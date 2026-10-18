# Embedding in your application

Add the Schema Viewer to an existing Express, Fastify, NestJS or Next.js application as a **protected,
development-only page**. Every file on this page is a tested example in
[`examples/embedding/`](https://github.com/laranex/node-schema-viewer/tree/main/examples/embedding).

::: danger Development only. Authentication is mandatory.
Never enable, bundle or serve the Schema Viewer or its snapshots in production. Require authentication even for local
development, and protect the page, every viewer file and the schema JSON on the server with the same check.
The one exception is [`serve`](#serve-or-an-embedded-viewer): a loopback-only viewer with no authentication, for a single developer on
their own machine. Never share it.
The policy is [Schema Viewer UI: Security](https://laranex.github.io/schema-viewer-ui/security.html).
:::

This page covers what is specific to Node.js. The generic rules (the shape of a protected embedding, snapshots,
React, Vue, Angular and FastAPI frontends, authentication) are in the canonical
[Embedding in client applications](https://laranex.github.io/schema-viewer-ui/embedding.html) guide.

## `serve` or an embedded viewer

| | `node-schema-viewer serve` | Embedded Schema Viewer |
| --- | --- | --- |
| What it is | A standalone local viewer: its own `node:http` server for one snapshot | The viewer as a page of your existing application |
| Where | `http://127.0.0.1:8765/`, loopback only by default | Your application's origin, under `/dev/schema-viewer/` |
| Authentication | **None.** It relies on loopback and a `Host` check | Your application's sign-in, or HTTP Basic Auth at minimum |
| Production | A developer tool you run by hand | Never registered in production; the examples prove it |
| Configuration | `--snapshot`, `--host`, `--port` ([CLI](./cli.md#serve)) | Environment variables read by your application |

`serve` has no authentication of its own. Keep it on loopback for one developer; to reach it from another machine, keep
it on loopback and put an authenticated HTTPS reverse proxy or an access-controlled tunnel in front of it. Embed the
viewer when it belongs in your application's development environment, behind your sign-in.

## What the package provides

The programmatic exports below are what the examples use. There is no framework middleware, mount helper or
authentication in the package; the examples' `lib/` adds those in two small files you can copy.

| Export | What it does |
| --- | --- |
| `loadViewer(directory?)` | Reads `laranex-schema-viewer-ui`'s `viewer/manifest.json` and returns a `Map` from URL path (`/index.html`, `/app.js`, `/assets/…`, and `/` for `index.html`) to `{ body, type }`, for exactly the files the manifest lists, each checked against its SHA-256. JSON files (the manifest) are left out. Throws `ViewerError` on a mismatch or a viewer that does not read laranex-schema 2.x. |
| `loadDocument(path)` | Reads a snapshot (at most 32 MiB) and validates it as laranex-schema 2.x. Throws `SnapshotError`. |
| `POLICY` | The Content-Security-Policy `serve` sends, with `frame-ancestors 'none'`. |
| `createViewerServer(options)` | The `serve` server itself (`node:http`, no authentication). It is not middleware; do not expose it. |

`canonicalJson` comes from `laranex-schema-viewer-ui/contract`, the contract package this one depends on.

## The examples

```text
examples/embedding/
  lib/dev-auth.mjs        development switch and Basic Auth (node:crypto only)
  lib/schema-viewer.mjs   the viewer's files and snapshot as { status, headers, body }
  express/server.mjs      Express 5
  fastify/server.mjs      Fastify 5
  nestjs/src/main.ts      NestJS 12 (Express platform)
  nextjs/                 Next.js 16: proxy.ts, route handler, React page
  test/embedding.test.mjs starts each example and checks every rule below over HTTP
```

They read the same environment variables:

| Variable | Meaning |
| --- | --- |
| `SCHEMA_VIEWER_ENABLED` | `1` turns the viewer on. Anything else, or `NODE_ENV=production`: no viewer routes, even with `1`. |
| `SCHEMA_VIEWER_USER`, `SCHEMA_VIEWER_PASSWORD` | Basic Auth credentials. Required when enabled; passwords under 16 characters are refused. Errors name missing variables, never values. |
| `SCHEMA_VIEWER_SNAPSHOT` | Path of the snapshot, outside `public/`, `static/` and anything a bundler reads. |

Install `node-schema-viewer` and `laranex-schema-viewer-ui` as **development dependencies**. The server frameworks
import `lib/schema-viewer.mjs` with a dynamic `import()` only after the switch is on, so a production install
(`npm ci --omit=dev`) has neither package, and the application starts and serves no viewer route. Build the snapshot
with [`build`](./build.md) and keep it out of version control:

```bash
npx node-schema-viewer build --output ../.schema/schema-viewer.json
```

### Shared code

`isAuthorized` compares SHA-256 digests of the user name and the password with `timingSafeEqual`, both every time.
`UNAUTHORIZED` is the `401` every example sends: `WWW-Authenticate: Basic realm="…"`, `Cache-Control: no-store` and a
body without schema details. Nothing logs the `Authorization` header.

<<< @/../examples/embedding/lib/dev-auth.mjs

`createSchemaViewer` answers one request below the prefix. It checks neither credentials nor the `Host` header, so
call it only after your application's authentication has accepted the request. It serves exactly the manifest's
files, re-reads and validates the snapshot on every request (`503` while it is invalid), and sends
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every response, errors included. Pass a `policy`
with `frame-ancestors 'self'` if your own pages show the viewer in an `<iframe>`.

<<< @/../examples/embedding/lib/schema-viewer.mjs

## Express

`app.use(PREFIX, requireDeveloper, …)` puts the check in front of every path under the prefix: the page, each viewer
file and `snapshot.json`.

<<< @/../examples/embedding/express/server.mjs

## Fastify

An encapsulated plugin with the prefix; its `onRequest` hook runs before each of its routes.

<<< @/../examples/embedding/fastify/server.mjs

## NestJS

Nest guards run only for controllers, so they cannot protect these files. The viewer is functional middleware on the
Express instance, registered in `main.ts` before Nest's routes.

<<< @/../examples/embedding/nestjs/src/main.ts

## Next.js

Next.js needs server-side protection and client-side rendering kept apart, and the viewer kept out of `next build`:

- `proxy.ts` is the first gate for every path under `/dev/schema-viewer`: `404` unless the viewer is enabled, `401`
  without valid credentials.
- The route handler serves the standalone viewer and `snapshot.json` under the prefix and checks again; the React page
  checks again on the server. The proxy is not the only control.
- The viewer's routes are `*.dev.ts` / `*.dev.tsx` files, which `next.config.mjs` treats as routes only in `next dev`
  with `SCHEMA_VIEWER_ENABLED=1`. `next build` does not see them: the production build has no viewer page, handler,
  viewer code or snapshot.

<<< @/../examples/embedding/nextjs/next.config.mjs

<<< @/../examples/embedding/nextjs/proxy.ts

The standalone viewer at `/dev/schema-viewer/index.html`. Next.js removes trailing slashes, so the prefix itself
redirects to `index.html`, where the page's relative URLs (`app.js`, `app.css`, `snapshot.json`) resolve:

<<< @/../examples/embedding/nextjs/app/dev/schema-viewer/[[...path]]/route.dev.ts{ts}

The React component at `/dev/schema-viewer/react`: a server component that checks the credentials and renders a
client component, which fetches the snapshot from the protected route after the page loads, so the schema is never in
a JavaScript bundle or in the server-rendered HTML.

<<< @/../examples/embedding/nextjs/app/dev/schema-viewer/react/page.dev.tsx

<<< @/../examples/embedding/nextjs/app/dev/schema-viewer/react/schema-viewer-client.dev.tsx

::: warning What the proxy does not cover
The React page's JavaScript chunks come from `/_next/static/`, outside the prefix. In `next dev` they hold the viewer's
library code, never the schema. If your policy requires the viewer's code itself to be unreachable without
credentials, use the standalone route, which serves every viewer file under the prefix, or put the whole development
server behind authentication.
:::

## Use your application's authentication

Basic Auth is the minimum. Where your application already signs developers in, put that check in the same place:
before `createSchemaViewer`, on the server, for every path under the prefix. For example, in Express after your
session middleware, with your own user and role names:

```js
const requireDeveloper = (request, response, next) => {
    if (request.user?.roles?.includes('developer')) {
        next();
        return;
    }
    response.status(request.user ? 403 : 401).set('Cache-Control', 'no-store').send('Not allowed\n');
};
```

In Fastify, use the same condition in the `onRequest` hook after your authentication plugin; in NestJS, register your
session or passport middleware before the viewer middleware; in Next.js, check your session in `proxy.ts`, the route
handler and the page. Client-side route guards, hidden links and obscure URLs are not access controls.

## Static assets

Serve the viewer only through `loadViewer`'s map, as `createSchemaViewer` does. Do not point `express.static`,
`@fastify/static` or Next.js `public/` at `node_modules/laranex-schema-viewer-ui/dist/viewer`: they would serve the
files without your check (or under a second, unprotected path) and include files the manifest does not list. The
files are held in memory, so serving them costs no disk access.

## Frontend dev servers in a monorepo

When a Vite (React or Vue) or Angular frontend runs its own dev server in front of a Node.js backend, the backend
serves and protects `/dev/schema-viewer/`, and the dev server proxies that prefix to it with the `Authorization` header
intact. The proxy configuration and the frontend side are in the canonical guide's
[FastAPI](https://laranex.github.io/schema-viewer-ui/embedding.html#fastapi-backend-with-a-react-or-vue-frontend) and
[Angular](https://laranex.github.io/schema-viewer-ui/embedding.html#angular) sections, which apply unchanged to these
backends.

## Run the tests

From the repository root, after `npm ci`:

```bash
npm run test:examples
```

It installs the examples (`examples/embedding/`, with this package built and packed from the checkout) and runs
`test/embedding.test.mjs` with credentials generated for the run, never printed, and a synthetic fixture of
`laranex-schema-viewer-ui` as the snapshot. For Express, Fastify, NestJS and `next dev` it checks that:

- without credentials, or with a wrong user name, a wrong password, a malformed header or another scheme, the page,
  every file in the viewer's manifest, `snapshot.json` and unknown paths under the prefix answer `401` with
  `WWW-Authenticate: Basic` and `Cache-Control: no-store`, for `GET` and `HEAD`, with no schema or viewer content;
- with credentials, every viewer file matches its manifest SHA-256, `snapshot.json` is the fixture, and the manifest
  and unknown files are `404` with `no-store`;
- with `NODE_ENV=production` (even with `SCHEMA_VIEWER_ENABLED=1`) or without the opt-in, every viewer path is `404`
  while the application still answers;
- the application refuses to start when the viewer is enabled without a password or with a short one, without echoing
  any value;
- `next build` with the opt-in set produces no viewer route, no viewer file, no viewer code and no snapshot, and
  `next start` answers `404` under the prefix.

Next.js answers `/dev/schema-viewer/` (with a trailing slash) itself with a redirect to `/dev/schema-viewer`, before
the proxy runs; the redirect carries no content.

## Limitations

- The package has no middleware, mount helper or authentication for frameworks; copy the examples' `lib/` files.
- `serve` and `createViewerServer` have no authentication and are not meant to be mounted inside an application.
- `POLICY` forbids framing; pass your own policy to `createSchemaViewer` to show the viewer in an `<iframe>`.
- Basic Auth has no logout, no per-user audit and no rate limiting of its own; see
  [Security](https://laranex.github.io/schema-viewer-ui/security.html#http-basic-auth).
