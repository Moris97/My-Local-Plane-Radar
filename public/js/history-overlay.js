// One history entry for a full-screen overlay that isn't a panels.js panel
// or fullscreen modal.
//
// panels.js already owns exactly one history entry for "a panel or modal is
// open", so the Android/iOS back gesture closes it. The trigger-area editor
// (area-editor.js) is a top-level overlay opened from *inside* the Settings
// panel, so it can't reuse that entry: back has to close the editor while
// leaving the Settings panel underneath open, which means a second entry
// stacked on top of the first.
//
// Kept in its own module rather than exported from panels.js purely to
// avoid an import cycle -- panels.js -> settings.js -> area-editor.js would
// have to import back into panels.js.

let onPop = null;
let swallowNextPop = false;

// Pushes an entry and registers what a back gesture should do. Returns a
// release function the overlay must call when it closes by any *other*
// route (Save/Cancel/Escape), so its entry doesn't outlive it -- a no-op if
// a real back gesture already consumed it.
export function openHistoryOverlay(handler) {
  history.pushState({ mlprOverlay: true }, '');
  onPop = handler;

  return () => {
    if (onPop !== handler) return;
    onPop = null;
    // history.back() fires its own popstate a moment later. Without this
    // flag that pop falls through to panels.js and closes the panel the
    // overlay was opened from -- the same "one mechanism consuming another
    // mechanism's history entry" trap panels.js documents for its own
    // panel/modal split.
    swallowNextPop = true;
    history.back();
  };
}

// Called by panels.js's popstate listener before it does anything else.
// True means this pop belonged to an overlay (or to one closing itself) and
// nothing else should react to it.
export function handleOverlayPop() {
  if (swallowNextPop) {
    swallowNextPop = false;
    return true;
  }
  if (!onPop) return false;
  const handler = onPop;
  onPop = null;
  handler();
  return true;
}
