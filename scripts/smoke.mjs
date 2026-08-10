#!/usr/bin/env node
// Post-deploy smoke test for the deployed Worker on its custom domain.
//
// Checks BOTH halves of the Workers Static Assets model, because only the
// second one proves the domain reaches the Worker itself:
//   1. `/`            — the static asset layer (dist/index.html)
//   2. `/api/items`   — an SSR route (`prerender = false`), so a correct JSON
//   3. `/api/search`    body here means the Worker script ran, not just assets
//
// SELF-SKIP CONTRACT: while the custom domain is still being wired up, this
// exits 0 with a `::notice::` instead of failing. "Being wired up" covers DNS
// not published yet, the edge not reachable yet, and the Cloudflare-managed
// TLS certificate not issued yet — all transient states of an in-progress
// custom-domain attach. The house rule is that the repo never shows a red
// deploy before Cloudflare is wired up.
//
// Everything PAST the connection is a hard failure: once the host answers,
// a wrong status, content-type, or body shape exits non-zero.

const DEFAULT_BASE_URL = "https://zfb-example-json-api.takazudomodular.com";

// Unique to this site's home page (pages/index.tsx <h1>) — a generic marker
// would also match the styled 404 page or another example site.
const CONTENT_MARKER = "Searchable JSON endpoints with a hydrated Preact client";

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_MS = 5_000;

// Connection-level failures that mean "not wired up yet", not "broken".
const SKIP_ERROR_CODES = new Set([
  "ENOTFOUND", // DNS record does not exist yet
  "EAI_AGAIN", // DNS lookup timed out / not propagated
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Cloudflare issues the custom domain's certificate asynchronously after the
// route is created, so a TLS error minutes after deploy is propagation, not a
// misconfiguration. Treated as "not ready yet" for the same reason as DNS.
const SKIP_TLS_CODE_PATTERN = /^(CERT_|ERR_TLS|ERR_SSL|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO)/;

const failures = [];

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
    return true;
  }
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

// fetch() wraps the underlying network error in `cause`, sometimes more than
// one level deep, so the real code is only reachable by walking the chain.
function errorCodes(error) {
  const codes = [];
  for (let current = error; current; current = current.cause) {
    if (typeof current.code === "string") {
      codes.push(current.code);
    }
  }
  return codes;
}

function notReadyReason(error) {
  for (const code of errorCodes(error)) {
    if (SKIP_ERROR_CODES.has(code)) {
      return `the host is not reachable yet (${code})`;
    }
    if (SKIP_TLS_CODE_PATTERN.test(code)) {
      return `the TLS certificate is not issued yet (${code})`;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url) {
  return fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": "zfb-example-json-api-smoke" },
  });
}

// Only the FIRST request retries: it decides reachable-vs-not-ready for the
// whole run. Later requests hit a host that already answered, so a connection
// failure there is a genuine problem and must not be retried into a skip.
async function requestWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await request(url);
    } catch (error) {
      lastError = error;
      if (!notReadyReason(error)) {
        throw error;
      }
      if (attempt < CONNECT_ATTEMPTS) {
        console.log(`  ...  not reachable yet, retrying in ${CONNECT_RETRY_MS / 1000}s`);
        await sleep(CONNECT_RETRY_MS);
      }
    }
  }
  throw lastError;
}

function contentType(response) {
  return (response.headers.get("content-type") ?? "").toLowerCase();
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    check(`${label} body parses as JSON`, false, `got ${JSON.stringify(text.slice(0, 120))}`);
    return null;
  }
}

async function checkHomePage(baseUrl) {
  console.log(`GET ${baseUrl}/`);
  const response = await requestWithRetry(`${baseUrl}/`);

  check("/ responds 200", response.status === 200, `got ${response.status}`);
  check("/ is HTML", contentType(response).includes("text/html"), `content-type: ${contentType(response) || "(none)"}`);

  const body = await response.text();
  check("/ contains this site's content marker", body.includes(CONTENT_MARKER), `marker not found in ${body.length} bytes`);
}

async function checkItemsApi(baseUrl) {
  const url = `${baseUrl}/api/items?q=review&page=1&per=5`;
  console.log(`GET ${url}`);
  const response = await request(url);

  check("/api/items responds 200", response.status === 200, `got ${response.status}`);
  const isJson = check(
    "/api/items is application/json",
    contentType(response).startsWith("application/json"),
    `content-type: ${contentType(response) || "(none)"}`,
  );
  if (!isJson) {
    return;
  }

  const body = await readJson(response, "/api/items");
  if (!body) {
    return;
  }

  check("/api/items endpoint is \"items\"", body.endpoint === "items", `got ${JSON.stringify(body.endpoint)}`);
  for (const field of ["page", "per", "total", "pages"]) {
    check(`/api/items ${field} is a number`, typeof body[field] === "number", `got ${typeof body[field]}`);
  }
  for (const field of ["hasNext", "hasPrevious"]) {
    check(`/api/items ${field} is a boolean`, typeof body[field] === "boolean", `got ${typeof body[field]}`);
  }
  check("/api/items honours per=5", body.per === 5, `got ${JSON.stringify(body.per)}`);

  const isArray = check("/api/items items is an array", Array.isArray(body.items), `got ${typeof body.items}`);
  if (!isArray) {
    return;
  }
  // q=review matches every item whose status is "review", so an empty result
  // means the handler is not really running against the demo data.
  check("/api/items returns matches for q=review", body.items.length > 0, "got 0 items");
  const malformed = body.items.filter(
    (item) => !item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.category !== "string",
  );
  check("/api/items entries have id, name, category", malformed.length === 0, `${malformed.length} malformed entries`);
}

async function checkSearchApi(baseUrl) {
  const url = `${baseUrl}/api/search?q=onboarding`;
  console.log(`GET ${url}`);
  const response = await request(url);

  check("/api/search responds 200", response.status === 200, `got ${response.status}`);
  const isJson = check(
    "/api/search is application/json",
    contentType(response).startsWith("application/json"),
    `content-type: ${contentType(response) || "(none)"}`,
  );
  if (!isJson) {
    return;
  }

  const body = await readJson(response, "/api/search");
  if (!body) {
    return;
  }

  check("/api/search endpoint is \"search\"", body.endpoint === "search", `got ${JSON.stringify(body.endpoint)}`);
  check("/api/search total is a number", typeof body.total === "number", `got ${typeof body.total}`);
  check("/api/search results is an array", Array.isArray(body.results), `got ${typeof body.results}`);
  // The MiniSearch index is built lazily on first request, so a deployed
  // worker that actually served this request reports at least one build.
  check(
    "/api/search built its MiniSearch index",
    typeof body.indexBuildCount === "number" && body.indexBuildCount >= 1,
    `got ${JSON.stringify(body.indexBuildCount)}`,
  );
  check("/api/search returns matches for q=onboarding", Array.isArray(body.results) && body.results.length > 0, "got 0 results");
}

async function main() {
  const baseUrl = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  console.log(`Smoke testing ${baseUrl}\n`);

  try {
    await checkHomePage(baseUrl);
  } catch (error) {
    const reason = notReadyReason(error);
    if (reason) {
      console.log(`::notice::Smoke test skipped — ${reason}. ${baseUrl} is not wired up yet; re-run once the custom domain is attached and its certificate is active.`);
      process.exit(0);
    }
    throw error;
  }

  await checkItemsApi(baseUrl);
  await checkSearchApi(baseUrl);

  if (failures.length > 0) {
    console.error(`\n::error::Smoke test failed with ${failures.length} problem(s) against ${baseUrl}:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`\nSmoke test passed against ${baseUrl}.`);
}

await main();
