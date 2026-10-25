import { Logger } from '@nestjs/common';

export interface Provider<A extends unknown[], R> {
  name: string;
  run: (...args: A) => Promise<R>;
  /** Minimum ms between calls to this provider (respect free-tier rate limits). */
  minIntervalMs?: number;
  /** Treat this result as a miss and continue down the chain (e.g. empty lookup). */
  isMiss?: (r: R, ...args: A) => boolean;
}

export interface ProviderHealth {
  name: string;
  state: 'up' | 'open';
  consecutiveFailures: number;
  successes: number;
  failures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  retryAt: string | null;
}

class Breaker {
  consecutiveFailures = 0;
  successes = 0;
  failures = 0;
  openUntil = 0;
  lastError: string | null = null;
  lastErrorAt = 0;
  lastSuccessAt = 0;
  nextSlot = 0;

  constructor(
    private readonly threshold: number,
    private readonly baseCooldownMs: number,
    private readonly maxCooldownMs: number,
  ) {}

  get available() {
    return Date.now() >= this.openUntil;
  }

  success() {
    this.consecutiveFailures = 0;
    this.successes++;
    this.openUntil = 0;
    this.lastSuccessAt = Date.now();
  }

  failure(err: Error) {
    this.consecutiveFailures++;
    this.failures++;
    this.lastError = err.message;
    this.lastErrorAt = Date.now();
    const rateLimited = /\b429\b/.test(err.message);
    // Honour the upstream's Retry-After (capped at 24 h) — e.g. OpenSky's daily quota reset.
    const retryAfter = (err as { retryAfterSec?: number }).retryAfterSec;
    if (rateLimited && retryAfter) {
      this.openUntil = Date.now() + Math.min(retryAfter, 86_400) * 1000;
      return;
    }
    if (rateLimited || this.consecutiveFailures >= this.threshold) {
      const n = Math.max(0, this.consecutiveFailures - this.threshold);
      const cooldown = Math.min(this.maxCooldownMs, this.baseCooldownMs * 2 ** n);
      this.openUntil = Date.now() + cooldown;
    }
  }
}

/**
 * Ordered list of interchangeable upstream providers.
 * Each call walks the chain: providers whose circuit breaker is open are skipped,
 * failures/misses fall through to the next provider. If every provider is open,
 * the chain still tries them all (best effort) rather than failing outright.
 */
export class ProviderChain<A extends unknown[], R> {
  private readonly logger: Logger;
  private readonly breakers = new Map<string, Breaker>();

  constructor(
    readonly name: string,
    private readonly providers: Provider<A, R>[],
    private readonly opts: {
      threshold?: number;
      cooldownMs?: number;
      maxCooldownMs?: number;
      /** When several providers only return "misses", choose which one to return. */
      betterMiss?: (a: R, b: R) => boolean;
    } = {},
  ) {
    this.logger = new Logger(`Chain:${name}`);
    for (const p of providers) {
      this.breakers.set(p.name, new Breaker(opts.threshold ?? 3, opts.cooldownMs ?? 30_000, opts.maxCooldownMs ?? 5 * 60_000));
    }
  }

  async run(...args: A): Promise<R & {}> {
    const res = await this.runWithSource(...args);
    return res.value;
  }

  async runWithSource(...args: A): Promise<{ value: R & {}; source: string }> {
    const ready = this.providers.filter((p) => this.breakers.get(p.name)!.available);
    const order = ready.length ? ready : this.providers;
    const errors: string[] = [];
    let miss: { value: R; source: string } | null = null;

    for (const p of order) {
      const br = this.breakers.get(p.name)!;
      try {
        await this.throttle(p, br);
        const value = await p.run(...args);
        br.success();
        if (value === null || value === undefined || p.isMiss?.(value, ...args)) {
          if (!miss || (value != null && miss.value != null && this.opts.betterMiss?.(value, miss.value))) miss = { value, source: p.name };
          continue;
        }
        return { value: value as R & {}, source: p.name };
      } catch (err) {
        if (!(err as Error).message.startsWith('local rate-limit')) br.failure(err as Error);
        errors.push(`${p.name}: ${(err as Error).message}`);
        this.logger.warn(`${p.name} failed → trying next (${(err as Error).message})`);
      }
    }
    if (miss) return miss as { value: R & {}; source: string };
    throw new Error(`All providers failed for ${this.name}: ${errors.join('; ')}`);
  }

  /**
   * Ask every available provider at once and return all successful answers.
   * Used where providers have *different coverage* (e.g. separate receiver networks),
   * so a "not found" from one doesn't mean "not found" everywhere.
   */
  async runAll(...args: A): Promise<{ value: R; source: string }[]> {
    const ready = this.providers.filter((p) => this.breakers.get(p.name)!.available);
    const settled = await Promise.allSettled(
      ready.map(async (p) => {
        const br = this.breakers.get(p.name)!;
        try {
          await this.throttle(p, br);
          const value = await p.run(...args);
          br.success();
          return { value, source: p.name };
        } catch (err) {
          if (!(err as Error).message.startsWith('local rate-limit')) br.failure(err as Error);
          this.logger.warn(`${p.name} failed (${(err as Error).message})`);
          throw err;
        }
      }),
    );
    return settled.filter((s) => s.status === 'fulfilled').map((s) => (s as PromiseFulfilledResult<{ value: R; source: string }>).value);
  }

  health(): ProviderHealth[] {
    return this.providers.map((p) => {
      const b = this.breakers.get(p.name)!;
      const iso = (t: number) => (t ? new Date(t).toISOString() : null);
      return {
        name: p.name,
        state: b.available ? 'up' : 'open',
        consecutiveFailures: b.consecutiveFailures,
        successes: b.successes,
        failures: b.failures,
        lastError: b.lastError,
        lastErrorAt: iso(b.lastErrorAt),
        lastSuccessAt: iso(b.lastSuccessAt),
        retryAt: b.available ? null : iso(b.openUntil),
      };
    });
  }

  private async throttle(p: Provider<A, R>, br: Breaker) {
    if (!p.minIntervalMs) return;
    const now = Date.now();
    const slot = Math.max(now, br.nextSlot);
    // Don't queue forever behind a slow rate limit — skip to the next provider instead.
    if (slot - now > 6_000) throw new Error('local rate-limit queue full');
    br.nextSlot = slot + p.minIntervalMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}
