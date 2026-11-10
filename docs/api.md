# HTTP API

The settings drawer is a client of this API, and anything it can do can be scripted. All paths are
under `/-/api/`.

## Rules

- Every request needs the header `x-waddle: 1`. Browsers will not let another website send a custom
  header without permission, so the header is what keeps other sites from driving the API.
- `POST` bodies are JSON (`content-type: application/json`), at most 1 MB.
- If `WADDLE_PASSWORD` is set, send it as HTTP Basic credentials (user `waddle` unless `WADDLE_USER`
  says otherwise).
- Every successful reply is the full state (below), plus any extra fields noted per call.

| Status | Meaning                                                 |
| ------ | ------------------------------------------------------- |
| 200    | Done. The body is the state.                            |
| 400    | Malformed JSON, an unknown action, or a rejected value. |
| 401    | Password missing or wrong.                              |
| 403    | The `x-waddle` header is missing, or the request came from another website. |
| 404    | No such endpoint.                                       |
| 405    | Wrong method.                                           |
| 413    | Body larger than 1 MB.                                  |
| 415    | The body is not JSON.                                   |

```sh
curl -H 'x-waddle: 1' http://localhost:8080/-/api/state
curl -H 'x-waddle: 1' -H 'content-type: application/json' \
     -d '{"route":{"mode":"proxy","hops":2}}' http://localhost:8080/-/api/config
```

## State

`GET /-/api/state`

```jsonc
{
  "config": { "route": {}, "dns": {}, "pool": {}, "spoof": {}, "ui": {} }, // see configuration.md
  "options": {
    "systems": [{ "id": "win-chrome", "label": "Windows · Chrome" }],
    "screens": ["1920x1080@1"],
    "networks": ["wifi", "4g", "3g", "2g", "slow-2g"],
    "dns": [{ "label": "Cloudflare", "url": "https://cloudflare-dns.com/dns-query" }]
  },
  "pool": {
    "on": true,
    "status": "checking", // starting | harvesting | checking | idle | paused | off
    "note": "", // why it is paused, if it is
    "resumeIn": 0, // seconds until a paused pool retries
    "found": 60304, // candidates known
    "checked": 1119, // tests run
    "waiting": 59185, // candidates not yet tested
    "alive": 12, // proxies that passed and are in use
    "usable": 12, // of those, how many fit the protocol and country filters
    "byProto": { "http": 5, "socks4": 2, "socks5": 5 },
    "countries": { "US": 4, "DE": 3 },
    "discover": "", // a note from the last search for new sources, such as "rate limited"
    "nextHarvest": 1500, // seconds
    // the 60 fastest live proxies; "ip" is the address sites see, "hits" and "errs" count requests
    "proxies": [{ "proto": "socks5", "addr": "203.0.113.9:1080", "ms": 420, "cc": "DE", "ip": "203.0.113.9", "hits": 12, "errs": 0 }],
    "sources": [
      {
        "id": "github:monosans/proxy-list",
        "type": "github", // github | gitlab | url | manual
        "name": "monosans/proxy-list",
        "on": true,
        "found": false, // added by discovery
        "state": "ok", // pending | loading | ok | error | off
        "error": "",
        "count": 1205, // candidates from the last harvest
        "alive": 3, // live proxies that came from here
        "tried": 64
      }
    ],
    "last": {
      // the most recent page request; one that failed has "error" in place of "status" and "ms"
      "at": 1794312832228,
      "host": "pypi.org",
      "status": 200,
      "ms": 36,
      "hops": [{ "proto": "socks5", "addr": "203.0.113.9:1080", "cc": "DE", "ms": 420 }], // entry first, exit last
      "direct": false,
      "fellBack": false, // went direct because no proxy answered
      "attempts": 1,
      "rule": "", // the routing rule that applied, if any
      "mode": "auto"
    }
  },
  "dns": {
    "mode": "doh",
    "strategy": "fallback",
    "cached": 11,
    "system": 0, // times the system resolver had to be used
    "last": { "host": "pypi.org", "via": "dns.google", "ms": 28, "address": "151.101.0.223" },
    "servers": [{ "url": "https://dns.google/dns-query", "name": "dns.google", "ok": 10, "fail": 0, "ms": 28, "down": false, "error": "" }]
  },
  "cookies": 4, // cookies in the caller's jar
  "uptime": 3600 // seconds
}
```

## Settings

`POST /-/api/config`

The body is a partial settings object; only the keys present are changed. Values are validated:
anything out of range is clamped and anything unrecognised is ignored, so a bad request cannot leave
the settings in a broken state.

```json
{ "route": { "mode": "proxy", "hops": 2 }, "spoof": { "system": "mac-safari", "timezone": "Europe/Berlin" } }
```

`{ "reset": true }` restores every default.

## Pool

`POST /-/api/pool` with an `action`:

| Body                                               | Effect                                                                          | Extra in the reply |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| `{"action":"harvest"}`                             | Download every source again now.                                                |                    |
| `{"action":"rotate"}`                              | Forget every kept exit, so each site gets a new one.                            |                    |
| `{"action":"rotate","site":"example.com"}`         | A new exit for one site.                                                        |                    |
| `{"action":"clear"}`                               | Forget every proxy and start over.                                              |                    |
| `{"action":"add","text":"…","proto":"socks5"}`     | Add proxies by hand, one per line. `proto` is the default for bare `ip:port`.   | `added`            |
| `{"action":"speed","url":"https://example.com/"}`  | Time a request directly and through the fastest live proxies. `url` is optional. | `results`          |
| `{"action":"source","text":"owner/repo"}`          | Add a source (any form listed in configuration.md).                             |                    |
| `{"action":"unsource","id":"github:owner/repo"}`   | Remove a source.                                                                |                    |
| `{"action":"toggle","id":"github:owner/repo","on":false}` | Switch a source on or off.                                               |                    |

`results` from `speed` is a list of `{ "via": "direct" | "<proxy>", "ms": 123, "status": 200 }` or
`{ "via": "…", "error": "…" }`, direct first. `ms` is the time to the first byte of the reply.

## DNS

`POST /-/api/dns`

| Body                                      | Effect                                              | Extra in the reply |
| ----------------------------------------- | --------------------------------------------------- | ------------------ |
| `{"action":"flush"}`                      | Empty the cache and give rested resolvers another go. |                  |
| `{"action":"test","host":"example.com"}`  | Ask every resolver in the stack, and the system.    | `host`, `results`  |

`results` is a list of `{ "name", "url", "ms", "address" }` or `{ "name", "url", "error" }`.

## Cookies

`POST /-/api/cookies` with `{}` empties the caller's cookie jar.

## Other endpoints

| Path                     | Purpose                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `GET /-/ping`            | Health check. Answers 204 and never needs the password.                                |
| `GET /-/go?q=…`          | Opens the interface on an address or a search, as the start page's box does.           |
| `GET /<host>/<path>`     | Shortcut: `http://localhost:8080/pypi.org/project/pip/` opens that page in Waddle.     |
| `GET, POST /-/cookie`    | Used by the page script to read and write `document.cookie`. Not for general use.      |
| `/-/ws?u=<ws URL>&o=<page origin>` | WebSocket relay used by proxied pages.                                       |
| `/~/<URL>`               | The proxy itself. Served only to Waddle's own pages or as a top-level page visit.      |
