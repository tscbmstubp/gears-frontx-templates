# Contributing

## Layout

Every top-level directory carrying `frontx-template.json` is a template (ADR-0018: manifest presence, never a `template-*` name guess - `scripts/template-discovery.mjs` is the one place that rule lives). Today there are three:

- **`template-shell/`** - self-contained: a full FrontX host app with its own `package.json`, lockfile, and toolchain (build, lint, type-check, test:unit, arch:deps).
- **`template-mfe/`** - add-only overlay: example MFE packages meant to be composed onto a shell by `frontx add`. It has no runtime of its own to validate standalone; `template-mfe/package.json` is a monorepo-only dev harness (see its leading `//` comment) that `frontx add` never copies into a seeded project.
- **`template-design-guardrails/`** - manifest-only overlay: a design-review AI bundle and a verification package, no root `package.json` at all.

`scripts/` holds the guards that keep all three consistent with each other and with the FrontX ecosystem, plus the dev-loop tooling for working on a template against a local ecosystem checkout.

## Versioning and publishing

This repo has one long-lived branch, `main` - unlike the ecosystem repo it split from, there is
no `develop` here. `.github/workflows/publish-packages.yml` triggers on pushes to `main` and to
`release/v*`, and picks the npm dist-tag from the branch and the version string:

| Version format | Channel | Branch |
|---|---|---|
| `0.y.z-alpha.N` | `alpha` | `main` |
| `0.y.z-rc.N` | `next` | `main` |
| `0.y.z` | `latest` | `main` |
| any version | `vN` | `release/vN` |

A PR that changes non-documentation source under a governed root's `src/`, or the dependency fields of its `package.json`, must bump that root's own `version` in the same PR and update every exact pin on it (`policy:template-pin-drift`). A governed root is `template-shell` itself, every `template-shell/packages/*` workspace member, and any other non-`private` `@gears-frontx`-scoped template or template workspace member added later - discovered structurally by `scripts/version-bump-on-change-check.mjs`, never a hardcoded list. `template-mfe`'s fixture MFE packages are `private` and exempt: they pin published versions rather than being one.

`policy:version-bump-on-change` (pull requests only) compares the version at the PR's merge base against its head, so a bump later reverted within the same PR does not count.

Publishing (`.github/workflows/publish-packages.yml`) runs after a push to `main` or `release/v*`, version-gated and in dependency order (leaf packages - `state`, `i18n`, `auth`, the shell itself - before `framework`, before `react`, before `studio`). **It must run after the FrontX ecosystem packages a bumped pin here names are themselves published on `gears-frontx`** - a template publish is not gated on that in CI (the two repos can't see each other's workflow runs), so bump the template's pins only once the ecosystem version they name is actually on the registry.

## Template development loop

The templates pin FrontX ecosystem packages (`@gears-frontx/api`, `@gears-frontx/mfes`, `@gears-frontx/gts-plugin`, ...) to exact registry versions, so that a seeded project installs outside any monorepo. A plain `npm install` inside a template therefore always resolves the **published** version - editing a sibling `gears-frontx` checkout has no effect on a template until you relink:

```bash
git clone https://github.com/constructorfabric/gears-frontx.git ../gears-frontx   # once
cd ../gears-frontx && npm ci && npm run build:packages                            # after every ecosystem edit

cd ../gears-frontx-templates
npm run dev:template:link     # point template-shell's node_modules at ../gears-frontx/packages/*/dist
cd template-shell && npm run dev
```

`dev:template:link` ([`scripts/link-template-ecosystem.mjs`](scripts/link-template-ecosystem.mjs)) reads the template's own manifests to find out which registry-pinned packages to repoint, so a newly pinned package needs no change to the script. It never touches `package.json` or `package-lock.json` - only the installed directories under `node_modules`. What each linked directory then resolves through is its `dist/`, which is why the script refuses to link an unbuilt package.

`FRONTX_ECOSYSTEM_DIR` controls where the ecosystem checkout is found, for both `dev:template:link` and `scripts/pin-template-ecosystem-to-local.mjs`: set it explicitly, or rely on the default `../gears-frontx` sibling shown above.

> **Forgetting to relink is silent.** The template builds, type-checks, and tests green against the published pins on its own. Nothing warns you. Relink after every ecosystem change, and when a template-side result contradicts a change you just made in the sibling checkout, suspect the link first.

To go back to the pinned registry versions, run `npm ci` inside the template. There is no `--unlink`: the links replace published tarball *content*, which only npm can restore.

Two ways to lose the links without meaning to:

- **any `npm install` inside the template** (say, while adding a dependency) reifies the tree from the lockfile and silently puts the registry tarballs back. Relink afterwards.
- an ecosystem rebuild that removes `packages/*/dist` (`npm run clean:artifacts` in the `gears-frontx` checkout) leaves the links pointing at nothing. Rebuilding restores them; the link script refuses to run at all if the build is missing.

### Why Template Drift CI installs without a lockfile

[`template-drift.yml`](.github/workflows/template-drift.yml) checks out `gears-frontx`'s `develop` branch into a sibling path, builds its packages, points the template's pins at that checkout (`scripts/pin-template-ecosystem-to-local.mjs`), then installs with `npm install --no-package-lock` instead of `npm ci`. Both departures from the ordinary install exist for reasons that are easy to re-break without this record.

**Why not `npm ci` against the rewritten manifests.** Rewriting the pins ahead of install desyncs the template's `package-lock.json` from its `package.json` by construction, and `npm ci` refuses to run against a desynced lockfile. `npm install` reconciles it instead - which is exactly the operation that trips `--no-package-lock`'s reason below.

**Why `--no-package-lock` is load-bearing.** `template-shell` pins its own root package to itself via a `file:.` override, materialized as an npm-managed symlink that `packages/framework` resolves through. Reconciling a desynced lockfile is exactly the operation npm `<= 11.13.0` gets wrong for a self-referential `file:.` entry (npm/cli#524, already referenced by `scripts/template-lockfile-selflink-check.mjs`): it drops the link from the *installed tree*, not just the lockfile, and the build fails. Skipping lockfile reconciliation with `--no-package-lock` sidesteps the bug regardless of the runner's npm version.

**The tradeoff this accepts.** Without the lockfile guiding resolution, transitive dependencies float to their latest in-range version instead of the exact pinned one. That's acceptable for this job specifically, since its purpose is detecting drift between the ecosystem checkout and the template, not verifying that the exact pinned dependency tree installs cleanly - that's `main.yml`'s `template-validate` job, which runs an unmodified `npm ci`.

## Validation

```bash
npm ci
npm test                              # scripts/**/*.test.mjs
npm run validate:templates
npm run policy:template-pin-drift     # registry mode locally; set FRONTX_ECOSYSTEM_DIR for sibling mode
npm run policy:template-lockfile-selflink
npm run policy:token-format
npm run policy:guideline-index
```

Each template is also independently validatable:

```bash
cd template-shell && npm ci && npm run build && npm run type-check && npm run lint && npm run test:unit
```

`template-mfe` cannot be validated in place - its packages' `file:` links resolve into `template-mfe/../template-shell`, and its own root `package.json` is a monorepo-only harness, never something a seeded project sees. `main.yml`'s `template-validate` job composes it onto `template-shell` (the way `frontx add` does) and validates the result; there is no equivalent single local command today.

## DCO

Commits must be signed off (`git commit -s`) per the Developer Certificate of Origin.
