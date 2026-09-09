/**
 * Template-side MFES Import-Boundary CI Guard (ADR-0003 confirmation
 * section; ported from gears-frontx's scripts/mfes-import-boundary-check.mjs
 * when the templates split into this repo).
 *
 * ADR-0003 (`mfe-runtime-public-surface`) shaped `@gears-frontx/mfes` around
 * an abstract facade: consumers depend on `MfeRegistry` and obtain instances
 * through `createMfeRegistryFactory().build({ typeSystem })`, while the
 * concrete implementation classes stay internal to the package. The
 * ecosystem repo's own copy of this guard checks BOTH halves of that
 * boundary: the barrel (`packages/mfes/src/index.ts` must not export a
 * concrete name) and the consumers (no file outside `packages/mfes` may
 * import a concrete name or deep-import a subpath). Only `packages/mfes`
 * itself moved with the split - the barrel it exports FROM never lived here
 * - so this file carries only the CONSUMER half: `@gears-frontx/mfes` is
 * pinned to a registry version by every template here, and #540's actual
 * incident (`template-shell` growing a `new DefaultMfeRegistryFactory()`
 * call nobody noticed) was a consumer-side violation. Losing this half when
 * `template-shell` moved would have made ADR-0003's "CI confirms both
 * halves of the boundary" claim false the moment the split landed.
 *
 * The forbidden set is a NAMING RULE, not a class list: every concrete
 * default implementation in the runtime is named `Default<Contract>` (or,
 * for the bridge factory, `<Contract>Default`), and the abstract contracts
 * never carry that affix. No file under any template directory here may
 * import a concrete-implementation name from `@gears-frontx/mfes`, and no
 * file may deep-import a subpath (`@gears-frontx/mfes/...`) at all - a deep
 * import reaches past the barrel into exactly the internals it exists to
 * hide. Aliasing does not launder a name: the ORIGINAL binding is checked,
 * not the local alias, and `import type` counts - a type-level dependency on
 * a concrete class couples the consumer to its shape just the same.
 *
 * WHICH FILES are consumers: every scannable-extension file under a
 * manifest-discovered template directory (`template-discovery.mjs` - same
 * rule every other guard here uses), skipping generated/third-party trees
 * and dot-directories. Zero templates found, or zero scannable consumer
 * files, is a hard failure, never a vacuous pass - same rule as
 * `template-pin-drift-check.mjs`.
 *
 * Why a script and not eslint `no-restricted-imports`: each template ships
 * its own `eslint.config.js` a template author is free to edit, not a place
 * a cross-template boundary can durably live.
 *
 * CLI entry: `node scripts/template-mfes-import-boundary-check.mjs` (exit 0
 * on success). Wired into `npm run policy:template-mfes-import-boundary` and
 * `.github/workflows/main.yml`. Core logic is exported for unit tests in
 * `scripts/template-mfes-import-boundary-check.test.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { findTemplateDirs } from './template-discovery.mjs';

export const MFES_PACKAGE_NAME = '@gears-frontx/mfes';

/** Directories never walked: generated output and third-party trees. */
const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', 'coverage']);

/** File extensions that can carry an ES import of the runtime package. */
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Concrete-but-not-`Default*`-named exports that the naming rule cannot catch
 * (see the DESIGN public-surface debt register in `packages/mfes/
 * architecture/DESIGN.md`, in gears-frontx - this repo has no packages/mfes
 * of its own to keep a copy of that register): a barrel export that is debt,
 * not sanctioned surface, but keeps a contract-shaped name. Kept in sync by
 * hand with the ecosystem repo's own copy of this constant, since a name
 * seeded there is exactly a name this half must also treat as forbidden.
 *
 * @type {Set<string>}
 */
export const CONCRETE_EXPORT_DENYLIST = new Set([]);

/**
 * The concrete-implementation naming rule (see the docblock for why a rule and
 * not a list): `Default` as a leading affix on a class-cased name, or as a
 * trailing affix (`MfeBridgeFactoryDefault`), or a name explicitly seeded into
 * `CONCRETE_EXPORT_DENYLIST`.
 *
 * @param {string} name an exported/imported binding's original name
 * @returns {boolean}
 */
export function isConcreteImplementationName(name) {
  return /^Default[A-Z]/.test(name) || /Default$/.test(name) || CONCRETE_EXPORT_DENYLIST.has(name);
}

