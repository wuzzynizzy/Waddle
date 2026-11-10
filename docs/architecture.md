# Architecture

Waddle is one Node process with no dependencies. It serves a small browser interface, fetches
websites on the visitor's behalf, and keeps a pool of working proxies to fetch them through.

```
                       ┌────────────────────────── Waddle server ──────────────────────────┐
 browser               │                                                                   │
 ┌──────────────┐      │  server.js   routes, settings API, static files, access checks    │
 │ shell (/)    │─────▶│  proxy.js    one page request → upstream request → adapted reply  │
 │  └ iframe    │      │  rewrite.js  addresses in HTML, CSS, JS imports, playlists        │
 │    /~/<url>  │      │  cookies.js  one cookie jar per visitor                           │
 └──────────────┘      │  pool.js     harvest, test, rotate, chain                         │
                       │  dns.js      DNS over HTTPS, cache, health                        │
                       │  net.js      direct / HTTP / SOCKS4 / SOCKS5 connections, chains  │
                       └───────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                  [entry proxy ─ relay ─] exit proxy ─ website
```

| File                | Role                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| `server.js`         | HTTP server, routing, the settings API, access checks, start-up                 |
| `lib/proxy.js`      | Handles `/~/<url>` and WebSocket upgrades; exit rotation and fallback           |
| `lib/rewrite.js`    | Rewrites addresses in HTML, CSS, JavaScript imports, import maps, HLS playlists |
| `lib/pool.js`       | The proxy pool: sources, harvesting, testing, selection, chains                 |
| `lib/extract.js`    | Finds proxies in any text: plain lists, URLs, CSV, JSON, HTML tables            |
| `lib/tar.js`        | Streaming tar reader for repository snapshots                                   |
| `lib/net.js`        | Outbound connections: direct, through one proxy, or through a chain             |
| `lib/dns.js`        | DNS over HTTPS resolver with caching and health tracking                        |
| `lib/cookies.js`    | Server-side cookie jars and visitor sessions                                    |
| `lib/config.js`     | Settings: defaults, validation, persistence, identity presets                   |
| `public/app.js`     | The interface (address bar and settings drawer)                                 |
| `public/client.js`  | Script placed first in every proxied page                                       |
| `public/sw.js`      | Service worker that re-routes requests which escaped rewriting                  |

## Addresses

| Path                  | What it serves                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `/`                   | The interface. The page being viewed is kept in the URL fragment. |
| `/~/<absolute URL>`   | A proxied resource, for example `/~/https://example.com/a?b=1`.   |
| `/-/…`                | Waddle's own files and API (see [api.md](api.md)).                |
| `/<host>/<path>`      | Shortcut: `/example.com/news` opens that site in the interface.   |

## How a page request travels

1. The interface loads `/~/https://example.com/` in an iframe.
2. `proxy.js` works out the route for the site: a routing rule if one matches, otherwise the global
   mode. It asks the pool for an exit (and relays, for a chain).
