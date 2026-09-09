/**
 * Template Pin-Drift CI Guard (#493 work item 3).
 *
 * PR #492 (#485) pinned the FrontX ecosystem packages a template consumes to
 * exact registry versions across every `package.json` that declares them. A
 * manual version bump to `packages/api/package.json` (etc.) that misses even one
 * of those sites ships a template with a mixed version set, and the in-monorepo
 * dev loop (`dev:template:link`) actively masks it: it links local sources
 * regardless of what's pinned, so the drift is invisible until a real
 * `npm install` outside the monorepo.
 *
 * Nothing about this check is a static list - not the file paths, not the
 * template names, and (since the review of this branch) not the package set
 * either. Every one of those lists would be the same duplicated knowledge the
 * guard exists to prevent, and each stopped covering new ground the moment the
 * repo moved: the #470 template split relocated the pin sites
 * (`template-standard/` became `template-shell/` plus `template-mfe/`), and #496
 * added `packages/telemetry` while this branch was in review. So everything is
 * discovered structurally instead:
 *
 *  - WHICH PACKAGES are a version truth: every `packages/*` manifest, PLUS
 *    every template's own identity and workspace members (`template-mfe` pins
 *    `template-shell/packages/*` and `template-shell` itself - #501 - neither
 *    of which lives under this repo's `packages/*`), read by
 *    `template-ecosystem-packages.mjs` (see its docblock for the fail-closed
 *    rules and for why a pin on a name outside that combined truth is a
 *    failure rather than a skip).
 *  - WHICH TEMPLATES to walk: every directory carrying `frontx-template.json`
 *    (ADR-0018 manifest presence, not a `template-*` name prefix), so a renamed
 *    or relocated template stays covered - and zero templates found is a hard
 *    failure, never a vacuous pass.
 *  - WHICH SITES to compare: every dependency field of every `package.json`
 *    under a template that names an ecosystem-scope package at an exact registry
 *    version.
 *
 * The same rule then runs over the governed packages' OWN manifests, because an
 * intra-ecosystem exact pin drifts the same way and with a worse blame radius:
 * `packages/gts-plugin` runtime-depends on `@gears-frontx/mfes` at an exact
 * version, so a bump that misses it installs two different MFE runtime copies
 * into one tree, which is the one thing a single-runtime framework cannot
 * survive (reviewer ask on #492).
 *
 * ONE SITE IS NEVER PART OF THAT SIBLING-MODE COMPARISON: this repo's own
 * root `package.json` (its `@gears-frontx/cli` devDependency, today). That
 * devDependency installs the PUBLISHED CLI so `validate-templates.mjs` can
 * run it - it is a tool this repo's own tooling needs, not a template pin,
 * and it cannot follow whatever version happens to be checked out in a
 * sibling `gears-frontx` working tree (which may well be an unpublished
 * `develop` snapshot `npm ci` could never install). So the root manifest's
 * pins are ALWAYS verified against the npm registry directly - in BOTH
 * modes - never against sibling-checkout truth. See `rootNpmViewVersion`
 * and `rootManifestPinSites` in `check()` below.
 *
 * Every failure mode is reported through the exit code with a message naming the
 * file - an unreadable manifest, a malformed one, a pin nothing can verify - so
 * a red build never reads as a broken script.
 *
 * CLI entry: `node scripts/template-pin-drift-check.mjs` (exit 0 on success).
 * Core logic is exported for unit tests in
 * `scripts/template-pin-drift-check.test.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  defaultNpmViewVersion,
  ecosystemScopeMatcher,
  ecosystemScopeMatcherFromTemplates,
  pinSitesIn,
  readEcosystemPackages,
  readEcosystemTruthVersions,
  readTemplateEcosystemPackages,
  resolveEcosystemMode,
  readPackageManifest,
  readRepoDefinedPackageNames,
  scanTreePins,
} from './template-ecosystem-packages.mjs';
import { MANIFEST_FILENAME, findTemplateDirs } from './template-discovery.mjs';

// Re-exported so the failure message this script prints when discovery finds
// nothing can name the filename without reaching past `template-discovery.mjs`,
// which owns it.
export { MANIFEST_FILENAME };

/**
 * @typedef {import('./template-ecosystem-packages.mjs').PinSite} PinSite
 * @typedef {PinSite & { actualVersion: string }} DriftedSite
 */