/**
 * @typedef {{ file: string; specifier: string; statement: string }} ImportSite
 * @typedef {ImportSite & { names: string[] }} ParsedImportSite
 */

/**
 * Words after which a `/` starts a regex literal, not a division — the lexer
 * rule the slash context needs when the preceding token is a word (`return
 * /x/` is a regex; `count /x/` would be division).
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'case', 'throw',
]);

/**
 * Keywords whose parenthesized head is a CONDITION, after whose closing `)` a
 * `/` starts a regex literal (`if (x) /re/.test(y)`), unlike the `)` of a call
 * or grouping, after which `/` is division (`f(x) / 2`).
 */
const CONDITION_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch']);

/**
 * Incremental slash-disambiguation state for the scanners: whether a `/` at
 * the current position starts a regex literal or is a division operator. Fed
 * one significant code character (or one completed literal token) at a time,
 * so deciding costs O(1) per slash instead of rescanning everything emitted
 * so far — division-heavy input used to make that rescan quadratic.
 *
 * The rules are the standard lexer heuristic, not a parser: a regex may start
 * after nothing, after most punctuation, or after a keyword like `return`;
 * after an identifier, a number, a closing quote/literal, or `]` the slash is
 * division. A `)` is division UNLESS its matching `(` followed a condition
 * keyword (tracked with a paren stack) — without that distinction, `if (x)
 * /[/*]/.test(y)` read the regex body as code and its `[/*]` character class
 * as a block-comment opener, deleting real code up to the next `*\/` in the
 * file. The heuristic can still misread a slash in shapes this repo DOES
 * contain (e.g. `promise.catch(fn)` or `Symbol.for('x')`, whose dotted call
 * still sets `lastWord` to a bare `catch`/`for` and so raises the same
 * condition flag as the real keyword), but this only has an effect if a `/`
 * immediately follows that call's closing `)` — no such site exists, so the
 * over-report never fires; every such residue class found by review has been
 * closed by making the boundary rules above precise, and regression tests pin
 * the probed shapes.
 */
function createSlashContext() {
  let lastWord = '';
  let prevWasWord = false;
  let regexAllowed = true;
  /** @type {boolean[]} */
  const parenConditionStack = [];
  return {
    /** @param {string} ch one code character outside any literal or comment */
    feedCodeChar(ch) {
      if (/[\w$]/.test(ch)) {
        lastWord = prevWasWord ? lastWord + ch : ch;
        prevWasWord = true;
        regexAllowed = REGEX_PRECEDING_KEYWORDS.has(lastWord);
        return;
      }
      if (/\s/.test(ch)) {
        prevWasWord = false;
        return;
      }
      if (ch === '(') {
        parenConditionStack.push(CONDITION_KEYWORDS.has(lastWord));
        regexAllowed = true;
      } else if (ch === ')') {
        regexAllowed = parenConditionStack.pop() ?? false;
      } else if (ch === ']') {
        regexAllowed = false;
      } else {
        regexAllowed = true;
      }
      lastWord = '';
      prevWasWord = false;
    },
    /** A completed string, template, or regex literal token was emitted. */
    feedLiteral() {
      regexAllowed = false;
      lastWord = '';
      prevWasWord = false;
    },
    regexAllowed: () => regexAllowed,
  };
}

/**
 * The end index (exclusive) of the string literal opening at `start`. Handles
 * `\` escapes; a `'`/`"` string left unterminated at a newline ends there
 * (mirroring the lexer, and capping how much text a stray quote can shield),
 * while a template literal runs to its closing backtick across lines.
 * Template `${…}` expressions are scanned with full nesting (see
 * `scanTemplateExpression`) so the backtick that ends the literal is its REAL
 * closing backtick, never a nested template's — round 5 closed the class
 * where `` `${`…`}` `` returned at the inner template's OPENING backtick,
 * everything after scanned as code, and a `//` or `/*` inside the nested
 * template (a URL is enough) started a strip that deleted real code. The
 * expression's CONTENT is still copied verbatim by the caller — a comment
 * nested inside `${…}` is preserved, which errs toward the guard's
 * fail-closed side (statement-shaped text there would still be matched).
 *
 * @param {string} source
 * @param {number} start index of the opening quote
 * @returns {number}
 */
function scanStringLiteral(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (ch === quote) return i + 1;
    if (ch === '\n' && quote !== '`') return i;
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = scanTemplateExpression(source, i + 2) - 1;
    }
  }
  return source.length;
}

