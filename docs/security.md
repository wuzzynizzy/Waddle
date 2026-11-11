# Security and privacy

What Waddle protects, how, and where the protection stops. The limits are listed as plainly as the
features, because with a tool like this the limits are what you need to know.

## In one paragraph

Waddle hides your address from the sites you visit by sending every request through other people's
proxies, keeps the lookups for those sites off your network, and gives sites a consistent made-up
browser identity instead of your real one. It never falls back to a direct connection. It does
**not** make you anonymous: free proxies are run by strangers, a site that looks closely can tell it
is being proxied, and everything you browse through one Waddle shares one browser origin. Treat it
as a privacy convenience, not as a replacement for Tor or a trusted VPN, and do not sign into
accounts that matter.

## Who can use your Waddle

| Protection       | Detail                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local by default | `npm start` listens on `127.0.0.1`, so only the same machine can connect. Setting `HOST=0.0.0.0` exposes it to the network, and the start-up log says so.                                                                   |
| Password         | `WADDLE_PASSWORD` puts everything behind HTTP Basic authentication (user `waddle`, or `WADDLE_USER`). It covers pages, the API and WebSockets, and is compared in constant time. Only the health check `/-/ping` is exempt. |
| No indexing      | `server.js` serves `/robots.txt` with `User-agent: *` and `Disallow: /`.                                                                                                                                                    |

An open proxy on a public address will be found and abused within hours. If you expose Waddle, set a
password and put it behind HTTPS (a reverse proxy or a tunnel): Basic authentication over plain
HTTP can be read by anyone on the path.

The password and Waddle's own session cookie are removed from every request before it goes to a
site or a proxy.

## Other websites using your Waddle

A page on some other website could try to use a Waddle it can reach, for instance one on your
`localhost`, by embedding it or sending it requests.

- **Proxied pages** (`/~/…`) are served only to Waddle's own pages, or when you open one directly in
  a tab. Requests the browser marks as coming from another site (`Sec-Fetch-Site`) get a 403 unless
  they are a plain top-level visit.
- **The API** requires a header that browsers will not let another site send, and rejects anything
  the browser marks as cross-site.
- **WebSockets** are refused unless the page asking belongs to Waddle.

The interface itself may be embedded in a frame (that is how hosted previews work); only the
proxying is restricted.

## When your real address shows

For a site you visit: never. Waddle has no direct mode, no fallback to one, and no rule or setting
that creates one. The transport refuses any request that has no proxy, so a mistake elsewhere in the
code fails instead of leaking. With no proxy available the page does not load.

What does go out directly, from the machine Waddle runs on:

- **Downloads of proxy lists and the resolver list**, from GitHub, GitLab and the list hosts, until
  three proxies are live. After that they go through the pool too. These hosts learn that this
  machine runs something that downloads proxy lists. They learn nothing about what you visit.
- **Lookups for those hosts**, over encrypted DNS, or through the system resolver as a last resort
  if **System resolver as a last resort** is on.
- **The connection to the first proxy of each route.** That proxy sees the address of the machine
  Waddle runs on. With one hop, the first proxy is also the exit, so it sees both your address and
  the site's name. With two or more, no single proxy sees both.

If Waddle runs on your own computer, "the machine Waddle runs on" is your address.

## What the proxies can see

Free proxies are run by people you do not know, and some exist to watch or tamper with traffic.

| Traffic          | A proxy on the route can                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://` sites | See the site's name and how much data moves. It cannot read or change the content: Waddle verifies the site's certificate end to end, through the tunnel. |
| `http://` sites  | Read everything, including what you type, and change it.                                                                                                  |

What Waddle does about plain HTTP:

- **HTTPS only** is on by default. `http://` and `ws://` addresses are asked for over HTTPS. A site
  that has no HTTPS gets a page that says so, and continuing takes a deliberate click, for that host
  and that session only.
- Plain HTTP only goes through exits that returned known test pages unchanged and add no headers
  of their own. An exit caught changing a page is dropped.
