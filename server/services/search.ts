export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published?: string;
}

export interface SearchService {
  available(): { configured: boolean; provider: string | null };
  search(query: string, opts?: { count?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export class SearchUnavailableError extends Error {}

/**
 * Web search via a self-hosted SearXNG instance (free, open source) or the
 * Brave Search API (free tier with limits). Only runs when explicitly configured.
 */
export function createSearchService(opts: { searxngUrl?: string; braveKey?: string }, fetchImpl: typeof fetch = fetch): SearchService {
  const provider = opts.searxngUrl ? 'SearXNG' : opts.braveKey ? 'Brave Search' : null;
  return {
    available: () => ({ configured: !!provider, provider }),
    async search(query, { count = 8, signal } = {}) {
      if (!provider) throw new SearchUnavailableError('Web research is not configured on the server (set SEARXNG_URL or BRAVE_SEARCH_API_KEY).');
      const q = query.slice(0, 400);
      const timeout = AbortSignal.timeout(15_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        if (opts.searxngUrl) {
          const url = new URL('/search', opts.searxngUrl);
          url.searchParams.set('q', q);
          url.searchParams.set('format', 'json');
          url.searchParams.set('safesearch', '1');
          res = await fetchImpl(url, { signal: combined, headers: { accept: 'application/json' } });
        } else {
          const url = new URL('https://api.search.brave.com/res/v1/web/search');
          url.searchParams.set('q', q);
          url.searchParams.set('count', String(Math.min(count, 20)));
          res = await fetchImpl(url, { signal: combined, headers: { accept: 'application/json', 'X-Subscription-Token': opts.braveKey! } });
        }
      } catch {
        throw new SearchUnavailableError(`${provider} could not be reached.`);
      }
      if (res.status === 429) throw new SearchUnavailableError(`${provider} usage limit reached. Try again later.`);
      if (!res.ok) throw new SearchUnavailableError(`${provider} returned an error (${res.status}).`);
      const data: any = await res.json();
      const raw: any[] = opts.searxngUrl ? data.results ?? [] : data.web?.results ?? [];
      return raw
        .filter((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))
        .slice(0, count)
        .map((r) => ({
          title: String(r.title ?? r.url).slice(0, 300),
          url: r.url,
          snippet: stripTags(String(r.content ?? r.description ?? '')).slice(0, 600),
          source: safeHost(r.url),
          published: r.publishedDate ?? r.page_age ?? undefined,
        }));
    },
  };
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
function safeHost(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
