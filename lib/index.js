/**
 * @local/plan-usage — host half.
 *
 * Serves the remaining plan quota of TWO providers to the browser half of this
 * plugin over the loopback Connection RPC channel `/api`, under the
 * `plan-usage` method namespace. The browser never sees a credential: it only
 * receives already-normalized rows in one shared shape.
 *
 * Provider A — MiniMax (Token Plan).
 * The quota is a plain REST endpoint that accepts the API key as
 * `Authorization: Bearer <key>`. The key is resolved through the harness
 * credential seam (`ctx.credentials`), so it never leaves this process.
 * Upstream endpoints, in probe order (the first one that answers wins):
 *   international  https://api.minimax.io/v1/api/openplatform/coding_plan/remains
 *   international  https://www.minimax.io/v1/token_plan/remains
 *   china          https://api.minimaxi.com/v1/token_plan/remains
 * The regions report the raw count fields differently: the international
 * endpoints report how much is LEFT, the China endpoint reports how much was
 * USED. The `*_remaining_percent` fields are region-independent, so those are
 * the values this plugin reports; the raw counts are only used to derive
 * "x of y left" and are interpreted per region.
 *
 * Provider B — OpenDesign (Vela Cloud).
 * There is NO HTTP quota endpoint: the inference gateway
 * (`https://amr-link.open-design.ai`) answers model and completion routes only
 * and carries no quota headers, while the control plane
 * (`https://amr-api.open-design.ai`) needs a `vela_ctrl_…` key that only the
 * signed-in `vela` CLI session holds (never on disk, never in the keychain).
 * So this half shells out to the CLI and never handles a key at all.
 * Sources, in order:
 *   1. `vela billing funding-check --workspace-id <ws> --format json`
 *      → codingPlan.windows[] with durationSeconds / usedCredits /
 *        limitCredits / remainingCredits / resetsAt.
 *   2. `vela billing summary --format json`
 *      → plan tier, subscription/recharge/total credits and the USD balance.
 *   3. `vela team-projects list`
 *      → the default workspace id, when one was not configured.
 * A window of at least three days is the "weekly" window; shorter windows are
 * the "5-hour"/interval window. An account that is not eligible for the plan
 * reports `eligible:false` with no windows — that degrades to an empty row
 * set, not an error.
 *
 * Both providers are fetched independently and concurrently. A provider that
 * fails is reported in the per-provider `providers` status list and never
 * fails the whole response nor hides the other provider's rows.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Service name this half registers on the plugin context. */
export const name = 'plan-usage';

/** Host services this half needs (`credentials` is still used by MiniMax). */
export const inject = ['connection', 'credentials'];

/** Connection's authenticated channel; the browser half calls into it. */
export const RPC_CHANNEL = '/api';

/** Method namespace owned by this plugin under {@link RPC_CHANNEL}. */
export const RPC_METHOD_PREFIX = 'plan-usage';

/** RPC endpoints served by the host half. */
export const RPC_ENDPOINTS = ['quota'];

/** Method name the browser half sends for one endpoint. */
export function rpcMethod(endpoint) {
	return `${RPC_METHOD_PREFIX}/${endpoint}`;
}

/** Exact Fetch route path Connection serves one endpoint on. */
export function rpcRoutePath(endpoint) {
	return `${RPC_CHANNEL}/${rpcMethod(endpoint)}`;
}

/** Per-provider fetch timeout. */
const UPSTREAM_TIMEOUT_MS = 15000;

/** Default credential reference, overridable from the bundle patch. */
const DEFAULT_CREDENTIAL_REF = 'MINIMAX_API_KEY';

/** Default refresh interval in milliseconds. */
const DEFAULT_REFRESH_MS = 60000;

/**
 * Upstream endpoints in probe order. The first one that answers with a
 * successful payload wins; the rest are only tried when it does not.
 */