- Every connection is a tunnel, so a proxy is never handed a request it could add your address to.

The tamper test shows that an exit left a few known pages alone when it was tested. It cannot show
that the exit leaves every page alone, or that it does not read what passes. Do not type anything
that matters into an `http://` page.

With a chain, only the first proxy sees Waddle's address and only the last sees which site is being
visited. That guards against one bad proxy, not against proxies that cooperate.

## Name lookups

By default the exit looks a site's name up, so no lookup for a site you visit is made from your
network at all. If you choose resolvers of your own instead, they are asked over HTTPS through the
same proxy route as the page: the resolver sees the exit's address, and your network sees neither
the question nor the answer. A site's name is never handed to the system resolver.

Questions are padded to a fixed size, so their length gives nothing away to someone watching the
exit's traffic.

## Reaching into a private network

A proxy that fetches whatever address it is given is a way into the network it runs on. Waddle
refuses private, loopback, link-local and other reserved addresses, including cloud metadata
addresses, and names such as `localhost` and `*.internal`. IPv6 spellings of IPv4 addresses are
recognised. The check is made:

- on the address typed, before a route is even picked;
- on the address a name resolves to, when Waddle's resolvers look it up;
- on every address Waddle connects to for its own downloads, whatever the name resolves to;
- on proxies: one with a private address is thrown away when the list is read.

One gap remains. When the exit looks a name up, Waddle never sees the address it gets. A public name
that points at a private address would then be reached inside the exit's network, not yours: Waddle
has no route into the network it runs on, because it only connects to proxies. Choosing
**Resolvers** for lookups closes the gap, since Waddle then sees and checks the address.

`WADDLE_ALLOW_PRIVATE=1` turns the checks off. The tests use it; a deployment should not.

## Keeping requests inside the proxy

A page has many ways to make a request, and each one that escapes goes straight from your browser
to the site, with your real address.

1. The server rewrites addresses in HTML, CSS and module imports.
2. A script that runs before anything else on the page wraps the browser's own functions (`fetch`,
   XHR, WebSocket, `sendBeacon`, forms, links, history, workers, and elements created by scripts).
3. A service worker catches whatever the first two missed and sends it back through the proxy.
4. Where a service worker is not available (plain HTTP on anything but `localhost`, or a browser
   that refuses it in a frame), the page is given a content security policy that confines it to
   Waddle's address, so a missed request fails instead of leaking. Worker scripts get the same
   policy.

WebRTC, which can reveal a real address through a channel no proxy sees, is switched off inside
proxied pages by default. Sites' own service workers are not served.

## Tracking

- **Cookies.** By default only the site in the address bar keeps cookies. A site embedded in another
  site's page gets none, and its storage is kept apart from what it stores when visited itself. So
  an embedded widget cannot recognise you from one site to the next.
- **Trackers.** Requests to 171 hosts whose whole purpose is tracking or advertising are refused
  before they leave. The list is short on purpose and is no substitute for a full content blocker.
- **Referer.** By default another site is told only the origin of the page a request came from, not
  its full address. It can be told nothing at all.
- **Do Not Track and Global Privacy Control** are sent.
- **New identity** drops cookies, the fingerprint, exits and cached lookups, and clears browser-local
  history and extra tabs. It keeps bookmarks, saved addresses and frontend preferences.

## What a site can still tell

The made-up identity covers what page scripts and request headers reveal: user agent, client hints,
platform, languages, time zone, location, screen, hardware, battery, connection, and noise or
blocking for canvas, WebGL, audio and font probes. The settings are kept consistent with each other
and, by default, with the country of the exit, since a mismatch is itself a signal. **What sites
see** shows the result.

It does not cover:

- **The network fingerprint.** The connection to the site is made by Node.js, and its TLS handshake
  and HTTP behaviour do not look like Chrome's or Safari's. Services that fingerprint at that level
  (many bot-protection products) can see the difference whatever the user agent says, and may
  answer with a challenge page that cannot be passed.
