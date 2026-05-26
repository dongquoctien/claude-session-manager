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
const $branchFilter = document.getElementById('branch-filter');
const $hideOrphans = document.getElementById('hide-orphans');
const $chips = [...document.querySelectorAll('.chip[data-filter]')];

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
  $branchFilter.replaceChildren(new Option('All branches', ''));
  for (const b of branches) $branchFilter.appendChild(new Option(b, b));
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
$branchFilter.addEventListener('change', refresh);
$hideOrphans.addEventListener('change', refresh);

// --- boot -----------------------------------------------------------------

refresh();
// Light auto-refresh so new conversations show up without a manual reload.
setInterval(() => {
  if (document.visibilityState === 'visible' && document.activeElement !== $search) {
    refresh();
  }
}, 15000);
