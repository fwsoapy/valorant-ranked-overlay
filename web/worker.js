// Cloudflare Worker that lets the hosted overlay read HenrikDev's Valorant API.
//
// HenrikDev needs an API key on every request, and a key in a web page is a
// key anyone can copy. So the page asks this Worker, and the Worker adds the
// key, which lives in the HENRIK_API_KEY secret (Worker settings > Variables
// and Secrets), never in this file or the website.
//
// Route:
//   GET /player/<region>/<name>/<tag>
//     -> { mmr: <v3 MMR data>, history: [<v2 MMR history entries>], at: <ISO time> }
//
// region is one of na, eu, ap, kr, latam, br. The platform is always pc.
//
// It asks as little as it can, since every key has a rate limit:
//   - The MMR answer is kept for CACHE_MS, so overlays that share a player (or
//     a refresh storm) cost one request.
//   - The match history only changes when a game ends, so it's only fetched
//     again when the MMR answer names a newer match than the one stored.
//   - When HenrikDev says 429, every request waits out its Retry-After here
//     instead of making things worse.
// The cache lives in the Worker's memory, which is per instance and can be
// dropped at any time; that only ever costs an extra request.
//
// Requests from web pages are only answered for the sites in ALLOWED_ORIGINS,
// so nobody else can build their site on top of this Worker and spend its
// allowance. Requests with no Origin at all (curl, the address bar) still
// work, which keeps testing easy, so each visitor (IP address) is also held to
// a pace no overlay comes near (RATE_LIMIT).

const HENRIK = "https://api.henrikdev.xyz/valorant";

// Where the overlay is hosted. Add your own GitHub Pages address here (or in
// an ALLOWED_ORIGINS variable, comma separated) if you fork the repo.
// localhost and local files ("null") are for testing.
const ALLOWED_ORIGINS = [
  "https://fwsoapy.github.io",
  "null",
];
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const REGIONS = new Set(["na", "eu", "ap", "kr", "latam", "br"]);

const CACHE_MS = 60 * 1000;
const CACHE_MAX = 2000;            // players kept in memory per instance
const MAX_AGE = 30;                // seconds a browser may reuse an answer

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const SAFE = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
};

// Requests per visitor per minute. An overlay asks about once every two
// minutes and the setup page a few times while someone types, so this is far
// above any real use. Counted per Worker instance, so it's a rough cap.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const seen = new Map();            // ip -> { start, count }

// player key -> { at, mmr, matchId, history }
const cache = new Map();
let coolUntil = 0;                 // HenrikDev said 429: wait until then

function overLimit(request, now) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return false;
  if (seen.size > 10000) {
    for (const [k, v] of seen) if (now - v.start >= RATE_WINDOW_MS) seen.delete(k);
    if (seen.size > 10000) seen.clear();
  }
  let e = seen.get(ip);
  if (!e || now - e.start >= RATE_WINDOW_MS) {
    e = { start: now, count: 0 };
    seen.set(ip, e);
  }
  e.count++;
  return e.count > RATE_LIMIT;
}