- **The proxy's reputation.** Free proxy addresses are widely listed and often blocked or shown
  CAPTCHAs.
- **Another kind of browser.** Claiming Firefox from Chrome, or the reverse, can be caught by a site
  that tests how the browser's engine behaves. The Identity tab marks such a choice **Detectable**,
  and the randomiser avoids it unless told otherwise.
- **The page address.** Scripts that read `location` see Waddle's address rather than the site's.
  Some sites notice and some single-page apps misroute because of it.

## One origin for everything

To a browser, every site viewed through Waddle comes from Waddle's own address. The browser's rule
that keeps one site's scripts away from another's does not apply between them.

- A script on one proxied site that sets out to can reach what another proxied site stored in the
  browser (local storage, IndexedDB), and can ask Waddle for pages of other sites using your cookies
  for them.
- Waddle's settings and Inspector APIs live at the same address. The page script refuses direct
  requests from proxied pages to them, which stops ordinary page code, but that is Waddle's own
  check and not one the browser enforces. A script that gets around it may change the route, add a
  proxy or clear cookies; the Inspector API also contains recent request URLs and non-HttpOnly cookie
  values for the selected site.
- Waddle's bookmarks, saved addresses, history, open-tab state and frontend preferences are kept in
  the shell's browser `localStorage`. Waddle does not upload this library to its server, but it is
  still same-origin data and a malicious proxied page may be able to reach it.

Waddle limits this where it can. Site cookies are kept on the server and filtered per site, cookies
marked `HttpOnly` never reach page scripts, and local and session storage are given a separate
namespace per site. The password is never exposed to pages. It cannot make the pages strangers to
each other without giving every site its own hostname, which a single address cannot do.

In practice: use Waddle for reading, not for accounts you care about, and do not browse a site you
distrust in the same session as one you are signed into.

## Browser-local records

Waddle provides no backup, restore or export controls. Bookmarks, saved addresses, history and browser
preferences remain in the browser that created them; clearing that browser's site data removes them.
They are still same-origin data and should not be treated as private from a malicious proxied page, as
explained above.

## Cookies and sessions

Each visitor gets a cookie jar on the server, identified by one `HttpOnly` cookie named `waddle`.
Site cookies go into the jar and never into your browser. Jars are held in memory only: they are
not written to disk, they are dropped after 24 hours without use, and a restart empties them all.
**Privacy → Cookies → Clear** empties yours.

When Waddle is shown inside another site's frame over HTTPS, the session cookie is set as a
partitioned third-party cookie. A browser that blocks third-party cookies outright will not keep
it, each request then starts a new session, and sign-ins will not stick. Open Waddle in its own tab
in that case.

## The host in front of Waddle

If Waddle runs behind a host's edge or a CDN, that edge can put its own page in place of an answer,
and inside a proxy such a page would try to load its own files through the proxy. Waddle marks
every answer it sends, never sends the statuses an edge replaces, and the service worker shows a
"Reconnecting" screen in place of any page that does not carry the mark. A visitor therefore sees
Waddle's pages or the site's, not the host's.

## Trust and limits

- Certificates are checked against Node's built-in authorities plus the operating system's store, so
  Waddle works on machines whose network adds its own authority (corporate networks, some hosted
  environments). On such a machine that authority can read Waddle's own direct downloads, as it can
  for every other program there. `WADDLE_SYSTEM_CA=0` trusts only Node's list.
- Uploads are limited to 32 MB and API requests to 1 MB. Harvested lists are limited in size and
  time per source.
- Everything that parses content from sites or lists runs in time proportional to its input, and is
  tested against input built to defeat that.
- Proxy lists are treated as untrusted text: only addresses are taken from them, and private or
  reserved addresses are thrown away.
- A GitHub token, if you set one, is sent only to GitHub and never through a proxy.

## Reporting a problem

Open an issue on the repository. For something that should not be public, contact the owner
directly first.
