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
// SMOKE_REQUIRE_LIVE=1 retires that contract for a domain already known to be
// serving: every condition that would otherwise skip exits 1 instead. The skip
// path stays in the code so a newly attached domain still gets its grace
// window — the flag, not a code change, is what opts a live domain out of it.
//
// Everything PAST the connection is a hard failure: once the host answers,
// a wrong status, content-type, or body shape exits non-zero.

const DEFAULT_BASE_URL = "https://zfb-example-json-api.takazudomodular.com";

// Unique to this site's home page (pages/index.tsx <h1>) — a generic marker
// would also match the styled 404 page or another example site.
const CONTENT_MARKER = "Searchable JSON endpoints with a hydrated Preact client";

const REQUEST_TIMEOUT_MS = 15_000;
// Generous enough to ride out a fresh custom-domain attach: CI runs this
// seconds after `wrangler deploy` creates the route, and Cloudflare needs
// roughly a minute before the edge stops serving error pages for the host.
const CONNECT_ATTEMPTS = 6;
const CONNECT_RETRY_MS = 10_000;

// Set on the CI smoke step once the custom domain is confirmed live. Every
// allowance below exists only to tolerate the propagation window, so for a
// domain that already serves, each one is a bug hiding a real outage.
const REQUIRE_LIVE = /^(1|true)$/i.test(process.env.SMOKE_REQUIRE_LIVE ?? "");

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

// …with one exception that the pattern above would otherwise swallow via
// `^CERT_`. A certificate Cloudflare just issued cannot already be expired, so
// this code can only mean an established domain broke — always a hard failure,
// even without SMOKE_REQUIRE_LIVE.
const FATAL_TLS_CODES = new Set(["CERT_HAS_EXPIRED"]);

// A request that connects and then stalls is the other face of "not wired up
// yet" — while a custom-domain route propagates, the edge can accept the socket
// and never answer. AbortSignal.timeout() surfaces that as a DOMException with
// name "TimeoutError" and a NUMERIC `code` (23), so matching on string codes
// alone silently misses it and the script crashes instead of skipping.
const SKIP_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

// Raised when the host answers but is plainly not serving this site yet.
class NotReadyError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "NotReadyError";
    this.reason = reason;
  }
}

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
function notReadyReason(error) {
  for (let current = error; current; current = current.cause) {
    if (SKIP_ERROR_NAMES.has(current.name)) {
      return `the host accepted the connection but did not answer within ${REQUEST_TIMEOUT_MS / 1000}s (${current.name})`;
    }
    if (typeof current.code === "string") {
      if (FATAL_TLS_CODES.has(current.code)) {
        return null;
      }
      if (SKIP_ERROR_CODES.has(current.code)) {
        return `the host is not reachable yet (${current.code})`;
      }
      if (SKIP_TLS_CODE_PATTERN.test(current.code)) {
        return `the TLS certificate is not issued yet (${current.code})`;
      }
    }
  }
  return null;
}

// Used only when reporting a failure, so the log names the real network error
// instead of a bare "fetch failed".
function describeError(error) {
  const parts = [];
  for (let current = error; current; current = current.cause) {
    const code = current.code === undefined ? "" : ` code=${current.code}`;
    parts.push(`${current.name ?? "Error"}: ${current.message ?? current}${code}`);
  }
  return parts.join(" <- ");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url) {
  return fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "user-agent": "zfb-example-json-api-smoke" },
  });
}

// Only the FIRST request retries: it decides ready-vs-not-ready for the whole
// run. Later requests hit a host that already served this site, so a failure
// there is a genuine problem and must never be retried into a skip.
//
// A 5xx counts as not-ready here because Cloudflare serves its own error pages
// from the edge for the minute or so after `wrangler deploy` creates a custom
// domain — the route and certificate exist before they actually work. Only the
// ROOT probe is this lenient, and only until it succeeds once.
//
// SMOKE_REQUIRE_LIVE collapses this to a single attempt — waiting out a window
// that has already closed would only delay the failure it is meant to report.
async function requestRootWithRetry(url) {
  const attempts = REQUIRE_LIVE ? 1 : CONNECT_ATTEMPTS;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(url);
      if (response.status < 500) {
        return response;
      }
      lastError = new NotReadyError(`the edge is still answering ${response.status} for this host`);
      if (attempt < attempts) {
        console.log(`  ...  edge returned ${response.status}, retrying in ${CONNECT_RETRY_MS / 1000}s`);
      }
    } catch (error) {
      if (!notReadyReason(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < attempts) {
        console.log(`  ...  not reachable yet, retrying in ${CONNECT_RETRY_MS / 1000}s`);
      }
    }
    if (attempt < attempts) {
      await sleep(CONNECT_RETRY_MS);
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
  const response = await requestRootWithRetry(`${baseUrl}/`);

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
  console.log(`Smoke testing ${baseUrl}`);
  console.log(
    REQUIRE_LIVE
      ? "SMOKE_REQUIRE_LIVE is set — the domain must be serving; nothing is skipped.\n"
      : "Propagation-window leniency is active — a not-ready domain skips.\n",
  );

  try {
    await checkHomePage(baseUrl);
  } catch (error) {
    const reason = error instanceof NotReadyError ? error.reason : notReadyReason(error);
    if (reason && REQUIRE_LIVE) {
      console.error(`::error::Smoke test failed — ${reason}. SMOKE_REQUIRE_LIVE is set, so ${baseUrl} is required to be serving and this is not a propagation window.`);
      process.exit(1);
    }
    if (reason) {
      console.log(`::notice::Smoke test skipped — ${reason}. ${baseUrl} is not serving yet; a freshly attached custom domain needs a minute or so before Cloudflare stops returning edge errors. Re-run the workflow to verify.`);
      process.exit(0);
    }
    throw error;
  }

  // The root already answered, so a network error here is a genuine problem,
  // not a not-ready state. Record it as a failure rather than letting it
  // escape as an unhandled rejection with a bare stack trace.
  for (const [label, run] of [
    ["/api/items", checkItemsApi],
    ["/api/search", checkSearchApi],
  ]) {
    try {
      await run(baseUrl);
    } catch (error) {
      check(`${label} request completed`, false, describeError(error));
    }
  }

  if (failures.length > 0) {
    console.error(`\n::error::Smoke test failed with ${failures.length} problem(s) against ${baseUrl}:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`\nSmoke test passed against ${baseUrl}.`);
}

try {
  await main();
} catch (error) {
  console.error(`::error::Smoke test errored: ${describeError(error)}`);
  process.exit(1);
}
