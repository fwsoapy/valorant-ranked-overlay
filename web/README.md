# The website's Cloudflare Worker

The [overlay](https://fwsoapy.github.io/valorant-ranked-overlay/) runs entirely in the page (`src/web/engine.js`,
built into `docs/`). Its stats come from the [HenrikDev API](https://docs.henrikdev.xyz), which needs an API key on
every request. A key inside a web page is a key anyone can copy, so `worker.js` is a small Cloudflare Worker that
holds the key as a secret, calls HenrikDev for the page, and adds the CORS header.

It has one route, and it only answers pages on the sites listed in `ALLOWED_ORIGINS`, so nobody else can build on it
and use up the key's limit.

| Route | Calls |
| --- | --- |
| `/player/<region>/<name>/<tag>` | HenrikDev `v3/mmr/<region>/pc/<name>/<tag>`, and `v2/mmr-history/...` when there's a new game. Returns `{ mmr, history, at }`. |

`region` is `na`, `eu`, `ap`, `kr`, `latam` or `br`.

## Deploying it

You need a free HenrikDev API key:

1. Open the [HenrikDev dashboard](https://api.henrikdev.xyz/dashboard/) and sign in with Discord.
2. Pick **API Keys** in the sidebar and fill in **Generate New Key** (a Basic key is enough). Copy the key.

Then, from this folder (`web/`), with [Node.js](https://nodejs.org) installed:

```bash
npx wrangler deploy
npx wrangler secret put HENRIK_API_KEY
```

The second command asks for the key: paste it and press Enter. Without the secret the Worker answers every request
with "The Worker has no HENRIK_API_KEY secret set".

Or in the [Cloudflare dashboard](https://dash.cloudflare.com/): **Workers & Pages > Create > Start with Hello World!**,
name it `valorant-ranked-proxy`, **Edit code**, paste in `worker.js`, **Deploy**. Then **Settings > Variables and
Secrets > Add**, type **Secret**, name `HENRIK_API_KEY`, value your key.

If you fork the repo, add your own GitHub Pages address to `ALLOWED_ORIGINS` in `worker.js` (or set an
`ALLOWED_ORIGINS` variable, comma separated), and point `DEFAULT_PROXY` in `src/web/engine.js` at your Worker (then
run `python tools/build.py`). An overlay link's `?proxy=<worker url>` only counts when the overlay page itself is
served from your own PC (localhost or a local file), for trying out a Worker before you change `DEFAULT_PROXY`.

## Limits

HenrikDev limits each key, and counts a request plus any Riot calls it makes behind it. To stay well inside that, the
Worker:

- keeps each player's answer for a minute, so several overlays (or a refresh storm) cost one request,
- only re-reads the match history when the MMR answer names a game it hasn't seen,
- waits out HenrikDev's `Retry-After` after a 429, serving the last answer it had in the meantime,
- holds each visitor (IP address) to 30 requests a minute.

The cache lives in the Worker's memory, so a fresh Worker instance starts empty and costs one extra request. If the
key's limit starts running out, ask for a higher key tier on the HenrikDev dashboard.

Cloudflare's free plan allows 100,000 Worker requests a day. An overlay asks about 30 times an hour while live, 6
while OBS is open but not live, and never while it's hidden.

## Testing it

```
https://valorant-ranked-proxy.<your-subdomain>.workers.dev/player/eu/Henrik3/VALO
```

opened in a browser should show JSON with `mmr` and `history`. `node --test "tests/*.test.*"` in the repo root runs
the Worker against a fake HenrikDev.
