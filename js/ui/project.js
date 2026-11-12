// Project files: Save and Open (see ../project.js for the file format).
//
// Saving writes the area, every setting and input (water levels, costs,
// shares, uploaded census and lake layers, glacier and lake marks), which steps
// were run, the map view and, if chosen, the downloaded data. Opening checks the
// file, puts everything back, uses the saved data (or downloads it again) and
// reruns the steps that had been run, so the results come back as they were.

import { VERSION, REPO } from '../version.js';
import { buildProject, encodeProject, decodeProject, readProject, projectFileName, bboxArea, ProjectError, PROJECT_EXT, PROJECT_MIME } from '../project.js';
import { setElevationSource } from '../elevation.js';
import { $, state } from './shared.js';
import { escapeHtml } from './format.js';
import { actions, layerCtrl, map } from './map.js';
import { runExposure } from './exposure.js';
import { restoreCostInfo, runRisk } from './flood.js';
import { censusForProject, restoreCensus, runSVI } from './social.js';
import { lakeUploads, restoreLakeUploads, runMH } from './multihazard.js';
import { restoreMarks } from './glof.js';
import { addedForProject } from './completeness.js';

// Controls that are not settings: files, search, the project bar itself, and
// fields that are restored with the layer they belong to.
const NOT_SETTINGS = new Set(['search-q', 'upload-file', 'upload-feature', 'census-file', 'lake-file', 'census-field', 'census-higher', 'help-hide', 'project-name', 'project-data', 'project-file']);
const settingControls = () => [...document.querySelectorAll('#panel input[id], #panel select[id], #panel textarea[id]')]
  .filter((el) => !NOT_SETTINGS.has(el.id) && el.type !== 'file' && !el.closest('[id$="-results"], #completeness'));

let meta = { created: '' }; // of the project last opened or saved
let dirty = false;
let busy = false;

function status(html, cls = 'muted') {
  const el = $('project-status');
  el.className = `small ${cls}`;
  el.innerHTML = html;
}

// ---- Collecting -------------------------------------------------------------------------------

function controlValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number' || el.type === 'range') return el.value === '' ? null : +el.value;
  return el.value;
}

function collectSettings() {
  const controls = {};
  for (const el of settingControls()) controls[el.id] = controlValue(el);
  controls.bdetail = document.querySelector('input[name=bdetail]:checked')?.value ?? 'footprints';
  const C = state.costInfo ?? {};
  return {
    controls,
    floodScenarios: [...document.querySelectorAll('#scenario-table tbody tr')]
      .map((tr) => ({ rp: +tr.querySelector('.sc-rp').value, level: +tr.querySelector('.sc-level').value })),
    hazards: Object.fromEntries([...document.querySelectorAll('.hz-use')].map((el) =>
      [el.value, { use: el.checked, weight: +document.querySelector(`.hz-w[data-k="${el.value}"]`)?.value }])),
    sviIndicators: [...document.querySelectorAll('.svi-ind:checked')].map((el) => el.value),
    costInfo: Object.fromEntries(['source', 'label', 'citation', 'country', 'region', 'level', 'year', 'priceYear', 'gdpPc', 'edited', 'typeFactors']
      .filter((k) => C[k] != null).map((k) => [k, C[k]])),
  };
}

function cleanArea(a) {
  if (!a) return null;
  const { type, polygons, name, radius, usedBBox } = a;
  return { type, polygons, ...(name ? { name } : {}), ...(radius ? { radius } : {}), ...(usedBBox ? { usedBBox } : {}) };
}

