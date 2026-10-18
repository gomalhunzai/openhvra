// Publication-ready charts as self-contained SVG (white background, fixed
// light palette, system fonts) plus 300-DPI PNG conversion. Marks follow the
// app's chart conventions: thin bars with a 4 px rounded data end, value
// labels at the tip, recessive gridlines, text in ink colours only.

import { VERSION } from './version.js';

const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";
const INK = '#0b0b0b';
const INK2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';
const AXIS = '#c3c2b7';
export const SERIES = '#2a78d6';
const W = 640; // 640 px × 3 = 1920 px ≈ 6.4 in at 300 DPI

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const fmtInt = (v) => Math.round(v).toLocaleString('en');
export const fmtCompact = (v) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: v >= 1000 ? 1 : 0 }).format(v);
export const fmtMoney = (cur) => (v) => `${cur} ${fmtCompact(v)}`;

// Round tick step (1, 2, 2.5 or 5 × 10ⁿ) giving about four intervals, and the axis maximum.
function niceScale(v, intervals = 4) {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / intervals;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
  return { max: Math.ceil(v / step - 1e-9) * step, step };
}
const ticksOf = ({ max, step }) => Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);

function text(x, y, s, { size = 11, fill = INK2, anchor = 'start', weight = 400, rotate = null } = {}) {
  const t = rotate != null ? ` transform="rotate(${rotate} ${x} ${y})"` : '';
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}"${t}>${esc(s)}</text>`;
}

