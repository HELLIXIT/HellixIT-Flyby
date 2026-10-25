import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Render health check for the combined app: healthy only when both the web server
 * and the NestJS API (on its internal port) respond.
 */
export async function GET() {
  const api = (process.env.BACKEND_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
  try {
    const res = await fetch(`${api}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const body = await res.json();
    return NextResponse.json({ status: 'ok', api: body.status });
  } catch (err) {
    return NextResponse.json({ status: 'error', api: 'unreachable', message: (err as Error).message }, { status: 503 });
  }
}
