import { t } from './i18n.js';
import { getLiveAircraft, requestSelect, onChange, getSelectedHex, requestHover, onHoverChange, getHoveredHex } from './radar-state.js';
import { getSettings, onSettingsChange, updateSettings } from './settings-state.js';
import { getListField, sortedFieldOptions } from './list-fields.js';
import { openFullscreenModal, openPanel, isSidePanelLayout } from './panels.js';
import { GROUND_MARKER } from './aircraft-details.js';
import { debounce, SEARCH_DEBOUNCE_MS } from './debounce.js';

// Fields matched against the search box -- not necessarily the same as the
// user-configured columns (registration isn't always a column, but is still
// a very natural thing to search a fleet by).
const SEARCH_FIELDS = ['flight', 'hex', 'typeCode', 'registration'];

// Module-level (not per-render) so it survives a panel close/reopen within
// the same page session, same as before columns/sort became configurable --
// only a reload clears it. Naturally shared between the small panel and the
// fullscreen modal too, since both call renderListPanel and both read this.
let searchQuery = '';

// Mode-S-only contacts (no ADS-B position, and often none from MLAT either)
// still show up here -- see app.js's applyAircraftUpdate for why they used
// to be silently dropped before ever reaching this list. A crossed-out pin
// next to the callsign is the only visual difference from a positioned
// row; everything else about the row (altitude, speed, sorting, search)
// works exactly the same, since none of that data depends on position.
// Only shown when 'flight' is one of the configured columns -- there's no
// other natural place to attach it if the user removes that column.
const NO_POSITION_ICON = (title) => `
  <svg class="mlpr-list-no-position" viewBox="0 0 24 24" width="14" height="14" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img">
    <title>${title}</title>
    <path d="M12 21s7-7.58 7-12A7 7 0 0 0 5 9c0 4.42 7 12 7 12z"/>
    <circle cx="12" cy="9" r="2.25"/>
    <line x1="4" y1="4" x2="20" y2="20"/>
  </svg>`;

function hasPosition(aircraft) {
  return typeof aircraft.lat === 'number' && typeof aircraft.lon === 'number';
}