function collect(withData) {
  const area = cleanArea(state.aoi) ?? bboxArea(state.dataset?.bbox ?? actions.currentBBox());
  const c = map.getCenter();
  const parts = {
    name: $('project-name').value.trim(),
    created: meta.created,
    area,
    view: { center: [+c.lng.toFixed(6), +c.lat.toFixed(6)], zoom: +map.getZoom().toFixed(2), bearing: +map.getBearing().toFixed(1), pitch: +map.getPitch().toFixed(1) },
    settings: collectSettings(),
    inputs: { marks: state.marks, lakeUploads: [...lakeUploads], census: censusForProject() },
    steps: { exposure: !!state.exposure, risk: !!state.risk, svi: !!state.sviDone, mh: !!state.mh },
    display: {
      riskScenario: state.riskScenario, mhShow: state.mh?.show ?? null,
      basemap: layerCtrl.basemap, layers: Object.fromEntries(layerCtrl.layers.map((l) => [l.key, l.visible])),
    },
    data: null,
  };
  if (state.dataset && state.osmParsed && state.loadOpts) {
    parts.data = {
      bbox: state.dataset.bbox, aoi: cleanArea(state.loadedAoi), loadOpts: state.loadOpts, downloadedAt: state.loadedAt ?? '',
      osm: withData ? state.osmParsed : null,
      added: addedForProject(withData),
    };
  }
  return buildProject(parts, { appVersion: VERSION, repo: REPO });
}

// The project as file bytes (also used for the ZIP package, without data).
export async function projectBytes(withData) {
  return encodeProject(collect(withData));
}

// ---- Saving -----------------------------------------------------------------------------------

const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

