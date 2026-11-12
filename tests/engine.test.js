// Checks src/web/engine.js: rank, RR, today's gain and record from
// HenrikDev-shaped answers, and the refresh loop's caching, error handling
// and request budget.
//
//   node --test tests/
//
// The fixtures in tests/fixtures/ follow HenrikDev's v3 MMR and v2 MMR
// history answers field for field (the Diamond one carries the numbers from
// HenrikDev's own documented example).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../src/web/engine.js');

const FX = path.join(__dirname, 'fixtures');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(FX, name + '.json'), 'utf8'));
const payload = (who) => ({ mmr: fx('mmr-' + who).data, history: fx('history-' + who).data.history });
const at = (iso) => Date.parse(iso);
const summarize = E._core.summarize;

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const CFG = '?name=Henrik3&tag=VALO&region=eu';

function engine(opts = {}) {
  const env = { now: at('2026-11-10T22:00:00Z'), calls: 0, respond: null };
  env.respond = opts.respond || (() => JSON.stringify(payload('diamond')));
  const e = E.createEngine({
    cfg: E.parseConfig(opts.search || CFG),
    store: opts.store || E.makeStore(memoryStorage()),
    fetchText: async (url) => { env.calls++; env.url = url; return env.respond(url); },
    now: () => env.now,
    isIdle: opts.isIdle,
  });
  return { e, env };
}

function httpError(status, message) {
  const err = new Error(message || 'HTTP ' + status);
  err.status = status;
  err.serverMessage = message || null;
  return err;
}

/* --- ranks ---------------------------------------------------------- */

test('tiers: names, colours and which ones have no 0-100 bar', () => {
  assert.equal(E.tierInfo(3).name, 'Iron 1');
  assert.equal(E.tierInfo(17).name, 'Platinum 3');
  assert.equal(E.tierInfo(21).name, 'Ascendant 1');
  assert.equal(E.tierInfo(26).name, 'Immortal 3');
  assert.equal(E.tierInfo(27).name, 'Radiant');
  assert.equal(E.tierInfo(18).color, '#b489c4');
  assert.equal(E.tierInfo(23).top, false);
  assert.equal(E.tierInfo(24).top, true);
  assert.equal(E.tierInfo(27).top, true);
  assert.match(E.tierInfo(12).icon, /^https:\/\/media\.valorant-api\.com\/competitivetiers\/[0-9a-f-]+\/12\/largeicon\.png$/);
  for (const bad of [0, 1, 2, 28, -1, 3.5, null, 'x']) assert.equal(E.tierInfo(bad), null, String(bad));
});

test('Riot IDs: Name#TAG and tracker.gg links', () => {
  assert.deepEqual(E.parseRiotId('Henrik3#VALO'), { name: 'Henrik3', tag: 'VALO' });
  assert.deepEqual(E.parseRiotId('  Some Name#EUW1 '), { name: 'Some Name', tag: 'EUW1' });
  assert.deepEqual(E.parseRiotId('https://tracker.gg/valorant/profile/riot/TenZ%230505/overview'), { name: 'TenZ', tag: '0505' });
  assert.deepEqual(E.parseRiotId('Ünïcødé#ÄÖÜ'), { name: 'Ünïcødé', tag: 'ÄÖÜ' });
  for (const bad of ['Henrik3', 'Henrik3#', '#VALO', 'ab#VALO', 'Henrik3#TOOLONG', 'Henrik3#V!L', 'a/b/c#VALO', 'x'.repeat(17) + '#VALO', '']) {
    assert.equal(E.parseRiotId(bad), null, bad);
  }
});

