# gears-frontx-templates

The FrontX templates, split out of the `gears-frontx` monorepo into their own repository. This repo holds nothing but templates, the CI guards that keep them consistent with the FrontX ecosystem, and the tooling those guards need. It is not a workspace over the templates - each template is a standalone npm project with its own `package.json` and lockfile - and it has no `packages/*` of its own.

## What's here

```
template-shell/                 self-contained template: a full FrontX host app, its own toolchain
template-mfe/                   add-only overlay: MFE example packages composed onto a shell
template-design-guardrails/     manifest-only overlay: a design-review AI bundle, no runtime screen
scripts/                        CI guards + the in-monorepo dev loop for developing templates
```

Each template directory carries a `frontx-template.json` manifest - that is what makes it a template (ADR-0018: manifest presence, never a `template-*` name guess). `scripts/template-discovery.mjs` is the one place that rule lives; every guard here (`validate-templates.mjs`, `template-pin-drift-check.mjs`, `version-bump-on-change-check.mjs`, ...) discovers templates through it, so a renamed or relocated template, or a fourth template added later, needs no change to any of them.

## Consuming a template

The FrontX CLI addresses a template here by subtree, not by cloning the whole repo (ADR-0017, subtree addressing):

```
frontx seed shell --source github:constructorfabric/gears-frontx-templates//template-shell@<ref>
frontx add mfe    --source github:constructorfabric/gears-frontx-templates//template-mfe@<ref>
```

`<ref>` is a tag, branch, or commit. Pin it in anything meant to be reproducible - a floating branch ref (`@main`) will move under you.

## Relationship to the FrontX ecosystem

The templates pin the FrontX ecosystem packages they consume (`@gears-frontx/api`, `@gears-frontx/mfes`, `@gears-frontx/gts-plugin`, ...) to exact registry versions, published from [`gears-frontx`](https://github.com/constructorfabric/gears-frontx). This repo never builds those packages from source - it only verifies that a pinned version is real (see "Validating locally" below). `template-mfe`'s six overrides into `../template-shell` are the one exception: `template-shell` lives in this same repo, one level up, so its packages resolve locally without a publish round-trip - see the leading comment in `template-mfe/package.json`.

## Validating locally

```bash
npm ci
npm test                              # scripts/**/*.test.mjs (no network)
npm run validate:templates            # frontx validate (manifest + content self-containment) per template
npm run policy:template-pin-drift     # every exact ecosystem pin is a real published version (registry mode)
npm run policy:template-lockfile-selflink
npm run policy:token-format
npm run policy:guideline-index
```

`policy:template-pin-drift` runs in one of two modes:

- **registry mode** (default - no `FRONTX_ECOSYSTEM_DIR`): looks up every pinned ecosystem package directly on the npm registry and fails if the pinned version does not exist there. This is what CI runs on every push and PR.
- **sibling-checkout mode** (`FRONTX_ECOSYSTEM_DIR` set to a `gears-frontx` checkout): compares every pin against that checkout's actual `packages/*` versions instead - the same comparison this repo's tooling made back when the templates and the ecosystem shared one tree. The [Template Drift workflow](.github/workflows/template-drift.yml) and the dev loop below both use this mode.

Inside each template, its own scripts are self-contained:

```bash
cd template-shell
npm ci
npm run build
npm run type-check
npm run lint
npm run test:unit
```

## Dev loop against a sibling gears-frontx checkout

Working on both a template and the ecosystem packages it pins at once needs a sibling checkout - templates resolve their pins from the registry by default, so a local ecosystem edit is otherwise invisible here until it is published:

```bash
git clone https://github.com/constructorfabric/gears-frontx.git ../gears-frontx
cd ../gears-frontx && npm ci && npm run build:packages && cd -

export FRONTX_ECOSYSTEM_DIR=../gears-frontx   # or rely on the default: the sibling is found automatically
npm run dev:template:link                      # repoints template-shell's installed pins at ../gears-frontx/packages/*/dist
cd template-shell && npm run dev
```

`dev:template:link` ([`scripts/link-template-ecosystem.mjs`](scripts/link-template-ecosystem.mjs)) only repoints the directories inside `template-shell/node_modules` that the template pins to the registry - it reads the template's own manifests to find out which those are, so a newly pinned package is linked without editing the script. It never writes `package.json` or `package-lock.json`. Run `npm ci` inside `template-shell` to go back to the pinned registry versions - there is no `--unlink`.

**Forgetting to relink is silent**: the template builds, type-checks, and tests green against the published pins on its own, so a missing relink produces no error - it just means the ecosystem edits you're testing aren't the code being run. If a template-side result contradicts a change you just made in the sibling checkout, suspect the link first.

`FRONTX_ECOSYSTEM_DIR` defaults to the `../gears-frontx` sibling shown above if unset, for both `dev:template:link` and `scripts/pin-template-ecosystem-to-local.mjs`. `policy:template-pin-drift` makes the opposite choice on purpose: it only switches to sibling mode when `FRONTX_ECOSYSTEM_DIR` is explicitly set, so a plain `npm run policy:template-pin-drift` on a machine that happens to have an unrelated `../gears-frontx` checkout still runs the registry check CI runs, rather than silently trusting whatever is sitting next to this repo.

## CI

- **`main.yml`** - the guards above (`validate:templates`, `policy:template-pin-drift` in registry mode, `policy:template-lockfile-selflink`, `policy:token-format`, `policy:guideline-index`, `policy:version-bump-on-change` on pull requests) plus the `template-validate` job (each self-contained template installed and checked standalone; overlays composed onto `template-shell` and checked as a seeded project would see them).
- **`template-drift.yml`** - checks out `gears-frontx`'s `develop` branch into a sibling path, builds its packages, runs `policy:template-pin-drift` in sibling mode against that checkout (registry mode is what `main.yml` runs instead, with no sibling checkout available there), then runs the same pin-to-local + install + link + build/type-check sequence a developer runs locally. Push/PR to this repo can't see a `gears-frontx` change, so this also runs on a daily schedule and via `workflow_dispatch`.
- **`publish-packages.yml`** - publishes `@gears-frontx/frontx-template-shell` and its workspace subpackages, version-gated, in dependency order. Must run after the ecosystem packages a version bump here pins are themselves published on `gears-frontx` - a template publish that races ahead installs nothing until that lands.

## License

See [LICENSE](LICENSE) and [NOTICE](NOTICE).
