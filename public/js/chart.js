export function renderSparklineSvg(values, { width = 280, height = 48, color = '#3ddc84' } = {}) {
  if (values.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" class="mlpr-sparkline"></svg>`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="mlpr-sparkline">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}
