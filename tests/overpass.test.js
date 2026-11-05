// Choosing and racing Overpass servers (js/osm.js), with a fake fetch so the
// tests are fast and do not touch the real servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raceServers, rankEndpoints, recordResult, runQuery } from '../js/osm.js';

const A = 'https://a.example/api/interpreter';
const B = 'https://b.example/api/interpreter';
const C = 'https://c.example/api/interpreter';

// Fake server behaviour per host: { ms, status, elements, statusText }.
function fakeFetch(plan, log = []) {
  return (url, opts = {}) => {
    const host = new URL(url).host;
    const p = plan[host];
    const isStatus = url.endsWith('/status');
    if (!isStatus) log.push(host);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (isStatus) return resolve(new Response(p.statusText ?? ''));
        if (p.fail) return reject(new TypeError('fetch failed'));
        resolve(new Response(JSON.stringify({ elements: p.elements ?? [{ host }] }), { status: p.status ?? 200 }));
      }, isStatus ? 1 : p.ms ?? 1);
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason); }, { once: true });
    });
  };
}

test('first server answers: no other server is asked', async () => {
  const log = [];
  const r = await raceServers('q', [A, B, C], { fetchImpl: fakeFetch({ 'a.example': { ms: 5 }, 'b.example': {}, 'c.example': {} }, log), hedgeMs: 100 });
  assert.deepEqual(r, [{ host: 'a.example' }]);
  assert.deepEqual(log, ['a.example']);
});

test('slow first server: the next is asked after the hedge time and the faster answer wins', async () => {
  const log = [];
  const t0 = Date.now();
  const r = await raceServers('q', [A, B, C], { fetchImpl: fakeFetch({ 'a.example': { ms: 1000 }, 'b.example': { ms: 10 }, 'c.example': {} }, log), hedgeMs: 50 });
  assert.deepEqual(r, [{ host: 'b.example' }]);
  assert.deepEqual(log, ['a.example', 'b.example']);
  assert.ok(Date.now() - t0 < 500, 'did not wait for the slow server');
});

test('failing server: the next is tried straight away, without waiting for the hedge time', async () => {
  const log = [];
  const t0 = Date.now();
  const r = await raceServers('q', [A, B], { fetchImpl: fakeFetch({ 'a.example': { fail: true }, 'b.example': { ms: 5 } }, log), hedgeMs: 5000 });
  assert.deepEqual(r, [{ host: 'b.example' }]);
  assert.ok(Date.now() - t0 < 1000);
});

test('busy server (HTTP 429): reads when the next slot is free', async () => {
  const plan = { 'a.example': { status: 429, statusText: 'Slot available after: 2026-11-05T17:00:12Z, in 12 seconds.\n' } };
  await assert.rejects(raceServers('q', [A], { fetchImpl: fakeFetch(plan), hedgeMs: 50 }), (err) => err.waitSecs === 12 && /busy \(next free slot in 12 s\)/.test(err.message));
});

test('Overpass error inside a 200 answer counts as a failure', async () => {
  const fetchImpl = (url, opts) => Promise.resolve(new Response(JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' })));
  await assert.rejects(raceServers('q', [A], { fetchImpl, hedgeMs: 50 }), /runtime error/);
});

test('ranking: fastest recent server first, recently failed servers last', () => {
  const now = 1_000_000;
  const stats = {};
  recordResult(stats, 'a.example', false, 0, now - 1000); // failed a second ago
  recordResult(stats, 'b.example', true, 40000, now);
  recordResult(stats, 'c.example', true, 9000, now);
  assert.deepEqual(rankEndpoints([A, B, C], stats, now), [C, B, A]);
  // after the penalty period the failure no longer counts, and unknown speed keeps list order
  assert.deepEqual(rankEndpoints([A, B, C], { 'a.example': { failedAt: now - 3_600_000 } }, now), [A, B, C]);
});

test('success time is smoothed, not replaced', () => {
  const stats = {};
  recordResult(stats, 'a.example', true, 10000);
  recordResult(stats, 'a.example', true, 20000);
  assert.equal(stats['a.example'].ms, 14000); // 0.6 × 10 s + 0.4 × 20 s
});

test('runQuery: a cancelled download stops at once', async () => {
  const ctrl = new AbortController();
  const p = runQuery('q-cancel', { signal: ctrl.signal, fetchImpl: fakeFetch({ 'overpass-api.de': { ms: 5000 }, 'overpass.private.coffee': { ms: 5000 }, 'maps.mail.ru': { ms: 5000 } }), hedgeMs: 10 });
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(p);
});
