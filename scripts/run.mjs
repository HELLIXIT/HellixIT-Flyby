#!/usr/bin/env node
/**
 * Runs the NestJS API and the Next.js web app together as one app.
 *
 *   node scripts/run.mjs dev    → watch mode for both (local development)
 *   node scripts/run.mjs start  → production (used by Render)
 *
 * Loads ./.env (without overriding variables already set, so Render's env vars win),
 * keeps the API on an internal port and points the web app's /api proxy at it.
 * If either process dies, the other is stopped and we exit non-zero so the host restarts us.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'dev' ? 'dev' : 'start';

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv(join(root, '.env'));

const apiPort = process.env.API_PORT || '4000';
const webPort = process.env.PORT || '3000';
if (apiPort === webPort) {
  console.error(`API_PORT (${apiPort}) must differ from PORT (${webPort}).`);
  process.exit(1);
}

const apps = [
  {
    name: 'api',
    color: '\x1b[36m',
    dir: 'backend',
    script: mode === 'dev' ? 'start:dev' : 'start',
    // The API is only reached through the web app's proxy, so keep it on localhost.
    env: { API_PORT: apiPort, API_HOST: process.env.API_HOST || '127.0.0.1' },
  },
  {
    name: 'web',
    color: '\x1b[35m',
    dir: 'frontend',
    script: mode === 'dev' ? 'dev' : 'start',
    env: { PORT: webPort, BACKEND_URL: process.env.BACKEND_URL || `http://127.0.0.1:${apiPort}` },
  },
];

const children = [];
let shuttingDown = false;

function prefixLines(stream, out, label) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) out.write(`${label} ${l}\n`);
  });
  stream.on('end', () => buf && out.write(`${label} ${buf}\n`));
}

/** Stop a child and everything it spawned (npm → tsc-watch → node, next → workers). */
function killTree(child, signal = 'SIGTERM') {
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, signal); // negative pid = the child's whole process group
  } catch {
    child.kill(signal);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) killTree(c);
  setTimeout(() => children.forEach((c) => killTree(c, 'SIGKILL')), 2500).unref();
  setTimeout(() => process.exit(code), 3000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once('exit', r))))).then(() => process.exit(code));
}

for (const app of apps) {
  const label = `${app.color}[${app.name}]\x1b[0m`;
  const child = spawn('npm', ['run', app.script], {
    cwd: join(root, app.dir),
    env: { ...process.env, ...app.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    // Own process group, so shutdown can signal the whole tree.
    detached: process.platform !== 'win32',
  });
  prefixLines(child.stdout, process.stdout, label);
  prefixLines(child.stderr, process.stderr, label);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${label} exited (${signal ?? code}) — stopping the app`);
    shutdown(code || 1);
  });
  children.push(child);
}

console.log(`Flyby ${mode}: web → http://localhost:${webPort}  (API on 127.0.0.1:${apiPort})`);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
