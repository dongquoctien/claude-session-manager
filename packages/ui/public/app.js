const TOKEN = window.CSM_TOKEN;

// --- API client -----------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'x-csm-token': TOKEN,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fetchSessions = (params) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.fav) qs.set('fav', '1');
  if (params.recent) qs.set('recent', String(params.recent));
  if (params.branch) qs.set('branch', params.branch);
  if (params.hideOrphans) qs.set('orphans', '0');
  const s = qs.toString();
  return api(`/api/sessions${s ? `?${s}` : ''}`);
};

// slug pins which copy when the same UUID exists in two project folders
// (a session started in a worktree, then continued in the main repo).
const openSession = (id, { fork, skipPermissions, slug }) =>
  api('/api/open', {
    method: 'POST',
    body: JSON.stringify({ id, fork, skipPermissions, slug }),
  });

const favoriteSession = (id) =>
  api('/api/favorite', { method: 'POST', body: JSON.stringify({ id }) });

const deleteSessionReq = (id, slug) =>
  api('/api/delete', { method: 'POST', body: JSON.stringify({ id, slug }) });

const restoreSessionReq = (id) =>
  api('/api/restore', { method: 'POST', body: JSON.stringify({ id }) });

// --- state ----------------------------------------------------------------

let allRows = []; // flat list of session objects in DOM order (for keyboard nav)
let activeIndex = -1;
let activeFilter = 'all'; // 'all' | 'fav' | 'recent'
let branchesLoaded = false;

const $list = document.getElementById('list');
const $search = document.getElementById('search');
const $fork = document.getElementById('fork');
const $skipperms = document.getElementById('skipperms');
const $refresh = document.getElementById('refresh');
const $toast = document.getElementById('toast');
const $hideOrphans = document.getElementById('hide-orphans');
const $chips = [...document.querySelectorAll('.chip[data-filter]')];

// --- custom dropdown (replaces native <select> for a themed option list) ---

/**
 * A small accessible dropdown built on a button + <ul role=listbox>. Exposes a
 * select-like surface: `.value` (get/set), `.setOptions([{value,label}])`, and
 * `.onChange(fn)`. Closes on outside click / Escape; supports arrow keys.
 * @param {string} rootId
 */
function createDropdown(rootId) {
  const root = document.getElementById(rootId);
  const trigger = root.querySelector('.dropdown-trigger');
  const label = root.querySelector('.dropdown-label');
  const menu = root.querySelector('.dropdown-menu');
  let options = [];
  let value = '';
  let changeFn = null;
  let activeIdx = -1;

  function labelFor(v) {
    const o = options.find((x) => x.value === v);
    return o ? o.label : (options[0] ? options[0].label : '');
  }

  function open() {
    if (!menu.hidden) return;
    buildMenu();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    activeIdx = Math.max(0, options.findIndex((o) => o.value === value));
    highlight(activeIdx);
    document.addEventListener('click', onOutside, true);
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
  }
  function onOutside(e) { if (!root.contains(e.target)) close(); }

  function buildMenu() {
    menu.replaceChildren(...options.map((o, i) => {
      const li = el('li', 'dropdown-option' + (o.value === value ? ' selected' : ''));
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(o.value === value));
      li.dataset.idx = String(i);
      const check = icon('check', 'dropdown-check');
      li.appendChild(check);
      li.appendChild(el('span', null, o.label));
      li.addEventListener('click', () => { pick(o.value); close(); });
      li.addEventListener('mousemove', () => highlight(i));
      return li;
    }));
  }
  function highlight(i) {
    activeIdx = i;
    [...menu.children].forEach((li, idx) => li.classList.toggle('active', idx === i));
    const cur = menu.children[i];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function pick(v) {
    if (v === value) return;
    value = v;
    label.textContent = labelFor(v);
    if (changeFn) changeFn(v);
  }

  trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (menu.hidden) open(); else if (activeIdx >= 0) { pick(options[activeIdx].value); close(); }
    } else if (e.key === 'ArrowUp') { e.preventDefault(); if (menu.hidden) open(); }
    else if (e.key === 'Escape') close();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(activeIdx + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(options[activeIdx].value); close(); trigger.focus(); }
    else if (e.key === 'Escape') { close(); trigger.focus(); }
  });

  return {
    get value() { return value; },
    set value(v) { value = v; label.textContent = labelFor(v); },
    setOptions(items) {
      options = items;
      if (!options.some((o) => o.value === value)) value = options[0] ? options[0].value : '';
      label.textContent = labelFor(value);
      if (!menu.hidden) buildMenu();
    },
    onChange(fn) { changeFn = fn; },
  };
}