const UPSTREAM_ENDPOINTS = [
	{ id: 'international', endpoint: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains', reportsUsed: false },
	{ id: 'international-www', endpoint: 'https://www.minimax.io/v1/token_plan/remains', reportsUsed: false },
	{ id: 'china', endpoint: 'https://api.minimaxi.com/v1/token_plan/remains', reportsUsed: true },
];

/** Provider identifiers and their display labels. */
const PROVIDERS = [
	{ id: 'minimax', label: 'MiniMax' },
	{ id: 'opendesign', label: 'OpenDesign' },
];

/** Workspace id pattern accepted by the Vela control plane. */
const WORKSPACE_ID_PATTERN = /^[a-z0-9]{16,32}$/;

/** The CLI reports credits as decimal strings. */
const CREDITS_PATTERN = /^\d+(\.\d+)?$/;

/** A window of at least three days counts as the weekly window. */
const WEEKLY_SECONDS = 3 * 24 * 60 * 60;

/** Seconds in a week — the OpenDesign design plan's long window. */
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Seconds in one day. */
const DAY_SECONDS = 24 * 60 * 60;

/** Seconds in one hour. */
const HOUR_SECONDS = 60 * 60;

/** Failure result shape the client validates (`details` must be an object). */
function rpcError(code, message, details = {}) {
	return { ok: false, error: { code, message, details } };
}

/** Wrap one result in the server-response envelope Connection expects. */
function rpcEnvelope(rpcId, result, status = 200) {
	return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/**
 * Human label for an upstream MiniMax model bucket.
 * @param {string} model - Raw `model_name` from the upstream payload.
 * @returns {string} Display label.
 */
function minimaxModelLabel(model) {
	if (model === 'general') return 'MiniMax';
	if (model === 'video') return 'MiniMax video';
	return model;
}

/**
 * Human label for an OpenDesign plan scope.
 * @param {string} scope - Raw scope from `codingPlan.windows`.
 * @returns {string} Display label.
 */
function opendesignModelLabel(scope) {
	if (!scope || scope === 'scope' || scope === 'plan') return 'OpenDesign plan';
	return scope;
}

/**
 * Turn one upstream `model_remains` row into the shape the client renders.
 * @param {object} row - one entry of the upstream `model_remains` array.
 * @param {boolean} reportsUsed - whether the raw counts mean used (CN) or remaining.
 * @returns {object} normalized row.
 */
function normalizeRow(row, reportsUsed) {
	const counts = (total, raw) => {
		if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(raw)) return null;
		const remaining = reportsUsed ? Math.max(0, total - raw) : Math.min(total, raw);
		return { total, remaining, used: total - remaining };
	};
	const percent = (value) => (Number.isFinite(value) ? value : null);
	return {
		provider: 'minimax',
		model: typeof row.model_name === 'string' ? minimaxModelLabel(row.model_name) : 'unknown',
		intervalPercent: percent(row.current_interval_remaining_percent),
		weeklyPercent: percent(row.current_weekly_remaining_percent),
		interval: counts(row.current_interval_total_count, row.current_interval_usage_count),
		weekly: counts(row.current_weekly_total_count, row.current_weekly_usage_count),
		intervalResetsAt: Number.isFinite(row.end_time) ? row.end_time : null,
		weeklyResetsAt: Number.isFinite(row.weekly_end_time) ? row.weekly_end_time : null,
		intervalMsLeft: Number.isFinite(row.remains_time) ? row.remains_time : null,
		weeklyMsLeft: Number.isFinite(row.weekly_remains_time) ? row.weekly_remains_time : null,
		intervalLabel: '5-hour',
		weeklyLabel: 'Weekly',
		intervalBadge: '5h',
		weeklyBadge: 'wk',
	};
}

/**
 * Read the API key through the credential seam.
 * @param {object} ctx - Host plugin context.
 * @param {string} ref - Credential reference name.
 * @returns {Promise<string|null>} the key, or null when it does not resolve.
 */
async function resolveCredential(ctx, ref) {
	try {
		const hit = await ctx.credentials.resolve(ref);
		if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
	} catch {
		// An unresolvable reference is reported to the caller as "no credential".
	}
	return null;
}

/**
 * Query MiniMax, trying each endpoint in order until one answers.
 * @param {string} apiKey - Resolved MiniMax API key.
 * @returns {Promise<object>} normalized rows plus the endpoint that served them.
 */
async function fetchQuota(apiKey) {
	const failures = [];
	for (const candidate of UPSTREAM_ENDPOINTS) {
		let response;
		try {
			response = await fetch(candidate.endpoint, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'User-Agent': 'dsh-plan-quota-chip/0.1.0',
				},
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
		} catch (error) {
			failures.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!response.ok) {
			failures.push(`${candidate.id}: HTTP ${response.status}`);
			continue;
		}
		let payload;
		try {
			payload = await response.json();
		} catch {
			failures.push(`${candidate.id}: response was not JSON`);
			continue;
		}
		const statusCode = payload && payload.base_resp && payload.base_resp.status_code;
		if (statusCode !== undefined && statusCode !== 0) {
			const statusMsg = (payload.base_resp && payload.base_resp.status_msg) || 'unknown error';
			failures.push(`${candidate.id}: ${statusMsg} (code ${statusCode})`);
			continue;
		}
		const rawRows = Array.isArray(payload && payload.model_remains) ? payload.model_remains : [];
		return {
			endpoint: candidate.id,
			rows: rawRows.map((row) => normalizeRow(row, candidate.reportsUsed)),
		};
	}
	const detail = failures.join('; ');
	return { endpoint: null, rows: [], error: detail || 'no upstream endpoint answered' };
}

/**
 * Resolve the vela CLI binary.
 *
 * The desktop app is not launched from a shell, so `$PATH` usually does not
 * contain `~/.local/bin`. Prefer an explicit config value, then the
 * environment override, then the well-known install location.
 *
 * @param {string} configured - Optional binary path from the plugin config.
 * @returns {string} Candidate binary path.
 */
function resolveBinary(configured) {
	if (typeof configured === 'string' && configured.trim()) return configured.trim();
	if (process.env.VELA_BIN) return process.env.VELA_BIN;
	return join(homedir(), '.local', 'bin', 'vela');
}

/**
 * Run the vela CLI and parse its JSON output.
 *
 * @param {string} binary - Path to the vela CLI.
 * @param {string[]} args - CLI arguments.
 * @returns {Promise<object>} Parsed JSON payload.
 */
function runJson(binary, args) {
	return new Promise((resolve, reject) => {
		execFile(binary, args, { timeout: UPSTREAM_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(new Error(`vela ${args.join(' ')} failed: ${error.message}`));
				return;
			}
			const text = String(stdout || '').trim();
			if (!text) {
				reject(new Error(`vela ${args.join(' ')} printed nothing`));
				return;
			}
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new Error(`vela ${args.join(' ')} did not print JSON`));
			}
		});
	});
}

