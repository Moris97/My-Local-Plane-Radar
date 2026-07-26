const PLANE_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2 L14 9 L22 13 L14 14.5 L13 21 L12 19 L11 21 L10 14.5 L2 13 L10 9 Z"
        fill="#3ddc84" stroke="#05070a" stroke-width="0.6"/>
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