const $branchFilter = createDropdown('branch-dd');
$branchFilter.setOptions([{ value: '', label: 'All branches' }]);

// --- confirm modal (replaces window.confirm) ------------------------------

const $modalOverlay = document.getElementById('modal-overlay');
const $modalTitle = document.getElementById('modal-conv-title');
const $modalPath = document.getElementById('modal-conv-path');
const $modalConfirm = document.getElementById('modal-confirm');
const $modalCancel = document.getElementById('modal-cancel');

/**
 * Show the themed confirm dialog. Resolves true if confirmed, false otherwise.
 * @param {{ title: string, path: string }} info
 * @returns {Promise<boolean>}
 */
function confirmModal({ title, path }) {
  return new Promise((resolve) => {
    $modalTitle.textContent = title;
    $modalPath.textContent = path;
    $modalOverlay.hidden = false;
    $modalConfirm.focus();

    const cleanup = () => {
      $modalOverlay.hidden = true;
      $modalConfirm.removeEventListener('click', onConfirm);
      $modalCancel.removeEventListener('click', onCancel);
      $modalOverlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const done = (val) => { cleanup(); resolve(val); };
    const onConfirm = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === $modalOverlay) done(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };

    $modalConfirm.addEventListener('click', onConfirm);
    $modalCancel.addEventListener('click', onCancel);
    $modalOverlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// --- rendering ------------------------------------------------------------

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function groupByProject(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.projectLabel;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.entries()].sort(
    (a, b) => Math.max(...b[1].map((s) => s.mtime)) - Math.max(...a[1].map((s) => s.mtime)),
  );
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Build an <svg><use href="#i-name"/></svg> referencing the inline sprite. */
function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  use.setAttributeNS(XLINK_NS, 'xlink:href', `#i-${name}`); // older WebKit
  svg.appendChild(use);
  return svg;
}

function render(sessions) {
  $list.innerHTML = '';
  allRows = [];
  activeIndex = -1;

  if (sessions.length === 0) {
    $list.appendChild(el('div', 'empty', 'No conversations found.'));
    return;
  }

  for (const [label, items] of groupByProject(sessions)) {
    const group = el('section', 'group');
    const head = el('div', 'group-head');
    head.appendChild(icon('folder', 'folder-icon'));
    head.appendChild(el('span', 'group-label', label));
    if (items[0] && !items[0].cwdExists) {
      const badge = el('span', 'badge missing');
      badge.appendChild(icon('alert'));
      badge.appendChild(el('span', null, 'missing'));
      head.appendChild(badge);
    }
    head.appendChild(el('span', 'group-count', String(items.length)));
    group.appendChild(head);

    for (const s of items) {
      // role=button (not a real <button>) so we can nest the star <button>.
      const row = el('div', 'row');
      row.dataset.id = s.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      // Star toggle (favorite)
      const star = el('button', 'row-star' + (s.favorite ? ' on' : ''));
      star.setAttribute('aria-label', s.favorite ? 'Unfavorite' : 'Favorite');
      star.appendChild(icon(s.favorite ? 'star-filled' : 'star'));
      star.addEventListener('click', (e) => {
        e.stopPropagation(); // don't trigger row open
        doFavorite(s, star);
      });
      row.appendChild(star);

      const main = el('div', 'row-main');
      main.appendChild(el('div', 'row-title', s.title));
      const meta = el('div', 'row-meta');
      if (s.branch) {
        const branch = el('span', 'branch');
        branch.appendChild(icon('git-branch'));
        branch.appendChild(el('span', null, s.branch));
        meta.appendChild(branch);
      }
      meta.appendChild(el('span', 'when', timeAgo(s.mtime)));
      meta.appendChild(el('span', 'id', s.id.slice(0, 8)));
      if (s.titleSource !== 'aiTitle') {
        meta.appendChild(el('span', 'src', s.titleSource));
      }
      main.appendChild(meta);
      // Preview of the last prompt, if any and not already the title.
      if (s.lastPrompt && s.lastPrompt !== s.title) {
        main.appendChild(el('div', 'row-preview', s.lastPrompt));
      }
      row.appendChild(main);

      const open = el('span', 'row-open');
      open.appendChild(el('span', null, 'Open'));
      open.appendChild(icon('play'));
      row.appendChild(open);

      // Trash button — last, separated from Open by a divider so it's not
      // mistaken for the primary action.
      const del = el('button', 'row-del');
      del.setAttribute('aria-label', 'Move to trash');
      del.setAttribute('title', 'Move to trash');
      del.appendChild(icon('trash'));
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        doDelete(s, row);
      });
      row.appendChild(del);

      row.addEventListener('click', () => doOpen(s));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doOpen(s); }
      });
      group.appendChild(row);
      allRows.push({ node: row, session: s });
    }
    $list.appendChild(group);
  }
}

