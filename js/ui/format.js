// Number and text formatting helpers, and small HTML builders.

import { FACILITY_GROUPS } from '../osm.js';

// ---- Formatting -------------------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function fmt(n) {
  return n.toLocaleString();
}
export function compact(v) {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: v >= 1000 ? 1 : 0 }).format(v);
}
export function money(v, cur) {
  return `${escapeHtml(cur)} ${compact(v)}`;
}
export function pctOf(a, b) {
  return b ? `${((100 * a) / b).toFixed(2)}%` : '0%';
}
export function m(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}
export function nearestText(n) {
  return n ? m(n.d) : '> 4 km';
}
export function row(label, value) {
  return `<tr><td>${label}</td><td class="num">${value}</td></tr>`;
}
export function pretty(t) {
  return String(t).replace(/_/g, ' ');
}
export function lineName(l) {
  return l.name ? `${escapeHtml(l.name)} <span class="muted">(${pretty(l.type)})</span>` : pretty(l.type);
}
export function groupTable(groups) {
  let h = '<table class="list">';
  for (const [g, def] of Object.entries(FACILITY_GROUPS)) {
    if (groups[g]) h += row(`<span class="dot" style="background:${def.color}"></span>${def.label}`, fmt(groups[g]));
  }
  return h + '</table>';
}
export function featureLabel(p) {
  const color = FACILITY_GROUPS[p.group]?.color ?? '#5c6b7a';
  const label = p.name ? `${escapeHtml(p.name)} <span class="muted">· ${escapeHtml(pretty(p.type))}</span>` : escapeHtml(pretty(p.type));
  return `<span class="dot" style="background:${color}"></span><a href="https://www.openstreetmap.org/${p.osm_id}" target="_blank" rel="noopener">${label}</a>`;
}