async function saveProject() {
  if (busy) return;
  const withData = $('project-data').checked && !!state.osmParsed;
  const name = projectFileName($('project-name').value);
  busy = true;
  status('Saving the project…');
  try {
    const doc = collect(withData);
    const bytes = await encodeProject(doc);
    const blob = new Blob([bytes], { type: PROJECT_MIME });
    let saved = name;
    if (window.showSaveFilePicker) {
      // Chrome and Edge: let the user choose where to save it.
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'OpenHVRA project', accept: { 'application/octet-stream': [PROJECT_EXT] } }],
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        saved = handle.name;
      } catch (err) {
        if (err.name === 'AbortError') return status('Not saved.');
        downloadBlob(blob, name); // the picker is not allowed here: fall back to a download
      }
    } else {
      downloadBlob(blob, name);
    }
    meta.created = doc.created;
    dirty = false;
    const what = withData ? 'with the downloaded data' : state.osmParsed ? 'without the downloaded data (it will be downloaded again when opened)' : 'area and settings';
    status(`Saved <b>${escapeHtml(saved)}</b> (${mb(bytes.length)}), ${what}.`, 'note');
  } catch (err) {
    status(`Could not save the project: ${escapeHtml(err.message)}`, 'warn');
  } finally {
    busy = false;
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- Opening ----------------------------------------------------------------------------------

function applyControl(el, v) {
  if (el.type === 'checkbox') {
    if (typeof v !== 'boolean') return false;
    el.checked = v;
  } else if (el.type === 'number' || el.type === 'range') {
    if (v === null) {
      if (el.type === 'range') return false;
      el.value = '';
      return true;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    let x = v;
    if (el.min !== '' && x < +el.min) x = +el.min;
    if (el.max !== '' && x > +el.max) x = +el.max;
    el.value = String(x);
  } else if (el.tagName === 'SELECT') {
    if (typeof v !== 'string' || ![...el.options].some((o) => o.value === v)) return false;
    el.value = v;
  } else {
    if (typeof v !== 'string') return false;
    el.value = el.maxLength > 0 ? v.slice(0, el.maxLength) : v;
  }
  return true;
}

function applySettings(P) {
  let skipped = 0;
  const byId = new Map(settingControls().map((el) => [el.id, el]));
  for (const [id, v] of Object.entries(P.controls)) {
    if (id === 'bdetail') {
      const r = document.querySelector(`input[name=bdetail][value="${CSS.escape(String(v))}"]`);
      if (r) r.checked = true;
      else skipped++;
      continue;
    }
    const el = byId.get(id);
    if (!el || !applyControl(el, v)) skipped++;
  }
  if (P.scenarios) {
    const rows = [...document.querySelectorAll('#scenario-table tbody tr')];
    rows.forEach((tr, i) => {
      const s = P.scenarios[i];
      applyControl(tr.querySelector('.sc-rp'), s ? s.rp : null);
      applyControl(tr.querySelector('.sc-level'), s ? s.level : null);
    });
    if (P.scenarios.length > rows.length) skipped += P.scenarios.length - rows.length;
    $('scenario-table').dispatchEvent(new Event('change', { bubbles: true })); // updates the river setting in step 7
  }
  if (P.hazards) {
    for (const el of document.querySelectorAll('.hz-use')) {
      const h = P.hazards[el.value];
      if (!h || typeof h !== 'object') continue;
      if (typeof h.use === 'boolean') el.checked = h.use;
      const w = document.querySelector(`.hz-w[data-k="${el.value}"]`);
      if (w) applyControl(w, h.weight);
    }
  }
  if (P.sviIndicators) {
    const on = new Set(P.sviIndicators);
    for (const el of document.querySelectorAll('.svi-ind')) if (el.value !== 'census') el.checked = on.has(el.value);
  }
  setElevationSource($('elev-source').value);
  $('radius').dispatchEvent(new Event('input', { bubbles: true }));
  return skipped;
}

// Clears the loaded data and every result, so nothing from before is mixed in.
function clearData() {
  state.abort?.abort();
  if (!state.dataset) return;
  actions.resetData();
}

async function openProjectFile(file) {
  if (busy) return;
  if (dirty && state.dataset && !window.confirm('Opening a project replaces the current area, settings and results. Unsaved changes will be lost. Continue?')) return;
  busy = true;
  setButtons(true);
  status(`Opening <b>${escapeHtml(file.name)}</b>…`);
  try {
    const doc = await decodeProject(new Uint8Array(await file.arrayBuffer()));
    const { project: P, warnings } = readProject(doc, VERSION);
    await applyProject(P, file.name, warnings);
  } catch (err) {
    const msg = err instanceof ProjectError ? err.message : `unexpected error (${err.message})`;
    status(`Could not open ${escapeHtml(file.name)}: ${escapeHtml(msg)}.`, 'warn');
  } finally {
    busy = false;
    setButtons(false);
  }
}

async function applyProject(P, fileName, warnings) {
  clearData();
  $('project-name').value = P.name;
  meta = { created: P.created };
  const skipped = applySettings(P);
  restoreMarks(P.marks);
  restoreLakeUploads(P.lakeUploads);
  restoreCensus(P.census);

  const D = P.data;
  const dataArea = D ? D.aoi ?? bboxArea(D.bbox) : P.redownload ? bboxArea(P.redownload.bbox) : null;
  actions.setAoi(dataArea ?? P.area);
  if (D) {
    // Download what was downloaded before, whatever the boxes say now.
    for (const k of ['buildings', 'facilities', 'waterways', 'roads', 'paths']) {
      const box = $(`dl-${k}`);
      if (box) box.checked = k === 'buildings' ? D.loadOpts.buildings !== 'none' : D.loadOpts[k];
    }
    if (D.loadOpts.buildings !== 'none') document.querySelector(`input[name=bdetail][value="${D.loadOpts.buildings}"]`).checked = true;
    actions.updateAoiInfo();
  }
  const [w, s, e, n] = actions.currentBBox();
  if (P.view?.center && Number.isFinite(P.view.zoom)) {
    map.jumpTo({ center: P.view.center, zoom: P.view.zoom, bearing: +P.view.bearing || 0, pitch: +P.view.pitch || 0 });
  } else {
    map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0, maxZoom: 17 });
  }
  if (P.costInfo) {
    // Costs looked up or typed in for this area are kept, not looked up again.
    const keep = P.costInfo.edited || (P.costInfo.source && P.costInfo.source !== 'placeholder');
    restoreCostInfo(P.costInfo, keep ? actions.currentBBox().join() : undefined);
  }

  // Data: as saved, or downloaded again.
  let loaded = false;
  let how = '';
  if (D?.osm) {
    status('Opening the project: using the saved data…');
    await actions.useSavedData(D);
    loaded = !!state.dataset;
    how = 'with the data saved in it';
  } else if (D || P.redownload) {
    status('Opening the project: downloading the data again…');
    loaded = await actions.loadData({ restore: D?.added ?? {} });
    how = loaded ? 'with the data downloaded again (OpenStreetMap may have changed since it was saved)' : '';
    if (!loaded) warnings.push({ level: 'warn', text: 'The data could not be downloaded, so the steps were not run again. Press Load OSM data to try again.' });
  }
  if (P.area && dataArea && JSON.stringify(P.area.polygons) !== JSON.stringify(dataArea.polygons)) actions.setAoi(P.area);

  // Rerun the steps that had been run, in order.
  const rerun = [];
  if (loaded) {
    const steps = [
      ['exposure', 'step 4', runExposure],
      ['risk', 'step 5', runRisk],
      ['svi', 'step 6', runSVI],
      ['mh', 'step 7', runMH],
    ];
    for (const [key, label, run] of steps) {
      if (!P.steps[key]) continue;
      if (key === 'svi' && state.sviDone) {
        rerun.push(label); // already run by step 7's combined risk
        continue;
      }
      status(`Opening the project: running ${label} again…`);
      try {
        await run();
        rerun.push(label);
      } catch (err) {
        warnings.push({ level: 'warn', text: `${label} could not be run again: ${err.message}` });
      }
    }
    restoreDisplay(P.display);
  }
  if (P.display?.basemap) setBasemap(P.display.basemap);

  const when = P.modified ? `, saved on ${escapeHtml(P.modified.slice(0, 10))}` : '';
  let html = `Opened <b>${escapeHtml(P.name || fileName)}</b>${when}${P.appVersion ? ` with OpenHVRA ${escapeHtml(P.appVersion)}` : ''}`;
  html += how ? `, ${how}.` : '. Press <b>Load OSM data</b> to download the data for the area.';
  if (rerun.length) html += ` Ran ${rerun.join(', ')} again.`;
  if (skipped) html += ` ${skipped} setting${skipped === 1 ? '' : 's'} could not be applied and kept the default.`;
  html = `<p>${html}</p>` + warnings.map((x) => `<p class="${x.level === 'warn' ? 'warn small' : 'muted'}">${escapeHtml(x.text)}</p>`).join('');
  status(html, 'note');
  dirty = false;
}

