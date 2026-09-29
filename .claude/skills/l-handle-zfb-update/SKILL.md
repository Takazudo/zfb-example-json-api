---
name: l-handle-zfb-update
description: >-
  Update the zfb upstream dependency (the @takazudo/zfb* packages) in this
  example (json-api) to the latest stable release, review what changed upstream
  between versions, and adapt this project's code if a change touches a surface
  it uses. Use when: (1) User says 'update zfb', 'bump zfb', 'zfb update', or
  'handle zfb update', (2) A new zfb release is out and this example should
  track it.
user-invocable: true
argument-hint: "[target-version, e.g. 3.1.0 — omit to use latest]"
---

# Handle zfb Update — json-api

This example is a compact SSR/API starter for zfb on Cloudflare Workers Static
Assets: `/api/items` filters and paginates demo data, `/api/search` builds a lazy
module-scope MiniSearch index, and `/` is a static page with one zudo-react island
(`components/item-browser.tsx`, signals + `For`/`Show`) that fetches both endpoints.
It declares no Cloudflare bindings.

Bump every `@takazudo/*` package this repo depends on to the latest stable
release (kept in lockstep on one version), review what changed upstream, and
adapt this project only where an upstream change touches a surface it actually
uses.

Upstream repo: `Takazudo/zudo-front-builder` (monorepo; npm packages live under
`packages/`). Every release has a `v<version>` tag and GitHub release notes.

## Step 0 — Preconditions

`package.json` and `pnpm-lock.yaml` must be clean (`git status --short` shows
neither). If either is dirty, stop and ask before touching them.

## Step 1 — Resolve current and target versions

```bash
CURRENT=$(node -p "require('./package.json').dependencies['@takazudo/zfb']")
TARGET=${1:-$(npm view @takazudo/zfb dist-tags.latest)}
```

- Always resolve the target from the `latest` dist-tag, never `next` — the
  prerelease line ENDED at `1.1.0-next.1`, a prerelease of the already-released
  `1.1.0`. The `next` tag is frozen there and now points at an older version than
  `latest`, so resolving from it silently pins a stale prerelease.
- If `CURRENT` == `TARGET`: report "already at the latest (<version>)" and STOP.
- If an explicit target is older than `CURRENT`, that is a downgrade — stop and
  confirm first. **Never go below `3.0.0`**: the project uses the zfb 3 config
  (`wind`, no `framework` key), the owned zudo-react JSX runtime and a
  signal-based island, none of which exist in 2.x.
- **If `TARGET` crosses a major version** (e.g. `3.x → 4.0.0`): treat it as a
  runtime migration, not a two-line package edit. Read that major's upstream
  migration guide (`docs/src/content/docs/guides/migrating-to-v<N>.mdx` at the
  release tag) before Step 3. Step 5's full verification, including the HTTP
  contract comparison and the hydrated-island browser checks, is mandatory
  before merging — a merge to `main` deploys.

## Step 2 — Review upstream changes BEFORE bumping

Enumerate versions between CURRENT (exclusive) and TARGET (inclusive) in publish
order — never sort prerelease strings lexically (`next.9` vs `next.10`):

```bash
node -e '
const vs = JSON.parse(process.argv[1]);
const cur = vs.indexOf(process.argv[2]), tgt = vs.indexOf(process.argv[3]);
if (tgt < 0) { console.error("target not found"); process.exit(1); }
if (cur >= 0 && tgt <= cur) { console.error("not newer than current"); process.exit(1); }
console.log(vs.slice(cur + 1, tgt + 1).join("\n"));
' "$(npm view @takazudo/zfb versions --json)" "$CURRENT" "$TARGET"
```

Read the release notes for EVERY enumerated version:

```bash
gh release view "v<version>" --repo Takazudo/zudo-front-builder --json body -q '.body'
```

If a release has no notes, fall back to the commit list:

```bash
gh api "repos/Takazudo/zudo-front-builder/compare/v<prev>...v<version>" \
  --jq '.commits[].commit.message' | head -40
```

**Fail closed:** if the changes cannot be reviewed at all, stop and ask — never
bump blind.

Flag anything that touches a surface this example uses:

