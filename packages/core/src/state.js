import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Persistent UI state (favorites, etc) stored next to the Claude config so it
 * survives across runs. Honors CLAUDE_CONFIG_DIR like paths.js does.
 * @returns {string} absolute path to csm-state.json
 */
export function statePath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
  return path.join(configDir, 'csm-state.json');
}

/**
 * @typedef {Object} CsmState
 * @property {string[]} favorites  session ids pinned by the user
 */

/** @returns {CsmState} */
function emptyState() {
  return { favorites: [] };
}

/**
 * Read persisted state. Never throws — a missing or corrupt file yields the
 * empty default so the app always works.
 * @returns {CsmState}
 */
export function readState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      favorites: Array.isArray(data.favorites) ? data.favorites.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return emptyState();
  }
}

/**
 * Persist state atomically (write temp then rename) so a crash mid-write can't
 * corrupt the file.
 * @param {CsmState} state
 * @returns {Promise<void>}
 */
export async function writeState(state) {
  const file = statePath();
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify({ favorites: state.favorites || [] }, null, 2);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, payload, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Toggle a session id in favorites and persist. Returns the new favorited
 * boolean for that id.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function toggleFavorite(id) {
  const state = readState();
  const set = new Set(state.favorites);
  let favorited;
  if (set.has(id)) {
    set.delete(id);
    favorited = false;
  } else {
    set.add(id);
    favorited = true;
  }
  state.favorites = [...set];
  await writeState(state);
  return favorited;
}

/** @returns {Set<string>} current favorite ids */
export function favoriteSet() {
  return new Set(readState().favorites);
}
