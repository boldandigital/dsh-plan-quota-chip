/**
 * Offline render check for the dsh-plan-quota-chip client half.
 *
 * The client is a browser bundle, so this harness stubs just enough of the
 * environment (the module loader, React and the DOM) to mount the chip and
 * print the tree it produces. It catches undefined references and shape
 * mistakes that a syntax check cannot.
 *
 * Run: node test/client.render.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

/** A tiny React stand-in: enough hooks for one component. */
function createReact() {
	const slots = [];
	let cursor = 0;
	const React = {
		createElement(type, props, ...children) {
			return { type, props: { ...(props || {}), children } };
		},
		useState(initial) {
			const index = cursor++;
			if (!slots[index]) {
				slots[index] = { state: typeof initial === 'function' ? initial() : initial };
			}
			const slot = slots[index];
			return [
				slot.state,
				(value) => {
					slot.state = typeof value === 'function' ? value(slot.state) : value;
				},
			];
		},
		useEffect(effect) {
			const index = cursor++;
			if (!slots[index]) slots[index] = {};
			slots[index].effect = effect;
		},
		useRef(initial) {
			const index = cursor++;
			if (!slots[index]) slots[index] = { current: initial };
			return slots[index];
		},
	};
	/** Forget every hook state, as a fresh mount would. */
	React.reset = () => {
		slots.length = 0;
		cursor = 0;
	};
	/**
	 * Prepare for one render: the hook cursor restarts, so every render reads
	 * the same slots, and the pending effects become runnable again.
	 */
	React.beginRender = () => {
		cursor = 0;
		for (const slot of slots) if (slot) slot.ran = false;
	};
	/** Run the effects collected by the last render. */
	React.flush = () => {
		for (const slot of slots) {
			if (!slot || !slot.effect || slot.ran) continue;
			slot.ran = true;
			slot.effect();
		}
	};
	return React;
}

/** Flatten an element tree into its text. */
function render(node) {
	if (node === null || node === undefined || node === false) return [];
	if (Array.isArray(node)) return node.flatMap(render);
	if (typeof node === 'string' || typeof node === 'number') return [String(node)];
	const children = node.props && node.props.children;
	if (children === undefined) return [];
	if (Array.isArray(children)) return children.flatMap(render);
	return render(children);
}

/** Accessible labels collected from the last rendered tree. */
let failedLabels = [];

/** Collect every aria-label in a rendered tree. */
function collectLabels(node) {
	if (node === null || node === undefined || node === false) return;
	if (Array.isArray(node)) {
		for (const child of node) collectLabels(child);
		return;
	}
	if (typeof node !== 'object') return;
	const label = node.props && node.props['aria-label'];
	if (typeof label === 'string') failedLabels.push(label);
	const children = node.props && node.props.children;
	if (Array.isArray(children)) for (const child of children) collectLabels(child);
	else if (children) collectLabels(children);
}

const React = createReact();

// The client schedules a refresh timer; keep it out of the test process.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

globalThis.document = {
	addEventListener() {},
	removeEventListener() {},
};
globalThis.localStorage = {
	getItem() {
		return null;
	},
	setItem() {},
};
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			globalThis.__loaded = spec;
			globalThis.__module = spec.factory((id) => {
				assert.equal(id, 'react');
				return React;
			});
		},
	},
};

// Load the client bundle with the stubbed React.
const source = readFileSync(clientPath, 'utf8');
new Function('window', 'document', 'localStorage', source)(
	globalThis.window,
	globalThis.document,
	globalThis.localStorage,
);
const moduleExports = globalThis.__module;
assert.equal(globalThis.__loaded.id, 'dsh-plan-quota-chip', 'module loader id must equal the package id');

/**
 * Mount the chip with one quota payload.
 * @param {object} payload - the RPC result the client receives.
 * @param {boolean} [openPanel] - click the chip so the panel opens.
 * @returns {Promise<string>} the rendered text.
 */
async function mount(payload, openPanel = false) {
	React.reset();
	let element = null;
	const ctx = {
		slots: {
			inject(name, fn) {
				fn();
			},
			register(spec, fn) {
				element = fn();
				return spec;
			},
		},
		connection: {
			rpc: {
				call(channel, method) {
					assert.equal(channel, '/api');
					assert.equal(method, 'plan-usage/quota');
					return Promise.resolve(payload);
				},
			},
		},
	};
	moduleExports.apply(ctx);
	assert.ok(element && element.type, 'the composer-dock slot registers a component');

	const renderTree = () => {
		React.beginRender();
		const tree = element.type(element.props);
		React.flush();
		collectLabels(tree);
		return tree;
	};

	renderTree();
	await new Promise((resolve) => setImmediate(resolve));
	let tree = renderTree();
	if (openPanel) {
		// The chip is the only interactive element: clicking it opens the panel.
		const chip = findButton(tree);
		assert.ok(chip, 'the chip renders a button');
		chip.props.onClick();
		tree = renderTree();
		await new Promise((resolve) => setImmediate(resolve));
		tree = renderTree();
	}
	return render(tree).join(' ');
}

