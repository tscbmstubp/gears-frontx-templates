// @cpt-dod:cpt-frontx-dod-unit-test-generation-and-agent-verification-standard-test-convention:p1
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEPENDENCY_FIELDS,
  defaultNpmViewVersion,
  ecosystemScopeMatcher,
  findPackageJsonFiles,
  isExactRegistryVersionPin,
  readEcosystemPackages,
  readEcosystemTruthVersions,
  readRepoDefinedPackageNames,
  readTemplateEcosystemPackages,
  resolveEcosystemDir,
  scanTreePins,
  templatePinnedPackageDirs,
} from './template-ecosystem-packages.mjs';

/** @type {string | undefined} */
let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

async function makeRoot() {
  rootDir = await mkdtemp(path.join(tmpdir(), 'frontx-ecosystem-'));
  return rootDir;
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

/** The three packages the predecessor of this module used to name by hand. */
/**
 * @param {string} root
 * @param {Record<string, string>} [versions]
 */
async function writeEcosystemPackages(root, versions = {}) {
  for (const dir of ['api', 'mfes', 'gts-plugin']) {
    await writeJson(path.join(root, 'packages', dir, 'package.json'), {
      name: `@gears-frontx/${dir}`,
      version: versions[dir] ?? '0.3.0-alpha.0',
    });
  }
}

/** Relative paths with POSIX separators, so an expectation reads the same on any platform. */
/**
 * @param {string} from
 * @param {string[]} absolutePaths
 */
function relativePosix(from, absolutePaths) {
  return absolutePaths.map((p) => path.relative(from, p).split(path.sep).join('/')).sort();
}

// A minimal marker manifest - `findTemplateDirs` only checks for the file's
// presence, never its content.
/**
 * @param {string} templateDir
 */
async function writeTemplateManifest(templateDir) {
  await writeJson(path.join(templateDir, 'frontx-template.json'), {});
}

describe('readEcosystemPackages', () => {
  it('derives the ecosystem from every packages/* manifest, not from a curated subset', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root, { api: '0.4.0-alpha.1' });
    await writeJson(path.join(root, 'packages', 'cli', 'package.json'), {
      name: '@gears-frontx/cli',
      version: '0.3.0-alpha.1',
    });

    expect(readEcosystemPackages(root)).toEqual([
      { dir: 'api', name: '@gears-frontx/api', version: '0.4.0-alpha.1' },
      { dir: 'cli', name: '@gears-frontx/cli', version: '0.3.0-alpha.1' },
      { dir: 'gts-plugin', name: '@gears-frontx/gts-plugin', version: '0.3.0-alpha.0' },
      { dir: 'mfes', name: '@gears-frontx/mfes', version: '0.3.0-alpha.0' },
    ]);
  });

  // The whole reason the hand-maintained array had to go: #496 added
  // `packages/telemetry` while #493 was in review, and nothing noticed.
  it('picks up a package added to packages/ with no list to edit', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'packages', 'telemetry', 'package.json'), {
      name: '@gears-frontx/telemetry',
      version: '0.3.0-alpha.0',
    });

    expect(readEcosystemTruthVersions(root)['@gears-frontx/telemetry']).toBe('0.3.0-alpha.0');
  });

  it('skips a packages/* directory that carries no manifest at all', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await mkdir(path.join(root, 'packages', 'not-a-package'), { recursive: true });

    expect(readEcosystemPackages(root)).toHaveLength(3);
  });

  // An unusable manifest must never read as "this package has no version to
  // compare against", which is indistinguishable from "none of its pin sites
  // drifted". Each way the read can fail names the file.
  it('fails closed, naming the file, when a manifest cannot be parsed', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeFile(path.join(root, 'packages', 'api', 'package.json'), '{ "name": broken');

    expect(() => readEcosystemPackages(root)).toThrow(/cannot parse .*packages[/\\]api[/\\]package\.json as JSON/);
  });

  it('fails closed, naming the file, when a manifest is not a JSON object', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeFile(path.join(root, 'packages', 'mfes', 'package.json'), '["not", "an", "object"]');

    expect(() => readEcosystemPackages(root)).toThrow(/packages[/\\]mfes[/\\]package\.json is not a JSON object/);
  });

  it('fails closed, naming the file, when a manifest has no valid "name"', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'packages', 'api', 'package.json'), { version: '0.3.0-alpha.0' });

    expect(() => readEcosystemPackages(root)).toThrow(/packages[/\\]api[/\\]package\.json has no valid "name"/);
  });

  it('fails closed, naming the file, when a manifest has no valid "version"', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'packages', 'mfes', 'package.json'), { name: '@gears-frontx/mfes', version: '' });

    expect(() => readEcosystemPackages(root)).toThrow(/packages[/\\]mfes[/\\]package\.json has no valid "version"/);
  });
});

