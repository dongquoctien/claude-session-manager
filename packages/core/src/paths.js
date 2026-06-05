import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve the Claude Code config directory (`~/.claude`).
 * Honors the CLAUDE_CONFIG_DIR override that Claude Code itself respects
 * (tests rely on this to point at a temp dir).
 * @returns {string} absolute path (may not exist yet)
 */
export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
}

/**
 * Resolve the Claude Code projects directory (`~/.claude/projects`).
 * Honors the CLAUDE_CONFIG_DIR override that Claude Code itself respects.
 * @returns {string} absolute path (may not exist yet)
 */
export function projectsDir() {
  return path.join(configDir(), 'projects');
}

/**
 * Resolve the Claude Code live-sessions directory (`~/.claude/sessions`).
 * This is where Claude Code records per-process session metadata, including
 * the custom `name` set via the `/rename` slash command (keyed by PID file,
 * NOT by sessionId — see {@link import('./sessionNames.js')}).
 * @returns {string} absolute path (may not exist yet)
 */
export function sessionsDir() {
  return path.join(configDir(), 'sessions');
}

/**
 * Claude Code encodes a project's cwd into the folder name by replacing
 * path separators and ':' with '-'. That encoding is lossy (a literal '-' in a
 * real folder name is indistinguishable from a separator), so we never try to
 * fully decode it — we read the real `cwd` from inside the .jsonl instead.
 *
 * This helper is only a last-resort label for orphan conversations whose folder
 * is gone and which recorded no cwd. We just recover the drive letter and leave
 * the rest as-is, rather than guessing wrong separators (e.g. turning
 * "news-tok" into "news/tok").
 * @param {string} slug folder name under projects/
 * @returns {string}
 */
export function slugToLabel(slug) {
  // "D--Github-news-tok" -> "D:\Github-news-tok" (drive recovered, rest verbatim)
  const m = slug.match(/^([A-Za-z])--(.*)$/);
  if (m) return `${m[1]}:\\${m[2]}`;
  return slug;
}

/** @returns {boolean} whether the projects dir currently exists */
export function projectsDirExists() {
  try {
    return fs.statSync(projectsDir()).isDirectory();
  } catch {
    return false;
  }
}