test('config: defaults, limits, and a proxy only counts on a local page', () => {
  const c = E.parseConfig(CFG + '&refresh=5&color=FF4655&since=24h&wl=0', 'fwsoapy.github.io');
  assert.equal(c.region, 'eu');
  assert.equal(c.refreshMs, E.REFRESH_MIN_MS);
  assert.equal(c.color, '#ff4655');
  assert.equal(c.since, '24h');
  assert.equal(c.wl, false);
  assert.equal(c.demo, 0);
  assert.ok(E.validConfig(c));

  const d = E.parseConfig('?region=moon&since=forever&refresh=99999&color=red', 'fwsoapy.github.io');
  assert.equal(d.region, '');
  assert.equal(d.since, 'session');
  assert.equal(d.refreshMs, 15 * 60 * 1000);
  assert.equal(d.color, null);
  assert.equal(d.wl, true);
  assert.equal(E.validConfig(d), false);

  assert.equal(E.parseConfig(CFG).refreshMs, E.REFRESH_DEFAULT_MS);
  assert.equal(E.parseConfig('?demo=1').demo, 19);
  assert.equal(E.parseConfig('?demo=27').demo, 27);

  const proxy = '&proxy=https://my-proxy.example.workers.dev/';
  assert.equal(E.parseConfig(CFG + proxy, 'fwsoapy.github.io').proxy, E.DEFAULT_PROXY);
  assert.equal(E.parseConfig(CFG + proxy, 'localhost').proxy, 'https://my-proxy.example.workers.dev');
  assert.equal(E.parseConfig(CFG + '&proxy=http://plain.example', 'localhost').proxy, E.DEFAULT_PROXY);
});

/* --- what the card shows -------------------------------------------- */

test('Diamond: RR bar, RR to the next rank, and the session so far', () => {
  const v = summarize(payload('diamond'), at('2026-11-10T22:00:00Z'), 'session', null);
  assert.equal(v.tier, 18);
  assert.equal(v.tier_name, 'Diamond 1');
  assert.equal(v.riot_id, 'Henrik3#VALO');
  assert.equal(v.rr, 38);
  assert.equal(v.progress, 38);
  assert.equal(v.rr_to_next, 62);
  assert.equal(v.next_name, 'Diamond 2');
  assert.equal(v.top, false);
  assert.equal(v.leaderboard, null);
  // Six games since 17:20, with a 4h50 gap before them: +15 -18 +22 0 -14 +19.
  assert.deepEqual([v.rr_change, v.wins, v.losses, v.draws, v.games], [24, 3, 2, 1, 6]);
  assert.equal(v.window_label, 'Today');
});

test('Last 12h and Last 24h count by the clock, across a promotion', () => {
  const now = at('2026-11-10T22:00:00Z');
  const h12 = summarize(payload('diamond'), now, '12h', null);
  assert.deepEqual([h12.rr_change, h12.wins, h12.losses, h12.draws, h12.window_label], [29, 4, 3, 1, '12h']);
  const h24 = summarize(payload('diamond'), now, '24h', null);
  assert.deepEqual([h24.rr_change, h24.wins, h24.losses, h24.draws], [59, 6, 3, 1]);
});

test('Session: Reset starts it over, and 3 quiet hours end it', () => {
  const p = payload('diamond');
  const reset = summarize(p, at('2026-11-10T22:00:00Z'), 'session', at('2026-11-10T19:00:00Z'));
  assert.deepEqual([reset.rr_change, reset.wins, reset.losses], [19, 2, 1]);
  const later = summarize(p, at('2026-11-11T00:20:00Z'), 'session', null);
  assert.deepEqual([later.rr_change, later.wins, later.losses, later.games], [0, 0, 0, 0]);
  // The reset doesn't touch the clock windows.
  const h12 = summarize(p, at('2026-11-10T22:00:00Z'), '12h', at('2026-11-10T21:00:00Z'));
  assert.equal(h12.rr_change, 29);
});