/**
 * Parse a credit amount. The CLI reports credits as decimal strings.
 *
 * @param {unknown} value - Raw value.
 * @returns {number|null} Parsed amount, or null.
 */
function creditsToNumber(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (!CREDITS_PATTERN.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Remaining percentage for one window.
 *
 * @param {number} remaining - Remaining credits.
 * @param {number} limit - Total credits.
 * @returns {number|null} Percentage in [0, 100], or null.
 */
function remainingPercentOf(remaining, limit) {
	if (remaining === null || limit === null || limit <= 0) return null;
	return Math.min(100, Math.max(0, Math.round((remaining / limit) * 100)));
}

/**
 * Parse a reset timestamp.
 *
 * @param {unknown} value - Raw timestamp.
 * @returns {number|null} Epoch milliseconds, or null.
 */
function epochOf(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || !value.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Short badge for a window duration.
 *
 * @param {number} durationSeconds - Window length in seconds.
 * @returns {string} Label.
 */
function durationLabel(durationSeconds) {
	if (durationSeconds >= DAY_SECONDS) {
		const days = Math.round(durationSeconds / DAY_SECONDS);
		return `${days}d`;
	}
	if (durationSeconds >= HOUR_SECONDS) {
		const hours = Math.round(durationSeconds / HOUR_SECONDS);
		return `${hours}h`;
	}
	return `${Math.max(1, Math.round(durationSeconds / 60))}m`;
}

/**
 * Human label for a window duration, matching the chip vocabulary.
 *
 * @param {number} durationSeconds - Window length in seconds.
 * @returns {string} Label.
 */
function windowLabel(durationSeconds) {
	if (durationSeconds >= 6 * DAY_SECONDS) return 'Weekly';
	if (durationSeconds >= DAY_SECONDS) {
		const days = Math.round(durationSeconds / DAY_SECONDS);
		return `${days}-day`;
	}
	const hours = Math.round(durationSeconds / HOUR_SECONDS);
	if (hours >= 1) return `${hours}-hour`;
	return `${Math.max(1, Math.round(durationSeconds / 60))}-minute`;
}

/**
 * Convert one raw plan window into the shape the client half reads.
 *
 * @param {object} raw - Raw window from `codingPlan.windows`.
 * @param {number} now - Current epoch milliseconds.
 * @returns {object|null} Normalized window, or null when unusable.
 */
function windowOf(raw, now) {
	if (!raw || typeof raw !== 'object') return null;
	const durationSeconds = typeof raw.durationSeconds === 'number' && Number.isFinite(raw.durationSeconds)
		? raw.durationSeconds
		: null;
	if (durationSeconds === null) return null;
	const limit = creditsToNumber(raw.limitCredits);
	const used = creditsToNumber(raw.usedCredits);
	const remaining = creditsToNumber(raw.remainingCredits);
	if (limit === null || remaining === null) return null;
	const resetsAt = epochOf(raw.resetsAt);
	const scope = typeof raw.scope === 'string' && raw.scope.trim()
		? raw.scope.trim()
		: (typeof raw.modelId === 'string' && raw.modelId.trim() ? raw.modelId.trim() : '');
	return {
		scope: scope,
		durationSeconds: durationSeconds,
		durationLabel: durationLabel(durationSeconds),
		label: windowLabel(durationSeconds),
		weekly: durationSeconds >= WEEKLY_SECONDS,
		percent: remainingPercentOf(remaining, limit),
		counts: { total: limit, remaining: remaining, used: used === null ? Math.max(0, limit - remaining) : used },
		resetsAt: resetsAt,
		msLeft: resetsAt === null ? null : Math.max(0, resetsAt - now),
	};
}

/**
 * Convert one OpenDesign design-plan window into the shape the client reads.
 *
 * The design plan (the Go plan and its successors) reports its windows with a
 * `kind` of "5h" or "7d" instead of a duration, and with credits as plain
 * strings. This is the same window pair the OpenDesign desktop app reads
 * from `vela billing workspace-snapshot`.
 *
 * @param {object} raw - Raw window from `designPlanWindows`.
 * @param {number} now - Current epoch milliseconds.
 * @returns {object|null} Normalized window, or null when unusable.
 */
function designWindowOf(raw, now) {
	if (!raw || typeof raw !== 'object') return null;
	const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
	const limit = creditsToNumber(raw.limitCredits);
	const remaining = creditsToNumber(raw.remainingCredits);
	if (limit === null || remaining === null) return null;
	const durationSeconds = kind === '7d'
		? WEEK_SECONDS
		: kind === '5h'
			? 5 * HOUR_SECONDS
			: null;
	const weekly = durationSeconds === null ? kind === '7d' : durationSeconds >= WEEKLY_SECONDS;
	const label = kind === '7d' ? 'Weekly' : kind === '5h' ? '5-hour' : 'Plan window';
	const durationLabel = kind === '7d' ? 'wk' : kind === '5h' ? '5h' : 'plan';
	const resetsAt = epochOf(raw.resetsAt);
	return {
		scope: 'plan',
		durationSeconds: durationSeconds,
		durationLabel: durationLabel,
		label: label,
		weekly: weekly,
		percent: remainingPercentOf(remaining, limit),
		counts: { total: limit, remaining: remaining, used: Math.max(0, limit - remaining) },
		resetsAt: resetsAt,
		msLeft: resetsAt === null ? null : Math.max(0, resetsAt - now),
	};
}

/**
 * Group normalized windows into the rows the client renders.
 *
 * A row carries at most one short window and one weekly window: the same two
 * readouts per plan scope.
 *
 * @param {object[]} windows - Normalized windows.
 * @returns {object[]} Rows.
 */
function rowsOf(windows) {
	const byScope = new Map();
	for (const window of windows) {
		const key = window.scope || 'plan';
		let row = byScope.get(key);
		if (!row) {
			row = {
				provider: 'opendesign',
				model: opendesignModelLabel(key),
				intervalPercent: null,
				weeklyPercent: null,
				interval: null,
				weekly: null,
				intervalResetsAt: null,
				weeklyResetsAt: null,
				intervalMsLeft: null,
				weeklyMsLeft: null,
				intervalLabel: null,
				weeklyLabel: null,
				intervalBadge: null,
				weeklyBadge: null,
			};
			byScope.set(key, row);
		}
		const slot = window.weekly ? 'weekly' : 'interval';
		if (row[slot] !== null) continue;
		row[`${slot}Percent`] = window.percent;
		row[slot] = window.counts;
		row[`${slot}ResetsAt`] = window.resetsAt;
		row[`${slot}MsLeft`] = window.msLeft;
		row[`${slot}Label`] = window.label;
		row[`${slot}Badge`] = window.durationLabel;
	}
	return Array.from(byScope.values());
}

/**
 * Resolve the workspace id.
 *
 * @param {string} binary - vela CLI path.
 * @param {string} configured - Optional workspace id from the plugin config.
 * @returns {Promise<string>} Workspace id.
 */
async function resolveWorkspaceId(binary, configured) {
	if (typeof configured === 'string' && WORKSPACE_ID_PATTERN.test(configured.trim())) {
		return configured.trim();
	}
	const payload = await runJson(binary, ['team-projects', 'list']);
	const workspaceId = payload && typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
	if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
		throw new Error('vela team-projects list did not return a usable workspace id');
	}
	return workspaceId;
}

/**
 * Read the plan summary (tier, credits, balance).
 *
 * A missing summary is not fatal — the quota windows still stand on their own.
 *
 * @param {string} binary - vela CLI path.
 * @returns {Promise<object|null>} Summary, or null.
 */
async function readSummary(binary) {
	try {
		const payload = await runJson(binary, ['billing', 'summary', '--format', 'json']);
		const balances = payload && typeof payload.balances === 'object' && payload.balances ? payload.balances : {};
		return {
			tier: typeof payload?.membershipTier === 'string' && payload.membershipTier ? payload.membershipTier : null,
			status: typeof payload?.subscriptionStatus === 'string' && payload.subscriptionStatus ? payload.subscriptionStatus : null,
			balanceUsd: creditsToNumber(payload?.balanceUsd),
			creditsPerUsd: creditsToNumber(payload?.creditsPerUsd),
			subscriptionCredits: creditsToNumber(balances.subscriptionCredits),
			rechargeCredits: creditsToNumber(balances.rechargeCredits),
			totalAvailableCredits: creditsToNumber(balances.totalAvailableCredits),
			usageCount: typeof payload?.usageCount === 'number' ? payload.usageCount : null,
			rechargeCount: typeof payload?.rechargeCount === 'number' ? payload.rechargeCount : null,
			introEligible: payload?.firstMonthIntroEligible === true,
		};
	} catch {
		return null;
	}
}

/**
 * Describe a provider that reports no quota windows.
 *
 * A provider on the free plan has no coding-plan window but still has a
 * tier, a credit balance and a subscription status. Those are the numbers
 * worth showing, so the browser can say what the plan actually is instead of
 * only "no quota windows reported".
 *
 * @param {object|null} summary - Plan summary, or null.
 * @param {object} funding - Raw funding-check payload.
 * @returns {object|null} A plan description, or null when there is nothing to say.
 */
function planStateOf(summary, funding) {
	const plan = funding && typeof funding.codingPlan === 'object' && funding.codingPlan ? funding.codingPlan : {};
	const eligible = plan.eligible === true;
	const tier = (summary && summary.tier) || (typeof plan.tier === 'string' && plan.tier ? plan.tier : null);
	// A free account has no tier, no credits and no balance. That is still a
	// plan state worth reporting: the account simply is not on a coding plan.
	if (!summary && !tier && !eligible) return null;
	return {
		tier: tier || (eligible ? 'plan' : 'free'),
		status: summary ? summary.status : null,
		eligible,
		balanceUsd: summary ? summary.balanceUsd : null,
		creditsPerUsd: summary ? summary.creditsPerUsd : null,
		subscriptionCredits: summary ? summary.subscriptionCredits : null,
		rechargeCredits: summary ? summary.rechargeCredits : null,
		totalAvailableCredits: summary ? summary.totalAvailableCredits : null,
		usageCount: summary ? summary.usageCount : null,
		rechargeCount: summary ? summary.rechargeCount : null,
		introEligible: summary ? summary.introEligible === true : false,
		fundingCheck: typeof funding?.fundingCheck === 'string' ? funding.fundingCheck : null,
	};
}

/**
 * Read the OpenDesign plan quota through the vela CLI.
 *
 * @param {object} config - Plugin config.
 * @returns {Promise<{rows: object[], plan: object|null}>} Rows plus the plan state.
 */
async function fetchOpenDesign(config) {
	const binary = resolveBinary(config.velaBinary);
	const workspaceId = await resolveWorkspaceId(binary, config.workspaceId);
	const funding = await runJson(binary, ['billing', 'funding-check', '--workspace-id', workspaceId, '--format', 'json']);
	const plan = funding && typeof funding.codingPlan === 'object' && funding.codingPlan ? funding.codingPlan : {};
	const rawWindows = Array.isArray(plan.windows) ? plan.windows : [];
	const now = Date.now();
	const windows = rawWindows.map((raw) => windowOf(raw, now)).filter(Boolean);
	// The design plan reports its windows separately, with a "5h"/"7d" kind.
	// It is the Go plan's readout, and the desktop app reads it from here.
	let snapshot = null;
	try {
		snapshot = await runJson(binary, ['billing', 'workspace-snapshot', '--workspace-id', workspaceId, '--format', 'json']);
	} catch {
		// The snapshot is additive; the coding-plan windows still stand.
	}
	const designWindows = Array.isArray(snapshot?.designPlanWindows) ? snapshot.designPlanWindows : [];
	for (const raw of designWindows) {
		const window = designWindowOf(raw, now);
		if (window) windows.push(window);
	}
	const rows = rowsOf(windows);
	// The plan summary is a second CLI call; it only fills in the plan state
	// (tier, credits, balance) that the windows do not carry. A free account
	// has no windows at all, so this is what the panel has to show.
	let planState = planStateOf(null, funding);
	try {
		const summary = await readSummary(binary);
		planState = planStateOf(summary, funding) || planState;
	} catch {
		// keep the funding-derived state
	}
	// The snapshot knows the workspace's billing state and plan id.
	if (snapshot && typeof snapshot.billing === 'object' && snapshot.billing) {
		const billing = snapshot.billing;
		if (typeof billing.planId === 'string' && billing.planId) {
			planState = { ...(planState || {}), tier: billing.planId };
		}
		if (typeof billing.billingState === 'string' && billing.billingState) {
			planState = { ...(planState || {}), billingState: billing.billingState };
		}
	}
	return { rows, plan: planState };
}

/**
 * Fetch one provider, turning any failure into a per-provider status entry.
 *
 * @param {object} provider - Provider descriptor (`id`, `label`).
 * @param {Function} fetchRows - Async function returning the provider rows.
 * @returns {Promise<object>} `{id, label, ok, error, rows, plan}`.
 */
async function fetchProvider(provider, fetchRows) {
	try {
		const result = await fetchRows();
		const rows = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];
		const plan = result && !Array.isArray(result) && result.plan ? result.plan : null;
		return { id: provider.id, label: provider.label, ok: true, error: null, rows, plan };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { id: provider.id, label: provider.label, ok: false, error: message, rows: [], plan: null };
	}
}

/**
 * Read every enabled provider, independently and concurrently.
 *
 * One slow or failing provider can neither block nor hide the other one.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} settings - Resolved plugin settings.
 * @returns {Promise<object[]>} Rows across all enabled providers.
 */
async function collectRows(ctx, settings) {
	const enabled = PROVIDERS.filter((provider) => settings.providers.includes(provider.id));
	const fetches = enabled.map((provider) => {
		if (provider.id === 'minimax') {
			return fetchProvider(provider, async () => {
				const apiKey = await resolveCredential(ctx, settings.credentialRef);
				if (!apiKey) {
					throw new Error(`credential reference ${settings.credentialRef} did not resolve; add it to the DSH credential store`);
				}
				const result = await fetchQuota(apiKey);
				if (result.error) {
					throw new Error(`MiniMax quota unavailable: ${result.error}`);
				}
				return result.rows;
			});
		}
		return fetchProvider(provider, () => fetchOpenDesign(settings));
	});
	const settled = await Promise.all(fetches);
	const rows = [];
	for (const entry of settled) {
		for (const row of entry.rows) rows.push(row);
	}
	return { rows, providers: settled };
}

/**
 * Handle one quota request.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} settings - Resolved plugin settings.
 * @returns {Promise<object>} RPC result.
 */
async function handleQuota(ctx, settings) {
	const collected = await collectRows(ctx, settings);
	return {
		ok: true,
		value: {
			rows: collected.rows,
			providers: collected.providers.map((entry) => ({
				id: entry.id,
				label: entry.label,
				ok: entry.ok,
				error: entry.error,
				plan: entry.plan ?? null,
			})),
			refreshMs: settings.refreshMs,
			fetchedAt: Date.now(),
		},
	};
}

/**
 * Apply the plugin.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} [config] - Plugin config.
 */
export function apply(ctx, config = {}) {
	const raw = config && typeof config === 'object' ? config : {};
	const refreshMs = Number.isFinite(raw.refreshMs) && raw.refreshMs >= 5000 ? raw.refreshMs : DEFAULT_REFRESH_MS;
	const credentialRef =
		typeof raw.credentialRef === 'string' && /^[A-Z][A-Z0-9_]*$/.test(raw.credentialRef)
			? raw.credentialRef
			: DEFAULT_CREDENTIAL_REF;
	const velaBinary = typeof raw.velaBinary === 'string' ? raw.velaBinary : '';
	const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : '';
	let providers = PROVIDERS.map((provider) => provider.id);
	if (Array.isArray(raw.providers)) {
		const wanted = raw.providers.filter((id) => typeof id === 'string' && PROVIDERS.some((p) => p.id === id));
		if (wanted.length > 0) providers = wanted;
	}
	const settings = { refreshMs, credentialRef, velaBinary, workspaceId, providers };

	for (const endpoint of RPC_ENDPOINTS) {
		const expected = rpcMethod(endpoint);
		ctx.connection.fetch.register({
			path: rpcRoutePath(endpoint),
			methods: ['POST'],
			requestBody: 'buffered',
			fetch: async (request) => {
				const contentType = (request.headers.get('content-type') ?? '')
					.split(';', 1)[0]
					.trim()
					.toLowerCase();
				if (contentType !== 'application/json') {
					return rpcEnvelope(
						'unknown',
						rpcError('gateway/bad-request', 'content type must be application/json'),
						415,
					);
				}
				let message;
				try {
					message = await request.json();
				} catch {
					return rpcEnvelope('unknown', rpcError('gateway/bad-request', 'body is not JSON'), 400);
				}
				const rpcId =
					message && typeof message === 'object' && typeof message.rpcId === 'string' ? message.rpcId : 'unknown';
				if (!message || message.type !== 'client-request' || message.method !== expected) {
					return rpcEnvelope(
						rpcId,
						rpcError('gateway/bad-request', `method must be ${JSON.stringify(expected)}`),
						400,
					);
				}
				try {
					const result = endpoint === 'quota'
						? await handleQuota(ctx, settings)
						: rpcError('internal', `unknown endpoint: ${endpoint}`);
					return rpcEnvelope(rpcId, result);
				} catch (error) {
					return rpcEnvelope(rpcId, rpcError('internal', error instanceof Error ? error.message : String(error)));
				}
			},
		});
	}
}
