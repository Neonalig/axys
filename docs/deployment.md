<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Deploying Axys

The production build is ordinary static files. Nothing runs server-side, so any static host works.
`npm run build` writes `dist/` and that directory is the whole deployment.

Cloudflare Pages is the target. `.github/workflows/deploy.yml` checks, builds and uploads `dist/`
on every push to `main`; `.github/workflows/ci.yml` validates pull requests on Linux and Windows.

## Build facts every host needs

| Setting          | Value                     |
| ---------------- | ------------------------- |
| Build command    | `npm ci && npm run build` |
| Output directory | `dist`                    |
| Node version     | `22.17.0` (`.nvmrc`)      |
| Install command  | `npm ci`                  |
| Server runtime   | none                      |

Rust and the `wasm32-unknown-unknown` target must be available to the build. Hosts that do not
provide Rust need the build to run in CI instead, uploading `dist/` from there.

## Root and subpath

Vite is configured with `base: './'`, so every asset is referenced relatively. The same `dist/`
works at `https://example.com/` and at `https://example.github.io/axys/` with no rebuild.

Override with `AXYS_BASE` only if you need an absolute base for a specific host. Do not hardcode a
hostname; nothing in the source does.

`npm run test` includes a check that serves the built `dist/` at both `/` and `/axys/` and loads
the HTML, JavaScript, WASM and worker assets from each.

## Non-secret build variables

| Variable                 | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `AXYS_BASE`              | Overrides the asset base path. Default `./`.                        |
| `AXYS_SOURCE_REPOSITORY` | Repository the in-app Source Code entry links to.                   |
| `AXYS_SOURCE_REVISION`   | Commit the build was made from. Falls back to `git rev-parse HEAD`. |

A fork or third-party host must set the last two so the AGPL Source Code entry resolves to their
own corresponding source rather than to the upstream repository. `GITHUB_SHA` and
`CF_PAGES_COMMIT_SHA` are picked up automatically when present.

## Cloudflare Pages

The target. Cloudflare's build image ships no Rust, and a Pages Git build gets no cargo cache, so
the build runs in GitHub Actions and Wrangler uploads the finished `dist/`. Direct upload also
keeps the Cloudflare project free of build settings that could drift from the repository.

1. **Create the project.** Workers and Pages, Create, Pages, Upload assets. Name it `axys`.
   Uploading a placeholder is enough; the workflow replaces it on the first push.
2. **Credentials.** An account API token from the Edit Cloudflare Workers template, scoped to the
   one account, plus the account id. Both go in the repository as the `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` secrets. The token is a secret; the account id is not, and is a secret
   only to keep the workflow free of account identifiers.
3. **Deploys.** `.github/workflows/deploy.yml` runs `npm run doctor`, `npm run check` and
   `npm run build`, then `wrangler pages deploy dist`. `AXYS_SOURCE_REPOSITORY` and
   `AXYS_SOURCE_REVISION` come from the workflow, so the AGPL Source Code entry resolves to the
   repository and commit the build was made from.
4. **Preview deployments.** A branch other than `main` passed to `--branch` lands on its own
   preview origin, which is a good place to test the subpath-free root case.
5. **Custom domain.** Pages, the project, Custom domains, Set up a domain. Cloudflare issues the
   certificate and writes the record itself when it holds the zone. It adds one record for that
   hostname and leaves every other record in the zone alone. HTTPS is required because
   `AudioWorklet`, OPFS and WebAssembly need a secure context.
6. **Caching.** `web/public/_headers` ships with the build and sets immutable long-lived caching
   for `/assets/*`, which are content-hashed, and `no-cache` for `/index.html`. That gives instant
   updates without stale asset references.

## Offline install

The build emits `sw.js` and `version.json` at the root of `dist/` alongside the page. The worker
precaches the whole build on the first visit, so Axys runs with no network afterwards and can be
installed as a desktop app from the browser's own install control.

Two requirements on the host:

- serve `/sw.js` and `/version.json` with `Cache-Control: no-cache`, which `_headers` does. A
  cached copy of either reports the build it came from as the current one forever;
- serve `/sw.js` from the same directory the page is served from. The worker can only control what
  sits under it, and the build puts it beside `index.html` for that reason.

A running Axys compares `version.json` against its own revision when the network returns and when
the tab is focused again, and offers a reload rather than taking one.

### `_headers`

`web/public/_headers` is copied into `dist/` and applied by Cloudflare Pages. It sets a strict
Content-Security-Policy, `nosniff`, `no-referrer` and the cache rules above.

Cross-origin isolation headers are present but **commented out**. Axys does not use
`SharedArrayBuffer` or WASM threads, works without isolation, and enabling it would block
non-CORP cross-origin subresources for no current benefit. Uncomment only to measure a future
threaded path.

Netlify reads `_headers` in the same format. Other hosts need the equivalent expressed their own
way; the file is the reference.

### WASM MIME type

Cloudflare Pages, Netlify and GitHub Pages all serve `.wasm` as `application/wasm` already. A host
that does not will fail `WebAssembly.instantiateStreaming`; Axys falls back to
`WebAssembly.instantiate` over an `ArrayBuffer` in that case and reports it in the diagnostics
panel, so the app still works while you fix the host configuration.

## GitHub Pages

Serves the build correctly but cannot set response headers, so `_headers` is ignored: no
Content-Security-Policy, and `/sw.js` and `/version.json` are served with GitHub's own caching. A
cached copy of either reports the build it came from as the current one, which breaks the update
prompt. Usable as a mirror, not as the primary host.

## Other static hosts

GitLab Pages, Render Static Sites, Netlify, Vercel static output, S3 with CloudFront and plain
Nginx all work with the same build command and output directory. Requirements are only:

- serve `.wasm` as `application/wasm`;
- serve `dist/` as-is, with no rewrite of asset paths;
- HTTPS.

No SPA catch-all rewrite is needed. Axys has no client-side routing, so a rewrite would only mask
genuine 404s.

## Verifying a deployment

1. `npm run build` then `npm run preview`, and confirm the app loads and plays.
2. Serve `dist/` under a subdirectory and confirm the same, which `npm run test` automates.
3. In the deployed app, open Help then Diagnostics and confirm WebAssembly, AudioWorklet,
   IndexedDB, OPFS and secure context are all green.
4. Confirm Help then Source Code points at your repository and the revision you deployed.