// Wrap the plot in a titled, sourced figure.
function figure({ title, subtitle, source, height }, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">
<rect width="${W}" height="${height}" fill="#ffffff"/>
${text(24, 32, title, { size: 17, fill: INK, weight: 700 })}
${subtitle ? text(24, 52, subtitle, { size: 12, fill: INK2 }) : ''}
${body}
${text(24, height - 14, `Source: OpenHVRA v${VERSION}${source ? ` · ${source}` : ''}`, { size: 9.5, fill: MUTED })}
</svg>`;
}

// Horizontal bar chart. rows: [{ label, value, color? }]
export function barChart({ title, subtitle, rows, format = fmtInt, axisLabel = '', source = '', max = null, color = SERIES }) {
  const longest = Math.max(...rows.map((r) => r.label.length), 4);
  const labelW = Math.min(230, Math.max(100, longest * 6.4 + 10));
  const top = 74;
  const rowH = 30;
  const barH = 18;
  const plotX = 24 + labelW;
  const plotW = W - plotX - 78;
  const plotH = rows.length * rowH;
  const height = top + plotH + (axisLabel ? 66 : 50);
  const scale = max != null ? { max, step: max / 4 } : niceScale(Math.max(...rows.map((r) => r.value), 0));
  const vmax = scale.max;
  const X = (v) => plotX + (Math.max(0, v) / vmax) * plotW;
  let body = '';
  for (const v of ticksOf(scale)) {
    body += `<line x1="${X(v)}" x2="${X(v)}" y1="${top - 4}" y2="${top + plotH}" stroke="${v ? GRID : AXIS}" stroke-width="1"/>`;
    body += text(X(v), top + plotH + 15, format(v), { size: 10, fill: MUTED, anchor: 'middle' });
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    const w = X(r.value) - plotX;
    body += text(plotX - 8, y + barH / 2 + 4, r.label, { size: 11, fill: INK2, anchor: 'end' });
    if (w > 0.5) {
      const rr = Math.min(4, w);
      body += `<path d="M${plotX},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${barH - 2 * rr}a${rr},${rr} 0 0 1 -${rr},${rr}h-${w - rr}z" fill="${r.color ?? color}"><title>${esc(`${r.label}: ${format(r.value)}`)}</title></path>`;
    }
    body += text(X(r.value) + 6, y + barH / 2 + 4, format(r.value), { size: 11, fill: INK, weight: 600 });
  });
  if (axisLabel) body += text(plotX + plotW / 2, top + plotH + 33, axisLabel, { size: 10.5, fill: INK2, anchor: 'middle' });
  return figure({ title, subtitle, source, height }, body);
}

// Loss-exceedance curve: return period (log) vs value. points: [{ rp, value }]
export function exceedanceChart({ title, subtitle, points, format = fmtCompact, yLabel = '', source = '' }) {
  const top = 74;
  const left = 78;
  const plotW = W - left - 30;
  const plotH = 230;
  const height = top + plotH + 74;
  const scale = niceScale(Math.max(...points.map((p) => p.value), 0));
  const ymax = scale.max;
  const lx0 = Math.log(points[0].rp);
  const lx1 = Math.log(points[points.length - 1].rp);
  const X = (rp) => left + ((Math.log(rp) - lx0) / (lx1 - lx0 || 1)) * plotW;
  const Y = (v) => top + plotH - (v / ymax) * plotH;
  let body = '';
  for (const v of ticksOf(scale)) {
    body += `<line x1="${left}" x2="${left + plotW}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v ? GRID : AXIS}" stroke-width="1"/>`;
    body += text(left - 8, Y(v) + 4, format(v), { size: 10, fill: MUTED, anchor: 'end' });
  }
  for (const p of points) body += text(X(p.rp), top + plotH + 16, String(p.rp), { size: 10, fill: MUTED, anchor: 'middle' });
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.rp)},${Y(p.value)}`).join('');
  body += `<path d="${d}L${X(points[points.length - 1].rp)},${Y(0)}L${X(points[0].rp)},${Y(0)}Z" fill="${SERIES}" opacity="0.1"/>`;
  body += `<path d="${d}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const p of points) {
    body += `<circle cx="${X(p.rp)}" cy="${Y(p.value)}" r="4" fill="${SERIES}" stroke="#ffffff" stroke-width="2"><title>${esc(`${p.rp}-year: ${format(p.value)}`)}</title></circle>`;
  }
  const last = points[points.length - 1];
  body += text(X(last.rp) - 8, Y(last.value) - 10, format(last.value), { size: 11, fill: INK, anchor: 'end', weight: 600 });
  body += text(left + plotW / 2, top + plotH + 36, 'Return period (years, log scale)', { size: 10.5, fill: INK2, anchor: 'middle' });
  if (yLabel) body += text(18, top + plotH / 2, yLabel, { size: 10.5, fill: INK2, anchor: 'middle', rotate: -90 });
  return figure({ title, subtitle, source, height }, body);
}

const RATING = {
  Low: { fill: '#0ca30c', ink: '#0b0b0b' },
  Medium: { fill: '#fab219', ink: '#0b0b0b' },
  High: { fill: '#ec835a', ink: '#0b0b0b' },
  Extreme: { fill: '#d03b3b', ink: '#ffffff' },
};

// 5 × 5 likelihood × impact matrix. items: [{ label, likelihood, impact }]
export function matrixChart({ title, subtitle, items, likelihoodLabels, impactLabels, rating, source = '' }) {
  const top = 78;
  const left = 130;
  const cw = (W - left - 24) / 5;
  const ch = 58;
  const height = top + 5 * ch + 92;
  let body = '';
  for (let l = 5; l >= 1; l--) {
    const y = top + (5 - l) * ch;
    body += text(left - 8, y + ch / 2 + 4, likelihoodLabels[l - 1], { size: 10.5, fill: INK2, anchor: 'end' });
    for (let i = 1; i <= 5; i++) {
      const x = left + (i - 1) * cw;
      const r = rating(l * i);
      const st = RATING[r];
      body += `<rect x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="4" fill="${st.fill}"/>`;
      body += text(x + 6, y + 14, r, { size: 9, fill: st.ink, weight: 600 });
      const here = items.filter((m) => m.likelihood === l && m.impact === i).map((m) => m.label);
      here.slice(0, 3).forEach((lab, k) => {
        body += text(x + cw / 2, y + 30 + k * 12, lab, { size: 10.5, fill: st.ink, anchor: 'middle', weight: 700 });
      });
      if (here.length > 3) body += text(x + cw / 2, y + ch - 4, `+${here.length - 3} more`, { size: 9, fill: st.ink, anchor: 'middle' });
    }
  }
  for (let i = 1; i <= 5; i++) body += text(left + (i - 0.5) * cw, top + 5 * ch + 16, impactLabels[i - 1], { size: 10.5, fill: INK2, anchor: 'middle' });
  body += text(left + 2.5 * cw, top + 5 * ch + 36, 'Impact', { size: 11, fill: INK, anchor: 'middle', weight: 600 });
  body += text(20, top + 2.5 * ch, 'Likelihood', { size: 11, fill: INK, anchor: 'middle', weight: 600, rotate: -90 });
  return figure({ title, subtitle, source, height }, body);
}

// ---- PNG export ------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Insert a pHYs chunk so Word, PowerPoint and print tools treat the PNG as 300 DPI.
export async function withDpi(blob, dpi = 300) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 8 + 25; // after the signature and the IHDR chunk
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at));
  out.set(chunk, at);
  out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: 'image/png' });
}

export function canvasToPng(canvas, dpi = 300) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(withDpi(b, dpi)) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

// Render an SVG string to a 300-DPI PNG at `scale` × its size.
export async function svgToPng(svg, scale = 3) {
  const m = svg.match(/width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)"/);
  const [w, h] = [+m[1], +m[2]];
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, w, h);
  return canvasToPng(canvas);
}