function formatCell(field, aircraft, units, ctx) {
  const raw = field.format(aircraft, units, ctx);
  if (field.boolean) return raw ? t('yes') : t('no');
  // altitudeValue's on-ground sentinel (shared with aircraft-panel.js's own
  // details-panel rendering) -- list-fields.js stays i18n-free like
  // aircraft-details.js, so translating it is this layer's job.
  if (raw === GROUND_MARKER) return t('onGround');
  return raw ?? '—';
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

// ctx is { home } -- only the 'distance' field reads it, see list-fields.js.
// allAircraft is passed in (rather than calling getLiveAircraft() here)
// so a caller that also needs the unfiltered live set (drawTable's total
// count) can fetch it once and reuse it -- getLiveAircraft() allocates a
// fresh array from the underlying Map on every call.
function visibleAircraft(allAircraft, query, ctx) {
  const { listSortLevels, listPositionFirst } = getSettings();
  const rows = allAircraft.filter((aircraft) => matchesSearch(aircraft, query));

  // Decorate-sort-undecorate (Schwartzian transform): each row's sort
  // key(s) are computed once upfront instead of calling field.sortValue()
  // fresh on every pairwise comparison inside Array.prototype.sort() --
  // notably wasteful for the 'distance' field, which otherwise redoes a
  // Haversine calculation per comparison instead of once per aircraft.
  const decorated = rows.map((aircraft) => ({
    aircraft,
    positionRank: listPositionFirst ? (hasPosition(aircraft) ? 0 : 1) : 0,
    keys: listSortLevels.map((level) => getListField(level.key)?.sortValue(aircraft, ctx) ?? null),
  }));

  decorated.sort((a, b) => {
    // Optional pre-sort grouping requested separately from any column sort
    // -- aircraft with a known position always come first, then the
    // configured sort levels apply within each group.
    if (listPositionFirst && a.positionRank !== b.positionRank) return a.positionRank - b.positionRank;
    for (let i = 0; i < listSortLevels.length; i++) {
      if (!getListField(listSortLevels[i].key)) continue;
      const cmp = compareValues(a.keys[i], b.keys[i], listSortLevels[i].asc);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  return decorated.map((d) => d.aircraft);
}

// fullscreen: true when rendered inside the "open fullscreen" modal
// (panels.js's FULLSCREEN_MODALS.listFull) rather than the normal side
// panel/bottom sheet -- same column/sort configuration either way, just
// more screen space, so it only affects whether the "open fullscreen"
// button itself is shown.
export function renderListPanel(container, { fullscreen = false } = {}) {
  container.innerHTML = `
    <div class="mlpr-list-toolbar">
      <button type="button" class="mlpr-list-action-btn" id="mlpr-list-configure">${t('configureList')}</button>
      ${
        fullscreen
          ? `<button type="button" class="mlpr-list-action-btn" id="mlpr-list-exit-fullscreen">${t('exitFullscreen')}</button>`
          : `<button type="button" class="mlpr-list-action-btn" id="mlpr-list-fullscreen">${t('openFullscreen')}</button>`
      }
    </div>
    <div id="mlpr-list-body">
      <div id="mlpr-list-view">
        <div class="mlpr-list-header">
          <p class="mlpr-list-total" id="mlpr-list-total"></p>
          <input type="search" id="mlpr-list-search" class="mlpr-list-search" placeholder="${t('listSearchPlaceholder')}">
        </div>
        <div id="mlpr-list-table-wrap"></div>
      </div>
      <div id="mlpr-list-config-view" style="display:none"></div>
    </div>
  `;

  const bodyEl = container.querySelector('#mlpr-list-body');
  const configureBtn = container.querySelector('#mlpr-list-configure');
  const listViewEl = container.querySelector('#mlpr-list-view');
  const configViewEl = container.querySelector('#mlpr-list-config-view');
  const totalEl = container.querySelector('#mlpr-list-total');
  const searchInput = container.querySelector('#mlpr-list-search');
  const tableWrap = container.querySelector('#mlpr-list-table-wrap');
  // A property assignment (not an HTML-templated value attribute, which
  // would need escaping since searchQuery is free-typed user input) --
  // reflects a search persisted from a previous open of this panel in the
  // same session, matching what's actually being filtered on below.
  searchInput.value = searchQuery;

  // { lat, lon } | null -- fetched once per panel open, same endpoint/
  // access-control as the home marker and Stats' nearest/farthest tiles
  // (stats.js's loadHomeLocation follows the exact same pattern).
  let home = null;

  async function loadHomeLocation() {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        const data = await response.json();
        home =
          typeof data.homeLat === 'number' && typeof data.homeLon === 'number'
            ? { lat: data.homeLat, lon: data.homeLon }
            : null;
      }
    } catch {
      // Offline/unreachable -- keep whatever we last knew (null on first load).
    }
    drawTable();
  }

  // The search box lives outside drawTable's rebuilt subtree deliberately --
  // drawTable runs on every radar-state change (so, roughly once a second
  // with live traffic, see radar-state.js's batching), and if the input
  // itself were part of that rebuilt HTML it would lose focus/cursor
  // position on every redraw, making it unusable while typing.
  // Debounced like the Stats tables' search, though this one matters less:
  // the live list is bounded by what's currently in range, not by how long
  // the install has been running. Consistency is the point -- both search
  // boxes should feel the same.
  const runSearch = debounce(() => {
    searchQuery = searchInput.value;
    drawTable();
  }, SEARCH_DEBOUNCE_MS);
  searchInput.addEventListener('input', runSearch);

  function drawTable() {
    const { units, listColumns, listSortLevels } = getSettings();
    const ctx = { home };
    const columns = listColumns.map((key) => getListField(key)).filter(Boolean);
    const primarySort = listSortLevels[0];

    const allAircraft = getLiveAircraft();
    totalEl.textContent = `${t('listTotal')}: ${allAircraft.length}`;

    const rows = visibleAircraft(allAircraft, searchQuery, ctx);
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
    for (const field of columns) {
      const th = document.createElement('th');
      const isPrimary = primarySort && primarySort.key === field.key;
      th.textContent = t(field.labelKey) + (isPrimary ? (primarySort.asc ? ' ▲' : ' ▼') : '');
      th.addEventListener('click', () => {
        const { listSortLevels: currentLevels } = getSettings();
        const current = currentLevels[0];
        const asc = current && current.key === field.key ? !current.asc : true;
        updateSettings({ listSortLevels: [{ key: field.key, asc }] });
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
      const rowHasPosition = hasPosition(aircraft);
      for (const field of columns) {
        const td = document.createElement('td');
        if (field.key === 'flight' && !rowHasPosition) {
          td.innerHTML = NO_POSITION_ICON(t('noPositionData'));
          td.append(document.createTextNode(' ' + formatCell(field, aircraft, units, ctx)));
        } else {
          td.textContent = formatCell(field, aircraft, units, ctx);
        }
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

  // Three ways Configure can present itself, depending on how much room
  // there is and where this instance is rendered -- 'floating', 'inline',
  // and 'swap' below. Whichever it is, #panel itself (position, size, its
  // own toolbar buttons) is never touched by opening/closing Configure --
  // explicit request, 2026-07-28, after an earlier version that auto-grew
  // the panel turned out not to be what was wanted at all.
  //
  // 'floating': the desktop side panel (isSidePanelLayout(), not
  // fullscreen) has a fixed-width #panel plus room to spare beside it --
  // Configure opens as a genuinely separate, independent window
  // (#list-config-window, a sibling of #panel in index.html, not nested
  // inside it) glued to #panel's left edge. Since it's a different element
  // entirely, #panel's own width/position/buttons are structurally
  // incapable of changing when it opens.
  //
  // 'inline': the fullscreen modal has no "beside it" to float into (it
  // already spans the full available width) but usually doesn't need to --
  // #mlpr-list-config-view renders *nested* inside this same container,
  // next to the table (the row-reverse side-by-side from the previous
  // round, kept for this case only), shown once the modal's own measured
  // width clears FULLSCREEN_SIDE_BY_SIDE_MIN_WIDTH.
  //
  // 'swap': mobile bottom sheet, not fullscreen -- already full-width, nothing
  // to float or grow into either way, so #mlpr-list-config-view replaces
  // the table in place (the original, simplest behavior).
  const FULLSCREEN_SIDE_BY_SIDE_MIN_WIDTH = 760;
  // Must match #list-config-window's own width in style.css.
  const CONFIG_WINDOW_WIDTH = 340;
  // Visible gap between #panel and the floating window, so they read as
  // two separate windows placed next to each other, not one fused shape.
  const CONFIG_WINDOW_GAP = 12;

  const configWindowEl = fullscreen ? null : document.getElementById('list-config-window');

  let configOpen = false;
  let fullscreenMeasuredWide = false; // ResizeObserver-driven, only consulted in 'inline' mode
  let activeConfigTarget = null; // whichever element currently has the rendered config form, or null when closed

  function currentMode() {
    if (!fullscreen && isSidePanelLayout()) return 'floating';
    if (fullscreen) return 'inline';
    return 'swap';
  }

  function targetForMode(mode) {
    return mode === 'floating' ? configWindowEl : configViewEl;
  }

  // #panel is right-docked (right: 0, left: auto in the side-panel layout)
  // -- its right edge stays fixed regardless of its own width, so the
  // floating window's position only needs #panel's *left* edge (from
  // getBoundingClientRect(), not recomputed from settings -- this way it's
  // correct whether that width came from the default, a persisted
  // drag-resize, or mid-drag) plus this window's own fixed width and the gap.
  function positionConfigWindow() {
    if (!configWindowEl) return;
    const panelRect = document.getElementById('panel').getBoundingClientRect();
    configWindowEl.style.right = `${window.innerWidth - panelRect.left + CONFIG_WINDOW_GAP}px`;
  }

  function updateLayout() {
    configureBtn.classList.toggle('active', configOpen);
    const mode = currentMode();
    const target = configOpen ? targetForMode(mode) : null;

    if (configWindowEl) {
      configWindowEl.classList.toggle('hidden', target !== configWindowEl);
    }
    if (target === configWindowEl) positionConfigWindow();

    if (mode === 'floating') {
      // The nested config-view plays no part in this mode -- make sure it's
      // not accidentally left visible from a previous session at a
      // different width (e.g. the fullscreen 'inline' case).
      bodyEl.classList.remove('mlpr-list-body-wide');
      listViewEl.style.display = '';
      configViewEl.style.display = 'none';
    } else {
      const wide = configOpen && mode === 'inline' && fullscreenMeasuredWide;
      bodyEl.classList.toggle('mlpr-list-body-wide', wide);
      if (wide) {
        listViewEl.style.display = '';
        configViewEl.style.display = '';
      } else {
        listViewEl.style.display = configOpen ? 'none' : '';
        configViewEl.style.display = configOpen ? '' : 'none';
      }
    }

    // (re-)render only when the target actually changed -- a plain open
    // sees activeConfigTarget go from null to a real element and renders;
    // a mode change while already open (e.g. the browser window crossing
    // the side-panel breakpoint mid-session) sees it change from one real
    // element to another and re-renders into the new one. Content
    // mutations (add/remove a column, etc.) call renderConfigView directly
    // themselves and never reach here, so this doesn't re-render on those.
    if (target && target !== activeConfigTarget) {
      activeConfigTarget = target;
      renderConfigView(target);
    } else if (!target) {
      activeConfigTarget = null;
    }
  }

  // Repositions the floating window (drag-resizing #panel's width changes
  // #panel-content's width too, which is what `container` actually is when
  // not fullscreen) and re-measures fullscreen's own width for 'inline'
  // mode -- one observer covers both, since either reason to react shows
  // up as a `container` resize.
  const resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect?.width ?? 0;
    fullscreenMeasuredWide = width >= FULLSCREEN_SIDE_BY_SIDE_MIN_WIDTH;
    updateLayout();
  });
  resizeObserver.observe(container);

  function openConfigView() {
    configOpen = true;
    updateLayout();
  }

  function closeConfigView() {
    configOpen = false;
    updateLayout();
  }

  function toggleConfigView() {
    if (configOpen) {
      closeConfigView();
    } else {
      openConfigView();
    }
  }

  // Every row mutation below commits straight to settings-state via
  // updateSettings and immediately re-renders this view from the fresh
  // settings -- no draft/Save/Cancel step. Safe to do on every native
  // <select>'s 'change' (fires only once the user has already committed a
  // choice, unlike e.g. a text input's 'input' event mid-keystroke) and on
  // every button click, so there's never a moment where a still-in-progress
  // interaction gets torn out from under the user. The underlying table
  // (drawTable, subscribed to onSettingsChange) updates live alongside this
  // view for the same reason.
  function renderConfigView(targetEl) {
    const { listColumns, listSortLevels, listPositionFirst } = getSettings();
    const options = sortedFieldOptions();

    targetEl.innerHTML = `
      <div class="mlpr-listconfig-header">
        <span class="mlpr-listconfig-title">${t('configureList')}</span>
        <button type="button" class="mlpr-listconfig-close-x" id="mlpr-listconfig-close" aria-label="${t('close')}">✕</button>
      </div>
      <fieldset class="mlpr-settings-group">
        <legend>${t('listConfigColumns')}</legend>
        <div id="mlpr-listconfig-columns"></div>
        <button type="button" class="mlpr-list-action-btn" id="mlpr-listconfig-add-column">${t('addColumn')}</button>
      </fieldset>
      <fieldset class="mlpr-settings-group">
        <legend>${t('listConfigSort')}</legend>
        <label class="mlpr-checkbox-row">
          <input type="checkbox" id="mlpr-listconfig-position-first" ${listPositionFirst ? 'checked' : ''}>
          ${t('positionFirstAircraft')}
        </label>
        <div id="mlpr-listconfig-sort"></div>
        <button type="button" class="mlpr-list-action-btn" id="mlpr-listconfig-add-sort">${t('addSortLevel')}</button>
      </fieldset>
    `;

    const columnsEl = targetEl.querySelector('#mlpr-listconfig-columns');
    const sortEl = targetEl.querySelector('#mlpr-listconfig-sort');

    function fieldOptionsHtml(selectedKey) {
      return options
        .map((option) => `<option value="${option.key}" ${option.key === selectedKey ? 'selected' : ''}>${option.label}</option>`)
        .join('');
    }

    function renderColumnRows() {
      columnsEl.innerHTML = '';
      listColumns.forEach((key, index) => {
        const row = document.createElement('div');
        row.className = 'mlpr-listconfig-row';

        const select = document.createElement('select');
        select.innerHTML = fieldOptionsHtml(key);
        select.addEventListener('change', () => {
          const next = [...listColumns];
          next[index] = select.value;
          updateSettings({ listColumns: next });
          renderConfigView(targetEl);
        });

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '↑';
        upBtn.setAttribute('aria-label', t('moveUp'));
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => {
          const next = [...listColumns];
          [next[index - 1], next[index]] = [next[index], next[index - 1]];
          updateSettings({ listColumns: next });
          renderConfigView(targetEl);
        });

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '↓';
        downBtn.setAttribute('aria-label', t('moveDown'));
        downBtn.disabled = index === listColumns.length - 1;
        downBtn.addEventListener('click', () => {
          const next = [...listColumns];
          [next[index + 1], next[index]] = [next[index], next[index + 1]];
          updateSettings({ listColumns: next });
          renderConfigView(targetEl);
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        // Icon, not the full "Remove" text -- the sort row already has two
        // <select>s plus four buttons competing for one narrow (340px)
        // column's width; the full-text button was wide enough to overflow
        // it entirely (invisible past the window's edge, not just tight).
        removeBtn.textContent = '✕';
        removeBtn.setAttribute('aria-label', t('remove'));
        // At least one column must always remain -- an empty table has
        // nothing useful to click/sort/show.
        removeBtn.disabled = listColumns.length <= 1;
        removeBtn.addEventListener('click', () => {
          const next = listColumns.filter((_, i) => i !== index);
          updateSettings({ listColumns: next });
          renderConfigView(targetEl);
        });

        row.append(select, upBtn, downBtn, removeBtn);
        columnsEl.appendChild(row);
      });
    }

    function renderSortRows() {
      sortEl.innerHTML = '';
      listSortLevels.forEach((level, index) => {
        const row = document.createElement('div');
        row.className = 'mlpr-listconfig-row';

        const select = document.createElement('select');
        select.innerHTML = fieldOptionsHtml(level.key);
        select.addEventListener('change', () => {
          const next = listSortLevels.map((l, i) => (i === index ? { ...l, key: select.value } : l));
          updateSettings({ listSortLevels: next });
          renderConfigView(targetEl);
        });

        const dirSelect = document.createElement('select');
        dirSelect.innerHTML = `
          <option value="asc" ${level.asc ? 'selected' : ''}>${t('sortAscending')}</option>
          <option value="desc" ${!level.asc ? 'selected' : ''}>${t('sortDescending')}</option>
        `;
        dirSelect.addEventListener('change', () => {
          const next = listSortLevels.map((l, i) => (i === index ? { ...l, asc: dirSelect.value === 'asc' } : l));
          updateSettings({ listSortLevels: next });
          renderConfigView(targetEl);
        });

        // Same reordering affordance as the columns section above -- a
        // changed mind about sort priority shouldn't mean removing and
        // re-adding levels from scratch.
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '↑';
        upBtn.setAttribute('aria-label', t('moveUp'));
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => {
          const next = [...listSortLevels];
          [next[index - 1], next[index]] = [next[index], next[index - 1]];
          updateSettings({ listSortLevels: next });
          renderConfigView(targetEl);
        });

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '↓';
        downBtn.setAttribute('aria-label', t('moveDown'));
        downBtn.disabled = index === listSortLevels.length - 1;
        downBtn.addEventListener('click', () => {
          const next = [...listSortLevels];
          [next[index + 1], next[index]] = [next[index], next[index + 1]];
          updateSettings({ listSortLevels: next });
          renderConfigView(targetEl);
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '✕';
        removeBtn.setAttribute('aria-label', t('remove'));
        // At least one sort level must always remain -- an unsorted list
        // has no defined row order to fall back to.
        removeBtn.disabled = listSortLevels.length <= 1;
        removeBtn.addEventListener('click', () => {
          const next = listSortLevels.filter((_, i) => i !== index);
          updateSettings({ listSortLevels: next });
          renderConfigView(targetEl);
        });

        row.append(select, dirSelect, upBtn, downBtn, removeBtn);
        sortEl.appendChild(row);
      });
    }

    renderColumnRows();
    renderSortRows();

    targetEl.querySelector('#mlpr-listconfig-add-column').addEventListener('click', () => {
      updateSettings({ listColumns: [...listColumns, options[0].key] });
      renderConfigView(targetEl);
    });

    targetEl.querySelector('#mlpr-listconfig-add-sort').addEventListener('click', () => {
      updateSettings({ listSortLevels: [...listSortLevels, { key: options[0].key, asc: true }] });
      renderConfigView(targetEl);
    });

    targetEl.querySelector('#mlpr-listconfig-position-first').addEventListener('change', (event) => {
      updateSettings({ listPositionFirst: event.target.checked });
    });

    targetEl.querySelector('#mlpr-listconfig-close').addEventListener('click', closeConfigView);
  }

  container.querySelector('#mlpr-list-configure').addEventListener('click', toggleConfigView);
  if (fullscreen) {
    // Switches back to the small panel/bottom sheet -- same "just switch,
    // don't push/pop history" path panels.js already uses for List <-> Stats
    // (openPanel calls hideModalUI() first), so this doesn't leave a stray
    // history entry or fire the back-gesture twice.
    container.querySelector('#mlpr-list-exit-fullscreen').addEventListener('click', () => openPanel('list'));
  } else {
    container.querySelector('#mlpr-list-fullscreen').addEventListener('click', () => openFullscreenModal('listFull'));
  }

  drawTable();
  loadHomeLocation();
  const unsubscribeAircraft = onChange(drawTable);
  const unsubscribeSettings = onSettingsChange(drawTable);
  const unsubscribeHover = onHoverChange(updateHoverHighlight);
  return () => {
    unsubscribeAircraft();
    unsubscribeSettings();
    unsubscribeHover();
    resizeObserver.disconnect();
    // The floating window is a standalone element outside this panel's own
    // container (see index.html) -- it doesn't get torn down along with
    // everything else here just because this List instance is closing, so
    // it has to be hidden explicitly or it would keep floating next to a
    // panel that's no longer even open.
    configWindowEl?.classList.add('hidden');
  };
}
