import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  scanSessions,
  scanMetrics,
  searchSessions,
  filterSessions,
  findSession,
  launch,
  buildLaunch,
  toggleFavorite,
  deleteSession,
  restoreSession,
  projectsDir,
} from '@csm/core';
import { publicDir } from '@csm/ui/dir';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4777;
const MAX_BULK = 500; // cap bulk delete/restore payload size

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Create (but do not start) the agent HTTP server.
 *
 * Security model (this process can spawn `claude`, so the surface must be tiny):
 *  - binds 127.0.0.1 only (never 0.0.0.0)
 *  - per-run random token required on every /api request (header or ?token)
 *  - Host header allowlist defeats DNS-rebinding
 *  - /api/open only accepts a sessionId that exists in the current scan;
 *    it never takes a path or command from the client
 *
 * @param {Object} [opts]
 * @param {string} [opts.token]  override token (testing)
 * @param {number} [opts.cacheMs] how long a scan is reused (default 3000)
 * @returns {{ server: http.Server, token: string }}
 */
export function createServer(opts = {}) {
  const token = opts.token || crypto.randomBytes(24).toString('base64url');
  const cacheMs = opts.cacheMs ?? 3000;

  /** @type {{ at: number, data: import('@csm/core').Session[] }|null} */
  let cache = null;
  async function getSessions() {
    const now = Date.now();
    if (cache && now - cache.at < cacheMs) return cache.data;
    const data = await scanSessions();
    cache = { at: now, data };
    return data;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}`);

      // --- security gate (skip for static GET of the app shell) ---
      const isApi = url.pathname.startsWith('/api/');

      if (!hostAllowed(req.headers.host)) {
        return send(res, 403, { error: 'forbidden host' });
      }

      if (isApi && !tokenOk(req, url, token)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      // --- routes ---
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        return handleStream(req, res);
      }

      if (req.method === 'GET' && url.pathname === '/api/monitor') {
        // One-shot metrics snapshot (polling fallback for the SSE stream).
        const data = await scanMetrics();
        return send(res, 200, data);
      }

      if (req.method === 'GET' && url.pathname === '/api/session') {
        const id = url.searchParams.get('id');
        if (!id) return send(res, 400, { error: 'missing id' });
        const slug = url.searchParams.get('slug') || undefined;
        const { sessions } = await scanMetrics();
        const { match, ambiguous } = findSession(sessions, id, { slug });
        if (!match) {
          return send(res, ambiguous.length ? 409 : 404, {
            error: ambiguous.length ? 'ambiguous id' : 'unknown id',
          });
        }
        return send(res, 200, { session: match });
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const q = url.searchParams.get('q') || '';
        const all = await getSessions();
        // Branch list (from the full set) so the UI can offer a branch filter.
        const branches = [...new Set(all.map((s) => s.branch).filter(Boolean))].sort();
        let sessions = q.trim() ? searchSessions(all, q) : all;
        sessions = filterSessions(sessions, {
          favoritesOnly: url.searchParams.get('fav') === '1',
          hideOrphans: url.searchParams.get('orphans') === '0',
          branch: url.searchParams.get('branch') || undefined,
          recentDays: Number(url.searchParams.get('recent')) || undefined,
        });
        return send(res, 200, { sessions, count: sessions.length, branches });
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = await readJson(req);
        return handleOpen(res, body, getSessions);
      }

      if (req.method === 'POST' && url.pathname === '/api/favorite') {
        const body = await readJson(req);
        if (!body || typeof body.id !== 'string') {
          return send(res, 400, { error: 'missing id' });
        }
        const favorited = await toggleFavorite(body.id);
        cache = null; // favorites changed -> invalidate scan cache
        return send(res, 200, { id: body.id, favorited });
      }

      if (req.method === 'POST' && url.pathname === '/api/delete') {
        const body = await readJson(req);
        const id = body && typeof body.id === 'string' ? body.id : null;
        if (!id) return send(res, 400, { error: 'missing id' });
        // Only delete a session that exists in the current scan (never an
        // arbitrary path); deleteSession also guards against traversal.
        const sessions = await getSessions();
        // slug pins which copy when the same UUID exists in two project folders
        // (worktree duplicates), so we never trash the wrong file.
        const slug = body && typeof body.slug === 'string' ? body.slug : undefined;
        const { match } = findSession(sessions, id, { slug });
        if (!match) return send(res, 404, { error: 'unknown id' });
        const r = await deleteSession(match);
        cache = null; // list changed
        return send(res, 200, { ok: true, id: match.id, title: match.title, hadDir: r.hadDir });
      }

      if (req.method === 'POST' && url.pathname === '/api/delete-bulk') {
        const body = await readJson(req);
        const items = body && Array.isArray(body.items) ? body.items : null;
        if (!items) return send(res, 400, { error: 'items must be an array' });
        if (items.length > MAX_BULK) return send(res, 400, { error: `too many items (max ${MAX_BULK})` });
        // Scan once; resolve each item against it (never an arbitrary path).
        const sessions = await getSessions();
        const results = [];
        for (const it of items) {
          const id = it && typeof it.id === 'string' ? it.id : null;
          const slug = it && typeof it.slug === 'string' ? it.slug : undefined;
          if (!id) { results.push({ id: null, ok: false, error: 'missing id' }); continue; }
          // slug pins the right copy when the same UUID lives under two slugs
          // (worktree duplicates); fall back to plain id resolution otherwise.
          const match = slug
            ? sessions.find((s) => s.id === id && s.projectSlug === slug)
            : findSession(sessions, id).match;
          if (!match) { results.push({ id, ok: false, error: 'unknown id' }); continue; }
          try {
            const r = await deleteSession(match);
            results.push({ id: match.id, ok: true, hadDir: r.hadDir });
          } catch (err) {
            results.push({ id, ok: false, error: String(err && err.message ? err.message : err) });
          }
        }
        cache = null; // list changed
        const deleted = results.filter((r) => r.ok).length;
        return send(res, 200, { ok: true, results, deleted, failed: results.length - deleted });
      }

      if (req.method === 'POST' && url.pathname === '/api/restore-bulk') {
        const body = await readJson(req);
        const ids = body && Array.isArray(body.ids) ? body.ids : null;
        if (!ids) return send(res, 400, { error: 'ids must be an array' });
        if (ids.length > MAX_BULK) return send(res, 400, { error: `too many items (max ${MAX_BULK})` });
        const results = [];
        for (const id of ids) {
          if (typeof id !== 'string') { results.push({ id: null, ok: false, error: 'invalid id' }); continue; }
          try {
            const r = await restoreSession(id);
            results.push({ id: r.id, ok: true });
          } catch (err) {
            results.push({ id, ok: false, error: String(err && err.message ? err.message : err) });
          }
        }
        cache = null;
        const restored = results.filter((r) => r.ok).length;
        return send(res, 200, { ok: true, results, restored, failed: results.length - restored });
      }

      if (req.method === 'POST' && url.pathname === '/api/restore') {
        const body = await readJson(req);
        const id = body && typeof body.id === 'string' ? body.id : null;
        if (!id) return send(res, 400, { error: 'missing id' });
        const r = await restoreSession(id);
        cache = null;
        return send(res, 200, { ok: true, id: r.id });
      }

      if (req.method === 'GET') {
        return serveStatic(res, url.pathname, token);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  return { server, token };
}

/**
 * Start the agent and resolve once listening.
 * @param {Object} [opts]
 * @param {number} [opts.port]
 * @returns {Promise<{ server: http.Server, token: string, port: number, url: string }>}
 */
export function start(opts = {}) {
  const { server, token } = createServer(opts);
  // Use ?? not || so port 0 (OS-assigned free port, used by the desktop app)
  // is honored instead of falling through to the default.
  const requested = opts.port ?? DEFAULT_PORT;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, HOST, () => {
      // Read the actual bound port (matters when requested was 0).
      const port = server.address().port;
      const url = `http://${HOST}:${port}/?token=${token}`;
      resolve({ server, token, port, url });
    });
  });
}

