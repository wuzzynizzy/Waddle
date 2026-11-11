# Configuration

Almost everything is set from the settings drawer in the interface and saved to
`data/config.json`. Changes apply at once; nothing needs a restart. The same settings can be read and
changed over the [HTTP API](api.md). A handful of things that concern the process itself are
environment variables.

There is no setting that lets a site be reached without a proxy.

## Environment variables

| Variable                | Default                       | What it does                                                                                                |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8080`                        | Port to listen on.                                                                                          |
| `HOST`                  | `127.0.0.1`                   | Address to listen on. `0.0.0.0` accepts connections from other machines (needed in containers).             |
| `WADDLE_PASSWORD`       | none                          | Require this password for everything except `/-/ping` (HTTP Basic).                                         |
| `WADDLE_USER`           | `waddle`                      | User name that goes with the password.                                                                      |
| `WADDLE_DATA`           | `./data`                      | Directory for `config.json`, `pool.json` and `dns.json`.                                                    |
| `WADDLE_GITHUB_TOKEN`   | none                          | A GitHub token for the repository search. Raises its rate limit; no permissions are needed.                 |
| `WADDLE_ALLOW_PRIVATE`  | off                           | Set to `1` to allow sites and proxies on private, loopback and link-local addresses. Leave off on a server. |
| `WADDLE_SYSTEM_CA`      | on                            | Set to `0` to trust only Node's bundled certificate authorities and not the operating system's as well.     |
| `WADDLE_GITHUB_API`     | `https://api.github.com`      | GitHub API base, for GitHub Enterprise or a mirror.                                                         |
| `WADDLE_GITHUB_ARCHIVE` | `https://codeload.github.com` | Where repository snapshots are downloaded from.                                                             |
| `WADDLE_GITLAB`         | `https://gitlab.com`          | GitLab base, for a self-hosted instance.                                                                    |
| `WADDLE_DEV`            | off                           | Set to `1` to re-read the interface's files on every request while working on them.                         |
| `WADDLE_DEBUG`          | off                           | Set to anything to log unexpected errors with the request that caused them.                                 |

A GitHub token is only ever sent straight to GitHub, never through a proxy.

On Node versions that cannot load the operating system's certificate store at run time, start Node
with `--use-system-ca` or set `NODE_EXTRA_CA_CERTS` if your network inspects TLS.

## Route

| Setting           | Panel                              | Values                       | Default  | Meaning                                                                                                    |
| ----------------- | ---------------------------------- | ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `route.rotate`    | New exit                           | `sticky`, `request`, `timed` | `sticky` | Keep an exit per site, pick one for every request, or use one exit for every site for a while.             |
| `route.minutes`   | Keep for (min)                     | 1 to 1440                    | 10       | How long a per-site or timed exit is kept.                                                                 |
| `route.countries` | Exit country                       | two-letter codes             | any      | Use only exits in these countries.                                                                         |
| `route.protocols` | Protocols                          | `http`, `socks4`, `socks5`   | all      | Kinds of proxy to use.                                                                                     |
| `route.hops`      | Hops                               | 1 to 5                       | 1        | Proxies in a row. Only the last one learns the destination.                                                |
| `route.entry`     | Entry country                      | two-letter codes             | any      | Countries the first proxy of a chain may be in. Shown when there is more than one hop.                     |
| `route.spread`    | A different country per hop        | on, off                      | on       | Put the hops of a chain in different countries when the pool allows.                                       |
| `route.shorten`   | Shorter chain when proxies are few | on, off                      | on       | When a chain of the chosen length cannot be built, or keeps breaking, use a shorter one. Off: fail.        |
| `route.https`     | HTTPS only                         | on, off                      | on       | Ask for `http://` and `ws://` addresses over HTTPS. A site without HTTPS needs a deliberate yes, per host. |
| `route.retries`   | Retries                            | 0 to 8                       | 3        | Other exits to try when one fails or is refused.                                                           |
| `route.timeout`   | Timeout (s)                        | 3000 to 120000 ms            | 20000    | How long to wait for a site.                                                                               |
| `route.rules`     | Rules                              | one rule per line            | none     | Per-site exceptions, below.                                                                                |

With **Per site**, a page and everything on it use the page's exit. A third party that cannot use
that exit (a rule forbids it, or the exit cannot reach it) gets one of its own, and the page stays
where it is.

### Rules

One rule per line; the first that matches wins.

