// All icons share a 24x24 viewBox and a single <g fill="..."> wrapper so
// setPlaneColor keeps working the same way regardless of shape.
const ICONS = {
  // Default/fallback silhouette -- also used for anything we can't
  // specifically classify (large/heavy/high-performance categories, or no
  // category info at all): a swept-wing airliner shape.
  passenger: `
    <polygon points="12,1 13,9 13,22 11,22 11,9"/>
    <polygon points="1,14 12,10 23,14 12,13"/>
    <polygon points="8,21 12,18 16,21 12,20"/>
  `,
  // Light single-engine GA aircraft (Cessna 172 and similar): the same
  // kite-shaped wing/tail technique as the passenger silhouette below (a
  // plain rectangle crossing the fuselage reads as a "+" sign, not a
  // plane), just symmetric/unswept instead of swept back, plus a nose
  // propeller to read clearly as a small single-engine aircraft.
  light: `
    <polygon points="12,3 12.7,8 12.7,21 11.3,21 11.3,8"/>
    <polygon points="2,10.2 12,8.7 22,10.2 12,11.7"/>
    <polygon points="9,20 12,18 15,20 12,19.3"/>
    <circle cx="12" cy="2.3" r="1"/>
  `,
  // Helicopter: X-pattern rotor blades (a single straight bar read as "|",
  // not obviously a rotor) mounted directly over the cabin roof -- not out
  // ahead of the nose, which is where the mast sat in the first draft
  // (reported: "the rotor is in the wrong place, it belongs on the
  // fuselage, not the front"). The cabin's own nose tip now extends above
  // the rotor hub, so the blades visibly cross over the airframe instead of
  // floating in front of it. Tail boom stays long relative to the cabin --
  // too short and it reads as a lollipop/balloon instead of a helicopter
  // (caught during development).
  helicopter: `
    <g transform="translate(12,9)">
      <rect x="-8" y="-0.7" width="16" height="1.4" rx="0.7" transform="rotate(45)"/>
      <rect x="-8" y="-0.7" width="16" height="1.4" rx="0.7" transform="rotate(-45)"/>
      <circle r="1"/>
    </g>
    <rect x="11.3" y="9" width="1.4" height="2.2"/>
    <polygon points="12,7.5 14.8,11.8 14.2,15.3 9.8,15.3 9.2,11.8"/>
    <polygon points="10.8,15.3 13.2,15.3 12.5,21.8 11.5,21.8"/>
    <rect x="9.3" y="21.2" width="5.4" height="1.4" rx="0.7"/>
  `,
  // Ground-station beacon (readsb reports these with typeCode "TWR") --
  // deliberately not aircraft-shaped at all: a lattice tower widening
  // toward the base, cross braces, and an antenna tip.
  tower: `
    <polygon points="12,2 12.8,2 17,22 15.2,22"/>
    <polygon points="11.2,2 12,2 8.8,22 7,22"/>
    <rect x="6.5" y="21" width="11" height="1.4"/>
    <rect x="9.3" y="8" width="5.4" height="1"/>
    <rect x="8.5" y="14" width="7" height="1"/>
    <rect x="7.7" y="18.5" width="8.6" height="1"/>
    <circle cx="12" cy="1.2" r="1"/>
  `,
};

function iconSvg(kind) {
  return `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g fill="#3ddc84" stroke="#05070a" stroke-width="0.5">
    ${ICONS[kind] ?? ICONS.passenger}
  </g>
</svg>
`;
}

// ADS-B emitter category: A1 = light (<15,500 lbs, the Cessna-172 class),
// A7 = rotorcraft. Everything else in the A-set (small/large/heavy/high-
// performance) and anything with no category info at all reads as
// "passenger" -- matches the ask ("other types get the passenger
// silhouette"). typeCode "TWR" is checked first since it identifies
// ground infrastructure, not an aircraft category at all.
export function classifyAircraftKind(aircraft) {
  if (aircraft?.typeCode === 'TWR') return 'tower';
  if (aircraft?.category === 'A7') return 'helicopter';
  if (aircraft?.category === 'A1') return 'light';
  return 'passenger';
}

export function createPlaneElement(aircraft) {
  const wrapper = document.createElement('div');
  wrapper.className = 'mlpr-plane';
  const kind = classifyAircraftKind(aircraft);
  wrapper.dataset.kind = kind;
  wrapper.innerHTML = iconSvg(kind);
  return wrapper;
}

// Category/typeCode can arrive a tick or two after an aircraft is first
// seen -- re-classify on every update, but only touch the DOM when the
// kind actually changes.
export function setPlaneKind(element, aircraft) {
  const kind = classifyAircraftKind(aircraft);
  if (element.dataset.kind === kind) return;
  const color = element.querySelector('g')?.getAttribute('fill');
  element.dataset.kind = kind;
  element.innerHTML = iconSvg(kind);
  if (color) element.querySelector('g').setAttribute('fill', color);
}

export function setPlaneHeading(element, trackDegrees) {
  const svg = element.querySelector('svg');
  // Ground-station beacons don't have a meaningful heading -- keep them
  // upright regardless of whatever "track" value readsb reports for them.
  if (element.dataset.kind === 'tower') {
    svg.style.transform = '';
    return;
  }
  const heading = typeof trackDegrees === 'number' ? trackDegrees : 0;
  svg.style.transform = `rotate(${heading}deg)`;
}

export function setPlaneColor(element, cssColor) {
  element.querySelector('g').setAttribute('fill', cssColor);
}
