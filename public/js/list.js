import { t } from './i18n.js';
import { getLiveAircraft, requestSelect, onChange } from './radar-state.js';
import { getSettings, onSettingsChange } from './settings-state.js';
import { formatAltitude, formatSpeed } from './units.js';

const COLUMNS = [
  { key: 'flight', label: () => t('flight') },
  { key: 'typeCode', label: () => t('type') },
  { key: 'altBaro', label: () => t('altitude') },
  { key: 'gs', label: () => t('speed') },
];

let sortKey = 'flight';
let sortAsc = true;

function formatCell(aircraft, key, units) {
  if (key === 'flight') return aircraft.flight || aircraft.hex;
  if (key === 'altBaro') return aircraft.onGround ? t('onGround') : (formatAltitude(aircraft.altBaro, units) ?? '—');
  if (key === 'gs') return formatSpeed(aircraft.gs, units) ?? '—';
  return aircraft[key] ?? '—';
}

function sortedAircraft(units) {
  const rows = getLiveAircraft();
  rows.sort((a, b) => {
    const cmp = String(formatCell(a, sortKey, units)).localeCompare(String(formatCell(b, sortKey, units)), undefined, {
      numeric: true,
    });
    return sortAsc ? cmp : -cmp;
  });
  return rows;
}

export function renderListPanel(container) {
  function draw() {
    const { units } = getSettings();
    const rows = sortedAircraft(units);
    container.innerHTML = '';

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mlpr-empty';
      empty.textContent = t('noAircraft');
      container.appendChild(empty);
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
        draw();
      });
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const aircraft of rows) {
      const row = document.createElement('tr');
      for (const col of COLUMNS) {
        const td = document.createElement('td');
        td.textContent = formatCell(aircraft, col.key, units);
        row.appendChild(td);
      }
      row.addEventListener('click', () => requestSelect(aircraft.hex));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  draw();
  const unsubscribeAircraft = onChange(draw);
  const unsubscribeSettings = onSettingsChange(draw);
  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
  };
}