// --- actions --------------------------------------------------------------

let toastTimer;
/**
 * Show a toast. Optional action = { label, fn } renders a button (e.g. Undo)
 * and keeps the toast up longer.
 */
function toast(msg, kind = 'ok', action = null) {
  clearTimeout(toastTimer);
  $toast.replaceChildren();
  $toast.appendChild(el('span', null, msg));
  if (action) {
    const btn = el('button', 'toast-action', action.label);
    btn.addEventListener('click', () => {
      $toast.className = 'toast';
      action.fn();
    });
    $toast.appendChild(btn);
  }
  $toast.className = `toast show ${kind}`;
  toastTimer = setTimeout(() => {
    $toast.className = 'toast';
  }, action ? 6000 : 3500);
}

async function doOpen(s) {
  if (!s.cwdExists) {
    toast(`Folder missing — Claude may fail to resume:\n${s.cwd}`, 'warn');
  }
  try {
    const r = await openSession(s.id, {
      fork: $fork.checked,
      skipPermissions: $skipperms.checked,
      slug: s.projectSlug,
    });
    toast(`Opening “${r.title || s.title}” via ${r.terminal}`, 'ok');
  } catch (err) {
    toast(`Failed to open: ${err.message}`, 'err');
  }
}

async function doFavorite(s, starEl) {
  try {
    const r = await favoriteSession(s.id);
    s.favorite = r.favorited;
    starEl.classList.toggle('on', r.favorited);
    starEl.replaceChildren(icon(r.favorited ? 'star-filled' : 'star'));
    starEl.setAttribute('aria-label', r.favorited ? 'Unfavorite' : 'Favorite');
    // If we're viewing the favorites filter, a removal should drop the row.
    if (activeFilter === 'fav' && !r.favorited) refresh();
  } catch (err) {
    toast(`Failed to update favorite: ${err.message}`, 'err');
  }
}

async function doDelete(s, rowEl) {
  const ok = await confirmModal({ title: s.title, path: s.cwd || s.projectLabel });
  if (!ok) return;
  try {
    await deleteSessionReq(s.id, s.projectSlug);
    rowEl.remove(); // immediate visual feedback
    toast(`Moved “${s.title}” to trash`, 'warn', {
      label: 'Undo',
      fn: async () => {
        try {
          await restoreSessionReq(s.id);
          toast(`Restored “${s.title}”`, 'ok');
          refresh();
        } catch (err) {
          toast(`Undo failed: ${err.message}`, 'err');
        }
      },
    });
  } catch (err) {
    toast(`Failed to delete: ${err.message}`, 'err');
  }
}

/** Current filter params derived from chips + controls. */
function currentParams() {
  return {
    q: $search.value,
    fav: activeFilter === 'fav',
    recent: activeFilter === 'recent' ? 7 : undefined,
    branch: $branchFilter.value || undefined,
    hideOrphans: $hideOrphans.checked,
  };
}