test('a rank-protected loss counts as a loss, and a match is only counted once', () => {
  const p = payload('diamond');
  p.history[3].was_derank_protected = true;          // the 0 RR game
  p.history.push(Object.assign({}, p.history[0]));   // the same match twice
  p.history.push({ date: 'not a date', last_change: 50 });
  p.history.push(null);
  const v = summarize(p, at('2026-11-10T22:00:00Z'), 'session', null);
  assert.deepEqual([v.rr_change, v.wins, v.losses, v.draws, v.games], [24, 3, 3, 0, 6]);
});

test('Immortal: RR without a bar, and the leaderboard spot', () => {
  const v = summarize(payload('immortal'), at('2026-11-10T22:00:00Z'), 'session', null);
  assert.equal(v.tier_name, 'Immortal 2');
  assert.equal(v.top, true);
  assert.equal(v.rr, 187);
  assert.equal(v.progress, null);
  assert.equal(v.rr_to_next, null);
  assert.equal(v.leaderboard, 412);
  assert.deepEqual([v.rr_change, v.wins, v.losses], [4, 1, 1]);
});

test('Unrated: no rank, and how many games are left', () => {
  const v = summarize(payload('unrated'), at('2026-11-10T22:00:00Z'), 'session', null);
  assert.equal(v.tier, 0);
  assert.equal(v.tier_name, 'Unrated');
  assert.equal(v.games_needed, 3);
  assert.equal(v.games, 0);
  assert.match(v.icon, /\/0\/largeicon\.png$/);
});

test('odd answers never throw', () => {
  for (const p of [null, {}, { mmr: null }, { mmr: { current: { tier: { id: 'x' }, rr: 'NaN' } }, history: 'no' }]) {
    const v = summarize(p, Date.now(), 'session', null);
    assert.equal(v.tier, 0);
    assert.equal(v.rr, 0);
  }
  // RR past 100 below Immortal (it happens for a moment on promotion) stays on the bar.
  const p = payload('diamond');
  p.mmr.current.rr = 140;
  assert.equal(summarize(p, Date.now(), 'session', null).progress, 100);
});

test('demo numbers: Diamond 2, +34 RR, 3 wins and a loss', () => {
  const now = Date.now();
  const v = summarize(E.demoData(19, now), now, 'session', null);
  assert.deepEqual([v.tier_name, v.rr, v.rr_change, v.wins, v.losses], ['Diamond 2', 62, 34, 3, 1]);
  const r = summarize(E.demoData(27, now), now, 'session', null);
  assert.deepEqual([r.tier_name, r.leaderboard, r.top], ['Radiant', 37, true]);
});

/* --- the refresh loop ----------------------------------------------- */

test('a link without a Riot ID never asks the network', async () => {
  const { e, env } = engine({ search: '?region=na' });
  await e.init();
  assert.equal(env.calls, 0);
  assert.equal(e.view().ok, false);
  assert.match(e.view().error, /Riot ID/);
});

test('fetches through the Worker and shows the answer', async () => {
  const { e, env } = engine({ search: '?name=Some%20Name&tag=%C3%84B1&region=ap' });
  await e.init();
  assert.equal(env.calls, 1);
  assert.equal(env.url, E.DEFAULT_PROXY + '/player/ap/Some%20Name/%C3%84B1');
  const v = e.view();
  assert.equal(v.ok, true);
  assert.equal(v.error, null);
  assert.equal(v.tier_name, 'Diamond 1');
});

test('a hiccup keeps the last numbers on screen, backs off, then recovers', async () => {
  const { e, env } = engine();
  await e.init();
  let fail = httpError(502, "Couldn't reach HenrikDev");
  env.respond = () => { throw fail; };

  env.now += E.REFRESH_DEFAULT_MS;
  await e.refresh(false);
  let v = e.view();
  assert.equal(v.ok, true, 'still shows the rank');
  assert.equal(v.tier_name, 'Diamond 1');
  assert.equal(v.error, "Couldn't reach HenrikDev");
  const first = e.nextDelay();

  env.now += first;
  fail = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await e.refresh(false);
  assert.equal(e.view().error, 'request failed: timed out');
  assert.ok(e.nextDelay() > first, 'waits longer after a second failure');

  for (let i = 0; i < 6; i++) { env.now += e.nextDelay(); await e.refresh(false); }
  assert.ok(e.nextDelay() <= E.BACKOFF_MAX_MS, 'never more than 10 minutes');

  env.respond = () => JSON.stringify(payload('immortal'));
  env.now += e.nextDelay();
  await e.refresh(false);
  v = e.view();
  assert.equal(v.error, null);
  assert.equal(v.tier_name, 'Immortal 2');
  assert.ok(e.nextDelay() <= E.REFRESH_DEFAULT_MS + 1);
});

