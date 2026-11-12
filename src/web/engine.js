/*
 * Valorant Ranked Overlay - browser engine.
 *
 * The overlay runs entirely in the page. This file reads a player's ranked
 * data (HenrikDev's API, through the Cloudflare Worker in web/worker.js, which
 * holds the API key), works out the rank, RR, the RR gained today and today's
 * wins and losses, and hands that to the overlay page to draw.
 *
 * The Worker and HenrikDev both have request limits, so this file asks as
 * little as possible:
 *
 *   - One request per refresh, every two minutes by default, never more than
 *     once a minute (REFRESH_MIN_MS). RR only changes when a game ends, and a
 *     game takes 30+ minutes, so that's plenty.
 *   - Nothing is fetched while the overlay is hidden (an OBS source that isn't
 *     visible in any scene, or a background browser tab).
 *   - While OBS is open but not streaming, recording or running the virtual
 *     camera, it slows to every ten minutes (IDLE_MS).
 *   - Every overlay on the page's origin shares one cache in localStorage, so
 *     the same overlay in five scenes, or a scene switch that reloads it, does
 *     not cost five requests.
 *   - Failures back off up to ten minutes, and the last good numbers stay on
 *     screen with a small message under the card until it recovers.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RankedEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULT_PROXY = 'https://valorant-ranked-proxy.fwsoapy-gaming.workers.dev';

  var REFRESH_DEFAULT_MS = 2 * 60 * 1000;
  var REFRESH_MIN_MS = 60 * 1000;
  var REFRESH_MAX_MS = 15 * 60 * 1000;
  var IDLE_MS = 10 * 60 * 1000;          // OBS open, not live
  var BACKOFF_MAX_MS = 10 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 30 * 1000;
  // The first load retries quickly: OBS often starts before the network is up.
  var FIRST_LOAD_RETRY_MS = [5000, 10000, 20000, 30000, 60000];
  // A gap this long between games starts a new session.
  var SESSION_GAP_MS = 3 * 60 * 60 * 1000;
  var WINDOW_MS = { '12h': 12 * 3600 * 1000, '24h': 24 * 3600 * 1000 };
  var WINDOW_LABEL = { session: 'Today', '12h': '12h', '24h': '24h' };

  var REGIONS = ['na', 'eu', 'ap', 'kr', 'latam', 'br'];

  // Tier ids, names and colours as valorant-api.com lists them
  // (/v1/competitivetiers, the current table). Icons load from its CDN.
  var TIER_TABLE = '03621f52-342b-cf4e-4f86-9350a49c6d04';
  var ICON_BASE = 'https://media.valorant-api.com/competitivetiers/' + TIER_TABLE + '/';
  var DIVISIONS = [
    ['Iron', '#868986'], ['Bronze', '#a5855d'], ['Silver', '#bbc2c2'], ['Gold', '#eccf56'],
    ['Platinum', '#59a9b6'], ['Diamond', '#b489c4'], ['Ascendant', '#6ae2af'], ['Immortal', '#bb3d65']
  ];
  var RADIANT = 27;
  var IMMORTAL_1 = 24;

  var hasOwn = Object.prototype.hasOwnProperty;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function num(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return isFinite(n) ? n : null;
  }

  function iconUrl(id) { return ICON_BASE + id + '/largeicon.png'; }

  // 3 (Iron 1) to 27 (Radiant). Anything else (0 is Unrated) is null.
  function tierInfo(id) {
    id = num(id);
    if (id === RADIANT) return { id: RADIANT, name: 'Radiant', division: 'Radiant', color: '#ffffaa', top: true, icon: iconUrl(RADIANT) };
    if (id === null || id < 3 || id > 26 || id !== Math.floor(id)) return null;
    var d = DIVISIONS[Math.floor((id - 3) / 3)];
    return {
      id: id,
      name: d[0] + ' ' + ((id - 3) % 3 + 1),
      division: d[0],
      color: d[1],
      top: id >= IMMORTAL_1,
      icon: iconUrl(id)
    };
  }

  /* ------------------------------------------------------------------
   * Riot IDs and links
   * ---------------------------------------------------------------- */

  // Riot names are 3-16 characters, tags 3-5 letters or digits.
  function validName(name) {
    name = String(name || '');
    return name.length >= 3 && name.length <= 16 && name.trim() === name
      && !/[#\/\\?%\u0000-\u001f\u007f]/.test(name);
  }
  function validTag(tag) {
    return /^[\p{L}\p{N}]{3,5}$/u.test(String(tag || ''));
  }

  // "Name#TAG", or a tracker.gg profile link with one in it.
  function parseRiotId(text) {
    var s = String(text || '').trim();
    try { s = decodeURIComponent(s); } catch (e) { /* not encoded */ }
    var m = s.match(/\/riot\/([^/?]+#[^/?]+)/i);
    if (m) s = m[1];
    var i = s.lastIndexOf('#');
    if (i < 0) return null;
    var name = s.slice(0, i).trim(), tag = s.slice(i + 1).trim();
    return validName(name) && validTag(tag) ? { name: name, tag: tag } : null;
  }

  // Pages served from this PC (python -m http.server, a local file): a fork
  // testing its own Worker. Only there does ?proxy= count, so a link someone
  // hands a streamer can't point their overlay at a server that feeds it
  // made-up numbers or logs their IP.
  var LOCAL_PAGE = /^(localhost|127\.0\.0\.1|\[::1\]|)$/;

  function parseConfig(search, pageHost) {
    var q = new URLSearchParams(search || '');
    var refreshSec = parseInt(q.get('refresh') || '', 10);
    var refreshMs = isFinite(refreshSec) ? refreshSec * 1000 : REFRESH_DEFAULT_MS;
    refreshMs = Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, refreshMs));
    var hex = String(q.get('color') || '').replace('#', '').trim();
    var proxy = String(q.get('proxy') || '').trim().replace(/\/+$/, '');
    var local = typeof pageHost === 'string' && LOCAL_PAGE.test(pageHost);
    if (!local || !/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(proxy)) proxy = DEFAULT_PROXY;
    var region = String(q.get('region') || '').toLowerCase();
    var since = String(q.get('since') || 'session').toLowerCase();
    var demo = q.get('demo');
    var demoTier = demo === null ? 0 : (tierInfo(demo) ? Number(demo) : 19);
    return {
      name: String(q.get('name') || '').trim(),
      tag: String(q.get('tag') || '').trim(),
      region: REGIONS.indexOf(region) >= 0 ? region : '',
      since: hasOwn.call(WINDOW_LABEL, since) ? since : 'session',
      refreshMs: refreshMs,
      color: /^[0-9a-fA-F]{6}$/.test(hex) ? '#' + hex.toLowerCase() : null,
      wl: q.get('wl') !== '0',
      demo: demoTier,
      proxy: proxy
    };
  }

  function validConfig(cfg) {
    return !!cfg.region && validName(cfg.name) && validTag(cfg.tag);
  }

  /* ------------------------------------------------------------------
   * What the overlay shows
   * ---------------------------------------------------------------- */

  // Newest first, one entry per match.
  function gameList(history) {
    var seen = {};
    var out = [];
    (Array.isArray(history) ? history : []).forEach(function (g) {
      if (!isObj(g)) return;
      var t = Date.parse(String(g.date || ''));
      if (!isFinite(t)) return;
      var id = String(g.match_id || t);
      if (seen[id]) return;
      seen[id] = true;
      out.push({ t: t, rr: num(g.last_change) || 0, prot: g.was_derank_protected === true });
    });
    return out.sort(function (a, b) { return b.t - a.t; });
  }

  // Where the counted stretch starts. Session: the run of games ending with
  // the newest one, with no gap over 3 hours between them, and none at all
  // if the newest is more than 3 hours old. "Reset RR gain" moves it later.
  function windowStart(games, nowMs, since, resetAt) {
    if (hasOwn.call(WINDOW_MS, since)) return nowMs - WINDOW_MS[since];
    var start = nowMs;
    if (games.length && nowMs - games[0].t <= SESSION_GAP_MS) {
      start = games[0].t - 1;
      for (var i = 1; i < games.length; i++) {
        if (games[i - 1].t - games[i].t > SESSION_GAP_MS) break;
        start = games[i].t - 1;
      }
    }
    return Math.max(start, num(resetAt) || 0);
  }

  // A game that gained RR is a win and one that lost RR a loss. A loss that
  // rank protection turned into +0 is still a loss; any other +0 is a draw.
  function countGames(games, from) {
    var c = { rr: 0, wins: 0, losses: 0, draws: 0, games: 0 };
    games.forEach(function (g) {
      if (g.t <= from) return;
      c.games++;
      c.rr += g.rr;
      if (g.rr > 0) c.wins++;
      else if (g.rr < 0 || g.prot) c.losses++;
      else c.draws++;
    });
    return c;
  }

  /*
   * payload: what the Worker's /player route returns,
   *   { mmr: <HenrikDev v3 MMR data>, history: [<v2 MMR history entries>] }
   */
  function summarize(payload, nowMs, since, resetAt) {
    var mmr = isObj(payload) && isObj(payload.mmr) ? payload.mmr : {};
    var cur = isObj(mmr.current) ? mmr.current : {};
    var games = gameList(payload && payload.history);
    var tier = tierInfo(isObj(cur.tier) ? cur.tier.id : null);
    var rr = num(cur.rr);
    var place = isObj(cur.leaderboard_placement) ? num(cur.leaderboard_placement.rank) : null;
    var acct = isObj(mmr.account) ? mmr.account : {};
    var count = countGames(games, windowStart(games, nowMs, since, resetAt));
    var v = {
      ok: true,
      riot_id: acct.name && acct.tag ? acct.name + '#' + acct.tag : null,
      tier: tier ? tier.id : 0,
      tier_name: tier ? tier.name : 'Unrated',
      color: tier ? tier.color : null,
      icon: tier ? tier.icon : iconUrl(0),
      top: !!(tier && tier.top),
      rr: rr === null ? 0 : rr,
      leaderboard: place && place > 0 ? place : null,
      progress: null,
      next_name: null,
      rr_to_next: null,
      games_needed: tier ? null : num(cur.games_needed_for_rating),
      window: since,
      window_label: WINDOW_LABEL[since] || 'Today',
      rr_change: count.rr,
      wins: count.wins,
      losses: count.losses,
      draws: count.draws,
      games: count.games
    };
    // Below Immortal a rank is 100 RR, so the bar is the RR itself.
    if (tier && !tier.top) {
      v.rr = Math.max(0, Math.min(100, v.rr));
      v.progress = v.rr;
      v.next_name = tierInfo(tier.id + 1).name;
      v.rr_to_next = 100 - v.rr;
    }
    return v;
  }

  /* ------------------------------------------------------------------
   * Storage and requests
   * ---------------------------------------------------------------- */

  // A localStorage wrapper that never throws and falls back to memory, so the
  // overlay still works (just without the shared cache) if storage is blocked.
  function makeStore(backing) {
    var mem = {};
    return {
      get: function (key) {
        var raw = null;
        try { raw = backing ? backing.getItem(key) : null; } catch (e) { raw = null; }
        if (raw === null && hasOwn.call(mem, key)) raw = mem[key];
        if (raw === null) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      },
      set: function (key, value) {
        var raw = JSON.stringify(value);
        mem[key] = raw;
        try { if (backing) backing.setItem(key, raw); } catch (e) { /* full or blocked */ }
      },
      remove: function (key) {
        delete mem[key];
        try { if (backing) backing.removeItem(key); } catch (e) { /* blocked */ }
      }
    };
  }

  function HttpError(status, message) {
    var e = new Error(message || 'HTTP ' + status);
    e.status = status;
    e.serverMessage = message || null;
    return e;
  }

  function browserFetchText(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
    return fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        return r.text().then(function (text) {
          if (!r.ok) {
            var msg = null;
            try { msg = JSON.parse(text).error; } catch (e) { /* not JSON */ }
            throw HttpError(r.status, typeof msg === 'string' ? msg : null);
          }
          return text;
        });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function describeError(e) {
    var status = e && e.status;
    if (status === 403) return "this site isn't allowed to use the proxy";
    if (status === 404) return 'no Valorant account with that Riot ID in this region, check the name, tag and region';
    if (status === 429) return 'stats service is busy, trying again shortly';
    if (status === 400) return (e.serverMessage || "that Riot ID doesn't look right") + ', remake your link on the setup page';
    if (status) return e.serverMessage || 'HTTP ' + status + ' from the stats service';
    if (e && e.name === 'AbortError') return 'request failed: timed out';
    if (e && e.message === 'bad json') return 'request failed: response was not JSON';
    return "request failed: couldn't reach the proxy";
  }

  // Asking again won't fix these, so they wait the longest.
  function permanent(e) { return !!e && (e.status === 400 || e.status === 403 || e.status === 404); }

  /*
   * createEngine(opts)
   *   cfg        parseConfig() result
   *   store      makeStore() result (shared between overlays)
   *   fetchText  url -> Promise<string>, rejects with .status on HTTP errors
   *   now        () -> milliseconds
   *   isIdle     () -> true while OBS is open but not live
   */
  function createEngine(opts) {
    var cfg = opts.cfg;
    var store = opts.store || makeStore(null);
    var fetchText = opts.fetchText || browserFetchText;
    var clock = opts.now || function () { return Date.now(); };

    var who = cfg.region + ':' + (cfg.name + '#' + cfg.tag).toLowerCase();
    var K = { data: 'vro1:data:' + who, busy: 'vro1:busy:' + who, reset: 'vro1:reset:' + who };
    var url = cfg.proxy + '/player/' + cfg.region + '/' + encodeURIComponent(cfg.name) + '/' + encodeURIComponent(cfg.tag);

    var requests = 0;
    var listeners = [];
    var payload = null, payloadAt = 0;
    var failures = 0, lastError = null, lastAttempt = 0;
    var error = 'starting up';

    function get(u) {
      // Demo mode is the setup page's preview: it must never spend requests.
      if (cfg.demo) return Promise.reject(new Error('offline'));
      requests++;
      return fetchText(u);
    }

    function interval() {
      return opts.isIdle && opts.isIdle() ? Math.max(IDLE_MS, cfg.refreshMs) : cfg.refreshMs;
    }

    function parse(text) {
      var d;
      try { d = JSON.parse(text); } catch (e) { throw new Error('bad json'); }
      if (!isObj(d) || !isObj(d.mmr)) throw new Error('bad json');
      return d;
    }

    function readCached() {
      var c = store.get(K.data);
      if (!isObj(c) || typeof c.at !== 'number' || typeof c.text !== 'string') return null;
      return c;
    }

    function adopt(c) {
      if (c.at === payloadAt && payload !== null) return true;
      try { payload = parse(c.text); } catch (e) { return false; }
      payloadAt = c.at;
      if (!failures) error = null;
      return true;
    }

    var BUSY_MS = FETCH_TIMEOUT_MS + 2000;
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /*
     * Overlays opened together (OBS starting with the overlay in several
     * scenes) would all fetch the same thing at once. Before fetching, an
     * overlay claims the job in shared storage; the others wait for its
     * answer to land in the cache instead of asking again.
     */
    function claim() {
      var b = store.get(K.busy);
      if (isObj(b) && clock() - b.at < BUSY_MS) return Promise.resolve(false);
      var token = Math.random().toString(36).slice(2);
      store.set(K.busy, { at: clock(), token: token });
      // Two overlays can both see it free; the last write wins.
      return sleep(40).then(function () {
        var c = store.get(K.busy);
        return isObj(c) && c.token === token;
      });
    }

    // Resolves with read()'s first non-null answer, or null after `ms` of
    // real time (real time, so a stopped test clock can't hang it).
    function waitFor(read, ms) {
      var until = Date.now() + ms;
      return new Promise(function (resolve) {
        (function poll() {
          var v = read();
          if (v !== null && v !== undefined) return resolve(v);
          if (Date.now() >= until) return resolve(null);
          setTimeout(poll, 200);
        })();
      });
    }

    function fetchNow(cached) {
      lastAttempt = clock();
      return get(url).then(function (text) {
        var d = parse(text);
        var at = clock();
        store.set(K.data, { at: at, text: text });
        payload = d;
        payloadAt = at;
        failures = 0;
        lastError = null;
        error = null;
        return true;
      }).catch(function (e) {
        failures++;
        lastError = e;
        error = describeError(e);
        // Keep showing the last good numbers, from the cache if need be.
        if (payload === null && cached) adopt(cached);
        return true;
      });
    }

    /*
     * One refresh. Uses the shared cache when it is fresh enough, otherwise
     * fetches. Resolves to true when there is something (new) to show.
     */
    function refresh(force) {
      var cached = readCached();
      if (!force && cached && clock() < cached.at + interval() - 1500 && adopt(cached)) {
        return Promise.resolve(true);
      }
      return claim().then(function (mine) {
        if (!mine && !force) {
          // Another overlay is fetching right now: use its answer.
          var since = cached ? cached.at : 0;
          return waitFor(function () {
            var c = readCached();
            return c && c.at > since ? c : null;
          }, BUSY_MS).then(function (c) { return !!c && adopt(c); });
        }
        return fetchNow(cached).finally(function () { store.remove(K.busy); });
      });
    }

    // When the next refresh is due, in ms from now.
    function nextDelay() {
      var t = clock();
      if (failures > 0 && permanent(lastError)) return Math.max(1000, lastAttempt + BACKOFF_MAX_MS - t);
      if (failures > 0 && payload === null) {
        var quick = FIRST_LOAD_RETRY_MS[Math.min(failures, FIRST_LOAD_RETRY_MS.length) - 1];
        return Math.max(1000, lastAttempt + quick - t);
      }
      if (failures > 0) {
        var back = Math.min(BACKOFF_MAX_MS, interval() * Math.pow(2, failures - 1));
        return Math.max(1000, lastAttempt + back - t);
      }
      var c = readCached();
      return Math.max(1000, (c ? c.at : lastAttempt) + interval() - t);
    }

    function isDue() {
      var c = readCached();
      return !c || clock() >= c.at + interval() - 1500;
    }

    function view() {
      if (payload === null) return { ok: false, error: error || 'starting up' };
      var reset = cfg.since === 'session' ? num(store.get(K.reset)) : null;
      var v = summarize(payload, clock(), cfg.since, reset);
      v.error = error;
      v.updated_at = payloadAt;
      return v;
    }

    function emit() {
      listeners.slice().forEach(function (fn) {
        try { fn(); } catch (e) { /* a drawing bug shouldn't stop the engine */ }
      });
    }

    function init() {
      if (!validConfig(cfg)) {
        error = cfg.name || cfg.tag || cfg.region
          ? "that Riot ID or region doesn't look right, remake your link on the setup page"
          : 'no Riot ID in the link, make one on the setup page';
        return Promise.resolve(false);
      }
      return refresh(false);
    }

    // Lets another overlay's fresh numbers show up here without a request.
    function adoptShared() {
      var c = readCached();
      return !!c && c.at !== payloadAt && adopt(c);
    }

    return {
      config: cfg,
      keys: K,
      url: url,
      init: init,
      refresh: refresh,
      adoptShared: adoptShared,
      nextDelay: nextDelay,
      isDue: isDue,
      interval: interval,
      view: view,
      emit: emit,
      onUpdate: function (fn) { listeners.push(fn); },
      hasData: function () { return payload !== null; },
      requestCount: function () { return requests; },
      resetSession: function () { store.set(K.reset, clock()); },
      _setPayload: function (p) { payload = p; payloadAt = clock(); error = null; }
    };
  }

  /* ------------------------------------------------------------------
   * Demo data: what the setup page previews before a Riot ID is set, in
   * HenrikDev's own shape. demo=<tier id> picks the rank.
   * ---------------------------------------------------------------- */

  function demoData(tierId, nowMs) {
    var tier = tierInfo(tierId) || tierInfo(19);
    var rr = tier.id === RADIANT ? 612 : tier.top ? 187 : 62;
    var place = tier.id === RADIANT ? 37 : tier.top ? 412 : null;
    var changes = [21, -16, 24, 5];
    var history = changes.map(function (c, i) {
      return {
        match_id: 'demo-' + i,
        date: new Date(nowMs - (20 + i * 45) * 60 * 1000).toISOString(),
        last_change: c,
        was_derank_protected: false,
        tier: { id: tier.id, name: tier.name }
      };
    });
    return {
      mmr: {
        account: { name: 'Demo', tag: 'VRO' },
        current: {
          tier: { id: tier.id, name: tier.name },
          rr: rr,
          last_change: changes[0],
          leaderboard_placement: place ? { rank: place, updated_at: new Date(nowMs).toISOString() } : null,
          games_needed_for_rating: 0
        }
      },
      history: history
    };
  }

  /* ------------------------------------------------------------------
   * Running it in an overlay page
   * ---------------------------------------------------------------- */

  function startOverlay(search) {
    var cfg = parseConfig(search, location.hostname);
    var storage = null;
    try { storage = window.localStorage; } catch (e) { storage = null; }
    var store = makeStore(storage);

    // OBS tells browser sources when they are shown and whether the stream
    // or recording is running. Outside OBS none of this exists and the
    // overlay behaves as visible and live.
    var obs = typeof window.obsstudio !== 'undefined';
    var obsVisible = true;
    var tabVisible = typeof document.visibilityState === 'string' ? document.visibilityState !== 'hidden' : true;
    var outputs = { streaming: null, recording: null, virtualcam: null };

    function idle() {
      if (!obs) return false;
      var known = 0, on = false;
      Object.keys(outputs).forEach(function (k) {
        if (outputs[k] === true) on = true;
        if (outputs[k] !== null) known++;
      });
      // Only slow down when OBS has positively said nothing is running.
      return !on && known === 3;
    }

    var engine = createEngine({ cfg: cfg, store: store, isIdle: idle });
    var timer = null;

    function visible() { return obsVisible && tabVisible; }

    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (cfg.demo || !visible() || !validConfig(cfg)) return;
      var jitter = Math.floor(Math.random() * 3000);
      timer = setTimeout(run, engine.nextDelay() + jitter);
    }

    function run() {
      clearTimeout(timer);
      timer = null;
      engine.refresh(false).then(function (changed) {
        if (changed) engine.emit();
      }, function () {}).then(schedule);
    }

    function wake() {
      if (!visible()) { schedule(); return; }
      if (engine.isDue()) run();
      else schedule();
    }

    if (cfg.demo) {
      engine._setPayload(demoData(cfg.demo, Date.now()));
      setTimeout(engine.emit, 0);
    } else {
      engine.init().then(function () { engine.emit(); }, function () { engine.emit(); }).then(schedule);
      // The Session count and "12h" move with the clock, not just with data.
      setInterval(engine.emit, 60 * 1000);
    }

    document.addEventListener('visibilitychange', function () {
      tabVisible = document.visibilityState !== 'hidden';
      wake();
    });

    if (obs) {
      window.addEventListener('obsSourceVisibleChanged', function (e) {
        obsVisible = !(e && e.detail && e.detail.visible === false);
        wake();
      });
      var setOutput = function (name, value) {
        return function () { outputs[name] = value; wake(); };
      };
      window.addEventListener('obsStreamingStarted', setOutput('streaming', true));
      window.addEventListener('obsStreamingStopped', setOutput('streaming', false));
      window.addEventListener('obsRecordingStarted', setOutput('recording', true));
      window.addEventListener('obsRecordingStopped', setOutput('recording', false));
      window.addEventListener('obsVirtualcamStarted', setOutput('virtualcam', true));
      window.addEventListener('obsVirtualcamStopped', setOutput('virtualcam', false));
      try {
        if (typeof window.obsstudio.getStatus === 'function') {
          window.obsstudio.getStatus(function (st) {
            if (!st) return;
            outputs.streaming = !!st.streaming;
            outputs.recording = !!st.recording;
            outputs.virtualcam = !!st.virtualcam;
            schedule();
          });
        }
      } catch (e) { /* no permission: stay at the normal pace */ }
    }

    // Another overlay (another scene) fetched or reset: show it here too.
    window.addEventListener('storage', function (e) {
      if (cfg.demo) return;
      if (e.key === engine.keys.reset) { engine.emit(); return; }
      if (e.key !== engine.keys.data) return;
      if (engine.adoptShared()) engine.emit();
      schedule();
    });

    return {
      version: VERSION,
      config: cfg,
      onUpdate: engine.onUpdate,
      view: engine.view,
      requestCount: engine.requestCount,
      resetSession: function () { engine.resetSession(); engine.emit(); }
    };
  }

  return {
    VERSION: VERSION,
    DEFAULT_PROXY: DEFAULT_PROXY,
    REGIONS: REGIONS,
    REFRESH_DEFAULT_MS: REFRESH_DEFAULT_MS,
    REFRESH_MIN_MS: REFRESH_MIN_MS,
    IDLE_MS: IDLE_MS,
    BACKOFF_MAX_MS: BACKOFF_MAX_MS,
    tierInfo: tierInfo,
    parseRiotId: parseRiotId,
    parseConfig: parseConfig,
    validConfig: validConfig,
    makeStore: makeStore,
    createEngine: createEngine,
    startOverlay: startOverlay,
    demoData: demoData,
    describeError: describeError,
    // exposed for tests
    _core: { summarize: summarize, windowStart: windowStart, gameList: gameList, countGames: countGames }
  };
});