// --- handlers -------------------------------------------------------------

async function handleOpen(res, body, getSessions) {
  const id = body && typeof body.id === 'string' ? body.id : null;
  if (!id) return send(res, 400, { error: 'missing id' });

  const sessions = await getSessions();
  // slug pins which copy when the same UUID exists in two project folders.
  const slug = body && typeof body.slug === 'string' ? body.slug : undefined;
  const { match, ambiguous } = findSession(sessions, id, { slug });
  if (!match) {
    return send(res, ambiguous.length ? 409 : 404, {
      error: ambiguous.length ? 'ambiguous id' : 'unknown id',
      candidates: ambiguous.map((s) => ({ id: s.id, projectSlug: s.projectSlug })),
    });
  }
  if (!match.cwd) return send(res, 422, { error: 'session has no cwd' });

  const launchOpts = {
    cwd: match.cwd,
    sessionId: match.id,
    fork: !!(body && body.fork),
    // Default ON (friction-free resume); the UI sends false to opt out.
    skipPermissions: body && body.skipPermissions !== undefined
      ? !!body.skipPermissions
      : true,
    terminal: (body && body.terminal) || 'auto',
  };

  if (body && body.dryRun) {
    const { cmd, args, terminal } = buildLaunch(launchOpts);
    return send(res, 200, { dryRun: true, terminal, cmd, args, cwdExists: match.cwdExists });
  }

  const { terminal } = launch(launchOpts);
  return send(res, 200, {
    ok: true,
    terminal,
    id: match.id,
    title: match.title,
    cwd: match.cwd,
    cwdExists: match.cwdExists,
  });
}

