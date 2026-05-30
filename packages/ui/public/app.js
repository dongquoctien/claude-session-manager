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

// --- office: agent chatter -------------------------------------------------
// Water-cooler one-liners the avatars buzz in speech bubbles so the office
// feels alive. The line pool is multilingual (en/ko/ja/vi). A live pool is
// fetched on demand from /api/chatter (generated by the local `claude` CLI);
// until/unless that arrives we use the static fallback below, so chatter always
// works even with no `claude` installed. Shared by both office renderers.

const CHATTER_FALLBACK = {
  en: [
    'Ship it. We can fix it in prod.', 'This bug is a rabbit hole.',
    'Who wrote this? …oh, it was me.', 'Tests are green, ship Friday 5pm.',
    'Just one more refactor, I swear.', 'LGTM, I read two of the lines.',
    'Merge conflict again? Beautiful.', 'It works on my machine.',
    'Coffee first, then the stack trace.', 'That PR is a masterpiece, honestly.',
    'Why is the build red AGAIN.', 'Naming things is the hardest part.',
  ],
  ko: [
    '일단 배포하고 고치죠.', '이 버그 또 뭐야…',
    '누가 짰어 이거. …아 나구나.', '테스트 통과, 금요일 배포 가자.',
    '리팩터 딱 한 번만 더.', 'LGTM, 두 줄 읽었음.',
    '또 머지 컨플릭트야?', '제 컴퓨터에선 됩니다.',
    '커피부터 마시고 스택트레이스.', '그 PR 진짜 잘 짰던데.',
    '빌드 왜 또 빨개.', '변수 이름 짓기가 제일 어렵다.',
  ],
  ja: [
    'とりあえずマージしよう。', 'このバグ、沼すぎる…',
    '誰が書いた？…自分か。', 'テスト緑、金曜にリリース。',
    'リファクタもう一回だけ。', 'LGTM、二行だけ読んだ。',
    'またコンフリクト？最高。', '自分の環境では動くよ。',
    'まずコーヒー、それからログ。', 'あのPRは正直すごい。',
    'なんでまたビルド赤いの。', '命名がいちばん難しい。',
  ],
  vi: [
    'Cứ deploy đi, lỗi sửa sau.', 'Bug này lằng nhằng phết.',
    'Ai viết đoạn này… à mình.', 'Test xanh hết, thứ Sáu ship.',
    'Refactor nốt lần này thôi.', 'LGTM, tôi đọc đúng hai dòng.',
    'Lại conflict nữa hả trời.', 'Máy tôi chạy ngon mà.',
    'Cà phê đã rồi xem log.', 'Cái PR đó viết ngon đấy.',
    'Sao build lại đỏ nữa rồi.', 'Đặt tên biến là khó nhất.',
  ],
};

/** Live pool overlaid by the server when available; starts as the fallback. */
const liveChatter = { ...CHATTER_FALLBACK };

/** Game-themed chatter for agents idling >10 min and now playing the arcade. */
const ARCADE_CHATTER = {
  en: [
    'New high score incoming.', 'One more game, then I work.',
    'Boss fight time.', 'Press start, no thoughts.',
    'GAME ON.', 'High score or it didn\'t happen.',
    'Just five more credits.', 'This pinball is cursed.',
    'Coffee break = arcade break.', 'Stop watching, you\'re jinxing me.',
  ],
  ko: [
    '하이스코어 가즈아.', '한 판만 더 하고 일할게.',
    '보스전 간다.', '스타트 누르고 무념무상.',
    '게임 시작!', '하이스코어 못 찍으면 안 한 거임.',
    '동전 다섯 개만 더.', '이 핀볼 저주받았다.',
    '커피 휴식 = 오락실 휴식.', '쳐다보지 마, 망해.',
  ],
  ja: [
    'ハイスコア更新くるぞ。', 'あと一回だけやって仕事する。',
    'ボス戦行きます。', 'スタート押して無心。',
    'ゲーム開始！', 'ハイスコアじゃなきゃ意味ない。',
    'あと5クレジット。', 'このピンボール呪われてる。',
    'コーヒー休憩イコール筐体休憩。', '見ないで、ミスる。',
  ],
  vi: [
    'High score sắp về tay.', 'Một ván nữa thôi rồi làm việc.',
    'Đánh boss đây.', 'Bấm start, đầu óc trống rỗng.',
    'GAME ON.', 'Phải high score chứ.',
    'Thêm 5 xu nữa thôi.', 'Pinball này bị nguyền rồi.',
    'Nghỉ cà phê = nghỉ chơi game.', 'Đừng nhìn, mày phá tao.',
  ],
};

/** Guess a session's language from its latest message text. Cheap, client-side. */
function detectLang(text) {
  if (!text) return 'en';
  if (/[가-힣]/.test(text)) return 'ko';                 // Hangul
  if (/[぀-ヿ㐀-鿿]/.test(text)) return 'ja';    // Kana + CJK
  // Vietnamese: Latin letters carrying the diacritics Vietnamese uses heavily.
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(text)) return 'vi';
  return 'en';
}

