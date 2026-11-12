// Checks web/worker.js against a fake HenrikDev: routing, the key staying
// server-side, caching, retries, 429 handling and the per-visitor limit.
//
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'web', 'worker.js'), 'utf8');
const fx = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name + '.json'), 'utf8');
const KEY = 'HDEV-test-key';

let fresh = 0;
// A new copy of the Worker each time, so its in-memory cache starts empty.
async function loadWorker() {
  const mod = await import('data:text/javascript,' + encodeURIComponent(SRC + '\n// ' + fresh++));
  return mod.default;
}

// Fake HenrikDev. `script` maps "mmr" / "history" to a list of answers,
// used in order (the last one repeats).
function fakeHenrik(script) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init && init.headers && init.headers.Authorization });
    const kind = String(url).includes('/mmr-history/') ? 'history' : 'mmr';
    const list = script[kind];
    const next = list.length > 1 ? list.shift() : list[0];
    if (next instanceof Error) throw next;
    const [status, body, headers] = next;
    return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...(headers || {}) } });
  };
  return calls;
}

function get(worker, p, { origin, ip = '203.0.113.1', key = KEY } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== undefined) headers.Origin = origin;
  const env = key ? { HENRIK_API_KEY: key } : {};
  return worker.fetch(new Request('https://proxy.example' + p, { headers }), env);
}

const ok = (name) => [200, fx(name)];
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

test('answers a player with their MMR and history, and the key stays server-side', async () => {
  const w = await loadWorker();
  const calls = fakeHenrik({ mmr: [ok('mmr-diamond')], history: [ok('history-diamond')] });
  const r = await get(w, '/player/eu/Henrik3/VALO', { origin: 'https://fwsoapy.github.io' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await r.json();
  assert.equal(body.mmr.current.tier.name, 'Diamond 1');
  assert.equal(body.history.length, 10);
  assert.ok(!JSON.stringify(body).includes(KEY));
  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.henrikdev.xyz/valorant/v3/mmr/eu/pc/Henrik3/VALO',
    'https://api.henrikdev.xyz/valorant/v2/mmr-history/eu/pc/Henrik3/VALO',
  ]);
  assert.ok(calls.every((c) => c.auth === KEY));
});

test('names with spaces and accents reach HenrikDev encoded', async () => {
  const w = await loadWorker();
  const calls = fakeHenrik({ mmr: [ok('mmr-diamond')], history: [ok('history-diamond')] });
  const r = await get(w, '/player/NA/Some%20N%C3%A4me/%C3%84B1');
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, 'https://api.henrikdev.xyz/valorant/v3/mmr/na/pc/Some%20N%C3%A4me/%C3%84B1');
});

test('turns away other sites, bad routes and bad Riot IDs without calling HenrikDev', async () => {
  const w = await loadWorker();
  const calls = fakeHenrik({ mmr: [ok('mmr-diamond')], history: [ok('history-diamond')] });
  assert.equal((await get(w, '/player/eu/Henrik3/VALO', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get(w, '/player/eu/Henrik3/VALO', { origin: 'http://localhost:8000' })).status, 200);
  const before = calls.length;
  for (const [p, status] of [
    ['/', 404], ['/player/eu/Henrik3', 404], ['/stats/x', 404],
    ['/player/moon/Henrik3/VALO', 400], ['/player/eu/ab/VALO', 400], ['/player/eu/Henrik3/TOOLONG', 400],
    ['/player/eu/Hen%2Frik/VALO', 400], ['/player/eu/%E0%A4%A/VALO', 400],
  ]) {
    assert.equal((await get(w, p)).status, status, p);
  }
  assert.equal(calls.length, before);
  const noKey = await get(w, '/player/eu/Henrik3/VALO', { key: '' });
  assert.equal(noKey.status, 500);
  assert.match((await noKey.json()).error, /HENRIK_API_KEY/);
  const post = await w.fetch(new Request('https://proxy.example/player/eu/Henrik3/VALO', { method: 'POST' }), { HENRIK_API_KEY: KEY });
  assert.equal(post.status, 405);
  const pre = await w.fetch(new Request('https://proxy.example/player/eu/Henrik3/VALO', { method: 'OPTIONS', headers: { Origin: 'https://fwsoapy.github.io' } }), {});
  assert.equal(pre.status, 204);
});

test('caches for a minute, and only re-reads history after a new game', async () => {
  const w = await loadWorker();
  let t = 1_800_000_000_000;
  Date.now = () => t;
  const newer = JSON.parse(fx('mmr-diamond'));
  newer.data.latest_update.match_id = 'a-brand-new-match';
  const calls = fakeHenrik({
    mmr: [ok('mmr-diamond'), ok('mmr-diamond'), [200, JSON.stringify(newer)]],
    history: [ok('history-diamond')],
  });
  const count = (kind) => calls.filter((c) => c.url.includes(kind === 'h' ? '/mmr-history/' : '/v3/mmr/')).length;

  await get(w, '/player/eu/Henrik3/VALO');
  await get(w, '/player/eu/henrik3/valo');          // same player, any case
  assert.deepEqual([count('m'), count('h')], [1, 1]);

  t += 61_000;
  await get(w, '/player/eu/Henrik3/VALO');          // same latest match
  assert.deepEqual([count('m'), count('h')], [2, 1]);

  t += 61_000;
  await get(w, '/player/eu/Henrik3/VALO');          // a game finished
  assert.deepEqual([count('m'), count('h')], [3, 2]);
});

test('a 404 from HenrikDev is a clear "not found"', async () => {
  const w = await loadWorker();
  fakeHenrik({ mmr: [[404, fx('error-404')]], history: [ok('history-diamond')] });
  const r = await get(w, '/player/na/Nobody/NONE');
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /No Valorant account/);
});