describe('ecosystemScopeMatcher', () => {
  it('recognises the ecosystem scope from the truth map\'s own names, never a written-down string', () => {
    const isEcosystemScopeName = ecosystemScopeMatcher(['@gears-frontx/api', '@gears-frontx/mfes']);

    expect(isEcosystemScopeName('@gears-frontx/telemetry')).toBe(true);
    expect(isEcosystemScopeName('@other-scope/api')).toBe(false);
    expect(isEcosystemScopeName('react')).toBe(false);
  });

  it('treats an unscoped ecosystem package as contributing no scope', () => {
    const isEcosystemScopeName = ecosystemScopeMatcher(['frontx-cli']);

    expect(isEcosystemScopeName('anything')).toBe(false);
  });
});

// The guard's own truth about what it governs. `isExactPin` (the ecosystem
// version policy's helper) answers a DIFFERENT question - "does this range carry
// a range operator" - which a monorepo-local `file:` specifier also answers "no"
// to, so reusing it made every `file:../../../packages/mfes` in template-mfe
// report as a pinned site drifted from a version it never expressed.
describe('isExactRegistryVersionPin', () => {
  it('accepts a bare exact registry version, prerelease included', () => {
    expect(isExactRegistryVersionPin('0.3.0-alpha.1')).toBe(true);
    expect(isExactRegistryVersionPin('1.2.3')).toBe(true);
  });

  it('rejects a local-path or protocol specifier, which expresses no version at all', () => {
    expect(isExactRegistryVersionPin('file:../../../packages/mfes')).toBe(false);
    expect(isExactRegistryVersionPin('link:../mfes')).toBe(false);
    expect(isExactRegistryVersionPin('workspace:*')).toBe(false);
    expect(isExactRegistryVersionPin('git+https://example.com/x.git')).toBe(false);
  });

  it('rejects a range - that is the ecosystem edge-compatibility policy\'s concern', () => {
    expect(isExactRegistryVersionPin('^0.3.0')).toBe(false);
    expect(isExactRegistryVersionPin('*')).toBe(false);
    expect(isExactRegistryVersionPin('>=0.2.0-0')).toBe(false);
  });
});

describe('findPackageJsonFiles', () => {
  it('finds every package.json under a directory, skipping node_modules', async () => {
    const root = await makeRoot();
    const templateDir = path.join(root, 'template-shell');
    await writeJson(path.join(templateDir, 'package.json'), { name: 'tpl' });
    await writeJson(path.join(templateDir, 'packages', 'framework', 'package.json'), { name: 'framework' });
    await writeJson(path.join(templateDir, 'node_modules', 'some-dep', 'package.json'), { name: 'some-dep' });

    expect(relativePosix(templateDir, findPackageJsonFiles(templateDir))).toEqual([
      'package.json',
      'packages/framework/package.json',
    ]);
  });

  // CodeRabbit review finding on #493: a pinned dependency site inside a hidden
  // directory is exactly as real as one anywhere else - skipping dot-prefixed
  // directories would silently stop checking it, the same completeness hole found
  // in `createFsListContentOwnedFilesFn`.
  it('does NOT skip a package.json nested under a dot-prefixed directory', async () => {
    const root = await makeRoot();
    const templateDir = path.join(root, 'template-shell');
    await writeJson(path.join(templateDir, '.hidden-workspace', 'package.json'), { name: 'hidden' });

    expect(relativePosix(templateDir, findPackageJsonFiles(templateDir))).toEqual([
      '.hidden-workspace/package.json',
    ]);
  });
});

