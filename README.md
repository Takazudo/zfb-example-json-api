# zfb-example-json-api

## SSR Contract

This example is a compact SSR/API starter for zfb on Cloudflare Workers Static Assets.

- API routes must opt out of build-time rendering with the literal export `export const prerender = false;`. zfb detects that exact AST shape at build time.
- `getCloudflareContext<Env>()` returns `{ env, request, ctx }` inside the emitted Worker request. It throws outside a Worker request scope. The generic `Env` is still useful even when this example has no bindings.
- `zfb dev` routes `prerender = false` code through the SSR path, but it does not provision Worker bindings. This example's API handlers read `request` from the Cloudflare adapter context, so endpoint checks belong in `pnpm build` plus `pnpm preview` or `pnpm exec wrangler dev`.
- `not_found_handling = "404-page"` keeps unresolved asset paths on the styled static 404 path while preserving deliberate API 404 responses when they use `application/json`. A bare `text/plain` 404 can look like the framework default and yield to the styled page.
- No Cloudflare resources need provisioning. The `wrangler.toml` only declares the static assets binding used by the adapter wrapper.

## What It Shows

- `/api/items` filters the demo data with `q` and paginates with `page` and `per`.
- `/api/search` builds a module-scope MiniSearch index lazily and returns `indexBuiltAt` plus `indexBuildCount`, so repeated warm-isolate requests can observe index reuse.
- `/` is a static page with one Preact island that fetches both JSON endpoints.

## Run Locally

```sh
pnpm install
pnpm dev
pnpm build
pnpm preview
```

Use `pnpm dev` for the static shell and component iteration. Use `pnpm preview` after `pnpm build` for Worker-shaped API behavior.

## Endpoint Checks

After `pnpm build`, start a local Worker with `pnpm preview` or `pnpm exec wrangler dev`, then run:

```sh
curl 'http://localhost:8787/api/items?q=review&page=1&per=5'
curl 'http://localhost:8787/api/search?q=onboarding'
curl -i -X OPTIONS 'http://localhost:8787/api/items'
curl -i -X POST 'http://localhost:8787/api/items'
```

Run the search request twice against the same local Worker process. `indexBuiltAt` should stay stable while the isolate stays warm.

## Deploy

```sh
pnpm build
pnpm exec wrangler deploy
```

Production serves on the custom domain
<https://zfb-example-json-api.takazudomodular.com>, declared as a
`custom_domain` route in `wrangler.toml` — Cloudflare creates and manages its
DNS record and TLS certificate. The worker also stays reachable on
<https://zfb-example-json-api.takazudo.workers.dev> (`workers_dev = true`).

There are no D1, KV, R2, secret, or queue bindings to create.

Verify a deploy against the live domain with the committed smoke test, which
checks the static shell and both JSON endpoints:

```sh
pnpm smoke                                    # the custom domain
pnpm smoke https://zfb-example-json-api.takazudo.workers.dev   # any other host
```

## Continuous deployment (GitHub Actions)

Setting this up from zero? Follow [docs/cloudflare-setup.md](docs/cloudflare-setup.md)
for the ordered walkthrough; the rest of this section is the reference.

This repo ships `.github/workflows/deploy.yml`:

- **build** runs on every push and PR — `pnpm install`, `pnpm typecheck`,
  `pnpm build`. It needs no Cloudflare credentials, so CI is green immediately.
- **deploy** runs on push to `main` and calls `wrangler deploy`. It self-skips
  until the secrets below are set, so a fresh repo never shows a red deploy.
- a **smoke step** then runs `pnpm smoke` against
  <https://zfb-example-json-api.takazudomodular.com>, asserting the static shell
  and both JSON endpoints. It self-skips with a notice while the domain's DNS
  and certificate are still propagating, and fails only on a real bad response.

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account · Workers Scripts: Edit and Zone · Workers Routes: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | target Cloudflare account id |

No bindings, secrets, or resource ids to provision.

### Cloudflare API token permissions

The `CLOUDFLARE_API_TOKEN` repo secret is an **Account**-scoped custom token
(Cloudflare dashboard → My Profile → API Tokens → Create Custom Token) with
these permissions:

- **Workers Scripts** — Edit
- **Account Settings** — Read
- **Workers Routes** — Edit (a **Zone** permission, on `takazudomodular.com`)

Set **Account Resources → Include → (your account)** and **Zone Resources →
Include → takazudomodular.com**. The Zone permission is what lets `wrangler
deploy` create the `custom_domain` route declared in `wrangler.toml`; without
it the deploy uploads the worker and then fails on the route step. A single
token can be shared across all `zfb-example-*` repos if it carries the union of
every repo's permissions.