function restoreDisplay(D = {}) {
  const pick = (id, v) => {
    const el = $(id);
    if (!el || v == null || ![...el.options].some((o) => o.value === String(v)) || el.value === String(v)) return;
    el.value = String(v);
    el.dispatchEvent(new Event('change'));
  };
  pick('risk-scenario', D.riskScenario);
  pick('mh-show', D.mhShow);
  if (D.layers && typeof D.layers === 'object') {
    for (const l of layerCtrl.layers) {
      const v = D.layers[l.key];
      if (typeof v === 'boolean' && l.available && l.visible !== v) layerCtrl.setVisible(l.key, v);
    }
  }
}

function setBasemap(key) {
  const r = document.querySelector(`input[name=basemap][value="${CSS.escape(String(key))}"]`);
  if (!r || r.checked) return;
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
}

function setButtons(disabled) {
  $('project-open').disabled = disabled;
  $('project-save').disabled = disabled;
}

// ---- Wiring -----------------------------------------------------------------------------------

$('project-file').accept = `${PROJECT_EXT},.json`;
$('project-open').addEventListener('click', () => $('project-file').click());
$('project-file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) openProjectFile(f);
});
$('project-save').addEventListener('click', saveProject);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    saveProject();
  } else if (k === 'o') {
    e.preventDefault();
    $('project-file').click();
  }
});
// Unsaved work: any change of a setting, or new data or results.
$('panel').addEventListener('change', (e) => {
  if (!e.target.closest('.project-bar')) dirty = true;
});
$('panel').addEventListener('click', (e) => {
  if (e.target.closest('#load, #run, #run-risk, #run-svi, #run-mh, [data-mark], #add-b, #add-f, #remove-b, #remove-f')) dirty = true;
});
window.addEventListener('beforeunload', (e) => {
  if (!dirty || !state.dataset) return;
  e.preventDefault();
  e.returnValue = '';
});

Object.assign(actions, { openProjectFile, projectBytes });