describe('scanTreePins', () => {
  const isEcosystemScopeName = ecosystemScopeMatcher(['@gears-frontx/api']);

  it('finds an exact-pinned ecosystem dependency across every dependency field', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), {
      dependencies: { '@gears-frontx/api': '0.3.0-alpha.0' },
      devDependencies: { '@gears-frontx/mfes': '0.3.0-alpha.0' },
    });

    const { sites } = scanTreePins(root, isEcosystemScopeName);

    expect(sites.map((s) => s.packageName).sort()).toEqual(['@gears-frontx/api', '@gears-frontx/mfes']);
  });

  // The pin site is found by walking the dependency MAP, not a list of known
  // names - which is exactly how a package added to `packages/` later gets
  // covered without anyone editing anything.
  it('finds a pin on a package the caller has never heard of, as long as it is in the ecosystem scope', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), {
      dependencies: { '@gears-frontx/telemetry': '0.3.0-alpha.0' },
    });

    expect(scanTreePins(root, isEcosystemScopeName).sites).toHaveLength(1);
  });

  it('ignores a range, a local-path specifier, and a package outside the ecosystem scope', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), {
      peerDependencies: { '@gears-frontx/api': '^0.3.0-alpha.0' },
      dependencies: { '@gears-frontx/mfes': 'file:../../../packages/mfes', react: '19.2.4' },
    });

    expect(scanTreePins(root, isEcosystemScopeName).sites).toEqual([]);
  });

  it('does not report a package pinning itself', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), {
      name: '@gears-frontx/mfes',
      dependencies: { '@gears-frontx/mfes': '0.3.0-alpha.0' },
    });

    expect(scanTreePins(root, isEcosystemScopeName).sites).toEqual([]);
  });

  it('reports the package names the tree DEFINES alongside the pins it declares', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), { name: '@gears-frontx/frontx-template-shell' });
    await writeJson(path.join(root, 'packages', 'auth', 'package.json'), { name: '@gears-frontx/auth' });

    const { definedPackageNames } = scanTreePins(root, isEcosystemScopeName);

    expect([...definedPackageNames].sort()).toEqual(['@gears-frontx/auth', '@gears-frontx/frontx-template-shell']);
  });

  // Review finding on #493: this used to `continue` past a malformed manifest,
  // so "unreadable" read as "zero pins here" - and zero pins is also what a
  // clean tree looks like.
  it('fails closed, naming the file, on a malformed manifest rather than counting it as zero pins', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'package.json'), 'not-valid-json{{{');

    expect(() => scanTreePins(root, isEcosystemScopeName)).toThrow(/cannot parse .*package\.json as JSON/);
  });
});

describe('readRepoDefinedPackageNames', () => {
  it('collects the root name plus every name its workspaces patterns select', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), {
      name: 'gears-frontx',
      workspaces: ['packages/*', 'internal/*'],
    });
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'internal', 'eslint-config', 'package.json'), {
      name: '@gears-frontx/eslint-config',
      version: '0.2.0-alpha.0',
    });

    const names = readRepoDefinedPackageNames(root);

    expect(names.has('gears-frontx')).toBe(true);
    expect(names.has('@gears-frontx/api')).toBe(true);
    // The name that motivates this function: outside the truth map, still
    // resolved locally by npm, so a pin on it is not an unverifiable pin.
    expect(names.has('@gears-frontx/eslint-config')).toBe(true);
  });

  it('handles a wildcard-free workspace pattern that names one directory', async () => {
    const root = await makeRoot();
    await writeJson(path.join(root, 'package.json'), { name: 'repo', workspaces: ['tools/codegen'] });
    await writeJson(path.join(root, 'tools', 'codegen', 'package.json'), { name: '@repo/codegen' });

    expect(readRepoDefinedPackageNames(root).has('@repo/codegen')).toBe(true);
  });

  it('returns an empty set for a root with no manifest', async () => {
    const root = await makeRoot();

    expect(readRepoDefinedPackageNames(root).size).toBe(0);
  });
});