function originAllowed(origin, env) {
  if (origin === null) return true;   // not a cross-site page request
  if (LOCAL_ORIGIN.test(origin)) return true;
  const extra = String((env && env.ALLOWED_ORIGINS) || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return ALLOWED_ORIGINS.includes(origin) || extra.includes(origin);
}

function reply(body, status, maxAge, extra) {
  return new Response(body, {
    status,
    headers: {
      ...CORS,
      ...SAFE,
      ...(extra || {}),
      "Content-Type": "application/json",
      "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

function error(status, message, extra) {
  return reply(JSON.stringify({ error: message }), status, 0, extra);
}

// Riot names are 3-16 characters, tags 3-5 letters or digits.
function validName(name) {
  return name.length >= 3 && name.length <= 16 && name.trim() === name &&
    !/[#/\\?%\u0000-\u001f\u007f]/.test(name);
}
function validTag(tag) {
  return /^[\p{L}\p{N}]{3,5}$/u.test(tag);
}

class Upstream extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter || 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HenrikDev call. A server error or a dropped connection is tried once
// more; a 4xx won't change by asking again.
async function henrik(path, key) {
  let status = 502;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1500);
    let r;
    try {
      r = await fetch(HENRIK + path, { headers: { Authorization: key, Accept: "application/json" } });
    } catch (e) {
      status = 502;
      continue;
    }
    if (r.ok) {
      try {
        const body = await r.json();
        if (body && body.data) return body.data;
      } catch (e) { /* fall through */ }
      throw new Upstream(502, "HenrikDev sent something that wasn't stats");
    }
    status = r.status;
    if (status === 429) {
      const wait = parseInt(r.headers.get("Retry-After") || r.headers.get("X-RateLimit-Reset") || "30", 10);
      throw new Upstream(429, "The stats service is busy, try again shortly", Math.min(300, Math.max(5, wait || 30)));
    }
    if (status === 404) throw new Upstream(404, "No Valorant account with that Riot ID in this region");
    if (status === 401 || status === 403) throw new Upstream(500, "The Worker's HenrikDev API key was refused");
    if (status < 500) throw new Upstream(status === 400 ? 400 : 502, `HenrikDev returned ${status}`);
  }
  throw new Upstream(502, status === 502 ? "Couldn't reach HenrikDev" : `HenrikDev returned ${status}`);
}

function remember(key, entry) {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    // Drop the oldest entry (Maps keep insertion order).
    cache.delete(cache.keys().next().value);
  }
  cache.delete(key);
  cache.set(key, entry);
}

async function player(region, name, tag, env, now) {
  const key = `${region}/${name}#${tag}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit;
  if (now < coolUntil) {
    if (hit) return hit;   // a little stale beats nothing
    throw new Upstream(429, "The stats service is busy, try again shortly", Math.ceil((coolUntil - now) / 1000));
  }

  const who = `${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  try {
    const mmr = await henrik(`/v3/mmr/${who}`, env.HENRIK_API_KEY);
    const latest = mmr && mmr.latest_update ? String(mmr.latest_update.match_id || "") : "";
    let history = hit && hit.history;
    // Only ask for the history again when there's a game it doesn't have.
    if (!history || !latest || latest !== hit.matchId) {
      const h = await henrik(`/v2/mmr-history/${who}`, env.HENRIK_API_KEY);
      history = Array.isArray(h && h.history) ? h.history : [];
    }
    const entry = { at: now, mmr, matchId: latest, history };
    remember(key, entry);
    return entry;
  } catch (e) {
    if (e instanceof Upstream && e.status === 429) coolUntil = now + e.retryAfter * 1000;
    // HenrikDev hiccuped: the last answer we had is better than an error.
    if (hit && e instanceof Upstream && e.status >= 429) return hit;
    throw e;
  }
}

export default {
  async fetch(request, env) {
    if (!originAllowed(request.headers.get("Origin"), env)) {
      return error(403, "This site isn't allowed to use this proxy");
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, ...SAFE } });
    if (request.method !== "GET") return error(405, "GET only");

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "player" || parts.length !== 4) return error(404, "Not found");

    const now = Date.now();
    if (overLimit(request, now)) return error(429, "Too many requests, slow down", { "Retry-After": "60" });

    let name, tag;
    try {
      name = decodeURIComponent(parts[2]);
      tag = decodeURIComponent(parts[3]);
    } catch (e) {
      return error(400, "That Riot ID doesn't look right");
    }
    const region = parts[1].toLowerCase();
    if (!REGIONS.has(region)) return error(400, "Region must be na, eu, ap, kr, latam or br");
    if (!validName(name) || !validTag(tag)) return error(400, "That Riot ID doesn't look right");
    if (!env.HENRIK_API_KEY) return error(500, "The Worker has no HENRIK_API_KEY secret set");

    try {
      const p = await player(region, name, tag, env, now);
      const body = JSON.stringify({ mmr: p.mmr, history: p.history, at: new Date(p.at).toISOString() });
      return reply(body, 200, MAX_AGE);
    } catch (e) {
      if (e instanceof Upstream) {
        return error(e.status, e.message, e.retryAfter ? { "Retry-After": String(e.retryAfter) } : null);
      }
      return error(502, "Something went wrong in the Worker");
    }
  },
};
