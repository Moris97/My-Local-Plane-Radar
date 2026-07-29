// /dev/icon_verify -- runs the real classification chain against every
// registration this receiver has actually recorded a type code for, so
// gaps in data/icon-types.json show up against real traffic instead of
// guesswork. Deliberately available in production (registered outside the
// NODE_ENV dev-tool gate in server.js) since it's useless without real
// accumulated data -- see dev/icon_verify.html's own hint text for the
// military-flag caveat (this page has no per-registration military bit,
// so tanker/AWACS-derivative civilian-code sharing can't be exercised
// here).
import { loadIconTypes, classifyIconKind } from './icon-classify.js';
import { VIEW_BOX, getIconPath } from './plane-icons.js';

// Stages that mean "the type table itself didn't resolve this" -- worth
// looking at first, same spirit as icon-types.html's _needsVerification
// highlighting but driven by real gaps instead of pre-flagged entries.
// 'category' is included for forward-compatibility (classifyIconKind()
// supports it) but can never actually occur from this page's data source
// today -- GET /api/stats/registrations has no per-registration ADS-B
// `category` field, only typeCode, so every row here either hits the type
// table or falls all the way through to 'unknown'.
const NEEDS_ATTENTION_STAGES = new Set(['category', 'unknown']);

function iconSwatch(icon) {
  return `<svg viewBox="${VIEW_BOX}" width="22" height="22" fill="none"><path d="${getIconPath(icon)}" fill="currentColor"/></svg>`;
}

function rowClass(stage) {
  if (stage === 'unknown') return 'unresolved';
  if (stage === 'category') return 'fallback';
  return '';
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

let rows = [];
let sortKey = 'stage';
let sortAsc = true;

// "Needs attention" stages sort first regardless of direction -- that's
// the whole point of this page, a plain alphabetical stage sort would bury
// 'unknown'/'category' between 'exact' and 'prefix'.
const STAGE_SORT_RANK = { unknown: 0, category: 1, prefix: 2, exact: 3, 'military-exact': 4, 'military-prefix': 4 };

function sortValue(row, key) {
  if (key === 'stage') return STAGE_SORT_RANK[row.stage] ?? 5;
  return row[key];
}

function applySort(list) {
  const sorted = [...list].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return av < bv ? -1 : 1;
  });
  return sortAsc ? sorted : sorted.reverse();
}

function render() {
  const query = document.getElementById('search').value.trim().toUpperCase();
  const attentionOnly = document.getElementById('needs-attention-only').checked;

  const filtered = rows.filter((row) => {
    const matchesQuery = !query
      || (row.typeCode ?? '').toUpperCase().includes(query)
      || row.registration.toUpperCase().includes(query)
      || row.icon.toUpperCase().includes(query);
    const matchesAttention = !attentionOnly || NEEDS_ATTENTION_STAGES.has(row.stage);
    return matchesQuery && matchesAttention;
  });

  const tbody = document.querySelector('#verify-table tbody');
  tbody.innerHTML = applySort(filtered).map((row) => `
    <tr class="${rowClass(row.stage)}">
      <td class="code">${row.typeCode ?? '—'}</td>
      <td class="code">${row.registration}</td>
      <td><div class="icon-cell">${iconSwatch(row.icon)}<span>${row.icon}</span></div></td>
      <td><span class="badge ${row.stage}">${row.stage}</span></td>
      <td>${row.timesSeen}</td>
      <td>${formatDate(row.lastSeenAt)}</td>
    </tr>
  `).join('') || '<tr><td colspan="6" class="empty">No registrations recorded yet.</td></tr>';

  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
  }
}

function renderSummary() {
  const unresolved = rows.filter((r) => r.stage === 'unknown').length;
  // No separate "resolved via category fallback" card -- see the
  // NEEDS_ATTENTION_STAGES comment above, that stage can't occur from
  // this page's data source, a permanently-zero counter would just be
  // misleading rather than informative.
  const stats = [
    { n: rows.length, label: 'registrations seen', warn: false },
    { n: rows.filter((r) => r.stage === 'exact' || r.stage === 'prefix').length, label: 'resolved via type table', warn: false },
    { n: unresolved, label: 'unresolved (unknown) -- add these to icon-types.json', warn: unresolved > 0 },
  ];
  document.getElementById('summary').innerHTML = stats.map((s) => `
    <div class="stat${s.warn ? ' warn' : ''}"><div class="n">${s.n}</div><div class="label">${s.label}</div></div>
  `).join('');
}

async function main() {
  await loadIconTypes();
  const registrations = await fetch('/api/stats/registrations').then((r) => r.json());

  rows = registrations.map((r) => {
    const { icon, stage } = classifyIconKind({ typeCode: r.typeCode });
    return { ...r, icon, stage };
  });

  renderSummary();
  render();

  document.getElementById('search').addEventListener('input', render);
  document.getElementById('needs-attention-only').addEventListener('change', render);
  for (const th of document.querySelectorAll('th[data-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = true;
      }
      render();
    });
  }
}

main();
