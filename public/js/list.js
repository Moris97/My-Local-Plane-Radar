import { t } from './i18n.js';
import { getLiveAircraft, requestSelect, onChange, getSelectedHex, requestHover, onHoverChange, getHoveredHex } from './radar-state.js';
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

// Sorting used to compare formatCell's *display* strings (e.g. "1200 ft"),
// which put "On ground"/"Na ziemi" wherever it happened to collate
// alphabetically against numbers with units attached, instead of where it
// actually belongs -- the bottom of the altitude range. This compares the
// real underlying values instead; formatCell stays display-only.
function sortValue(aircraft, key) {
  if (key === 'flight') return (aircraft.flight || '').trim() || aircraft.hex;
  if (key === 'altBaro') {
    if (aircraft.onGround) return -1; // below any real positive altitude, on purpose
    return typeof aircraft.altBaro === 'number' ? aircraft.altBaro : null;
  }
  if (key === 'gs') return typeof aircraft.gs === 'number' ? aircraft.gs : null;
  return aircraft[key] ?? null;
}

// Missing data (null) always sorts last regardless of direction -- it
// shouldn't interleave with real values in either a "smallest first" or
// "largest first" reading, just sit out of the way at the end.
function compareValues(a, b, asc) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    const cmp = a - b;
    return asc ? cmp : -cmp;
  }
  const cmp = String(a).localeCompare(String(b), undefined, { numeric: true });
  return asc ? cmp : -cmp;
}

function matchesSearch(aircraft, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return SEARCH_FIELDS.some((field) => String(aircraft[field] ?? '').toLowerCase().includes(needle));
}

function visibleAircraft() {
  const rows = getLiveAircraft().filter((aircraft) => matchesSearch(aircraft, searchQuery));
  rows.sort((a, b) => compareValues(sortValue(a, sortKey), sortValue(b, sortKey), sortAsc));
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

    const rows = visibleAircraft();
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
      th.textContent = col.label() + (sortKey === col.key ? (sortAsc ? ' ▲' : ' ▼') : '');
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
      row.dataset.hex = aircraft.hex;
      if (aircraft.hex === selectedHex) row.classList.add('mlpr-list-row-selected');
      for (const col of COLUMNS) {
        const td = document.createElement('td');
        td.textContent = formatCell(aircraft, col.key, units);
        row.appendChild(td);
      }
      row.addEventListener('click', () => requestSelect(aircraft.hex));
      // List row -> highlight the marker on the map (different style than
      // a click/selection -- see style.css's .mlpr-plane-hover). The
      // reverse direction (hovering the marker highlights this row) is
      // handled by updateHoverHighlight below, driven by radar-state's
      // hover broadcast rather than rebuilding here.
      row.addEventListener('mouseenter', () => requestHover(aircraft.hex));
      row.addEventListener('mouseleave', () => requestHover(null));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    updateHoverHighlight();
  }

  // Cheap class-toggle on already-rendered rows -- deliberately not part of
  // drawTable's rebuild path, and driven by its own onHoverChange
  // subscription rather than the shared onChange one. Hovering a marker can
  // fire many times a second while the cursor crosses a cluster of
  // aircraft; routing that through the same channel as aircraft-data
  // updates would mean rebuilding the whole <table> that often, undoing
  // the batching fix that channel exists for in the first place.
  function updateHoverHighlight() {
    const hoveredHex = getHoveredHex();
    for (const row of tableWrap.querySelectorAll('tr[data-hex]')) {
      row.classList.toggle('mlpr-list-row-hover', row.dataset.hex === hoveredHex);
    }
  }

  drawTable();
  const unsubscribeAircraft = onChange(drawTable);
  const unsubscribeSettings = onSettingsChange(drawTable);
  const unsubscribeHover = onHoverChange(updateHoverHighlight);
  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
    unsubscribeHover();
  };
}