```
<site> <proxy | block> [countries] [hops=N]
```

```
example.com proxy US,DE hops=2
*.ads.example block
*tracker* block
```

- A plain name also covers its subdomains: `example.com` matches `www.example.com`.
- `*` matches any run of characters.
- `block` answers 403 without contacting the site.
- Countries and `hops` apply to `proxy`.

There is no rule that sends a site around the proxies.

## Proxies

| Setting               | Panel              | Values            | Default          | Meaning                                                                                                            |
| --------------------- | ------------------ | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pool.on`             | Harvest            | on, off           | on               | Download the lists on a schedule. Off: only proxies that are live, worked before or were added by hand are tested. |
| `pool.adaptive`       | Adapt the schedule | on, off           | on               | Harvest sooner while short of proxies, later while full or while the network blocks them.                          |
| `pool.discover`       | Find new sources   | on, off           | on               | Search GitHub and GitLab for new proxy lists after each harvest.                                                   |
| `pool.discoverMax`    |                    | 0 to 50           | 10               | Most sources to keep from discovery.                                                                               |
| `pool.target`         | Keep live          | 1 to 500          | 40               | Testing stops when this many proxies are live and resumes below it.                                                |
| `pool.harvestMinutes` | Every (min)        | 5 to 1440         | 30               | How often lists are downloaded again.                                                                              |
| `pool.recheckMinutes` | Recheck (min)      | 1 to 120          | 4                | How often live proxies are tested again.                                                                           |
| `pool.checkTimeout`   | Test timeout (s)   | 1500 to 30000 ms  | 7000             | A proxy slower than this fails its test.                                                                           |
| `pool.concurrency`    | Tests at once      | 1 to 400          | 80               | Tests running at once.                                                                                             |
| `pool.perSource`      |                    | 100 to 200000     | 10000            | Most candidates taken from one source per harvest.                                                                 |
| `pool.judge`          | Judge              | an address        | Cloudflare trace | Page each proxy must fetch to pass. It also tells Waddle the proxy's public address and country.                   |
| `pool.echo`           | Header echo        | an address, empty | httpbin headers  | A plain-HTTP page that answers with the headers it received. Shows what a proxy adds. Empty: skip.                 |
| `pool.canaries`       | Tamper checks      | one per line      | 3 pages          | Known plain-HTTP pages, as `<address> <expected text>`. See below.                                                 |
| `pool.sources`        | Sources            | list              | 39               | Where proxies come from, below.                                                                                    |

Settings without a panel entry can be changed in `data/config.json` or over the API.

### How a proxy is judged

1. **Judge.** It has to fetch the judge page. Over HTTPS the certificate proves the proxy did not
   tamper. The reply gives the address and the country sites will see.
2. **Tamper checks.** It is asked for the pages under **Tamper checks**, whose content is known.
   - The page arrives intact: the proxy may carry plain HTTP.
   - The page arrives changed, and at least three other proxies delivered that page intact: the
     proxy is dropped.
   - No page can be fetched through it: the proxy is kept for HTTPS only.
3. **Header echo.** A proxy that adds headers such as `X-Forwarded-For` or `Via` is marked as
   leaking and never carries plain HTTP.

The default tamper checks are the connectivity test pages of Firefox, Apple and Microsoft. A plain
HTTP judge only counts when its reply contains the caller's address: Cloudflare's `/cdn-cgi/trace`,
a JSON body with an `ip` or `origin` field, or a bare address.

### Sources

Type any of these into the box under **Sources**:

| You type                                    | It becomes                       |
| ------------------------------------------- | -------------------------------- |
| `owner/repo`                                | That GitHub repository           |
| `https://github.com/owner/repo`             | The same                         |
| `https://github.com/owner/repo/tree/branch` | A specific branch                |
| `gitlab:group/project`                      | A GitLab project                 |
| `https://gitlab.com/group/project`          | The same                         |
| `https://example.com/proxies.txt`           | A list fetched from that address |

Each source can be switched off or removed. Sources added by discovery carry a "found" tag.
**Add proxies** takes proxies directly, one per line, such as `socks5://203.0.113.9:1080` or
`198.51.100.7:8080`; they are tested ahead of everything else.

## DNS