describe('templatePinnedPackageDirs', () => {
  it('derives the linkable set from what the template actually pins', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'packages', 'telemetry', 'package.json'), {
      name: '@gears-frontx/telemetry',
      version: '0.3.0-alpha.0',
    });
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      dependencies: { '@gears-frontx/api': '0.3.0-alpha.0', '@gears-frontx/mfes': '0.3.0-alpha.0' },
    });
    await writeJson(path.join(root, 'template-shell', 'packages', 'framework', 'package.json'), {
      devDependencies: { '@gears-frontx/gts-plugin': '0.3.0-alpha.0' },
    });

    // telemetry exists but is not pinned, so there is nothing published to
    // shadow a local edit to it - and nothing to link.
    expect(templatePinnedPackageDirs(root, 'template-shell')).toEqual(['api', 'gts-plugin', 'mfes']);
  });

  // Would have been the #496 regression in the dev loop: a newly pinned package
  // must become linkable without anyone editing a list.
  it('picks up a newly pinned ecosystem package with no list to edit', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'packages', 'telemetry', 'package.json'), {
      name: '@gears-frontx/telemetry',
      version: '0.3.0-alpha.0',
    });
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      dependencies: { '@gears-frontx/telemetry': '0.3.0-alpha.0' },
    });

    expect(templatePinnedPackageDirs(root, 'template-shell')).toEqual(['telemetry']);
  });

  it('excludes a dependency the template reaches through a local path, which needs no link', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      dependencies: { '@gears-frontx/api': 'file:../packages/api', '@gears-frontx/mfes': '*' },
    });

    expect(templatePinnedPackageDirs(root, 'template-shell')).toEqual([]);
  });

  it('returns an empty set for a template directory that does not exist', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);

    expect(templatePinnedPackageDirs(root, 'template-gone')).toEqual([]);
  });
});

// #501: template-mfe pins template-shell/packages/* and template-shell itself,
// none of which live under this repo's own `packages/*` - so without asking
// the templates the same question `packages/*` already answers ("what do you
// publish, and at what version"), those pins are structurally unverifiable.
describe('readTemplateEcosystemPackages', () => {
  const isEcosystemScopeName = ecosystemScopeMatcher(['@gears-frontx/api']);

  it("contributes a template's own name+version when it is inside the ecosystem scope", async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/frontx-template-shell',
      version: '0.1.0-alpha.1',
    });

    expect(readTemplateEcosystemPackages(root, isEcosystemScopeName)).toContainEqual({
      dir: 'template-shell',
      name: '@gears-frontx/frontx-template-shell',
      version: '0.1.0-alpha.1',
    });
  });

  it('contributes every workspace member the workspaces patterns select, alongside the template itself', async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/frontx-template-shell',
      version: '0.1.0-alpha.1',
      workspaces: ['packages/*'],
    });
    await writeJson(path.join(root, 'template-shell', 'packages', 'auth', 'package.json'), {
      name: '@gears-frontx/auth',
      version: '0.2.0-alpha.1',
    });

    const packages = readTemplateEcosystemPackages(root, isEcosystemScopeName);

    expect(packages).toContainEqual({ dir: 'template-shell', name: '@gears-frontx/frontx-template-shell', version: '0.1.0-alpha.1' });
    expect(packages).toContainEqual(
      expect.objectContaining({ name: '@gears-frontx/auth', version: '0.2.0-alpha.1' }),
    );
  });

  // template-mfe's own root manifest names itself `frontx-template-mfe-monorepo-
  // harness` - unscoped, `private: true`, and (deliberately, per its own comment)
  // carrying no version at all. That is not a broken manifest to fail closed on:
  // it is simply not a truth candidate, the same judgment `packages/*` makes for
  // a directory with no manifest at all, applied here to a name outside the
  // scope this map governs.
  it('skips a template whose own name is outside the ecosystem scope, even with no version present', async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-mfe'));
    await writeJson(path.join(root, 'template-mfe', 'package.json'), {
      name: 'frontx-template-mfe-monorepo-harness',
      private: true,
    });

    expect(() => readTemplateEcosystemPackages(root, isEcosystemScopeName)).not.toThrow();
    expect(readTemplateEcosystemPackages(root, isEcosystemScopeName)).toEqual([]);
  });

  it('skips a template root manifest that declares no name at all', async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-mfe'));
    await writeJson(path.join(root, 'template-mfe', 'package.json'), { private: true });

    expect(readTemplateEcosystemPackages(root, isEcosystemScopeName)).toEqual([]);
  });

  it('skips a template directory that carries no root package.json at all', async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-mfe'));

    expect(readTemplateEcosystemPackages(root, isEcosystemScopeName)).toEqual([]);
  });

  // The counterpart to the skip above: an in-scope name IS a truth candidate,
  // so a missing version on it must never read as "nothing to compare against" -
  // the same fail-closed rule `packages/*` applies to its own manifests.
  it("fails closed, naming the file, when a template's own in-scope name has no valid version", async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/frontx-template-shell',
    });

    expect(() => readTemplateEcosystemPackages(root, isEcosystemScopeName)).toThrow(
      /template-shell[/\\]package\.json has no valid "version"/,
    );
  });

  it('fails closed, naming the file, when a workspace member has an in-scope name but no valid version', async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/frontx-template-shell',
      version: '0.1.0-alpha.1',
      workspaces: ['packages/*'],
    });
    await writeJson(path.join(root, 'template-shell', 'packages', 'auth', 'package.json'), {
      name: '@gears-frontx/auth',
    });

    expect(() => readTemplateEcosystemPackages(root, isEcosystemScopeName)).toThrow(
      /packages[/\\]auth[/\\]package\.json has no valid "version"/,
    );
  });

  it('skips a workspace member directory that carries no manifest at all', async () => {
    const root = await makeRoot();
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/frontx-template-shell',
      version: '0.1.0-alpha.1',
      workspaces: ['packages/*'],
    });
    await mkdir(path.join(root, 'template-shell', 'packages', 'not-a-package'), { recursive: true });

    expect(() => readTemplateEcosystemPackages(root, isEcosystemScopeName)).not.toThrow();
  });
});

