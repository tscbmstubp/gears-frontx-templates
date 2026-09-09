/**
 * Vitest project for this repo's root `scripts/` toolchain - the guards that
 * validate the templates (manifest + content self-containment, pin-drift,
 * lockfile self-links, token format, guideline-index, version-bump-on-change).
 *
 * Anchored at `scripts/` rather than an unanchored `**` glob: each template
 * directory (`template-shell/`, `template-mfe/`) owns its own Vitest config
 * and its own test suite, and an unanchored glob here would additionally
 * collect (and double-report) whatever those configs already cover.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', 'template-*/**'],
    passWithNoTests: false,
  },
});