test('a refused key says so instead of blaming the player', async () => {
  const w = await loadWorker();
  fakeHenrik({ mmr: [[401, '{"errors":[{"message":"Unauthorized"}]}']], history: [ok('history-diamond')] });
  const r = await get(w, '/player/na/Henrik3/VALO');
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /API key was refused/);
});

test('a server error is tried once more before giving up', async () => {
  const w = await loadWorker();
  const calls = fakeHenrik({ mmr: [[503, '{}'], ok('mmr-diamond')], history: [ok('history-diamond')] });
  const r = await get(w, '/player/eu/Henrik3/VALO');
  assert.equal(r.status, 200);
  assert.equal(calls.filter((c) => c.url.includes('/v3/mmr/')).length, 2);

  const w2 = await loadWorker();
  fakeHenrik({ mmr: [new TypeError('network down')], history: [ok('history-diamond')] });
  const down = await get(w2, '/player/eu/Henrik3/VALO');
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /Couldn't reach HenrikDev/);
});

test('HenrikDev 429: waits out Retry-After, serving the last answer it had', async () => {
  const w = await loadWorker();
  let t = 1_800_000_000_000;
  Date.now = () => t;
  const calls = fakeHenrik({
    mmr: [ok('mmr-diamond'), [429, fx('error-429'), { 'Retry-After': '40' }]],
    history: [ok('history-diamond')],
  });
  assert.equal((await get(w, '/player/eu/Henrik3/VALO')).status, 200);
  t += 61_000;
  const stale = await get(w, '/player/eu/Henrik3/VALO');
  assert.equal(stale.status, 200, 'old numbers beat an error');
  const n = calls.length;

  // Someone new while cooling down: no call upstream, a 429 with a wait.
  const r = await get(w, '/player/na/Other/ONE');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('Retry-After')) > 0);
  assert.equal(calls.length, n);

  t += 41_000;
  fakeHenrik({ mmr: [ok('mmr-immortal')], history: [ok('history-immortal')] });
  assert.equal((await get(w, '/player/na/Other/ONE')).status, 200);
});

test('one visitor is held to 30 requests a minute', async () => {
  const w = await loadWorker();
  let t = 1_800_000_000_000;
  Date.now = () => t;
  fakeHenrik({ mmr: [ok('mmr-diamond')], history: [ok('history-diamond')] });
  for (let i = 0; i < 30; i++) assert.equal((await get(w, '/player/eu/Henrik3/VALO', { ip: '198.51.100.7' })).status, 200);
  assert.equal((await get(w, '/player/eu/Henrik3/VALO', { ip: '198.51.100.7' })).status, 429);
  assert.equal((await get(w, '/player/eu/Henrik3/VALO', { ip: '198.51.100.8' })).status, 200);
  t += 60_000;
  assert.equal((await get(w, '/player/eu/Henrik3/VALO', { ip: '198.51.100.7' })).status, 200);
});