| Setting            | Panel                            | Values                                         | Default                   | Meaning                                                                                      |
| ------------------ | -------------------------------- | ---------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `dns.mode`         | Lookups                          | `auto`, `stack`, `exit`                        | `auto`                    | Who looks up the names of sites, below.                                                      |
| `dns.strategy`     | Order                            | `fallback`, `race`, `rotate`, `split`, `check` | `fallback`                | How the resolvers are asked, below.                                                          |
| `dns.parallel`     | Ask at once                      | 2 to 4                                         | 2                         | Resolvers asked together by Fastest and Cross-check.                                         |
| `dns.pad`          | Pad questions                    | on, off                                        | on                        | Pad every question to a fixed size, so its length does not give the name away.               |
| `dns.servers`      | Resolvers                        | DoH addresses                                  | Cloudflare, Quad9, Google | Your resolvers, in order.                                                                    |
| `dns.auto`         | Add tested public resolvers      | on, off                                        | on                        | Keep a tested list of public resolvers behind your own.                                      |
| `dns.keep`         | Keep                             | 0 to 20                                        | 6                         | How many of those to use.                                                                    |
| `dns.refreshHours` | Refresh (h)                      | 1 to 720                                       | 24                        | How often the public list is downloaded and tested again.                                    |
| `dns.feeds`        |                                  | addresses                                      | 4 mirrors                 | Where the public list is downloaded from.                                                    |
| `dns.fallback`     | System resolver as a last resort | on, off                                        | on                        | For Waddle's own downloads only, when no resolver can be reached. Never for a site you open. |

**Lookups**

| Value   | Panel     | Who looks a site's name up                                                                                        |
| ------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `auto`  | Auto      | The exit proxy. With a SOCKS4 exit, which was not built to take names, your resolvers are asked through it first. |
| `stack` | Resolvers | Your resolvers, asked through the exit. Waddle then knows the address and hands it to the exit.                   |
| `exit`  | Exit      | The exit proxy, always. A SOCKS4 exit is given the name the SOCKS4a way.                                          |

A question about a site you visit always travels through a proxy. Neither the resolver nor your
network's own DNS learns who is asking.

**Order**

| Value      | Panel         | Meaning                                                                                              |
| ---------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `fallback` | In order      | Use the first; move down the list when one fails.                                                    |
| `race`     | Fastest       | Ask several at once and take the first answer.                                                       |
| `rotate`   | Take turns    | Spread questions across the list.                                                                    |
| `split`    | Split by name | Each site always goes to the same resolver, so no resolver sees everything you visit.                |
| `check`    | Cross-check   | Ask several and compare. An address beats a "no such name", and the resolver that said no is marked. |

Built-in resolvers: Cloudflare, Cloudflare (malware blocking), Quad9, Quad9 (unfiltered), Google,
AdGuard (ad blocking), AdGuard (unfiltered), Mullvad, Mullvad (ad blocking), OpenDNS, DNS.SB,
Control D and Wikimedia. Any other `https://…` DoH address can be added with **Custom address**.

**The public list.** Waddle downloads the DNSCrypt project's list of public resolvers and keeps the
ones that speak DNS over HTTPS over IPv4, declare that they keep no logs and filter nothing, and are
not described as passing the asker's network on (EDNS Client Subnet). A sample is tested through a
proxy, never directly. A resolver that invents an answer for a name that cannot exist is left out.
The quickest are kept, one per operator. **Refresh list** does this now.

**Test** asks every resolver in play about one name, through the route a visit to that site would
take, and shows the answers side by side. **Flush** empties the cache.

## Identity

`spoof.on` (**Spoofing**) switches all of this off at once: pages then see your real browser.

