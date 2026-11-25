/**
 * Pre-resolved CDN redirect caching (avoiding Hub 302 rate limits and 48–94 ms
 * per-chunk round-trips) and multi-origin mirror scheduling for escaping
 * single-connection HTTP/2 throttling.
 */

export interface RedirectCacheOptions {
  /** Default TTL for cached redirects when URL carries no `Expires` query param. Default: 50 minutes. */
  defaultTtlMs?: number;
  /** Safety margin subtracted from signed CDN `Expires` timestamps. Default: 60s. */
  expirySafetyMarginMs?: number;
  /** Optional host/origin allowlist for resolved redirect targets (MV3 security). */
  allowedHosts?: readonly string[];
  /** Custom fetch implementation (defaults to `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
  /** Clock function for deterministic testing. */
  nowMs?: () => number;
}

export interface RedirectCacheEntry {
  sourceUrl: string;
  resolvedUrl: string;
  resolvedAtMs: number;
  expiresAtMs: number;
}

export interface RedirectCacheStats {
  hits: number;
  misses: number;
  resolutions: number;
  entries: number;
}

const DEFAULT_TTL_MS = 50 * 60 * 1000; // 50 minutes (safely inside 3600s CloudFront signed TTL)
const DEFAULT_SAFETY_MARGIN_MS = 60 * 1000;

function extractSignedExpiryMs(urlStr: string): number | null {
  try {
    const parsed = new URL(urlStr);
    const expiresParam = parsed.searchParams.get('Expires');
    if (expiresParam && /^\d+$/.test(expiresParam)) {
      const epochSec = Number(expiresParam);
      if (Number.isFinite(epochSec) && epochSec > 1_000_000_000) {
        return epochSec * 1000;
      }
    }
    const amzExpires = parsed.searchParams.get('X-Amz-Expires');
    const amzDate = parsed.searchParams.get('X-Amz-Date');
    if (amzExpires && amzDate && /^\d+$/.test(amzExpires)) {
      const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
      if (match) {
        const issuedMs = Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        );
        return issuedMs + Number(amzExpires) * 1000;
      }
    }
  } catch {
    // Ignore URL parse errors.
  }
  return null;
}

function isHostAllowed(urlStr: string, allowedHosts?: readonly string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) {
    return true;
  }
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return allowedHosts.some((pattern) => {
      const norm = pattern.toLowerCase();
      if (norm.startsWith('*.')) {
        const suffix = norm.slice(1);
        return host.endsWith(suffix) && host.length > suffix.length;
      }
      return host === norm;
    });
  } catch {
    return false;
  }
}

export class RedirectCache {
  private readonly cache = new Map<string, RedirectCacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly defaultTtlMs: number;
  private readonly safetyMarginMs: number;
  private readonly allowedHosts?: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private hits = 0;
  private misses = 0;
  private resolutions = 0;

  constructor(options: RedirectCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.safetyMarginMs = options.expirySafetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    this.allowedHosts = options.allowedHosts;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  getStats(): RedirectCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      resolutions: this.resolutions,
      entries: this.cache.size,
    };
  }

  getCached(sourceUrl: string): string | null {
    const entry = this.cache.get(sourceUrl);
    if (!entry) {
      return null;
    }
    if (this.nowMs() >= entry.expiresAtMs) {
      this.cache.delete(sourceUrl);
      return null;
    }
    return entry.resolvedUrl;
  }

  /**
   * Manually seeds a resolved URL (e.g., discovered during an earlier `fetch`
   * response whose `response.url` followed a 302 redirect).
   */
  recordResolved(sourceUrl: string, resolvedUrl: string): void {
    if (!resolvedUrl) {
      return;
    }
    if (!isHostAllowed(resolvedUrl, this.allowedHosts)) {
      throw new Error(`Resolved redirect target host is not allowlisted: ${resolvedUrl}`);
    }
    const now = this.nowMs();
    const signedExpiry = extractSignedExpiryMs(resolvedUrl);
    const ttlExpiry = now + this.defaultTtlMs;
    const expiresAtMs =
      signedExpiry !== null
        ? Math.min(ttlExpiry, signedExpiry - this.safetyMarginMs)
        : ttlExpiry;
    if (expiresAtMs <= now) {
      return;
    }
    this.cache.set(sourceUrl, {
      sourceUrl,
      resolvedUrl,
      resolvedAtMs: now,
      expiresAtMs,
    });
  }

  invalidate(sourceUrl: string): void {
    this.cache.delete(sourceUrl);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Returns a cached CDN URL or resolves `sourceUrl` once via a single-hop
   * `HEAD` (falling back to `Range: bytes=0-0` GET if `HEAD` is unsupported).
   * Concurrent calls for the same `sourceUrl` coalesce onto one network request.
   */
  async resolve(sourceUrl: string, signal?: AbortSignal): Promise<string> {
    const cached = this.getCached(sourceUrl);
    if (cached) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;

    const existing = this.inflight.get(sourceUrl);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const resolved = await this.performResolve(sourceUrl, signal);
        this.recordResolved(sourceUrl, resolved);
        this.resolutions += 1;
        return resolved;
      } finally {
        this.inflight.delete(sourceUrl);
      }
    })();

    this.inflight.set(sourceUrl, promise);
    return promise;
  }

  private async performResolve(sourceUrl: string, signal?: AbortSignal): Promise<string> {
    if (!isHostAllowed(sourceUrl, this.allowedHosts)) {
      throw new Error(`Source URL host is not allowlisted: ${sourceUrl}`);
    }
    try {
      const headResp = await this.fetchImpl(sourceUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal,
      });
      if (headResp.ok || (headResp.status >= 300 && headResp.status < 400)) {
        const target = headResp.url || sourceUrl;
        if (!isHostAllowed(target, this.allowedHosts)) {
          throw new Error(`Redirect target host is not allowlisted: ${target}`);
        }
        return target;
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      // Fall through to 1-byte Range probe if HEAD is blocked or errors.
    }

    const probeResp = await this.fetchImpl(sourceUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal,
    });
    // Cancel body immediately so we don't buffer data.
    try {
      await probeResp.body?.cancel();
    } catch {
      // Ignore cancel errors.
    }
    const target = probeResp.url || sourceUrl;
    if (!isHostAllowed(target, this.allowedHosts)) {
      throw new Error(`Redirect target host is not allowlisted: ${target}`);
    }
    return target;
  }
}