| Upstream surface | Where this project uses it |
| --- | --- |
| `defineConfig` schema (`@takazudo/zfb/config`) | `zfb.config.ts` — `adapter`, `outDir`, `publicDir`, `wind` (`reset: "owned-v1"`, `authoredClasses`) |
| Cloudflare adapter + `getCloudflareContext<Env>()` | `pages/api/items.tsx`, `pages/api/search.tsx` |
| API route contract (`export const prerender = false`) | `pages/api/items.tsx`, `pages/api/search.tsx` |
| Islands + signals runtime (`<Island>`, `@takazudo/zfb-runtime`, `signal`/`computed`/`batch`/`getScope().effect`/`For`/`Show`, `modelValue`, `on:*` listeners) | `components/item-browser.tsx`, hydrated via `<Island when="load">` in `pages/index.tsx`. Setup runs once: the load effect reads `query`/`page`/`refreshToken` before any await, returns an abort cleanup, and guards late responses with a generation counter; `ItemCard` binds item signals so same-key rows update |
| zudo-react JSX runtime (`@takazudo/zfb/zudo-react`) | `tsconfig.json` `jsxImportSource`; `Child` + `charset` in `layouts/default.tsx`; HTML attribute spellings everywhere |
| zudo-wind reset + candidate scanning | `owned-v1` reset under the authored CSS in `styles/global.css` (plus any preflight-parity rules there; zfb#3382). Every `class="…"` token is scanned: BEM `__` names (zfb#3365) and names that start with a utility root (`text-link` → `text-*`, ZW006) must be listed in `wind.authoredClasses`. Run `pnpm exec zfb wind audit` — "dead classes" must be empty |
| Layouts | `layouts/default.tsx` |
| CSS pipeline (authored CSS; no utilities are used) | `styles/global.css` |
| Smoke content marker | `scripts/smoke.mjs` `CONTENT_MARKER` must equal the exact `pages/index.tsx` `<h1>` |
| CLI (`zfb dev/build/preview/check`) | `package.json` scripts, `wrangler.toml` |

Rule: adapt only if this project actually uses the changed feature. Internal zfb
changes (Rust internals, docs, other frameworks) need no action — note and move on.

## Step 3 — Bump every @takazudo/* package (lockstep)

```bash
PKGS=$(TARGET="$TARGET" node -p "Object.keys(require('./package.json').dependencies).filter(n=>n.startsWith('@takazudo/')).map(n=>n+'@'+process.env.TARGET).join(' ')")
pnpm add -E $PKGS
```

- `-E` keeps the exact pin (no caret) — this repo tracks one known-good zfb version.
- All `@takazudo/*` packages must land on the SAME version.
- Commit `package.json` AND `pnpm-lock.yaml` together — CI installs with
  `pnpm install --frozen-lockfile` and fails on a stale lockfile.
- pnpm is the package manager; npm is only for reading registry metadata.

## Step 4 — Adapt project code (only if Step 2 flagged something)

Apply what the flagged notes require (config schema, renamed APIs, adapter or
`ctx` changes, island markup, etc.). Update `README.md` if commands or documented
behavior changed. If nothing was flagged, skip.

## Step 5 — Verify

```bash
rm -rf ./dist ./.zfb ./.zfb-build
pnpm build       # pages build cleanly, adapter writes dist/_worker.js + dist/.assetsignore
pnpm typecheck   # zfb check passes
```

Run `pnpm typecheck` before `pnpm build` — `zfb check` explains attribute/type
errors far better than a failed build, and a failed build leaves `dist/` empty.

This example declares no Worker bindings. Check the API endpoints with
`pnpm preview` (or `pnpm exec wrangler dev`) after building, per the README —
`zfb dev` serves the static shell but does not run the Worker request path.
Always start servers on an explicit free port (`zfb preview --port <port>
--host 127.0.0.1`) and stop them afterwards.

Run the smoke test only against an explicit local URL — its default target is
the live production host: `pnpm smoke http://127.0.0.1:<port>`. Record a real
"Smoke test passed", not a skip notice.

For a **major** bump, also compare against the previous version side by side.
Build the old version in a separate `git worktree`, serve both on explicit free
ports, then:

- diff the HTTP contract of both Workers: `/api/items` (filter, pagination,
  empty result, invalid `page`/`per`), `/api/search` (query, `limit`),
  405 + `Allow: GET, OPTIONS` for other methods, 204 CORS preflight, and the
  styled 404 for unknown page/`/api/*` paths. Only `indexBuiltAt` may differ
  between Workers; within one warm Worker it and `indexBuildCount` stay stable;
- exercise the island after **real hydration** (wait for
  `[data-zfb-island="ItemBrowser"][data-zfb-island-mounted]`): typing does not
  submit; Search, Prev/Next, Clear and Refresh work; a 500 shows the error note
  and recovers; rapid queries with delayed earlier responses end on the latest
  result with `aria-busy`/`disabled` recovered; a same-key payload replacement
  updates the retained row in place; no console errors;
- pixel-diff screenshots and diff computed styles (the populated console plus
  the 404 page) at 375px, 1280px and both sides of the 860px / 620px
  breakpoints, with identical intercepted payloads and a fixed locale/timezone.

## Step 6 — Report

Summarize: versions traversed, notable upstream changes per release (one line
each), adaptations made (or "none needed"), and verification results.
