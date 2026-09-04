# Manual Auth Tests (Node.js)

These scripts are for manual verification of FrontX `auth()` integration without any UI.

They run against a public test backend (DummyJSON) to validate:

- bearer token attachment via `Authorization: Bearer ...`
- refresh + retry on `401`
- request cancellation via `AbortSignal` (axios cancellation bypasses plugin `onError`)

Cookie-session is intentionally NOT covered here because Node.js fetch/axios do not manage browser cookies the same way.
Test cookie-session in a real browser against your own backend (see below).

## Not part of this template

This directory is deliberately absent from `template-shell/frontx-template.json`'s
`ownershipBoundaries` - unlike everything else under `template-shell/`, `frontx add`/`frontx seed`
never copies it into a seeded project. It's a monorepo-only developer verification tool, moved here
(from `gears-frontx`'s own `scripts/manual-auth-tests/`) when the templates split into this repo,
because it imports `@gears-frontx/framework` - a `template-shell` workspace package that stopped
being resolvable from the ecosystem repo the moment `template-shell` left it. Living here instead
under `template-shell/` is what makes the import resolve again: `@gears-frontx/framework` is a
`template-shell` workspace member, so after `npm ci` in `template-shell/` it's hoisted into
`template-shell/node_modules/@gears-frontx/framework` as a symlink to `packages/framework`, and
`@gears-frontx/api` resolves there too as a real registry install (`template-shell`'s own pinned
dependency). Node's module resolution walks up from wherever the running script lives looking for
a `node_modules` directory - anywhere under `template-shell/` finds it; nothing above this
directory needs it to be there.

## Run From This Repo

From `template-shell/`:

```bash
cd template-shell
npm ci
npm run build:packages

node manual-auth-tests/bearer-attach.mjs
node manual-auth-tests/refresh-retry.mjs
node manual-auth-tests/abort.mjs
```

Both steps are required. `npm ci` installs `@gears-frontx/api` (a real registry tarball) and
resolves the `@gears-frontx/framework` workspace symlink, but the symlink only points AT
`packages/framework` - it does not build it. `packages/framework/dist` is gitignored and carries
no `prepare`/`postinstall` hook to build it for you, so without `npm run build:packages` these
scripts fail with `ERR_MODULE_NOT_FOUND` looking for `.../framework/dist/index.js`. `build:packages`
also builds `auth`, `state`, and `i18n` first, in the order `framework` needs them built.

## Cookie-Session (Browser/Manual)

1. Implement a backend with:
- `POST /login` -> sets `Set-Cookie: session=...` and returns `csrfToken` (if you enforce CSRF)
- `GET /protected` -> requires cookie (and optionally CSRF header)

2. In your app, configure auth plugin:

```ts
use(auth({
  provider,
  frontxApi: {
    allowedCookieOrigins: ['http://localhost:4010'],
    csrfHeaderName: 'x-csrf-token',
  },
}))
```

3. Ensure `provider.getSession()` returns `{ kind: 'cookie', csrfToken }`.

Expected: requests to the allowlisted origin are sent with `withCredentials: true` and include the CSRF header.

## Use In An External App With Local FrontX Changes

If you changed FrontX locally and want to test in a separate consumer app, you have two common options.

Note: `@gears-frontx/api` has a peer dependency on `axios`. Install it in your consumer app:

```bash
pnpm add axios
# or: npm i axios
```

### Option A: `file:` dependencies (recommended for local work)

1. Build the ecosystem packages in the `gears-frontx` repo, and `template-shell/packages/framework`
   here (package exports point to `dist/` in both cases):

```bash
cd /path/to/gears-frontx
npm run build:packages:sdk

cd /path/to/gears-frontx-templates/template-shell
npm run build:packages:framework
```

2. In your consumer app `package.json`, depend on the local package folders:

```json
{
  "dependencies": {
    "@gears-frontx/auth": "file:/path/to/gears-frontx-templates/template-shell/packages/auth",
    "@gears-frontx/api": "file:/path/to/gears-frontx/packages/api",
    "@gears-frontx/framework": "file:/path/to/gears-frontx-templates/template-shell/packages/framework"
  }
}
```

3. Install:

```bash
cd /path/to/consumer-app
npm i
```

If you use pnpm, prefer `link:` for symlinks:

```json
{
  "dependencies": {
    "@gears-frontx/auth": "link:/path/to/gears-frontx-templates/template-shell/packages/auth",
    "@gears-frontx/api": "link:/path/to/gears-frontx/packages/api",
    "@gears-frontx/framework": "link:/path/to/gears-frontx-templates/template-shell/packages/framework"
  }
}
```

### Option B: `npm pack` tarballs

1. Build packages in both repos as in Option A.
2. Pack tarballs:

```bash
cd /path/to/gears-frontx/packages/api && npm pack
cd /path/to/gears-frontx-templates/template-shell/packages/auth && npm pack
cd /path/to/gears-frontx-templates/template-shell/packages/framework && npm pack
```

3. Install the generated `*.tgz` files in your consumer app:

```bash
cd /path/to/consumer-app
npm i /path/to/gears-frontx/packages/api/gears-frontx-api-*.tgz
npm i /path/to/gears-frontx-templates/template-shell/packages/auth/gears-frontx-auth-*.tgz
npm i /path/to/gears-frontx-templates/template-shell/packages/framework/gears-frontx-framework-*.tgz
```