| Setting                | Panel                         | Values                                             | Default      |
| ---------------------- | ----------------------------- | -------------------------------------------------- | ------------ |
| `spoof.random`         | Randomise                     | `off`, `session`, `site`, `timer`                  | `off`        |
| `spoof.randomMinutes`  | Every (min)                   | 1 to 1440 (with `timer`)                           | 30           |
| `spoof.match`          | Stay the same kind of browser | on, off (with a random identity)                   | on           |
| `spoof.mobile`         | Phone                         | on, off                                            | off          |
| `spoof.system`         | System                        | a preset, `custom`, `real`                         | `win-chrome` |
| `spoof.phone`          | Phone model                   | `auto`, a phone preset                             | `auto`       |
| `spoof.customUa`       | User agent                    | text (with `custom`)                               |              |
| `spoof.customPlatform` | Platform                      | text (with `custom`)                               |              |
| `spoof.languages`      | Language                      | `exit`, `real`, or a list such as `de-DE,de`       | `exit`       |
| `spoof.timezone`       | Time zone                     | `exit`, `real`, or a zone such as `Europe/Berlin`  | `exit`       |
| `spoof.geo`            | Location                      | `block`, `exit`, `real`                            | `block`      |
| `spoof.screen`         | Screen                        | `auto`, `real`, or a size such as `1920x1080@1`    | `auto`       |
| `spoof.viewport`       | Lock the page to that size    | `window`, `screen`                                 | `window`     |
| `spoof.gpu`            | Graphics                      | `auto`, or one of the cards that system ships with | `auto`       |
| `spoof.cores`          | Processor cores               | `auto`, 2, 4, 6, 8, 12, 16                         | `auto`       |
| `spoof.memory`         | Memory                        | `auto`, 2, 4, 8                                    | `auto`       |
| `spoof.touch`          | Touch                         | `auto`, `off`, `on`                                | `auto`       |
| `spoof.battery`        | Battery                       | `generic`, `random`, `real`                        | `generic`    |
| `spoof.theme`          | Colour scheme                 | `real`, `light`, `dark`                            | `real`       |
| `spoof.motion`         | Motion                        | `real`, `reduce`, `no-preference`                  | `real`       |
| `spoof.network`        | Connection                    | `real`, `wifi`, `4g`, `3g`, `2g`, `slow-2g`        | `real`       |
| `spoof.saveData`       | Save-Data                     | on, off                                            | off          |
| `spoof.webrtc`         | WebRTC                        | `block`, `real`                                    | `block`      |
| `spoof.dnt`            | Do Not Track + GPC            | on, off                                            | on           |
| `spoof.canvas`         | Canvas                        | `real`, `noise`, `block`                           | `noise`      |
| `spoof.webgl`          | WebGL                         | `real`, `spoof`                                    | `spoof`      |
| `spoof.audio`          | Audio                         | `real`, `noise`                                    | `noise`      |
| `spoof.rects`          | Layout                        | `real`, `noise`                                    | `real`       |
| `spoof.fonts`          | Fonts                         | `real`, `limit`                                    | `real`       |
| `spoof.plugins`        | Plugins                       | `auto`, `none`, `real`                             | `auto`       |
| `spoof.voices`         | Voices                        | `generic`, `none`, `real`                          | `generic`    |
| `spoof.media`          | Cameras                       | `generic`, `none`, `real`                          | `generic`    |

Presets: Windows with Chrome, Edge or Firefox; macOS with Chrome or Safari; Linux with Chrome or
Firefox; ChromeOS with Chrome; Android with Chrome or Firefox; iPhone and iPad with Safari. Version
numbers are estimated from each browser's release schedule and today's date.

Notes:

- **Exit country** for language, time zone and location takes them from the country the exit is in,
  so they agree with the address the site sees. Before a page has been opened there is no exit yet.
- **Randomise** gives a whole new identity per session, per site, or on a timer. With **Stay the
  same kind of browser** on, it keeps to identities your real browser can pass for.
- A claimed browser of another kind than your real one (Firefox claimed from Chrome, say) can be told
  apart by a site that tests how the browser behaves. The panel marks such an identity
  **Detectable**.
- **Phone** presents a phone and lays the page out at a phone's size. **Phone model** `auto` picks
  the phone your browser can pass for.
- **Lock the page to that size** lays the page out at the spoofed screen's size and scales it to fit
  your window, so the window size does not give your real screen away.
- **WebRTC** is blocked by default because it can reveal your real address around any proxy.
- **Location** `block` refuses the request. `exit` answers with a position in the exit's country.
- **Layout** and **Fonts** are off by default: they change how some pages measure text.
- Within one site, the same page always sees the same canvas and audio noise; another site sees
  different noise.

**What sites see** on the Privacy tab opens a page that shows all of this next to what your browser
really is, and the headers that go out.

## Privacy

| Setting            | Panel                  | Values                   | Default  | Meaning                                                                                                                         |
| ------------------ | ---------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `privacy.cookies`  | Other sites' cookies   | `first`, `all`, `none`   | `first`  | Block (`first`): only the site in the address bar keeps cookies. Allow (`all`): embedded sites too. Block all (`none`): nobody. |
| `privacy.trackers` | Block trackers         | on, off                  | on       | Refuse requests to known tracking and advertising hosts before they leave.                                                      |
| `spoof.referer`    | Referer to other sites | `full`, `origin`, `none` | `origin` | What a site learns about the page a request came from, when that page is on another site.                                       |

