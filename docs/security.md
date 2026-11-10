# Security and privacy

What Waddle protects, how, and where the protection stops. The limits are listed as plainly as the
features, because with a tool like this the limits are what you need to know.

## In one paragraph

Waddle hides your address from the sites you visit by sending requests through other people's
proxies, hides your DNS lookups from your network by encrypting them, and gives sites a consistent
made-up browser identity instead of your real one. It does **not** make you anonymous: free proxies
are run by strangers, a site that looks closely can tell it is being proxied, and everything you
browse through one Waddle shares one browser origin. Treat it as a privacy convenience, not as a
replacement for Tor or a trusted VPN, and do not sign into accounts that matter.

## Who can use your Waddle

| Protection      | Detail                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local by default | `npm start` listens on `127.0.0.1`, so only the same machine can connect. Setting `HOST=0.0.0.0` exposes it to the network, and the start-up log says so.     |
| Password        | `WADDLE_PASSWORD` puts everything behind HTTP Basic authentication (user `waddle`, or `WADDLE_USER`). It covers pages, the API and WebSockets, and is compared in constant time. Only the health check `/-/ping` is exempt. |
| No indexing     | `/robots.txt` disallows everything.                                                                                                                            |

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

## Reaching into your network

A proxy that fetches whatever address it is given is a way into the network it runs on. Waddle
refuses to connect to loopback, private, link-local and other reserved addresses, including cloud
metadata addresses. The check is made on the address a name resolves to, not on the name, on every
connection (so a name that changes its answer gains nothing), and applies to proxies as well as
sites. IPv6 spellings of IPv4 addresses are recognised.

`WADDLE_ALLOW_PRIVATE=1` turns the check off. The tests use it; a deployment should not.

## Keeping requests inside the proxy

A page has many ways to make a request, and each one that escapes goes straight from your browser
to the site, with your real address.

1. The server rewrites addresses in HTML, CSS and module imports.
2. A script that runs before anything else on the page wraps the browser's own functions (`fetch`,
   XHR, WebSocket, `sendBeacon`, forms, links, history, and elements created by scripts).
3. A service worker catches whatever the first two missed and sends it back through the proxy.
4. Where a service worker is not available (plain HTTP on anything but `localhost`, or a browser
   that refuses it in a frame), the page is given a content security policy that confines it to
   Waddle's address, so a missed request fails instead of leaking. Worker scripts get the same
   policy.

WebRTC, which can reveal a real address through a channel no proxy sees, is switched off inside
proxied pages by default.

## What the proxies can see

Free proxies are run by people you do not know, and some exist to watch or tamper with traffic.

| Traffic       | A proxy on the route can                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `https://` sites | See the site's name and how much data moves. It cannot read or change the content: Waddle verifies the site's certificate end to end, through the tunnel. |
| `http://` sites  | Read and change everything, including what you type. This is true of any network path, and worse here.                              |

With a chain of two or three proxies, only the first sees Waddle's address and only the last sees
which site is being visited. That guards against one bad proxy, not against proxies that cooperate.

With **Resolve at exit** on (the default), names are looked up by the last proxy, so sites reached
through a proxy cause no DNS lookup from your machine at all.

## When your real address shows

- In **Auto** mode Waddle goes direct when no proxy works, so the site sees the address of the
  machine Waddle runs on. The route indicator in the toolbar turns amber and says `direct` when this
  happens. Choose **Proxies only** to make Waddle fail instead.
- Before any proxy has passed its test (the first minute or so, or always on a network that blocks
  proxies), Auto mode means direct.
- A routing rule can force a site direct on purpose.

"Direct" still means the request comes from the Waddle server, not from your browser. If Waddle runs
on your own computer those are the same address.

## What a site can still tell

The made-up identity covers what page scripts and request headers reveal: user agent, client hints,
platform, languages, time zone, screen, hardware, connection, and noise or blocking for canvas,
WebGL, audio and font probes. The settings are kept consistent with each other, since a mismatch is
itself a signal.

It does not cover:

- **The network fingerprint.** The connection to the site is made by Node.js, and its TLS handshake
  and HTTP behaviour do not look like Chrome's or Safari's. Services that fingerprint at that level
  (many bot-protection products) can see the difference whatever the user agent says, and may
  answer with a challenge page that cannot be passed.
- **The proxy's reputation.** Free proxy addresses are widely listed and often blocked or shown
  CAPTCHAs.
- **The page address.** Scripts that read `location` see Waddle's address rather than the site's.
  Some sites notice and some single-page apps misroute because of it.

## One origin for everything

To a browser, every site viewed through Waddle comes from Waddle's own address. The browser's rule
that keeps one site's scripts away from another's does not apply between them.

- A script on one proxied site that sets out to can reach what another proxied site stored in the
  browser (local storage, IndexedDB), and can ask Waddle for pages of other sites using your cookies
  for them.
- Waddle's settings API lives at the same address. The page script refuses requests from proxied
  pages to it, which stops ordinary page code, but that is Waddle's own check and not one the browser
  enforces. A script written to get around the page script could change the route, add a proxy or
  clear cookies.

Waddle limits this where it can. Site cookies are kept on the server and filtered per site, cookies
marked `HttpOnly` never reach scripts, local and session storage are given a separate namespace per
site, and the password is never exposed to pages. It cannot make the pages strangers to each other without
giving every site its own hostname, which a single address cannot do.

In practice: use Waddle for reading, not for accounts you care about, and do not browse a site you
distrust in the same session as one you are signed into.

## Cookies and sessions

Each visitor gets a cookie jar on the server, identified by one `HttpOnly` cookie named `waddle`.
Site cookies go into the jar and never into your browser. Jars are held in memory only: they are
not written to disk, they are dropped after 24 hours without use, and a restart empties them all.
**Data → Clear cookies** empties yours.

When Waddle is shown inside another site's frame over HTTPS, the session cookie is set as a
partitioned third-party cookie. A browser that blocks third-party cookies outright will not keep
it, each request then starts a new session, and sign-ins will not stick. Open Waddle in its own tab
in that case.

## Trust and limits

- Certificates are checked against Node's built-in authorities plus the operating system's store, so
  Waddle works on machines whose network adds its own authority (corporate networks, some hosted
  environments). On such a machine that authority can read HTTPS traffic, as it can for every other
  program there. `WADDLE_SYSTEM_CA=0` trusts only Node's list.
- Uploads are limited to 32 MB and API requests to 1 MB. Harvested lists are limited in size and
  time per source.
- Everything that parses content from sites or lists runs in time proportional to its input, and is
  tested against input built to defeat that.
- Proxy lists are treated as untrusted text: only addresses are taken from them, and private or
  reserved addresses are thrown away.

## Reporting a problem

Open an issue on the repository. For something that should not be public, contact the owner
directly first.