/**
 * Finds every exact-registry-version pin, in the monorepo's OWN `packages/*`
 * manifests, that names an ecosystem-scope package.
 *
 * Only each package's own root manifest is read, not its whole subtree: that
 * manifest is the published dependency declaration, whereas a nested
 * `package.json` under `packages/*` is a build artifact or test fixture whose
 * pins nobody installs. A directory with no manifest at all is skipped, but a
 * manifest that IS there and cannot be read or parsed fails closed - "unreadable"
 * must never be allowed to read as "no pins here".
 *
 * @param {string} rootDir monorepo root
 * @param {(name: string) => boolean} isEcosystemScopeName
 * @returns {PinSite[]}
 */
export function findEcosystemPinSites(rootDir, isEcosystemScopeName) {
  const packagesDir = path.join(rootDir, 'packages');
  if (!fs.existsSync(packagesDir)) return [];

  /** @type {PinSite[]} */
  const sites = [];
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const filePath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(filePath)) continue;
    const manifest = readPackageManifest(filePath);
    sites.push(...pinSitesIn(manifest, path.relative(rootDir, filePath), isEcosystemScopeName));
  }
  return sites;
}

/**
 * Every exact-registry-version pin site this repo's OWN top-level
 * `package.json` declares - the root manifest itself, never anything under
 * `packages/*` (that is `findEcosystemPinSites`'s job). This repo has no
 * `packages/*`, so before this existed the root manifest's own pins (its
 * `@gears-frontx/cli` devDependency, today) were never checked by EITHER
 * mode: `findEcosystemPinSites` only walks `<rootDir>/packages/*`, which is
 * always empty here, and nothing else looked at the root file at all.
 *
 * DISCOVERY only - this just finds the sites. `check()` verifies every site
 * this returns against the REGISTRY unconditionally (`rootNpmViewVersion`),
 * never against sibling-mode truth: the root manifest's devDependency
 * installs the PUBLISHED CLI (so `validate-templates.mjs` can run it), which
 * cannot follow whatever version a sibling `gears-frontx` checkout has on
 * disk, and it is not a template pin in the first place. That asymmetry is
 * why this is a separate function from `findEcosystemPinSites` rather than a
 * site folded into the same sibling-mode truth comparison.
 *
 * Reported at `file: 'package.json'` (root-relative, no directory prefix).
 *
 * @param {string} rootDir
 * @param {(name: string) => boolean} isEcosystemScopeName
 * @returns {PinSite[]}
 */
export function rootManifestPinSites(rootDir, isEcosystemScopeName) {
  const manifestPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return [];
  const manifest = readPackageManifest(manifestPath);
  return pinSitesIn(manifest, 'package.json', isEcosystemScopeName);
}

/**
 * @param {PinSite[]} sites
 * @param {Record<string, string>} truthVersions
 * @returns {DriftedSite[]}
 */
export function findDriftedSites(sites, truthVersions) {
  return sites
    .filter((site) => {
      const actual = truthVersions[site.packageName];
      return actual !== undefined && actual !== site.pinnedVersion;
    })
    .map((site) => ({ ...site, actualVersion: truthVersions[site.packageName] }));
}

/**
 * The pins that cannot be compared at all: an ecosystem-scope name with no
 * truth entry, which the scanned tree does not define itself either.
 *
 * This is the counterpart to `findDriftedSites` and the reason it can stay as
 * simple as it is. "No truth entry" is indistinguishable from "matches" to a
 * comparison, so without this classification a name that leaves `packages/`
 * (renamed, deleted, moved out) would silently take every pin on it out of the
 * check. Names the tree defines itself are excluded because npm resolves those
 * through a workspace and no registry version exists to drift from - see
 * `template-ecosystem-packages.mjs` for why that exception is load-bearing
 * rather than a courtesy.
 *
 * @param {PinSite[]} sites
 * @param {Record<string, string>} truthVersions
 * @param {Set<string>} locallyDefinedNames names the scanned tree itself defines
 * @returns {PinSite[]}
 */
