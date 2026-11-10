# Configuration

Almost everything is set from the settings drawer in the interface and saved to
`data/config.json`. Changes apply at once; nothing needs a restart. The same settings can be read and
changed over the [HTTP API](api.md). A handful of things that concern the process itself are
environment variables.

## Environment variables

| Variable                | Default                       | What it does                                                                                                   |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8080`                        | Port to listen on.                                                                                             |
| `HOST`                  | `127.0.0.1`                   | Address to listen on. `0.0.0.0` accepts connections from other machines (needed in containers).                |
| `WADDLE_PASSWORD`       | none                          | Require this password for everything except `/-/ping` (HTTP Basic).                                            |
| `WADDLE_USER`           | `waddle`                      | User name that goes with the password.                                                                         |
| `WADDLE_DATA`           | `./data`                      | Directory for `config.json` and `pool.json`.                                                                   |
| `WADDLE_GITHUB_TOKEN`   | none                          | A GitHub token for the repository search. Raises its rate limit; no permissions are needed.                    |
| `WADDLE_ALLOW_PRIVATE`  | off                           | Set to `1` to allow sites and proxies on private, loopback and link-local addresses. Leave off on a server.     |
| `WADDLE_SYSTEM_CA`      | on                            | Set to `0` to trust only Node's bundled certificate authorities and not the operating system's as well.         |
| `WADDLE_GITHUB_API`     | `https://api.github.com`      | GitHub API base, for GitHub Enterprise or a mirror.                                                            |
| `WADDLE_GITHUB_ARCHIVE` | `https://codeload.github.com` | Where repository snapshots are downloaded from.                                                                |
| `WADDLE_GITLAB`         | `https://gitlab.com`          | GitLab base, for a self-hosted instance.                                                                       |
| `WADDLE_DEV`            | off                           | Set to `1` to re-read the interface's files on every request while working on them.                            |
| `WADDLE_DEBUG`          | off                           | Set to anything to log unexpected errors with the request that caused them.                                    |

On Node versions that cannot load the operating system's certificate store at run time, start Node
with `--use-system-ca` or set `NODE_EXTRA_CA_CERTS` if your network inspects TLS.

## Route

| Setting           | Panel             | Values                           | Default  | Meaning                                                                                              |
| ----------------- | ----------------- | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `route.mode`      | Mode              | `auto`, `proxy`, `direct`        | `auto`   | `auto` uses proxies and goes direct when none works. `proxy` never goes direct. `direct` never uses proxies. |
| `route.rotate`    | New exit          | `sticky`, `request`, `timed`     | `sticky` | Keep an exit per site, pick one for every request, or use one exit for everything for a while.        |
| `route.minutes`   | Keep exit (min)   | 1 to 1440                        | 10       | How long a per-site or timed exit is kept.                                                           |
| `route.hops`      | Chain             | 1 to 3                           | 1        | Proxies in a row. Only the last one learns the destination.                                          |
| `route.retries`   | Retries           | 0 to 8                           | 2        | Other exits to try when one fails or is refused.                                                     |
| `route.timeout`   | Timeout (s)       | 3000 to 120000 ms                | 20000    | How long to wait for a site.                                                                         |
| `route.protocols` | Protocols         | `http`, `socks4`, `socks5`       | all      | Kinds of proxy to use.                                                                               |
| `route.countries` | Countries         | two-letter codes                 | any      | Use only exits in these countries, for example `US, DE`.                                             |
| `route.rules`     | Rules             | one rule per line                | none     | Per-site exceptions, below.                                                                          |

### Rules

One rule per line; the first that matches wins.

```
<site> <direct | proxy | auto | block> [countries] [hops=N]
```

```
*.github.com direct
example.com proxy US,DE hops=2
bank.example direct
*tracker* block
```

- A plain name also covers its subdomains: `example.com` matches `www.example.com`.
- `*` matches any run of characters.
- `block` answers 403 without contacting the site.
- Countries and `hops` apply to `proxy` and `auto`.

## Proxies

| Setting                | Panel                | Values           | Default | Meaning                                                                    |
| ---------------------- | -------------------- | ---------------- | ------- | -------------------------------------------------------------------------- |
| `pool.on`              | Pool                 | on, off          | on      | Harvest and test proxies. Off leaves only a direct connection.             |
| `pool.discover`        | Find new sources     | on, off          | on      | Search GitHub for new proxy lists after each harvest.                      |
| `pool.discoverMax`     |                      | 0 to 50          | 10      | Most sources to keep from discovery.                                       |
| `pool.target`          | Keep live            | 1 to 500         | 40      | Testing stops when this many proxies are live and resumes below it.        |
| `pool.harvestMinutes`  | Harvest every (min)  | 5 to 1440        | 30      | How often lists are downloaded again.                                      |
| `pool.recheckMinutes`  | Recheck every (min)  | 1 to 120         | 4       | How often live proxies are re-tested.                                      |
| `pool.checkTimeout`    | Check timeout (s)    | 1500 to 30000 ms | 7000    | A proxy slower than this fails its test.                                   |
| `pool.concurrency`     | Parallel checks      | 1 to 400         | 80      | Tests running at once.                                                     |
| `pool.perSource`       |                      | 100 to 200000    | 10000   | Most candidates taken from one source per harvest.                         |
| `pool.judge`           | Judge                | a URL            | Cloudflare trace | Page each proxy must fetch to pass. An HTTPS judge also proves the proxy does not tamper. |
| `pool.sources`         | Sources              | list             | 27      | Where proxies come from, below.                                            |

Settings without a panel entry can be changed in `data/config.json` or over the API.

### Sources

Type any of these into the box under **Sources**:

