// Publication map layouts: the analysed area is redrawn off-screen at print
// resolution (the on-screen map is not touched), then composed on an A4
// landscape canvas at 300 DPI with title, legend, key figures, scale bar,
// north arrow and credits.

import { VERSION } from './version.js';
import { canvasToPng } from './pubcharts.js';

const PAGE = { w: 1123, h: 794 }; // A4 landscape in CSS px at 96 DPI
const DPI_SCALE = 300 / 96; // → 3509 × 2481 px
const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";
const INK = '#0b0b0b';
const INK2 = '#52514e';
const MUTED = '#898781';
const LINE = '#c3c2b7';

function waitIdle(m, ms = 45000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the map took too long to render (basemap tiles may be slow)')), ms);
    m.once('idle', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function niceDistance(m) {
  const p = 10 ** Math.floor(Math.log10(m));
  return [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= m).pop() ?? p;
}

// Word-wrap `s` to `maxW` px; returns lines.
function wrap(ctx, s, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(s).split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// opts: { bounds: [[w,s],[e,n]], title, subtitle, legendTitle, legend: [{ label, color, kind: 'fill'|'line'|'dot' }],
//         ramp: [{ label, color }], stats: [[label, value]], credits, show: [layerIds], hide: [layerIds],
//         data: { sourceId: geojson } }
// Returns a 300-DPI PNG Blob.
export async function renderMapLayout(map, opts) {
  const s = DPI_SCALE;
  const M = 28;
  const legendW = 250;
  const mapBox = { x: M, y: 88, w: PAGE.w - 2 * M - legendW - 16, h: PAGE.h - 88 - 62 };

  // Copy the current style, then adjust layers and data for this map only.
  const style = map.getStyle();
  for (const l of style.layers) {
    if (opts.hide?.includes(l.id)) l.layout = { ...l.layout, visibility: 'none' };
    if (opts.show?.includes(l.id)) l.layout = { ...l.layout, visibility: 'visible' };
  }
  for (const [id, data] of Object.entries(opts.data ?? {})) if (style.sources[id]) style.sources[id].data = data;
  // Publication maps are flat and north-up; restore 2D paint dimmed by the 3D view.
  delete style.terrain;
  for (const l of style.layers) if (opts.paint?.[l.id]) l.paint = { ...l.paint, ...opts.paint[l.id] };

  // Render at 2× the layout size (sharper basemap tiles, thinner print lines).
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${mapBox.w * 2}px;height:${mapBox.h * 2}px;`;
  document.body.appendChild(holder);
  const off = new maplibregl.Map({
    container: holder, style, interactive: false, attributionControl: false, fadeDuration: 0,
    preserveDrawingBuffer: true, pixelRatio: s / 2, bounds: opts.bounds, fitBoundsOptions: { padding: 60 },
  });
  try {
    await waitIdle(off);
    const page = document.createElement('canvas');
    page.width = Math.round(PAGE.w * s);
    page.height = Math.round(PAGE.h * s);
    const ctx = page.getContext('2d');
    ctx.scale(s, s);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE.w, PAGE.h);
    ctx.textBaseline = 'alphabetic';

    // Title and subtitle.
    ctx.fillStyle = INK;
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText(opts.title, M, 44);
    ctx.fillStyle = INK2;
    ctx.font = `400 13px ${FONT}`;
    ctx.fillText(opts.subtitle, M, 68);

    // Map image and frame.
    ctx.drawImage(off.getCanvas(), mapBox.x, mapBox.y, mapBox.w, mapBox.h);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(mapBox.x + 0.5, mapBox.y + 0.5, mapBox.w - 1, mapBox.h - 1);

    // North arrow (the export is always north-up).
    const nx = mapBox.x + mapBox.w - 30;
    const ny = mapBox.y + 22;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(nx, ny + 12, 17, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(nx, ny);
    ctx.lineTo(nx + 7, ny + 18);
    ctx.lineTo(nx, ny + 14);
    ctx.lineTo(nx - 7, ny + 18);
    ctx.closePath();
    ctx.fill();
    ctx.font = `700 9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('N', nx, ny + 29);
    ctx.textAlign = 'left';

    // Scale bar from the rendered zoom at the map centre (1 layout px = 2 render px).
    const lat = off.getCenter().lat;
    const mPerPx = ((40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** off.getZoom())) * 2;
    const dist = niceDistance(mapBox.w * 0.22 * mPerPx);
    const barPx = dist / mPerPx;
    const sx = mapBox.x + 14;
    const sy = mapBox.y + mapBox.h - 16;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(sx - 6, sy - 20, barPx + 12, 28);
    ctx.fillStyle = INK;
    ctx.fillRect(sx, sy - 4, barPx / 2, 4);
    ctx.strokeStyle = INK;
    ctx.strokeRect(sx + 0.5, sy - 3.5, barPx - 1, 4);
    ctx.font = `600 10px ${FONT}`;
    ctx.fillText(dist >= 1000 ? `${dist / 1000} km` : `${dist} m`, sx, sy - 8);

    // Legend column.
    let y = mapBox.y + 6;
    const lx = mapBox.x + mapBox.w + 16;
    const lw = legendW;
    const heading = (t) => {
      ctx.fillStyle = MUTED;
      ctx.font = `600 10px ${FONT}`;
      ctx.fillText(t.toUpperCase(), lx, y + 10);
      y += 22;
    };
    heading(opts.legendTitle ?? 'Legend');
    if (opts.ramp?.length) {
      const sw = lw / opts.ramp.length;
      opts.ramp.forEach((r, i) => {
        ctx.fillStyle = r.color;
        ctx.fillRect(lx + i * sw, y, sw, 14);
      });
      y += 28;
      ctx.font = `400 10.5px ${FONT}`;
      opts.ramp.forEach((r, i) => {
        ctx.fillStyle = r.color;
        ctx.fillRect(lx, y - 9, 10, 10);
        ctx.fillStyle = INK2;
        ctx.fillText(r.label, lx + 16, y);
        y += 16;
      });
      y += 4;
    }
    ctx.font = `400 11px ${FONT}`;
    for (const it of opts.legend ?? []) {
      ctx.fillStyle = it.color;
      if (it.kind === 'line') ctx.fillRect(lx, y - 5, 16, 3);
      else if (it.kind === 'dash') {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(lx, y - 4);
        ctx.lineTo(lx + 16, y - 4);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (it.kind === 'ring') {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(lx + 6, y - 4, 5, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (it.kind === 'dot') {
        ctx.beginPath();
        ctx.arc(lx + 6, y - 4, 5, 0, 2 * Math.PI);
        ctx.fill();
      } else ctx.fillRect(lx, y - 10, 14, 11);
      ctx.fillStyle = INK2;
      ctx.fillText(it.label, lx + 22, y);
      y += 18;
    }
    if (opts.stats?.length) {
      y += 12;
      heading('Key figures');
      for (const [k, v] of opts.stats) {
        ctx.fillStyle = INK;
        ctx.font = `700 15px ${FONT}`;
        ctx.fillText(v, lx, y + 4);
        y += 18;
        ctx.fillStyle = INK2;
        ctx.font = `400 10.5px ${FONT}`;
        for (const line of wrap(ctx, k, lw)) {
          ctx.fillText(line, lx, y);
          y += 14;
        }
        y += 8;
      }
    }

    // Credits.
    ctx.fillStyle = MUTED;
    ctx.font = `400 9.5px ${FONT}`;
    const foot = `OpenHVRA v${VERSION} (beta) · ${opts.credits} · Screening estimate: verify with local data and field checks.`;
    let fy = PAGE.h - 38;
    for (const line of wrap(ctx, foot, PAGE.w - 2 * M)) {
      ctx.fillText(line, M, fy);
      fy += 13;
    }
    return await canvasToPng(page);
  } finally {
    off.remove();
    holder.remove();
  }
}