/**
 * The end index (exclusive) of the `}` closing the template expression whose
 * `${` ends at `start`. Only a BOUNDARY scan — the caller copies the
 * expression's text verbatim; this walk exists so a `}`, backtick, or comment
 * marker inside a nested string, template, regex, or comment cannot end (or
 * fail to end) the expression early. Brace depth is tracked for object
 * literals and blocks; nested template literals recurse through
 * `scanStringLiteral`; an expression left unterminated at end-of-file shields
 * the rest of the file as literal text, which errs fail-closed — nothing is
 * ever stripped from it.
 *
 * @param {string} source
 * @param {number} start index just past the `${`
 * @returns {number}
 */
function scanTemplateExpression(source, start) {
  let depth = 1;
  const slashContext = createSlashContext();
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end === -1) return source.length;
      i = end;
    } else if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) return source.length;
      i = close + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i = scanStringLiteral(source, i);
      slashContext.feedLiteral();
    } else if (ch === '/' && slashContext.regexAllowed()) {
      const end = scanRegexLiteral(source, i);
      if (end > i + 1) slashContext.feedLiteral();
      else slashContext.feedCodeChar('/');
      i = end;
    } else {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
      slashContext.feedCodeChar(ch);
      i++;
    }
  }
  return source.length;
}

/**
 * The end index (exclusive) of the regex literal opening at `start`, honoring
 * `\` escapes and character classes (a `/` inside `[…]` does not terminate).
 * A newline before the closing `/` means this was not a regex literal after
 * all; the caller then emits the lone slash and moves on.
 *
 * @param {string} source
 * @param {number} start index of the opening `/`
 * @returns {number}
 */
function scanRegexLiteral(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '\n') return start + 1;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i + 1;
  }
  return start + 1;
}

/**
 * Replaces every block comment (`/* ... *\/`) with a single space (plus the
 * comment's own newlines, so line-anchored patterns downstream keep their
 * line numbers) and every line comment (`// ...`) with a single space that
 * does not consume the trailing newline — so multi-line statement structure
 * (the keyword-backtrack scan in `findMfesImportSites`, the brace-block
 * boundaries `parseImportedNames` matches against) is preserved across the
 * removed comment.
 *
 * This is a character-level scanner that is STRING-AWARE and REGEX-AWARE: a
 * `//` or `/*` inside a `'…'`/`"…"` string, a template literal, or a regex
 * literal is literal text, never a comment start. Round 4 closed the class
 * where it was not — a `/*` inside an ordinary string (a glob like
 * `'src/**'`) opened a strip that ran to the next `*\/` anywhere in the file
 * and silently deleted the real code in between, a false negative the
 * guard's contract forbids. Round 5 closed the same class one level deeper:
 * a template literal NESTED inside another template's `${…}` expression used
 * to end the outer literal at the inner one's opening backtick (see
 * `scanStringLiteral`), and a `[/*]` character class in a regex misread as
 * division used to open a comment strip (see `createSlashContext`). What
 * deliberately remains un-parsed: string CONTENT is preserved, so
 * statement-shaped text inside a string literal is still matched downstream
 * (fail closed, see `findMfesImportSites`), and a comment nested inside a
 * template `${…}` expression is kept for the same reason — `${…}` is scanned
 * only to find its boundary, then copied verbatim.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const slashContext = createSlashContext();
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      out += ' ';
      i = end === -1 ? source.length : end;
    } else if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += ' ' + source.slice(i, end).replace(/[^\n]/g, '');
      i = end;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const end = scanStringLiteral(source, i);
      out += source.slice(i, end);
      slashContext.feedLiteral();
      i = end;
    } else if (ch === '/' && slashContext.regexAllowed()) {
      const end = scanRegexLiteral(source, i);
      out += source.slice(i, end);
      if (end > i + 1) slashContext.feedLiteral();
      else slashContext.feedCodeChar('/');
      i = end;
    } else {
      out += ch;
      slashContext.feedCodeChar(ch);
      i++;
    }
  }
  return out;
}

/**
 * Finds every `import`/`export ... from` statement in `content` whose module
 * specifier is `@gears-frontx/mfes` or a subpath of it — including the
 * from-less side-effect form (`import '@gears-frontx/mfes/…'`), which
 * executes the module's top level and is a deep import like any other.
 *
 * Comments are stripped from `content` first (see `stripComments`), so a
 * comment can neither reset the keyword backtrack below nor itself produce a
 * match. Anchored on the quoted specifier and backtracked to the nearest
 * preceding WHOLE-WORD `import`/`export` keyword (a `\b(?:import|export)\b`
 * scan, not a substring search), so multi-line named-import blocks are
 * captured whole even when another identifier in the block contains
 * `import`/`export` as a substring — `importManifest` must not be mistaken
 * for the statement's own keyword. Anything else that merely mentions the
 * package name — an eslint `no-restricted-imports` group, a bundler
 * `external` array, prose in a docblock with no from-clause or side-effect
 * shape — is not matched. A statement-shaped STRING LITERAL (a `from
 * '<specifier>'` clause or the side-effect form inside quotes) is still
 * matched deliberately: this guard does not parse JS, so it fails closed on
 * statement-shaped text outside comments rather than risk missing a real
 * import. A comment with that same shape is no longer matched — round 3
 * closed the class of comments laundering a concrete import past this guard,
 * which costs the narrower false positive of statement-shaped prose inside a
 * comment (see `stripComments`'s docblock for the full trade).
 *
 * @param {string} content
 * @param {string} relativeFilePath repo-root-relative, for reporting
 * @returns {ParsedImportSite[]}
 */
