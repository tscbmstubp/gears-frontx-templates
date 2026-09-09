// @cpt-dod:cpt-frontx-dod-unit-test-generation-and-agent-verification-standard-test-convention:p1
//
// One home for the discovery rule's tests, matching the one home the rule
// itself now has. Both CI guards used to carry their own copy of
// `findTemplateDirs` and their own copy of these cases (CodeRabbit on #493).
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MANIFEST_FILENAME, findTemplateDirs } from './template-discovery.mjs';

/** @type {string | undefined} */
let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

async function makeRoot() {
  rootDir = await mkdtemp(path.join(tmpdir(), 'frontx-template-discovery-'));
  return rootDir;
}

// Discovery only checks that the file is THERE, never what it contains - the
// manifest's content is the CLI validate command's subject.
/** @param {string} dir */
async function writeManifest(dir, filename = MANIFEST_FILENAME) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), '{}');
}

describe('findTemplateDirs', () => {
  // The property that made the #470 split a no-op for both guards: a template
  // is its manifest (ADR-0018), so `template-standard/` becoming
  // `template-shell/` plus `template-mfe/` needed no discovery change. A
  // `template-*` glob would instead have kept passing while covering nothing.
  it('finds every top-level directory carrying the manifest, whatever it is named', async () => {
    const root = await makeRoot();
    await writeManifest(path.join(root, 'template-shell'));
    await writeManifest(path.join(root, 'a-renamed-template'));
    await mkdir(path.join(root, 'packages'), { recursive: true }); // no manifest - not a template

    expect(findTemplateDirs(root).map((d) => path.basename(d))).toEqual(['a-renamed-template', 'template-shell']);
  });

  it('ignores a directory named template-* that carries no manifest', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'template-empty'), { recursive: true });

    expect(findTemplateDirs(root)).toEqual([]);
  });

  it('ignores node_modules even if it somehow carries a manifest', async () => {
    const root = await makeRoot();
    await writeManifest(path.join(root, 'node_modules', 'something'));

    expect(findTemplateDirs(root)).toEqual([]);
  });

  // CodeRabbit review finding on #493: excluding every dot-prefixed directory
  // reintroduces the location assumption manifest-presence discovery exists to
  // drop. node_modules is the one true exclusion.
  it('does NOT ignore a dot-prefixed top-level directory that carries a manifest', async () => {
    const root = await makeRoot();
    await writeManifest(path.join(root, '.hidden-template'));

    expect(findTemplateDirs(root).map((d) => path.basename(d))).toEqual(['.hidden-template']);
  });

  // `validate-templates.mjs` passes the built CLI's own exported constant, so
  // that guard checks the CLI's idea of the filename rather than a second copy.
  it('honours a caller-supplied manifest filename over the local default', async () => {
    const root = await makeRoot();
    await writeManifest(path.join(root, 'template-shell'), 'a-different-manifest-name.json');

    expect(findTemplateDirs(root)).toEqual([]);
    expect(findTemplateDirs(root, 'a-different-manifest-name.json').map((d) => path.basename(d))).toEqual([
      'template-shell',
    ]);
  });
});

// #492 review finding 2's "unguarded duplicated literal" class. MANIFEST_FILENAME
// is deliberately a local literal rather than an import from `@gears-frontx/cli`,
// so a repo-script never needs the CLI built.
//
// Both sync guards this file used to carry here compared THIS repo's
// `MANIFEST_FILENAME` literal (and template list) against files that lived in
// the SAME repo back when the templates and the ecosystem shared one tree:
// `packages/cli/src/manifest/types.ts` (the canonical export this constant
// mirrors) and `.cf-studio/config/artifacts.toml` (the Constructor Studio
// artifact registry's template-territory ignore globs). Neither file exists
// here any more - both live in `gears-frontx` now, on the other side of the
// split. That does NOT mean the sync-guard OBLIGATION moved there: `gears-
// frontx`'s test suite has no way to see a literal declared in THIS repo, so
// nothing anywhere compares the two automatically any more. If the CLI's
// canonical `MANIFEST_FILENAME` ever changed, this repo's copy would go
// silently stale for every script that reads it (`template-pin-drift-
// check.mjs` and friends, via `findTemplateDirs`'s default). The practical
// mitigation that remains is `validate-templates.mjs`: it never reads this
// local literal at all, importing the INSTALLED `@gears-frontx/cli` and
// running its `validateCommand` (and its own live `MANIFEST_FILENAME`)
// against this repo's real template manifests directly - so a drift here
// still surfaces as validate:templates misbehaving against real content, not
// as a silent pass everywhere.

/**
 * Confidence check that the `MANIFEST_FILENAME` literal comment still names
 * the file this repo's own templates actually carry - not a cross-repo sync
 * guard (see the note above), just this repo's half of "does the mirrored
 * constant still say what it claims to mirror".
 */
it('MANIFEST_FILENAME matches the manifest every template in this repo actually carries', async () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const templateDirs = findTemplateDirs(repoRoot, MANIFEST_FILENAME);
  expect(templateDirs.length).toBeGreaterThan(0);
});
