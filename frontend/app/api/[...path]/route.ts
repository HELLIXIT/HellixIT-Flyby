import { NextRequest, NextResponse } from 'next/server';
import { gzipSync } from 'zlib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Same-origin proxy to the NestJS API. Keeps the browser free of CORS issues and lets us
 * fail over between several backend addresses (public URL, private network, extra replicas).
 */
function backends(): string[] {
  const list: string[] = [];
  const add = (u?: string) => {
    const v = u?.trim().replace(/\/+$/, '');
    if (v && !list.includes(v)) list.push(v);
  };
  add(process.env.BACKEND_URL);
  for (const u of (process.env.BACKEND_FALLBACK_URLS ?? '').split(',')) add(u);
  // Render private network (`fromService.property: hostport`) has no scheme.
  if (process.env.BACKEND_HOSTPORT) add(`http://${process.env.BACKEND_HOSTPORT}`);
  if (!list.length) add('http://localhost:4000');
  return list;
}

// Remember which backend answered last so healthy traffic doesn't keep probing a dead one first.
let preferred = 0;

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const suffix = `/api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const all = backends();
  const order = all.map((_, i) => all[(i + preferred) % all.length]);
  // A sleeping free-tier Render service can take ~50 s to wake; allow for it on the last attempt.
  const errors: string[] = [];

  for (let i = 0; i < order.length; i++) {
    const base = order[i];
    const last = i === order.length - 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), last ? 60_000 : 12_000);
    try {
      const res = await fetch(base + suffix, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      // 5xx from a backend = try another one; 4xx is a real answer.
      if (res.status >= 500 && !last) {
        errors.push(`${base}: ${res.status}`);
        continue;
      }
      preferred = all.indexOf(base);
      const body = await res.text();
      const headers: Record<string, string> = {
        'content-type': res.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      };
      // Live-traffic responses can be MBs of JSON (world view); gzip shrinks them ~7×.
      if (body.length > 2048 && /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')) {
        headers['content-encoding'] = 'gzip';
        headers.vary = 'accept-encoding';
        return new NextResponse(new Uint8Array(gzipSync(body, { level: 6 })), { status: res.status, headers });
      }
      return new NextResponse(body, { status: res.status, headers });
    } catch (err) {
      errors.push(`${base}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.error('[proxy] all backends failed', errors);
  return NextResponse.json({ error: 'backend_unavailable', message: 'Flight data service is temporarily unreachable.' }, { status: 503 });
}
