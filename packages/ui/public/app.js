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

// items: [{ id, slug }] — slug pins the right copy of a duplicated UUID.
const deleteBulkReq = (items) =>
  api('/api/delete-bulk', { method: 'POST', body: JSON.stringify({ items }) });

const restoreBulkReq = (ids) =>
  api('/api/restore-bulk', { method: 'POST', body: JSON.stringify({ ids }) });

// One enriched session incl. tokenBuckets (tokens-over-time) for the chart.
const fetchSession = (id, slug) => {
  const qs = new URLSearchParams({ id });
  if (slug) qs.set('slug', slug);
  return api(`/api/session?${qs.toString()}`);
};

// --- state ----------------------------------------------------------------

let allRows = []; // flat list of session objects in DOM order (for keyboard nav)
let activeIndex = -1;
let activeFilter = 'all'; // 'all' | 'fav' | 'recent'
let branchesLoaded = false;

// Multi-select for bulk delete. Keyed by id|projectSlug so two recordings of
// the same UUID (worktree duplicates) are tracked separately.
const selected = new Map(); // selKey -> session
let lastCheckedIndex = -1;  // anchor for shift-click range selection
const selKey = (s) => `${s.id}|${s.projectSlug}`;

const $list = document.getElementById('list');
const $search = document.getElementById('search');
const $fork = document.getElementById('fork');
const $skipperms = document.getElementById('skipperms');
const $refresh = document.getElementById('refresh');
const $toast = document.getElementById('toast');
const $hideOrphans = document.getElementById('hide-orphans');
const $chips = [...document.querySelectorAll('.chip[data-filter]')];
const $selBar = document.getElementById('selection-bar');
const $selCount = document.getElementById('selection-count');
const $selClear = document.getElementById('selection-clear');
const $selDelete = document.getElementById('selection-delete');
const $selToggle = document.getElementById('select-toggle');
let selectMode = false; // checkboxes only render/show when this is on

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

    // Select-all checkbox for this group.
    const groupCheck = el('input', 'group-check');
    groupCheck.type = 'checkbox';
    groupCheck.setAttribute('aria-label', `Select all in ${label}`);
    const groupRows = []; // {checkbox, session} filled as rows render
    groupCheck.addEventListener('change', () => {
      for (const gr of groupRows) {
        if (gr.checkbox.checked !== groupCheck.checked) {
          gr.checkbox.checked = groupCheck.checked;
          setSelected(gr.session, gr.checkbox.checked);
        }
      }
      groupCheck.indeterminate = false;
      updateSelectionBar();
    });
    head.appendChild(groupCheck);

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
    const syncGroupCheck = () => {
      const n = groupRows.filter((gr) => gr.checkbox.checked).length;
      groupCheck.checked = n === groupRows.length && n > 0;
      groupCheck.indeterminate = n > 0 && n < groupRows.length;
    };

    for (const s of items) {
      const rowIndex = allRows.length; // flat index for shift-click ranges
      // role=button (not a real <button>) so we can nest the star <button>.
      const row = el('div', 'row');
      row.dataset.id = s.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      // Selection checkbox (bulk delete). Restores checked state on re-render.
      const check = el('input', 'row-check');
      check.type = 'checkbox';
      check.setAttribute('aria-label', `Select ${s.title}`);
      check.checked = selected.has(selKey(s));
      if (check.checked) row.classList.add('selected');
      check.addEventListener('click', (e) => {
        e.stopPropagation(); // don't trigger row open
        if (e.shiftKey && lastCheckedIndex >= 0) {
          selectRange(lastCheckedIndex, rowIndex, check.checked);
        }
        setSelected(s, check.checked);
        row.classList.toggle('selected', check.checked);
        lastCheckedIndex = rowIndex;
        syncGroupCheck();
        updateSelectionBar();
      });
      row.appendChild(check);
      groupRows.push({ checkbox: check, session: s, row });

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
      allRows.push({ node: row, session: s, checkbox: check, syncGroupCheck });
    }
    syncGroupCheck();
    $list.appendChild(group);
  }
  updateSelectionBar();
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

// --- multi-select / bulk delete -------------------------------------------

/** Add/remove a session from the selection set. */
function setSelected(s, on) {
  if (on) selected.set(selKey(s), s);
  else selected.delete(selKey(s));
}

/** Select (or deselect) every row between two flat indices, inclusive. */
function selectRange(from, to, on) {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) {
    const r = allRows[i];
    if (!r) continue;
    r.checkbox.checked = on;
    r.node.classList.toggle('selected', on);
    setSelected(r.session, on);
    r.syncGroupCheck();
  }
}

/** Show/hide the selection bar and refresh its count. */
function updateSelectionBar() {
  const n = selected.size;
  $selBar.hidden = !selectMode || n === 0;
  $selCount.textContent = `${n} selected`;
}

/** Clear the selection and uncheck every visible row. */
function clearSelection() {
  selected.clear();
  lastCheckedIndex = -1;
  for (const r of allRows) {
    r.checkbox.checked = false;
    r.checkbox.indeterminate = false;
    r.node.classList.remove('selected');
    r.syncGroupCheck();
  }
  updateSelectionBar();
}

