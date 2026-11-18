# dsh-plan-quota-chip

Plan quota chip for the DeepSeek Harness web surface: one compact entry in the
composer dock showing the tightest remaining plan quota across MiniMax and
OpenDesign, with the full per-provider detail in a click-to-open panel.

```
● MiniMax 5h 64%
```

The chip always shows the **tightest window across all providers** — the
reading that matters most, whichever provider it comes from. Click the chip to
open the panel and switch provider with the segmented control: **All** /
**MiniMax** / **OpenDesign**.

The chip never hides the other provider behind a failure: if MiniMax cannot be
read, the chip still reports OpenDesign (and the panel explains what went
wrong); if OpenDesign cannot be read, the chip still reports MiniMax.

## How it works

| Part | File | What it does |
| --- | --- | --- |
| Host | `lib/index.js` | Reads MiniMax through the credential seam and OpenDesign through the signed-in `vela` CLI session, serves both over the loopback RPC channel. |
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

The host half shells out to the OpenDesign `vela` CLI, which is already signed
in on this machine:

- `vela team-projects list` — resolves the workspace id.
- `vela billing funding-check --workspace-id <id> --format json` — the plan
  windows (5-hour and weekly) with their credit limits, remaining credits and
  reset times.
- `vela billing summary --format json` — the plan tier, the subscription and
  recharge credits, and the USD balance.

The gateway host (`amr-link.open-design.ai`) exposes no quota endpoint, and the
control plane (`amr-api.open-design.ai`) needs a separate control key that only
the CLI session holds, so the CLI is the supported seam.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: plan-usage
      name: 'dsh-plan-quota-chip'
      config:
        refreshMs: 60000
        credentialRef: MINIMAX_API_KEY
        velaBinary: ''
        workspaceId: ''
```

| Key | Default | Meaning |
|---|---|---|
| `refreshMs` | `60000` | How often the chip re-reads the quota (minimum 5000). |
| `credentialRef` | `MINIMAX_API_KEY` | Credential reference resolved through `ctx.credentials` (the harness credential seam). |
| `velaBinary` | `''` | Path to the `vela` CLI. Empty uses `$VELA_BIN`, then `~/.local/bin/vela`. |
| `workspaceId` | `''` | Workspace to query. Empty resolves it with `vela team-projects list`. |

The MiniMax credential must exist in the DSH credential store
(`~/.dsh/.credentials.yaml`). `MINIMAX_API_KEY` is already there on this
machine, so the MiniMax half works with no further setup.

## Install

```bash
dsh plugin --profile desktop add dsh-plan-quota-chip
```

The `vela` CLI has to be installed and signed in (`vela auth status`) for the
OpenDesign half to report anything. A provider that fails never hides the
other provider's data: the chip falls back to the provider that did answer,
and the panel shows the failing provider's error.

## Replaces

The standalone `dsh-minimax-quota` and `dsh-opendesign-quota` plugins, which
this package merges into one chip.

## License

MIT
