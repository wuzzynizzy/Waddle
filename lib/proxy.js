'use strict';
// The proxy itself: turns a browser request for /~/<url> into an upstream request through
// the pool (one exit, or a chain of proxies) and adapts the answer. There is no path from
// here to a site that does not go through a proxy: when no proxy works, the request fails.

const zlib = require('zlib');
const crypto = require('crypto');
const net = require('net');
const { request, readAll, explain, isPrivateAddr, assertPublicHost, ALLOW_PRIVATE } = require('./net');
const { resolveSpoof, realBrowser, matchRule } = require('./config');
const { session, siteOf, touchTop } = require('./cookies');
const { proxify, unproxify, isFrame, rewriteHtml, rewriteCss, rewriteJs, rewriteM3u8, encode, PREFIX } = require('./rewrite');
const { isTracker } = require('./trackers');
const { errorHtml, checkHtml } = require('./pages');

const CHECK_HOST = 'check.waddle.invalid'; // the built-in "what sites see" page; .invalid can never be a real site
const CHECK_NAME = 'waddle:check'; // what the address bar calls it
// Statuses an edge in front of Waddle (a CDN, a hosting platform's router) takes for its own failure
// and replaces with its own page. They are never sent as they are: see setStatus().
const EDGE_STATUS = (s) => s === 502 || s === 504 || (s >= 520 && s <= 530);
const INSPECT_HEADERS = [
  'content-type',
  'cache-control',
  'content-length',
  'content-range',
  'accept-ranges',
  'date',
  'expires',
  'etag',
  'last-modified',
  'location',
  'server',
  'vary',
  'x-frame-options',
  'content-security-policy',
  'set-cookie',
];
function inspectHeaders(headers) {
  const out = {};
  for (const name of INSPECT_HEADERS) {
    const value = headers[name];
    if (value == null) continue;
    out[name] =
      name === 'set-cookie'
        ? '[values kept in Waddle’s cookie jar]'
        : String(Array.isArray(value) ? value.join(', ') : value).slice(0, 1000);
  }
  return out;
}

const MAX_BODY = 32 << 20; // request bodies are buffered so they can be replayed on another exit
const MAX_REWRITE = 16 << 20; // larger documents are streamed through untouched

const DROP_REQ = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'content-length',
  'accept-encoding',
  'forwarded',
  'via',
  'x-real-ip',
  'true-client-ip',
  'cdn-loop',
  'x-request-id',
  'x-waddle',
  'service-worker',
  'service-worker-navigation-preload',
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'x-original-forwarded-for',
  'origin',
  'referer',
]);
const DROP_REQ_PREFIX =
  /^(?:x-forwarded-|cf-|sec-ch-|x-envoy-|x-b3-|x-amzn-|x-vercel-|fly-|x-e2b-|x-arena-|x-cloud-trace|x-appengine-|sec-fetch-storage|x-waddle-)/;
const DROP_RES = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy-report-only',
  'cross-origin-embedder-policy-report-only',
  'permissions-policy',
  'feature-policy',
  'report-to',
  'reporting-endpoints',
  'nel',
  'alt-svc',
  'link',
  'clear-site-data',
  'referrer-policy',
  'set-cookie',
  'set-cookie2',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-connection',
  'public-key-pins',
  'public-key-pins-report-only',
  'expect-ct',
  'origin-agent-cluster',
  'document-policy',
  'sourcemap',
  'x-sourcemap',
  'accept-ch',
  'critical-ch',
  'origin-trial',
  'service-worker-allowed',
  'trailer',
  'upgrade',
  'x-xss-protection',
  'content-location',
  'speculation-rules',
  'supports-loading-mode',
  'no-vary-search',
  'timing-allow-origin',
  'server-timing',
]);
const DOC_DEST = new Set(['document', 'iframe', 'frame', 'embed', 'object']);
const DECODE = {
  gzip: zlib.gunzip,
  'x-gzip': zlib.gunzip,
  br: zlib.brotliDecompress,
  deflate: (b, cb) => zlib.inflate(b, (e, r) => (e ? zlib.inflateRaw(b, cb) : cb(null, r))),
};
if (zlib.zstdDecompress) DECODE.zstd = zlib.zstdDecompress;

const pretty = (name) =>
  name.startsWith('sec-ch-')
    ? name
    : name === 'dnt'
      ? 'DNT'
      : name === 'sec-gpc'
        ? 'Sec-GPC'
        : name.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase());
const esc = (s) => encode(String(s));

function isSecure(req) {
  if (req.socket.encrypted) return true;
  const xfp = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  if (xfp) return xfp === 'https';
  if (/^https:/.test(req.headers.origin || '') || /^https:/.test(req.headers.referer || '')) return true;
  // Sec-Fetch-* is only sent to trustworthy origins: HTTPS, or plain HTTP on loopback.
  return !!req.headers['sec-fetch-site'] && !/^(localhost|127\.|\[::1\])/.test(req.headers.host || '');
}

/**
 * A request that Waddle's service worker had to send again (one that escaped rewriting) arrives
 * looking like a script's fetch(), whatever it was. The worker says what it was in two headers of
 * its own; they are folded back into the standard ones here, once, for everything that reads them.
 * Only a request that does look like a fetch() can be renamed, and never into a page.
 */
function settle(req) {
  const h = req.headers;
  const dest = h['x-waddle-dest'];
  const mode = h['x-waddle-mode'];
  delete h['x-waddle-dest'];
  delete h['x-waddle-mode'];
  if (h['sec-fetch-dest'] !== 'empty') return;
  if (h['sec-fetch-mode'] === 'navigate') {
    h['sec-fetch-dest'] = 'iframe'; // a navigation passed on as it was: still a page
    return;
  }
  if (typeof dest === 'string' && /^[a-z]{1,24}$/.test(dest) && !DOC_DEST.has(dest)) h['sec-fetch-dest'] = dest;
  if (mode === 'cors' || mode === 'no-cors' || mode === 'same-origin') h['sec-fetch-mode'] = mode;
}

