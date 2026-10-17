// Loss-exceedance curve: one series, return period (log scale) vs loss.
// Plain SVG; colours come from the .viz CSS tokens so dark mode follows.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

export function lossCurve(container, points, { fmtMoney, fmtCompact }) {
  container.innerHTML = '';
  if (points.length < 2) return;
  const W = container.clientWidth || 340;
  const H = 190;
  const m = { t: 12, r: 14, b: 34, l: 52 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const lx0 = Math.log(points[0].rp);
  const lx1 = Math.log(points[points.length - 1].rp);
  const ymax = niceMax(Math.max(...points.map((p) => p.loss)));
  const X = (rp) => m.l + ((Math.log(rp) - lx0) / (lx1 - lx0)) * iw;
  const Y = (v) => m.t + ih - (v / ymax) * ih;

  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Loss exceedance curve: estimated loss by flood return period' }, container);

  for (let i = 0; i <= 4; i++) {
    const v = (ymax * i) / 4;
    el('line', { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), class: i ? 'grid' : 'axis' }, svg);
    el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = fmtCompact(v);
  }
  for (const p of points) {
    el('text', { x: X(p.rp), y: m.t + ih + 16, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = p.rp;
  }
  el('text', { x: m.l + iw / 2, y: H - 3, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = 'Return period (years, log scale)';

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.rp)},${Y(p.loss)}`).join('');
  el('path', { d: `${d}L${X(points[points.length - 1].rp)},${Y(0)}L${X(points[0].rp)},${Y(0)}Z`, class: 'area' }, svg);
  el('path', { d, class: 'line' }, svg);

  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  container.appendChild(tip);

  points.forEach((p, i) => {
    const g = el('g', { class: 'pt', tabindex: 0 }, svg);
    el('circle', { cx: X(p.rp), cy: Y(p.loss), r: 4, class: 'dot' }, g);
    el('circle', { cx: X(p.rp), cy: Y(p.loss), r: 14, class: 'hit' }, g);
    const show = () => {
      tip.innerHTML = `<b>${p.rp}-year flood</b><br>Loss ${fmtMoney(p.loss)}<br>${(100 / p.rp).toFixed(p.rp > 100 ? 1 : 0)}% chance each year`;
      tip.hidden = false;
      const left = Math.min(Math.max(X(p.rp) - 70, 0), W - 150);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(Y(p.loss) - 70, 0)}px`;
    };
    g.addEventListener('mouseenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('mouseleave', () => (tip.hidden = true));
    g.addEventListener('blur', () => (tip.hidden = true));
    if (i === points.length - 1) {
      el('text', { x: X(p.rp) - 6, y: Y(p.loss) - 8, 'text-anchor': 'end', class: 'label' }, svg).textContent = fmtCompact(p.loss);
    }
  });
}
