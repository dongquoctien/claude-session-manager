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

const getSessions = (q) =>
  api(`/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((d) => d.sessions);

const openSession = (id, fork) =>
  api('/api/open', { method: 'POST', body: JSON.stringify({ id, fork }) });

// --- state ----------------------------------------------------------------

let allRows = []; // flat list of session objects in DOM order (for keyboard nav)
let activeIndex = -1;

const $list = document.getElementById('list');
const $search = document.getElementById('search');
const $fork = document.getElementById('fork');
const $refresh = document.getElementById('refresh');
const $toast = document.getElementById('toast');

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
    head.appendChild(el('span', 'group-label', label));
    if (items[0] && !items[0].cwdExists) {
      head.appendChild(el('span', 'badge missing', 'missing'));
    }
    head.appendChild(el('span', 'group-count', String(items.length)));
    group.appendChild(head);

    for (const s of items) {
      const row = el('button', 'row');
      row.dataset.id = s.id;

      const main = el('div', 'row-main');
      main.appendChild(el('div', 'row-title', s.title));
      const meta = el('div', 'row-meta');
      if (s.branch) meta.appendChild(el('span', 'branch', s.branch));
      meta.appendChild(el('span', 'when', timeAgo(s.mtime)));
      meta.appendChild(el('span', 'id', s.id.slice(0, 8)));
      if (s.titleSource !== 'aiTitle') {
        meta.appendChild(el('span', 'src', s.titleSource));
      }
      main.appendChild(meta);
      row.appendChild(main);

      const open = el('span', 'row-open', 'Open ▶');
      row.appendChild(open);

      row.addEventListener('click', () => doOpen(s));
      group.appendChild(row);
      allRows.push({ node: row, session: s });
    }
    $list.appendChild(group);
  }
}

// --- actions --------------------------------------------------------------

let toastTimer;
function toast(msg, kind = 'ok') {
  clearTimeout(toastTimer);
  $toast.textContent = msg;
  $toast.className = `toast show ${kind}`;
  toastTimer = setTimeout(() => {
    $toast.className = 'toast';
  }, 3500);
}

async function doOpen(s) {
  if (!s.cwdExists) {
    toast(`Folder missing — Claude may fail to resume:\n${s.cwd}`, 'warn');
  }
  try {
    const r = await openSession(s.id, $fork.checked);
    toast(`Opening “${r.title || s.title}” via ${r.terminal}`, 'ok');
  } catch (err) {
    toast(`Failed to open: ${err.message}`, 'err');
  }
}

let searchTimer;
async function refresh() {
  const q = $search.value;
  try {
    const sessions = await getSessions(q);
    render(sessions);
  } catch (err) {
    $list.innerHTML = '';
    $list.appendChild(el('div', 'empty err', `Error: ${err.message}`));
  }
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

// --- boot -----------------------------------------------------------------

refresh();
// Light auto-refresh so new conversations show up without a manual reload.
setInterval(() => {
  if (document.visibilityState === 'visible' && document.activeElement !== $search) {
    refresh();
  }
}, 15000);
