// Shared by every module that builds an HTML string from aircraft data
// (app.js's map popup, stats.js's tables, aircraft-panel.js's details
// panel) rather than each defining its own copy -- HttpSource fetches
// aircraft.json over plain, unauthenticated LAN HTTP, so a raw callsign/
// registration/etc. dropped into innerHTML/setHTML is a real stored-XSS
// path, not a theoretical one.
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
