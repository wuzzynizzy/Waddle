# HTTP API

The settings drawer is a client of this API, and anything it can do can be scripted. All paths are
under `/-/api/`.

## Rules

- Every request needs the header `x-waddle: 1`. Browsers will not let another website send a custom
  header without permission, so the header is what keeps other sites from driving the API.
- `POST` bodies are JSON (`content-type: application/json`), at most 1 MB.
- If `WADDLE_PASSWORD` is set, send it as HTTP Basic credentials (user `waddle` unless `WADDLE_USER`
  says otherwise).
- Successful replies normally include the full state (below), plus any extra fields noted per call.
  `GET /-/api/inspect` is the exception: it returns only the request and cookie inspection data.
- State that belongs to a visitor (cookies, identity, the last route, hosts allowed without HTTPS) is
  that of the session named by the `waddle` cookie. A scripted client should keep that cookie.

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 200    | Done. The body is the state.                                                |
| 400    | Malformed JSON, an unknown action, or a rejected value.                     |
| 401    | Password missing or wrong.                                                  |
| 403    | The `x-waddle` header is missing, or the request came from another website. |
| 404    | No such endpoint.                                                           |
| 405    | Wrong method.                                                               |
| 413    | Body larger than 1 MB.                                                        |
| 415    | The body is not JSON.                                                       |

```sh
curl -c jar -b jar -H 'x-waddle: 1' http://localhost:8080/-/api/state
curl -c jar -b jar -H 'x-waddle: 1' -H 'content-type: application/json' \
     -d '{"route":{"hops":2,"countries":["US","DE"]}}' http://localhost:8080/-/api/config
```

## State

`GET /-/api/state`

```jsonc
{
  "config": { "route": {}, "dns": {}, "pool": {}, "spoof": {}, "privacy": {}, "ui": {} }, // see configuration.md
  "options": {
    // what the panel offers
    "systems": [{ "id": "win-chrome", "label": "Windows · Chrome", "kind": "desktop", "engine": "chromium", "gpus": ["NVIDIA RTX 3060"] }],
    "screens": ["1920x1080@1"],
    "networks": ["wifi", "4g", "3g", "2g", "slow-2g"],
    "dns": [{ "id": "cloudflare", "label": "Cloudflare", "url": "https://cloudflare-dns.com/dns-query" }],
    "search": [{ "id": "ddg", "label": "DuckDuckGo", "url": "https://duckduckgo.com/html/?q=%s" }],
    "countries": [["AE", "United Arab Emirates"]],
    "maxHops": 16,
    "maxDnsServers": 64,
    "maxSources": 2000,
    "profile": "small" // or "standard"
  },
  "pool": {
    "on": true,
    "status": "checking", // harvesting | checking | idle | paused | off
    "health": "ok", // ok | starting | searching | blocked | nolists | empty | off (below)
    "why": { "refused": 0, "timeout": 4, "unreachable": 0, "reset": 1124, "other": 0 }, // how tests failed since the last pass
    "note": "", // why it is paused, if it is
    "resumeIn": 0, // seconds until a paused pool retries
    "found": 60304, // candidates known
    "checked": 1119, // tests run
    "waiting": 59185, // candidates not yet tested
    "alive": 12, // proxies that passed and are in use
    "usable": 12, // of those, how many fit the protocol and country filters
    "plain": 7, // of those alive, how many may carry plain HTTP
    "byProto": { "http": 5, "socks4": 2, "socks5": 5 },
    "countries": { "US": 4, "DE": 3 },
    "discover": "", // a note from the last search for new sources, such as "github search: rate limited"
    "nextHarvest": 1500, // seconds
    // the 60 fastest live proxies; "ip" is the address sites see, "hits" and "errs" count requests
    "proxies": [
      {
        "proto": "socks5",
        "addr": "203.0.113.9:1080",
        "ms": 420,
        "cc": "DE",
        "ip": "203.0.113.9",
        "hits": 12,
        "errs": 0,
        "plain": true, // passed the tamper check and adds no headers: may carry plain HTTP
        "leaks": false, // adds headers that announce who is behind it
        "relay": true // false: it refused to connect onward, so it is only used as an exit
      }
    ],
    "sources": [
      {
        "id": "github:monosans/proxy-list",
        "type": "github", // github | gitlab | url | manual
        "name": "monosans/proxy-list",
        "on": true,
        "found": false, // added by discovery
        "state": "ok", // pending | loading | ok | error
        "error": "",
        "count": 1205, // candidates from the last harvest
        "alive": 3, // live proxies that came from here
        "tried": 64,
        "worked": 5, // proxies from here that ever passed
        "bad": 0, // proxies from here caught changing pages
        "resting": false, // failed repeatedly and is being left alone for a few rounds
        "via": "direct" // how the list was downloaded: "direct", or the proxy that carried it
      }
    ],
    "last": {
      // the caller's most recent page; one that failed has "error" and "detail" in place of "status" and "ms"
      "at": 1794312832228,
      "host": "example.com",
      "status": 200,
      "ms": 36,
      "hops": [{ "proto": "socks5", "addr": "203.0.113.9:1080", "cc": "DE", "ms": 420 }], // entry first, exit last
      "attempts": 1,
      "rule": "" // the routing rule that applied, if any
    }
  },
  "dns": {
    "mode": "auto",
    "strategy": "fallback",
    "cached": 11,
    "system": 0, // times the system resolver had to be used (Waddle's own downloads only)
    "last": { "host": "example.com", "via": "dns.google", "ms": 28, "address": "93.184.215.14", "routed": true }, // routed: asked through a proxy
    "servers": [
      {
        "url": "https://dns.google/dns-query",
        "name": "dns.google",
        "label": "",
        "auto": false, // true: from the tested public list
        "ok": 10,
        "fail": 0,
        "ms": 28,
        "down": false, // resting after repeated failures
        "error": "",
        "lies": 0 // times a cross-check caught it saying "no such name" for a name that exists
      }
    ],
    "feed": { "at": 1794359236416, "listed": 170, "tested": 30, "kept": 6, "error": "", "busy": false } // the public list
  },
  "cookies": 4, // cookies in the caller's jar
  "blocked": 17, // tracker requests refused for the caller
  "trackers": 171, // hosts on the tracker list
  "identity": {
    // what the caller's pages present
    "on": true,
    "id": "win-chrome",
    "label": "Windows · Chrome",
    "engine": "chromium",
    "mobile": false,
    "detectable": false, // true: another kind of browser than the real one is claimed
    "tz": "Europe/Berlin",
    "languages": ["de-DE", "de"],
    "cc": "DE", // the exit's country, once a page has been opened
    "screen": "1920x1080@1",
    "cores": 12,
    "gpu": "NVIDIA RTX 3060"
  },
  "plain": ["old.example"], // hosts the caller allowed without HTTPS
  "uptime": 3600 // seconds
}
```

