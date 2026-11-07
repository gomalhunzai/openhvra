// Place search, mobile layout, version link and the welcome dialog.

import { VERSION, REPO } from '../version.js';
import { $ } from './shared.js';
import { escapeHtml } from './format.js';
import { map } from './map.js';
import { setStatus } from './area.js';

// ---- Search, mobile ---------------------------------------------------------------------------

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await res.json();
    if (!hit) return setStatus(`No place found for “${escapeHtml(q)}”.`, true);
    const [s, n, w, ea] = hit.boundingbox.map(Number);
    map.fitBounds([[w, s], [ea, n]], { maxZoom: 16, duration: 1200 });
    setStatus(`Moved to ${escapeHtml(hit.display_name)}. Draw an area or zoom in, then load data.`);
  } catch {
    setStatus('Search is unavailable right now.', true);
  }
});
$('panel-toggle').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed');
  setTimeout(() => map.resize(), 50);
});
// ---- Version ----------------------------------------------------------------------------------

for (const a of document.querySelectorAll('.version-link')) {
  a.textContent = `v${VERSION}`;
  a.href = `${REPO}/releases`;
}
// ---- Welcome / how-to dialog ------------------------------------------------------------------

const HELP_KEY = 'openhvra-help-hidden';
function helpHidden() {
  try {
    return localStorage.getItem(HELP_KEY) === '1';
  } catch {
    return false;
  }
}
$('help-btn').addEventListener('click', () => {
  $('help-hide').checked = helpHidden();
  $('help').showModal();
});
$('help-close').addEventListener('click', () => $('help').close());
$('help').addEventListener('close', () => {
  try {
    if ($('help-hide').checked) localStorage.setItem(HELP_KEY, '1');
    else localStorage.removeItem(HELP_KEY);
  } catch {
    /* storage unavailable: the dialog simply shows again next time */
  }
});
// Clicking the dimmed backdrop closes it too.
$('help').addEventListener('click', (e) => {
  if (e.target === $('help')) $('help').close();
});
if (!helpHidden()) $('help').showModal();
