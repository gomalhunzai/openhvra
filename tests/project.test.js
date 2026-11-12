// Project files (js/project.js): building, compressing, reading back and
// checking untrusted files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  buildProject, encodeProject, decodeProject, readProject, versionNote, compareVersions, projectFileName, bboxArea,
  ProjectError, PROJECT_FORMAT, SCHEMA_VERSION,
} from '../js/project.js';

const ring = [[74.65, 36.31], [74.67, 36.31], [74.67, 36.33], [74.65, 36.33], [74.65, 36.31]];
const building = (fid, lon = 74.66, lat = 36.32) => ({
  type: 'Feature', center: [lon, lat], properties: { fid, kind: 'building', cls: 'residential', area: 80 },
  geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 1e-4, lat], [lon + 1e-4, lat + 1e-4], [lon, lat + 1e-4], [lon, lat]]] },
});

function sample({ withData = true } = {}) {
  return buildProject({
    name: 'Karimabad baseline',
    area: { type: 'polygon', polygons: [[ring]], name: 'Karimabad' },
    view: { center: [74.66, 36.32], zoom: 15, bearing: 0, pitch: 0 },
    settings: {
      controls: { 'pop-m2': 25, 'dl-roads': true, 'elev-source': 'copernicus', 'pop-known': null, bdetail: 'footprints' },
      floodScenarios: [{ rp: 10, level: 1 }, { rp: 100, level: 3 }],
      hazards: { river: { use: true, weight: 1 } },
      sviIndicators: ['health', 'roads'],
      costInfo: { source: 'gem', label: 'GEM', edited: true, typeFactors: { masonry: 0.9 } },
    },
    inputs: { marks: { lakes: [{ id: 'mark:3', kind: 'point', point: [74.7, 36.4], area: 5e4 }], glaciers: [], paths: {} }, lakeUploads: [], census: null },
    steps: { exposure: true, risk: true, svi: false, mh: false },
    data: {
      bbox: [74.65, 36.31, 74.67, 36.33], aoi: null, downloadedAt: '2026-11-12T10:00:00.000Z',
      loadOpts: { buildings: 'footprints', facilities: true, waterways: true, roads: true, paths: false },
      osm: withData ? { buildings: [building(1), building(2)], facilities: [], waterways: [], roads: [] } : null,
      added: { buildings: { auto: false, meta: { duplicates: 4, release: '2026-10-21.0' }, ...(withData ? { features: [building(10)] } : {}) } },
    },
  }, { appVersion: '0.13.0', repo: 'https://example.org', now: new Date('2026-11-12T12:00:00Z') });
}

test('a project round-trips through the compressed file', async () => {
  const doc = sample();
  const bytes = await encodeProject(doc);
  assert.equal(bytes[0], 0x1f, 'gzip magic');
  assert.equal(bytes[1], 0x8b);
  const back = await decodeProject(bytes);
  assert.deepEqual(back, doc);
  const { project, warnings } = readProject(back, '0.13.0');
  assert.equal(warnings.length, 0);
  assert.equal(project.name, 'Karimabad baseline');
  assert.equal(project.controls['pop-m2'], 25);
  assert.equal(project.controls['pop-known'], null);
  assert.equal(project.data.osm.buildings.length, 2);
  assert.equal(project.data.added.buildings.features.length, 1);
  assert.equal(project.data.added.buildings.auto, false);
  assert.deepEqual(project.steps, { exposure: true, risk: true, svi: false, mh: false });
  assert.equal(project.marks.lakes[0].id, 'mark:3');
  assert.equal(doc.created, '2026-11-12T12:00:00.000Z');
  assert.equal(doc.format, PROJECT_FORMAT);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
});

test('plain JSON (also with a byte-order mark) opens too', async () => {
  const doc = sample({ withData: false });
  const plain = new TextEncoder().encode('﻿' + JSON.stringify(doc));
  const { project } = readProject(await decodeProject(plain), '0.13.0');
  assert.equal(project.data.osm, null, 'saved without data');
  assert.ok(project.data.added.buildings, 'still says buildings were added');
  assert.equal(project.data.added.buildings.features, undefined);
});

test('gzip written by another tool opens', async () => {
  const bytes = gzipSync(Buffer.from(JSON.stringify(sample())));
  const { project } = readProject(await decodeProject(new Uint8Array(bytes)), '0.13.0');
  assert.equal(project.name, 'Karimabad baseline');
});

test('files that are not projects are refused with a clear message', async () => {
  await assert.rejects(decodeProject(new TextEncoder().encode('not json')), (e) => e instanceof ProjectError && /not valid JSON/.test(e.message));
  await assert.rejects(decodeProject(new Uint8Array([0x1f, 0x8b, 1, 2, 3])), (e) => e instanceof ProjectError && /damaged/.test(e.message));
  assert.throws(() => readProject({ type: 'FeatureCollection', features: [] }, '0.13.0'), /not an OpenHVRA project/);
  assert.throws(() => readProject({ ...sample(), schemaVersion: 'x' }, '0.13.0'), /layout version/);
  assert.throws(() => readProject({ ...sample(), schemaVersion: SCHEMA_VERSION + 1, app: { version: '9.0.0' } }, '0.13.0'), /newer version of OpenHVRA \(9\.0\.0\)/);
});