describe('readEcosystemTruthVersions with templates', () => {
  it("folds a template's own version and its workspace members into the truth map, on top of packages/*", async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root);
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/frontx-template-shell',
      version: '0.1.0-alpha.1',
      workspaces: ['packages/*'],
    });
    await writeJson(path.join(root, 'template-shell', 'packages', 'auth', 'package.json'), {
      name: '@gears-frontx/auth',
      version: '0.2.0-alpha.1',
    });

    const truth = readEcosystemTruthVersions(root);

    expect(truth['@gears-frontx/frontx-template-shell']).toBe('0.1.0-alpha.1');
    expect(truth['@gears-frontx/auth']).toBe('0.2.0-alpha.1');
    // packages/* itself is untouched by the fold.
    expect(truth['@gears-frontx/api']).toBe('0.3.0-alpha.0');
  });

  // Verified today: no `packages/*` directory shares a name with any template
  // or template workspace member (see the module docblock). This proves the
  // tie-break the docblock commits to for if that ever changes: `packages/*`
  // is this repo's actual publish source, so it must win over a template's
  // copy of the same name rather than being silently overwritten by it.
  it('prefers the packages/* version over a template contribution of the same name', async () => {
    const root = await makeRoot();
    await writeEcosystemPackages(root, { api: '0.4.0-alpha.0' });
    await writeTemplateManifest(path.join(root, 'template-shell'));
    await writeJson(path.join(root, 'template-shell', 'package.json'), {
      name: '@gears-frontx/api',
      version: '0.1.0-alpha.0',
    });

    expect(readEcosystemTruthVersions(root)['@gears-frontx/api']).toBe('0.4.0-alpha.0');
  });
});

