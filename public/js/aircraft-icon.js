const PLANE_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g fill="#3ddc84" stroke="#05070a" stroke-width="0.5">
    <polygon points="12,1 13,9 13,22 11,22 11,9"/>
    <polygon points="1,14 12,10 23,14 12,13"/>
    <polygon points="8,21 12,18 16,21 12,20"/>
  </g>
</svg>
`;

export function createPlaneElement() {
  const wrapper = document.createElement('div');
  wrapper.className = 'mlpr-plane';
  wrapper.innerHTML = PLANE_SVG;
  return wrapper;
}

export function setPlaneHeading(element, trackDegrees) {
  const svg = element.querySelector('svg');
  const heading = typeof trackDegrees === 'number' ? trackDegrees : 0;
  svg.style.transform = `rotate(${heading}deg)`;
}

export function setPlaneColor(element, cssColor) {
  element.querySelector('g').setAttribute('fill', cssColor);
}
