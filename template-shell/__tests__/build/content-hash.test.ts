// @vitest-environment node

/**
 * Tests for the two functions that make a published `contentHash` mean
 * anything: `normalizeEmbeddedModulePathsInSource` canonicalizes the
 * package-manager-layout differences esbuild bakes into a shared chunk's
 * bytes, and `computeContentHash` hashes those (already-normalized) bytes.
 * If normalization misses a shape, two builds of the same dependency hash
 * differently and cross-MFE chunk reuse silently never happens — so the
 * case that matters most here is `computeContentHash` agreeing across two
 * inputs that only differ in the shapes normalization is meant to handle.
 *
 * Both are exported from `../../src/build/mf-gts` as the minimal pure seam:
 * `normalizeEmbeddedModulePathsInSource` is the string transform underlying
 * the file-I/O wrapper `StandaloneEsmBuilder.normalizeEmbeddedModulePaths`
 * actually calls, and `computeContentHash` is the same hashing helper
 * `MfeJsonEnricher` calls, promoted to a free function.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeContentHash,
  normalizeEmbeddedModulePathsInSource,
} from '../../src/build/mf-gts';

describe('normalizeEmbeddedModulePathsInSource', () => {
  it('collapses pnpm\'s content-addressed store segment to the flat layout', () => {
    const pnpm =
      '// node_modules/.pnpm/react-dom@19.2.8/node_modules/react-dom/cjs/react-dom.development.js\n' +
      '"node_modules/.pnpm/react-dom@19.2.8/node_modules/react-dom/cjs/react-dom.development.js"(exports, module) {}';
    const flat =
      '// node_modules/react-dom/cjs/react-dom.development.js\n' +
      '"node_modules/react-dom/cjs/react-dom.development.js"(exports, module) {}';
    expect(normalizeEmbeddedModulePathsInSource(pnpm)).toBe(flat);
  });

  it('handles the pnpm store segment with a peer-suffixed store folder', () => {
    const withPeers =
      '// node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/index.js\n';
    const flat = '// node_modules/react-dom/index.js\n';
    expect(normalizeEmbeddedModulePathsInSource(withPeers)).toBe(flat);
  });

  it('collapses leading ../ depth hops before node_modules/', () => {
    const deep = '// ../../node_modules/react/index.js\n';
    const shallow = '// node_modules/react/index.js\n';
    expect(normalizeEmbeddedModulePathsInSource(deep)).toBe(shallow);
  });

  it('collapses both the pnpm segment and leading depth hops together', () => {
    const deepPnpm =
      '// ../../node_modules/.pnpm/react@19.2.8/node_modules/react/index.js\n';
    const flat = '// node_modules/react/index.js\n';
    expect(normalizeEmbeddedModulePathsInSource(deepPnpm)).toBe(flat);
  });

  it('normalizes both occurrence forms: the provenance comment and the __commonJS registry key', () => {
    const source =
      '// node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.production.js\n' +
      'var require_scheduler_production = __commonJS({\n' +
      '  "node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/cjs/scheduler.production.js"(exports, module) {\n' +
      '    // body\n' +
      '  }\n' +
      '});\n';
    const normalized = normalizeEmbeddedModulePathsInSource(source);
    expect(normalized).toBe(
      '// node_modules/scheduler/cjs/scheduler.production.js\n' +
        'var require_scheduler_production = __commonJS({\n' +
        '  "node_modules/scheduler/cjs/scheduler.production.js"(exports, module) {\n' +
        '    // body\n' +
        '  }\n' +
        '});\n'
    );
  });

  it('leaves a workspace-linked path with no node_modules segment untouched', () => {
    // Measured counter-example: a workspace-linked dependency emits a path
    // like this, with neither the pnpm-store nor the depth-hop shape this
    // function handles — it must pass through unchanged rather than being
    // silently mis-normalized.
    const linked = '// ../packages/mfes/dist/index.js\n';
    expect(normalizeEmbeddedModulePathsInSource(linked)).toBe(linked);
  });

  it('leaves source with no embedded module paths untouched', () => {
    const plain = 'export default function App() {}\n';
    expect(normalizeEmbeddedModulePathsInSource(plain)).toBe(plain);
  });
});

describe('computeContentHash', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-hash-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(fileName: string, contents: string): string {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, contents, 'utf-8');
    return filePath;
  }

  it('is deterministic over the same bytes', () => {
    const filePath = write('a.js', 'export default 1;\n');
    expect(computeContentHash(filePath)).toBe(computeContentHash(filePath));
  });

  it('returns a 64-char lowercase hex sha256 digest', () => {
    const filePath = write('a.js', 'export default 1;\n');
    const hash = computeContentHash(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns undefined and warns when the chunk file does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = path.join(dir, 'does-not-exist.js');
    expect(computeContentHash(missing)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain(missing);
    expect(message).toContain('[frontx-mf-gts]');
  });

  it('two-builds-same-hash: inputs differing only in normalized path shapes hash identically', () => {
    // Simulates the same dependency built twice — once under pnpm at one
    // cwd depth, once under pnpm at another — going through the full
    // pipeline (normalize, then hash) the plugin actually runs.
    const pnpmBuildA =
      '// node_modules/.pnpm/react-dom@19.2.8/node_modules/react-dom/cjs/react-dom.development.js\n' +
      'var require_x = __commonJS({\n' +
      '  "node_modules/.pnpm/react-dom@19.2.8/node_modules/react-dom/cjs/react-dom.development.js"(exports, module) {\n' +
      '    module.exports = {};\n' +
      '  }\n' +
      '});\n';
    const pnpmBuildB =
      '// ../../node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/cjs/react-dom.development.js\n' +
      'var require_x = __commonJS({\n' +
      '  "../../node_modules/.pnpm/react-dom@19.2.8_react@19.2.8/node_modules/react-dom/cjs/react-dom.development.js"(exports, module) {\n' +
      '    module.exports = {};\n' +
      '  }\n' +
      '});\n';

    const fileA = write('a.js', normalizeEmbeddedModulePathsInSource(pnpmBuildA));
    const fileB = write('b.js', normalizeEmbeddedModulePathsInSource(pnpmBuildB));

    expect(computeContentHash(fileA)).toBe(computeContentHash(fileB));
  });

  it('a real code difference still produces a different hash', () => {
    const pnpmBuildA =
      '// node_modules/.pnpm/react-dom@19.2.8/node_modules/react-dom/cjs/react-dom.development.js\n' +
      'module.exports = { version: "19.2.8" };\n';
    const pnpmBuildC =
      '// node_modules/.pnpm/react-dom@19.2.9/node_modules/react-dom/cjs/react-dom.development.js\n' +
      'module.exports = { version: "19.2.9" };\n';

    const fileA = write('a.js', normalizeEmbeddedModulePathsInSource(pnpmBuildA));
    const fileC = write('c.js', normalizeEmbeddedModulePathsInSource(pnpmBuildC));

    expect(computeContentHash(fileA)).not.toBe(computeContentHash(fileC));
  });
});