/**
 * Find the first button element in a rendered tree.
 * @param {object} node - the rendered tree.
 * @returns {object|null} the button element, or null.
 */
function findButton(node) {
	if (node === null || node === undefined || node === false) return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findButton(child);
			if (found) return found;
		}
		return null;
	}
	if (typeof node !== 'object') return null;
	if (node.type === 'button') return node;
	const children = node.props && node.props.children;
	if (Array.isArray(children)) return findButton(children);
	return findButton(children);
}

/**
 * One normalized quota row, as the host half serves it.
 * @param {string} provider - 'minimax' or 'opendesign'.
 * @param {number} intervalPercent - remaining percent of the 5-hour window.
 * @param {number} weeklyPercent - remaining percent of the weekly window.
 * @returns {object} the row.
 */
function row(provider, intervalPercent, weeklyPercent) {
	return {
		provider,
		model: provider === 'minimax' ? 'MiniMax Token Plan' : 'OpenDesign plan',
		intervalPercent,
		weeklyPercent,
		interval: { total: 100000, remaining: intervalPercent * 1000, used: 100000 - intervalPercent * 1000 },
		weekly: { total: 500000, remaining: weeklyPercent * 5000, used: 500000 - weeklyPercent * 5000 },
		intervalResetsAt: Date.now() + 3 * 3600 * 1000,
		weeklyResetsAt: Date.now() + 6 * 86400 * 1000,
		intervalMsLeft: 3 * 3600 * 1000,
		weeklyMsLeft: 6 * 86400 * 1000,
		intervalLabel: '5-hour',
		weeklyLabel: 'Weekly',
		intervalBadge: '5h',
		weeklyBadge: 'wk',
	};
}

/**
 * One host payload: the rows plus the per-provider status list.
 * @param {object[]} rows - the quota rows.
 * @param {object[]} providers - the per-provider status list.
 * @returns {object} the RPC result.
 */
function payload(rows, providers) {
	return {
		ok: true,
		value: {
			rows,
			providers,
			refreshMs: 60000,
			fetchedAt: Date.now(),
		},
	};
}

// 1. Two providers with rows: the chip shows the tighter percent and the
//    label of the provider that window belongs to. The looser provider comes
//    first on purpose, so the chip has to compare the windows rather than
//    take the first row it sees.
const bothProviders = payload(
	[row('opendesign', 91, 72), row('minimax', 64, 88)],
	[
		{ id: 'minimax', label: 'MiniMax', ok: true, error: null },
		{ id: 'opendesign', label: 'OpenDesign', ok: true, error: null },
	],
);
const both = await mount(bothProviders);
assert.match(both, /64%/, 'the chip shows the tighter percent across all providers');
assert.doesNotMatch(both, /91%/, 'the looser percent does not reach the chip');
assert.match(both, /MiniMax/, 'the chip names the provider the tightest window belongs to');
assert.doesNotMatch(both, /OpenDesign/, 'the chip does not name the looser provider');
assert.ok(
	failedLabels.some((label) => label.includes('MiniMax') && label.includes('64%')),
	'the chip accessible label names the tightest provider and its percent',
);

// 2. One provider fails: the chip still shows the working provider's percent,
//    and the failing provider's error reaches the panel.
const oneFailing = payload(
	[row('opendesign', 37, 80)],
	[
		{ id: 'minimax', label: 'MiniMax', ok: false, error: 'MiniMax API key missing' },
		{ id: 'opendesign', label: 'OpenDesign', ok: true, error: null },
	],
);
failedLabels = [];
const degraded = await mount(oneFailing);
assert.match(degraded, /37%/, 'the chip still shows the working provider percent');
assert.match(degraded, /OpenDesign/, 'the chip names the working provider');
assert.ok(
	failedLabels.some((label) => label.includes('OpenDesign') && label.includes('37%')),
	'the chip accessible label names the working provider and its percent',
);

// The panel lists every provider, so the failing one shows its error.
failedLabels = [];
const degradedPanel = await mount(oneFailing, true);
assert.match(degradedPanel, /MiniMax/, 'the panel still lists the failing provider');
assert.match(degradedPanel, /MiniMax API key missing/, 'the panel shows the failing provider error');
assert.ok(
	failedLabels.some((label) => label.includes('Plan usage')),
	'the panel is exposed as a labelled dialog',
);

// 3. No rows at all: the chip reports n/a.
const none = payload(
	[],
	[
		{ id: 'minimax', label: 'MiniMax', ok: false, error: 'no quota windows reported' },
		{ id: 'opendesign', label: 'OpenDesign', ok: false, error: 'vela missing' },
	],
);
const empty = await mount(none);
assert.match(empty, /n\/a/, 'no rows reports n/a on the chip');

console.log('client render checks passed');