3. Request headers are rebuilt from scratch for the site: the spoofed `User-Agent`, languages and
   client hints; the real `Origin` and `Referer` of the page that asked (mapped back from Waddle's
   addresses); cookies from the visitor's jar. Headers that would reveal the visitor or the proxy
   (`X-Forwarded-For`, `Via`, Waddle's own cookie and password) are never sent.
4. `net.js` connects: directly, through one proxy, or through a chain, with the name resolved by
   `dns.js` or handed to the exit to resolve.
5. If the exit is dead, or the site answers a page request with 403, 429 or 503, the exit is reported
   to the pool and another one is tried (up to `route.retries` more). In automatic mode the last
   resort is a direct connection. A request with a body that has already been sent is never sent
   through a second exit.
6. The reply is adapted:
   - `Set-Cookie` goes into the jar and is not passed to the browser.
   - Redirects are pointed back into the proxy.
   - Headers that would break framing or pin the browser to the real site (CSP, `X-Frame-Options`,
     HSTS, COOP/COEP/CORP, reporting headers, `Alt-Svc`) are removed.
   - HTML, CSS, JavaScript and HLS playlists are decoded (gzip, deflate, Brotli; any declared
     character set) and rewritten; everything else is streamed through byte for byte, with range
     requests and validators intact.
7. For HTML, the page script is inserted as the first thing in `<head>`, carrying the identity
   settings for this visitor.

Failures are answered with a short page for documents and a single line of text for everything
else, stating which stage failed: looking up the name, connecting, the proxy, or waiting for the site.

### Connections

Connections to sites and through proxies are kept open and reused, which is most of why a second
request through a three-proxy chain costs about the same as a direct one. Two things follow from
that, both handled in `net.js`:

- **A reused connection may already be dead.** Servers and proxies close idle connections without
  notice, and the first sign is a reset on the next request. When that happens on a connection that
  had been used before, the request is repeated once on a new connection, as browsers do. A reset on
  a connection that was new is a real failure and is reported.
- **A name may have an address that does not work.** When a site has several addresses and the
  connection to one is cut off before the request could be sent (seen in practice: a filtered
  network that resets the TLS handshake to one address of a pair), that address is put at the back
  of the queue for ten minutes and the request is made again on the next one.

## Keeping a page inside the proxy

Three layers, each catching what the previous one cannot:

1. **Server-side rewriting.** Addresses in HTML attributes (`href`, `src`, `srcset`, `action`,
   `poster`, inline styles, `<meta refresh>`, import maps), in CSS (`url()`, `@import`) and in
   JavaScript `import` statements are rewritten as the document passes through. The scanners are
   single forward passes with bounded matching, so a hostile page cannot stall the server.
2. **The page script** (`public/client.js`). JavaScript builds addresses while it runs, where no
   rewriter can see them. The script wraps the places they are used: `fetch`, `XMLHttpRequest`,
   `WebSocket`, `EventSource`, `sendBeacon`, workers, element properties such as `img.src`, elements
   added to the page later, `history`, `window.open`, form submission and `document.cookie`. It also
   hides the fact that the page is inside a frame, and gives each site its own `localStorage`,
   `sessionStorage` and IndexedDB names, since all sites share Waddle's origin.
3. **A last line.** If the service worker (`public/sw.js`) controls the page, any request that still
   points outside is sent back through the proxy. If it does not (it is not installed yet, or the
   browser does not allow it), a Content-Security-Policy confines the page to Waddle's own address,
   so a stray request is refused rather than sent from the visitor's browser.

What is not hidden: `location` inside the page shows Waddle's address. Rewriting every script to
hide that is slow and fragile, and Waddle does not attempt it. Some single-page apps route on
`location.pathname` and misbehave as a result.

## The proxy pool

```
sources ──▶ harvest ──▶ candidates ──▶ test against judge ──▶ live pool ──▶ routes
   ▲            │                            ▲                    │
   └─ discovery ┘                            └──── re-test ───────┘
```

**Sources.** Three kinds, all editable in the panel:

- GitHub repositories. The whole repository is downloaded as one snapshot (`codeload.github.com`)
  and read as a stream; list-like files (`.txt`, `.csv`, `.json`, `.list`, `.lst`, `.md`) are scanned.
  Files that hold other kinds of servers (V2Ray, Shadowsocks, Tor bridges and so on) are skipped.
- GitLab projects, the same way, through GitLab's archive API.
- Any URL that returns a list: plain text, JSON, CSV or an HTML table.

**Extraction.** `lib/extract.js` finds `ip:port` in any of those formats, with credentials if
present. The protocol comes from the entry itself (`socks5://…`), else from the file's name or path
(`socks4.txt`), else every protocol is tried during testing. Private and reserved addresses are
discarded.

**Discovery.** After each harvest Waddle searches GitHub for recently updated repositories named
or tagged as proxy lists, and adds up to `pool.discoverMax` of them as sources, marked "found". A
found source that keeps failing to download, or that yields no working proxy after 600 tests, is
dropped again and not re-added.

**Testing.** Nothing is used untested. Each candidate has to fetch the judge page
(`pool.judge`, by default Cloudflare's trace page over HTTPS). A pass proves the proxy can carry an
HTTPS request without tampering, and the judge's reply gives the exit's public address and country.
`pool.concurrency` tests run at once; testing pauses once `pool.target` proxies are live and resumes
when the pool shrinks. Candidates from sources that have produced live proxies before are tested
first.

**Upkeep.** Live proxies are re-tested every `pool.recheckMinutes`. A proxy that fails a real
request is re-tested immediately and evicted if it fails again. The live list is saved to
`data/pool.json`, so a restart begins with the proxies that were working, re-tested.

**Selection.** Among usable proxies (protocol and country filters applied), faster and steadier
ones are chosen more often, but all get traffic. Depending on `route.rotate` the choice is kept per
site, kept for everything for a while, or made anew for every request.

**Chains.** With two or three hops, Waddle connects to the entry proxy, asks it to connect to the
next one, and so on; the last proxy connects to the site. Each proxy sees only its neighbours, and
for HTTPS the site's certificate is verified through the whole chain. A chain is kept while it
works so that connections can be reused.

**When nothing works.** If hundreds of candidates in a row fail, the network is probably blocking
outbound proxy connections; the pool pauses and retries later instead of burning through its list.

## DNS

`lib/dns.js` speaks DNS over HTTPS (RFC 8484) to a stack of resolvers:

- **In order**: use the first; move down the stack when one fails.
- **Fastest**: ask all at once, take the first answer.
- **Rotate**: spread questions across the stack, so no single resolver sees them all.

Answers are cached for the lifetime the resolver gives them, kept between 30 seconds and one hour;
"no such name" is cached too. A resolver that fails three times in a row is rested for a minute. If the whole stack is unreachable, the system resolver is used
when `dns.fallback` allows it.

With `dns.remote` on (the default), SOCKS5 and HTTP proxies are given the site's name and resolve it
themselves, so the lookup happens at the exit. SOCKS4 has no way to pass a name, so Waddle resolves
it first. Direct connections always use Waddle's resolver.

## Identity

`lib/config.js` turns the identity settings into one consistent profile per visitor: request
headers (`User-Agent`, `Accept-Language`, client hints) and the values the page script reports
(`navigator`, `screen`, time zone, media queries, fingerprint surfaces) are generated from the same
source, so they cannot disagree. Browser version numbers are derived from the date, so presets do
not go stale. Noise added to canvas and audio is derived from the session and the site: stable on
one site, different on the next.

What this does not change is the network-level fingerprint. Sites that inspect the TLS handshake
or HTTP framing see Node, whatever the `User-Agent` says.

## Cookies and sessions

Waddle sets one cookie of its own, `waddle`, which names the visitor's session. Each session has a
jar on the server that follows the browser rules for domain, path, `Secure`, `HttpOnly`, expiry and
public suffixes. Page scripts read and write cookies through the page script, which talks to the
jar; `HttpOnly` cookies are never shown to scripts. Jars are held in memory, bounded in size, and
dropped after a day without use.

## Limits and safeguards

- Request bodies up to 32 MB are buffered so they can be replayed on another exit; larger ones are
  refused with 413.
- Documents up to 16 MB are rewritten; larger ones are streamed through untouched.
- Repository snapshots are capped at 25 MB compressed and 400 MB unpacked, list files at 8 MB, and
  the pool holds at most 150,000 untested candidates.
- Connections to private, loopback and link-local addresses are refused, for sites and for proxies,
  whatever a name resolves to (see [security.md](security.md)).
