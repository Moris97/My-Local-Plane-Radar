// Flat manual-verification view over the real public/data/icon-types.json
// -- built alongside the Stage 3 table expansion (2026-07-29) so the
// ~35 lower-confidence entries flagged in the JSON's own
// `_needsVerification` field are easy to find and spot-check, instead of
// only existing as comments in the one-shot scratch script that generated
// the table.

// `_needsVerification` entries look like either:
//   "CODE1/CODE2/CODE3: reason text"   -- one or more specific type codes
//   "The entire helicopter block: ..." -- a general, non-code-specific note
// The first form is split into a per-code reason map; the second is shown
// as a standalone banner instead of trying to match it to a row.
function parseNeedsVerification(list) {
  const perCode = new Map();
  const general = [];
  const CODE_LIST_RE = /^[A-Z0-9]+(\/[A-Z0-9]+)*$/;
  for (const entry of list ?? []) {
    const [head, ...rest] = entry.split(':');
    const reason = rest.join(':').trim();
    if (CODE_LIST_RE.test(head.trim())) {
      for (const code of head.trim().split('/')) perCode.set(code, reason);
    } else {
      general.push(entry);
    }
  }
  return { perCode, general };
}

function renderGeneralNotes(general) {
  const container = document.getElementById('general-notes');
  container.innerHTML = general.map((note) => `<div class="note-banner">${note}</div>`).join('');
}

function renderSummary(data, perCode) {
  const exactCount = Object.keys(data.exact).length;
  const prefixCount = Object.keys(data.prefix).length;
  const militaryCount = Object.keys(data.military.exact).length;
  const stats = [
    { n: exactCount, label: 'exact entries' },
    { n: prefixCount, label: 'prefix entries' },
    { n: militaryCount, label: 'military-only overrides' },
    { n: exactCount + prefixCount + militaryCount, label: 'total' },
    { n: perCode.size, label: 'flagged for verification' },
  ];
  document.getElementById('summary').innerHTML = stats.map((s) => `
    <div class="stat"><div class="n">${s.n}</div><div class="label">${s.label}</div></div>
  `).join('');
}

function rowHtml(code, icon, kindBadge, perCode) {
  const reason = perCode.get(code);
  const flaggedClass = reason ? ' flagged' : '';
  const verifyBadge = reason ? '<span class="badge verify">VERIFY</span>' : '';
  const reasonHtml = reason ? `<div class="reason">${reason}</div>` : '';
  return `
    <tr class="${flaggedClass.trim()}" data-code="${code}" data-icon="${icon}">
      <td class="code">${code}</td>
      <td><span class="icon-name">${icon}</span><span class="badge ${kindBadge}">${kindBadge}</span></td>
      <td>${verifyBadge}${reasonHtml}</td>
    </tr>
  `;
}

function renderTable(tableId, entries, kindBadge, perCode) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  const rows = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, icon]) => rowHtml(code, icon, kindBadge, perCode));
  tbody.innerHTML = rows.join('') || '<tr><td colspan="3" class="empty">No entries.</td></tr>';
}

function applyFilters() {
  const query = document.getElementById('search').value.trim().toUpperCase();
  const verifyOnly = document.getElementById('verify-only').checked;
  for (const row of document.querySelectorAll('table tbody tr[data-code]')) {
    const matchesQuery = !query || row.dataset.code.includes(query) || row.dataset.icon.toUpperCase().includes(query);
    const matchesVerify = !verifyOnly || row.classList.contains('flagged');
    row.style.display = matchesQuery && matchesVerify ? '' : 'none';
  }
}

async function main() {
  const response = await fetch('/data/icon-types.json');
  const data = await response.json();
  const { perCode, general } = parseNeedsVerification(data._needsVerification);

  renderGeneralNotes(general);
  renderSummary(data, perCode);
  renderTable('exact-table', data.exact, 'exact', perCode);
  renderTable('prefix-table', data.prefix, 'prefix', perCode);
  renderTable('military-table', data.military.exact, 'military', perCode);

  document.getElementById('search').addEventListener('input', applyFilters);
  document.getElementById('verify-only').addEventListener('change', applyFilters);
}

main();
