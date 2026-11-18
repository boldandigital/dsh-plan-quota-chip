# Where this plugin is published

Three channels, all reachable today. This file records what each one needs,
so nothing has to be rediscovered later.

## 1. npm — the install path

This package is published on npm as
[`dsh-plan-quota-chip`](https://www.npmjs.com/package/dsh-plan-quota-chip).

```sh
dsh plugin --profile desktop add dsh-plan-quota-chip
```

npm is the channel the harness itself resolves: `dsh plugin add <name>` looks
a package name up in the registry, and the plugin market index format's
`source: { "type": "npm" }` points at a registry version with its publish time
and its `engines.dsh`.

| | |
|---|---|
| Package name | `dsh-plan-quota-chip` |
| Registry owner | the npm account that published it |
| Author field | `boldandigital (https://github.com/boldandigital)` |
| Versions | `0.1.0` |

The npm **name** is permanent: npm only allows an unpublish within 72 hours
of a release, and the name stays reserved afterwards. Publishing `0.1.1` and
later is the only way forward.

The name `dsh-plan-usage` is deliberately **not** used: npm already has a
package under it (`dsh-plan-usage@0.2.1`, an unrelated multi-channel plugin by
another author), and npm names cannot be reused.

## 2. The plugin market index — the Discover tab

The index is its own repository, published with GitHub Pages. An entry points
at the registry version, so it only exists once the package is on npm:

```json
{
  "id": "boldandigital/dsh-plan-quota-chip",
  "title": "Plan usage",
  "description": "The tightest remaining plan quota across MiniMax and OpenDesign, in the composer dock.",
  "source": { "type": "npm", "package": "dsh-plan-quota-chip" }
}
```

## 3. GitHub — the source and the release

The source lives at
[`github.com/boldandigital/dsh-plan-quota-chip`](https://github.com/boldandigital/dsh-plan-quota-chip).
The publish workflow (`.github/workflows/publish.yml`) publishes the version in
`package.json` to npm with OIDC when a matching `v*` tag is pushed, so no
long-lived token is stored anywhere.

npm only accepts an OIDC publish from a workflow it has a trusted publisher
for. Configure one at:

```text
https://www.npmjs.com/package/dsh-plan-quota-chip/settings
```

with the repository `boldandigital/dsh-plan-quota-chip`, the workflow file
`publish.yml`, and the `npm publish` allowed action. Without it npm answers
`E404 ... you do not have permission to access it`.

Configuring the trusted publisher needs a person, because it needs a 2FA
session in the browser: **Package → Settings → Trusted Publisher**. The
equivalent CLI is:

```sh
npm trust github dsh-plan-quota-chip --file publish.yml \
  --repo boldandigital/dsh-plan-quota-chip --allow-publish
```

which asks for confirmation and then fails with a 403 when run with a token
that bypasses two-factor authentication.