export function findUnverifiableSites(sites, truthVersions, locallyDefinedNames) {
  return sites.filter(
    (site) => truthVersions[site.packageName] === undefined && !locallyDefinedNames.has(site.packageName),
  );
}

/**
 * @param {{ rootDir: string; log: (line: string) => void; logError: (line: string) => void }} context
 * @returns {number}
 */
function check({ rootDir, log, logError, npmViewVersion, env }) {
  // Now that the templates live in their own repo, there is no local
  // `packages/*` truth map to always compare against - see
  // `resolveEcosystemMode`'s docblock for the two modes this splits into.
  const mode = resolveEcosystemMode({ npmViewVersion, env });

  // The root manifest's own pins (this repo's `@gears-frontx/cli`
  // devDependency, today) are verified against the REGISTRY unconditionally,
  // in both modes - never against a sibling checkout's `packages/*`. That
  // devDependency installs the PUBLISHED CLI so `validate-templates.mjs` can
  // run it; it cannot follow whatever version an ecosystem sibling checkout
  // happens to have on disk (an unpublished `develop` version would break
  // `npm ci` here), and it is not a template pin site in the first place - a
  // template ships to a seeded project, this repo's own tooling manifest
  // does not. Comparing it against sibling-mode truth used to report a false
  // "drifted" finding the moment the sibling checkout's in-development CLI
  // version moved past whatever is actually published.
  const rootNpmViewVersion = npmViewVersion ?? defaultNpmViewVersion;

  /** @type {import('./template-ecosystem-packages.mjs').EcosystemPackage[] | null} */
  let siblingEcosystemPackages = null;
  if (mode.mode === 'sibling') {
    siblingEcosystemPackages = readEcosystemPackages(mode.dir);
    // Fail-closed floor, same rule as the zero-templates check below: a
    // typo'd or missing FRONTX_ECOSYSTEM_DIR (no directory at all, a
    // directory with no `packages/`, or a `packages/` with nothing readable
    // in it) must never read as "zero pins drifted" - `readEcosystemPackages`
    // treats every one of those as "no packages" rather than throwing, which
    // is exactly indistinguishable from a real (currently impossible)
    // ecosystem with zero packages unless this checks for it explicitly. A
    // bad path used to pass vacuously: nothing to compare against means
    // nothing is ever classified as drifted.
    if (siblingEcosystemPackages.length === 0) {
      logError(
        `[template-pin-drift-check] FAIL: FRONTX_ECOSYSTEM_DIR=${mode.dir} has no packages/* to read ` +
          '(the directory, or its packages/ subdirectory, is missing or empty) - sibling mode has ' +
          'nothing to compare any pin against. Point FRONTX_ECOSYSTEM_DIR at a real gears-frontx ' +
          'checkout, or unset it to fall back to registry mode.',
      );
      return 1;
    }
  }

  const isEcosystemScopeName =
    mode.mode === 'sibling'
      ? ecosystemScopeMatcher(/** @type {import('./template-ecosystem-packages.mjs').EcosystemPackage[]} */ (siblingEcosystemPackages).map(({ name }) => name))
      : ecosystemScopeMatcherFromTemplates(rootDir);

  const templateDirs = findTemplateDirs(rootDir);

  // A5 review finding: zero templates found is never a silent pass - a glob
  // that stops matching (a rename, a relocation) would otherwise report
  // "0 drifted sites" as success. Either no template exists (unexpected -
  // this repo always ships at least one) or discovery is broken; either way
  // a human needs to see it.
  if (templateDirs.length === 0) {
    logError(`[template-pin-drift-check] FAIL: no template found under ${rootDir} (looked for a top-level directory carrying ${MANIFEST_FILENAME}).`);
    return 1;
  }

  /** @type {Array<DriftedSite & { reportedPath: string }>} */
  const allDrifted = [];
  /** @type {Array<PinSite & { reportedPath: string }>} */
  const allUnverifiable = [];
  /** @type {Array<PinSite & { reportedPath: string }>} */
  const allUnresolved = [];

  if (mode.mode === 'sibling') {
    // Not `packages/*` alone: a template can pin another template's own
    // identity or one of that template's workspace members (#501), so the
    // truth map this guard compares against has to include those too. See
    // `readEcosystemTruthVersions` for what gets folded in and why
    // `packages/*` wins any (currently nonexistent) name collision with a
    // template.
    const truthVersions = readEcosystemTruthVersions(rootDir, mode.dir);

    for (const templateDir of templateDirs) {
      const { sites, definedPackageNames } = scanTreePins(templateDir, isEcosystemScopeName);
      const templateName = path.basename(templateDir);
      for (const site of findDriftedSites(sites, truthVersions)) {
        allDrifted.push({ ...site, reportedPath: path.join(templateName, site.file) });
      }
      for (const site of findUnverifiableSites(sites, truthVersions, definedPackageNames)) {
        allUnverifiable.push({ ...site, reportedPath: path.join(templateName, site.file) });
      }
    }

    // This repo's own `<rootDir>/packages/*/package.json` manifests (empty
    // here - this repo has none - but kept for parity with the ecosystem
    // repo's own copy of this check) carry the same kind of pin, checked
    // against the same truth by the same rules. `site.file` is already
    // root-relative, so it needs no template-name prefix. The root
    // `package.json` itself is deliberately NOT folded in here - see the
    // module docblock and `rootNpmViewVersion` above for why its pins are
    // always a registry question, never a sibling-truth comparison.
    const ecosystemSites = findEcosystemPinSites(rootDir, isEcosystemScopeName);
    const repoDefinedNames = readRepoDefinedPackageNames(rootDir);
    allDrifted.push(...findDriftedSites(ecosystemSites, truthVersions).map((site) => ({ ...site, reportedPath: site.file })));
    allUnverifiable.push(
      ...findUnverifiableSites(ecosystemSites, truthVersions, repoDefinedNames).map((site) => ({ ...site, reportedPath: site.file })),
    );
  } else {
    // Registry mode: a template's OWN contributions (its own identity, its
    // workspace members) are still a truth this repo can vouch for directly
    // - they are derived from this checkout's own manifests, not from the
    // registry. Every other ecosystem-scoped pin is verified by asking the
    // registry whether the exact pinned version exists at all; there is no
    // "current version" to drift from here, only "does this exist".
    const templateTruth = Object.fromEntries(
      readTemplateEcosystemPackages(rootDir, isEcosystemScopeName).map(({ name, version }) => [name, version]),
    );

    // Shared by every template's group of sites classified below, so all of
    // them get exactly the same treatment rather than a copy of the rule
    // per template. The root manifest does NOT go through this - see
    // `rootNpmViewVersion` above for why its pins are always a registry
    // question, in every mode.
    /**
     * @param {import('./template-ecosystem-packages.mjs').PinSite[]} sites
     * @param {Set<string>} definedNames
     * @param {string | null} prefix
     */
    const classifyRegistrySites = (sites, definedNames, prefix) => {
      const reportPath = (/** @type {string} */ file) => (prefix ? path.join(prefix, file) : file);
      const knownSites = sites.filter((site) => site.packageName in templateTruth);
      for (const site of findDriftedSites(knownSites, templateTruth)) {
        allDrifted.push({ ...site, reportedPath: reportPath(site.file) });
      }
      for (const site of sites) {
        if (site.packageName in templateTruth) continue;
        // A pin the scanned tree resolves locally through its own workspace
        // needs no registry round-trip - same exemption as sibling mode's
        // "unverifiable" rule, just checked before spending a network call.
        if (definedNames.has(site.packageName)) continue;
        if (!mode.npmViewVersion(site.packageName, site.pinnedVersion)) {
          allUnresolved.push({ ...site, reportedPath: reportPath(site.file) });
        }
      }
    };

    for (const templateDir of templateDirs) {
      const { sites, definedPackageNames } = scanTreePins(templateDir, isEcosystemScopeName);
      classifyRegistrySites(sites, definedPackageNames, path.basename(templateDir));
    }
  }

  // The root manifest's own pins, in BOTH modes: always a registry existence
  // check (`rootNpmViewVersion`, computed above), never sibling-truth or
  // template-truth comparison - see the module docblock for why. A pin the
  // repo resolves locally through its own workspace needs no registry
  // round-trip, same exemption template pins get.
  const rootSites = rootManifestPinSites(rootDir, isEcosystemScopeName);
  const repoDefinedRootNames = readRepoDefinedPackageNames(rootDir);
  for (const site of rootSites) {
    if (repoDefinedRootNames.has(site.packageName)) continue;
    if (!rootNpmViewVersion(site.packageName, site.pinnedVersion)) {
      allUnresolved.push({ ...site, reportedPath: site.file });
    }
  }

  if (allDrifted.length > 0) {
    logError(`[template-pin-drift-check] FAIL: ${allDrifted.length} pinned site(s) drifted from the ecosystem's actual version:`);
    for (const site of allDrifted) {
      logError(`  ${site.reportedPath} ${site.field}["${site.packageName}"]: pinned ${site.pinnedVersion}, actual ${site.actualVersion}`);
    }
    logError(
      '\nBump the pinned site(s) above to match the package(s)\' actual version, then rerun ' +
        '`npm run policy:template-pin-drift` to confirm. Do NOT run `npm run dev:template:link` to ' +
        'investigate this - it links local sources regardless of what is pinned and would mask the drift.',
    );
  }

  if (allUnverifiable.length > 0) {
    logError(
      `[template-pin-drift-check] FAIL: ${allUnverifiable.length} pinned site(s) name an ecosystem package ` +
        'this repo does not publish, so the pin cannot be verified:',
    );
    for (const site of allUnverifiable) {
      logError(`  ${site.reportedPath} ${site.field}["${site.packageName}"]: pinned ${site.pinnedVersion}, no packages/* manifest declares that name`);
    }
    logError(
      '\nEither the package was renamed or removed from `packages/` and the pin(s) above still name ' +
        'the old name, or the name is a typo. A pin nobody can compare is not a pin that passes: fix ' +
        'the name, or drop the pin if the dependency is gone.',
    );
  }

  if (allUnresolved.length > 0) {
    logError(
      `[template-pin-drift-check] FAIL: ${allUnresolved.length} pinned site(s) name a version that does not exist ` +
        'on the npm registry:',
    );
    for (const site of allUnresolved) {
      logError(`  ${site.reportedPath} ${site.field}["${site.packageName}"]: pinned ${site.pinnedVersion}, not found on the npm registry`);
    }
    logError(
      '\nEither the version has not been published yet, the pin is stale, or it is a typo - the version must be ' +
        'real on the registry regardless of mode: a template pin in registry mode (no FRONTX_ECOSYSTEM_DIR ' +
        'configured), or a pin on this repo\'s OWN root package.json (e.g. @gears-frontx/cli) in either mode - the ' +
        'root manifest installs the published CLI, so its pins are never compared against a sibling checkout.',
    );
  }

  if (allDrifted.length > 0 || allUnverifiable.length > 0 || allUnresolved.length > 0) return 1;

  log(
    mode.mode === 'sibling'
      ? `Template pin-drift check passed (sibling mode, ${mode.dir}): every pinned site across ` +
          `${templateDirs.length} template(s) matches the ecosystem's actual versions.`
      : `Template pin-drift check passed (registry mode): every pinned site across ${templateDirs.length} ` +
          'template(s) either resolves locally or names a version that exists on the npm registry.',
  );
  return 0;
}

/**
 * CI entry point. Wired into `npm run policy:template-pin-drift` and
 * `.github/workflows/main.yml`.
 *
 * Every fail-closed throw raised while reading a manifest is caught here and
 * turned into an exit code with the message that names the offending file: a
 * guard whose own crash looks different from its own failure teaches developers
 * to read a red build as "the script is broken".
 *
 * @param {{
 *   rootDir?: string;
 *   log?: (line: string) => void;
 *   logError?: (line: string) => void;
 *   npmViewVersion?: (name: string, version: string) => boolean;
 *   env?: Record<string, string | undefined>;
 * }} [options]
 * @returns {number} 0 on success, 1 on failure.
 */
export function runCli(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;

  try {
    return check({ rootDir, log, logError, npmViewVersion: options.npmViewVersion, env: options.env });
  } catch (error) {
    logError(`[template-pin-drift-check] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  // `process.exitCode` rather than `process.exit()`: the latter can truncate a
  // still-flushing stdout/stderr write, which for a guard means losing the very
  // lines that say what failed.
  process.exitCode = runCli();
}