interface MirrorHealth {
  origin: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntilMs: number;
  ewmaBytesPerSec: number;
  inflight: number;
}

/**
 * Multi-origin URL sharding & work-stealing mirror selector.
 * Rotates chunk fetches across `urls[]` and shifts traffic away from throttled
 * or failing HTTP/2 origins.
 */
export class OriginMirrorPool {
  private readonly healthByOrigin = new Map<string, MirrorHealth>();
  private readonly nowMs: () => number;
  private roundRobinCursor = 0;

  constructor(nowMs: () => number = () => Date.now()) {
    this.nowMs = nowMs;
  }

  private getOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  private ensureHealth(url: string): MirrorHealth {
    const origin = this.getOrigin(url);
    let health = this.healthByOrigin.get(origin);
    if (!health) {
      health = {
        origin,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        cooldownUntilMs: 0,
        ewmaBytesPerSec: 0,
        inflight: 0,
      };
      this.healthByOrigin.set(origin, health);
    }
    return health;
  }

  /**
   * Picks the next mirror URL for a chunk fetch using round-robin distribution
   * across healthy origins, preferring origins with lower active concurrency
   * and avoiding origins currently in failure cooldown.
   */
  acquireMirror(urls: readonly string[]): string {
    if (urls.length === 0) {
      throw new Error('Cannot pick mirror from an empty URL list.');
    }
    if (urls.length === 1) {
      const h = this.ensureHealth(urls[0]!);
      h.inflight += 1;
      return urls[0]!;
    }

    const now = this.nowMs();
    const startIdx = this.roundRobinCursor % urls.length;
    this.roundRobinCursor += 1;

    let bestUrl = urls[startIdx]!;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let offset = 0; offset < urls.length; offset++) {
      const idx = (startIdx + offset) % urls.length;
      const candidate = urls[idx]!;
      const h = this.ensureHealth(candidate);

      const inCooldown = h.cooldownUntilMs > now;
      // Score balances spreading across origins (low inflight), avoiding cooldowns,
      // and honoring measured throughput when available.
      let score = -h.inflight * 10_000;
      if (inCooldown) {
        score -= 1_000_000 + (h.cooldownUntilMs - now);
      }
      if (h.ewmaBytesPerSec > 0) {
        score += Math.min(5_000, h.ewmaBytesPerSec / 10_000);
      }
      // Small deterministic tie-breaker preserving round-robin rotation.
      score -= offset * 0.01;

      if (score > bestScore) {
        bestScore = score;
        bestUrl = candidate;
      }
    }

    this.ensureHealth(bestUrl).inflight += 1;
    return bestUrl;
  }

  releaseSuccess(url: string, bytes: number, elapsedMs: number): void {
    const h = this.ensureHealth(url);
    h.inflight = Math.max(0, h.inflight - 1);
    h.successes += 1;
    h.consecutiveFailures = 0;
    h.cooldownUntilMs = 0;
    const rate = bytes / Math.max(0.001, elapsedMs / 1000);
    h.ewmaBytesPerSec =
      h.ewmaBytesPerSec === 0 ? rate : h.ewmaBytesPerSec * 0.7 + rate * 0.3;
  }

  releaseFailure(url: string, baseCooldownMs = 1500): void {
    const h = this.ensureHealth(url);
    h.inflight = Math.max(0, h.inflight - 1);
    h.failures += 1;
    h.consecutiveFailures += 1;
    const backoff = Math.min(30_000, baseCooldownMs * 2 ** (h.consecutiveFailures - 1));
    h.cooldownUntilMs = this.nowMs() + backoff;
  }

  getOriginStats(): Record<string, Readonly<MirrorHealth>> {
    const snapshot: Record<string, Readonly<MirrorHealth>> = {};
    for (const [origin, health] of this.healthByOrigin.entries()) {
      snapshot[origin] = { ...health };
    }
    return snapshot;
  }
}
