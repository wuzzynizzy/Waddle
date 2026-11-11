# Testing

Two suites. The first needs nothing but Node and runs in about 30 seconds. The second drives a real
browser.

```sh
npm test              # unit and integration: 191 tests
npm run test:browser  # end to end in Chrome: 143 checks
```

Neither suite uses the internet. Both replace it with stand-ins on the local machine, so they pass
on a network that blocks everything, and they cannot reach a real site or a real proxy by accident.

## How the tests are built

Almost every test starts the real server and talks to it over HTTP, the way a browser would. The
stand-ins are in `test/support.js`:

| Stand-in                     | What it does                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Websites                     | Serve whatever a test needs, record every request they receive, echo WebSockets.                                                                                                     |
| HTTP, SOCKS4, SOCKS5 proxies | Real protocol implementations that log every tunnel they are asked to open. Can demand credentials, refuse, accept and go silent, refuse some ports, or change the pages they carry. |
| DNS over HTTPS server        | Answers from a table. Can be slow, broken, unable to take padded questions, or made to invent answers.                                                                               |
| Judge                        | Reports the caller's address and country, like the real judge page. Each proxy sees its own copy, which is how a proxy is "placed" in a country.                                     |
| Canary and header echo       | A page with known content, and a page that answers with the headers it received, for vetting proxies.                                                                                |
| Repository hosts             | Serve tarballs and API replies shaped like GitHub's and GitLab's.                                                                                                                    |

The proxy stand-ins connect only to addresses on the local machine. To them nothing else exists.

Because the proxies are real, a test can state exactly who saw what: for a three-hop chain, that the
entry proxy was asked for the relay, the relay for the exit, and only the exit for the site. The
same logs prove the negative: a test can assert that a site received no connection that did not
come through an exit.

## What is covered