/**
 * Server-Sent Events stream of the metrics snapshot. Pushes an update whenever
 * a .jsonl under the projects dir changes (debounced), plus a periodic
 * heartbeat so proxies/clients don't time the connection out. The token is
 * already validated by the gate before we get here (EventSource can't set
 * headers, so the client passes ?token=).
 */
function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Disable proxy buffering (nginx) so events flush immediately.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let closed = false;
  let scanning = false;
  let pending = false;

  const push = async () => {
    if (closed) return;
    if (scanning) { pending = true; return; }
    scanning = true;
    try {
      const data = await scanMetrics();
      if (!closed) res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: String(err && err.message || err) })}\n\n`);
    } finally {
      scanning = false;
      if (pending && !closed) { pending = false; push(); }
    }
  };

  // Debounce filesystem events: Claude writes many lines in bursts.
  let debounce = null;
  const onChange = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(push, 400);
  };

  let watcher = null;
  try {
    watcher = fs.watch(projectsDir(), { recursive: true }, onChange);
  } catch {
    // No projects dir / watch unsupported: fall back to interval-only updates.
  }

  // Heartbeat comment keeps the socket warm; also a slow poll as a safety net
  // in case a platform misses fs events.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);
  const safetyPoll = setInterval(push, 5000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (debounce) clearTimeout(debounce);
    clearInterval(heartbeat);
    clearInterval(safetyPoll);
    if (watcher) watcher.close();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);

  // Initial snapshot right away.
  push();
}

// --- security helpers -----------------------------------------------------

function hostAllowed(host) {
  if (!host) return false;
  // host is "127.0.0.1:PORT" or "localhost:PORT"
  const name = host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost';
}

function tokenOk(req, url, token) {
  const fromHeader = req.headers['x-csm-token'];
  const fromQuery = url.searchParams.get('token');
  const provided = (Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) || fromQuery;
  if (!provided) return false;
  // constant-time compare
  const a = Buffer.from(String(provided));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- static + io ----------------------------------------------------------

async function serveStatic(res, pathname, token) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // prevent path traversal
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const filePath = path.join(publicDir, safe);
  if (!filePath.startsWith(publicDir)) {
    return send(res, 403, { error: 'forbidden' });
  }
  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  const ext = path.extname(filePath).toLowerCase();
  // Inject the token into index.html so the page can call the API without the
  // user re-typing it (the token is already in the URL they opened).
  if (ext === '.html') {
    // Placeholder is intentionally distinct from any JS identifier so it can
    // only match the literal injection point, never a variable name.
    data = Buffer.from(
      data.toString('utf8').replaceAll('%%CSM_TOKEN%%', token),
      'utf8',
    );
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export { HOST, DEFAULT_PORT };