The tracker list is short on purpose: 171 hosts whose whole purpose is tracking or advertising, so
that refusing them does not break pages. Anything else can be blocked with a routing rule.

- **New identity** starts over: cookies, fingerprint, exits and chains, remembered choices and cached
  lookups.
- **Cookies → Clear** empties your cookie jar.
- **Allowed without HTTPS** lists the hosts you chose to open over plain HTTP in this session, and
  lets you take that back.

## General

| Setting         | Panel        | Values                                                                | Default      | Meaning                                                       |
| --------------- | ------------ | --------------------------------------------------------------------- | ------------ | ------------------------------------------------------------- |
| `ui.theme`      | Theme        | `auto`, `light`, `dark`                                               | `auto`       | Waddle's own look. `auto` follows your system.                |
| `ui.search`     | Search       | an address with `%s`                                                  | DuckDuckGo   | Where text that is not an address is sent. `%s` is the query. |
| `ui.links`      | Quick links  | one per line, `Name https://address`                                  | 4 links      | The tiles on the start page.                                  |
| `ui.cloak`      | Tab disguise | `none`, `docs`, `classroom`, `drive`, `notes`, `calculator`, `custom` | `none`       | Give the browser tab another title and icon.                  |
| `ui.cloakTitle` | Title        | text (with `custom`)                                                  |              | The title to show.                                            |
| `ui.panicKey`   | Panic key    | one key, empty for off                                                | off          | One press and the tab goes somewhere else.                    |
| `ui.panicUrl`   | Goes to      | an address, empty for a blank page                                    | a blank page | Where the panic key goes.                                     |

Search presets: DuckDuckGo, Brave, Startpage, Mojeek, Google and Bing, or any address of your own.

**Blank-address tab** opens Waddle in a tab whose address reads `about:blank`. **Reset everything**
restores every default, including the source list.

## Browser-local features

The library and presentation preferences below live in this browser's `localStorage`; they are not
part of `data/config.json` and are not sent to Waddle's server. **Reset frontend settings** resets
only the appearance and start-page preferences. **New identity** clears local history and closes
extra Waddle tabs, while preserving bookmarks, saved addresses and frontend preferences. Saved pages
are addresses for later, not offline copies.

- **Tabs:** up to 16 open Waddle tabs, with separate current addresses and back/forward history.
  The state is restored when the shell reloads.
- **Library:** bookmarks (with folders, JSON export and browser-bookmark HTML or Waddle JSON import),
  a searchable history, and a Saved read-later list. The toolbar bookmark icon toggles the current bookmark.
- **Appearance:** accent (`orange`, `blue`, `violet`, `teal`, `rose`), density (`comfortable`,
  `compact`, `spacious`), text size (`small`, `normal`, `large`) and tab-strip position (`top`,
  `bottom`).
- **Start page:** show or hide quick links, local recommendations and status chips. Recommendations
  and typing suggestions match this browser's open tabs, bookmarks, saved addresses and history.
- **External suggestions:** DuckDuckGo suggestions are off by default. When enabled, after a pause
  while typing at least three characters, the query is sent to DuckDuckGo through the current proxy
  exit. The selected search engine still receives a query when you submit a search.
- **Keyboard shortcuts:** `Ctrl/⌘+T` new tab, `Ctrl/⌘+W` close tab, `Ctrl/⌘+L` address bar,
  `Ctrl/⌘+Shift+I` Inspect, `Ctrl/⌘+D` bookmark, and `Alt+Left/Right` back or forward. The panic
  key remains configurable as `ui.panicKey` in the server settings above.

Waddle's single-origin design means a malicious proxied page may be able to reach browser-local data;
see [Security](security.md#one-origin-for-everything) before using the library for sensitive records.

## Files

| File               | Contents                                                            |
| ------------------ | ------------------------------------------------------------------- |
| `data/config.json` | The current settings, in full.                                      |
| `data/pool.json`   | The live proxies and per-source statistics, to warm the next start. |
| `data/dns.json`    | The tested public resolvers and the list they came from.            |

All are rewritten atomically. A damaged file is ignored and replaced; it never stops Waddle from
starting. Cookie jars are kept in memory only and do not survive a restart.