| File              | Tests | Covers                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract.test.js` | 9     | Finding proxies in plain lists, URLs, CSV, JSON and HTML; protocol hints; rejecting private addresses; linear time on hostile input.                                                                                                                                                                                                                              |
| `tar.test.js`     | 4     | Reading repository archives: long names, pax headers, split chunks, damaged input.                                                                                                                                                                                                                                                                                |
| `rewrite.test.js` | 18    | HTML, CSS, `srcset`, import maps, JavaScript imports, HLS playlists; frames and sandboxed frames; text that only looks like an address is left alone; multi-megabyte hostile input.                                                                                                                                                                               |
| `cookies.test.js` | 10    | Domain, path, `Secure`, `HttpOnly`, expiry, public suffixes, jar limits, sessions (including inside a cross-site frame).                                                                                                                                                                                                                                          |
| `local.test.js`   | 3     | Browser-local bookmarks, saved addresses, history and preferences; one-way browser HTML import; unsafe URL and preference sanitization.                                                                                                                                                                                                                                                    |
| `config.test.js`  | 24    | Defaults, validation and clamping, persistence, damaged files, routing rules, source parsing; expanded resolver/source/hop limits and small-profile bounds; no setting reaches a site without a proxy; identities, randomiser and phone mode.                                                                                                        |
| `dns.test.js`     | 21    | Wire format, caching, padding, each of the five orders, failover, "no such name", blocked names; that a visited site's name only ever travels through a proxy; the system fallback and its limits; the public resolver list from download to the kept few.                                                                                                        |
| `net.test.js`     | 25    | That a request without a proxy is refused; HTTP, SOCKS4 and SOCKS5 tunnels; credentials; chains of two and three; which hop failed and why; timeouts; stale connections; names resolved at the exit; plain HTTP carried as a tunnel; the private-address guard.                                                                                                   |
| `pool.test.js`    | 26    | Harvesting from each kind of source, testing, protocol detection, discovery, persistence; vetting (tampering, header leaks); eviction and blame; chains and entry countries; one exit per page and exits for third parties; health; pausing when nothing answers; adaptive scheduling.                                                                            |
| `proxy.test.js`   | 43    | The whole server: pages, sub-resources, encodings and character sets, redirects, uploads, cookies, trackers, workers, HTTPS only, error pages, routing/failover, chains through 16 proxies, removed backup/tour endpoints, installers, auth guards, robots.txt, inspector redaction and WebSockets. |
| `timing.test.js`  | 8     | Response times, below.                                                                                                                                                                                                                                                                                                                                            |

The browser suite (`test/browser/e2e.mjs`) checks what only a browser can:

- A page renders and navigates inside the proxy: links, forms, redirects, back and forward. A page
  is laid out by its own stylesheet and shows its own pictures.
- `fetch`, XHR, images added by script, workers and WebSockets are caught. What slips past rewriting
  is caught by the service worker.
- Each identity setting is what page scripts actually observe: user agent, platform, languages,
  time zone, screen, colour scheme, WebRTC, canvas, WebGL. The same holds in frames and workers.
- A third party in a frame gets no cookies and its own storage, and is a site of its own when opened
  in the address bar.
- Multiple browser tabs keep separate addresses and histories; `_blank` links open another Waddle
  tab, and a narrow viewport scrolls the strip without horizontal page overflow. Bookmarks, folders,
  one-way browser HTML import, saved addresses, searchable local history,
  and New identity cleanup are exercised in the browser. The library has no export controls.
- The minimal start screen has one centered address/search field and one Source on GitHub link, with
  no mascot, visible wordmark, secondary links or promotional panels.
- The Inspect panel shows request routes and statuses, response headers, cookie names with HttpOnly
  values hidden, and rewritten source without the Waddle bootstrap.
- Address suggestions are drawn from the browser's local library; external suggestions are off by
  default. Theme, accent, density, text size and tab position are persisted locally.
- The settings drawer saves changes, shows the page's route, and keeps unsent text. At a narrow
  width, default and custom controls reflow without overlapping or pushing the page sideways; the
  custom accent editor is shown only when selected.
- **What sites see** shows the claimed browser next to the real one.
- HTTPS only: a site without HTTPS gets Waddle's page, and continuing takes a click.
- With the server away, behind a stand-in for a host's edge that answers 502 with its own page, the
  visitor sees Waddle's "Reconnecting" screen and the page comes back by itself.
- With no proxy, the page says so and the site is not contacted.
- At the end: every connection the site ever received came through the exit, no request told the
  site where Waddle runs, and Waddle never sent a status that an edge replaces.

## Response times

`timing.test.js` measures as well as asserts. The limits it asserts are generous so that a slow
machine does not fail the suite; the figures it prints are the useful part. On the development
machine (2 cores, Node 22, everything on the loopback interface), the range over three runs:

| Measurement                                          | Result                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| A 60 KB page through the exit alone, without Waddle  | 0.7 ms                                                         |
| The same page through Waddle and the exit, rewritten | median 4.2 to 5.1 ms, 95th percentile 11 to 14 ms              |
| An image through Waddle (streamed, not rewritten)    | 1.2 to 1.5 ms                                                  |
| A 1.9 MB page through Waddle                         | 113 to 126 ms, of which rewriting 91 to 107 ms (17 to 20 MB/s) |
| 200 pages requested at once                          | all answered in 358 to 423 ms (about 470 to 560 per second)    |
| First request through 1, 2 or 3 proxies              | 2.5 to 3.7 ms                                                  |
| Later requests through 1, 2 or 3 proxies             | 1.5 to 2.0 ms                                                  |
| Connections opened per proxy for 123 requests        | 1 to 3 (connections are reused)                                |
| A page whose exit has died, with 2 of 3 exits dead   | 5.6 to 8.3 ms, then 1.3 to 2.7 ms                              |
| A cached DNS lookup                                  | 1 µs                                                           |
| A dead resolver                                      | asked 3 times for 5 names, then rested                         |

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

| Variable       | Effect                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------- |
| `SHOTS=dir`    | Save screenshots into `dir`. The images in `docs/img` were made this way.                     |
| `VERBOSE=1`    | List every failed or refused request the browser made, and console errors.                    |
| `NO_SANDBOX=1` | Start Chrome without its sandbox, which most containers need. Automatic when running as root. |

## What was and was not tested against the real internet

Waddle was built in a sandbox that allows connections to only a handful of hosts and resets every
connection to a proxy. Since Waddle reaches sites only through proxies, **no real website has been
loaded through this version**. Everything about carrying pages is confirmed against the stand-ins
only. That is better said plainly:

| Area                                           | Confirmed live                                                                                   | Confirmed only against local stand-ins |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Harvesting from GitHub                         | Yes: all 30 default repositories, about 75,000 addresses                                         |                                        |
| Discovery of new GitHub repositories           | Yes: 9 found and added                                                                           |                                        |
| GitLab (harvest and discovery), list addresses | No: those hosts were unreachable                                                                 | Yes                                    |
| Proxies passing their tests                    | No: 2,638 were tried in 22 minutes; 2,618 connections were reset and 20 timed out                | Yes: HTTP, SOCKS4 and SOCKS5           |
| Pages loaded through a proxy                   | No                                                                                               | Yes                                    |
| Chains, vetting, identity following the exit   | No                                                                                               | Yes                                    |
| Lookups at the exit or through it              | No                                                                                               | Yes                                    |
| Lookups for Waddle's own downloads             | Yes, through dns.google; the other resolvers were unreachable                                    | Yes                                    |
| The public resolver list                       | Downloaded (170 resolvers listed); not tested, since testing needs a proxy                       | Yes                                    |
| A network that blocks proxies                  | Yes: the pool reports `blocked`, pauses, and every page says "This network blocks proxies"       | Yes                                    |
| A host's 502 page replacing Waddle's answer    | The problem was seen live with the previous version; the fix was not observed behind a real edge | Yes, behind a stand-in edge            |
| Response times                                 | No                                                                                               | Yes, on loopback                       |

The first thing to do on a normal network is open the **Proxies** tab and watch the live count rise.
If it stays at zero for several minutes and the status reads **This network blocks proxies**, the
network is blocking outbound proxy connections and Waddle cannot work there.

What to expect once proxies are live, from how free proxies behave in general and not from
measurement here: many sites will load, slowly; sites behind bot protection will often refuse or
show a CAPTCHA; exits will come and go, and Waddle will swap them.
