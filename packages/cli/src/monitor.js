// Live, no-deps terminal monitor for Claude sessions. Redraws the whole screen
// on an interval from scanMetrics(). Ctrl+C to quit.

import { scanMetrics, projectsDir, projectsDirExists } from '@csm/core';
import {
  c,
  timeAgo,
  humanTokens,
  humanCost,
  humanDuration,
  colorActivity,
  colorCost,
  colorCache,
  colorTokens,
  sgr,
  RESET,
  colorEnabled,
} from './format.js';

const HOME = '\x1b[H';            // move cursor to top-left (no scrollback churn)
const CLEAR_DOWN = '\x1b[0J';     // clear from cursor to end of screen
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_ENTER = '\x1b[?1049h';  // switch to alternate screen buffer (like htop/vim)
const ALT_EXIT = '\x1b[?1049l';   // restore the normal screen, leaving no trace

/** Truncate to width with an ellipsis, accounting for plain text length. */
function clip(s, width) {
  s = s == null ? '' : String(s);
  if (s.length <= width) return s.padEnd(width);
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

/**
 * @param {{ sessions: any[], systemStats: any }} data
 * @param {{ activeOnly: boolean }} opts
 * @returns {string}
 */
// Column widths (the leading dot+space takes 2 cols before PROJECT).
const COLS = { project: 24, activity: 10, tokens: 8, cost: 9, msgs: 5, cache: 5, model: 18 };
// Zebra/active row backgrounds (256-color). Empty = no background.
const BG_ZEBRA = [48, 5, 235];
const BG_ACTIVE = [48, 5, 22]; // dark green tint for the running session

/** Pad a plain string to width (truncate with ellipsis), measuring plain text. */
function cell(s, width, align = 'left') {
  s = s == null ? '' : String(s);
  if (s.length > width) s = s.slice(0, Math.max(0, width - 1)) + '…';
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}

/** Foreground SGR for a row: a 256-color code, no reset (so a row bg survives). */
function fg(code) { return colorEnabled ? `\x1b[38;5;${code}m` : ''; }
const FG_DEFAULT = colorEnabled ? '\x1b[39m' : '';

/**
 * Wrap a row (which contains per-cell full resets) in a background color that
 * stays solid: open the bg, re-open it after every embedded reset, close at
 * the end. Without re-opening, each cell's `\x1b[0m` would punch a hole.
 * @param {string} row @param {number[]} bg  SGR bg codes
 */
function withBg(row, bg) {
  if (!colorEnabled || !bg.length) return row;
  const open = `\x1b[${bg.join(';')}m`;
  // After any reset inside the row, restore the background immediately so the
  // tint stays solid across cells that each end in their own reset.
  const patched = row.split('\x1b[0m').join('\x1b[0m' + open);
  return open + patched + '\x1b[0m';
}

function renderFrame(data, opts) {
  const { sessions, systemStats: st } = data;
  const rows = opts.activeOnly ? sessions.filter((s) => s.active) : sessions;
  const lines = [];

  const now = new Date().toLocaleTimeString();
  lines.push(
    c.bold(c.cyan('Claude Session Monitor')) +
    c.dim(`   ${st.activeSessions} active / ${st.totalSessions} total`) +
    c.dim(`   ${now}`),
  );
  lines.push(
    c.dim('  ') +
    c.dim('Tokens ') + c.bold(humanTokens(st.tokensUsed)) +
    c.dim('   Cost ') + c.bold(humanCost(st.totalCost)) +
    c.dim('   Msgs ') + c.bold(String(st.totalMessages)) +
    c.dim('   Avg ') + c.bold(humanDuration(st.avgDurationMs)) +
    c.dim('   Top ') + c.bold(st.topModel || '—'),
  );
  lines.push('');

  // Column header (aligned to the same widths the rows use).
  lines.push(
    c.dim(
      '  ' +
      cell('PROJECT', COLS.project) + ' ' +
      cell('ACTIVITY', COLS.activity) + ' ' +
      cell('TOKENS', COLS.tokens) + ' ' +
      cell('COST', COLS.cost) + ' ' +
      cell('MSGS', COLS.msgs) + ' ' +
      cell('CACHE', COLS.cache) + ' ' +
      cell('MODEL', COLS.model) + ' AGE',
    ),
  );

  if (rows.length === 0) {
    lines.push('');
    lines.push(c.dim(opts.activeOnly ? '  No active sessions.' : '  No conversations found.'));
    return lines.join('\n');
  }

  rows.slice(0, 40).forEach((s, i) => {
    const project = (s.cwd || s.projectLabel || '').replace(/^.*[\\/]/, '') || s.projectLabel;
    const cacheRate = s.cacheHitRate || 0;
    const cacheTxt = `${Math.round(cacheRate * 100)}%`;
    const model = (s.model || '—').replace(/^claude-/, '');

    // Per-cell colored fragments. For active rows we render on a tinted bg, so
    // we use bare SGR foregrounds (no reset) that fall back to FG_DEFAULT, then
    // wrap the whole row in one bg + trailing reset. Idle rows use normal c.*.
    let body;
    if (s.active) {
      body =
        fg(46) + '● ' +                                            // bright green dot
        FG_DEFAULT + cell(project, COLS.project) + ' ' +
        fg(46) + cell(s.activity, COLS.activity) + ' ' +
        FG_DEFAULT + cell(humanTokens(s.totalTokens), COLS.tokens) + ' ' +
        cell(humanCost(s.costUSD), COLS.cost) + ' ' +
        cell(String(s.messages), COLS.msgs) + ' ' +
        cell(cacheTxt, COLS.cache) + ' ' +
        cell(model, COLS.model) + ' ' +
        cell(timeAgo(s.mtime), 8);
      lines.push(sgr(body, BG_ACTIVE) + RESET);
    } else {
      // Idle: semantic colors per cell (each has its own reset — fine, no bg).
      const row =
        c.dim('○ ') +
        cell(project, COLS.project) + ' ' +
        colorActivity(cell(s.activity, COLS.activity)) + ' ' +
        colorTokens(s.totalTokens, cell(humanTokens(s.totalTokens), COLS.tokens)) + ' ' +
        colorCost(s.costUSD, cell(humanCost(s.costUSD), COLS.cost)) + ' ' +
        cell(String(s.messages), COLS.msgs) + ' ' +
        colorCache(cacheRate, cell(cacheTxt, COLS.cache)) + ' ' +
        c.dim(cell(model, COLS.model)) + ' ' +
        c.dim(cell(timeAgo(s.mtime), 8));
      // Zebra: tint every other idle row's background to guide the eye across.
      // Each c.* cell ends with a full reset (\x1b[0m) which would also clear the
      // row background — so re-open the bg after every reset to keep it solid.
      lines.push(i % 2 === 1 ? withBg(row, BG_ZEBRA) : row);
    }
  });

  if (rows.length > 40) lines.push(c.dim(`  … and ${rows.length - 40} more`));
  lines.push('');
  lines.push(c.dim('  Press Ctrl+C to quit.'));
  return lines.join('\n');
}

/**
 * The "body" of a frame, excluding the volatile clock in the header — used to
 * decide whether anything meaningful changed since the last draw. Without this,
 * the wall-clock ticking every second would force a redraw even when no session
 * data moved.
 */
function frameSignature(data, opts) {
  const rows = opts.activeOnly ? data.sessions.filter((s) => s.active) : data.sessions;
  const st = data.systemStats;
  return JSON.stringify([
    st.activeSessions, st.totalSessions, st.totalMessages, st.tokensUsed, st.totalCost,
    rows.slice(0, 40).map((s) => [s.id, s.activity, s.active, s.totalTokens, s.costUSD, s.messages, s.mtime]),
  ]);
}

/**
 * Run the live monitor.
 * @param {{ intervalMs?: number, activeOnly?: boolean, once?: boolean, json?: boolean }} [opts]
 */
export async function runMonitor(opts = {}) {
  if (!projectsDirExists()) {
    process.stderr.write(c.red(`No Claude projects directory found at:\n  ${projectsDir()}\n`));
    process.exit(1);
  }

  const activeOnly = !!opts.activeOnly;

  // One-shot mode: print a single frame and exit (non-TTY, scripting, tests).
  if (opts.once || !process.stdout.isTTY) {
    const data = await scanMetrics();
    if (opts.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      process.stdout.write(renderFrame(data, { activeOnly }) + '\n');
    }
    return;
  }

  // Data comes from JSONL files that change on the order of seconds, not
  // milliseconds — 2s keeps it "live" without busy-spinning.
  const intervalMs = opts.intervalMs && opts.intervalMs >= 250 ? opts.intervalMs : 2000;
  let stopped = false;
  let timer = null;
  let lastSig = null;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    // Leave the alternate screen so the user's scrollback is exactly as before.
    process.stdout.write(SHOW_CURSOR + ALT_EXIT);
    process.off('SIGINT', cleanup);
  };
  process.on('SIGINT', cleanup);

  // Enter the alternate screen buffer: the whole TUI lives here and vanishes on
  // exit, so we never spam the scrollback with repeated frames.
  process.stdout.write(ALT_ENTER + HIDE_CURSOR);

  // tick() reuses a single in-flight guard so a slow scan never overlaps. It
  // redraws only when the data actually changed (the volatile clock is excluded
  // from the signature), so an idle dashboard sits still instead of flickering.
  let scanning = false;
  const tick = async () => {
    if (scanning || stopped) return;
    scanning = true;
    try {
      const data = await scanMetrics();
      if (stopped) return;
      const sig = frameSignature(data, { activeOnly });
      if (sig === lastSig) return; // nothing changed — don't repaint
      lastSig = sig;
      // HOME then overwrite, then clear anything left below: no full-screen
      // clear (which flashes) and no scrollback growth.
      process.stdout.write(HOME + renderFrame(data, { activeOnly }) + CLEAR_DOWN);
    } catch (err) {
      if (!stopped) process.stdout.write(HOME + c.red(`scan error: ${err.message}`) + CLEAR_DOWN);
    } finally {
      scanning = false;
    }
  };

  await tick();
  timer = setInterval(tick, intervalMs);

  // Keep the process alive until SIGINT.
  await new Promise((resolve) => {
    const check = setInterval(() => { if (stopped) { clearInterval(check); resolve(); } }, 200);
  });
}
