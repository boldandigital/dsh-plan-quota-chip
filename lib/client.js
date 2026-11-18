/**
 * dsh-plan-quota-chip — client half (browser bundle, served through the
 * `dsh.client` manifest).
 *
 * Registers one entry in the `conversation.composer.dock` slot: a compact
 * inline chip that sits beside the shipped UsagePill in the strip below the
 * composer card, showing the tightest remaining plan quota across every
 * configured provider (MiniMax and OpenDesign).
 *
 * The chip is a plain React element built with inline styles against the
 * Harness design tokens (`--dsw-alias-*`, `--dsw-static-*`), so it follows the
 * product theme (light/dark) without carrying a stylesheet. Nothing is written
 * to the DOM outside the component.
 *
 * Clicking the chip opens a panel with the full per-provider detail. Hovering
 * does nothing: a quota readout that only appears on hover is invisible to
 * touch, awkward on a trackpad and impossible to screenshot. The panel is
 * where the extra numbers live, and it is also where the window the chip
 * displays is chosen — 5-hour or weekly — and which provider's rows are
 * shown. The chip itself always reports the tightest window across every
 * provider, whatever the panel filter is set to.
 *
 * Data arrives over the loopback Connection RPC channel `/api` under the
 * `plan-usage` method namespace, owned by the host half in lib/index.js.
 * The API keys never reach the browser.
 */
