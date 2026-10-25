// A small in-memory TTL cache for live Qloo responses: private, per process, never on disk
// (the hackathon guide allows private server-side caching). Bounded: past `maxEntries`,
// the oldest entry is evicted first.

export const CACHE_TTL_MS = 6 * 3600_000;
export const CACHE_MAX_ENTRIES = 500;

export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  size(): number;
}

export function createTtlCache<T>(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): TtlCache<T> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const max = opts.maxEntries ?? CACHE_MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: T; expires: number }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttl });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
    size: () => entries.size,
  };
}

/** The cache key for a request: path plus params sorted by name. */
export function cacheKey(path: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return `${path}?${sorted}`;
}
