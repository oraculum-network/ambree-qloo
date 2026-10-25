// Fetch with a hard timeout and a streamed body-size cap (adapted from ambree-alexa's
// feeds/fetch.ts). Redirects are refused, not followed: fetch drops the standard auth
// header on a cross-origin redirect but not a custom X-Api-Key, so following one could
// send the key to another host.

export const QLOO_TIMEOUT_MS = 6000;
export const QLOO_MAX_BYTES = 1024 * 1024;

export type FetchFailure = "timeout" | "network" | "too_big" | "redirect";

export class CappedFetchError extends Error {
  override name = "CappedFetchError";
  readonly kind: FetchFailure;
  constructor(kind: FetchFailure) {
    super(kind);
    this.kind = kind;
  }
}

export interface FetchedText {
  status: number;
  headers: Headers;
  text: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRedirectRefusal(e: unknown): boolean {
  const cause = (e as { cause?: { message?: unknown } })?.cause;
  return /redirect/i.test(String(cause?.message ?? "")) || /redirect/i.test(e instanceof Error ? e.message : "");
}

export async function fetchCapped(
  url: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; maxBytes?: number; fetch?: FetchLike } = {},
): Promise<FetchedText> {
  const timeoutMs = opts.timeoutMs ?? QLOO_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? QLOO_MAX_BYTES;
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal, redirect: "error" });
    // A fetch that hands back a 3xx anyway (an injected one, say) is refused the same way.
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new CappedFetchError("redirect");
    }
    const declared = Number(res.headers.get("content-length") || "0");
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new CappedFetchError("too_big");
    }
    if (res.status === 204 || !res.body) return { status: res.status, headers: res.headers, text: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CappedFetchError("too_big");
      }
      chunks.push(value);
    }
    return { status: res.status, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    if (e instanceof CappedFetchError) throw e;
    if (ctrl.signal.aborted) throw new CappedFetchError("timeout");
    if (isRedirectRefusal(e)) throw new CappedFetchError("redirect");
    throw new CappedFetchError("network");
  } finally {
    clearTimeout(timer);
  }
}
