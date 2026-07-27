import { t } from './i18n.js';
import { getLiveAircraft, requestSelect, onChange, getSelectedHex } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import { formatAltitude, formatSpeed } from './units.js';

const COLUMNS = [
  { key: 'flight', label: () => t('flight') },
  { key: 'typeCode', label: () => t('type') },
  { key: 'altBaro', label: () => t('altitude') },
  { key: 'gs', label: () => t('speed') },
];

// Fields matched against the search box -- not necessarily the same as the
// visible COLUMNS (registration isn't its own column, but is still a very
// natural thing to search a fleet by).
const SEARCH_FIELDS = ['flight', 'hex', 'typeCode', 'registration'];

let sortKey = 'flight';
let sortAsc = true;
let searchQuery = '';

function formatCell(aircraft, key, units) {
  if (key === 'flight') return aircraft.flight || aircraft.hex;
  if (key === 'altBaro') return aircraft.onGround ? t('onGround') : (formatAltitude(aircraft.altBaro, units) ?? '—');
  if (key === 'gs') return formatSpeed(aircraft.gs, units) ?? '—';
  return aircraft[key] ?? '—';
}

function matchesSearch(aircraft, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return SEARCH_FIELDS.some((field) => String(aircraft[field] ?? '').toLowerCase().includes(needle));
}

function visibleAircraft(units) {
  const rows = getLiveAircraft().filter((aircraft) => matchesSearch(aircraft, searchQuery));
  rows.sort((a, b) => {
    const cmp = String(formatCell(a, sortKey, units)).localeCompare(String(formatCell(b, sortKey, units)), undefined, {
      numeric: true,
    });
    return sortAsc ? cmp : -cmp;
  });
  return rows;
}

export function renderListPanel(container) {
  container.innerHTML = `
    <div class="mlpr-list-header">
      <p class="mlpr-list-total" id="mlpr-list-total"></p>
      <input type="search" id="mlpr-list-search" class="mlpr-list-search" placeholder="${t('listSearchPlaceholder')}">
    </div>
    <div id="mlpr-list-table-wrap"></div>
  `;

  const totalEl = container.querySelector('#mlpr-list-total');
  const searchInput = container.querySelector('#mlpr-list-search');
  const tableWrap = container.querySelector('#mlpr-list-table-wrap');

  // The search box lives outside drawTable's rebuilt subtree deliberately --
  // drawTable runs on every radar-state change (so, roughly once a second
  // with live traffic, see radar-state.js's batching), and if the input
  // itself were part of that rebuilt HTML it would lose focus/cursor
  // position on every redraw, making it unusable while typing.
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    drawTable();
  });

  function drawTable() {
    const { units } = getSettings();
    const total = getLiveAircraft().length;
    totalEl.textContent = `${t('listTotal')}: ${total}`;

    const rows = visibleAircraft(units);
    const selectedHex = getSelectedHex();
    tableWrap.innerHTML = '';

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mlpr-empty';
      empty.textContent = searchQuery ? t('noSearchResults') : t('noAircraft');
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'mlpr-list-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of COLUMNS) {
      const th = document.createElement('th');
      th.textContent = col.label();
      th.addEventListener('click', () => {
        if (sortKey === col.key) {
          sortAsc = !sortAsc;
        } else {
          sortKey = col.key;
          sortAsc = true;
        }
        drawTable();
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const aircraft of rows) {
      const row = document.createElement('tr');
      if (aircraft.hex === selectedHex) row.classList.add('mlpr-list-row-selected');
      for (const col of COLUMNS) {
        const td = document.createElement('td');
        td.textContent = formatCell(aircraft, col.key, units);
        row.appendChild(td);
      }
      row.addEventListener('click', () => requestSelect(aircraft.hex));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  drawTable();
  const unsubscribeAircraft = onChange(drawTable);
  const unsubscribeSettings = onSettingsChange(drawTable);
  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
  };
}
