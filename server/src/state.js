let current = { now: 0, messages: undefined, aircraft: [] };

export function setSnapshot(snapshot) {
  current = snapshot;
}

export function getSnapshot() {
  return current;
}