test('an invalid area is refused; a project without an area uses the data extent', () => {
  const bad = sample();
  bad.area = { type: 'polygon', polygons: [[[[0, 0], [1, 1]]]] };
  assert.throws(() => readProject(bad, '0.13.0'), /invalid outline/);
  const outOfRange = sample();
  outOfRange.area = { type: 'polygon', polygons: [[[[0, 0], [500, 0], [1, 1], [0, 0]]]] };
  assert.throws(() => readProject(outOfRange, '0.13.0'), /invalid outline/);
  const noArea = sample();
  noArea.area = null;
  const { project } = readProject(noArea, '0.13.0');
  assert.deepEqual(project.area, bboxArea([74.65, 36.31, 74.67, 36.33]));
});

test('damaged saved data falls back to downloading it again', () => {
  const doc = sample();
  doc.data.osm.buildings[1].center = ['x', 2];
  const { project, warnings } = readProject(doc, '0.13.0');
  assert.equal(project.data, null);
  assert.deepEqual(project.redownload.bbox, [74.65, 36.31, 74.67, 36.33]);
  assert.match(warnings[0].text, /downloaded again/);
});

test('settings keep only plain values with safe names', () => {
  const doc = sample();
  doc.settings.controls = { ok: 1, 'bad id"><img': 2, obj: { a: 1 }, arr: [1], str: 'x'.repeat(1000), __proto__x: true };
  const { project } = readProject(doc, '0.13.0');
  assert.deepEqual(Object.keys(project.controls).sort(), ['ok', 'str']);
  assert.equal(project.controls.ok, 1);
  assert.equal(project.controls['bad id"><img'], undefined);
  assert.equal(project.controls.obj, undefined);
  assert.equal(project.controls.arr, undefined);
  assert.equal(project.controls.str.length, 200);
});

test('marks, lakes and census are checked one by one', () => {
  const doc = sample();
  doc.inputs.marks = {
    lakes: [{ id: 'mark:1', kind: 'point', point: [74, 36], area: 1e4 }, { id: 'mark:2', kind: 'point', point: [999, 36], area: 1e4 }],
    glaciers: [{ id: 'mark:4', ring, area: 2e6 }, { id: 'mark:5', ring: [[0, 0]], area: 1 }],
    paths: { 'osm:1': [[74, 36], [74.1, 36.1]], 'osm:2': [[74, 36]] },
  };
  doc.inputs.lakeUploads = [{ id: 'up:0', name: 'Lake', lon: 74.2, lat: 36.2, area: 3e4, source: 'file' }, { lon: 'a' }];
  doc.inputs.census = { name: 'census.zip', field: 'poverty', features: [{ type: 'Feature', properties: { poverty: 3 }, geometry: { type: 'Polygon', coordinates: [ring] } }, { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }] };
  const { project } = readProject(doc, '0.13.0');
  assert.deepEqual(project.marks.lakes.map((l) => l.id), ['mark:1']);
  assert.deepEqual(project.marks.glaciers.map((g) => g.id), ['mark:4']);
  assert.deepEqual(Object.keys(project.marks.paths), ['osm:1']);
  assert.equal(project.lakeUploads.length, 1);
  assert.equal(project.census.features.length, 1);
  assert.equal(project.census.higher, true);
});

test('version notes follow the CHANGELOG rule', () => {
  assert.equal(compareVersions('0.13.0', '0.13.1'), -1);
  assert.equal(compareVersions('0.13.10', '0.13.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(versionNote('0.13.0', '0.13.0').level, 'ok');
  assert.equal(versionNote('0.13.0', '0.13.2').level, 'info');
  assert.match(versionNote('0.12.3', '0.13.0').text, /Methods have changed/);
  assert.match(versionNote('0.14.0', '0.13.0').text, /newer version/);
  assert.match(versionNote('1.2.0', '1.3.0').text, /fixes/); // after 1.0 a new minor number does not change methods
  assert.equal(versionNote(undefined, '0.13.0').level, 'warn');
  const old = sample();
  old.app.version = '0.12.3';
  assert.match(readProject(old, '0.13.0').warnings[0].text, /results may differ/);
});

test('file names are safe and dated', () => {
  const d = new Date('2026-11-12T08:00:00Z');
  assert.equal(projectFileName('Karimabad – flood baseline!', d), 'karimabad-flood-baseline-2026-11-12.openhvra');
  assert.equal(projectFileName('Zürich / Région', d), 'zurich-region-2026-11-12.openhvra');
  assert.equal(projectFileName('', d), 'openhvra-project-2026-11-12.openhvra');
  assert.equal(projectFileName('../../etc', d), 'etc-2026-11-12.openhvra');
});
