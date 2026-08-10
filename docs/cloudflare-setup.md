# Cloudflare setup

This repo is **not deployed yet**. It has no Cloudflare secrets set, and the `deploy`
job in `.github/workflows/deploy.yml` self-skips until they exist — so CI is green but
nothing ships. What follows is the from-zero path: do these four steps once and every
push to `main` deploys.

There is nothing to provision first. No D1, KV, R2, queue, or Worker secrets — the
`wrangler.toml` only declares the static assets binding the adapter wrapper uses. This
is the simplest repo in the family.

## 1. Create or reuse the API token

All nine `zfb-example-*` repos share **one** account-scoped token. If you already made
it for another example, reuse it and skip to step 2 — see
[the family-wide guide](https://github.com/Takazudo/zfbex-tweaker/blob/main/docs/cloudflare-shared-token-and-env-setup.md)
for the shared-token setup.

Otherwise: Cloudflare dashboard → My Profile → API Tokens → Create Custom Token, with

- **Workers Scripts** — Edit
- **Account Settings** — Read

and **Account Resources → Include → (your account)**. No Zone permissions — this repo
deploys to a `*.workers.dev` host, not a custom domain. Copy the token value now; the
dashboard shows it once.

You also need the account id, on the Cloudflare dashboard's Workers & Pages overview.

## 2. Set the two GitHub Actions secrets

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo Takazudo/zfb-example-json-api
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Takazudo/zfb-example-json-api
```

Each command prompts for the value. Confirm with:

```sh
gh secret list --repo Takazudo/zfb-example-json-api
```

The same pair is available under **Settings → Secrets and variables → Actions** if you
prefer the web UI.

## 3. Trigger the first deploy

Push anything to `main`, or re-run the latest `Deploy` workflow. The first
`wrangler deploy` is what **creates** the Worker — you do not create it in the
dashboard beforehand.

```sh
gh workflow run deploy.yml --repo Takazudo/zfb-example-json-api
gh run watch --repo Takazudo/zfb-example-json-api
```

To deploy from your machine instead:

```sh
pnpm build
pnpm exec wrangler deploy
```

## 4. Verify

The Worker lands at <https://zfb-example-json-api.takazudo.workers.dev> (account
subdomain `takazudo`). Run the same endpoint checks the README lists locally, against
the deployed host:

```sh
curl 'https://zfb-example-json-api.takazudo.workers.dev/api/items?q=review&page=1&per=5'
curl 'https://zfb-example-json-api.takazudo.workers.dev/api/search?q=onboarding'
curl -i -X OPTIONS 'https://zfb-example-json-api.takazudo.workers.dev/api/items'
curl -i -X POST 'https://zfb-example-json-api.takazudo.workers.dev/api/items'
```

Run the search request twice. `indexBuiltAt` should stay stable while the isolate stays
warm, and `indexBuildCount` should not climb.

Also load `/` in a browser — the Preact island there fetches both JSON endpoints, so a
rendered list confirms the static assets and the SSR path both work.

## Troubleshooting

**Deploy job skipped.** The preflight step found no `CLOUDFLARE_API_TOKEN`, or found a
`REPLACE_WITH_*` placeholder in `wrangler.toml`. It writes the reason as a workflow
notice. For this repo it is almost always the missing secret — redo step 2.

**`Authentication error [code: 10000]`.** The token lacks Workers Scripts: Edit, or its
Account Resources do not include the account whose id is in `CLOUDFLARE_ACCOUNT_ID`.
Check both halves match.

**404 on an API path.** `not_found_handling = "404-page"` sends unresolved asset paths
to the styled static 404. Deliberate API 404s survive only when they respond with
`application/json`; a bare `text/plain` 404 gets replaced by the styled page.

**Build passes, deploy fails.** The `build` job needs no credentials, so a green build
says nothing about Cloudflare access. Read the `Deploy` step's log, not the build's.