export function findMfesImportSites(content, relativeFilePath) {
  content = stripComments(content);
  /** @type {ParsedImportSite[]} */
  const sites = [];
  const specifierPattern = /\bfrom\s*['"](@gears-frontx\/mfes(?:\/[^'"]*)?)['"]/g;
  const keywordPattern = /\b(?:import|export)\b/g;
  for (const match of content.matchAll(specifierPattern)) {
    const head = content.slice(0, match.index);
    let statementStart = -1;
    for (const keywordMatch of head.matchAll(keywordPattern)) {
      statementStart = keywordMatch.index;
    }
    if (statementStart === -1) continue;
    const statement = content.slice(statementStart, match.index + match[0].length);
    sites.push({
      file: relativeFilePath,
      specifier: match[1],
      statement,
      names: parseImportedNames(statement),
    });
  }
  // Side-effect and dynamic imports carry no binding block, so the
  // from-anchored pattern above never sees them — but both
  // `import '@gears-frontx/mfes/internal/x'` and
  // `import('@gears-frontx/mfes/internal/x')` still reach past the barrel.
  const sideEffectPattern = /\bimport\s*\(?\s*['"](@gears-frontx\/mfes(?:\/[^'"]*)?)['"]/g;
  for (const match of content.matchAll(sideEffectPattern)) {
    sites.push({ file: relativeFilePath, specifier: match[1], statement: match[0], names: [] });
  }
  return sites;
}

/**
 * The ORIGINAL names a statement's named-binding block imports, aliases and
 * inline `type` keywords stripped. A statement with no brace block (default
 * import, `import * as ns`, bare re-export) yields no names — the barrel-side
 * check is what guards those, since a namespace object only contains what the
 * barrel actually exports.
 *
 * Comments are stripped from the braced content before the comma-split (via
 * the shared `stripComments` — one implementation, not a second copy with its
 * own defects): a `//` line comment directly above a name otherwise glues
 * onto that name in the split (`// imported for typing only\n
 * DefaultLifecycleManager` becomes one entry, not two), laundering a concrete
 * name past the naming rule. Every in-repo caller reaches this through
 * `findMfesImportSites`, which already stripped the whole file — but this
 * pass is a real BACKSTOP, not redundancy: a comment that survives the
 * whole-file strip through a residual scanner blind spot lands inside the
 * braces here, and this second strip is what keeps it from gluing onto a
 * name. The barrel half's braced sweep carries the symmetric backstop for
 * the same reason.
 *
 * @param {string} statement
 * @returns {string[]}
 */
export function parseImportedNames(statement) {
  const braced = statement.match(/{([\s\S]*?)}/);
  if (!braced) return [];
  return stripComments(braced[1])
    .split(',')
    .map((entry) => entry.replace(/\btype\b/g, '').trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(/\s+as\s+/)[0].trim());
}

/**
 * Walks the template directories for consumer files: every scannable-
 * extension file under a manifest-discovered template directory
 * (`findTemplateDirs` - the same ADR-0018 rule every other guard in this
 * repo uses, rather than a hardcoded template-name list), skipping
 * generated/third-party trees and every dot-directory (`.git`,
 * `.claude/worktrees/*`, a stale copy of which would otherwise fail a local
 * run for reasons that have nothing to do with the working tree actually
 * being checked).
 *
 * @param {string} rootDir this repo's root
 * @returns {string[]} repo-root-relative paths, sorted for stable output
 */
export function findConsumerFiles(rootDir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.relative(rootDir, fullPath));
      }
    }
  };
  for (const templateDir of findTemplateDirs(rootDir)) {
    walk(templateDir);
  }
  return files.sort();
}