let searchTimer;
async function refresh() {
  try {
    const data = await fetchSessions(currentParams());
    if (!branchesLoaded && Array.isArray(data.branches)) {
      populateBranches(data.branches);
      branchesLoaded = true;
    }
    render(data.sessions);
  } catch (err) {
    $list.innerHTML = '';
    $list.appendChild(el('div', 'empty err', `Error: ${err.message}`));
  }
}

function populateBranches(branches) {
  const cur = $branchFilter.value;
  $branchFilter.setOptions([
    { value: '', label: 'All branches' },
    ...branches.map((b) => ({ value: b, label: b })),
  ]);
  $branchFilter.value = cur;
}

// --- keyboard nav ---------------------------------------------------------

function setActive(i) {
  if (activeIndex >= 0 && allRows[activeIndex]) {
    allRows[activeIndex].node.classList.remove('active');
  }
  activeIndex = Math.max(0, Math.min(i, allRows.length - 1));
  const cur = allRows[activeIndex];
  if (cur) {
    cur.node.classList.add('active');
    cur.node.scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $search) {
    e.preventDefault();
    $search.focus();
    $search.select();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(activeIndex + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(activeIndex - 1);
  } else if (e.key === 'Enter' && activeIndex >= 0 && allRows[activeIndex]) {
    e.preventDefault();
    doOpen(allRows[activeIndex].session);
  } else if (e.key === 'Escape') {
    $search.value = '';
    refresh();
  }
});

$search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 120);
});
$refresh.addEventListener('click', refresh);

// --- filter bar -----------------------------------------------------------

for (const chip of $chips) {
  chip.addEventListener('click', () => {
    activeFilter = chip.dataset.filter;
    for (const c of $chips) c.setAttribute('aria-pressed', String(c === chip));
    refresh();
  });
}
$branchFilter.onChange(refresh);
$hideOrphans.addEventListener('change', refresh);

// --- monitor view ---------------------------------------------------------

const fmt = {
  tokens(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(1) + 'K';
    if (n < 1e9) return (n / 1e6).toFixed(1) + 'M';
    return (n / 1e9).toFixed(1) + 'B';
  },
  cost(n) { return '$' + n.toFixed(2); },
  int(n) { return n.toLocaleString(); },
  duration(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  },
};

const ACTIVITY_LABELS = {
  idle: 'idle', waiting: 'waiting', thinking: 'thinking', reading: 'reading',
  writing: 'writing', running: 'running', searching: 'searching',
  browsing: 'browsing', spawning: 'spawning',
};

