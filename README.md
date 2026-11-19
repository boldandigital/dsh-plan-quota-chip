# dsh-plan-quota-chip

Plan quota chip for the DeepSeek Harness web surface: one compact entry in the
composer dock showing the remaining plan quota across MiniMax and OpenDesign,
with the full per-provider detail in a click-to-open panel.

```
● Plan usage 5h 64%
```

The chip shows **one combined number for every plan**: the windows of all
providers are pooled into a single remaining percentage, and the accessible
label carries the remaining credits as well (`Plan usage: 64% 5-hour
(1.2M of 2M left)`). Click the chip to open the panel and narrow it down with
the window control (**5-hour** / **Weekly**) and the provider control (**All** /
**MiniMax** / **OpenDesign**).

A provider on a plan without quota windows (a free account, for example) is
still described: the panel shows its plan state — tier, credits, balance and
whether a coding plan applies — instead of only "No quota windows reported".

The chip never hides the other provider behind a failure: if MiniMax cannot be
read, the chip still reports OpenDesign (and the panel explains what went
wrong); if OpenDesign cannot be read, the chip still reports MiniMax.

## How it works

| Part | File | What it does |
| --- | --- | --- |
| Host | `lib/index.js` | Reads MiniMax through the credential seam and OpenDesign through the control plane (or the signed-in `vela` CLI as a fallback), serves both over the loopback RPC channel. |
| Client | `lib/client.js` | Renders the chip and the panel in the `conversation.composer.dock` slot. |

The data flows over the Connection RPC channel `/api` (method namespace
`plan-usage`). The client never talks to MiniMax or OpenDesign directly: the
host half normalizes both providers into one shared row shape and answers over
the local channel, so no credential ever reaches the browser.

## Where the quota comes from

### MiniMax

Tried in order; the first that answers wins:

| Region | Endpoint |
|---|---|
| international | `https://api.minimax.io/v1/api/openplatform/coding_plan/remains` |
| international | `https://www.minimax.io/v1/token_plan/remains` |
| china | `https://api.minimaxi.com/v1/token_plan/remains` |

All three accept a plain API key as `Authorization: Bearer <key>` — no admin
key required.

**The region reporting quirk:** the international endpoints report
`current_interval_usage_count` / `current_weekly_usage_count` as **how much is
left**, while the China endpoint reports **how much was used**. Naive
subtraction therefore inverts the numbers on one side. The host half reads the
region-independent `*_remaining_percent` fields as the source of truth and
only derives "x of y left" from the counts, interpreting them per region.

### OpenDesign

Two seams, tried in this order.

**1. The control plane** (`https://amr-api.open-design.ai/api/v1`). This is the
credential that actually carries the plan, because the OpenDesign provider key
and the `vela` CLI session can belong to *different* accounts — the CLI is only
signed in to whichever account ran `vela login`, and that one may be a free
account with no windows at all. When `OPENDESIGN_CONTROL_KEY` (a `vela_ctrl_…`
key) resolves from the DSH credential store, the host reads:

- `GET /workspaces` — resolves the account's default workspace.
- `GET /workspaces/<ws>/billing/preflight` — the coding-plan windows (5-hour
  and weekly) with credit limits, remaining credits and reset times, plus the
  `funding` / `fundingCheck` / `taskCheck` verdicts.
- `GET /workspaces/<ws>/billing/snapshot` — the design-plan windows
  (`designPlanWindows`), the plan tier and interval, the wallet balance and
  whether the plan cancels at the period end.

Both calls need only `Authorization: Bearer <control key>` plus the optional
`x-vela-workspace-id` header, so no CLI binary is required on that path.

**2. The `vela` CLI**, the fallback for an account the CLI itself is logged into:

- `vela team-projects list` — resolves the workspace id.
- `vela billing funding-check --workspace-id <id> --format json` — the coding
  plan windows (5-hour and weekly) with their credit limits, remaining credits
  and reset times.
- `vela billing workspace-snapshot --workspace-id <id> --format json` — the
  design plan windows (`designPlanWindows`, a 5-hour and a 7-day window in
  credits) and the workspace's billing state. This is the same call the
  OpenDesign desktop app makes, so both window sets are read.
- `vela billing summary --format json` — the plan tier, the subscription and
  recharge credits, and the USD balance.

The gateway host (`amr-link.open-design.ai`) that the provider itself uses
exposes no quota endpoint at all — every `/v1/*` and `/api/v1/*` quota path
answers `404 page not found`, and a chat completion carries no quota headers —
so the control plane and the CLI are the only two seams that report a plan.

**A plan without windows still has a state.** An account on a free plan has no
quota window at all, so the panel reports its plan state instead of only
"No quota windows reported": tier, credits left, USD balance, whether a coding
plan applies, whether the first month is still free, and when the plan cancels.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: plan-usage
      name: 'dsh-plan-quota-chip'
      config:
        refreshMs: 60000
        credentialRef: MINIMAX_API_KEY
        controlKeyRef: OPENDESIGN_CONTROL_KEY
        velaBinary: ''
        workspaceId: ''
```

| Key | Default | Meaning |
|---|---|---|
| `refreshMs` | `60000` | How often the chip re-reads the quota (minimum 5000). |
| `credentialRef` | `MINIMAX_API_KEY` | Credential reference resolved through `ctx.credentials` (the harness credential seam). |
| `controlKeyRef` | `OPENDESIGN_CONTROL_KEY` | Credential reference for the OpenDesign control key (`vela_ctrl_…`). When it resolves, the control plane is read instead of the CLI. |
| `velaBinary` | `''` | Path to the `vela` CLI. Empty uses `$VELA_BIN`, then `~/.local/bin/vela`. |
| `workspaceId` | `''` | Workspace to query. Empty resolves it (control plane: the account's default workspace; CLI: `vela team-projects list`). |

The MiniMax credential must exist in the DSH credential store
(`~/.dsh/.credentials.yaml`). `MINIMAX_API_KEY` is already there on this
machine, so the MiniMax half works with no further setup.

For OpenDesign, add the control key of the account that owns the plan:

```yaml
OPENDESIGN_CONTROL_KEY: vela_ctrl_...
```

`vela` keeps that key in its own session store, which no other process
reads, so it has to be copied into the DSH credential store once.

## Install

```bash
dsh plugin --profile desktop add dsh-plan-quota-chip
```

Without `OPENDESIGN_CONTROL_KEY` the `vela` CLI has to be installed and signed
in (`vela auth status`) for the OpenDesign half to report anything — but note
that the CLI only knows the account it was logged into, which is not
necessarily the account the provider key bills. A provider that fails never
hides the other provider's data: the chip falls back to the provider that did
answer, and the panel shows the failing provider's error.

## Replaces

The standalone `dsh-minimax-quota` and `dsh-opendesign-quota` plugins, which
this package merges into one chip.

## License

MIT
