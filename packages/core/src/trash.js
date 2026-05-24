import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { projectsDir } from './paths.js';

/**
 * Trash lives next to the Claude config so it's easy to find and survives runs.
 * A deleted session is MOVED here (never rm'd) so it can be restored.
 * Layout: <configDir>/.csm-trash/<timestamp>-<uuid>/
 *           ├─ <uuid>.jsonl
 *           ├─ <uuid>/            (the sibling dir, if it existed)
 *           └─ .csm-meta.json     ({ id, projectSlug, deletedAt, hadDir })
 * @returns {string}
 */
export function trashDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
  return path.join(configDir, '.csm-trash');
}

const UUID_RE = /^[0-9a-fA-F-]{8,}$/; // permissive but blocks path separators/traversal

/** @param {string} id @returns {boolean} */
function looksLikeId(id) {
  return typeof id === 'string' && UUID_RE.test(id) && !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

/**
 * Assert a resolved path stays inside a base dir (anti path-traversal).
 * @param {string} base @param {string} target
 */
function assertInside(base, target) {
  const rb = path.resolve(base);
  const rt = path.resolve(target);
  if (rt !== rb && !rt.startsWith(rb + path.sep)) {
    throw new Error('refusing to operate outside the projects directory');
  }
}

/**
 * Move a session (its .jsonl plus any same-name sibling directory) into the
 * trash. Returns info needed to undo.
 *
 * @param {Object} session  a scanned Session ({ id, projectSlug, file, ... })
 * @returns {Promise<{ id: string, trashPath: string, hadDir: boolean }>}
 */
export async function deleteSession(session) {
  if (!session || !looksLikeId(session.id)) {
    throw new Error('invalid session id');
  }
  const root = projectsDir();
  const projectFolder = path.join(root, session.projectSlug);
  const jsonl = path.join(projectFolder, `${session.id}.jsonl`);
  const sibling = path.join(projectFolder, session.id);

  // Guard: everything must live under the projects dir.
  assertInside(root, jsonl);
  assertInside(root, sibling);

  if (!fs.existsSync(jsonl)) {
    throw new Error(`conversation file not found: ${session.id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bucket = path.join(trashDir(), `${stamp}-${session.id}`);
  await fsp.mkdir(bucket, { recursive: true });

  await moveInto(jsonl, path.join(bucket, `${session.id}.jsonl`));

  let hadDir = false;
  if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) {
    hadDir = true;
    await moveInto(sibling, path.join(bucket, session.id));
  }

  const meta = {
    id: session.id,
    projectSlug: session.projectSlug,
    title: session.title || null,
    deletedAt: Date.now(),
    hadDir,
  };
  await fsp.writeFile(path.join(bucket, '.csm-meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return { id: session.id, trashPath: bucket, hadDir };
}

/**
 * Restore the most recently trashed copy of a session id back to its project.
 * @param {string} id
 * @returns {Promise<{ id: string, restoredTo: string }>}
 */
export async function restoreSession(id) {
  if (!looksLikeId(id)) throw new Error('invalid session id');
  const buckets = await listTrash();
  const match = buckets.filter((b) => b.id === id).sort((a, b) => b.deletedAt - a.deletedAt)[0];
  if (!match) throw new Error(`nothing in trash for ${id}`);

  const root = projectsDir();
  const projectFolder = path.join(root, match.projectSlug);
  await fsp.mkdir(projectFolder, { recursive: true });

  const jsonlSrc = path.join(match.path, `${id}.jsonl`);
  const jsonlDest = path.join(projectFolder, `${id}.jsonl`);
  assertInside(root, jsonlDest);
  if (fs.existsSync(jsonlDest)) throw new Error(`a conversation ${id} already exists; not overwriting`);
  await moveInto(jsonlSrc, jsonlDest);

  if (match.hadDir) {
    const dirSrc = path.join(match.path, id);
    const dirDest = path.join(projectFolder, id);
    assertInside(root, dirDest);
    if (fs.existsSync(dirSrc)) await moveInto(dirSrc, dirDest);
  }

  // Remove the now-empty bucket.
  await fsp.rm(match.path, { recursive: true, force: true });
  return { id, restoredTo: projectFolder };
}

/**
 * @typedef {Object} TrashEntry
 * @property {string} id
 * @property {string} projectSlug
 * @property {string|null} title
 * @property {number} deletedAt
 * @property {boolean} hadDir
 * @property {string} path   absolute path to the trash bucket
 */

/** List trash buckets (newest first). @returns {Promise<TrashEntry[]>} */
export async function listTrash() {
  const dir = trashDir();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const bucket = path.join(dir, name);
    try {
      if (!fs.statSync(bucket).isDirectory()) continue;
      const meta = JSON.parse(await fsp.readFile(path.join(bucket, '.csm-meta.json'), 'utf8'));
      out.push({ ...meta, path: bucket });
    } catch {
      // bucket without valid meta -> skip (still recoverable manually)
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * Permanently remove trash buckets older than N days (0 = empty everything).
 * @param {number} [olderThanDays=0]
 * @returns {Promise<number>} count removed
 */
export async function emptyTrash(olderThanDays = 0) {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  const buckets = await listTrash();
  let removed = 0;
  for (const b of buckets) {
    if (olderThanDays === 0 || b.deletedAt < cutoff) {
      await fsp.rm(b.path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/**
 * Move a file/dir, falling back to copy+remove across filesystems/volumes
 * (rename fails with EXDEV across drives).
 * @param {string} src @param {string} dest
 */
async function moveInto(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.cp(src, dest, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}
