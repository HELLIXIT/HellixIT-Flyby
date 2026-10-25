import { Injectable, Logger } from '@nestjs/common';

interface Entry<T> {
  value: T;
  expires: number;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** Seconds the upstream asked us to wait (Retry-After), if any. */
    public readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/**
 * Optional free OpenSky account (OAuth2 client credentials). Raises the daily quota well above
 * the anonymous per-IP limit. Create an API client on your OpenSky account page.
 */
class OpenSkyAuth {
  private token: string | null = null;
  private expires = 0;
  private pending: Promise<string | null> | null = null;
  private readonly id = process.env.OPENSKY_CLIENT_ID?.trim();
  private readonly secret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  private readonly url =
    process.env.OPENSKY_TOKEN_URL ?? 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  private readonly logger = new Logger('OpenSkyAuth');

  get configured() {
    return !!(this.id && this.secret);
  }

  async header(): Promise<string | null> {
    if (!this.configured) return null;
    if (this.token && Date.now() < this.expires) return `Bearer ${this.token}`;
    this.pending ??= this.fetchToken().finally(() => (this.pending = null));
    const t = await this.pending;
    return t ? `Bearer ${t}` : null;
  }

  private async fetchToken(): Promise<string | null> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.id!, client_secret: this.secret! }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`token endpoint ${res.status}`);
      const j = (await res.json()) as { access_token: string; expires_in?: number };
      this.token = j.access_token;
      this.expires = Date.now() + Math.max(60, (j.expires_in ?? 1800) - 60) * 1000;
      return this.token;
    } catch (err) {
      // Fall back to anonymous access rather than failing requests.
      this.logger.warn(`Could not get OpenSky token, using anonymous access: ${(err as Error).message}`);
      this.expires = Date.now() + 5 * 60_000;
      this.token = null;
      return null;
    }
  }
}

const USER_AGENT =
  process.env.UPSTREAM_USER_AGENT ??
  'Flyby/1.0 (+https://github.com/hellixit/flyby; flight tracker)';

/**
 * Small TTL cache + upstream fetch helper.
 * - Collapses concurrent requests for the same key into one upstream call.
 * - Serves stale data (up to `staleMs`) if the upstream fails, so the UI keeps working
 *   through brief outages or rate limits of the free APIs.
 */
@Injectable()
export class HttpCacheService {
  private readonly logger = new Logger('Upstream');
  private readonly cache = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  readonly openSkyAuth = new OpenSkyAuth();

  constructor() {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Fresh cached value for a key without triggering a load (undefined if absent/expired). */
  peek<T>(key: string): T | undefined {
    const hit = this.cache.get(key) as Entry<T> | undefined;
    return hit && hit.expires > Date.now() ? hit.value : undefined;
  }

  async cached<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    staleMs = 5 * 60_000,
    /** TTL for empty (null) results — "not found" may be a transient upstream gap. */
    nullTtlMs = ttlMs,
  ): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key) as Entry<T> | undefined;
    if (hit && hit.expires > now) return hit.value;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await loader();
        this.cache.set(key, { value, expires: Date.now() + (value === null || value === undefined ? nullTtlMs : ttlMs) });
        return value;
      } catch (err) {
        if (hit && hit.expires + staleMs > Date.now()) {
          this.logger.warn(`Serving stale ${key}: ${(err as Error).message}`);
          return hit.value;
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  async getJson<T = any>(url: string, timeoutMs = 10_000): Promise<T> {
    const res = await this.fetchRaw(url, timeoutMs);
    return (await res.json()) as T;
  }

  async getText(url: string, timeoutMs = 30_000): Promise<string> {
    const res = await this.fetchRaw(url, timeoutMs);
    return res.text();
  }

  private async fetchRaw(url: string, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' };
      if (new URL(url).host.endsWith('opensky-network.org')) {
        const auth = await this.openSkyAuth.header();
        if (auth) headers.Authorization = auth;
      }
      const res = await fetch(url, { signal: ctrl.signal, headers });
      if (!res.ok) {
        const ra = Number(res.headers.get('retry-after') ?? res.headers.get('x-rate-limit-retry-after-seconds'));
        throw new UpstreamError(`${res.status} from ${new URL(url).host}`, res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
      }
      return res;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError(`${new URL(url).host}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private sweep() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.cache) if (v.expires < cutoff) this.cache.delete(k);
  }
}