`pool.health` in one word:

| Value       | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `ok`        | At least one proxy is live.                                                 |
| `starting`  | Nothing has been tested yet.                                                |
| `searching` | Tests are running and none has passed yet.                                  |
| `blocked`   | 300 or more tests and not one proxy ever answered: the network blocks them. |
| `nolists`   | Every source failed to download.                                            |
| `empty`     | There are no sources and no proxies.                                        |
| `off`       | Harvesting is off and nothing is known.                                     |

## Settings

`POST /-/api/config`

The body is a partial settings object; only the keys present are changed. Values are validated:
anything out of range is clamped and anything unrecognised is ignored, so a bad request cannot leave
the settings in a broken state.

```json
{ "route": { "hops": 2 }, "spoof": { "system": "mac-safari", "timezone": "Europe/Berlin" } }
```

`{ "reset": true }` restores every default.

## Pool

`POST /-/api/pool` with an `action`:

| Body                                                      | Effect                                                                        | Extra in the reply |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| `{"action":"harvest"}`                                    | Download every source again now, including those that are resting.            |                    |
| `{"action":"rotate"}`                                     | Forget every kept exit, so each site gets a new one.                          |                    |
| `{"action":"rotate","site":"example.com"}`                | A new exit for one site and the third parties on its pages.                   |                    |
| `{"action":"clear"}`                                      | Forget every proxy and start over.                                            |                    |
| `{"action":"add","text":"…","proto":"socks5"}`            | Add proxies by hand, one per line. `proto` is the default for bare `ip:port`. | `added`            |
| `{"action":"speed","url":"https://example.com/"}`         | Time a request through the fastest live exits. `url` is optional.             | `results`          |
| `{"action":"source","text":"owner/repo"}`                 | Add a source (any form listed in configuration.md).                           |                    |
| `{"action":"unsource","id":"github:owner/repo"}`          | Remove a source.                                                              |                    |
| `{"action":"toggle","id":"github:owner/repo","on":false}` | Switch a source on or off.                                                    |                    |

`results` from `speed` is a list of `{ "via": "<proxy>", "ms": 123, "status": 200 }` or
`{ "via": "<proxy>", "error": "…" }`. `ms` is the time to the first byte of the reply. Nothing is
ever timed directly. Without `url` the pool's own test page is used.

## DNS

`POST /-/api/dns`

| Body                                     | Effect                                                                  | Extra in the reply       |
| ---------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| `{"action":"flush"}`                     | Empty the cache and give rested resolvers another go.                   |                          |
| `{"action":"refresh"}`                   | Download the public resolver list again and test it, in the background. |                          |
| `{"action":"test","host":"example.com"}` | Ask every resolver in play, through the route a visit would take.       | `host`, `results`, `via` |

`results` is a list of `{ "name", "url", "ms", "address" }` or `{ "name", "url", "error" }`. `via`
lists the proxies the questions went through, entry first. With no proxy available every row has the
error `no proxy`: a name someone typed is never asked about directly.