async function doDeleteBulk() {
  const sessions = [...selected.values()];
  if (sessions.length === 0) return;
  const ok = await confirmModal({
    title: `Move ${sessions.length} conversation${sessions.length > 1 ? 's' : ''} to trash?`,
    path: sessions.length === 1 ? (sessions[0].cwd || sessions[0].projectLabel) : 'Multiple folders',
  });
  if (!ok) return;

  const items = sessions.map((s) => ({ id: s.id, slug: s.projectSlug }));
  const ids = sessions.map((s) => s.id);
  try {
    const r = await deleteBulkReq(items);
    // Remove the deleted rows from the DOM immediately.
    const okKeys = new Set(
      r.results.filter((x) => x.ok).map((x) => x.id),
    );
    for (const row of allRows) {
      if (okKeys.has(row.session.id) && selected.has(selKey(row.session))) {
        row.node.remove();
      }
    }
    clearSelection();
    const msg = r.failed > 0
      ? `Moved ${r.deleted} to trash · ${r.failed} failed`
      : `Moved ${r.deleted} to trash`;
    toast(msg, r.failed > 0 ? 'warn' : 'warn', {
      label: 'Undo',
      fn: async () => {
        try {
          await restoreBulkReq(ids);
          toast(`Restored ${ids.length}`, 'ok');
          refresh();
        } catch (err) {
          toast(`Undo failed: ${err.message}`, 'err');
        }
      },
    });
  } catch (err) {
    toast(`Bulk delete failed: ${err.message}`, 'err');
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
    if (selected.size > 0) {
      clearSelection(); // first Escape drops the selection
    } else if (selectMode) {
      setSelectMode(false); // next Escape leaves select mode
    } else {
      $search.value = '';
      refresh();
    }
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

// --- selection bar --------------------------------------------------------

/** Enter/leave multi-select mode. Leaving clears any current selection. */
function setSelectMode(on) {
  selectMode = on;
  if ($selToggle.checked !== on) $selToggle.checked = on;
  $list.classList.toggle('select-mode', on);
  if (!on) clearSelection();
  updateSelectionBar();
}

$selToggle.addEventListener('change', () => setSelectMode($selToggle.checked));
$selClear.addEventListener('click', clearSelection);
$selDelete.addEventListener('click', doDeleteBulk);

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
  // Token-over-time buckets per session id, fetched lazily from /api/session.
  // Value: { buckets:{ts,tokens}, atTokens:number } — refetch when totalTokens grows.
  const tokenChartCache = new Map();

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
  const $modelChart = document.getElementById('mon-model-chart');
  const $modelLegend = document.getElementById('mon-model-legend');

  // --- sidebar filter/sort state (client-side; survives SSE refresh) ---
  const $monSearch = document.getElementById('mon-search');
  const $monActive = document.getElementById('mon-active-toggle');
  let filterText = '';
  let filterActive = false;
  let sortKey = 'recent';   // 'recent' | 'tokens' | 'cost'
  let filterModel = '';     // '' = all models
  let modelOptionsKey = ''; // tracks which model set the dropdown was built from

  const $sortDD = createDropdown('mon-sort-dd');
  $sortDD.setOptions([
    { value: 'recent', label: 'Recent' },
    { value: 'tokens', label: 'Most tokens' },
    { value: 'cost', label: 'Highest cost' },
  ]);
  $sortDD.onChange((v) => { sortKey = v; renderSidebar(); });

  const $modelDD = createDropdown('mon-model-dd');
  $modelDD.setOptions([{ value: '', label: 'All models' }]);
  $modelDD.onChange((v) => { filterModel = v; renderSidebar(); });

  function setLive(state) {
    $livePill.className = 'live-pill ' + state; // connected | connecting | offline
    $liveText.textContent = state;
  }

  /** Rebuild the model dropdown when the set of models in `latest` changes,
   *  preserving the current selection. */
  function syncModelOptions(sessions) {
    const models = [...new Set(sessions.map((s) => s.model).filter(Boolean))].sort();
    const key = models.join('|');
    if (key === modelOptionsKey) return;
    modelOptionsKey = key;
    const opts = [{ value: '', label: 'All models' }];
    for (const m of models) opts.push({ value: m, label: m.replace(/^claude-/, '') });
    $modelDD.setOptions(opts);
    // If the previously-selected model vanished, fall back to All.
    if (filterModel && !models.includes(filterModel)) { filterModel = ''; }
    $modelDD.value = filterModel;
  }

  /** Apply search + active-only + model filters and the chosen sort. */
  function visibleSessions() {
    const q = filterText.trim().toLowerCase();
    let out = latest.filter((s) => {
      if (filterActive && !s.active) return false;
      if (filterModel && s.model !== filterModel) return false;
      if (q) {
        const hay = `${shortName(s)} ${s.cwd || ''} ${s.projectLabel || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out = out.slice().sort((a, b) => {
      if (sortKey === 'tokens') return b.totalTokens - a.totalTokens;
      if (sortKey === 'cost') return b.costUSD - a.costUSD;
      return b.mtime - a.mtime; // recent
    });
    return out;
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
        syncModelOptions(latest);
        renderSidebar();
        renderSysStats(data.systemStats);
        renderModelBreakdown(data.systemStats && data.systemStats.byModel);
        if (!selectedId && latest.length) selectedId = (visibleSessions()[0] || latest[0]).id;
        renderDetail(currentSession());
        Office.update(latest); // Office shares this stream (no second EventSource)
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

  function renderSidebar() {
    const sessions = visibleSessions();
    $sidebar.replaceChildren();
    if (sessions.length === 0) {
      $sidebar.appendChild(el('div', 'empty', 'No sessions match.'));
      return;
    }
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
        renderSidebar();
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

  // Tokens-over-time bar chart. The SSE snapshot doesn't carry per-entry token
  // deltas (kept small on purpose), so we lazily fetch server-bucketed
  // tokenBuckets from /api/session for the selected session. Until that lands
  // (or if it fails) we fall back to bucketing recentMessages timestamps as a
  // coarse activity proxy.
  function renderChart(s) {
    if (typeof uPlot === 'undefined') {
      $chartBox.textContent = 'chart unavailable (uPlot not loaded)';
      return;
    }
    const cached = tokenChartCache.get(s.id);
    if (cached && cached.buckets.tokens.length >= 2) {
      drawBars(cached.buckets.ts.map((x) => x / 1000), cached.buckets.tokens, 'tokens');
    } else {
      drawMessageFallback(s);
    }
    // Fetch (or refresh, if this session has accumulated more tokens) the real
    // token buckets, then redraw if it's still the selected session.
    if (!cached || cached.atTokens < s.totalTokens) {
      fetchSession(s.id, s.projectSlug).then((data) => {
        const b = data.session && data.session.tokenBuckets;
        if (!b) return;
        tokenChartCache.set(s.id, { buckets: b, atTokens: s.totalTokens });
        if (selectedId === s.id && b.tokens.length >= 2) {
          drawBars(b.ts.map((x) => x / 1000), b.tokens, 'tokens');
        }
      }).catch(() => { /* keep the fallback chart */ });
    }
  }

  // Fallback: bucket recentMessages timestamps (count per bin) when token
  // buckets aren't available yet.
  function drawMessageFallback(s) {
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
    drawBars(xs.map((x) => x / 1000), ys, 'messages');
  }

  function drawBars(xSec, ys, label = 'tokens') {
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
          label,
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

  // --- tokens-by-model donut (system-wide) ---

  let latestByModel = []; // kept so a theme switch can re-render with fresh colors

  // Stable palette pulled from theme CSS vars so it adapts to light/dark. Known
  // families get a fixed hue; anything else cycles through the rest.
  const MODEL_HUES = ['--accent', '--magenta', '--ok', '--warn', '--err'];
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }
  function modelColor(model, idx) {
    const m = (model || '').toLowerCase();
    if (m.includes('opus')) return cssVar('--accent');
    if (m.includes('sonnet')) return cssVar('--magenta');
    if (m.includes('haiku')) return cssVar('--ok');
    return cssVar(MODEL_HUES[idx % MODEL_HUES.length]);
  }

  function renderModelBreakdown(byModel) {
    latestByModel = byModel || [];
    const total = latestByModel.reduce((n, m) => n + m.tokens, 0);
    if (!latestByModel.length || total <= 0) {
      $modelChart.replaceChildren();
      $modelLegend.replaceChildren(el('li', 'empty', 'No model data yet.'));
      return;
    }
    // Donut via one SVG circle per slice using stroke-dasharray. r chosen so the
    // circumference is a round 100 → dasharray values read as percentages.
    const r = 15.915; // circumference ≈ 100
    const cx = 21, cy = 21, sw = 6;
    const SVG = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 42 42');
    svg.setAttribute('class', 'donut');
    // track ring
    const track = document.createElementNS(SVG, 'circle');
    track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', r);
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', cssVar('--border'));
    track.setAttribute('stroke-width', sw);
    svg.appendChild(track);

    // SVG is rotated -90deg in CSS so slices start at 12 o'clock; offset 0 = top.
    let offset = 0;
    $modelLegend.replaceChildren();
    latestByModel.forEach((m, i) => {
      const pct = (m.tokens / total) * 100;
      const color = modelColor(m.model, i);
      const seg = document.createElementNS(SVG, 'circle');
      seg.setAttribute('cx', cx); seg.setAttribute('cy', cy); seg.setAttribute('r', r);
      seg.setAttribute('fill', 'none');
      seg.setAttribute('stroke', color);
      seg.setAttribute('stroke-width', sw);
      seg.setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
      seg.setAttribute('stroke-dashoffset', String(offset));
      svg.appendChild(seg);
      offset -= pct; // next slice starts where this one ended

      const li = el('li', 'mon-model-row');
      const dot = el('span', 'mon-model-dot'); dot.style.background = color;
      li.appendChild(dot);
      li.appendChild(el('span', 'mon-model-name', (m.model || '—').replace(/^claude-/, '')));
      li.appendChild(el('span', 'mon-model-val', `${fmt.tokens(m.tokens)} · ${pct.toFixed(0)}%`));
      li.title = `${fmt.cost(m.costUSD)} (est.)`;
      $modelLegend.appendChild(li);
    });
    $modelChart.replaceChildren(svg);
  }

  function onResize() { const s = currentSession(); if (s && started) renderChart(s); }
  window.addEventListener('resize', onResize);

  // Re-render charts so they pick up new CSS colors (e.g. after a theme switch).
  function redraw() {
    const s = currentSession();
    if (s && started) renderChart(s);
    if (started) renderModelBreakdown(latestByModel);
  }

  // --- wire sidebar filter controls ---
  let monSearchTimer;
  $monSearch.addEventListener('input', () => {
    clearTimeout(monSearchTimer);
    monSearchTimer = setTimeout(() => { filterText = $monSearch.value; renderSidebar(); }, 120);
  });
  $monActive.addEventListener('click', () => {
    filterActive = !filterActive;
    $monActive.setAttribute('aria-pressed', String(filterActive));
    renderSidebar();
  });

  return { start, redraw };
})();

// --- office view ----------------------------------------------------------
// A playful "office": each session is an avatar that moves to the room matching
// its current activity. Shares the Monitor SSE stream (Office.update is called
// from the snapshot handler) — no second EventSource. Activity → room is a
// direct map of the core-derived `activity` state; the avatar is plain SVG/CSS
// (no game engine) and slides between rooms via a CSS transition.

const Office = (() => {
  const $floor = document.getElementById('office-floor');
  const $count = document.getElementById('office-count');
  const $empty = document.getElementById('office-empty');
  const agents = new Map(); // session id -> { node, room, x, y, queue, slot, ... }
  let started = false;
  let built = false;

  // --- floor plan: a 3x3 grid of rooms separated by real hallway lanes -------
  // The hallway is the empty band between rooms (HALL_W wide). Avatars only ever
  // travel along the lane centre-lines, entering/leaving each room by its single
  // door on the hallway-facing edge — so paths never cut through a room.
  const PAD = 16;                  // outer margin
  const RW = 286, RH = 178;        // room size
  const HALL_W = 52;               // hallway lane width (visible + walkable)
  const WORLD_W = PAD * 2 + RW * 3 + HALL_W * 2;     // 1000
  const WORLD_H = PAD * 2 + RH * 3 + HALL_W * 2;     // 696
  const COLX = [PAD, PAD + RW + HALL_W, PAD + 2 * (RW + HALL_W)]; // room lefts
  const ROWY = [PAD, PAD + RH + HALL_W, PAD + 2 * (RH + HALL_W)]; // room tops
  // Lane centre-lines: 2 vertical (between cols), 2 horizontal (between rows).
  const LANE_X = [COLX[1] - HALL_W / 2, COLX[2] - HALL_W / 2];
  const LANE_Y = [ROWY[1] - HALL_W / 2, ROWY[2] - HALL_W / 2];

  // 9 activities placed on the 3x3 grid (row-major).
  const LAYOUT = [
    ['thinking', 'reading', 'writing'],
    ['running', 'searching', 'browsing'],
    ['spawning', 'waiting', 'idle'],
  ];
  const LABELS = {
    thinking: 'Thinking', reading: 'Reading', writing: 'Coding',
    running: 'Running', searching: 'Searching', browsing: 'Browsing',
    spawning: 'Spawning', waiting: 'Waiting', idle: 'Idle',
  };
  const nearest = (v, arr) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), arr[0]);

  /** @type {Map<string,{activity,r,c,x,y,w,h,door,laneY,laneX,slots}>} */
  const ROOMS = new Map();
  (function defineRooms() {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const activity = LAYOUT[r][c];
        const x = COLX[c], y = ROWY[r];
        // Door on the edge that faces the room's nearest horizontal hallway:
        // top rows exit downward, the bottom row exits upward.
        const exitDown = r < 2;
        const doorY = exitDown ? y + RH : y;          // on the room wall
        const laneY = exitDown ? LANE_Y[r] : LANE_Y[r - 1]; // the lane just outside that door
        const door = { x: x + RW / 2, y: doorY, lane: laneY };
        // The vertical lane this column drains into (for cross-column travel).
        const laneX = nearest(x + RW / 2, LANE_X);
        // Standing slots near the desk (desk sits along the back/top wall).
        const slots = [];
        const cols = 4, sx = x + 40, sy = y + RH - 34, gap = (RW - 80) / (cols - 1);
        for (let i = 0; i < 8; i++) {
          slots.push({ x: sx + (i % cols) * gap, y: sy - Math.floor(i / cols) * 40 });
        }
        ROOMS.set(activity, { activity, r, c, x, y, w: RW, h: RH, door, laneY, laneX, slots });
      }
    }
  })();

  function roomFor(activity) {
    return ROOMS.get(activity) || ROOMS.get('idle');
  }
  function shortName(s) {
    if (s.cwd) return s.cwd.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || s.projectLabel;
    return s.projectLabel || s.id.slice(0, 8);
  }
  function activityColor(activity) {
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
    switch (activity) {
      case 'writing': return css('--accent');
      case 'reading': case 'searching': case 'browsing': return css('--magenta');
      case 'running': case 'spawning': return css('--ok');
      case 'thinking': return css('--warn');
      default: return css('--text-dim'); // idle / waiting
    }
  }
  function bubbleText(s) {
    const msgs = s.recentMessages || [];
    const last = msgs[msgs.length - 1];
    if (!last || !last.text) return '';
    const t = last.text.trim();
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }

  /** Truncate a name for the avatar label; full name lives in the title. */
  function clipName(name, n = 12) {
    return name.length > n ? name.slice(0, n - 1) + '…' : name;
  }

  // --- floor + furniture ----------------------------------------------------

  /** A desk/prop SVG per room kind, sized to sit against the room's back wall. */
  function deskSvg(activity) {
    const g = svgEl('svg', { viewBox: '0 0 80 48', class: 'desk', width: 80, height: 48 });
    const desk = () => g.appendChild(svgEl('rect', { x: 6, y: 30, width: 68, height: 8, rx: 2, fill: '#8d6a4a' }));
    const legs = () => { g.appendChild(svgEl('rect', { x: 10, y: 38, width: 4, height: 8, fill: '#6b4f36' })); g.appendChild(svgEl('rect', { x: 66, y: 38, width: 4, height: 8, fill: '#6b4f36' })); };
    switch (activity) {
      case 'writing': // monitor with code lines
        desk(); legs();
        g.appendChild(svgEl('rect', { x: 26, y: 8, width: 28, height: 20, rx: 2, fill: '#22303a' }));
        g.appendChild(svgEl('rect', { x: 28, y: 10, width: 24, height: 16, fill: '#0f1720' }));
        [13, 16, 19, 22].forEach((y, i) => g.appendChild(svgEl('rect', { x: 30, y, width: [14, 10, 16, 8][i], height: 1.6, class: 'desk-tint' })));
        g.appendChild(svgEl('rect', { x: 36, y: 28, width: 8, height: 2, fill: '#22303a' }));
        break;
      case 'reading': // bookshelf
        for (let i = 0; i < 6; i++) g.appendChild(svgEl('rect', { x: 8 + i * 11, y: 10 + (i % 2) * 2, width: 8, height: 28 - (i % 2) * 2, rx: 1, fill: ['#c25d6b', '#5b8def', '#5fae8c', '#e0a458', '#c08adb', '#8d6a4a'][i] }));
        g.appendChild(svgEl('rect', { x: 4, y: 38, width: 72, height: 4, fill: '#6b4f36' }));
        break;
      case 'running': // terminal box
        desk(); legs();
        g.appendChild(svgEl('rect', { x: 24, y: 8, width: 32, height: 20, rx: 2, fill: '#0f1720' }));
        g.appendChild(svgEl('path', { d: 'M28 13l4 3-4 3', fill: 'none', stroke: '#7fc8a0', 'stroke-width': 1.5 }));
        g.appendChild(svgEl('rect', { x: 34, y: 19, width: 10, height: 1.6, fill: '#7fc8a0' }));
        break;
      case 'searching': // magnifier on desk
        desk(); legs();
        g.appendChild(svgEl('circle', { cx: 36, cy: 18, r: 8, fill: 'none', stroke: '#9a9286', 'stroke-width': 2.5 }));
        g.appendChild(svgEl('path', { d: 'M42 24l6 6', stroke: '#9a9286', 'stroke-width': 3, 'stroke-linecap': 'round' }));
        break;
      case 'browsing': // globe
        desk(); legs();
        g.appendChild(svgEl('circle', { cx: 40, cy: 16, r: 10, fill: '#2a6f97' }));
        g.appendChild(svgEl('path', { d: 'M30 16h20M40 6v20M33 9q7 7 0 14M47 9q-7 7 0 14', fill: 'none', stroke: '#7fc8a0', 'stroke-width': 1 }));
        break;
      case 'spawning': // portal
        g.appendChild(svgEl('ellipse', { cx: 40, cy: 26, rx: 16, ry: 18, fill: 'none', stroke: '#7fc8a0', 'stroke-width': 2 }));
        g.appendChild(svgEl('ellipse', { cx: 40, cy: 26, rx: 9, ry: 11, fill: 'none', stroke: '#7fc8a0', 'stroke-width': 1.5, opacity: 0.6 }));
        break;
      case 'thinking': // gear
        g.appendChild(svgEl('circle', { cx: 40, cy: 22, r: 9, fill: 'none', stroke: '#e0a458', 'stroke-width': 3 }));
        g.appendChild(svgEl('circle', { cx: 40, cy: 22, r: 3, fill: '#e0a458' }));
        break;
      case 'waiting': // clock
        desk(); legs();
        g.appendChild(svgEl('circle', { cx: 40, cy: 17, r: 9, fill: '#fff', stroke: '#9a9286', 'stroke-width': 1.5 }));
        g.appendChild(svgEl('path', { d: 'M40 17v-5M40 17l4 2', stroke: '#2b2620', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
        break;
      default: // idle: a small plant
        g.appendChild(svgEl('path', { d: 'M40 30c-6 0-9-6-9-12 5 0 9 4 9 12zM40 30c6 0 9-6 9-12-5 0-9 4-9 12z', fill: '#5fae8c' }));
        g.appendChild(svgEl('path', { d: 'M34 30h12l-2 8H36z', fill: '#b06a4a' }));
    }
    return g;
  }

  /** Build the static floor once: hallway lanes + rooms + furniture. */
  function buildFloor() {
    if (built || !$floor) return;
    built = true;
    $floor.style.setProperty('--floor-w', WORLD_W + 'px');
    $floor.style.setProperty('--floor-h', WORLD_H + 'px');
    // Visible hallway lanes (under the rooms): 2 vertical + 2 horizontal bands.
    for (const cx of LANE_X) {
      const lane = el('div', 'hallway hallway-v');
      lane.style.cssText = `left:${cx - HALL_W / 2}px;top:0;width:${HALL_W}px;height:${WORLD_H}px`;
      $floor.appendChild(lane);
    }
    for (const cy of LANE_Y) {
      const lane = el('div', 'hallway hallway-h');
      lane.style.cssText = `left:0;top:${cy - HALL_W / 2}px;width:${WORLD_W}px;height:${HALL_W}px`;
      $floor.appendChild(lane);
    }
    for (const room of ROOMS.values()) {
      const el2 = el('div', 'room');
      el2.dataset.activity = room.activity;
      el2.style.cssText = `left:${room.x}px;top:${room.y}px;width:${room.w}px;height:${room.h}px`;
      // Door opening cut into the hallway-facing wall (matches route exit point).
      const door = el('div', 'room-door ' + (room.door.y > room.y ? 'door-bottom' : 'door-top'));
      door.style.left = (room.door.x - room.x - 22) + 'px';
      el2.appendChild(door);
      el2.appendChild(el('span', 'room-label', LABELS[room.activity]));
      const desk = deskSvg(room.activity);
      // Center the desk against the back wall of the room.
      desk.style.cssText = `left:${room.w / 2 - 40}px;top:8px`;
      el2.appendChild(desk);
      // Props: a chair below the desk + a potted plant in a corner.
      const chair = propSvg('chair');
      chair.style.cssText = `left:${room.w / 2 - 14}px;top:54px`;
      el2.appendChild(chair);
      const plant = propSvg('plant');
      plant.style.cssText = `left:${room.w - 34}px;top:${room.h - 40}px`;
      el2.appendChild(plant);
      $floor.appendChild(el2);
    }
    fitFloor();
  }

  /** Small decorative props (no semantic meaning, just to furnish the room). */
  function propSvg(kind) {
    if (kind === 'chair') {
      const g = svgEl('svg', { viewBox: '0 0 28 28', class: 'desk', width: 28, height: 28 });
      g.appendChild(svgEl('rect', { x: 6, y: 4, width: 16, height: 5, rx: 2, fill: '#8d6a4a' }));   // backrest
      g.appendChild(svgEl('rect', { x: 6, y: 12, width: 16, height: 5, rx: 2, fill: '#a07a52' }));  // seat
      g.appendChild(svgEl('rect', { x: 8, y: 17, width: 3, height: 7, fill: '#6b4f36' }));
      g.appendChild(svgEl('rect', { x: 17, y: 17, width: 3, height: 7, fill: '#6b4f36' }));
      return g;
    }
    // plant
    const g = svgEl('svg', { viewBox: '0 0 28 32', class: 'desk', width: 28, height: 32 });
    g.appendChild(svgEl('path', { d: 'M14 18c-7 0-10-7-10-13 6 0 10 5 10 13zM14 18c7 0 10-7 10-13-6 0-10 5-10 13z', fill: '#5fae8c' }));
    g.appendChild(svgEl('path', { d: 'M8 18h12l-2 10H10z', fill: '#b06a4a' }));
    return g;
  }

  /** Scale the fixed world down to fit the available width. */
  function fitFloor() {
    if (!$floor) return;
    const avail = ($floor.parentElement.clientWidth || WORLD_W) - 4;
    const scale = Math.min(1, avail / WORLD_W);
    $floor.style.setProperty('--floor-scale', String(scale));
    // The scaled element still reserves unscaled height; shrink the stage to match.
    $floor.parentElement.style.height = (WORLD_H * scale + 4) + 'px';
  }

  // --- character avatars (deterministic-random per session id) -------------

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  /** Stable 32-bit-ish hash of a string so an agent always looks the same. */
  function hashId(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const SKIN = ['#ffdbac', '#f2c9a0', '#e8b088', '#d99a6c', '#c1855a', '#8d5a3c', '#6b4423'];
  const HAIR = ['#2b2620', '#4a2f1a', '#5a3a22', '#8d5a3c', '#b06a2c', '#c08a4a', '#d4b483', '#9a9286', '#cfcfcf', '#3a3550', '#7a3b5d'];
  const HAT = ['#d97757', '#7fc8a0', '#c08adb', '#e0a458', '#5b8def', '#e06a5a'];
  const SHIRT = ['#d97757', '#7fc8a0', '#c08adb', '#e0a458', '#5b8def', '#5fae8c', '#c25d6b', '#6b7280', '#3a3550', '#b0894a'];
  const INK = '#2b2620'; // facial features

  /**
   * Build a little character from the id hash so the same agent always looks the
   * same: skin, gender lean, hairstyle + color, optional hat, shirt color, and
   * facial details (eyes/brows/mouth that change with `active`). A small collar
   * badge keeps the activity color so the figure still reads as a status.
   * @param {object} s session
   * @param {boolean} active  smiling + open eyes when actively working
   */
  function makeAgentSvg(s, active) {
    const h = hashId(s.id);
    const bit = (shift) => (h >> shift) & 1;
    const pick = (arr, shift) => arr[(h >> shift) % arr.length];

    const skin = pick(SKIN, 2);
    const hair = pick(HAIR, 5);
    const shirt = pick(SHIRT, 21);
    const feminine = bit(28) === 1;            // gender lean → longer hair, lashes, blush
    // Hairstyle pool widens for the feminine lean (long / ponytail).
    const masc = ['short', 'sidePart', 'buzz', 'curly', 'bald'];
    const femi = ['long', 'ponytail', 'bob', 'curly', 'sidePart'];
    const hairStyle = (feminine ? femi : masc)[(h >> 9) % 5];
    const hasHat = (h >> 13) % 10 < 3 && hairStyle !== 'long' && hairStyle !== 'ponytail';
    const hat = pick(HAT, 17);
    const hasGlasses = (h >> 24) % 10 < 3;     // ~30% wear glasses

    const svg = svgEl('svg', { viewBox: '0 0 40 40', class: 'agent-figure' });

    // Long hair behind the shoulders (drawn first so it sits underneath).
    if (hairStyle === 'long') {
      svg.appendChild(svgEl('path', { d: 'M8 18c-1 9 0 16 2 22h4c-2-7-2-14-1-21zM32 18c1 9 0 16-2 22h-4c2-7 2-14 1-21z', fill: hair }));
    } else if (hairStyle === 'ponytail') {
      svg.appendChild(svgEl('path', { d: 'M30 12c5 1 7 6 6 12-1 4-3 6-5 7l-2-3c2-1 3-3 3-6 0-4-2-7-4-8z', fill: hair }));
    }

    // Shirt / shoulders.
    svg.appendChild(svgEl('path', { d: 'M7 40c0-7 6-11 13-11s13 4 13 11z', fill: shirt }));
    // Collar badge — keeps the activity tint so the figure still shows status.
    svg.appendChild(svgEl('circle', { cx: 20, cy: 33, r: 2.2, class: 'fig-body' }));

    // Head + ears.
    svg.appendChild(svgEl('circle', { cx: 11.5, cy: 18, r: 1.8, fill: skin }));
    svg.appendChild(svgEl('circle', { cx: 28.5, cy: 18, r: 1.8, fill: skin }));
    svg.appendChild(svgEl('circle', { cx: 20, cy: 17, r: 11, fill: skin }));

    // Hair on top (skip for bald).
    if (hairStyle !== 'bald' && hairStyle !== 'buzz') {
      let d;
      if (hairStyle === 'short') d = 'M9 15a11 11 0 0 1 22 0c0-4-4-8-11-8S9 11 9 15z';
      else if (hairStyle === 'sidePart') d = 'M9 16c0-7 6-9 11-9s11 2 11 9c-3-3-7-4-11-4-2 3-7 2-11 4z';
      else if (hairStyle === 'curly') d = 'M8 16a12 5 0 0 1 24 0a4 4 0 0 0-4-5a4 4 0 0 0-8 0a4 4 0 0 0-8 0a4 4 0 0 0-4 5z';
      else if (hairStyle === 'bob') d = 'M8 20c0-10 5-13 12-13s12 3 12 13c0-6-2-9-4-9-3 0-4 2-8 2s-5-2-8-2c-2 0-4 3-4 9z';
      else if (hairStyle === 'long') d = 'M9 16a11 11 0 0 1 22 0c0-5-3-9-11-9S9 11 9 16z';
      else d = 'M9 15a11 11 0 0 1 22 0c0-5-4-8-11-8S9 10 9 15z'; // ponytail front
      svg.appendChild(svgEl('path', { d, fill: hair }));
    } else if (hairStyle === 'buzz') {
      svg.appendChild(svgEl('path', { d: 'M9.5 14a10.5 10.5 0 0 1 21 0a11 11 0 0 0-21 0z', fill: hair, opacity: 0.85 }));
    }

    // Hat over the hair.
    if (hasHat) {
      svg.appendChild(svgEl('path', { d: 'M9 13h22l-2-4a10 10 0 0 0-18 0z', fill: hat }));
      svg.appendChild(svgEl('rect', { x: 7, y: 12, width: 26, height: 2.4, rx: 1.2, fill: hat }));
    }

    // Eyebrows.
    svg.appendChild(svgEl('path', { d: 'M13.5 13.5h4', stroke: INK, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 }));
    svg.appendChild(svgEl('path', { d: 'M22.5 13.5h4', stroke: INK, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 }));

    // Eyes.
    const eyeY = 17;
    if (active) {
      svg.appendChild(svgEl('circle', { cx: 16, cy: eyeY, r: 1.7, fill: INK }));
      svg.appendChild(svgEl('circle', { cx: 24, cy: eyeY, r: 1.7, fill: INK }));
    } else {
      svg.appendChild(svgEl('path', { d: `M14 ${eyeY}h4`, stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
      svg.appendChild(svgEl('path', { d: `M22 ${eyeY}h4`, stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
    }
    // Eyelashes for the feminine lean.
    if (feminine) {
      svg.appendChild(svgEl('path', { d: 'M13.6 16l-1-1M26.4 16l1-1', stroke: INK, 'stroke-width': 0.9, 'stroke-linecap': 'round' }));
    }
    // Glasses.
    if (hasGlasses) {
      svg.appendChild(svgEl('circle', { cx: 16, cy: eyeY, r: 3, fill: 'none', stroke: INK, 'stroke-width': 1 }));
      svg.appendChild(svgEl('circle', { cx: 24, cy: eyeY, r: 3, fill: 'none', stroke: INK, 'stroke-width': 1 }));
      svg.appendChild(svgEl('path', { d: 'M19 17h2', stroke: INK, 'stroke-width': 1 }));
    }

    // Blush for the feminine lean.
    if (feminine) {
      svg.appendChild(svgEl('circle', { cx: 14, cy: 21, r: 1.6, fill: '#e8806f', opacity: 0.35 }));
      svg.appendChild(svgEl('circle', { cx: 26, cy: 21, r: 1.6, fill: '#e8806f', opacity: 0.35 }));
    }

    // Mouth: smile when active, flat when idle.
    svg.appendChild(svgEl('path', {
      d: active ? 'M16 22q4 4 8 0' : 'M16 23h8',
      fill: 'none', stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round',
    }));
    return svg;
  }

  /** Build an avatar node: a little character + a name below + a bubble. */
  function makeAgent(s) {
    const name = shortName(s);
    const node = el('div', 'agent');
    node.dataset.id = s.id;
    node.title = name; // full name on hover
    node.appendChild(makeAgentSvg(s, !!s.active));
    node.appendChild(el('span', 'agent-name', clipName(name)));
    node.appendChild(el('div', 'bubble'));
    return node;
  }

  // The office shows agents that are *working*, not the full history. Keep
  // sessions that are active or were touched within this window; the rest
  // (old closed conversations) would just pile up in the Idle room.
  const RECENT_MS = 30 * 60 * 1000; // 30 minutes
  function isRecent(s, now) {
    return s.active || (now - (s.mtime || 0) < RECENT_MS);
  }

  // --- slot manager: hand out non-overlapping standing spots per room -------
  const occupied = new Map(); // activity -> Set of slot indices in use
  function takeSlot(room, entry) {
    if (entry.slot && entry.slot.room === room.activity) return entry.slot;
    releaseSlot(entry);
    let set = occupied.get(room.activity);
    if (!set) { set = new Set(); occupied.set(room.activity, set); }
    let idx = room.slots.findIndex((_, i) => !set.has(i));
    if (idx < 0) idx = set.size % room.slots.length; // overflow: reuse (stack)
    set.add(idx);
    entry.slot = { room: room.activity, idx, ...room.slots[idx] };
    return entry.slot;
  }
  function releaseSlot(entry) {
    if (!entry.slot) return;
    const set = occupied.get(entry.slot.room);
    if (set) set.delete(entry.slot.idx);
    entry.slot = null;
  }

  // --- routing: travel only along hallway lanes, never through a room --------
  /**
   * Path from the agent's current room to the target room's desk slot, staying
   * on the hallway lanes the whole way:
   *   slot(A) → A.door → A's lane → [turn onto a vertical lane] → B's lane →
   *   B.door → slot(B).
   * Each leg is axis-aligned and sits on a lane centre-line or a door axis, so
   * the avatar never cuts across a room.
   */
  function route(fromRoom, toRoom, toSlot) {
    const a = fromRoom.door, b = toRoom.door;
    const pts = [];
    // 1) leave room A: step out of the door onto A's horizontal lane.
    pts.push({ x: a.x, y: a.lane });
    if (fromRoom === toRoom) { pts.push({ x: toSlot.x, y: toSlot.y }); return pts; }
    // 2) Whenever the two horizontal lanes differ (i.e. we change rows OR the
    //    rooms drain to different lanes), move vertically ONLY on a vertical
    //    lane (the gap between columns) — never along a room's centre, which
    //    would cut through the room in between.
    if (a.lane !== b.lane) {
      const vx = nearest(b.x, LANE_X);            // vertical lane beside room B's column
      pts.push({ x: vx, y: a.lane });             // ride A's lane to that vertical lane
      pts.push({ x: vx, y: b.lane });             // travel the vertical lane to B's lane
    }
    // 3) along B's horizontal lane to directly outside B's door.
    pts.push({ x: b.x, y: b.lane });
    // 4) into room B through its door, then square off to the slot (door x →
    //    slot y → slot x) so the final approach stays axis-aligned, not diagonal.
    pts.push({ x: b.x, y: b.y });
    pts.push({ x: b.x, y: toSlot.y });
    pts.push({ x: toSlot.x, y: toSlot.y });
    return pts;
  }

  /** Walk an agent through a list of points using chained CSS transitions. */
  const SPEED = 0.18; // px per ms (~feels like walking)
  function walkTo(entry, points) {
    entry.queue = points.slice();
    if (entry.walking) return; // already stepping; queue picked up on arrival
    stepNext(entry);
  }
  function stepNext(entry) {
    const next = entry.queue && entry.queue.shift();
    if (!next) { entry.walking = false; entry.node.classList.remove('walking'); return; }
    const dx = next.x - entry.x, dy = next.y - entry.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) { entry.x = next.x; entry.y = next.y; return stepNext(entry); }
    entry.walking = true;
    entry.node.classList.add('walking');
    entry.node.classList.toggle('face-left', dx < -1);
    const dur = reduceMotion ? 0 : Math.min(1400, Math.max(180, dist / SPEED));
    entry.node.style.transitionDuration = dur + 'ms';
    entry.x = next.x; entry.y = next.y;
    entry.node.style.transform = `translate(${next.x}px,${next.y}px)`;
    if (dur === 0) { stepNext(entry); return; }
    clearTimeout(entry.stepTimer);
    entry.stepTimer = setTimeout(() => stepNext(entry), dur + 30); // drive via timer (robust vs missed transitionend)
  }
  /** Place instantly (no walk) — for first appearance. */
  function placeAt(entry, p) {
    entry.x = p.x; entry.y = p.y;
    entry.node.style.transitionDuration = '0ms';
    entry.node.style.transform = `translate(${p.x}px,${p.y}px)`;
  }

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Reconcile avatars with the latest snapshot. */
  function update(sessions) {
    if (!$floor) return;
    buildFloor();
    const now = Date.now();
    const visible = sessions.filter((s) => isRecent(s, now));
    const seen = new Set();
    for (const s of visible) {
      seen.add(s.id);
      let entry = agents.get(s.id);
      const fresh = !entry;
      if (!entry) {
        const node = makeAgent(s);
        node.classList.add('spawning-in');
        $floor.appendChild(node);
        entry = { node, room: null, active: undefined, x: 0, y: 0, queue: [], walking: false, slot: null };
        agents.set(s.id, entry);
      }
      const target = roomFor(s.activity);
      if (entry.room !== target) {
        const fromRoom = entry.room;
        entry.room = target;
        const slot = takeSlot(target, entry);
        if (fresh || !fromRoom) {
          // Appear at the target room's door, then stroll to the desk.
          placeAt(entry, { x: target.door.x, y: target.door.y });
          walkTo(entry, [{ x: slot.x, y: slot.y }]);
        } else {
          // Walk out of the old room and along the hallway lanes to the new one.
          walkTo(entry, route(fromRoom, target, slot));
        }
      }
      // Re-draw the face only when active-ness flips (smile/eyes change).
      if (entry.active !== !!s.active) {
        entry.active = !!s.active;
        entry.node.replaceChild(makeAgentSvg(s, entry.active), entry.node.querySelector('.agent-figure'));
      }
      entry.node.style.setProperty('--agent-tint', activityColor(s.activity));
      entry.node.classList.toggle('active', !!s.active);
      entry.text = bubbleText(s);
      entry.node.querySelector('.bubble').textContent = entry.text;
    }
    // Drop avatars whose session vanished from the snapshot.
    for (const [id, entry] of agents) {
      if (!seen.has(id)) { clearTimeout(entry.stepTimer); releaseSlot(entry); entry.node.remove(); agents.delete(id); }
    }
    const n = agents.size;
    $count.textContent = `${n} agent${n === 1 ? '' : 's'}`;
    $empty.hidden = n > 0;
    if (started) applyBubbles();
  }

  // One bubble per room at a time (rotating) so bubbles never overlap.
  let rotateOffset = 0;
  function applyBubbles() {
    const perRoom = new Map(); // activity -> agents that have something to say
    for (const [, entry] of agents) {
      entry.node.classList.remove('show-bubble');
      if (!entry.text || !entry.room) continue;
      const key = entry.room.activity;
      if (!perRoom.has(key)) perRoom.set(key, []);
      perRoom.get(key).push(entry);
    }
    for (const [, list] of perRoom) {
      const actives = list.filter((e) => e.active);
      const pickFrom = actives.length ? actives : list;
      pickFrom[rotateOffset % pickFrom.length].node.classList.add('show-bubble');
    }
  }

  let rotateTimer = null;
  function start() {
    if (started) return;
    started = true;
    buildFloor();
    applyBubbles();
    rotateTimer = setInterval(() => { rotateOffset++; applyBubbles(); }, 3000);
    window.addEventListener('resize', fitFloor);
  }
  function redraw() {
    // Theme changed: re-tint avatars (rooms/desks use CSS vars and re-tint on
    // their own).
    for (const [, entry] of agents) {
      const act = entry.room ? entry.room.activity : 'idle';
      entry.node.style.setProperty('--agent-tint', activityColor(act));
    }
  }

  return { start, update, redraw };
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
  Office.redraw(); // avatars use CSS-var-derived inline colors
});

// --- tab switching --------------------------------------------------------

const $tabs = [...document.querySelectorAll('.tab')];
const $views = {
  sessions: document.getElementById('view-sessions'),
  monitor: document.getElementById('view-monitor'),
  office: document.getElementById('view-office'),
};

function switchTab(name) {
  for (const t of $tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const [k, v] of Object.entries($views)) v.hidden = k !== name;
  // Office shares the Monitor SSE stream, so opening either starts it.
  if (name === 'monitor' || name === 'office') Monitor.start();
  if (name === 'office') Office.start();
}

for (const t of $tabs) t.addEventListener('click', () => switchTab(t.dataset.tab));

// --- boot -----------------------------------------------------------------

refresh();
// Light auto-refresh so new conversations show up without a manual reload.
// Only the Sessions view polls (Monitor is SSE-driven), and we skip while a
// selection is in progress so we don't wipe the user's checkboxes.
setInterval(() => {
  if (
    document.visibilityState === 'visible' &&
    document.activeElement !== $search &&
    !$views.sessions.hidden &&
    selected.size === 0
  ) {
    refresh();
  }
}, 15000);