/** Pick a chatter line; mostly the session's language, sometimes another. */
function pickChatter(lang) {
  const langs = ['en', 'ko', 'ja', 'vi'];
  // 70% the session's own language, 30% a random other (multinational office).
  let use = lang && liveChatter[lang] && liveChatter[lang].length ? lang : 'en';
  if (Math.random() < 0.3) use = langs[Math.floor(Math.random() * langs.length)];
  const pool = (liveChatter[use] && liveChatter[use].length) ? liveChatter[use] : CHATTER_FALLBACK.en;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Pick an arcade-themed line for agents playing the cabinet. */
function pickArcadeChatter(lang) {
  const pool = ARCADE_CHATTER[lang] || ARCADE_CHATTER.en;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Merge a server-sent pool over the fallback, per language. */
function applyLivePool(lines) {
  if (!lines || typeof lines !== 'object') return;
  for (const k of ['en', 'ko', 'ja', 'vi']) {
    if (Array.isArray(lines[k]) && lines[k].length) liveChatter[k] = lines[k];
  }
}

/** Whether agents banter (remembered; default on). Toggled from the Office head. */
let chatterEnabled = (() => {
  try { return localStorage.getItem('csm-office-chatter') !== '0'; } catch (e) { return true; }
})();
function setChatterEnabled(on) {
  chatterEnabled = !!on;
  try { localStorage.setItem('csm-office-chatter', on ? '1' : '0'); } catch (e) {}
}

/**
 * Decide what an avatar says. When chatter is off, just the real recent line.
 * When on, mix in banter — heavily in the lounge (idle/waiting/thinking), only
 * occasionally for agents busy at work, so you can still read what they're doing.
 * Agents at the arcade always speak game-themed lines so it reads as "playing".
 * Language follows the session's own recent text.
 * @param {string} realText  the session's latest real message (may be '')
 * @param {boolean} inLounge true if the avatar is sitting in the lounge
 * @param {boolean} [inGame] true if the avatar is playing the arcade
 */
function composeBubble(realText, inLounge, inGame) {
  if (!chatterEnabled) return realText;
  const lang = detectLang(realText);
  if (inGame) return pickArcadeChatter(lang);
  const chatterChance = inLounge ? 0.85 : 0.25;
  if (!realText || Math.random() < chatterChance) return pickChatter(lang);
  return realText;
}

// --- office view ----------------------------------------------------------
// A playful "office": each session is an avatar that moves to the room matching
// its current activity. Shares the Monitor SSE stream (Office.update is called
// from the snapshot handler) — no second EventSource. Activity → room is a
// direct map of the core-derived `activity` state; the avatar is plain SVG/CSS
// (no game engine) and slides between rooms via a CSS transition.

const OfficePro = (() => {
  const $floor = document.getElementById('office-floor');
  const $count = document.getElementById('office-count');
  const $empty = document.getElementById('office-empty');
  let $tv = null; // the lounge TV feed (created in buildFloor)
  const agents = new Map(); // session id -> { node, room, x, y, queue, slot, ... }
  let started = false;
  let built = false;

  // --- open-plan office: 6 work rooms around a central lounge ----------------
  // Two columns of 3 rooms (left/right) flank a wide central lounge. Each room
  // has one door on its lounge-facing (inner) edge. idle/waiting/thinking live
  // in the lounge itself, so the office never looks empty when work is quiet.
  const PAD = 16;
  const RW = 300, RH = 200;        // edge-room size (was 250×168 — +20%)
  const GAP = 16;                  // vertical gap between stacked rooms
  const LOUNGE_W = 540;            // central lounge width (wide → landscape feel)
  const WORLD_W = PAD * 2 + RW * 2 + LOUNGE_W;            // 1172
  const WORLD_H = PAD * 2 + RH * 3 + GAP * 2;             // 664
  const LEFTX = PAD;                         // left column room left
  const RIGHTX = WORLD_W - PAD - RW;         // right column room left
  const LOUNGE = { x: PAD + RW, y: PAD, w: WORLD_W - 2 * (PAD + RW), h: RH * 3 + GAP * 2 };
  const LOUNGE_CX = LOUNGE.x + LOUNGE.w / 2;
  const ROWY = [PAD, PAD + RH + GAP, PAD + 2 * (RH + GAP)];

  const LABELS = {
    writing: 'Coding', reading: 'Reading', running: 'Running',
    searching: 'Searching', browsing: 'Browsing', spawning: 'Spawning',
  };
  // Which activities are real rooms (left column top→bottom, then right column).
  const ROOM_DEFS = [
    { activity: 'writing', side: 'L', row: 0 },
    { activity: 'running', side: 'L', row: 1 },
    { activity: 'searching', side: 'L', row: 2 },
    { activity: 'reading', side: 'R', row: 0 },
    { activity: 'browsing', side: 'R', row: 1 },
    { activity: 'spawning', side: 'R', row: 2 },
  ];

  /** @type {Map<string, object>} zone by activity (rooms) + 'lounge'. */
  const ZONES = new Map();
  (function defineZones() {
    for (const def of ROOM_DEFS) {
      const x = def.side === 'L' ? LEFTX : RIGHTX;
      const y = ROWY[def.row];
      // Door on the inner edge (facing the lounge): right edge for L, left for R.
      const doorX = def.side === 'L' ? x + RW : x;
      const door = { x: doorX, y: y + RH / 2 };
      // Standing slots near the desk: a 4-wide grid that grows by adding rows
      // upward so an unexpectedly crowded room still spreads people out.
      const slots = [];
      const cols = 4, sx = x + 34, sy = y + RH - 30, gap = (RW - 68) / (cols - 1);
      const make = (i) => ({ x: sx + (i % cols) * gap, y: sy - Math.floor(i / cols) * 38 });
      for (let i = 0; i < 8; i++) slots.push(make(i));
      slots.makeAt = make;
      ZONES.set(def.activity, { kind: 'room', activity: def.activity, side: def.side, x, y, w: RW, h: RH, door, slots });
    }
    // Lounge: idle/waiting/thinking sit here, in three separate clusters.
    // Each cluster knows how to grow: extra people land on a wider concentric
    // ring instead of stomping a held slot.
    const cx = LOUNGE_CX, cy = LOUNGE.y + LOUNGE.h / 2;
    // ringGen returns a slot array seeded with `base` positions on an inner
    // ellipse; .makeAt(i) lazily produces additional ones on outer ellipses.
    // `phase` offsets the first slot's angle so neighbouring groups don't all
    // place their first agent on the same x (the ring tops would otherwise
    // align vertically — see waiting/thinking/idle below).
    const ringGen = (base, rx, ry, oy, phase = 0) => {
      const slotAt = (i) => {
        const tier = Math.floor(i / base);                // 0 = innermost
        const within = i % base;
        const n = base + tier * 2;                        // wider tiers hold more
        const rxT = rx + tier * 28, ryT = ry + tier * 22;
        const a = phase + (within / n) * Math.PI * 2 - Math.PI / 2;
        return { x: cx + Math.cos(a) * rxT, y: cy + oy + Math.sin(a) * ryT };
      };
      const arr = [];
      for (let i = 0; i < base; i++) arr.push(slotAt(i));
      arr.makeAt = slotAt;
      return arr;
    };
    ZONES.set('lounge', {
      kind: 'lounge', activity: 'lounge', ...LOUNGE,
      door: { x: cx, y: cy },              // "door" = lounge centre (already inside)
      groups: (() => {
        // Three concentric clusters split vertically — waiting around the
        // meeting table (upper, but below the TV), thinking in the middle,
        // idle at the sofa below. Each gets a unique phase so the "first"
        // slot of each ring lands at a different angle and the vertical line
        // through cx isn't crowded. Rings are sized so nameplates (~60px
        // wide) clear each other. The waiting ring used to reach into the
        // TV — keep its top below the TV bezel (~y=200 in lounge coords).
        const base = {
          waiting:  ringGen(6, 140, 50,  -40, 0),                // around the meeting table (now lower)
          thinking: ringGen(4, 170, 50,   60, Math.PI / 4),       // mid-space between table and sofa
          idle:     ringGen(4, 120, 48,  160, Math.PI / 2),       // around the sofa
        };
        // One pinball cabinet at the bottom-right corner. Max 2 slots in
        // front (player + spectator); overflow is rejected so extras stay at
        // the sofa instead of cramming the corner.
        const pinballX = LOUNGE.x + LOUNGE.w - 16 - 20;
        const playY    = LOUNGE.y + LOUNGE.h - 36;
        const playing = [
          { x: pinballX,      y: playY },
          { x: pinballX - 26, y: playY },
        ];
        // No makeAt — pool is hard-capped at 2.
        return { ...base, playing };
      })(),
    });
  })();

  /** Resolve an activity to its zone + the slot group to stand in. */
  function zoneFor(activity) {
    if (ZONES.has(activity)) return { zone: ZONES.get(activity), group: null };
    return { zone: ZONES.get('lounge'), group: activity }; // idle/waiting/thinking
  }
  function roomFor(activity) { return zoneFor(activity).zone; }
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
      case 'writing': // monitor with code lines + blinking cursor
        desk(); legs();
        g.appendChild(svgEl('rect', { x: 26, y: 8, width: 28, height: 20, rx: 2, fill: '#22303a' }));
        g.appendChild(svgEl('rect', { x: 28, y: 10, width: 24, height: 16, fill: '#0f1720' }));
        // code lines wrapped in a group so CSS can scroll them upward when the
        // room has an agent (typing). Idle rooms show them static.
        {
          const codeG = svgEl('g', { class: 'cd-code' });
          [13, 16, 19, 22].forEach((y, i) => codeG.appendChild(svgEl('rect', {
            x: 30, y, width: [14, 10, 16, 8][i], height: 1.6, class: 'desk-tint',
          })));
          g.appendChild(codeG);
        }
        // blinking cursor at the end of the last line (animation via CSS)
        g.appendChild(svgEl('rect', { x: 39, y: 21.6, width: 1.2, height: 2.2, fill: '#7fc8a0', class: 'cd-cursor' }));
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

  // --- Extra room props (a real lived-in room has more than a desk) -----
  // Each helper returns a small SVG sized to its viewBox. roomFurniture(def)
  // sprinkles 3–5 of these around the room so it doesn't look 70%-empty.

  function rpBookshelf(w = 50, h = 56) {
    const g = svgEl('svg', { viewBox: '0 0 50 56', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 50, height: 56, rx: 2, fill: '#5a3f28' }));
    const cols = ['#c25d6b','#5b8def','#5fae8c','#e0a458','#c08adb','#8d6a4a','#3a4a63','#7fc8a0'];
    for (let row = 0; row < 3; row++) {
      const y = 4 + row * 17;
      g.appendChild(svgEl('rect', { x: 2, y: y + 13, width: 46, height: 2, fill: '#6b4f36' }));  // shelf board
      let x = 3;
      while (x < 46) {
        const bw = 3 + (row + x) % 4; // 3–6 px wide
        const bh = 10 + ((x * 3) % 4);
        g.appendChild(svgEl('rect', { x, y: y + 13 - bh, width: bw, height: bh, rx: 0.5, fill: cols[(row + x) % cols.length] }));
        x += bw + 0.5;
      }
    }
    return g;
  }
  function rpServerRack(w = 32, h = 64) {
    const g = svgEl('svg', { viewBox: '0 0 32 64', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 32, height: 64, rx: 2, fill: '#1c1f24' }));
    g.appendChild(svgEl('rect', { x: 2, y: 2, width: 28, height: 60, rx: 1, fill: '#11131a' }));
    for (let i = 0; i < 6; i++) {
      const y = 5 + i * 9;
      g.appendChild(svgEl('rect', { x: 4, y, width: 24, height: 7, rx: 1, fill: '#22303a' }));
      // Blinking LEDs — each gets a stagger so the rack reads as "alive".
      const ledA = svgEl('circle', { cx: 7, cy: y + 3.5, r: 1, fill: i % 2 ? '#7fc8a0' : '#e0a458', class: 'server-led' });
      ledA.style.animationDelay = (i * 0.18) + 's';
      g.appendChild(ledA);
      const ledB = svgEl('circle', { cx: 11, cy: y + 3.5, r: 1, fill: '#5b8def', class: 'server-led' });
      ledB.style.animationDelay = (i * 0.13 + 0.4) + 's';
      g.appendChild(ledB);
      // vent slits
      for (let v = 0; v < 4; v++) g.appendChild(svgEl('rect', { x: 16 + v * 2.4, y: y + 2, width: 1, height: 3, fill: '#0f1720' }));
    }
    return g;
  }
  /** Dual-monitor desk for the Running room — screens scroll a binary stream. */
  function rpDualMonitor(w = 64, h = 44) {
    const g = svgEl('svg', { viewBox: '0 0 64 44', class: 'desk dual-monitor', width: w, height: h });
    // back wall countertop
    g.appendChild(svgEl('rect', { x: 2, y: 32, width: 60, height: 10, rx: 1, fill: '#8d6a4a' }));
    g.appendChild(svgEl('rect', { x: 6, y: 41, width: 4, height: 3, fill: '#6b4f36' }));
    g.appendChild(svgEl('rect', { x: 54, y: 41, width: 4, height: 3, fill: '#6b4f36' }));
    // monitor 1
    g.appendChild(svgEl('rect', { x: 4, y: 6, width: 26, height: 22, rx: 1.5, fill: '#22303a' }));
    g.appendChild(svgEl('rect', { x: 6, y: 8, width: 22, height: 18, fill: '#0c1424' }));
    g.appendChild(svgEl('rect', { x: 15, y: 28, width: 4, height: 4, fill: '#22303a' }));
    g.appendChild(svgEl('rect', { x: 12, y: 32, width: 10, height: 1.6, fill: '#22303a' }));
    // monitor 2
    g.appendChild(svgEl('rect', { x: 34, y: 6, width: 26, height: 22, rx: 1.5, fill: '#22303a' }));
    g.appendChild(svgEl('rect', { x: 36, y: 8, width: 22, height: 18, fill: '#0c1424' }));
    g.appendChild(svgEl('rect', { x: 45, y: 28, width: 4, height: 4, fill: '#22303a' }));
    g.appendChild(svgEl('rect', { x: 42, y: 32, width: 10, height: 1.6, fill: '#22303a' }));
    // Binary text streams — a tall column of "1010..." lines clipped to the
    // screen bezel and slid upward via CSS so it reads as live activity. Each
    // SVG instance gets unique clipPath IDs so multiple desks could coexist.
    const uid = (rpDualMonitor._n = (rpDualMonitor._n || 0) + 1);
    const id1 = `dm-clip-1-${uid}`;
    const id2 = `dm-clip-2-${uid}`;
    const clip1 = svgEl('clipPath', { id: id1 });
    clip1.appendChild(svgEl('rect', { x: 6, y: 8, width: 22, height: 18 }));
    g.appendChild(clip1);
    const clip2 = svgEl('clipPath', { id: id2 });
    clip2.appendChild(svgEl('rect', { x: 36, y: 8, width: 22, height: 18 }));
    g.appendChild(clip2);
    const binaryLines = [
      '10101100', '01101001', '11010101', '10010110',
      '00111001', '11100100', '01011011', '10110010',
      '11001011', '01010110', '10111001', '11010011',
    ];
    const makeStream = (clipId, cxScreen, delay) => {
      const wrap = svgEl('g', { 'clip-path': `url(#${clipId})` });
      const ticker = svgEl('g', { class: 'dm-ticker' });
      ticker.style.animationDelay = delay + 's';
      binaryLines.forEach((b, i) => {
        const t = svgEl('text', {
          x: cxScreen, y: 11 + i * 4,
          'font-size': 3.4,
          'font-family': 'ui-monospace, Consolas, monospace',
          'text-anchor': 'middle',
          fill: '#7fc8a0',
        });
        t.textContent = b;
        ticker.appendChild(t);
      });
      wrap.appendChild(ticker);
      return wrap;
    };
    // Screen 1 spans x 6..28 → centre 17; screen 2 spans 36..58 → centre 47.
    g.appendChild(makeStream(id1, 17, 0));
    g.appendChild(makeStream(id2, 47, -1.7));
    return g;
  }
  function rpWhiteboard(w = 60, h = 36) {
    const g = svgEl('svg', { viewBox: '0 0 60 36', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 60, height: 36, rx: 1.5, fill: '#cccccc' }));    // frame
    g.appendChild(svgEl('rect', { x: 2, y: 2, width: 56, height: 30, fill: '#fafafa' }));              // board
    // doodles
    g.appendChild(svgEl('path', { d: 'M6 10h14M6 14h10M6 18h18', stroke: '#5b8def', 'stroke-width': 1, fill: 'none', 'stroke-linecap': 'round' }));
    g.appendChild(svgEl('rect', { x: 30, y: 6, width: 14, height: 8, fill: 'none', stroke: '#c25d6b', 'stroke-width': 1 }));
    g.appendChild(svgEl('path', { d: 'M30 22l6 4 8-6 4 4', stroke: '#5fae8c', 'stroke-width': 1, fill: 'none', 'stroke-linecap': 'round' }));
    g.appendChild(svgEl('rect', { x: 2, y: 32, width: 56, height: 2, fill: '#9a9286' }));              // tray
    return g;
  }
  function rpPlant(w = 22, h = 30) {
    const g = svgEl('svg', { viewBox: '0 0 22 30', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('path', { d: 'M11 18C5 18 2 12 2 5c5 0 9 4 9 13zM11 18c6 0 9-6 9-13-5 0-9 4-9 13z', fill: '#5fae8c' }));
    g.appendChild(svgEl('path', { d: 'M11 12c-4 0-6-3-6-7 3 0 6 2 6 7zM11 12c4 0 6-3 6-7-3 0-6 2-6 7z', fill: '#7fc8a0', opacity: 0.8 }));
    g.appendChild(svgEl('path', { d: 'M6 18h10l-1.5 10H7.5z', fill: '#b06a4a' }));
    return g;
  }
  function rpLamp(w = 18, h = 36) {
    const g = svgEl('svg', { viewBox: '0 0 18 36', class: 'desk', width: w, height: h });
    // soft circular glow around the bulb — pulses when the room has an agent
    g.appendChild(svgEl('circle', { cx: 9, cy: 9, r: 8, fill: '#fff1c4', opacity: 0.2, class: 'rd-glow' }));
    g.appendChild(svgEl('ellipse', { cx: 9, cy: 34, rx: 6, ry: 1.5, fill: '#2b2620' }));      // base
    g.appendChild(svgEl('rect', { x: 8, y: 12, width: 2, height: 22, fill: '#5a4636' }));     // pole
    g.appendChild(svgEl('path', { d: 'M2 12 L16 12 L13 4 L5 4 z', fill: '#e0a458' }));        // shade
    g.appendChild(svgEl('circle', { cx: 9, cy: 12, r: 1.5, fill: '#fff1c4' }));               // bulb glow
    return g;
  }
  function rpRug(w = 80, h = 32, tint = '#c25d6b') {
    const g = svgEl('svg', { viewBox: '0 0 80 32', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('ellipse', { cx: 40, cy: 16, rx: 38, ry: 14, fill: tint, opacity: 0.55 }));
    g.appendChild(svgEl('ellipse', { cx: 40, cy: 16, rx: 30, ry: 10, fill: 'none', stroke: '#fff', 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0.5 }));
    return g;
  }
  function rpStickyBoard(w = 28, h = 28) {
    const g = svgEl('svg', { viewBox: '0 0 28 28', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 28, height: 28, rx: 1, fill: '#5a4636' })); // cork
    const cols = ['#fde68a','#fca5a5','#a7f3d0','#bfdbfe','#fbcfe8'];
    const cells = [[2,2],[12,2],[22,2],[2,12],[12,12],[2,22]];
    cells.forEach(([x,y], i) => g.appendChild(svgEl('rect', { x, y, width: 5, height: 5, fill: cols[i % cols.length] })));
    return g;
  }
  /** Retro pixel "data transfer" window for the Browsing room: a globe on
   *  the left, a computer on the right, documents flying from globe to
   *  computer and a progress bar at the bottom. Colours come from the app
   *  theme (--bg-elev / --border / --accent) so it doesn't clash with the
   *  rest of the office; animations only run when an agent is present. */
  function rpFileTransfer(w = 100, h = 70) {
    const g = svgEl('svg', { viewBox: '0 0 100 70', class: 'desk file-transfer', width: w, height: h });
    // outer pixel window frame (border = themed light line; surface = themed
    // elevated background)
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 100, height: 70, class: 'ft-frame' }));
    g.appendChild(svgEl('rect', { x: 2, y: 2, width: 96, height: 66, class: 'ft-surface' }));
    // title bar (separator line)
    g.appendChild(svgEl('rect', { x: 2, y: 7, width: 96, height: 0.6, class: 'ft-frame' }));
    // window control glyphs
    g.appendChild(svgEl('rect', { x: 82, y: 4, width: 2, height: 0.6, class: 'ft-frame' }));    // _
    g.appendChild(svgEl('rect', { x: 87, y: 3, width: 3, height: 3, fill: 'none', class: 'ft-stroke' })); // □
    g.appendChild(svgEl('path', { d: 'M93 3 L96 6 M96 3 L93 6', class: 'ft-stroke' }));         // ×
    // === Globe icon (LEFT, "source") — a blue earth with continent blobs ===
    const cx1 = 25, cy = 32, r = 10;
    g.appendChild(svgEl('circle', { cx: cx1, cy, r, fill: '#3a6fa8' }));                       // ocean
    g.appendChild(svgEl('circle', { cx: cx1, cy, r: r - 1, fill: 'none', stroke: '#5b8def', 'stroke-width': 0.6 }));
    // continents — three irregular blobs
    g.appendChild(svgEl('path', { d: `M${cx1 - 6} ${cy - 4} q3 -2 6 0 q1 3 -2 4 q-5 0 -4 -4 z`, fill: '#5fae8c' }));
    g.appendChild(svgEl('path', { d: `M${cx1 + 1} ${cy + 1} q4 -1 5 3 q-2 3 -5 2 q-2 -2 0 -5 z`, fill: '#5fae8c' }));
    g.appendChild(svgEl('path', { d: `M${cx1 - 4} ${cy + 3} q2 -1 3 1 q0 2 -3 1 z`, fill: '#5fae8c' }));
    // latitude / longitude hint lines
    g.appendChild(svgEl('path', { d: `M${cx1 - r} ${cy} h${r * 2}`, stroke: '#5b8def', 'stroke-width': 0.4, opacity: 0.5 }));
    g.appendChild(svgEl('path', { d: `M${cx1} ${cy - r} v${r * 2}`, stroke: '#5b8def', 'stroke-width': 0.4, opacity: 0.5 }));
    // === Computer icon (RIGHT, "destination") — pixel monitor + base ===
    const cx2 = 75;
    g.appendChild(svgEl('rect', { x: cx2 - 12, y: cy - 9,  width: 24, height: 16, rx: 1, class: 'ft-stroke', fill: 'none', 'stroke-width': 1.4 })); // monitor frame
    g.appendChild(svgEl('rect', { x: cx2 - 10, y: cy - 7,  width: 20, height: 12, fill: '#3a6fa8' }));                  // screen
    // tiny "browser tabs" + 2 horizontal lines on screen
    g.appendChild(svgEl('rect', { x: cx2 - 9, y: cy - 6, width: 5, height: 1.5, fill: '#fafafa' }));
    g.appendChild(svgEl('rect', { x: cx2 - 9, y: cy - 3, width: 16, height: 0.8, fill: '#fafafa', opacity: 0.7 }));
    g.appendChild(svgEl('rect', { x: cx2 - 9, y: cy - 1, width: 12, height: 0.8, fill: '#fafafa', opacity: 0.7 }));
    g.appendChild(svgEl('rect', { x: cx2 - 9, y: cy + 1, width: 14, height: 0.8, fill: '#fafafa', opacity: 0.7 }));
    // stand + base
    g.appendChild(svgEl('rect', { x: cx2 - 2, y: cy + 7, width: 4, height: 3, class: 'ft-stroke', fill: 'none', 'stroke-width': 1.2 }));
    g.appendChild(svgEl('rect', { x: cx2 - 8, y: cy + 10, width: 16, height: 2, class: 'ft-stroke', fill: 'none', 'stroke-width': 1.2 }));
    // === Documents flying from globe to computer ===
    const doc = (cls) => {
      const dg = svgEl('g', { class: cls });
      dg.appendChild(svgEl('rect', { x: -3, y: -4, width: 6, height: 8, class: 'ft-doc-paper' }));
      dg.appendChild(svgEl('text', { x: 0, y: 1.5, 'text-anchor': 'middle', 'font-size': 5, 'font-weight': 700, class: 'ft-doc-letter', 'font-family': 'ui-monospace, Consolas, monospace' }))
        .textContent = 'B';
      return dg;
    };
    // Trajectory: docs hop from above the left folder to above the right
    // folder. CSS sets transform-origin + animation; idle rooms hide them.
    const flyer1 = svgEl('g', { class: 'ft-doc ft-doc-1' });
    flyer1.appendChild(doc(''));
    g.appendChild(flyer1);
    const flyer2 = svgEl('g', { class: 'ft-doc ft-doc-2' });
    flyer2.appendChild(doc(''));
    g.appendChild(flyer2);
    // === Progress bar: frame + 10 segments that fade in sequentially via
    // staggered animation-delay (see CSS .ft-seg). Re-runs on a loop. ===
    g.appendChild(svgEl('rect', { x: 10, y: 50, width: 80, height: 8, fill: 'none', class: 'ft-stroke', 'stroke-width': 1 }));
    for (let i = 0; i < 10; i++) {
      const seg = svgEl('rect', { x: 12 + i * 7.6, y: 52, width: 6, height: 4, class: 'ft-seg' });
      seg.style.animationDelay = (i * 0.18) + 's';
      g.appendChild(seg);
    }
    return g;
  }
  /** Whiteboard with a "CASE #" header banner + a pinned polaroid in the
   *  corner — gives the Searching room a clear "investigation HQ" read. */
  function rpCaseboard(w = 110, h = 50) {
    const g = svgEl('svg', { viewBox: '0 0 110 50', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 110, height: 50, rx: 1.5, fill: '#cccccc' })); // frame
    g.appendChild(svgEl('rect', { x: 2, y: 2, width: 106, height: 42, fill: '#fafafa' }));           // board
    // CASE # banner stripe at the top of the board
    g.appendChild(svgEl('rect', { x: 4, y: 4, width: 60, height: 7, fill: '#c25d3c' }));
    g.appendChild(svgEl('text', {
      x: 7, y: 9.5, fill: '#fafafa',
      'font-size': 5, 'font-weight': 700,
      'font-family': 'ui-monospace, Consolas, monospace',
    })).textContent = 'CASE #047';
    // Doodles: timeline arrow + a couple of clue boxes + connecting line
    g.appendChild(svgEl('path', { d: 'M8 22 L98 22', stroke: '#5b8def', 'stroke-width': 1, fill: 'none' }));
    g.appendChild(svgEl('path', { d: 'M94 19 L98 22 L94 25', stroke: '#5b8def', 'stroke-width': 1, fill: 'none' }));
    g.appendChild(svgEl('rect', { x: 10, y: 26, width: 14, height: 9, fill: 'none', stroke: '#5fae8c', 'stroke-width': 0.9 }));
    g.appendChild(svgEl('rect', { x: 32, y: 26, width: 14, height: 9, fill: 'none', stroke: '#5fae8c', 'stroke-width': 0.9 }));
    g.appendChild(svgEl('rect', { x: 54, y: 26, width: 14, height: 9, fill: 'none', stroke: '#5fae8c', 'stroke-width': 0.9 }));
    g.appendChild(svgEl('path', { d: 'M24 30.5 L32 30.5 M46 30.5 L54 30.5', stroke: '#c25d3c', 'stroke-width': 0.8, fill: 'none' }));
    // A polaroid pinned to the top-right corner of the board (tilted)
    const card = svgEl('g', { transform: 'rotate(10 90 12)' });
    card.appendChild(svgEl('rect', { x: 84, y: 5, width: 12, height: 14, fill: '#fafafa', stroke: '#9a9286', 'stroke-width': 0.4 }));
    card.appendChild(svgEl('rect', { x: 85, y: 6, width: 10, height: 9, fill: '#3a4a63' }));
    g.appendChild(card);
    g.appendChild(svgEl('circle', { cx: 90, cy: 7, r: 0.9, fill: '#e06a5a' })); // pin
    // chalk tray
    g.appendChild(svgEl('rect', { x: 2, y: 44, width: 106, height: 4, fill: '#9a9286' }));
    // Magnifier — sweeps across the clue row when the room has an agent
    // (see CSS .room.has-agent .cb-magnifier). Sits idle off to the left
    // when nobody's investigating.
    const mag = svgEl('g', { class: 'cb-magnifier' });
    mag.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 5, fill: 'none', stroke: '#2b2620', 'stroke-width': 1.2 }));
    mag.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 4, fill: '#5b8def', opacity: 0.18 }));
    mag.appendChild(svgEl('path', { d: 'M3.5 3.5 L7 7', stroke: '#2b2620', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
    g.appendChild(mag);
    return g;
  }
  /** Detective's investigation board: cork with photo polaroids connected by
   *  red string + a couple of sticky notes. Classic "the case is connected!"
   *  look from noir/crime games and Pinterest detective rooms. */
  function rpInvestigationBoard(w = 38, h = 38) {
    const g = svgEl('svg', { viewBox: '0 0 38 38', class: 'desk', width: w, height: h });
    // cork backing + frame
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 38, height: 38, rx: 1, fill: '#3a2b22' })); // dark frame
    g.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: 35, height: 35, rx: 0.5, fill: '#7a5638' })); // cork
    // tiny grain dots on the cork
    [[5,8],[14,5],[24,9],[31,14],[8,18],[28,22],[16,27],[6,30],[26,32],[20,16]].forEach(([x,y]) =>
      g.appendChild(svgEl('circle', { cx: x, cy: y, r: 0.4, fill: '#5a3f28' })));
    // red strings — zigzag connecting the three photo "evidence" spots
    g.appendChild(svgEl('path', {
      d: 'M7 9 L18 18 L29 8 M18 18 L19 30',
      stroke: '#c25d3c', 'stroke-width': 0.9, fill: 'none', 'stroke-linecap': 'round',
    }));
    // photo polaroids — white card with a tiny dark "image" area, slightly tilted
    const polaroid = (x, y, rot, tone) => {
      const card = svgEl('g', { transform: `rotate(${rot} ${x + 4} ${y + 5})` });
      card.appendChild(svgEl('rect', { x, y, width: 8, height: 10, fill: '#fafafa', stroke: '#cccccc', 'stroke-width': 0.3 }));
      card.appendChild(svgEl('rect', { x: x + 1, y: y + 1, width: 6, height: 6, fill: tone }));
      g.appendChild(card);
    };
    polaroid(3, 4, -8, '#3a4a63');   // top-left
    polaroid(25, 3, 6, '#6b4f36');   // top-right
    polaroid(15, 25, -3, '#5a3f28'); // bottom-centre
    // pushpins (red dots) where the strings meet the photos
    [[7,9],[29,8],[19,30],[18,18]].forEach(([cx, cy]) =>
      g.appendChild(svgEl('circle', { cx, cy, r: 0.9, fill: '#e06a5a' })));
    // a couple of sticky notes tucked in the corners for colour
    g.appendChild(svgEl('rect', { x: 30, y: 22, width: 5, height: 5, fill: '#fde68a', transform: 'rotate(8 32.5 24.5)' }));
    g.appendChild(svgEl('rect', { x: 3, y: 22, width: 5, height: 5, fill: '#a7f3d0', transform: 'rotate(-6 5.5 24.5)' }));
    return g;
  }
  function rpCoffee(w = 12, h = 14) {
    const g = svgEl('svg', { viewBox: '0 0 12 14', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 2, y: 4, width: 7, height: 8, rx: 1, fill: '#fafafa' }));     // cup
    g.appendChild(svgEl('path', { d: 'M9 6c2 0 2 4 0 4', fill: 'none', stroke: '#fafafa', 'stroke-width': 1 }));
    g.appendChild(svgEl('rect', { x: 3, y: 5, width: 5, height: 2, fill: '#5a3f28' }));            // coffee
    g.appendChild(svgEl('path', { d: 'M4 3 q1 -2 0 -3 M6 3 q1 -2 0 -3', stroke: '#cccccc', 'stroke-width': 0.6, fill: 'none', opacity: 0.7 }));
    return g;
  }
  function rpFiles(w = 24, h = 22) {
    const g = svgEl('svg', { viewBox: '0 0 24 22', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 1, y: 6, width: 22, height: 14, rx: 1, fill: '#e0a458' }));
    g.appendChild(svgEl('rect', { x: 1, y: 4, width: 12, height: 4, rx: 0.5, fill: '#b97f2e' }));
    g.appendChild(svgEl('rect', { x: 3, y: 9, width: 18, height: 1, fill: '#b97f2e' }));
    g.appendChild(svgEl('rect', { x: 3, y: 12, width: 14, height: 1, fill: '#b97f2e' }));
    g.appendChild(svgEl('rect', { x: 3, y: 15, width: 16, height: 1, fill: '#b97f2e' }));
    return g;
  }
  function rpPoster(w = 32, h = 42, tint = '#5b8def') {
    const g = svgEl('svg', { viewBox: '0 0 32 42', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 32, height: 42, rx: 1, fill: '#1f2937' }));
    g.appendChild(svgEl('rect', { x: 2, y: 2, width: 28, height: 38, fill: tint, opacity: 0.85 }));
    g.appendChild(svgEl('circle', { cx: 16, cy: 18, r: 9, fill: 'none', stroke: '#fff', 'stroke-width': 1.4 }));
    g.appendChild(svgEl('path', { d: 'M16 9 l3 9 -3 9 -3 -9 z', fill: '#fff', opacity: 0.9 }));
    g.appendChild(svgEl('rect', { x: 6, y: 32, width: 20, height: 2, fill: '#fff' }));
    return g;
  }
  function rpRouter(w = 30, h = 16) {
    const g = svgEl('svg', { viewBox: '0 0 30 16', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 4, width: 30, height: 10, rx: 1.5, fill: '#22303a' }));
    [4,8,12,16,20,24].forEach((cx, i) => g.appendChild(svgEl('circle', { cx, cy: 9, r: 1, fill: i % 2 ? '#7fc8a0' : '#5b8def' })));
    g.appendChild(svgEl('path', { d: 'M6 4 l-2 -4 M14 4 l0 -4 M22 4 l2 -4', stroke: '#9a9286', 'stroke-width': 0.8, fill: 'none' }));
    return g;
  }
  function rpClock(w = 22, h = 22) {
    const g = svgEl('svg', { viewBox: '0 0 22 22', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('circle', { cx: 11, cy: 11, r: 10, fill: '#fafafa', stroke: '#2b2620', 'stroke-width': 1 }));
    g.appendChild(svgEl('path', { d: 'M11 11 V4 M11 11 l5 3', stroke: '#2b2620', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
    g.appendChild(svgEl('circle', { cx: 11, cy: 11, r: 0.8, fill: '#2b2620' }));
    return g;
  }
  function rpFileCabinet(w = 28, h = 40) {
    const g = svgEl('svg', { viewBox: '0 0 28 40', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 28, height: 40, rx: 1.5, fill: '#6b7280' }));
    for (let i = 0; i < 3; i++) {
      const y = 3 + i * 12;
      g.appendChild(svgEl('rect', { x: 2, y, width: 24, height: 10, rx: 1, fill: '#4b5563' }));
      g.appendChild(svgEl('circle', { cx: 14, cy: y + 5, r: 1, fill: '#cccccc' }));
    }
    return g;
  }
  /** Org-chart whiteboard for the Spawning room: a root node with child nodes
   *  branching out below. The child nodes pulse one-by-one (subagents
   *  "spawning") when the room has an agent — CSS .org-node animation. */
  function rpOrgChart(w = 70, h = 50) {
    const g = svgEl('svg', { viewBox: '0 0 70 50', class: 'desk', width: w, height: h });
    // frame + board
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: 70, height: 50, rx: 1.5, fill: '#cccccc' }));
    g.appendChild(svgEl('rect', { x: 2, y: 2, width: 66, height: 42, fill: '#fafafa' }));
    // connecting lines first (so nodes paint on top)
    g.appendChild(svgEl('path', {
      d: 'M35 17 L35 24 M15 30 L15 24 L55 24 L55 30 M35 24 L35 30',
      stroke: '#9a9286', 'stroke-width': 1, fill: 'none',
    }));
    // root node (top centre)
    g.appendChild(svgEl('circle', { cx: 35, cy: 13, r: 4, fill: '#5b8def', stroke: '#2b2620', 'stroke-width': 0.6 }));
    // three child nodes — class lets CSS pulse them when has-agent
    [[15, 34], [35, 34], [55, 34]].forEach(([cx, cy], i) => {
      const node = svgEl('circle', { cx, cy, r: 3.5, fill: '#7fc8a0', stroke: '#2b2620', 'stroke-width': 0.5, class: 'org-node' });
      node.style.animationDelay = (i * 0.4) + 's';
      g.appendChild(node);
    });
    // chalk tray
    g.appendChild(svgEl('rect', { x: 2, y: 44, width: 66, height: 4, fill: '#9a9286' }));
    return g;
  }
  function rpStool(w = 18, h = 22) {
    const g = svgEl('svg', { viewBox: '0 0 18 22', class: 'desk', width: w, height: h });
    g.appendChild(svgEl('ellipse', { cx: 9, cy: 8, rx: 7, ry: 3, fill: '#a07a52' }));
    g.appendChild(svgEl('rect', { x: 6, y: 9, width: 2, height: 10, fill: '#6b4f36' }));
    g.appendChild(svgEl('rect', { x: 10, y: 9, width: 2, height: 10, fill: '#6b4f36' }));
    return g;
  }

  /**
   * Place extra furniture inside a room. Returns an array of
   * { node, x, y } so caller can append each item at its own offset.
   * Coordinates are room-local (0..RW × 0..RH). The main desk + label sit at
   * the top centre, the door is on the lounge-facing edge, and avatars stand
   * along the bottom — props avoid those zones.
   */
  function roomFurniture(activity, side, RW, RH) {
    // Top-down layout rules (see plan):
    //   - Anchor goes on the back wall (y 22..50).
    //   - Side prop goes on the wall FAR FROM THE DOOR (y ~ 90..130).
    //   - Floor accent goes in the FAR-FROM-DOOR bottom corner (y ~ 130..150).
    //   - Nothing past y=150 → bottom 50px is the avatar lane.
    //   - The door sits on the inner edge at mid-height, so "far from door"
    //     means the OPPOSITE outer wall: side='L' (door on right) → far=left,
    //     side='R' (door on left) → far=right.
    const farIsLeft = side === 'L';
    const farX = (w, pad = 8) => farIsLeft ? pad : RW - w - pad;
    const out = [];
    const add = (node, x, y) => out.push({ node, x, y });
    switch (activity) {
      case 'writing': {
        // Coding — anchor = the monitor desk at the back-centre (default
        // deskSvg). Add a small bookshelf in the back FAR-corner, a desk lamp
        // on the FAR side wall, and a plant + coffee on the floor by the same
        // wall — every accent on the wall opposite the door.
        add(rpBookshelf(46, 48), farX(46), 30);
        add(rpLamp(16, 30),      farX(16), 90);
        add(rpPlant(20, 26),     farX(20), 124);
        add(rpCoffee(12, 14),    farX(12, 30), 130);
        break;
      }
      case 'reading': {
        // Reading — the library wall IS the anchor. Three bookshelves lined
        // up along the back wall make one visual unit ("the bookshelf row"),
        // then a reading lamp on the FAR side wall and a stool in the FAR
        // corner. No floor plant — the wall does enough heavy lifting.
        const shelfW = 60, shelfH = 50, count = 3;
        const totalW = shelfW * count + (count - 1) * 4;
        const startX = (RW - totalW) / 2;
        for (let i = 0; i < count; i++) {
          add(rpBookshelf(shelfW, shelfH), startX + i * (shelfW + 4), 26);
        }
        add(rpLamp(18, 34),  farX(18), 96);
        add(rpStool(20, 22), farX(20), 138);
        break;
      }
      case 'running': {
        // Ops / server room — anchor is a cluster of two server racks on the
        // FAR end of the back wall (away from the door). A whiteboard chart
        // on the OTHER end of the back wall acts as the secondary accent, and
        // a small file stack sits in the FAR-side corner on the floor.
        const rackW = 28, rackH = 58, rackPad = 8;
        const rack1 = farX(rackW * 2 + rackPad, 12);   // x of cluster start (far side)
        add(rpServerRack(rackW, rackH), rack1,               26);
        add(rpServerRack(rackW, rackH), rack1 + rackW + rackPad, 26);
        // whiteboard chart at the opposite back-corner
        add(rpWhiteboard(64, 36), farIsLeft ? RW - 76 : 12, 30);
        // Dual-monitor workstation centred on the back wall, between the
        // server cluster (far side) and the whiteboard (near side). Binary
        // streams on the screens only scroll while an agent is in the room
        // — see CSS .room.has-agent .dm-ticker.
        add(rpDualMonitor(70, 48), Math.round(RW / 2 - 35), 26);
        break;
      }
      case 'searching': {
        // Investigation wall — a CASE board with doodles + pinned polaroid
        // anchors the back wall, flanked by a detective's cork board (photos
        // strung together with red thread) on one side and a small plant on
        // the other. Side walls + floor stay clear for the avatar.
        add(rpCaseboard(110, 50),         Math.round(RW / 2 - 55), 22);
        add(rpInvestigationBoard(40, 40), farIsLeft ? 10 : RW - 50, 28);
        add(rpPlant(22, 28),              farIsLeft ? RW - 32 : 10, 32);
        break;
      }
      case 'browsing': {
        // Explorer / data-fetcher — the centrepiece is a retro pixel
        // "file transfer" window with two folders, flying docs and a
        // progress bar that runs while an agent is in the room. A poster
        // on the far back-corner and a plant in the floor-corner give the
        // wall some warmth without competing with the centre.
        add(rpFileTransfer(120, 80),        Math.round(RW / 2 - 60), 18);
        add(rpPoster(28, 38, '#c08adb'),    farIsLeft ? 10 : RW - 38, 26);
        add(rpPlant(22, 28),                farIsLeft ? RW - 32 : 10, 30);
        break;
      }
      case 'spawning': {
        // Orchestrator — three filing cabinets line the back wall as a
        // "filing row" (anchor) and an org-chart whiteboard sits on the
        // FAR side wall, with child nodes pulsing as sub-agents spawn.
        const cabW = 28, cabH = 42, cabPad = 6;
        const totalW = cabW * 3 + cabPad * 2;
        const startX = Math.round((RW - totalW) / 2);
        for (let i = 0; i < 3; i++) {
          add(rpFileCabinet(cabW, cabH), startX + i * (cabW + cabPad), 26);
        }
        add(rpOrgChart(70, 50), farIsLeft ? 6 : RW - 76, 95);
        break;
      }
    }
    return out;
  }

  /** Build the static floor once: central lounge + 6 edge rooms + furniture. */
  function buildFloor() {
    if (built || !$floor) return;
    built = true;
    $floor.style.setProperty('--floor-w', WORLD_W + 'px');
    $floor.style.setProperty('--floor-h', WORLD_H + 'px');

    // Central lounge (drawn first, sits under the rooms' shadows).
    const lz = ZONES.get('lounge');
    const lounge = el('div', 'lounge');
    lounge.style.cssText = `left:${lz.x}px;top:${lz.y}px;width:${lz.w}px;height:${lz.h}px`;
    // Wall-mounted TV at the top of the lounge showing live Recent Activity.
    const tv = el('div', 'lounge-tv');
    tv.style.cssText = `left:${lz.w / 2 - 170}px;top:8px;width:340px`;
    tv.innerHTML = '<div class="tv-bezel"><div class="tv-head">▌ Recent Activity</div>'
      + '<div id="office-tv" class="tv-feed"></div></div><div class="tv-stand"></div>';
    lounge.appendChild(tv);
    // Lounge props: meeting table (upper), sofa (lower), plants + vending (corners),
    // and two arcade cabinets at the bottom corners where idle agents go to play.
    const addProp = (svg, x, y) => { svg.style.cssText = `left:${x}px;top:${y}px`; lounge.appendChild(svg); };
    // Long meeting table sits lower so it isn't crammed under the TV — the
    // sofa stays in the lower half.
    addProp(loungeProp('table'), lz.w / 2 - 90, lz.h * 0.38);
    addProp(loungeProp('sofa'),  lz.w / 2 - 55, lz.h * 0.7);
    // A digital wall clock at the top-left corner of the lounge — replaces
    // the old water cooler in that slot so the top wall reads as "snack
    // corner + clock + TV" instead of "water + TV + vending".
    addProp(loungeProp('digitalclock'), 14, 14);
    // End tables + warm lamps flanking the sofa — the cozy "living-room"
    // touch. Lamps render in front of the tables since they're added after.
    const sofaY = lz.h * 0.7;
    addProp(loungeProp('endtable'), lz.w / 2 - 86, sofaY + 8);    // left of sofa
    addProp(loungeProp('endtable'), lz.w / 2 + 64, sofaY + 8);    // right of sofa
    addProp(loungeProp('warmlamp'), lz.w / 2 - 80, sofaY - 22);
    addProp(loungeProp('warmlamp'), lz.w / 2 + 70, sofaY - 22);
    // A rug under the sofa to anchor the lower half of the lounge.
    addProp(loungeProp('rug'),   lz.w / 2 - 50, sofaY + 30);
    // One pinball cabinet at the bottom-right corner of the lounge. Caps the
    // queue at two players (see playSlot) so it doesn't crowd the corner; the
    // right-corner plant is dropped to give the cabinet room to breathe.
    addProp(loungeProp('pinball'), lz.w - 16 - 40, lz.h - 110);
    addProp(loungeProp('plant'), 14, lz.h - 46);
    // Beverage vending machine — bigger and more legible (illuminated front,
    // visible cans). Drop the water cooler entirely (its slot is now the clock).
    addProp(loungeProp('soda'), lz.w - 62, 8);
    $floor.appendChild(lounge);
    $tv = lounge.querySelector('#office-tv');

    // Six edge rooms with a door on the lounge-facing edge.
    for (const def of ROOM_DEFS) {
      const room = ZONES.get(def.activity);
      const el2 = el('div', 'room');
      el2.dataset.activity = room.activity;
      el2.style.cssText = `left:${room.x}px;top:${room.y}px;width:${room.w}px;height:${room.h}px`;
      // Door cut into the inner wall (right edge for left col, left edge for right col).
      const door = el('div', 'room-door ' + (room.side === 'L' ? 'door-right' : 'door-left'));
      door.style.top = (room.door.y - room.y - 22) + 'px';
      el2.appendChild(door);
      el2.appendChild(el('span', 'room-label', LABELS[room.activity]));
      // Most rooms get a small zone icon at the top centre (writing's monitor,
      // running's terminal, etc.). A few rooms instead define their anchor
      // directly inside roomFurniture (a wall-spanning bookshelf for Reading,
      // a file-cabinet row for Spawning, …) so skip the small desk for those.
      const ROOMS_WITHOUT_DEFAULT_DESK = new Set(['reading', 'running', 'searching', 'browsing', 'spawning']);
      if (!ROOMS_WITHOUT_DEFAULT_DESK.has(room.activity)) {
        const desk = deskSvg(room.activity);
        desk.style.cssText = `left:${room.w / 2 - 40}px;top:8px`;
        el2.appendChild(desk);
      }
      // A scatter of extra props so the room reads as a real little workspace
      // (placed against the back/side walls, away from the door + the slot row
      // along the bottom where avatars stand).
      for (const item of roomFurniture(room.activity, room.side, room.w, room.h)) {
        item.node.style.cssText = `left:${item.x}px;top:${item.y}px`;
        el2.appendChild(item.node);
      }
      $floor.appendChild(el2);
    }
    fitFloor();
  }

  /** Bigger furniture for the central lounge. */
  function loungeProp(kind) {
    if (kind === 'table') { // long rectangular meeting table with chairs
      const g = svgEl('svg', { viewBox: '0 0 180 70', class: 'desk', width: 180, height: 70 });
      // chairs first so the table-top draws over them slightly
      // top row (4 chairs, facing the table)
      for (let i = 0; i < 4; i++) {
        const x = 24 + i * 40;
        g.appendChild(svgEl('rect', { x: x - 7, y: 4, width: 14, height: 5, rx: 1.5, fill: '#6b4f36' })); // backrest
        g.appendChild(svgEl('rect', { x: x - 7, y: 10, width: 14, height: 5, rx: 1.5, fill: '#8d6a4a' })); // seat
      }
      // bottom row (4 chairs)
      for (let i = 0; i < 4; i++) {
        const x = 24 + i * 40;
        g.appendChild(svgEl('rect', { x: x - 7, y: 55, width: 14, height: 5, rx: 1.5, fill: '#8d6a4a' }));  // seat
        g.appendChild(svgEl('rect', { x: x - 7, y: 61, width: 14, height: 5, rx: 1.5, fill: '#6b4f36' })); // backrest
      }
      // end chairs (head + foot of table)
      g.appendChild(svgEl('rect', { x: 0, y: 28, width: 5, height: 14, rx: 1.5, fill: '#6b4f36' }));   // left backrest
      g.appendChild(svgEl('rect', { x: 6, y: 28, width: 5, height: 14, rx: 1.5, fill: '#8d6a4a' }));   // left seat
      g.appendChild(svgEl('rect', { x: 169, y: 28, width: 5, height: 14, rx: 1.5, fill: '#8d6a4a' })); // right seat
      g.appendChild(svgEl('rect', { x: 175, y: 28, width: 5, height: 14, rx: 1.5, fill: '#6b4f36' })); // right backrest
      // table top
      g.appendChild(svgEl('rect', { x: 14, y: 18, width: 152, height: 34, rx: 4, fill: '#8d6a4a' }));   // base
      g.appendChild(svgEl('rect', { x: 18, y: 20, width: 144, height: 28, rx: 3, fill: '#a07a52' }));   // highlight surface
      // a small centrepiece: two cups + a tiny vase
      g.appendChild(svgEl('rect', { x: 40, y: 30, width: 4, height: 5, fill: '#fafafa' }));            // cup 1
      g.appendChild(svgEl('rect', { x: 56, y: 31, width: 4, height: 4, fill: '#fafafa' }));            // cup 2
      g.appendChild(svgEl('rect', { x: 88, y: 28, width: 4, height: 8, fill: '#5fae8c' }));            // vase
      g.appendChild(svgEl('circle', { cx: 90, cy: 27, r: 2, fill: '#c25d6b' }));                       // flower
      g.appendChild(svgEl('rect', { x: 130, y: 31, width: 8, height: 4, rx: 0.6, fill: '#fafafa' }));  // notepad
      return g;
    }
    if (kind === 'sofa') {
      const g = svgEl('svg', { viewBox: '0 0 110 44', class: 'desk', width: 110, height: 44 });
      g.appendChild(svgEl('rect', { x: 4, y: 10, width: 102, height: 30, rx: 8, fill: '#5a6b8c' }));
      g.appendChild(svgEl('rect', { x: 4, y: 4, width: 102, height: 14, rx: 7, fill: '#6b7da0' }));
      g.appendChild(svgEl('rect', { x: 0, y: 14, width: 12, height: 24, rx: 5, fill: '#6b7da0' }));
      g.appendChild(svgEl('rect', { x: 98, y: 14, width: 12, height: 24, rx: 5, fill: '#6b7da0' }));
      return g;
    }
    if (kind === 'vending') {
      const g = svgEl('svg', { viewBox: '0 0 36 48', class: 'desk', width: 36, height: 48 });
      g.appendChild(svgEl('rect', { x: 2, y: 2, width: 32, height: 44, rx: 3, fill: '#c0392b' }));
      g.appendChild(svgEl('rect', { x: 6, y: 6, width: 16, height: 26, rx: 2, fill: '#1b2733' }));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) g.appendChild(svgEl('rect', { x: 8 + c * 5, y: 8 + r * 8, width: 3, height: 5, fill: '#7fc8a0' }));
      g.appendChild(svgEl('rect', { x: 25, y: 8, width: 6, height: 18, rx: 1, fill: '#2b2620' }));
      return g;
    }
    if (kind === 'water') { // water cooler
      const g = svgEl('svg', { viewBox: '0 0 24 48', class: 'desk', width: 24, height: 48 });
      g.appendChild(svgEl('rect', { x: 5, y: 18, width: 14, height: 28, rx: 2, fill: '#e8eef2' }));
      g.appendChild(svgEl('path', { d: 'M7 18l5-12 5 12z', fill: '#5b8def', opacity: 0.8 }));
      return g;
    }
    if (kind === 'clock') { // wall clock above the meeting table
      const g = svgEl('svg', { viewBox: '0 0 22 22', class: 'desk', width: 22, height: 22 });
      g.appendChild(svgEl('circle', { cx: 11, cy: 11, r: 10, fill: '#fafafa', stroke: '#2b2620', 'stroke-width': 1 }));
      // 10:10 hands so it reads as a friendly clock face
      g.appendChild(svgEl('path', { d: 'M11 11 L5 8', stroke: '#2b2620', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
      g.appendChild(svgEl('path', { d: 'M11 11 L17 8', stroke: '#2b2620', 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
      g.appendChild(svgEl('circle', { cx: 11, cy: 11, r: 0.8, fill: '#2b2620' }));
      return g;
    }
    if (kind === 'rug') { // rug under the sofa to anchor the floor
      const g = svgEl('svg', { viewBox: '0 0 100 32', class: 'desk', width: 100, height: 32 });
      g.appendChild(svgEl('ellipse', { cx: 50, cy: 16, rx: 48, ry: 14, fill: '#c25d6b', opacity: 0.45 }));
      g.appendChild(svgEl('ellipse', { cx: 50, cy: 16, rx: 38, ry: 9, fill: 'none', stroke: '#fff', 'stroke-width': 0.8, 'stroke-dasharray': '4 3', opacity: 0.55 }));
      return g;
    }
    if (kind === 'digitalclock') {
      // Digital LED-style wall clock — black bezel with the live local time
      // (12-hour clock with AM/PM), updated by updateDigitalClocks() below.
      const g = svgEl('svg', { viewBox: '0 0 56 24', class: 'desk digital-clock', width: 56, height: 24 });
      g.appendChild(svgEl('rect', { x: 0, y: 0, width: 56, height: 24, rx: 2.5, fill: '#1c1f24' })); // bezel
      g.appendChild(svgEl('rect', { x: 2, y: 2, width: 52, height: 20, rx: 1.5, fill: '#0c1424' })); // screen
      // Time HH:MM (LED red, 7-seg-ish monospace)
      const time = svgEl('text', {
        x: 5, y: 17,
        'font-size': 14, 'font-weight': 700,
        'font-family': 'ui-monospace, Consolas, monospace',
        'letter-spacing': '0.5px',
        fill: '#e06a5a',
        class: 'dc-time',
      });
      time.textContent = '10:10';
      g.appendChild(time);
      // AM/PM indicator (smaller, stacked vertically off to the right)
      const meridiem = svgEl('text', {
        x: 50, y: 12,
        'text-anchor': 'middle',
        'font-size': 5.5, 'font-weight': 700,
        'font-family': 'ui-monospace, Consolas, monospace',
        fill: '#e06a5a',
        class: 'dc-meridiem',
      });
      meridiem.textContent = 'AM';
      g.appendChild(meridiem);
      // soft glow under the screen
      g.appendChild(svgEl('rect', { x: 4, y: 20, width: 48, height: 1, fill: '#e06a5a', opacity: 0.4, class: 'wl-glow' }));
      return g;
    }
    if (kind === 'soda') {
      // Beverage vending machine — illuminated front with shelves of cans.
      const g = svgEl('svg', { viewBox: '0 0 48 72', class: 'desk', width: 48, height: 72 });
      // body (warm red)
      g.appendChild(svgEl('rect', { x: 0, y: 0, width: 48, height: 72, rx: 3, fill: '#c25d3c' }));
      g.appendChild(svgEl('rect', { x: 2, y: 2, width: 44, height: 4, rx: 1, fill: '#e06a5a' }));     // top trim
      // top banner with logo (SODA letters)
      g.appendChild(svgEl('rect', { x: 4, y: 7, width: 40, height: 6, rx: 0.6, fill: '#fafafa' }));
      g.appendChild(svgEl('text', {
        x: 24, y: 11.6, 'text-anchor': 'middle', 'font-size': 4.2, 'font-weight': 700,
        fill: '#c25d3c', 'font-family': 'ui-monospace, Consolas, monospace',
      })).textContent = 'SODA';
      // glass window with shelves of cans
      g.appendChild(svgEl('rect', { x: 4, y: 16, width: 40, height: 40, rx: 1, fill: '#0c1424' })); // dark inside
      g.appendChild(svgEl('rect', { x: 5, y: 17, width: 38, height: 38, fill: '#1c2a40', opacity: 0.7 })); // glass tint
      // Three shelves of cans (different colours per row)
      const canColors = ['#5b8def', '#5fae8c', '#e0a458'];
      for (let row = 0; row < 3; row++) {
        const y = 19 + row * 12;
        // shelf
        g.appendChild(svgEl('rect', { x: 5, y: y + 10, width: 38, height: 0.6, fill: '#7a8294' }));
        // 5 cans per row
        for (let c = 0; c < 5; c++) {
          const x = 6.5 + c * 7;
          g.appendChild(svgEl('rect', { x, y, width: 5, height: 9, rx: 0.5, fill: canColors[row] }));     // can body
          g.appendChild(svgEl('rect', { x, y, width: 5, height: 1.2, fill: '#cccccc' }));                // top rim
        }
      }
      // payment + slot at the bottom
      g.appendChild(svgEl('rect', { x: 6, y: 58, width: 16, height: 10, rx: 0.6, fill: '#1c1f24' }));    // keypad
      // keypad buttons
      for (let r2 = 0; r2 < 3; r2++) for (let c2 = 0; c2 < 3; c2++) {
        g.appendChild(svgEl('rect', { x: 8 + c2 * 4, y: 60 + r2 * 3, width: 2.5, height: 2, rx: 0.3, fill: '#5b8def', opacity: 0.7 }));
      }
      // coin slot + delivery slot
      g.appendChild(svgEl('rect', { x: 26, y: 60, width: 16, height: 1.2, fill: '#2b2620' }));           // coin slot
      g.appendChild(svgEl('rect', { x: 26, y: 64, width: 16, height: 5, rx: 0.6, fill: '#1c1f24' }));    // delivery tray
      return g;
    }
    if (kind === 'endtable') { // small square end table beside the sofa
      const g = svgEl('svg', { viewBox: '0 0 24 18', class: 'desk', width: 24, height: 18 });
      // top
      g.appendChild(svgEl('rect', { x: 1, y: 1, width: 22, height: 11, rx: 1.5, fill: '#8d6a4a' }));
      g.appendChild(svgEl('rect', { x: 1, y: 1, width: 22, height: 3, rx: 1.5, fill: '#a07a52' })); // highlight
      // legs
      g.appendChild(svgEl('rect', { x: 2, y: 12, width: 3, height: 5, fill: '#6b4f36' }));
      g.appendChild(svgEl('rect', { x: 19, y: 12, width: 3, height: 5, fill: '#6b4f36' }));
      return g;
    }
    if (kind === 'warmlamp') { // floor lamp with warm glow — sits on end table
      const g = svgEl('svg', { viewBox: '0 0 18 30', class: 'desk warm-lamp', width: 18, height: 30 });
      // soft glow behind the shade
      g.appendChild(svgEl('circle', { cx: 9, cy: 9, r: 10, fill: '#fff1c4', opacity: 0.35, class: 'wl-glow' }));
      // shade (warm amber)
      g.appendChild(svgEl('path', { d: 'M3 12 L15 12 L13 4 L5 4 Z', fill: '#e0a458' }));
      // bulb glow at base of shade
      g.appendChild(svgEl('rect', { x: 5, y: 11, width: 8, height: 1.4, fill: '#fff1c4' }));
      // pole
      g.appendChild(svgEl('rect', { x: 8, y: 12, width: 2, height: 14, fill: '#5a4636' }));
      // base
      g.appendChild(svgEl('ellipse', { cx: 9, cy: 27, rx: 5, ry: 1.4, fill: '#2b2620' }));
      return g;
    }
    if (kind === 'arcade') { // upright arcade cabinet — purple, blinking screen
      const g = svgEl('svg', { viewBox: '0 0 40 60', class: 'desk arcade-cab', width: 40, height: 60 });
      g.appendChild(svgEl('rect', { x: 4, y: 2, width: 32, height: 56, rx: 4, fill: '#3a2a55' }));     // cabinet body
      g.appendChild(svgEl('rect', { x: 4, y: 0, width: 32, height: 8,  rx: 3, fill: '#5b3d8a' }));     // marquee
      g.appendChild(svgEl('rect', { x: 8, y: 10, width: 24, height: 18, rx: 2, fill: '#0c1424' }));    // screen frame
      g.appendChild(svgEl('rect', { x: 10, y: 12, width: 20, height: 14, class: 'arcade-screen', fill: '#5b8def' })); // screen (blinks via CSS)
      g.appendChild(svgEl('rect', { x: 8, y: 32, width: 24, height: 10, rx: 2, fill: '#241a36' }));    // control deck
      g.appendChild(svgEl('circle', { cx: 14, cy: 37, r: 2, fill: '#d97757' }));                       // joystick ball
      g.appendChild(svgEl('rect',   { x: 13, y: 37, width: 2, height: 4, fill: '#2b2620' }));          // joystick stick
      g.appendChild(svgEl('circle', { cx: 22, cy: 38, r: 1.6, fill: '#7fc8a0' }));                     // button A
      g.appendChild(svgEl('circle', { cx: 26, cy: 38, r: 1.6, fill: '#e0a458' }));                     // button B
      g.appendChild(svgEl('rect', { x: 6, y: 44, width: 28, height: 12, rx: 2, fill: '#241a36' }));    // base
      return g;
    }
    if (kind === 'pinball') { // pinball machine (tilted top)
      const g = svgEl('svg', { viewBox: '0 0 40 60', class: 'desk arcade-cab', width: 40, height: 60 });
      g.appendChild(svgEl('rect', { x: 4, y: 0, width: 32, height: 10, rx: 3, fill: '#7a3b5d' }));     // backbox
      g.appendChild(svgEl('rect', { x: 4, y: 10, width: 32, height: 38, rx: 4, fill: '#2b3b55' }));    // playfield body
      g.appendChild(svgEl('rect', { x: 7, y: 13, width: 26, height: 30, rx: 3, fill: '#0c1424' }));    // playfield glass
      g.appendChild(svgEl('circle', { cx: 14, cy: 22, r: 2, class: 'arcade-bumper', fill: '#e06a5a' }));
      g.appendChild(svgEl('circle', { cx: 24, cy: 19, r: 2, class: 'arcade-bumper', fill: '#7fc8a0' }));
      g.appendChild(svgEl('circle', { cx: 20, cy: 30, r: 1.6, class: 'arcade-bumper', fill: '#e0a458' }));
      g.appendChild(svgEl('rect',   { x: 12, y: 36, width: 6, height: 2, fill: '#5b8def' }));          // flipper L
      g.appendChild(svgEl('rect',   { x: 22, y: 36, width: 6, height: 2, fill: '#5b8def' }));          // flipper R
      g.appendChild(svgEl('rect', { x: 4, y: 48, width: 32, height: 10, rx: 2, fill: '#241a36' }));    // legs/base
      return g;
    }
    // plant (larger)
    const g = svgEl('svg', { viewBox: '0 0 32 40', class: 'desk', width: 32, height: 40 });
    g.appendChild(svgEl('path', { d: 'M16 22c-8 0-12-8-12-16 7 0 12 6 12 16zM16 22c8 0 12-8 12-16-7 0-12 6-12 16z', fill: '#5fae8c' }));
    g.appendChild(svgEl('path', { d: 'M9 22h14l-2 12H11z', fill: '#b06a4a' }));
    return g;
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

  // --- slot manager: non-overlapping spots per zone (+ group for the lounge) -
  const occupied = new Map(); // key (activity|activity:group) -> Set of indices
  function slotKey(zone, group) { return group ? zone.activity + ':' + group : zone.activity; }
  function slotsOf(zone, group) { return group ? zone.groups[group] : zone.slots; }
  function takeSlot(zone, group, entry) {
    const key = slotKey(zone, group);
    if (entry.slot && entry.slot.key === key) return entry.slot;
    releaseSlot(entry);
    const pool = slotsOf(zone, group);
    let set = occupied.get(key);
    if (!set) { set = new Set(); occupied.set(key, set); }
    let idx = pool.findIndex((_, i) => !set.has(i));
    // Overflow: grow the pool on the fly so extra agents stand somewhere new
    // (a wider ring / extra row) instead of stacking on top of someone else.
    if (idx < 0) {
      idx = pool.length;
      pool.push(pool.makeAt ? pool.makeAt(idx) : pool[idx % Math.max(1, pool.length)]);
    }
    set.add(idx);
    entry.slot = { key, idx, ...pool[idx] };
    return entry.slot;
  }
  function releaseSlot(entry) {
    if (!entry.slot) return;
    const set = occupied.get(entry.slot.key);
    if (set) set.delete(entry.slot.idx);
    entry.slot = null;
  }

  // --- routing: open-plan — travel through the central lounge ----------------
  // The lounge is an open space (no internal walls), so agents cross it freely.
  // A room is only entered/left through its door on the lounge-facing edge, and
  // every cross-lounge leg stays inside the lounge bounding box, so a path never
  // cuts through another room.
  function route(fromZone, toZone, toSlot) {
    const pts = [];
    const intoLounge = (z) => (z.kind === 'room'
      // step from the door out to a point just inside the lounge.
      ? { x: z.side === 'L' ? LOUNGE.x + 24 : LOUNGE.x + LOUNGE.w - 24, y: z.door.y }
      : null);

    if (fromZone === toZone) { pts.push({ x: toSlot.x, y: toSlot.y }); return pts; }

    // 1) leave the source: room → door → just inside lounge; lounge → current pos.
    if (fromZone.kind === 'room') {
      pts.push({ x: fromZone.door.x, y: fromZone.door.y }); // out the door
      pts.push(intoLounge(fromZone));                        // onto the lounge floor
    }
    // 2) cross the lounge toward the target's entry side (stay within lounge box).
    if (toZone.kind === 'room') {
      const entry = intoLounge(toZone);
      pts.push({ x: entry.x, y: entry.y });                  // to a point by B's door
      pts.push({ x: toZone.door.x, y: toZone.door.y });      // in through B's door
      pts.push({ x: toZone.door.x, y: toSlot.y });           // square off to the slot
      pts.push({ x: toSlot.x, y: toSlot.y });
    } else {
      // target is the lounge itself → just walk to the slot.
      pts.push({ x: toSlot.x, y: toSlot.y });
    }
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
    // Pinball cap is 2; whoever has been idle longest gets the cabinet (a
    // session that just crossed 10min shouldn't beat one idle for 30min).
    const ARCADE_IDLE_MS = 10 * 60 * 1000;
    const ARCADE_CAP = 2;
    const arcadeIds = new Set(
      visible
        .filter((s) => s.activity === 'idle' && (now - (s.mtime || 0)) > ARCADE_IDLE_MS)
        .sort((a, b) => (a.mtime || 0) - (b.mtime || 0))
        .slice(0, ARCADE_CAP)
        .map((s) => s.id),
    );
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
      let { zone: target, group } = zoneFor(s.activity);
      const inGame = arcadeIds.has(s.id);
      if (inGame) group = 'playing';
      // Re-route when the zone changes, or when the lounge sub-group changes
      // (e.g. idle → waiting both live in the lounge but at different clusters).
      if (entry.room !== target || entry.group !== group) {
        const fromRoom = entry.room;
        entry.room = target;
        entry.group = group;
        const slot = takeSlot(target, group, entry);
        if (fresh || !fromRoom) {
          // Appear at the zone's entry point, then stroll to the slot.
          placeAt(entry, { x: target.door.x, y: target.door.y });
          walkTo(entry, [{ x: slot.x, y: slot.y }]);
        } else {
          // Walk out through the lounge to the new zone.
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
      entry.realText = bubbleText(s);
      entry.inLounge = target.kind === 'lounge';
      entry.inGame = inGame;
    }
    // Drop avatars whose session vanished from the snapshot.
    for (const [id, entry] of agents) {
      if (!seen.has(id)) { clearTimeout(entry.stepTimer); releaseSlot(entry); entry.node.remove(); agents.delete(id); }
    }
    // Mark which work rooms currently hold an agent — used by CSS to pause
    // ambient room animations (server LEDs, monitor binary stream, …) when a
    // room is empty so the office doesn't keep blinking at no one.
    const populated = new Set();
    for (const [, entry] of agents) {
      if (entry.room && entry.room.kind === 'room') populated.add(entry.room.activity);
    }
    for (const roomEl of $floor.querySelectorAll('.room')) {
      roomEl.classList.toggle('has-agent', populated.has(roomEl.dataset.activity));
    }
    const n = agents.size;
    $count.textContent = `${n} agent${n === 1 ? '' : 's'}`;
    $empty.hidden = n > 0;
    if (started) applyBubbles();
    updateTV(visible);
  }

  /** Feed the lounge TV with the most recent activity across all agents. */
  function updateTV(sessions) {
    if (!$tv) return;
    const rows = [];
    for (const s of sessions) {
      const msgs = s.recentMessages || [];
      const last = msgs[msgs.length - 1];
      if (!last || !last.text) continue;
      rows.push({ ts: last.ts || s.mtime || 0, who: shortName(s), text: last.text });
    }
    rows.sort((a, b) => b.ts - a.ts);
    $tv.replaceChildren(...rows.slice(0, 8).map((r) => {
      const line = el('div', 'tv-line');
      line.appendChild(el('span', 'tv-who', clipName(r.who, 10)));
      const t = r.text.length > 46 ? r.text.slice(0, 46) + '…' : r.text;
      line.appendChild(el('span', 'tv-text', t));
      return line;
    }));
    if (!rows.length) $tv.replaceChildren(el('div', 'tv-line tv-empty', 'No activity yet.'));
  }

  // One bubble per room at a time (rotating) so bubbles never overlap.
  let rotateOffset = 0;
  function applyBubbles() {
    const perRoom = new Map(); // activity -> agents that have something to say
    for (const [, entry] of agents) {
      entry.node.classList.remove('show-bubble');
      // With chatter on, anyone can pipe up; off, only those with a real line.
      if (!entry.room || (!chatterEnabled && !entry.realText)) continue;
      const key = entry.room.activity;
      if (!perRoom.has(key)) perRoom.set(key, []);
      perRoom.get(key).push(entry);
    }
    for (const [, list] of perRoom) {
      const actives = list.filter((e) => e.active);
      const pickFrom = actives.length ? actives : list;
      const entry = pickFrom[rotateOffset % pickFrom.length];
      // Compose here (not in update) so banter rotates with the 3s timer.
      const text = composeBubble(entry.realText || '', !!entry.inLounge, !!entry.inGame);
      if (!text) continue;
      entry.node.querySelector('.bubble').textContent = text;
      entry.node.classList.add('show-bubble');
    }
  }

  /** Push the current local time into every .digital-clock SVG. Called on
   *  start + every 30s afterwards so the lounge clock stays in sync. */
  function updateDigitalClocks() {
    if (!$floor) return;
    const now = new Date();
    let h = now.getHours();
    const m = now.getMinutes();
    const meridiem = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const time = `${h}:${m < 10 ? '0' + m : m}`;
    for (const clock of $floor.querySelectorAll('.digital-clock')) {
      const t = clock.querySelector('.dc-time');
      const md = clock.querySelector('.dc-meridiem');
      if (t)  t.textContent  = time;
      if (md) md.textContent = meridiem;
    }
  }

  let rotateTimer = null;
  let clockTimer = null;
  function start() {
    if (started) return;
    started = true;
    buildFloor();
    updateDigitalClocks();
    applyBubbles();
    rotateTimer = setInterval(() => { rotateOffset++; applyBubbles(); }, 5000);
    clockTimer  = setInterval(updateDigitalClocks, 30000);
    window.addEventListener('resize', fitFloor);
  }
  function stop() {
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
    if (clockTimer)  { clearInterval(clockTimer);  clockTimer  = null; }
    window.removeEventListener('resize', fitFloor);
    started = false;
  }
  function redraw() {
    // Theme changed: re-tint avatars (rooms/desks use CSS vars and re-tint on
    // their own).
    for (const [, entry] of agents) {
      const act = entry.room ? entry.room.activity : 'idle';
      entry.node.style.setProperty('--agent-tint', activityColor(act));
    }
  }
  /** Re-pick bubbles now (e.g. chatter just toggled). */
  function refreshBubbles() { if (started) applyBubbles(); }

  return { start, stop, update, redraw, refreshBubbles };
})();

// --- office: classic mode (simple 3x3 grid of room cards) -----------------
// The original, lightweight Office: each room is a card, avatars wrap inside,
// and an activity change re-parents the avatar (a "jump", no walking). Kept as
// an alternative to the Pro open-plan view; the two are swapped by a switch.
const OfficeClassic = (() => {
  const $grid = document.getElementById('office-classic');
  const $count = document.getElementById('office-count');
  const $empty = document.getElementById('office-empty');
  const rooms = new Map(); // activity -> .oc-room element
  const agents = new Map();
  let started = false;

  for (const room of $grid ? $grid.querySelectorAll('.oc-room') : []) {
    rooms.set(room.dataset.activity, room);
  }
  function roomFor(activity) { return rooms.get(activity) || rooms.get('idle'); }
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
      default: return css('--text-dim');
    }
  }
  function bubbleText(s) {
    const msgs = s.recentMessages || [];
    const last = msgs[msgs.length - 1];
    if (!last || !last.text) return '';
    const t = last.text.trim();
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }
  const RECENT_MS = 30 * 60 * 1000;
  function isRecent(s, now) { return s.active || (now - (s.mtime || 0) < RECENT_MS); }
  function clipName(name, n = 12) { return name.length > n ? name.slice(0, n - 1) + '…' : name; }

  // Self-contained character drawer (same look as Pro; kept local so this
  // renderer has no dependency on OfficePro's private helpers).
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function hashId(id) { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const SKIN = ['#ffdbac', '#f2c9a0', '#e8b088', '#d99a6c', '#c1855a', '#8d5a3c', '#6b4423'];
  const HAIR = ['#2b2620', '#4a2f1a', '#5a3a22', '#8d5a3c', '#b06a2c', '#c08a4a', '#d4b483', '#9a9286', '#cfcfcf', '#3a3550', '#7a3b5d'];
  const HAT = ['#d97757', '#7fc8a0', '#c08adb', '#e0a458', '#5b8def', '#e06a5a'];
  const SHIRT = ['#d97757', '#7fc8a0', '#c08adb', '#e0a458', '#5b8def', '#5fae8c', '#c25d6b', '#6b7280', '#3a3550', '#b0894a'];
  const INK = '#2b2620';
  function makeAgentSvg(s, active) {
    const h = hashId(s.id);
    const bit = (sh) => (h >> sh) & 1, pick = (a, sh) => a[(h >> sh) % a.length];
    const skin = pick(SKIN, 2), hair = pick(HAIR, 5), shirt = pick(SHIRT, 21);
    const feminine = bit(28) === 1;
    const hairStyle = (feminine ? ['long', 'ponytail', 'bob', 'curly', 'sidePart'] : ['short', 'sidePart', 'buzz', 'curly', 'bald'])[(h >> 9) % 5];
    const hasHat = (h >> 13) % 10 < 3 && hairStyle !== 'long' && hairStyle !== 'ponytail';
    const hat = pick(HAT, 17), hasGlasses = (h >> 24) % 10 < 3;
    const svg = svgEl('svg', { viewBox: '0 0 40 40', class: 'agent-figure' });
    if (hairStyle === 'long') svg.appendChild(svgEl('path', { d: 'M8 18c-1 9 0 16 2 22h4c-2-7-2-14-1-21zM32 18c1 9 0 16-2 22h-4c2-7 2-14 1-21z', fill: hair }));
    else if (hairStyle === 'ponytail') svg.appendChild(svgEl('path', { d: 'M30 12c5 1 7 6 6 12-1 4-3 6-5 7l-2-3c2-1 3-3 3-6 0-4-2-7-4-8z', fill: hair }));
    svg.appendChild(svgEl('path', { d: 'M7 40c0-7 6-11 13-11s13 4 13 11z', fill: shirt }));
    svg.appendChild(svgEl('circle', { cx: 20, cy: 33, r: 2.2, class: 'fig-body' }));
    svg.appendChild(svgEl('circle', { cx: 11.5, cy: 18, r: 1.8, fill: skin }));
    svg.appendChild(svgEl('circle', { cx: 28.5, cy: 18, r: 1.8, fill: skin }));
    svg.appendChild(svgEl('circle', { cx: 20, cy: 17, r: 11, fill: skin }));
    if (hairStyle !== 'bald' && hairStyle !== 'buzz') {
      let d;
      if (hairStyle === 'short') d = 'M9 15a11 11 0 0 1 22 0c0-4-4-8-11-8S9 11 9 15z';
      else if (hairStyle === 'sidePart') d = 'M9 16c0-7 6-9 11-9s11 2 11 9c-3-3-7-4-11-4-2 3-7 2-11 4z';
      else if (hairStyle === 'curly') d = 'M8 16a12 5 0 0 1 24 0a4 4 0 0 0-4-5a4 4 0 0 0-8 0a4 4 0 0 0-8 0a4 4 0 0 0-4 5z';
      else if (hairStyle === 'bob') d = 'M8 20c0-10 5-13 12-13s12 3 12 13c0-6-2-9-4-9-3 0-4 2-8 2s-5-2-8-2c-2 0-4 3-4 9z';
      else if (hairStyle === 'long') d = 'M9 16a11 11 0 0 1 22 0c0-5-3-9-11-9S9 11 9 16z';
      else d = 'M9 15a11 11 0 0 1 22 0c0-5-4-8-11-8S9 10 9 15z';
      svg.appendChild(svgEl('path', { d, fill: hair }));
    } else if (hairStyle === 'buzz') svg.appendChild(svgEl('path', { d: 'M9.5 14a10.5 10.5 0 0 1 21 0a11 11 0 0 0-21 0z', fill: hair, opacity: 0.85 }));
    if (hasHat) { svg.appendChild(svgEl('path', { d: 'M9 13h22l-2-4a10 10 0 0 0-18 0z', fill: hat })); svg.appendChild(svgEl('rect', { x: 7, y: 12, width: 26, height: 2.4, rx: 1.2, fill: hat })); }
    svg.appendChild(svgEl('path', { d: 'M13.5 13.5h4', stroke: INK, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 }));
    svg.appendChild(svgEl('path', { d: 'M22.5 13.5h4', stroke: INK, 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.7 }));
    const eyeY = 17;
    if (active) { svg.appendChild(svgEl('circle', { cx: 16, cy: eyeY, r: 1.7, fill: INK })); svg.appendChild(svgEl('circle', { cx: 24, cy: eyeY, r: 1.7, fill: INK })); }
    else { svg.appendChild(svgEl('path', { d: `M14 ${eyeY}h4`, stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round' })); svg.appendChild(svgEl('path', { d: `M22 ${eyeY}h4`, stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round' })); }
    if (feminine) svg.appendChild(svgEl('path', { d: 'M13.6 16l-1-1M26.4 16l1-1', stroke: INK, 'stroke-width': 0.9, 'stroke-linecap': 'round' }));
    if (hasGlasses) { svg.appendChild(svgEl('circle', { cx: 16, cy: eyeY, r: 3, fill: 'none', stroke: INK, 'stroke-width': 1 })); svg.appendChild(svgEl('circle', { cx: 24, cy: eyeY, r: 3, fill: 'none', stroke: INK, 'stroke-width': 1 })); svg.appendChild(svgEl('path', { d: 'M19 17h2', stroke: INK, 'stroke-width': 1 })); }
    if (feminine) { svg.appendChild(svgEl('circle', { cx: 14, cy: 21, r: 1.6, fill: '#e8806f', opacity: 0.35 })); svg.appendChild(svgEl('circle', { cx: 26, cy: 21, r: 1.6, fill: '#e8806f', opacity: 0.35 })); }
    svg.appendChild(svgEl('path', { d: active ? 'M16 22q4 4 8 0' : 'M16 23h8', fill: 'none', stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
    return svg;
  }

  function makeAgent(s) {
    const node = el('div', 'agent oc-agent');     // oc-agent → CSS resets Pro's absolute layout
    node.dataset.id = s.id;
    node.title = shortName(s);
    node.appendChild(makeAgentSvg(s, !!s.active));
    node.appendChild(el('span', 'agent-name', clipName(shortName(s))));
    node.appendChild(el('div', 'bubble'));
    return node;
  }

  function update(sessions) {
    if (!$grid) return;
    const now = Date.now();
    const visible = sessions.filter((s) => isRecent(s, now));
    const seen = new Set();
    for (const s of visible) {
      seen.add(s.id);
      let entry = agents.get(s.id);
      if (!entry) { entry = { node: makeAgent(s), room: null, active: undefined }; agents.set(s.id, entry); }
      const target = roomFor(s.activity);
      if (target && entry.room !== target) {
        target.querySelector('.oc-room-floor').appendChild(entry.node);
        entry.room = target;
      }
      if (entry.active !== !!s.active) {
        entry.active = !!s.active;
        entry.node.replaceChild(makeAgentSvg(s, entry.active), entry.node.querySelector('.agent-figure'));
      }
      entry.node.style.setProperty('--agent-tint', activityColor(s.activity));
      entry.node.classList.toggle('active', !!s.active);
      entry.realText = bubbleText(s);
      // Treat the resting rooms as "lounge" for chatter weighting.
      entry.inLounge = ['idle', 'waiting', 'thinking'].includes(s.activity);
    }
    for (const [id, entry] of agents) {
      if (!seen.has(id)) { entry.node.remove(); agents.delete(id); }
    }
    const n = agents.size;
    $count.textContent = `${n} agent${n === 1 ? '' : 's'}`;
    $empty.hidden = n > 0;
    if (started) applyBubbles();
  }

  let rotateOffset = 0;
  function applyBubbles() {
    const perRoom = new Map();
    for (const [, entry] of agents) {
      entry.node.classList.remove('show-bubble');
      if (!entry.room || (!chatterEnabled && !entry.realText)) continue;
      if (!perRoom.has(entry.room)) perRoom.set(entry.room, []);
      perRoom.get(entry.room).push(entry);
    }
    for (const [, list] of perRoom) {
      const actives = list.filter((e) => e.active);
      const pickFrom = actives.length ? actives : list;
      const entry = pickFrom[rotateOffset % pickFrom.length];
      const text = composeBubble(entry.realText || '', !!entry.inLounge);
      if (!text) continue;
      entry.node.querySelector('.bubble').textContent = text;
      entry.node.classList.add('show-bubble');
    }
  }

  let rotateTimer = null;
  function start() {
    if (started) return;
    started = true;
    applyBubbles();
    rotateTimer = setInterval(() => { rotateOffset++; applyBubbles(); }, 5000);
  }
  function stop() { if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; } started = false; }
  function redraw() {
    for (const [, entry] of agents) {
      const act = entry.room ? entry.room.dataset.activity : 'idle';
      entry.node.style.setProperty('--agent-tint', activityColor(act));
    }
  }
  function refreshBubbles() { if (started) applyBubbles(); }
  return { start, stop, update, redraw, refreshBubbles };
})();

// --- office: coordinator — swap Classic ⇄ Pro, remember the choice ---------
const Office = (() => {
  const $pro = document.getElementById('office-pro');
  const $classic = document.getElementById('office-classic');
  const $seg = document.querySelector('.office-mode-seg');
  const $segBtns = $seg ? [...$seg.querySelectorAll('.seg-btn')] : [];
  const $chatter = document.getElementById('office-chatter');
  let mode = (() => { try { return localStorage.getItem('csm-office-mode') || 'pro'; } catch (e) { return 'pro'; } })();
  let latest = [];
  let active = false; // is the Office tab currently shown?
  const renderer = () => (mode === 'classic' ? OfficeClassic : OfficePro);

  function applyVisibility() {
    if ($pro) $pro.hidden = mode !== 'pro';
    if ($classic) $classic.hidden = mode !== 'classic';
    for (const b of $segBtns) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  // Chatter line-pool polling. We only poll while the Office is open AND
  // chatter is on — that poll is the server's "someone is watching" signal,
  // so `claude` is never spawned when nobody's looking.
  let pollTimer = null;
  async function pollChatter() {
    try {
      const data = await api(`/api/chatter?token=${encodeURIComponent(TOKEN)}`);
      applyLivePool(data && data.lines);
    } catch (e) { /* keep the static pool */ }
  }
  function startPolling() {
    if (pollTimer || !active || !chatterEnabled) return;
    pollChatter();                                  // prime now
    pollTimer = setInterval(pollChatter, 45000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function setMode(m) {
    if (m === mode) return;
    const leaving = renderer();
    if (leaving.stop) leaving.stop();
    mode = m === 'classic' ? 'classic' : 'pro';
    try { localStorage.setItem('csm-office-mode', mode); } catch (e) {}
    applyVisibility();
    renderer().start();
    renderer().update(latest);
  }

  function setChatter(on) {
    setChatterEnabled(on);
    if ($chatter) $chatter.checked = chatterEnabled;
    if (chatterEnabled) startPolling(); else stopPolling();
    if (renderer().refreshBubbles) renderer().refreshBubbles();
  }

  function start() {
    active = true;
    if ($chatter) $chatter.checked = chatterEnabled;
    applyVisibility();
    renderer().start();
    startPolling();
  }
  function update(sessions) { latest = sessions; renderer().update(sessions); }
  function redraw() { renderer().redraw(); }
  // Called when leaving the Office tab — stop spawning chatter server-side.
  function leave() { active = false; stopPolling(); }

  for (const b of $segBtns) b.addEventListener('click', () => setMode(b.dataset.mode));
  if ($chatter) $chatter.addEventListener('change', () => setChatter($chatter.checked));

  return { start, update, redraw, setMode, leave };
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
  else Office.leave(); // stop chatter polling when not viewing the office
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
