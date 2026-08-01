// Trailing-edge debounce: run `fn` once the caller has stopped calling it
// for `waitMs`. Used for the search boxes, where every keystroke otherwise
// triggers a full filter + sort + re-render of a table.
//
// The live aircraft list is bounded by what's in range, so it barely cares.
// The Stats "all registrations" and "all airlines" tables are the reason
// this exists: they grow for the life of the install (every distinct
// registration ever seen), and they sort and re-render the whole filtered
// set client-side, so the per-keystroke cost keeps climbing over months.
//
// Deliberately trailing-only. A leading call would render on the first
// keystroke and then again at the end, which for a search box means one
// wasted render against a one-character query.
export function debounce(fn, waitMs) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, waitMs);
  };
}

// Short enough to still feel immediate while typing (well under the ~100ms
// at which an interface starts feeling laggy), long enough that a normal
// typing burst collapses into a single render.
export const SEARCH_DEBOUNCE_MS = 120;
