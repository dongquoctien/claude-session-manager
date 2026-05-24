import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve the Claude Code projects directory (`~/.claude/projects`).
 * Honors the CLAUDE_CONFIG_DIR override that Claude Code itself respects.
 * @returns {string} absolute path (may not exist yet)
 */
export function projectsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

/**
 * Claude Code encodes a project's cwd into the folder name by replacing
 * path separators and ':' with '-'. That encoding is lossy, so we never
 * decode it back to a path — we read the real `cwd` from inside the .jsonl
 * instead. This helper is only a human-readable fallback label.
 * @param {string} slug folder name under projects/
 * @returns {string}
 */
export function slugToLabel(slug) {
  // e.g. "D--Github-news-tok" -> "D:/Github/news-tok"-ish, best-effort only.
  return slug.replace(/^([A-Za-z])--/, '$1:/').replace(/-/g, '/');
}

/** @returns {boolean} whether the projects dir currently exists */
export function projectsDirExists() {
  try {
    return fs.statSync(projectsDir()).isDirectory();
  } catch {
    return false;
  }
}