test('a first load that fails retries quickly; a wrong Riot ID waits', async () => {
  const quick = engine({ respond: () => { throw new TypeError('Failed to fetch'); } });
  await quick.e.init();
  assert.equal(quick.e.view().ok, false);
  assert.equal(quick.e.view().error, "request failed: couldn't reach the proxy");
  assert.equal(quick.e.nextDelay(), 5000);
  quick.env.now += 5000;
  await quick.e.refresh(false);
  assert.equal(quick.e.nextDelay(), 10000);

  const missing = engine({ respond: () => { throw httpError(404, 'No Valorant account with that Riot ID in this region'); } });
  await missing.e.init();
  assert.match(missing.e.view().error, /no Valorant account/);
  assert.equal(missing.e.nextDelay(), E.BACKOFF_MAX_MS);

  const busy = engine({ respond: () => { throw httpError(429, 'Too many requests, slow down'); } });
  await busy.e.init();
  assert.equal(busy.e.view().error, 'stats service is busy, trying again shortly');

  const junk = engine({ respond: () => '<html>Cloudflare</html>' });
  await junk.e.init();
  assert.equal(junk.e.view().error, 'request failed: response was not JSON');
  const noMmr = engine({ respond: () => '{"error":null}' });
  await noMmr.e.init();
  assert.equal(noMmr.e.view().ok, false);
});

test('overlays on one PC share one cache', async () => {
  const store = E.makeStore(memoryStorage());
  const a = engine({ store });
  const b = engine({ store });
  b.env.now = a.env.now;
  await a.e.init();
  await b.e.init();
  assert.equal(a.env.calls + b.env.calls, 1);
  assert.equal(b.e.view().tier_name, 'Diamond 1');
  // The Reset button in one overlay counts in the other.
  a.e.resetSession();
  assert.equal(b.e.view().games, 0);
});

test('a broken cache entry is fetched again instead of crashing', async () => {
  const backing = memoryStorage();
  const store = E.makeStore(backing);
  const { e, env } = engine({ store });
  backing.setItem(e.keys.data, JSON.stringify({ at: env.now, text: '{not json' }));
  await e.init();
  assert.equal(env.calls, 1);
  assert.equal(e.view().ok, true);
});

test('storage that throws still works, just without sharing', async () => {
  const angry = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const { e } = engine({ store: E.makeStore(angry) });
  await e.init();
  assert.equal(e.view().tier_name, 'Diamond 1');
});

test('request budget: 3 hours live, and 3 hours with OBS open but idle', async () => {
  for (const [idle, max] of [[false, 3 * 30 + 1], [true, 3 * 6 + 1]]) {
    const { e, env } = engine({ isIdle: () => idle });
    const end = env.now + 3 * 3600 * 1000;
    await e.init();
    while (env.now < end) {
      env.now += e.nextDelay();
      await e.refresh(false);
    }
    assert.ok(env.calls <= max, `${idle ? 'idle' : 'live'}: ${env.calls} requests, max ${max}`);
    assert.ok(env.calls >= max / 2, `${idle ? 'idle' : 'live'}: only ${env.calls} requests`);
  }
});

test('demo mode never asks the network', async () => {
  const { e, env } = engine({ search: '?demo=19' });
  await e.refresh(true);
  assert.equal(env.calls, 0);
});
