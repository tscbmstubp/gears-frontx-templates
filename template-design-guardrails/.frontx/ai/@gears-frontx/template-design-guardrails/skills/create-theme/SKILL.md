---
name: create-theme
version: 0.1.0
description: Author or revise a FrontX shell theme against the @gears-frontx/ui-kit token contract - full CSS color values, declared light/dark appearance, derived hover and alpha tokens, kit tokens overridden only on purpose and then completely. Use when adding a brand or product theme, porting an existing palette, or when kit components render unstyled, transparent, or with wrong dark-mode surfaces after a theme change.
---

# Create a FrontX theme

A theme is a `ThemeConfig` object registered with the shell, not a stylesheet. The UI kit's `theme.css` is the palette every theme starts from: it declares every colour, radius and type token for both appearances, and the shell resolves it for the theme's declared appearance. A theme's variables are applied on top of it on the document root, and the kit consumes them as-is, which makes the value format a token-value contract, not a convention.

## Establish the token contract

1. Decide whether the theme is the kit's palette or a palette of its own. A theme on the kit's palette declares the shell's own tokens (left menu, spacing, shadows, transitions, `--error`, `--radius-none`) and at most a few kit tokens it overrides on purpose, such as a brand `--primary`; the shell's `light`, `dark` and `default` override none. A theme that repaints the page surface (`--background`) has a palette of its own, like the shell's Dracula themes (`src-app/app/themes/draculaPalette.ts`), and then overrides every colour token the kit declares for its appearance: a token left out resolves to the kit's value, and a kit component then paints in two palettes. Shape is one knob: override `--radius`, never the derived `--radius-*` steps. Start from the existing theme of the same kind in `src-app/app/themes/`; the shell's `themes.test.ts` checks every theme in `frontxThemes` (`src-app/app/themes/index.ts`) against the installed kit, so list a new theme there as well as registering it.
2. Read the installed UI-kit documentation for the semantic roles and the tokens the kit consumes directly. The kit is the only token source; there is no bundle fallback set. When a kit-consumed token cannot be mapped from available context, ask the user for that token's value before finishing; fall back to the base value and flag it only if no answer is available.

## Value format rules

These are the failure modes actually observed; each one renders as "kit looks broken", not as an error:

- **Every color token is a full CSS color** — `hsl(240 10% 3.9%)`, a hex value, `oklch(...)`. Never an HSL fragment like `240 10% 3.9%`: the kit consumes tokens as `var(--x)` directly, and a fragment there is an invalid value, so the component silently loses its color. The repository's token-format CI gate bans the matching consumer pattern `hsl(var(--x))` for the same reason.
- **Declare `appearance: 'light' | 'dark'`** on every theme. The shell stamps it as `data-theme` on the document element, and the kit's dark-surface tokens (elevated surfaces, overlays) switch on that attribute — a dark theme without the declaration gets light kit surfaces.
- **Derive hover tokens, don't invent them.** A theme that overrides neither `--primary` nor `--card` inherits the kit's hover tokens and declares none. Any theme that overrides `--primary` or `--card`, an own palette or a deliberate override on the kit palette, must also set `--primary-hover` / `--card-hover`, derived from the base so they follow palette edits: `color-mix(in oklab, var(--primary) 90%, var(--background))`. After authoring, grep the hover/alpha tokens the theme declares for the `color-mix(` derivation from their base — a visually correct hardcoded value still fails this check.
- **Alpha via `color-mix`**, never by re-wrapping a token: `color-mix(in oklab, var(--border) 50%, transparent)`.
- Fallbacks, where needed, go inside `var()`: `var(--x, hsl(0 0% 100%))`.

## Register and verify

1. Register the theme where the app's existing themes are registered (the themes index feeding the theme registry).
2. Verify live in dev mode, not just by reading source: switch to the new theme and inspect a host screen **and** a screen rendered inside an MFE shadow root — theme propagation into shadow roots is a separate code path from the host document.
3. Toggle against a theme of the opposite appearance and confirm the kit's surface tokens (card, overlay, background) resolve to the new appearance in both the host document and one MFE shadow root via computed styles.
4. Run the repository token-format guard when present; note it only catches the consumer pattern `hsl(var(--x))` — always also grep the new theme's own declared values for bare fragments and hardcoded hover values, since the guard cannot see producer-side defects; run `verify-interface` (or the runtime design-defect checker directly) with the new theme active — `axe/color-contrast` is the objective check on the chosen palette, and an `axe-incomplete/color-contrast` entry means it could not decide there, so that contrast is still unverified.

If dev mode or shadow-root inspection cannot be reached, report **environment unavailable** — naming the missing piece — and report the theme as registered-but-unverified; never start a dev server as a foreground command.

## Report

Before the Report, state pass/fail for each of the five value-format rules by inspecting the theme's declared values: (1) every color token is a full CSS color; (2) no HSL fragments; (3) appearance declared; (4) the hover/alpha tokens the theme declares (none to check for a theme that overrides neither `--primary` nor `--card`) derived via `color-mix` from their base, not hardcoded; (5) no token re-wrapping. A theme is not reportable as done with any rule unchecked.

Name:

- the theme id and its appearance;
- which kit tokens it overrides, and why;
- any kit-consumed token you could not map and left at the base value;
- the verification evidence — host + shadow-root screens observed, contrast findings;
- states not switched to — list them as unverified instead of claiming the theme works there.
