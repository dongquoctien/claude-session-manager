import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  scanSessions,
  searchSessions,
  findSession,
  launch,
  buildLaunch,
} from '@csm/core';
import { publicDir } from '@csm/ui/dir';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4777;

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
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const q = url.searchParams.get('q') || '';
        let sessions = await getSessions();
        if (q.trim()) sessions = searchSessions(sessions, q);
        return send(res, 200, { sessions, count: sessions.length });
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = await readJson(req);
        return handleOpen(res, body, getSessions);
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
  const port = opts.port || DEFAULT_PORT;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
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
  const { match, ambiguous } = findSession(sessions, id);
  if (!match) {
    return send(res, ambiguous.length ? 409 : 404, {
      error: ambiguous.length ? 'ambiguous id' : 'unknown id',
      candidates: ambiguous.map((s) => s.id),
    });
  }
  if (!match.cwd) return send(res, 422, { error: 'session has no cwd' });

  const launchOpts = {
    cwd: match.cwd,
    sessionId: match.id,
    fork: !!(body && body.fork),
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