(function () {
	// The factory id MUST equal the package id. The module system resolves a
	// graph row's factory by its row id (`dsh-plan-quota-chip`); registering
	// under a different id makes it look like the bundle "loaded without
	// registering", and the retry then trips the duplicate-factory guard.
	window.__ModuleLoader__.load({
		id: 'dsh-plan-quota-chip',
		factory: function (require) {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
var React = require('react');

/** Connection's authenticated channel; the host half owns it. */
var CHANNEL = '/api';

/** Method namespace owned by this plugin under {@link CHANNEL}. */
var RPC_METHOD_PREFIX = 'plan-usage';

/** Slot this plugin adds its entry to. */
var SLOT_NAME = 'conversation.composer.dock';

/** Own id inside the slot, beside the shipped entries. */
var SLOT_ID = 'plan-usage';

/** Client services this half needs. */
var inject = ['slots', 'connection'];

var FALLBACK_REFRESH_MS = 60000;

/** Where the chosen window is remembered between sessions. */
var PREFERENCE_KEY = 'dsh-plan-quota-chip:window';

/** Where the chosen provider filter is remembered between sessions. */
var PROVIDER_PREFERENCE_KEY = 'dsh-plan-quota-chip:provider';

/** The windows a user can put on the chip. */
var WINDOW_LABELS = { '5h': '5-hour', wk: 'Weekly' };

/** Short badges shown on the chip itself. */
var WINDOW_BADGES = { '5h': '5h', wk: 'wk' };

/** The provider filter that shows every provider's rows. */
var ALL_PROVIDERS = 'all';

/** Fallback display label for a provider id the host did not name. */
var PROVIDER_FALLBACK_LABELS = { minimax: 'MiniMax', opendesign: 'OpenDesign' };

/**
 * The display label of one provider.
 *
 * The host owns the label, so a renamed provider follows automatically.
 * A provider the host did not name falls back to a known name.
 *
 * @param {object} provider - the host's provider descriptor.
 * @returns {string} the label.
 */
function providerLabel(provider) {
	if (!provider) return '';
	if (provider.label) return String(provider.label);
	if (provider.id && PROVIDER_FALLBACK_LABELS[provider.id]) {
		return PROVIDER_FALLBACK_LABELS[provider.id];
	}
	return provider.id ? String(provider.id) : '';
}

/**
 * The label of one window kind.
 *
 * The host reports the real window length with every row, so the label
 * follows the plan instead of being hard-coded. The fixed labels are the
 * fallback for a host that does not report one.
 *
 * @param {Array<object>} rows - normalized quota rows.
 * @param {string} kind - '5h' or 'wk'.
 * @returns {string} the label.
 */
function windowLabelOf(rows, kind) {
	for (var i = 0; i < rows.length; i += 1) {
		var row = rows[i];
		var label = kind === 'wk' ? row.weeklyLabel : row.intervalLabel;
		if (label) return label;
	}
	return WINDOW_LABELS[kind];
}

/**
 * The short badge of one window kind.
 *
 * @param {Array<object>} rows - normalized quota rows.
 * @param {string} kind - '5h' or 'wk'.
 * @returns {string} the badge.
 */
function windowBadgeOf(rows, kind) {
	for (var i = 0; i < rows.length; i += 1) {
		var row = rows[i];
		var badge = kind === 'wk' ? row.weeklyBadge : row.intervalBadge;
		if (badge) return badge;
	}
	return WINDOW_BADGES[kind];
}

/** Remaining-percent → status dot colour. */
function dotColor(percent) {
	if (percent === null || percent === undefined) {
		return 'var(--dsw-static-neutral-bluish-400, #9aa4b2)';
	}
	if (percent >= 50) return 'var(--dsw-static-green-500, #16a34a)';
	if (percent >= 20) return 'var(--dsw-static-amber-500, #f59e0b)';
	return 'var(--dsw-static-red-500, #ef4444)';
}

function formatReset(epochMs) {
	if (!epochMs) return 'unknown';
	try {
		return new Date(epochMs).toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
		});
	} catch (error) {
		return 'unknown';
	}
}

function formatLeft(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return '';
	var hours = Math.floor(ms / 3600000);
	var minutes = Math.floor((ms % 3600000) / 60000);
	if (hours > 0) return hours + 'h ' + minutes + 'm left';
	return minutes + 'm left';
}

/** Large token counts read better compact than spelled out. */
function formatCount(value) {
	if (!Number.isFinite(value)) return '';
	var sign = value < 0 ? '-' : '';
	var n = Math.abs(value);
	if (n >= 1e9) return sign + (n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1) + 'B';
	if (n >= 1e6) return sign + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
	if (n >= 1e3) return sign + (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k';
	return sign + String(n);
}

/**
 * Human label for an upstream model bucket.
 *
 * The two providers use different scope names: MiniMax reports 'general'
 * and 'video', OpenDesign reports an empty scope or 'plan'.
 *
 * @param {string} model - the reported scope.
 * @returns {string} the label.
 */
function modelLabel(model) {
	if (model === 'general') return 'MiniMax';
	if (!model || model === 'plan') return 'OpenDesign plan';
	return model;
}

/**
 * The lowest percentage any row reports for one window.
 *
 * A model bucket can report several rows; the tightest one is the
 * one that decides when the user actually runs out.
 *
 * @param {Array<object>} rows - normalized quota rows.
 * @param {string} kind - '5h' or 'wk'.
 * @returns {{percent: number, row: object}|null} the tightest row, or null.
 */
function tightest(rows, kind) {
	var worst = null;
	rows.forEach(function (row) {
		var percent = kind === 'wk' ? row.weeklyPercent : row.intervalPercent;
		if (percent === null || percent === undefined) return;
		if (!worst || percent < worst.percent) worst = { percent: percent, row: row };
	});
	return worst;
}

/**
 * The window the chip displays.
 *
 * The chosen window is used when any row reports it. The other
 * window is only a fallback, so a provider that reports just one
 * of them still shows a number instead of nothing.
 *
 * @param {Array<object>} rows - normalized quota rows.
 * @param {string} kind - the chosen window, '5h' or 'wk'.
 * @returns {{key: string, percent: number, row: object}|null} the window, or null.
 */
function chipWindow(rows, kind) {
	var primary = tightest(rows, kind);
	if (primary) return { key: kind, percent: primary.percent, row: primary.row };
	var other = kind === '5h' ? 'wk' : '5h';
	var fallback = tightest(rows, other);
	if (fallback) return { key: other, percent: fallback.percent, row: fallback.row };
	return null;
}

/**
 * Read the remembered window.
 *
 * Storage can be unavailable (private browsing, a locked-down
 * profile), so a failure falls back to the default rather than
 * breaking the chip.
 *
 * @returns {string} '5h' or 'wk'.
 */
function readPreference() {
	try {
		var stored = window.localStorage.getItem(PREFERENCE_KEY);
		return stored === 'wk' ? 'wk' : '5h';
	} catch (error) {
		return '5h';
	}
}

/**
 * Remember the chosen window.
 * @param {string} kind - '5h' or 'wk'.
 */
function writePreference(kind) {
	try {
		window.localStorage.setItem(PREFERENCE_KEY, kind);
	} catch (error) {
		// A chip that cannot remember still works for this session.
	}
}

/**
 * Read the remembered provider filter.
 *
 * @returns {string} 'all' or a provider id.
 */
function readProviderPreference() {
	try {
		var stored = window.localStorage.getItem(PROVIDER_PREFERENCE_KEY);
		return stored || ALL_PROVIDERS;
	} catch (error) {
		return ALL_PROVIDERS;
	}
}

/**
 * Remember the chosen provider filter.
 * @param {string} id - 'all' or a provider id.
 */
function writeProviderPreference(id) {
	try {
		window.localStorage.setItem(PROVIDER_PREFERENCE_KEY, id);
	} catch (error) {
		// A panel that cannot remember still works for this session.
	}
}

/** One window's numbers for one model row. */
function windowDetail(row, kind) {
	var isWeekly = kind === 'wk';
	var percent = isWeekly ? row.weeklyPercent : row.intervalPercent;
	if (percent === null || percent === undefined) return null;
	var counts = isWeekly ? row.weekly : row.interval;
	var resetsAt = isWeekly ? row.weeklyResetsAt : row.intervalResetsAt;
	var msLeft = isWeekly ? row.weeklyMsLeft : row.intervalMsLeft;
	return {
		percent: percent,
		counts: counts,
		resetsAt: resetsAt,
		msLeft: msLeft,
	};
}

/**
 * Apply the plugin: register the composer-dock entry.
 * @param {object} ctx - client plugin context.
 */
function apply(ctx) {
	var QuotaChip = function () {
		var state = React.useState(null);
		var snapshot = state[0];
		var setSnapshot = state[1];

		var openState = React.useState(false);
		var open = openState[0];
		var setOpen = openState[1];

		var preferenceState = React.useState(readPreference());
		var preference = preferenceState[0];
		var setPreference = preferenceState[1];

		var providerState = React.useState(readProviderPreference());
		var providerFilter = providerState[0];
		var setProviderFilter = providerState[1];

		/** The chip and its panel share one wrapper, so the panel is anchored to it. */
		var panelRef = React.useRef(null);

		React.useEffect(function () {
			var alive = true;
			var timer = null;

			var load = function () {
				ctx.connection.rpc
					.call(CHANNEL, RPC_METHOD_PREFIX + '/quota', null)
					.then(function (result) {
						if (!alive) return;
						if (result && result.ok === true && result.value) {
							setSnapshot({ ok: true, value: result.value });
							var ms =
								Number.isFinite(result.value.refreshMs) && result.value.refreshMs >= 5000
									? result.value.refreshMs
									: FALLBACK_REFRESH_MS;
							if (timer === null) timer = setInterval(load, ms);
						} else {
							var message =
								(result && result.error && result.error.message) || 'quota unavailable';
							setSnapshot({ ok: false, message: message });
						}
					})
					.catch(function (error) {
						if (!alive) return;
						setSnapshot({
							ok: false,
							message: String((error && error.message) || error),
						});
					});
			};

			load();

			return function () {
				alive = false;
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};
		}, []);

		// A click anywhere else closes the panel; Escape closes it too.
		React.useEffect(function () {
			if (!open) return undefined;
			var onPointerDown = function (event) {
				if (panelRef.current && panelRef.current.contains(event.target)) return;
				setOpen(false);
			};
			var onKeyDown = function (event) {
				if (event.key === 'Escape') setOpen(false);
			};
			document.addEventListener('mousedown', onPointerDown);
			document.addEventListener('keydown', onKeyDown);
			return function () {
				document.removeEventListener('mousedown', onPointerDown);
				document.removeEventListener('keydown', onKeyDown);
			};
		}, [open]);

		if (!snapshot) {
			// Still loading: render nothing so the strip stays clean.
			return null;
		}

		var value = snapshot.ok ? snapshot.value || {} : {};
		var rows = value.rows || [];
		var providers = value.providers || [];

		/**
		 * The provider a row belongs to.
		 *
		 * @param {object} row - one normalized quota row.
		 * @returns {object|null} the provider descriptor, or null.
		 */
		function providerOf(row) {
			if (!row || !row.provider) return null;
			for (var i = 0; i < providers.length; i += 1) {
				if (providers[i] && providers[i].id === row.provider) return providers[i];
			}
			return { id: row.provider, label: '', ok: true, error: null };
		}

		/**
		 * The tightest window across every provider.
		 *
		 * The chip always reports the tightest quota the user has, no
		 * matter which provider the panel is currently filtered to.
		 *
		 * @returns {{key: string, percent: number, row: object}|null} the window, or null.
		 */
		function tightestAcrossProviders() {
			var worst = null;
			rows.forEach(function (row) {
				var kind = preference;
				var percent = kind === 'wk' ? row.weeklyPercent : row.intervalPercent;
				if (percent === null || percent === undefined) {
					kind = kind === '5h' ? 'wk' : '5h';
					percent = kind === 'wk' ? row.weeklyPercent : row.intervalPercent;
					if (percent === null || percent === undefined) return;
				}
				if (!worst || percent < worst.percent) {
					worst = { key: kind, percent: percent, row: row };
				}
			});
			return worst;
		}

		var worst = snapshot.ok ? tightestAcrossProviders() : null;

		/** The chip itself, shared by the loaded and unavailable states. */
		function renderChip(percent, badge, label, name) {
			return React.createElement(
				'button',
				{
					type: 'button',
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: '6px',
						padding: '2px 6px',
						margin: '-2px -6px',
						border: 'none',
						borderRadius: '6px',
						background: open
							? 'var(--dsw-alias-button-ghost-active-fill, rgba(0, 0, 0, 0.06))'
							: 'transparent',
						cursor: 'pointer',
						font: 'inherit',
						fontFamily: 'var(--dsw-font-family, inherit)',
						fontSize: '12px',
						lineHeight: '1',
						whiteSpace: 'nowrap',
						color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
					},
					onClick: function () {
						setOpen(!open);
					},
					'aria-expanded': open ? 'true' : 'false',
					'aria-haspopup': 'dialog',
					'aria-label': label,
				},
				React.createElement('span', {
					style: {
						width: '8px',
						height: '8px',
						borderRadius: '50%',
						display: 'inline-block',
						background: dotColor(percent),
					},
				}),
				React.createElement('span', null, name),
				badge
					? React.createElement('span', { style: { opacity: 0.7 } }, badge)
					: null,
				React.createElement(
					'span',
					{
						style: {
							color: 'var(--dsw-alias-label-primary, inherit)',
							fontVariantNumeric: 'tabular-nums',
						},
					},
					percent === null || percent === undefined ? 'n/a' : percent + '%',
				),
			);
		}

		var worstProvider = worst ? providerOf(worst.row) : null;
		var worstName = worstProvider ? providerLabel(worstProvider) : 'Plan usage';
		var worstBadge = worst ? windowBadgeOf(rows, worst.key) : null;
		var chipPercent = worst ? worst.percent : null;
		var worstLabel = worst
			? 'Plan usage: ' + worstName + ' ' + worst.percent + '% ' + windowLabelOf(rows, worst.key)
			: 'Plan usage: no quota windows reported';
		var chipAriaLabel = snapshot.ok ? worstLabel : 'Plan usage: ' + snapshot.message;

		/** One window's row inside the panel. */
		function renderWindowRow(row, kind) {
			var detail = windowDetail(row, kind);
			if (!detail) return null;
			var selected = kind === (worst ? worst.key : null);
			var left = detail.counts
				? formatCount(detail.counts.remaining) + '/' + formatCount(detail.counts.total) + ' left'
				: '';
			var reset = formatReset(detail.resetsAt);
			var remaining = formatLeft(detail.msLeft);
			return React.createElement(
				'div',
				{
					key: 'row-' + kind,
					style: {
						display: 'flex',
						alignItems: 'baseline',
						justifyContent: 'space-between',
						gap: '12px',
						padding: '3px 6px',
						borderRadius: '4px',
						background: selected
							? 'var(--dsw-alias-button-ghost-active-fill, rgba(0, 0, 0, 0.06))'
							: 'transparent',
					},
				},
				React.createElement(
					'span',
					{
						style: {
							display: 'inline-flex',
							alignItems: 'baseline',
							gap: '8px',
							minWidth: '0',
						},
					},
					React.createElement(
						'span',
						{
							style: {
								width: '52px',
								flex: '0 0 auto',
								color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
							},
						},
						(kind === 'wk' ? row.weeklyLabel : row.intervalLabel) || WINDOW_LABELS[kind],
					),
					React.createElement(
						'span',
						{
							style: {
								color: 'var(--dsw-alias-label-primary, inherit)',
								fontVariantNumeric: 'tabular-nums',
								fontWeight: selected ? 600 : 400,
							},
						},
						detail.percent + '%',
					),
					left
						? React.createElement(
							'span',
							{
								style: {
									color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
									fontVariantNumeric: 'tabular-nums',
								},
							},
							left,
						)
						: null,
				),
				React.createElement(
					'span',
					{
						style: {
							flex: '0 0 auto',
							color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
						},
					},
					reset + (remaining ? ', ' + remaining : ''),
				),
			);
		}

		/** The rows of one provider, grouped under its heading. */
		function renderProviderRows(provider) {
			var own = rows.filter(function (row) {
				return row.provider === provider.id;
			});
			if (!own.length) {
				return React.createElement(
					'div',
					{ style: { color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))' } },
					'No quota windows reported.',
				);
			}
			return own.map(function (row) {
				return React.createElement(
					'div',
					{ key: provider.id + '-' + row.model, style: { marginTop: '8px' } },
					React.createElement(
						'div',
						{
							style: {
								fontWeight: 600,
								color: 'var(--dsw-alias-label-primary, inherit)',
								marginBottom: '2px',
							},
						},
						modelLabel(row.model),
					),
					renderWindowRow(row, '5h'),
					renderWindowRow(row, 'wk'),
				);
			});
		}

		/** The panel body: one block per provider. */
		function renderPanelBody() {
			var shown = providers.filter(function (provider) {
				return providerFilter === ALL_PROVIDERS || provider.id === providerFilter;
			});
			if (!shown.length) {
				return React.createElement(
					'div',
					{ style: { color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))' } },
					'No quota windows reported.',
				);
			}
			return shown.map(function (provider) {
				return React.createElement(
					'div',
					{ key: provider.id, style: { marginTop: '8px' } },
					React.createElement(
						'div',
						{
							style: {
								fontWeight: 600,
								color: 'var(--dsw-alias-label-primary, inherit)',
								marginBottom: '2px',
							},
						},
						providerLabel(provider),
					),
					provider.ok === false
						? React.createElement(
								'div',
								{ style: { color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))' } },
								String(provider.error || 'quota unavailable'),
							)
						: renderProviderRows(provider),
				);
			});
		}

		/** The segmented control that chooses the chip's window. */
		function renderWindowPicker() {
			return React.createElement(
				'div',
				{
					style: {
						display: 'inline-flex',
						gap: '2px',
						padding: '2px',
						marginTop: '8px',
						borderRadius: '8px',
						background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.04))',
					},
				},
				Object.keys(WINDOW_LABELS).map(function (kind) {
					var selected = preference === kind;
					return React.createElement(
						'button',
						{
							key: kind,
							type: 'button',
							'aria-pressed': selected ? 'true' : 'false',
							style: {
								border: 'none',
								borderRadius: '6px',
								padding: '3px 10px',
								cursor: 'pointer',
								font: 'inherit',
								fontSize: '11px',
								lineHeight: '1.4',
								background: selected
									? 'var(--dsw-alias-button-ghost-active-fill, rgba(0, 0, 0, 0.08))'
									: 'transparent',
								color: selected
									? 'var(--dsw-alias-label-primary, inherit)'
									: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
								fontWeight: selected ? 600 : 400,
							},
							onClick: function () {
								setPreference(kind);
								writePreference(kind);
							},
						},
						windowLabelOf(rows, kind),
					);
				}),
			);
		}

		/** The segmented control that chooses which provider's rows are shown. */
		function renderProviderPicker() {
			var options = [{ id: ALL_PROVIDERS, label: 'All' }].concat(
				providers.map(function (provider) {
					return { id: provider.id, label: providerLabel(provider) };
				}),
			);
			return React.createElement(
				'div',
				{
					style: {
						display: 'inline-flex',
						gap: '2px',
						padding: '2px',
						marginTop: '6px',
						borderRadius: '8px',
						background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.04))',
					},
				},
				options.map(function (option) {
					var selected = providerFilter === option.id;
					return React.createElement(
						'button',
						{
							key: option.id,
							type: 'button',
							'aria-pressed': selected ? 'true' : 'false',
							style: {
								border: 'none',
								borderRadius: '6px',
								padding: '3px 10px',
								cursor: 'pointer',
								font: 'inherit',
								fontSize: '11px',
								lineHeight: '1.4',
								background: selected
									? 'var(--dsw-alias-button-ghost-active-fill, rgba(0, 0, 0, 0.08))'
									: 'transparent',
								color: selected
									? 'var(--dsw-alias-label-primary, inherit)'
									: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
								fontWeight: selected ? 600 : 400,
							},
							onClick: function () {
								setProviderFilter(option.id);
								writeProviderPreference(option.id);
							},
						},
						option.label,
					);
				}),
			);
		}

		return React.createElement(
			'span',
			{
				ref: panelRef,
				style: {
					position: 'relative',
					display: 'inline-flex',
					alignItems: 'center',
				},
			},
			renderChip(chipPercent, worstBadge, chipAriaLabel, worstName),
			open
				? React.createElement(
						'div',
						{
							role: 'dialog',
							'aria-label': 'Plan usage',
							style: {
								position: 'absolute',
								bottom: 'calc(100% + 8px)',
								left: '0',
								zIndex: 60,
								width: '340px',
								maxWidth: '80vw',
								padding: '12px',
								borderRadius: '12px',
								border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
								background: 'var(--dsw-alias-bg-l2, var(--dsw-alias-card-fill, #fff))',
								boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.12))',
								color: 'var(--dsw-alias-label-primary, inherit)',
								fontFamily: 'var(--dsw-font-family, inherit)',
								fontSize: '12px',
								lineHeight: '1.45',
								textAlign: 'left',
								whiteSpace: 'normal',
							},
						},
						React.createElement(
							'div',
							{
								style: {
									fontWeight: 600,
									fontSize: '12px',
								},
							},
							'Plan usage',
						),
						React.createElement(
							'div',
							{
								style: {
									color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
									marginTop: '2px',
								},
							},
							'Chip shows:',
						),
						renderWindowPicker(),
						renderProviderPicker(),
						renderPanelBody(),
						value.fetchedAt
							? React.createElement(
									'div',
									{
										style: {
											marginTop: '10px',
											paddingTop: '8px',
											borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06))',
											color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.62))',
										},
									},
									'updated ' + formatReset(value.fetchedAt),
								)
							: null,
					)
				: null,
		);
	};

	ctx.slots.inject(SLOT_NAME, function () {
		return ctx.slots.register(
			{
				name: SLOT_NAME,
				id: SLOT_ID,
				order: 100,
				label: 'Plan usage',
			},
			function () {
				return React.createElement(QuotaChip, null);
			},
		);
	});
}

exports.apply = apply;
exports.inject = inject;
return module.exports;
		},
	});
})();