## Cookies, identity, plain HTTP

| Call                                                         | Effect                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `POST /-/api/cookies` with `{}`                              | Empty the caller's cookie jar.                                                               |
| `POST /-/api/identity` with `{}`                             | Reset server-side session data: cookies, fingerprint, exits and cached lookups.             |
| `POST /-/api/plain` with `{"host":"old.example"}`            | Allow one host without HTTPS, for the caller's session.                                      |
| `POST /-/api/plain` with `{"host":"old.example","on":false}` | Take that back.                                                                              |

The interface's **New identity** action also clears browser-local history and open tabs, while
preserving bookmarks, saved addresses and frontend preferences. That browser-side cleanup is not
performed by calling the HTTP endpoint directly.

## Inspector

`GET /-/api/inspect?url=<encoded-http-or-https-URL>`

Returns `{ "requests": [...], "cookies": [...] }` for the caller's Waddle session. The newest
request records come first. Waddle keeps at most 200 records in memory per session and returns up to
150. The `url` parameter selects which site/path's cookies to show; the request list is the recent
session log, not a per-URL filter.

A request record includes its `url`, `method`, resource `type`, upstream `status`, status sent to
the browser (`waddleStatus`), elapsed `ms`, response `bytes`, known `servedBytes`, proxy `route`,
`blocked`/`error` reason and a small allow-list of response headers. `Set-Cookie` header values are
replaced with a note that they were kept in Waddle's jar. A cookie record includes its name, domain,
path, flags and expiry; HttpOnly cookie values are always empty, while other matching values are
included. The request log is process memory only: it is not written to disk and is cleared by New
identity, session expiry or restart.

The interface reads the current page's rewritten source in the browser; the private Waddle bootstrap
is omitted. See [Security](security.md#one-origin-for-everything) for the limits of keeping browser
and proxied-page data on one origin.

## Other endpoints

| Path                               | Purpose                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `GET /-/ping`                      | Health check. Answers 204 and never needs the password.                           |
| `GET /-/api/inspect?url=…`         | Recent request records and cookie details for the current Waddle session. See [Inspector](#inspector). |
| `GET /-/go?q=…`                    | Opens the interface on an address or a search, as the address/search box does.      |
| `GET /install.sh`, `/install.ps1`  | Public, downloadable platform installer scripts.                                  |
| `GET /<host>/<path>`               | Shortcut: `http://localhost:8080/example.com/news` opens that page in Waddle.     |
| `GET, POST /-/cookie`              | Used by the page script to read and write `document.cookie`. Not for general use. |
| `/-/ws?u=<ws URL>&o=<page origin>` | WebSocket relay used by proxied pages.                                            |
| `/~/<URL>`                         | The proxy itself. Served only to Waddle's own pages or as a top-level page visit. |
| `/~/f/<URL>`                       | The same, for a document that a page embeds in a frame.                           |
| `/~/https://check.waddle.invalid/` | The built-in **What sites see** page. The interface shows it as `waddle:check`.   |

## What a proxied answer carries

Every answer from Waddle has the header `X-Waddle: 1`. An answer without it was put there by
something between the browser and Waddle, such as a host's own error page.

| Header                      | Meaning                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `X-Waddle-Error: <code>`    | Waddle's own error page or line, not the site's answer. Codes below.        |
| `X-Waddle-Status: <n>`      | The status that was meant, when the one sent differs (below).               |
| `X-Waddle-Blocked: tracker` | The request went to a host on the tracker list and was refused (403).       |
| `X-Waddle-Upgrade: https`   | The address was plain HTTP and is being asked for over HTTPS instead (307). |
| `X-Waddle-Cookie`           | For the page script: what `document.cookie` should read after this answer.  |

A site's own `X-Waddle-*` headers are removed.

**Statuses.** Hosts and CDNs in front of an app often replace a 502, 504 or 520 to 530 answer with a
page of their own. Waddle therefore never sends those statuses, whether they are its own or the
site's: a document is sent as 200 and anything else as 500, and the status that was meant is in
`X-Waddle-Status`. For the same reason Waddle's own error page for a document is always sent as
200, whatever went wrong. A request that is not a document gets one line of text instead of a page.

**Error codes.**

| Code      | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `noproxy` | No proxy is available for this request, so the site was not contacted.    |
| `dns`     | The name does not exist, or could not be looked up.                       |
| `connect` | No exit that was tried could reach the site, or the connection failed.    |
| `refused` | The site turned away every exit that was tried (403, 429 or 503).         |
| `timeout` | The site, or the proxies on the way, took too long.                       |
| `nohttps` | The site did not answer over HTTPS, and HTTPS only is on.                 |
| `broken`  | The answer broke off while it was being read, or arrived damaged.         |
| `tracker` | A tracker's address was opened as a page.                                 |
| `rule`    | A routing rule blocks the site.                                           |
| `private` | The address is private or local.                                          |
| `away`    | Sent by the service worker, not the server: the server cannot be reached. |