// #492 review finding 2's "unguarded duplicated literal" class. DEPENDENCY_FIELDS
// is deliberately a local literal here (not an import from
// `validate-content-self-containment.ts`) so no repo-script depends on the CLI
// package being built - a real property worth keeping.
//
// The cross-repo half of this guard - comparing against the canonical
// TypeScript source - no longer lives here: `validate-content-self-
// containment.ts` moved to `gears-frontx` with the rest of `packages/cli` when
// the templates split into their own repo, so there is nothing under this
// repo's `packages/cli/...` to read any more. That comparison does NOT now
// belong in `gears-frontx`'s own test suite either - that repo has no way to
// see a literal declared in this one, so nothing anywhere compares the two
// automatically any more. If the CLI's real dependency-field list ever
// changed, this copy would go silently stale for every script that reads it
// (`pinSitesIn`, and the pin-drift and version-bump-on-change checks built on
// it). The practical mitigation that remains is `validate-templates.mjs`: it
// never reads this local literal, importing the INSTALLED `@gears-frontx/cli`
// and running its own content-self-containment check against this repo's
// real template manifests directly - so a drift here still surfaces as
// validate:templates misbehaving against real content, not as a silent pass
// everywhere. What stays here is a confidence check that the four fields
// this repo's own guards act on are exactly the ones the ecosystem's
// dependency graph has - not a sync guard, just a name for what
// DEPENDENCY_FIELDS has to keep meaning if either repo edits it.
it('DEPENDENCY_FIELDS covers exactly the npm-resolved dependency kinds', () => {
  expect(DEPENDENCY_FIELDS).toEqual(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
});

describe('resolveEcosystemDir', () => {
  const original = process.env.FRONTX_ECOSYSTEM_DIR;

  beforeEach(() => {
    delete process.env.FRONTX_ECOSYSTEM_DIR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FRONTX_ECOSYSTEM_DIR;
    else process.env.FRONTX_ECOSYSTEM_DIR = original;
  });

  it('defaults to the ../gears-frontx sibling when unset', () => {
    expect(resolveEcosystemDir('/repo')).toBe(path.resolve('/repo', '..', 'gears-frontx'));
  });

  it('defaults to the sibling when set to an empty/blank string', () => {
    process.env.FRONTX_ECOSYSTEM_DIR = '   ';
    expect(resolveEcosystemDir('/repo')).toBe(path.resolve('/repo', '..', 'gears-frontx'));
  });

  it('resolves an explicit FRONTX_ECOSYSTEM_DIR relative to repoRoot', () => {
    process.env.FRONTX_ECOSYSTEM_DIR = '../my-gears-frontx-checkout';
    expect(resolveEcosystemDir('/repo')).toBe(path.resolve('/repo', '..', 'my-gears-frontx-checkout'));
  });

  it('leaves an absolute FRONTX_ECOSYSTEM_DIR unchanged', () => {
    process.env.FRONTX_ECOSYSTEM_DIR = '/somewhere/else/gears-frontx';
    expect(resolveEcosystemDir('/repo')).toBe('/somewhere/else/gears-frontx');
  });
});

describe('defaultNpmViewVersion', () => {
  // Review finding: every `npm view` failure used to map to "not found, fix
  // the pin" - indistinguishable from a real registry outage or a broken
  // local npm. Only `npm error code E404` (an unknown name OR an unknown
  // version - both shapes) means "not found"; anything else is rethrown as
  // an infra error the caller cannot silently treat as a bad pin.
  function fakeExecThrowing(stderr) {
    return () => {
      const error = new Error('Command failed');
      error.stderr = stderr;
      throw error;
    };
  }

  it('returns true when npm view succeeds with a non-empty version', () => {
    const fakeExec = () => '"0.3.0-alpha.1"\n';
    expect(defaultNpmViewVersion('@gears-frontx/api', '0.3.0-alpha.1', fakeExec)).toBe(true);
  });

  it('returns false for an unknown package name (E404)', () => {
    const fakeExec = fakeExecThrowing(
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@gears-frontx%2fghost',
    );
    expect(defaultNpmViewVersion('@gears-frontx/ghost', '1.0.0', fakeExec)).toBe(false);
  });

  it('returns false for a known package at an unpublished version (E404)', () => {
    const fakeExec = fakeExecThrowing('npm error code E404\nnpm error 404 No match found for version 9.9.9');
    expect(defaultNpmViewVersion('@gears-frontx/api', '9.9.9', fakeExec)).toBe(false);
  });

  it('rethrows a non-E404 failure instead of reporting it as "not found"', () => {
    const fakeExec = fakeExecThrowing('npm error code ENOTFOUND\nnpm error network request to registry.npmjs.org failed');
    expect(() => defaultNpmViewVersion('@gears-frontx/api', '0.3.0-alpha.1', fakeExec)).toThrow(
      /failed for a reason other than "not found"/,
    );
    // The distinct message carries the real detail, not a generic "not found".
    expect(() => defaultNpmViewVersion('@gears-frontx/api', '0.3.0-alpha.1', fakeExec)).toThrow(/ENOTFOUND/);
  });

  it('rethrows when the failure carries no stderr at all (e.g. npm itself missing)', () => {
    const fakeExec = () => {
      throw new Error('spawnSync npm ENOENT');
    };
    expect(() => defaultNpmViewVersion('@gears-frontx/api', '0.3.0-alpha.1', fakeExec)).toThrow(/ENOENT/);
  });
});
