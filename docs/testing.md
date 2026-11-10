# Testing

Two suites. The first needs nothing but Node and runs in about 13 seconds. The second drives a real
browser.

```sh
npm test              # unit and integration: 135 tests
npm run test:browser  # end to end in Chrome: 55 checks (59 with LIVE=1)
```

## How the tests are built

Almost every test starts the real server and talks to it over HTTP, the way a browser would. The
internet is replaced by stand-ins that run on the local machine (`test/support.js`):

| Stand-in                    | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Websites                    | Serve whatever a test needs, record every request they receive, echo WebSockets.     |
| HTTP, SOCKS4, SOCKS5 proxies | Real protocol implementations that log what they are asked to reach. Can demand credentials, refuse, or accept and go silent. Each pretends to be in a country. |
| DNS over HTTPS server       | Answers from a table. Can be slow or broken.                                         |
| Judge                       | Reports the caller's address and country, like the real judge page.                  |
| Repository hosts            | Serve tarballs and API replies shaped like GitHub's and GitLab's.                    |

Because the proxies are real, a test can state exactly who saw what: for a three-hop chain, that the
entry proxy was asked for the relay, the relay for the exit, and only the exit for the site.

## What is covered

| File               | Tests | Covers                                                                                                                                                    |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract.test.js`  | 9     | Finding proxies in plain lists, URLs, CSV, JSON and HTML; protocol hints; rejecting private addresses; linear time on hostile input.                       |
| `tar.test.js`      | 4     | Reading repository archives: long names, pax headers, split chunks, damaged input.                                                                        |
| `rewrite.test.js`  | 15    | HTML, CSS, `srcset`, import maps, JavaScript imports, HLS playlists; text that only looks like an address is left alone; multi-megabyte hostile input.     |
| `cookies.test.js`  | 10    | Domain, path, `Secure`, `HttpOnly`, expiry, public suffixes, jar limits, sessions (including inside a cross-site frame).                                   |
| `config.test.js`   | 14    | Defaults, validation and clamping, persistence, damaged files, routing rules, source parsing, every identity preset checked for self-consistency.          |
| `dns.test.js`      | 13    | Wire format, caching, each stacking strategy, failover, "no such name", blocked names, system fallback, the timing test.                                   |
| `net.test.js`      | 23    | Direct, HTTP, SOCKS4 and SOCKS5 connections; credentials; two- and three-hop chains; which hop failed; timeouts; stale connections; address fallback; the private-address guard. |
| `pool.test.js`     | 14    | Harvesting from each kind of source, testing, protocol detection, eviction, re-testing, discovery, persistence, pausing when nothing answers.              |
| `proxy.test.js`    | 25    | The whole server: pages, sub-resources, encodings and character sets, redirects, uploads, cookies, privacy in both directions, error pages, rules, rotation, chains, the API, the cross-site guard, the password, WebSockets. |
| `timing.test.js`   | 8     | Response times, below.                                                                                                                                    |

The browser suite (`test/browser/e2e.mjs`) checks what only a browser can: that a page really
renders and navigates inside the proxy (links, forms, redirects, back), that `fetch`, XHR, images
added by script and WebSockets are caught, that cookies behave, that the service worker takes
control, that each identity setting is what page scripts actually observe (user agent, platform,
languages, time zone, screen, colour scheme, WebRTC, canvas, WebGL), and that the settings drawer
saves changes and keeps unsent text.

## Response times

`timing.test.js` measures as well as asserts. The limits it asserts are generous so that a slow
machine does not fail the suite; the figures it prints are the useful part. On the development
machine (2 cores, Node 22, everything on the loopback interface), the range over eight runs:

| Measurement                                        | Result                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| A 60 KB page fetched directly, without Waddle      | 0.5 to 0.8 ms                                                  |
| The same page through Waddle, rewritten            | median 3.9 to 5.2 ms, 95th percentile 11 to 16 ms              |
| An image through Waddle (streamed, not rewritten)  | 1.0 to 1.9 ms                                                  |
| A 1.9 MB page through Waddle                       | 102 to 178 ms, of which rewriting 86 to 163 ms (11 to 22 MB/s) |
| 200 pages requested at once                        | all answered in 328 to 397 ms (about 500 to 610 per second)    |
| First request through 1, 2 or 3 proxies            | 2.8 to 9.6 ms                                                  |
| Later requests through 1, 2 or 3 proxies           | 1.6 to 2.5 ms                                                  |
| Connections opened per proxy for 123 requests      | 2 to 5 (connections are reused)                                |
| Page request when 2 of 3 exits are dead            | median 1.2 to 2.2 ms, worst 3.9 to 7.4 ms                      |
| A cached DNS lookup                                | 1 to 2 µs                                                      |
| A dead resolver                                    | asked 3 times for 5 names, then rested                         |

These are loopback figures: they show what Waddle itself adds, and that chains and failover do not
add much on top. On the real internet the proxies dominate. A free proxy typically adds hundreds of
milliseconds per hop, and that cannot be measured without real proxies to measure.

Every server-side parser is also timed against hostile input (megabyte-long tokens, unclosed tags,
patterns built to make a regular expression backtrack), because a proxy that parses what strangers
send it must not be stallable.

## Running the browser test

Waddle has no dependencies, so the browser driver is installed only when you want this test:

```sh
npm install --no-save puppeteer-core
CHROME=/path/to/chrome npm run test:browser
```

Without `CHROME` the script looks for Chrome, Chromium or Edge in the usual places. If there is no
browser on the machine, `npm install --no-save @sparticuz/chromium` provides a self-contained
headless build that the script also finds. Outside AWS Lambda that build needs the shared libraries
from its own `bin/al2023.tar.br` on `LD_LIBRARY_PATH`.

| Variable    | Effect                                                             |
| ----------- | ------------------------------------------------------------------ |
| `LIVE=1`    | Also browse pypi.org through Waddle. Needs internet access.        |
| `SHOTS=dir` | Save screenshots into `dir`.                                       |
| `VERBOSE=1` | List every failed or refused request the browser made.             |
| `NO_SANDBOX=1` | Start Chrome without its sandbox, which most containers need. Automatic when running as root. |

## What was and was not tested against the real internet

Waddle was built in a sandbox that allows connections to only a handful of hosts. That shaped what
could be confirmed live, and it is better said plainly:

| Area                                  | Confirmed live                                              | Confirmed only against local stand-ins                  |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Browsing through Waddle               | pypi.org and github.com, in Chrome                          | Everything else                                         |
| Harvesting from GitHub                | Yes: all 20 default repositories, about 60,000 candidates   |                                                         |
| Discovery of new GitHub repositories  | Yes                                                         |                                                         |
| GitLab (harvest and discovery), list URLs | No: those hosts were unreachable                        | Yes                                                     |
| Proxies carrying traffic              | No: every outbound proxy connection was blocked, so no proxy ever passed its test | Yes: HTTP, SOCKS4 and SOCKS5 |
| Chains of two and three proxies       | No                                                          | Yes                                                     |
| DNS over HTTPS                        | Yes, through dns.google; the other resolvers were unreachable | Yes                                                   |
| Response times                        | No                                                          | Yes, on loopback                                        |

The first thing to do on a normal network is open the **Proxies** tab and watch the live count rise.
If it stays at zero for several minutes, the network is blocking outbound proxy connections.

Two robustness fixes came out of the sandbox's odd network, and both have tests: a kept-alive
connection that was dropped while idle is replaced without failing the request, and when a name has
several addresses and one of them cuts connections off, the others are used.

Only Node 22 was used. `package.json` allows Node 20, but nothing was run on it. `npm test` relies
on the shell to expand `test/*.test.js`; on Windows that needs Node 21 or newer, which expands the
pattern itself.

## Formatting

The code is formatted with Prettier (`.prettierrc.json`). `npm run format:check` verifies it and
`npm run format` applies it; both fetch Prettier with `npx`.