/**
 * @typedef {{ file: string; kind: 'deep-import' | 'concrete-name'; detail: string }} Violation
 */

/**
 * The consumer half: deep-subpath imports of the package, and named imports of
 * a concrete-implementation name from the barrel.
 *
 * @param {ParsedImportSite[]} sites
 * @returns {Violation[]}
 */
export function findConsumerViolations(sites) {
  /** @type {Violation[]} */
  const violations = [];
  for (const site of sites) {
    if (site.specifier !== MFES_PACKAGE_NAME) {
      violations.push({ file: site.file, kind: 'deep-import', detail: site.specifier });
      continue;
    }
    for (const name of site.names) {
      if (isConcreteImplementationName(name)) {
        violations.push({ file: site.file, kind: 'concrete-name', detail: name });
      }
    }
  }
  return violations;
}

/**
 * The one-line human explanation for a single violation, shared by every
 * place `check()` reports violations.
 *
 * @param {Violation} violation
 * @returns {string}
 */
function explainViolation(violation) {
  return violation.kind === 'deep-import'
    ? `deep import \`${violation.detail}\` reaches past the barrel`
    : `imports concrete implementation \`${violation.detail}\` from ${MFES_PACKAGE_NAME}`;
}

/**
 * @param {{ rootDir: string; log: (line: string) => void; logError: (line: string) => void }} context
 * @returns {number}
 */
function check({ rootDir, log, logError }) {
  // A5-class review finding, same rule as `template-pin-drift-check.mjs`:
  // zero templates found is never a silent pass - a glob that stops
  // matching would otherwise report "0 violations" as success.
  const templateDirs = findTemplateDirs(rootDir);
  if (templateDirs.length === 0) {
    logError('[template-mfes-import-boundary-check] FAIL: no template found under ' + rootDir + ' - discovery is broken, not the boundary clean.');
    return 1;
  }

  const consumerFiles = findConsumerFiles(rootDir);
  if (consumerFiles.length === 0) {
    logError('[template-mfes-import-boundary-check] FAIL: found no consumer source files to scan — the walk is broken, not the boundary clean.');
    return 1;
  }

  /** @type {Violation[]} */
  const violations = [];
  for (const file of consumerFiles) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    if (!content.includes(MFES_PACKAGE_NAME)) continue;
    violations.push(...findConsumerViolations(findMfesImportSites(content, file)));
  }

  if (violations.length > 0) {
    logError(`[template-mfes-import-boundary-check] FAIL: ${violations.length} ADR-0003 boundary violation(s):`);
    for (const violation of violations) {
      logError(`  ${violation.file}: ${explainViolation(violation)}`);
    }
    logError(
      '\nADR-0003 (mfe-runtime-public-surface): consumers depend on the abstract contracts and obtain ' +
        'a registry via `createMfeRegistryFactory().build({ typeSystem })`; the concrete Default* ' +
        'implementations are internal. Depend on the abstract class instead, or — if a genuinely new ' +
        'public surface is being added — name it after its contract, not its implementation. The barrel ' +
        'half of this boundary (packages/mfes/src/index.ts) is checked in gears-frontx, not here.',
    );
    return 1;
  }

  log(
    `Template MFES import-boundary check passed: ${consumerFiles.length} consumer file(s) across ` +
      `${templateDirs.length} template(s) import only the sanctioned surface of ${MFES_PACKAGE_NAME}.`,
  );
  return 0;
}

/**
 * CI entry point. Every fail-closed throw raised while reading a file is
 * caught here and turned into an exit code with a message naming what broke:
 * a guard whose own crash looks different from its own failure teaches
 * developers to read a red build as "the script is broken".
 *
 * @param {{
 *   rootDir?: string;
 *   log?: (line: string) => void;
 *   logError?: (line: string) => void;
 * }} [options]
 * @returns {number} 0 on success, 1 on failure.
 */
export function runCli(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;

  try {
    return check({ rootDir, log, logError });
  } catch (error) {
    logError(`[template-mfes-import-boundary-check] FAIL: ${error instanceof Error ? error.message : String(error)}`);
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