| You type                                        | It becomes                          |
| ----------------------------------------------- | ----------------------------------- |
| `owner/repo`                                    | That GitHub repository              |
| `https://github.com/owner/repo`                 | The same                            |
| `https://github.com/owner/repo/tree/branch`     | A specific branch                   |
| `gitlab:group/project`                          | A GitLab project                    |
| `https://gitlab.com/group/project`              | The same                            |
| `https://example.com/proxies.txt`               | A list fetched from that address    |

Each source can be switched off or removed. Sources added by discovery carry a "found" tag.
**Add proxies** takes proxies directly, one per line, such as `socks5://203.0.113.9:1080` or
`198.51.100.7:8080`; they are tested ahead of everything else.

The judge has to answer with the caller's address for a plain-HTTP judge to count: Cloudflare's
`/cdn-cgi/trace`, a JSON body with an `ip` or `origin` field, or a bare address.

## DNS

| Setting        | Panel            | Values                       | Default                    | Meaning                                                                              |
| -------------- | ---------------- | ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `dns.mode`     | Resolver         | `doh`, `system`              | `doh`                      | Encrypted DNS through the stack, or the operating system's resolver.                 |
| `dns.strategy` | Stack            | `fallback`, `race`, `rotate` | `fallback`                 | In order, fastest answer wins, or spread across the stack.                           |
| `dns.servers`  | Stack (the list) | DoH URLs                     | Cloudflare, Quad9, Google  | The resolvers, in order.                                                             |
| `dns.fallback` | System fallback  | on, off                      | on                         | Use the system resolver if the whole stack is unreachable.                           |
| `dns.remote`   | Resolve at exit  | on, off                      | on                         | Let the exit proxy look names up, so the lookup does not come from Waddle's network. |

Built-in resolvers: Cloudflare, Cloudflare (malware blocking), Quad9, Google, AdGuard (ad blocking),
AdGuard (unfiltered), Mullvad, Mullvad (ad blocking), OpenDNS, DNS.SB, Control D and Wikimedia. Any
other `https://…` DoH address can be added with **Custom…**. **Test** times every resolver in the
stack, and the system resolver, on one name.

## Identity

`spoof.on` switches all of this off at once: pages then see your real browser.

| Setting                | Panel                  | Values                                         | Default      |
| ---------------------- | ---------------------- | ---------------------------------------------- | ------------ |
| `spoof.system`         | Browser                | a preset, `random`, `custom`, `real`           | `win-chrome` |
| `spoof.customUa`       | User agent             | text (with `custom`)                           |              |
| `spoof.customPlatform` | Platform               | text (with `custom`)                           |              |
| `spoof.languages`      | Languages              | for example `de-DE,de`; empty for real         | `en-US,en`   |
| `spoof.timezone`       | Time zone              | for example `Asia/Tokyo`; empty for real       | real         |
| `spoof.screen`         | Size                   | a preset such as `1920x1080@1`, or `real`      | `real`       |
| `spoof.viewport`       | Lock viewport          | `window`, `screen`                             | `window`     |
| `spoof.theme`          | Colour scheme          | `real`, `light`, `dark`                        | `real`       |
| `spoof.motion`         | Motion                 | `real`, `reduce`, `no-preference`              | `real`       |
| `spoof.network`        | Connection             | `real`, `wifi`, `4g`, `3g`, `2g`, `slow-2g`    | `real`       |
| `spoof.saveData`       | Save-Data              | on, off                                        | off          |
| `spoof.webrtc`         | WebRTC                 | `block`, `real`                                | `block`      |
| `spoof.dnt`            | Do Not Track + GPC     | on, off                                        | on           |
| `spoof.referer`        | Referer to other sites | `full`, `origin`, `none`                       | `origin`     |
| `spoof.canvas`         | Canvas                 | `real`, `noise`, `block`                       | `noise`      |
| `spoof.webgl`          | WebGL                  | `real`, `spoof`                                | `spoof`      |
| `spoof.audio`          | Audio                  | `real`, `noise`                                | `noise`      |
| `spoof.rects`          | Layout rects           | `real`, `noise`                                | `real`       |
| `spoof.fonts`          | Fonts                  | `real`, `limit`                                | `real`       |
| `spoof.devices`        | Devices                | `real`, `spoof`                                | `spoof`      |

Presets: Windows with Chrome, Edge or Firefox; macOS with Chrome or Safari; Linux with Chrome or
Firefox; Android with Chrome; iPhone with Safari. `random` picks one per session. Version numbers
are estimated from each browser's release schedule and today's date.

Notes:

- **Lock viewport** lays the page out at the spoofed screen's size and scales it to fit your window,
  so the window size does not give your real screen away.
- **WebRTC** is blocked by default because it can reveal your real address around any proxy.
- **Layout rects** and **Fonts** are off by default: they change how some pages measure text.
- Within one site, the same page always sees the same canvas and audio noise; another site sees
  different noise.

## Data

| Setting     | Panel  | Default                               | Meaning                                                    |
| ----------- | ------ | ------------------------------------- | ---------------------------------------------------------- |
| `ui.search` | Search | `https://duckduckgo.com/html/?q=%s`   | Where text that is not an address is sent. `%s` is the query. |

**Clear cookies** empties your cookie jar. **Reset settings** restores every default, including the
source list.

## Files

| File               | Contents                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `data/config.json` | The current settings, in full.                                        |
| `data/pool.json`   | The live proxies and per-source statistics, to warm the next start.   |

Both are rewritten atomically. A damaged file is ignored and replaced; it never stops Waddle from
starting. Cookie jars are kept in memory only and do not survive a restart.