const Monitor = (() => {
  let es = null;            // EventSource
  let latest = [];          // last sessions array
  let selectedId = null;    // pinned session id
  let chart = null;         // uPlot instance
  let started = false;
  let firstLoaded = false;  // true once the first SSE snapshot has rendered

  const $sidebar = document.getElementById('mon-session-list');
  const $sysstats = document.getElementById('mon-sysstats-grid');
  const $title = document.getElementById('mon-title');
  const $subtitle = document.getElementById('mon-subtitle');
  const $stats = document.getElementById('mon-stats');
  const $chartBox = document.getElementById('mon-chart');
  const $activity = document.getElementById('mon-activity');
  const $files = document.getElementById('mon-files');
  const $filesTitle = document.getElementById('mon-files-title');
  const $livePill = document.getElementById('live-pill');
  const $liveText = document.getElementById('live-text');

  function setLive(state) {
    $livePill.className = 'live-pill ' + state; // connected | connecting | offline
    $liveText.textContent = state;
  }

  function start() {
    if (started) return;
    started = true;
    renderLoading(); // first snapshot can take a few seconds — show skeletons
    connect();
  }

  function connect() {
    setLive('connecting');
    es = new EventSource(`/api/stream?token=${encodeURIComponent(TOKEN)}`);
    es.addEventListener('snapshot', (e) => {
      setLive('connected');
      try {
        const data = JSON.parse(e.data);
        latest = data.sessions || [];
        firstLoaded = true;
        renderSidebar(latest);
        renderSysStats(data.systemStats);
        if (!selectedId && latest.length) selectedId = latest[0].id;
        renderDetail(currentSession());
      } catch { /* ignore malformed frame */ }
    });
    es.addEventListener('error', () => {
      setLive('offline');
      // EventSource auto-reconnects; reflect connecting state on retry.
      setTimeout(() => { if (es && es.readyState === 0) setLive('connecting'); }, 500);
    });
  }

  // Skeleton placeholders shown until the first SSE snapshot arrives.
  function renderLoading() {
    if (firstLoaded) return;
    $sidebar.replaceChildren(...Array.from({ length: 6 }, () => {
      const card = el('div', 'mon-card skeleton-card');
      card.appendChild(el('div', 'sk sk-line sk-w60'));
      card.appendChild(el('div', 'sk sk-line sk-w40'));
      card.appendChild(el('div', 'sk sk-line sk-w80'));
      return card;
    }));
    $sysstats.replaceChildren(...Array.from({ length: 7 }, () => {
      const row = el('div', 'sk sk-line');
      return row;
    }));
    $title.textContent = 'Loading sessions…';
    $subtitle.textContent = '';
    $stats.replaceChildren(...Array.from({ length: 6 }, () => {
      const card = el('div', 'stat skeleton-card');
      card.appendChild(el('div', 'sk sk-line sk-w50'));
      card.appendChild(el('div', 'sk sk-line sk-w70 sk-tall'));
      return card;
    }));
    $chartBox.replaceChildren(el('div', 'sk sk-block'));
    $activity.replaceChildren(...Array.from({ length: 3 }, () => {
      const row = el('div', 'mon-act-row');
      row.appendChild(el('div', 'sk sk-line sk-w30'));
      row.appendChild(el('div', 'sk sk-line sk-w90'));
      return row;
    }));
    $files.replaceChildren(...Array.from({ length: 4 }, () => el('div', 'sk sk-line sk-file')));
    $filesTitle.textContent = 'Modified Files';
  }

  function currentSession() {
    return latest.find((s) => s.id === selectedId) || latest[0] || null;
  }

  function activityBadge(s) {
    const span = el('span', 'mon-badge ' + (s.active ? 'active' : 'done'));
    span.textContent = s.active ? (ACTIVITY_LABELS[s.activity] || s.activity) : 'Complete';
    return span;
  }

  function renderSidebar(sessions) {
    $sidebar.replaceChildren();
    for (const s of sessions.slice(0, 60)) {
      const card = el('div', 'mon-card' + (s.id === selectedId ? ' selected' : '') + (s.active ? ' is-active' : ''));
      card.dataset.id = s.id;

      const top = el('div', 'mon-card-top');
      top.appendChild(el('span', 'mon-card-name', shortName(s)));
      top.appendChild(activityBadge(s));
      card.appendChild(top);

      const mid = el('div', 'mon-card-mid');
      mid.appendChild(el('span', 'mon-card-model', (s.model || '—').replace(/^claude-/, '')));
      mid.appendChild(el('span', 'mon-card-when', timeAgo(s.mtime)));
      card.appendChild(mid);

      const bot = el('div', 'mon-card-bot');
      bot.appendChild(el('span', null, `${fmt.int(s.messages)} msgs`));
      bot.appendChild(el('span', 'mon-card-tokens', `${fmt.int(s.totalTokens)} tokens`));
      card.appendChild(bot);

      card.addEventListener('click', () => {
        selectedId = s.id;
        renderSidebar(latest);
        renderDetail(currentSession());
      });
      $sidebar.appendChild(card);
    }
  }

  function shortName(s) {
    if (s.cwd) return s.cwd.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || s.projectLabel;
    return s.projectLabel;
  }

  function statCard(label, value, sub, iconName, title) {
    const card = el('div', 'stat');
    if (title) card.title = title;
    const head = el('div', 'stat-head');
    head.appendChild(el('span', 'stat-label', label));
    head.appendChild(icon(iconName, 'stat-icon'));
    card.appendChild(head);
    card.appendChild(el('div', 'stat-value', value));
    if (sub) card.appendChild(el('div', 'stat-sub', sub));
    return card;
  }

  function renderDetail(s) {
    if (!s) {
      $title.textContent = 'No sessions';
      $subtitle.textContent = '';
      $stats.replaceChildren();
      $activity.replaceChildren();
      $files.replaceChildren();
      return;
    }
    $title.textContent = shortName(s);
    $subtitle.textContent = (s.cwd || s.projectLabel) + (s.branch ? `  ·  ${s.branch}` : '');

    const io = `${fmt.tokens(s.tokens.input)}/${fmt.tokens(s.tokens.output)}`;
    const cacheTok = s.tokens.cacheCreation + s.tokens.cacheRead;
    $stats.replaceChildren(
      statCard('Total Tokens', fmt.tokens(s.totalTokens), `${fmt.int(s.messages)} messages`, 'zap'),
      statCard('Session Cost (est.)', fmt.cost(s.costUSD), (s.model || '').replace(/^claude-/, ''), 'coins',
        'Estimated from token usage and public list prices — not an exact bill.'),
      statCard('Cache Tokens', fmt.tokens(cacheTok), `${(s.cacheHitRate * 100).toFixed(1)}% cache hit`, 'database'),
      statCard('Input/Output', io, 'In/Out ratio', 'activity'),
      statCard('Files Modified', String(s.modifiedFiles.length), 'Changed files', 'file'),
      statCard('Session Time', fmt.duration(s.durationMs), s.active ? 'Currently active' : 'Ended', 'clock'),
    );

    renderChart(s);
    renderActivity(s);
    renderFiles(s);
  }

  function renderActivity(s) {
    $activity.replaceChildren();
    const msgs = (s.recentMessages || []).slice().reverse();
    if (!msgs.length) { $activity.appendChild(el('div', 'empty', 'No recent messages.')); return; }
    for (const m of msgs) {
      const row = el('div', 'mon-act-row');
      const head = el('div', 'mon-act-head');
      head.appendChild(el('span', 'mon-act-role ' + m.role, m.role === 'user' ? 'You' : 'Assistant'));
      if (m.ts) head.appendChild(el('span', 'mon-act-when', timeAgo(m.ts)));
      row.appendChild(head);
      row.appendChild(el('div', 'mon-act-text', m.text));
      $activity.appendChild(row);
    }
  }

  function renderFiles(s) {
    $filesTitle.textContent = `Modified Files (${s.modifiedFiles.length})`;
    $files.replaceChildren();
    if (!s.modifiedFiles.length) { $files.appendChild(el('div', 'empty', 'No files modified.')); return; }
    for (const f of s.modifiedFiles.slice(-30).reverse()) {
      $files.appendChild(el('div', 'mon-file', f));
    }
  }

  // Bucket entry timestamps into a per-session token-usage-over-time bar chart.
  // We don't have per-entry token deltas in the snapshot, so the chart shows
  // message volume per time bucket (a faithful "activity" proxy that matches
  // the mockup's bar shape). Full per-bucket tokens can come from /api/session.
  function renderChart(s) {
    if (typeof uPlot === 'undefined') {
      $chartBox.textContent = 'chart unavailable (uPlot not loaded)';
      return;
    }
    // We only have recentMessages timestamps in the stream snapshot; bucket them.
    const ts = (s.recentMessages || []).map((m) => m.ts).filter(Boolean).sort((a, b) => a - b);
    if (ts.length < 2) {
      $chartBox.replaceChildren(el('div', 'empty', 'Not enough data to chart yet.'));
      if (chart) { chart.destroy(); chart = null; }
      return;
    }
    const buckets = 24;
    const min = ts[0], max = ts[ts.length - 1];
    const span = Math.max(1, max - min);
    const xs = [], ys = new Array(buckets).fill(0);
    for (let i = 0; i < buckets; i++) xs.push(min + (span * i) / buckets);
    for (const t of ts) {
      let idx = Math.floor(((t - min) / span) * buckets);
      if (idx >= buckets) idx = buckets - 1;
      ys[idx] += 1;
    }
    drawBars(xs.map((x) => x / 1000), ys);
  }

  function drawBars(xSec, ys) {
    const w = $chartBox.clientWidth || 800;
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--accent') || '#d97757').trim();
    const dim = (css.getPropertyValue('--text-dim') || '#9a9286').trim();
    const grid = hexToRgba((css.getPropertyValue('--border') || '#3a342b').trim(), 0.6);
    const opts = {
      width: w, height: 240,
      cursor: { show: true },
      scales: { x: { time: true } },
      axes: [
        { stroke: dim, grid: { stroke: grid } },
        { stroke: dim, grid: { stroke: grid } },
      ],
      series: [
        {},
        {
          label: 'messages',
          stroke: accent,
          fill: hexToRgba(accent, 0.35),
          paths: uPlot.paths.bars({ size: [0.7, 40] }),
          points: { show: false },
        },
      ],
    };
    if (chart) chart.destroy();
    $chartBox.replaceChildren(); // clear any skeleton/placeholder before drawing
    chart = new uPlot(opts, [xSec, ys], $chartBox);
  }

  function hexToRgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  function renderSysStats(st) {
    if (!st) return;
    const estTitle = 'Estimated from token usage and public list prices — not an exact bill.';
    const rows = [
      ['Active Sessions', String(st.activeSessions)],
      ['Total Sessions', String(st.totalSessions)],
      ['Total Messages', fmt.int(st.totalMessages)],
      ['Tokens Used', fmt.tokens(st.tokensUsed)],
      ['Total Cost (est.)', fmt.cost(st.totalCost), estTitle],
      ['Avg Duration', fmt.duration(st.avgDurationMs)],
      ['Top Model', (st.topModel || '—').replace(/^claude-/, '')],
    ];
    $sysstats.replaceChildren();
    for (const [k, v, title] of rows) {
      const dt = el('dt', null, k);
      const dd = el('dd', null, v);
      if (title) { dt.title = title; dd.title = title; }
      $sysstats.appendChild(dt);
      $sysstats.appendChild(dd);
    }
  }

  function onResize() { const s = currentSession(); if (s && started) renderChart(s); }
  window.addEventListener('resize', onResize);

  // Re-render the chart so it picks up new CSS colors (e.g. after a theme switch).
  function redraw() { const s = currentSession(); if (s && started) renderChart(s); }

  return { start, redraw };
})();

