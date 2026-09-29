"use client";

import {
  batch,
  computed,
  For,
  getScope,
  Show,
  signal,
  type ReadonlySignal,
} from "@takazudo/zfb/zudo-react";

import type { DemoItem } from "../lib/data";

type ItemsPayload = {
  endpoint: "items";
  q: string;
  page: number;
  per: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  items: DemoItem[];
};

type SearchResult = {
  item: DemoItem;
  score: number;
  terms: string[];
};

type SearchPayload = {
  endpoint: "search";
  q: string;
  limit: number;
  total: number;
  indexBuiltAt: string | null;
  indexBuildCount: number;
  results: SearchResult[];
};

const PAGE_SIZE = 6;

function endpointUrl(path: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && String(value).length > 0) {
      query.set(key, String(value));
    }
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function readJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "request failed"}`);
  }
  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON but received ${contentType || "an empty content type"}`);
  }
  return (await response.json()) as T;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatIndexTime(value: string | null) {
  if (!value) {
    return "not built";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

// Components run setup once, so every field reads through the item signal:
// a same-key replacement from a newer response updates the retained row.
function ItemCard({
  item,
  score,
  terms,
}: {
  item: ReadonlySignal<DemoItem>;
  score?: ReadonlySignal<number>;
  terms?: ReadonlySignal<string[]>;
}) {
  const tags = computed(() => item.value.tags.map((tag, position) => ({ tag, position })));
  const hasTerms = computed(() => (terms ? terms.value.length > 0 : false));

  return (
    <li class="item-card">
      <div class="item-card__meta">
        <span>{computed(() => item.value.id)}</span>
        <span class={computed(() => `status status--${item.value.status}`)}>
          {computed(() => item.value.status)}
        </span>
      </div>
      <h3>{computed(() => item.value.name)}</h3>
      <p>{computed(() => item.value.summary)}</p>
      <dl class="item-facts">
        <div>
          <dt>Category</dt>
          <dd>{computed(() => item.value.category)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{computed(() => item.value.owner)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{computed(() => formatDate(item.value.updatedAt))}</dd>
        </div>
        {score ? (
          <div>
            <dt>Score</dt>
            <dd>{computed(() => score.value.toFixed(3))}</dd>
          </div>
        ) : null}
      </dl>
      <div class="tag-row" aria-label={computed(() => `${item.value.name} tags`)}>
        <For each={tags} by={(entry) => entry.position}>
          {(entry) => <span>{computed(() => entry.value.tag)}</span>}
        </For>
      </div>
      <Show when={hasTerms}>
        {() => <p class="match-terms">Matched: {computed(() => (terms?.value ?? []).join(", "))}</p>}
      </Show>
    </li>
  );
}

export default function ItemBrowser() {
  const scope = getScope();
  const draft = signal("");
  const query = signal("");
  const page = signal(1);
  const refreshToken = signal(0);
  const itemsPayload = signal<ItemsPayload | null>(null);
  const searchPayload = signal<SearchPayload | null>(null);
  const loading = signal(false);
  const error = signal<string | null>(null);

  // Only the newest request may write state; an older one can still resolve after a
  // newer request started, or after its body already arrived when the abort landed.
  let generation = 0;

  scope.effect(() => {
    const q = query.value;
    const currentPage = page.value;
    void refreshToken.value;

    const controller = new AbortController();
    const requestGeneration = ++generation;
    const isStale = () =>
      requestGeneration !== generation || controller.signal.aborted || scope.abortSignal.aborted;

    batch(() => {
      loading.value = true;
      error.value = null;
    });

    void (async () => {
      try {
        const [items, search] = await Promise.all([
          fetch(endpointUrl("/api/items", { q, page: currentPage, per: PAGE_SIZE }), {
            signal: controller.signal,
          }).then((response) => readJson<ItemsPayload>(response)),
          fetch(endpointUrl("/api/search", { q, limit: PAGE_SIZE }), {
            signal: controller.signal,
          }).then((response) => readJson<SearchPayload>(response)),
        ]);
        if (isStale()) {
          return;
        }
        batch(() => {
          itemsPayload.value = items;
          searchPayload.value = search;
        });
      } catch (err) {
        if (!isStale()) {
          error.value = err instanceof Error ? err.message : String(err);
        }
      } finally {
        if (!isStale()) {
          loading.value = false;
        }
      }
    })();

    return () => controller.abort();
  });

  const items = computed(() => itemsPayload.value?.items ?? []);
  const results = computed(() => searchPayload.value?.results ?? []);
  const hasError = computed(() => error.value !== null);

  return (
    <section class="api-console" aria-busy={loading}>
      <form
        class="toolbar"
        on:submit={(event: Event) => {
          event.preventDefault();
          batch(() => {
            page.value = 1;
            query.value = draft.value.trim();
          });
        }}
      >
        <label>
          <span>Search</span>
          <input
            type="search"
            modelValue={draft}
            placeholder="Try support, review, onboarding..."
          />
        </label>
        <div class="toolbar-actions">
          <button type="submit">Search</button>
          <button
            type="button"
            class="button-secondary"
            on:click={() => {
              batch(() => {
                draft.value = "";
                query.value = "";
                page.value = 1;
              });
            }}
          >
            Clear
          </button>
          <button
            type="button"
            class="button-secondary"
            on:click={() => {
              refreshToken.value += 1;
            }}
          >
            Refresh
          </button>
        </div>
      </form>

      <Show when={hasError}>
        {() => <p class="error-note">API request failed: {error}</p>}
      </Show>

      <div class="metric-strip">
        <div>
          <span>Items</span>
          <strong>{computed(() => (itemsPayload.value ? itemsPayload.value.total : "..."))}</strong>
        </div>
        <div>
          <span>Search hits</span>
          <strong>{computed(() => (searchPayload.value ? searchPayload.value.total : "..."))}</strong>
        </div>
        <div>
          <span>Index built</span>
          <strong>{computed(() => formatIndexTime(searchPayload.value?.indexBuiltAt ?? null))}</strong>
        </div>
        <div>
          <span>Build count</span>
          <strong>{computed(() => searchPayload.value?.indexBuildCount ?? "...")}</strong>
        </div>
      </div>

      <div class="result-grid">
        <section class="result-panel">
          <div class="panel-header">
            <div>
              <h2>Filtered items</h2>
              <p>
                Page {computed(() => itemsPayload.value?.page ?? page.value)} of{" "}
                {computed(() => itemsPayload.value?.pages ?? 1)}
              </p>
            </div>
            <div class="pager">
              <button
                type="button"
                class="button-secondary"
                disabled={computed(() => loading.value || !itemsPayload.value?.hasPrevious)}
                on:click={() => {
                  page.value = Math.max(1, page.value - 1);
                }}
              >
                Prev
              </button>
              <button
                type="button"
                class="button-secondary"
                disabled={computed(() => loading.value || !itemsPayload.value?.hasNext)}
                on:click={() => {
                  page.value += 1;
                }}
              >
                Next
              </button>
            </div>
          </div>
          <ul class="item-list">
            <For each={items} by={(item) => item.id}>
              {(item) => <ItemCard item={item} />}
            </For>
          </ul>
        </section>

        <section class="result-panel">
          <div class="panel-header">
            <div>
              <h2>Search ranking</h2>
              <p>
                {computed(() =>
                  query.value ? `Query: ${query.value}` : "Showing default index sample",
                )}
              </p>
            </div>
          </div>
          <ul class="item-list">
            <For each={results} by={(result) => result.item.id}>
              {(result) => (
                <ItemCard
                  item={computed(() => result.value.item)}
                  score={computed(() => result.value.score)}
                  terms={computed(() => result.value.terms)}
                />
              )}
            </For>
          </ul>
        </section>
      </div>
    </section>
  );
}