/** The real page a request came from, taken from its Referer. */
function realReferer(req) {
  const ref = req.headers.referer;
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return u.pathname.startsWith(PREFIX) ? unproxify(u.pathname + u.search) : null;
  } catch {
    return null;
  }
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const tooBig = () => reject(Object.assign(new Error('request body too large'), { status: 413 }));
    // Refuse on the declared size, before reading a byte; the count below covers chunked uploads.
    if (Number(req.headers['content-length']) > max) return tooBig();
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.pause();
        parts.length = 0;
        tooBig();
        return;
      } // stop reading; the 413 closes the connection
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

function charsetOf(type, buf, html) {
  let m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(type || '');
  if (m) return m[1];
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (html) {
    m = /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'));
    if (m) return m[1];
  }
  return 'utf-8';
}

function decodeText(buf, label) {
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function classify(type, dest, accept) {
  const ct = String(type || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    return (dest ? DOC_DEST.has(dest) : /text\/html/.test(accept || '')) ? 'html' : null;
  }
  if (dest === 'empty' || dest === 'image' || dest === 'font' || dest === 'audio' || dest === 'video') {
    return /mpegurl/.test(ct) ? 'm3u8' : null; // fetched as data: the page expects the original bytes
  }
  if (ct === 'text/css') return 'css';
  if (/^(?:application|text)\/(?:x-)?(?:java|ecma)script$/.test(ct)) return 'js';
  if (/mpegurl/.test(ct)) return 'm3u8';
  return null;
}

// What a worker script may reach: Waddle and nothing else. Its requests are kept on the proxy by the page script,
// which is put in front of every worker; this is the net under that.
const GUARD_CSP = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'";
// What a proxied page may do that the service worker cannot catch and send back through the proxy:
// frames, plugins and form posts go to Waddle or nowhere, and sockets only to Waddle's own relay.
// Nor may a proxied page be shown inside anyone else's.
const PAGE_CSP =
  "frame-src 'self' blob:; object-src 'self' blob:; form-action 'self'; connect-src 'self' http: https: data: blob:; frame-ancestors 'self'";

/** Status + the marker every Waddle response carries. The real status travels in a header when it cannot be sent as is. */
function setStatus(res, status, doc) {
  res.setHeader('X-Waddle', '1');
  if (EDGE_STATUS(status)) {
    res.setHeader('X-Waddle-Status', String(status));
    res.statusCode = doc ? 200 : 500;
  } else res.statusCode = status;
}

function createProxy({ config, pool, resolver, clientVersion, clientSource }) {
  let version = 0;
  config.onChange(() => {
    version++;
  });

  const docKey = (u) => u.origin + u.pathname + u.search;

  /**
   * Whose page is this request for? A page the visitor opened is its own first party; whatever
   * that page loads or embeds belongs to it. Exits, identity and cookies all hang off the first
   * party, so a site and everything on it leave from one exit with one face, and a third party
   * embedded on two sites is met from two different exits.
   * @param {boolean} nested the address carries the frame mark: a document some page embeds
   * @returns {{site: string, top: boolean}}
   */
  function firstParty(req, sess, target, ref, doc, nested) {
    const site = siteOf(target.hostname);
    const dest = req.headers['sec-fetch-dest'];
    // A client that says nothing about itself (no browser does that) and names no page: the request stands alone.
    if (!dest && !ref) return { site, top: doc };
    const owner = ref ? sess.frames.get(docKey(ref)) : undefined; // set when the referring document is itself embedded
    const from = ref ? siteOf(ref.hostname) : '';
    if (doc) {
      const nav = !dest || req.headers['sec-fetch-mode'] === 'navigate';
      if (nav && !nested && owner === undefined) {
        sess.frames.delete(docKey(target));
        return { site, top: true };
      }
      const first = owner !== undefined ? owner : from && sess.tops.has(from) ? from : sess.lastTop || from || site;
      if (nav) {
        const key = docKey(target);
        sess.frames.delete(key);
        sess.frames.set(key, first);
        if (sess.frames.size > 400) sess.frames.delete(sess.frames.keys().next().value);
      }
      return { site: first, top: false };
    }
    if (owner !== undefined) return { site: owner, top: false };
    if (from && sess.tops.has(from)) return { site: from, top: false };
    return { site: sess.lastTop || from || site, top: false };
  }

  /** The first party a document at `ref` belongs to, for requests that are not navigations. */
  function ownerOf(sess, ref) {
    const owner = sess.frames.get(docKey(ref));
    if (owner !== undefined) return owner;
    const from = siteOf(ref.hostname);
    return sess.tops.has(from) ? from : sess.lastTop || from;
  }

  /** The identity a page of `first` presents. Cached per session, and redone when settings or the exit's country change. */
  function identity(sess, req, first) {
    const sp = config.value.spoof;
    const where = sess.where.get(first) || {};
    const real = realBrowser(req && req.headers['user-agent']);
    const bucket = sp.random === 'timer' ? Math.floor(Date.now() / (sp.randomMinutes * 60000)) : 0;
    const key = [version, sp.random === 'site' ? first : '', where.cc || '', where.colo || '', real ? real.engine : '', bucket].join('|');
    if (!sess.spoof) sess.spoof = new Map();
    let v = sess.spoof.get(key);
    if (!v) {
      v = resolveSpoof(sp, sess.seed, Date.now(), { site: first, cc: where.cc, colo: where.colo, real });
      sess.spoof.set(key, v);
      if (sess.spoof.size > 40) sess.spoof.delete(sess.spoof.keys().next().value);
    }
    return v;
  }
  const spoofFor = (sess, req, first) => identity(sess, req, first || sess.lastTop || '');

  /** Which way does this host go? Always through proxies; a rule can pin countries and chain length, or block it. */
  function plan(host, pathname) {
    const c = config.value;
    const rule = matchRule(c.route.rules, host);
    const out = { mode: 'proxy', countries: null, hops: 0, rule: rule ? rule.pattern : '', why: '' };
    if (rule) {
      if (rule.via === 'block') return Object.assign(out, { mode: 'block', why: 'rule' });
      out.countries = rule.countries;
      out.hops = rule.hops;
    }
    if (c.privacy.trackers && isTracker(host, pathname)) return Object.assign(out, { mode: 'block', why: 'tracker' });
    return out;
  }

  /** Why no route could be built, as an error the page can explain. */
  function noRoute(o, plain) {
    const e = Object.assign(new Error('no working proxy'), { code: 'ENOPROXY', phase: 'proxy' });
    if (!pool.alive.size) e.reason = pool.health();
    else if (!pool._usable(o.plan.countries).length) e.reason = 'filter';
    else if (plain && !pool._usable(o.plan.countries, { plain: true }).length) e.reason = 'plain';
    else if (config.value.route.entry.length && (o.plan.hops || config.value.route.hops) > 1) e.reason = 'entry';
    else e.reason = 'chain';
    return e;
  }

  /**
   * Send one request upstream through the pool. Falls back from exit to exit, towards other
   * kinds of proxy, around relays that fail and, when allowed, to a shorter chain. It never
   * falls back to a direct connection: with no route left, it throws.
   * @param {object} o { url, method, body, upgrade, doc, plan, key: first-party site, headers: (route) => object, onRoute?: (route) => void }
   *   What is learned about exits is kept under the first party when the request goes to it, and apart when it
   *   goes to a third party on its pages: a frame that is turned away does not move the page it sits in.
   */
  async function send(o) {
    const r = config.value.route;
    const d = config.value.dns;
    const tried = new Set(); // exits that had their go
    const avoid = new Set(); // relays that let a chain down
    const vary = new Set(); // kinds of proxy that failed as an exit
    const safe = o.method === 'GET' || o.method === 'HEAD' || o.method === 'OPTIONS';
    const plain = o.url.protocol === 'http:';
    const host = o.url.hostname.replace(/^\[|\]$/g, '');
    const guest = siteOf(host) !== o.key ? siteOf(host) : '';
    let hops = o.plan.hops || r.hops;
    let failure = null;
    let attempts = 0;
    let detours = 0; // tries spent on a relay's fault rather than the exit's
    const doubted = []; // exits that could not reach the site: their fault only if another one can
    const reached = () => {
      // It counts against them, and this site (or this third party on it) is kept away from them for a
      // while. Whatever else they carry stays with them: they failed for one host, not as proxies.
      for (const bad of doubted.splice(0)) {
        pool.report(bad, false, 0, true);
        pool.remember(o.key, bad, false, guest);
      }
    };
    // Private and local addresses are refused before any proxy is involved: no exit is blamed for them.
    try {
      assertPublicHost(host);
    } catch (e) {
      throw Object.assign(e, { fatal: true });
    }
    const pick = () =>
      attempts - Math.min(detours, 3) <= r.retries
        ? pool.route(o.key, tried, { hops, countries: o.plan.countries, plain, vary, avoid, guest })
        : null;
    let route = pick();
    if (!route) throw noRoute(o, plain);
    while (route) {
      tried.add(route.key);
      attempts++;
      const t0 = Date.now();
      try {
        if (o.onRoute) o.onRoute(route);
        // Who looks the name up: the exit itself, or the chosen resolvers, asked through this same route.
        let address = '';
        if (!net.isIP(host) && (d.mode === 'stack' || (d.mode === 'auto' && route.proto === 'socks4'))) {
          try {
            address = await resolver.resolve4(host, { via: route });
          } catch (e) {
            if (e.final) throw Object.assign(e, { phase: 'dns', fatal: true }); // the name does not exist: no exit will change that
            if (d.mode === 'stack') throw Object.assign(e, { phase: 'proxy', culprit: e.culprit || route });
            // auto: leave it to the exit after all (SOCKS4a)
          }
          // A public name that points into a private network is refused like the address itself.
          if (address && !ALLOW_PRIVATE && isPrivateAddr(address))
            throw Object.assign(new Error('private address blocked: ' + host), { code: 'EPRIVATE', fatal: true });
        }
        const res = await request({
          url: o.url,
          method: o.method,
          headers: o.headers(route),
          body: o.body,
          proxy: route,
          address,
          timeout: r.timeout,
          upgrade: o.upgrade,
        });
        const ms = Date.now() - t0;
        reached(); // this exit got through to the site: the ones before it that could not are now known to be the problem
        // Turned away at the door (bot wall, rate limit, region block): this exit is burnt for this site.
        if (o.doc && safe && (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) && !res.upgrade) {
          pool.remember(o.key, route, false, guest);
          pool.rotate(o.key, guest);
          const other = pick();
          // Move on while there is another exit to try. With none left, the site's own answer is the answer.
          if (other) {
            res.resume();
            failure = Object.assign(new Error('the site refused this exit (' + res.statusCode + ')'), {
              phase: 'target',
              refused: res.statusCode,
            });
            route = other;
            continue;
          }
        }
        pool.report(route, true, ms);
        if (o.doc && res.statusCode < 400) {
          pool.remember(o.key, route, true, guest);
          if (attempts > 1) pool.pin(o.key, route, guest); // the page (or the frame in it) moves to the exit that works for it
        }
        return { res, route, ms, attempts };
      } catch (e) {
        if (e.fatal) throw e;
        failure = e;
        const fault = pool.blame(route, e, true);
        if (fault.doubt) doubted.push(route);
        if (!safe && e.sent) throw e; // it may have gone through: never repeat a non-idempotent request
        if (fault.relay) {
          // The exit never got its turn: keep it in play, go around the relay, and after two such detours use one hop fewer.
          avoid.add(fault.key);
          tried.delete(route.key);
          detours++;
          if (detours >= 2 && r.shorten && hops > 1) hops--;
        } else vary.add(route.proto);
        route = pick();
      }
    }
    throw failure || noRoute(o, plain);
  }

  /** Headers for the upstream request, in the browser's own order and casing. */
  function upstreamHeaders(req, target, sess, ctx) {
    const list = [['Host', target.host, 'host']];
    const raw = req.rawHeaders;
    // Behind an HTTP/2 front (most hosts and CDNs) every name arrives in lower case. Sites are spoken to
    // over HTTP/1.1, where a browser spells them the usual way: a lower-case "user-agent" there stands out.
    let lowered = true;
    for (let i = 0; i < raw.length && lowered; i += 2) lowered = raw[i] === raw[i].toLowerCase();
    for (let i = 0; i < raw.length; i += 2) {
      const lower = raw[i].toLowerCase();
      if (DROP_REQ.has(lower) || DROP_REQ_PREFIX.test(lower)) continue;
      if (lower === 'authorization' && ctx.ownAuth && raw[i + 1] === ctx.ownAuth) continue; // that one is Waddle's own password
      list.push([lowered ? pretty(lower) : raw[i], raw[i + 1], lower]);
    }
    const put = (lower, value) => {
      const at = list.findIndex((h) => h[2] === lower);
      if (value === null || value === undefined) {
        if (at >= 0) list.splice(at, 1);
        return;
      }
      if (at >= 0) list[at][1] = value;
      else list.push([pretty(lower), value, lower]);
    };
    const has = (lower) => list.some((h) => h[2] === lower);
    const spoof = config.value.spoof;
    const ref = ctx.ref;
    const sameOrigin = ref && ref.origin === target.origin;

    // Referer: same-origin requests always carry it; what other sites get is a setting.
    if (ref && !(ref.protocol === 'https:' && target.protocol === 'http:')) {
      const full = ref.origin + ref.pathname + ref.search;
      if (sameOrigin || spoof.referer === 'full') put('referer', full);
      else if (spoof.referer === 'origin') put('referer', ref.origin + '/');
    }
    const sentOrigin = req.headers.origin;
    const mode = req.headers['sec-fetch-mode'];
    if (sentOrigin === 'null') put('origin', 'null');
    else if (sentOrigin || (ref && !sameOrigin && mode === 'cors')) put('origin', ref ? ref.origin : target.origin);

    if (req.headers['sec-fetch-site']) {
      let rel = 'none';
      if (ref)
        rel = sameOrigin
          ? 'same-origin'
          : siteOf(ref.hostname) === siteOf(target.hostname) && ref.protocol === target.protocol
            ? 'same-site'
            : 'cross-site';
      else if (mode !== 'navigate') rel = 'same-origin';
      put('sec-fetch-site', rel);
      // What the request is, as settled on arrival (see settle()).
      if (mode) put('sec-fetch-mode', mode);
      if (req.headers['sec-fetch-dest']) put('sec-fetch-dest', req.headers['sec-fetch-dest']);
      // The page lives in Waddle's frame; to the site it must look like a top-level tab.
      if (req.headers['sec-fetch-dest'] === 'iframe' && ctx.top) put('sec-fetch-dest', 'document');
    }
    const accepts = String(req.headers['accept-encoding'] || 'gzip, deflate').toLowerCase();
    put('accept-encoding', ['gzip', 'deflate', 'br', 'zstd'].filter((e) => accepts.includes(e) && DECODE[e]).join(', ') || 'identity');

    if (spoof.on) {
      const sp = identity(sess, req, ctx.first).headers;
      for (const k of Object.keys(sp)) {
        if (k.startsWith('sec-ch-') && target.protocol !== 'https:') continue; // client hints are HTTPS-only
        put(k, sp[k]);
      }
    } else {
      for (let i = 0; i < raw.length; i += 2) if (/^sec-ch-/i.test(raw[i])) put(raw[i].toLowerCase(), raw[i + 1]);
    }
    const cookie = ctx.cookies ? sess.jar.header(target) : '';
    if (cookie) put('cookie', cookie);
    if (ctx.body && ctx.body.length) put('content-length', String(ctx.body.length));
    else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') put('content-length', '0');
    if (!has('accept')) put('accept', '*/*');

    const out = {};
    for (const [name, value] of list) {
      if (out[name] === undefined) out[name] = value;
      else out[name] = [].concat(out[name], value);
    }
    return out;
  }

  /** May this request carry and set cookies? By default only the site in the address bar may. */
  function cookiesAllowed(target, first) {
    const mode = config.value.privacy.cookies;
    if (mode === 'none') return false;
    if (mode === 'all') return true;
    return siteOf(target.hostname) === first;
  }

  /**
   * The script tag that goes first into every proxied document.
   * @param {string} [part] set when the document is another site's guest: the site whose page it is shown in
   */
  function bootstrap(sess, req, target, first, cookies, part) {
    const page = identity(sess, req, first).page;
    const data = { page, cookie: cookies ? sess.jar.visible(target) : '', jar: cookies };
    if (part) data.part = part;
    return '<script src="/-/client.js?v=' + clientVersion() + '" data-w="' + esc(JSON.stringify(data)) + '"></script>';
  }

  const isDoc = (req) => {
    const dest = req.headers['sec-fetch-dest'];
    return dest ? DOC_DEST.has(dest) : /text\/html/.test(req.headers.accept || '');
  };

  /**
   * Answer with one of Waddle's own pages. A document always goes out as 200 (the real code in
   * X-Waddle-Status) so that nothing in front of Waddle swaps the page for its own.
   * @param {object} o { status, title, detail, target, actions, retry, code }
   */
  function errorPage(req, res, o) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const doc = isDoc(req);
    const status = o.status || 500;
    res.setHeader('X-Waddle', '1');
    res.setHeader('X-Waddle-Error', o.code || '1');
    res.setHeader('X-Waddle-Status', String(status));
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = doc ? 200 : EDGE_STATUS(status) ? 500 : status;
    if (status === 413) {
      // the rest of the upload is not wanted: answer, then hang up
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
    }
    if (!doc || req.method === 'HEAD') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : o.title + (o.detail ? ': ' + o.detail : ''));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.end(errorHtml(Object.assign({ theme: config.value.ui.theme }, o)));
  }

  const NO_PROXY = {
    starting: ['Finding a proxy', 'Waddle has just started and is still testing proxies. This page loads as soon as one works.', 4],
    searching: ['Finding a proxy', 'No proxy is working yet. Waddle is still testing; this page loads as soon as one works.', 6],
    blocked: [
      'This network blocks proxies',
      'None of the proxies Waddle tried could be reached from here, so nothing can be loaded. Waddle never connects to a site directly.',
      0,
    ],
    nolists: ['No proxy lists', 'None of the proxy lists could be downloaded from this network.', 0],
    empty: ['No proxy lists', 'Every proxy list is switched off. Add one, or add proxies by hand.', 0],
    off: ['No proxies', 'Harvesting is off and no proxy has been added by hand.', 0],
    filter: ['No proxy matches', 'There are live proxies, but none in the countries or of the kinds you allow.', 0],
    plain: [
      'No safe proxy for plain HTTP',
      'This address has no encryption, and no live proxy has proven that it leaves such pages untouched.',
      0,
    ],
    entry: ['No entry proxy', 'No live proxy is in the countries allowed for the first hop.', 0],
    chain: ['Not enough proxies', 'Too few proxies are alive to build a chain of that length.', 8],
    ok: ['No working proxy', 'Every proxy that was tried failed. New ones are being tested.', 6],
  };

  /** @returns {object} what errorPage() takes */
  function describeFailure(e, ctx = {}) {
    if (e.status === 413) return { status: 413, title: 'Too large', detail: 'The upload is larger than Waddle forwards.' };
    if (e.code === 'EPRIVATE')
      return { status: 403, title: 'Blocked', detail: 'Private and local addresses are off limits.', code: 'private' };
    if (e.code === 'ENOPROXY' || e.code === 'EDIRECT') {
      const [title, detail, retry] = NO_PROXY[e.reason] || NO_PROXY.ok;
      return { status: 502, title, detail, retry, code: 'noproxy', actions: ['proxies'] };
    }
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.phase === 'dns')
      return {
        status: 502,
        title: 'Site not found',
        detail: e.blocked
          ? 'The resolver refuses this name.'
          : e.final || e.code === 'ENOTFOUND'
            ? 'There is no site at this address.'
            : 'The name could not be looked up.',
        code: 'dns',
      };
    const plain = ctx.upgraded ? ['plain'] : [];
    if (e.refused)
      return {
        status: 502,
        title: 'Refused',
        detail: 'The site turned away every exit that was tried (' + e.refused + ').',
        actions: ['exit'],
        code: 'refused',
      };
    const what = explain(e);
    if (/timed out/.test(what))
      return {
        status: 504,
        title: 'Timed out',
        detail: e.phase === 'proxy' ? 'The proxies that were tried took too long.' : 'The site took too long to answer.',
        actions: ['exit', ...plain],
        code: 'timeout',
      };
    const tls = e.stage === 'tls'; // the tunnel was open: it is the far end's TLS that failed
    const unreached = e.code === 'EPROXYREFUSED' && !e.auth; // the exit answered, the site did not
    if (ctx.upgraded && (e.phase !== 'proxy' || tls || unreached))
      return {
        status: 502,
        title: 'No secure connection',
        detail: 'This site did not answer over HTTPS.',
        actions: ['exit', 'plain'],
        code: 'nohttps',
      };
    const said = what.charAt(0).toUpperCase() + what.slice(1);
    return {
      status: 502,
      title: 'Could not connect',
      detail: unreached
        ? 'No exit that was tried could reach this address. The site may be down.'
        : tls
          ? 'The secure connection to this site failed (' + what + ').'
          : e.phase === 'proxy'
            ? 'The proxies that were tried failed (' + what + ').'
            : said + '.',
      actions: ['exit', ...plain],
      code: 'connect',
    };
  }

  /** The visitor's own address as far as Waddle can tell. Only ever shown back to them, on the check page. */
  function visitorOf(req) {
    const said = [req.headers['cf-connecting-ip'], String(req.headers['x-forwarded-for'] || '').split(',')[0], req.socket.remoteAddress];
    for (const raw of said) {
      const ip = String(raw || '')
        .trim()
        .replace(/^::ffff:/, '');
      if (net.isIP(ip) && !isPrivateAddr(ip)) return ip;
    }
    return '';
  }

  /** The built-in "what sites see" page: asks the judge through the exit a new site would get, and shows what a page can read. */
  async function checkPage(req, res, sess) {
    const first = CHECK_HOST;
    touchTop(sess, first);
    const c = config.value;
    let exit = null;
    let exitError = '';
    const route = pool.route(first, null, {});
    if (!route) exitError = (NO_PROXY[pool.alive.size ? 'filter' : pool.health()] || NO_PROXY.ok)[0];
    else {
      sess.where.set(first, { cc: route.cc, colo: route.colo });
      exit = { ip: route.ip || '', cc: route.cc || '', hops: pool.describe(route) };
      const asked = Date.now();
      try {
        const up = await request({
          url: new URL(c.pool.judge),
          proxy: route,
          timeout: 10000,
          headers: { 'User-Agent': identity(sess, req, first).headers['user-agent'] || 'Mozilla/5.0', Accept: '*/*' },
        });
        const body = (await readAll(up, 65536)).toString('utf8');
        let m;
        if ((m = /^ip=(.+)$/m.exec(body))) exit.ip = m[1].trim();
        if ((m = /^loc=([A-Z]{2})$/m.exec(body))) exit.cc = m[1];
        pool.report(route, true);
        sess.last = { at: Date.now(), host: CHECK_NAME, status: 200, ms: Date.now() - asked, hops: exit.hops, attempts: 1, rule: '' };
      } catch (e) {
        pool.blame(route, e);
        exitError = 'The exit did not answer the test (' + explain(e) + ').';
        sess.last = { at: Date.now(), host: CHECK_NAME, error: 'Exit failed', detail: exitError, hops: [], rule: '' };
      }
    }
    const id = identity(sess, req, first);
    const sent = {};
    for (const k of Object.keys(id.headers)) if (id.headers[k] != null) sent[pretty(k)] = id.headers[k];
    if (!c.spoof.on) sent['User-Agent'] = req.headers['user-agent'] || '';
    const html = checkHtml({
      inject: bootstrap(sess, req, new URL('https://' + CHECK_HOST + '/'), first, false),
      theme: c.ui.theme,
      exit,
      exitError,
      sent,
      visitor: visitorOf(req),
      detectable: id.info.detectable,
      policy: {
        geo: c.spoof.on ? c.spoof.geo : 'real',
        dns:
          c.dns.mode === 'exit'
            ? 'by the exit'
            : c.dns.mode === 'stack'
              ? 'your resolvers, through the exit'
              : 'by the exit; your resolvers when it cannot',
        https: c.route.https,
        cookies: c.privacy.cookies === 'first' ? 'refused' : c.privacy.cookies === 'none' ? 'all cookies refused' : 'allowed',
        trackers: c.privacy.trackers,
      },
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Waddle': '1',
      'Referrer-Policy': 'same-origin',
    });
    res.end(html);
  }

  // ---- HTTP -----------------------------------------------------------------------

  async function handle(req, res, ctx = {}) {
    const target = unproxify(req.url);
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:'))
      return errorPage(req, res, { status: 400, title: 'Bad address', detail: 'That is not a web address.' });
    target.hash = '';
    if (target.username || target.password) {
      target.username = '';
      target.password = '';
    }
    const dest = req.headers['sec-fetch-dest'] || '';
    const doc = isDoc(req);
    if (dest === 'serviceworker') {
      res.writeHead(404, { 'X-Waddle': '1' });
      return res.end();
    } // sites' own service workers would fight ours
    const sess = session(req, res, isSecure(req));
    if (target.hostname === CHECK_HOST) return checkPage(req, res, sess);

    const started = Date.now();
    const inspection = {
      id: crypto.randomBytes(6).toString('base64url'),
      at: started,
      url: target.href.slice(0, 4096),
      method: req.method,
      type: req.headers['sec-fetch-dest'] || (doc ? 'document' : 'fetch'),
      status: null,
      waddleStatus: null,
      ms: 0,
      bytes: 0,
      servedBytes: null,
      route: [],
      blocked: '',
      error: '',
      headers: {},
    };
    let logged = false;
    const record = (patch) => {
      Object.assign(inspection, patch || {});
      inspection.ms = Date.now() - started;
      if (!logged) {
        logged = true;
        if (!Array.isArray(sess.inspect)) sess.inspect = [];
        sess.inspect.unshift(inspection);
        if (sess.inspect.length > 200) sess.inspect.length = 200;
      }
      return inspection;
    };

    const route = plan(target.hostname, target.pathname);
    if (route.mode === 'block') {
      if (route.why === 'tracker') {
        sess.blocked++;
        record({ status: 403, waddleStatus: 403, blocked: 'tracker', error: 'Blocked tracker' });
        if (!doc) {
          // Refused quietly: to the page it is a request that failed, as with any blocker.
          res.writeHead(403, { 'X-Waddle': '1', 'X-Waddle-Blocked': 'tracker', 'Cache-Control': 'no-store', 'Content-Length': 0 });
          return res.end();
        }
        return errorPage(req, res, {
          status: 403,
          title: 'Blocked',
          detail: 'This is a tracking or advertising host. Tracker blocking is on.',
          target,
          code: 'tracker',
        });
      }
      record({ status: 403, waddleStatus: doc ? 200 : 403, blocked: 'rule', error: 'Blocked by routing rule' });
      return errorPage(req, res, { status: 403, title: 'Blocked', detail: 'A routing rule blocks this site.', target, code: 'rule' });
    }

    // HTTPS only: an address without encryption is asked for over HTTPS instead. Staying on plain HTTP takes a deliberate yes.
    if (target.protocol === 'http:' && config.value.route.https && !sess.plain.has(target.hostname)) {
      const to = new URL(target.href);
      to.protocol = 'https:';
      const mark = isFrame(req.url);
      if (doc) {
        const now = Date.now();
        const was = sess.upgraded.get(target.hostname);
        const n = was && now - was.at < 8000 ? was.n + 1 : 1;
        sess.upgraded.set(target.hostname, { at: now, n });
        if (sess.upgraded.size > 200) sess.upgraded.delete(sess.upgraded.keys().next().value);
        // A site that keeps sending its visitors back to plain HTTP: stop going round in circles and ask.
        if (n > 3) {
          record({ status: 502, waddleStatus: doc ? 200 : 500, blocked: 'https-only', error: 'No secure connection' });
          return errorPage(req, res, {
            status: 502,
            title: 'No secure connection',
            detail: 'This site only works without HTTPS.',
            target,
            actions: ['plain'],
            code: 'nohttps',
          });
        }
      }
      record({ status: 307, waddleStatus: 307, blocked: 'https-only', error: 'Upgraded to HTTPS' });
      res.writeHead(307, {
        Location: proxify(to.href, to, mark),
        'Cache-Control': 'no-store',
        'X-Waddle': '1',
        'X-Waddle-Upgrade': 'https',
      });
      return res.end();
    }

    ctx.ref = realReferer(req);
    const nested = isFrame(req.url);
    const first = firstParty(req, sess, target, ctx.ref, doc, nested);
    if (first.top) touchTop(sess, first.site);
    ctx.first = first.site;
    ctx.top = first.top;
    // A document (or its worker) that belongs to another site's page keeps its storage apart from that site's own.
    const part = !first.top && siteOf(target.hostname) !== first.site ? first.site : '';
    ctx.cookies = cookiesAllowed(target, first.site);
    let up;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readBody(req, MAX_BODY);
      up = await send({
        url: target,
        method: req.method,
        body: ctx.body,
        plan: route,
        key: first.site,
        doc,
        // A page's identity follows the country it leaves from, so the exit is settled before the headers are written.
        onRoute: (r) => {
          if (first.top || !sess.where.has(first.site)) sess.where.set(first.site, { cc: r.cc, colo: r.colo });
        },
        headers: () => upstreamHeaders(req, target, sess, ctx),
      });
    } catch (e) {
      const was = sess.upgraded.get(target.hostname);
      const upgraded = target.protocol === 'https:' && !!was && Date.now() - was.at < 600000;
      const told = describeFailure(e, { upgraded });
      if (doc && first.top)
        sess.last = { at: Date.now(), host: target.host, error: told.title, detail: told.detail || '', hops: [], rule: route.rule };
      record({
        status: told.status || 500,
        waddleStatus: doc ? 200 : EDGE_STATUS(told.status || 500) ? 500 : told.status || 500,
        blocked: told.code === 'tracker' || told.code === 'rule' ? told.code : '',
        error: told.title || 'Request failed',
      });
      return errorPage(req, res, Object.assign(told, { target }));
    }
    const upRes = up.res;
    const upMs = Date.now() - started;
    record({
      status: upRes.statusCode,
      waddleStatus: doc ? 200 : EDGE_STATUS(upRes.statusCode) ? 500 : upRes.statusCode,
      route: pool.describe(up.route),
      headers: inspectHeaders(upRes.headers),
      error: upRes.statusCode >= 400 ? 'Site returned HTTP ' + upRes.statusCode : '',
    });
    upRes.on('data', (chunk) => {
      inspection.bytes += chunk.length;
    });
    res.on('finish', () => {
      inspection.ms = Date.now() - started;
      inspection.waddleStatus = res.statusCode;
      const length = Number(res.getHeader('content-length'));
      inspection.servedBytes = Number.isFinite(length) && length >= 0 ? length : null;
    });
    // The route that is reported is the one of the page in the address bar, not of whatever that page embeds.
    if (doc && first.top) {
      sess.last = {
        at: Date.now(),
        host: target.host,
        status: upRes.statusCode,
        ms: upMs,
        hops: pool.describe(up.route),
        attempts: up.attempts,
        rule: route.rule,
      };
    }
    res.on('close', () => {
      if (!upRes.complete) upRes.destroy();
    });
    upRes.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });

    // ---- response headers
    if (ctx.cookies) for (const line of [].concat(upRes.headers['set-cookie'] || [])) sess.jar.set(line, target);
    const raw = upRes.rawHeaders;
    const status = upRes.statusCode;
    setStatus(res, status, doc);
    for (let i = 0; i < raw.length; i += 2) {
      const lower = raw[i].toLowerCase();
      if (DROP_RES.has(lower) || lower.startsWith('x-waddle')) continue;
      let value = raw[i + 1];
      if (lower === 'location') {
        // Redirects stay inside the proxy. One to a script or data URL is not a redirect at all.
        if (/^\s*(?:javascript|data|vbscript|blob|file|about|view-source)\s*:/i.test(value)) continue;
        value = proxify(value, target, nested); // a frame that is sent elsewhere is still a frame
      } else if (lower === 'refresh')
        value = value.replace(
          /^(\s*[\d.]+\s*[;,]\s*(?:url\s*=\s*)?)["']?([^"']{1,4096})["']?\s*$/i,
          (m, a, u) => a + proxify(u.trim(), target)
        );
      else if (lower === 'content-length' || lower === 'content-encoding' || lower === 'content-type') continue; // decided below
      try {
        res.appendHeader(raw[i], value);
      } catch {
        /* a header the browser would refuse anyway */
      }
    }
    res.setHeader('Referrer-Policy', 'same-origin');
    const type = upRes.headers['content-type'] || '';
    const encoding = String(upRes.headers['content-encoding'] || '')
      .trim()
      .toLowerCase();
    const cookieEcho = () => {
      // Scripts watch document.cookie; tell the page's hooks what it should now read.
      if (ctx.cookies && dest === 'empty' && upRes.headers['set-cookie'] && ctx.ref) {
        res.setHeader('X-Waddle-Cookie', encodeURIComponent(sess.jar.visible(ctx.ref)).slice(0, 6000));
      }
    };
    const passThrough = () => {
      if (type) res.setHeader('Content-Type', type);
      if (encoding) res.setHeader('Content-Encoding', upRes.headers['content-encoding']);
      if (upRes.headers['content-length']) res.setHeader('Content-Length', upRes.headers['content-length']);
      cookieEcho();
    };

    const bodyless = req.method === 'HEAD' || status === 204 || status === 304 || status < 200;
    const kind = bodyless || status === 206 ? null : classify(type, dest, req.headers.accept);
    const decoder = !encoding || encoding === 'identity' ? null : DECODE[encoding];
    const declared = Number(upRes.headers['content-length'] || 0);
    if (!kind || (encoding && encoding !== 'identity' && !decoder) || declared > MAX_REWRITE) {
      passThrough();
      if (bodyless) {
        upRes.resume();
        return res.end();
      }
      res.flushHeaders();
      return upRes.pipe(res);
    }

    // ---- buffer, decode, rewrite
    const broken = (detail) => {
      for (const name of res.getHeaderNames()) if (name !== 'set-cookie') res.removeHeader(name);
      return errorPage(req, res, { status: 502, title: 'Could not load', detail, target, actions: ['exit'], code: 'broken' });
    };
    let buf;
    try {
      buf = await readAll(upRes, MAX_REWRITE);
    } catch (e) {
      if (!res.headersSent) return broken(explain(e).replace(/^./, (c) => c.toUpperCase()) + '.');
      return res.destroy();
    }
    try {
      if (decoder && buf.length) buf = await new Promise((resolve, reject) => decoder(buf, (e, r) => (e ? reject(e) : resolve(r))));
    } catch {
      return broken('The response was corrupted on the way.');
    }

    const t1 = Date.now();
    const text = decodeText(buf, charsetOf(type, buf, kind === 'html'));
    let out;
    let outType;
    if (kind === 'html') {
      out = rewriteHtml(text, target.href, { inject: bootstrap(sess, req, target, first.site, ctx.cookies, part) });
      outType = (type.split(';')[0].trim() || 'text/html') + '; charset=utf-8';
      res.setHeader('Content-Security-Policy', PAGE_CSP);
      res.setHeader('Cache-Control', 'no-store');
      res.removeHeader('Expires');
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');
      res.removeHeader('Age');
    } else if (kind === 'css') {
      out = rewriteCss(text, target.href);
      outType = 'text/css; charset=utf-8';
    } else if (kind === 'js') {
      out = rewriteJs(text, target.href);
      if (dest === 'worker' || dest === 'sharedworker') {
        // A worker is a second place to ask "who am I talking to", and a second place to make requests from. The page
        // script goes in front of it: the same identity as the page that started it, and every request kept on the proxy.
        const boot = { page: identity(sess, req, first.site).page, base: target.href };
        if (part) boot.part = part;
        out = 'self.__waddle=' + JSON.stringify(boot).replace(/</g, '\\u003c') + ';\n' + clientSource() + '\n' + out;
        res.setHeader('Content-Security-Policy', GUARD_CSP);
      }
      outType = (type.split(';')[0].trim() || 'text/javascript') + '; charset=utf-8';
    } else {
      out = rewriteM3u8(text, target.href);
      outType = type.split(';')[0].trim() + '; charset=utf-8';
    }
    let body = Buffer.from(out, 'utf8');
    res.setHeader('Content-Type', outType);
    res.setHeader('Server-Timing', 'up;dur=' + upMs + ', rw;dur=' + (Date.now() - t1));
    cookieEcho();
    if (body.length > 1400 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      body = await new Promise((resolve) => zlib.gzip(body, { level: 4 }, (e, r) => resolve(e ? body : r)));
      if (body[0] === 0x1f && body[1] === 0x8b) {
        res.setHeader('Content-Encoding', 'gzip');
        res.appendHeader('Vary', 'Accept-Encoding');
      }
    }
    res.setHeader('Content-Length', body.length);
    res.end(body);
  }

  // ---- WebSocket relay ------------------------------------------------------------

  async function upgrade(req, socket, head) {
    const q = new URL(req.url, 'http://x').searchParams;
    let target;
    try {
      target = new URL(q.get('u'));
    } catch {
      target = null;
    }
    const deny = (code, text) => {
      socket.end('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    if (!target || !/^wss?:$/.test(target.protocol)) return deny(400, 'Bad Request');
    const sess = session(req, null, isSecure(req));
    // HTTPS only covers sockets too: ws:// is asked for as wss://.
    if (target.protocol === 'ws:' && config.value.route.https && !sess.plain.has(target.hostname)) target.protocol = 'wss:';
    const url = new URL(target.href.replace(/^ws/, 'http'));
    const route = plan(url.hostname, url.pathname);
    if (route.mode === 'block') {
      if (route.why === 'tracker') sess.blocked++;
      return deny(403, 'Forbidden');
    }
    let origin = q.get('o') || '';
    let first = '';
    try {
      const o = new URL(origin);
      origin = o.origin;
      first = siteOf(o.hostname);
    } catch {
      origin = url.origin;
    }
    if (!first || !sess.tops.has(first)) first = sess.lastTop || first || siteOf(url.hostname);
    const headers = {
      Host: url.host,
      Connection: 'Upgrade',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Upgrade: 'websocket',
      Origin: origin,
    };
    for (const k of ['sec-websocket-version', 'sec-websocket-key', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
      if (req.headers[k]) headers[pretty(k)] = req.headers[k];
    }
    headers['User-Agent'] = req.headers['user-agent'] || '';
    if (req.headers['accept-language']) headers['Accept-Language'] = req.headers['accept-language'];
    const cookies = cookiesAllowed(url, first);
    const cookie = cookies ? sess.jar.header(url) : '';
    if (cookie) headers.Cookie = cookie;
    socket.on('error', () => {});
    let up;
    try {
      up = await send({
        url,
        method: 'GET',
        body: null,
        plan: route,
        key: first,
        upgrade: true,
        onRoute: (r) => {
          if (!sess.where.has(first)) sess.where.set(first, { cc: r.cc, colo: r.colo });
        },
        headers: () => {
          if (config.value.spoof.on) {
            const sp = identity(sess, req, first).headers;
            if (sp['user-agent']) headers['User-Agent'] = sp['user-agent'];
            if (sp['accept-language']) headers['Accept-Language'] = sp['accept-language'];
          }
          return headers;
        },
      });
    } catch {
      return deny(500, 'Upstream Failed');
    }
    const res = up.res;
    if (cookies) for (const line of [].concat(res.headers['set-cookie'] || [])) sess.jar.set(line, url);
    if (!res.upgrade) {
      res.resume();
      const code = res.statusCode === 101 || EDGE_STATUS(res.statusCode) ? 500 : res.statusCode;
      return deny(code, 'Refused');
    }
    const peer = res.upgrade.socket;
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
    for (const k of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (res.headers[k]) lines.push(pretty(k) + ': ' + res.headers[k]);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (res.upgrade.head && res.upgrade.head.length) socket.write(res.upgrade.head);
    if (head && head.length) peer.write(head);
    peer.setTimeout(0);
    socket.setTimeout(0);
    peer.on('error', () => socket.destroy());
    socket.on('error', () => peer.destroy());
    peer.on('close', () => socket.destroy());
    socket.on('close', () => peer.destroy());
    peer.pipe(socket);
    socket.pipe(peer);
  }

  return { handle, upgrade, plan, errorPage, realReferer, isSecure, spoofFor, identity, cookiesAllowed, firstParty, ownerOf };
}

module.exports = { createProxy, classify, charsetOf, settle, CHECK_HOST, EDGE_STATUS, PAGE_CSP, GUARD_CSP };