// --- keep --topbar-h in sync (header wraps to 2 rows when narrow) ---------

const $topbar = document.querySelector('.topbar');
function syncTopbarHeight() {
  const h = Math.round($topbar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--topbar-h', h + 'px');
}
if (window.ResizeObserver) {
  new ResizeObserver(syncTopbarHeight).observe($topbar);
} else {
  window.addEventListener('resize', syncTopbarHeight);
}
syncTopbarHeight();

// --- theme toggle ---------------------------------------------------------

const $themeToggle = document.getElementById('theme-toggle');
$themeToggle.addEventListener('click', () => {
  const root = document.documentElement;
  const light = root.getAttribute('data-theme') === 'light';
  if (light) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', 'light');
  try { localStorage.setItem('csm-theme', light ? 'dark' : 'light'); } catch (e) {}
  // The chart paints to a canvas, so CSS vars don't restyle it — redraw it.
  Monitor.redraw();
});

// --- tab switching --------------------------------------------------------

const $tabs = [...document.querySelectorAll('.tab')];
const $views = {
  sessions: document.getElementById('view-sessions'),
  monitor: document.getElementById('view-monitor'),
};

function switchTab(name) {
  for (const t of $tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const [k, v] of Object.entries($views)) v.hidden = k !== name;
  if (name === 'monitor') Monitor.start();
}

for (const t of $tabs) t.addEventListener('click', () => switchTab(t.dataset.tab));

// --- boot -----------------------------------------------------------------

refresh();
// Light auto-refresh so new conversations show up without a manual reload.
// Only the Sessions view polls; the Monitor view is driven by its SSE stream.
setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    document.activeElement !== $search &&
    !$views.sessions.hidden
  ) {
    refresh();
  }
}, 15000);
