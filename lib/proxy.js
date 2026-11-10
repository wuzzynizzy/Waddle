'use strict';
// The proxy itself: turns a browser request for /~/<url> into an upstream request
// (through the rotating pool, a proxy chain, or directly) and adapts the answer.

const zlib = require('zlib');
const { request, readAll, explain } = require('./net');
const { resolveSpoof, matchRule } = require('./config');
const { session, siteOf } = require('./cookies');
const { proxify, unproxify, rewriteHtml, rewriteCss, rewriteJs, rewriteM3u8, encode, PREFIX } = require('./rewrite');

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
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'x-original-forwarded-for',
  'origin',
  'referer',
]);
const DROP_REQ_PREFIX =
  /^(?:x-forwarded-|cf-|sec-ch-|x-envoy-|x-b3-|x-amzn-|x-vercel-|fly-|x-e2b-|x-arena-|x-cloud-trace|x-appengine-|sec-fetch-storage)/;
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
  name.startsWith('sec-ch-') ? name : name === 'dnt' ? 'DNT' : name.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase());
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

// Runs first inside every worker: keeps its network calls on the proxy.
const WORKER_SHIM = (real) =>
  '(function(){try{var B=' +
  JSON.stringify(real) +
  ',P="/~/",O=self.location.origin;' +
  'function p(u){try{u=String(u);if(/^(data|blob|about):/i.test(u))return u;var a=new URL(u,B);' +
  'if(a.origin===O){if(a.pathname.indexOf(P)===0||a.pathname.indexOf("/-/")===0)return a.href;a=new URL(a.pathname+a.search+a.hash,B)}' +
  'return /^https?:$/.test(a.protocol)?O+P+a.href:u}catch(e){return u}}' +
  'var f=self.fetch;if(f)self.fetch=function(i,o){try{if(typeof i==="string"||i instanceof URL)i=p(i);else if(i&&i.url)i=new Request(p(i.url),i)}catch(e){}return f.call(self,i,o)};' +
  'var x=self.XMLHttpRequest&&XMLHttpRequest.prototype.open;if(x)XMLHttpRequest.prototype.open=function(m,u){arguments[1]=p(u);return x.apply(this,arguments)};' +
  'var s=self.importScripts;if(s)self.importScripts=function(){return s.apply(self,[].map.call(arguments,p))};' +
  'var W=self.WebSocket;if(W){self.WebSocket=function(u,q){var a=new URL(u,B);u=O.replace(/^http/,"ws")+"/-/ws?u="+encodeURIComponent(a.href)+"&o="+encodeURIComponent(new URL(B).origin);return q===undefined?new W(u):new W(u,q)};self.WebSocket.prototype=W.prototype}' +
  'var E=self.EventSource;if(E){self.EventSource=function(u,o){return new E(p(u),o)};self.EventSource.prototype=E.prototype}' +
  '}catch(e){}})();\n';

const GUARD_CSP = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'";

function createProxy({ config, pool, clientVersion }) {
  let version = 0;
  config.onChange(() => {
    version++;
  });

  function spoofFor(sess) {
    if (!sess.spoof || sess.spoof.version !== version) {
      sess.spoof = { version, value: resolveSpoof(config.value.spoof, sess.seed, Date.now()) };
    }
    return sess.spoof.value;
  }

  /** Dynamic routing: which way does this host go? */
  function plan(host) {
    const c = config.value;
    const rule = matchRule(c.route.rules, host);
    let mode = c.route.mode;
    const out = { mode, countries: null, hops: 0, rule: rule ? rule.pattern : '' };
    if (rule) {
      if (rule.via === 'block') return Object.assign(out, { mode: 'block' });
      mode = rule.via;
      out.countries = rule.countries;
      out.hops = rule.hops;
    }
    if (!c.pool.on && mode === 'auto') mode = 'direct';
    out.mode = mode;
    return out;
  }

  /**
   * Send one request upstream. Tries exits from the pool (rotating past the ones that
   * fail or get turned away), then falls back to a direct connection when allowed.
   */
  async function send(o) {
    const r = config.value.route;
    const tried = new Set();
    const safe = o.method === 'GET' || o.method === 'HEAD' || o.method === 'OPTIONS';
    let failure = null;
    let attempts = 0;
    if (o.plan.mode !== 'direct') {
      const pick = () => pool.route(o.site, tried, { hops: o.plan.hops, countries: o.plan.countries });
      let route = pick();
      for (let i = 0; route && i <= r.retries; i++) {
        const next = () => (i < r.retries ? pick() : null);
        tried.add(route.key);
        attempts++;
        const t0 = Date.now();
        try {
          const res = await request({
            url: o.url,
            method: o.method,
            headers: o.headers,
            body: o.body,
            proxy: route,
            timeout: r.timeout,
            upgrade: o.upgrade,
          });
          const ms = Date.now() - t0;
          if (res.statusCode === 407) {
            // the proxy wants credentials we do not have
            res.resume();
            pool.report(route, false);
            failure = Object.assign(new Error('proxy asked for a password'), { phase: 'proxy' });
            route = next();
            continue;
          }
          // Turned away at the door (bot wall, rate limit, region block): this exit is burnt for this site.
          if (o.doc && safe && (res.statusCode === 403 || res.statusCode === 429 || res.statusCode === 503) && !res.upgrade) {
            pool.rotate(o.site);
            const other = next();
            // Move on while there is somewhere to go: another exit, or a direct connection. With
            // proxies only and nothing left to try, the site's own answer is the answer.
            if (other || o.plan.mode !== 'proxy') {
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
          return { res, route, ms, attempts };
        } catch (e) {
          failure = e;
          const bad = e.culprit || route;
          pool.report(bad.cand || bad, false);
          if (!safe && e.sent) throw e; // it may have gone through: never repeat a non-idempotent request
          route = next();
        }
      }
      if (o.plan.mode === 'proxy') {
        throw failure || Object.assign(new Error('no working proxy right now'), { code: 'ENOPROXY', phase: 'proxy' });
      }
    }
    const t0 = Date.now();
    const res = await request({
      url: o.url,
      method: o.method,
      headers: o.headers,
      body: o.body,
      proxy: null,
      timeout: r.timeout,
      upgrade: o.upgrade,
    });
    return { res, route: null, ms: Date.now() - t0, attempts: attempts + 1, fellBack: o.plan.mode !== 'direct' && attempts > 0 };
  }

  /** Headers for the upstream request, in the browser's own order and casing. */
  function upstreamHeaders(req, target, sess, ctx) {
    const list = [['Host', target.host, 'host']];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const lower = raw[i].toLowerCase();
      if (DROP_REQ.has(lower) || DROP_REQ_PREFIX.test(lower)) continue;
      if (lower === 'authorization' && ctx.ownAuth && raw[i + 1] === ctx.ownAuth) continue; // that one is Waddle's own password
      list.push([raw[i], raw[i + 1], lower]);
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
      // The page lives in Waddle's frame; to the site it must look like a top-level tab.
      if (req.headers['sec-fetch-dest'] === 'iframe' && (!ref || req.headers['sec-fetch-user'])) put('sec-fetch-dest', 'document');
    }
    const accepts = String(req.headers['accept-encoding'] || 'gzip, deflate').toLowerCase();
    put('accept-encoding', ['gzip', 'deflate', 'br', 'zstd'].filter((e) => accepts.includes(e) && DECODE[e]).join(', ') || 'identity');

    if (spoof.on) {
      const sp = spoofFor(sess).headers;
      for (const k of Object.keys(sp)) {
        if (k.startsWith('sec-ch-') && target.protocol !== 'https:') continue; // client hints are HTTPS-only
        put(k, sp[k]);
      }
    } else {
      for (let i = 0; i < raw.length; i += 2) if (/^sec-ch-/i.test(raw[i])) put(raw[i].toLowerCase(), raw[i + 1]);
    }
    const cookie = sess.jar.header(target);
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

  function bootstrap(sess, target) {
    const page = spoofFor(sess).page;
    const data = { page, cookie: sess.jar.visible(target) };
    return '<script src="/-/client.js?v=' + clientVersion + '" data-w="' + esc(JSON.stringify(data)) + '"></script>';
  }

  function errorPage(req, res, status, title, detail, target) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const dest = req.headers['sec-fetch-dest'];
    const doc = dest ? DOC_DEST.has(dest) : /text\/html/.test(req.headers.accept || '');
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Waddle-Error', '1');
    if (status === 413) {
      // the rest of the upload is not wanted: answer, then hang up
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
    }
    if (!doc || req.method === 'HEAD') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : title + (detail ? ': ' + detail : ''));
      return;
    }
    const href = target ? PREFIX + target.href : '/';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">' +
        '<title>' +
        esc(title) +
        '</title><style>html{height:100%}body{margin:0;min-height:100%;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;' +
        'background:Canvas;color:CanvasText}main{max-width:30rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:0 0 1.25rem;opacity:.65;overflow-wrap:anywhere}' +
        'a{color:inherit;border:1px solid;border-radius:999px;padding:.4rem 1rem;text-decoration:none;margin-right:.5rem;opacity:.85}a:hover{opacity:1}</style>' +
        '<main><h1>' +
        esc(title) +
        '</h1><p>' +
        esc(detail || '') +
        (target ? '<br>' + esc(target.host) : '') +
        '</p>' +
        '<a href="' +
        esc(href) +
        '">Retry</a>' +
        (status === 502 || status === 504
          ? '<a href="' +
            esc(href) +
            "\" onclick=\"fetch('/-/api/pool',{method:'POST',headers:{'content-type':'application/json','x-waddle':'1'},body:'{&quot;action&quot;:&quot;rotate&quot;}'}).then(function(){location.reload()});return false\">New exit</a>"
          : '') +
        '</main>'
    );
  }

  function describeFailure(e) {
    if (e.status === 413) return [413, 'Too large', 'The upload is larger than Waddle forwards.'];
    if (e.code === 'EPRIVATE') return [403, 'Blocked', 'Private and local addresses are off limits.'];
    if (e.code === 'ENOPROXY') return [502, 'No working proxy', 'Route is set to proxies only and none is alive right now.'];
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN')
      return [502, 'Site not found', e.message === 'blocked by resolver' ? 'The DNS resolver blocks this name.' : 'No such host.'];
    if (e.refused) return [502, 'Refused', 'The site turned away every exit that was tried (' + e.refused + ').'];
    const what = explain(e);
    if (/timed out/.test(what))
      return [504, 'Timed out', e.phase === 'proxy' ? 'The proxy took too long to answer.' : 'The site took too long to answer.'];
    return [502, 'Could not connect', what.charAt(0).toUpperCase() + what.slice(1) + (e.phase === 'proxy' ? ' (via proxy).' : '.')];
  }

  // ---- HTTP -----------------------------------------------------------------------

  async function handle(req, res, ctx = {}) {
    const target = unproxify(req.url);
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:'))
      return errorPage(req, res, 400, 'Bad address', 'That is not a web address.');
    target.hash = '';
    if (target.username || target.password) {
      target.username = '';
      target.password = '';
    }
    const dest = req.headers['sec-fetch-dest'] || '';
    const doc = dest ? DOC_DEST.has(dest) : /text\/html/.test(req.headers.accept || '');
    const route = plan(target.hostname);
    if (route.mode === 'block') return errorPage(req, res, 403, 'Blocked', 'A routing rule blocks this site.', target);
    if (dest === 'serviceworker') {
      res.statusCode = 404;
      return res.end();
    } // sites' own service workers would fight ours

    const sess = session(req, res, isSecure(req));
    const started = Date.now();
    let up;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readBody(req, MAX_BODY);
      ctx.ref = realReferer(req);
      const headers = upstreamHeaders(req, target, sess, ctx);
      up = await send({ url: target, method: req.method, headers, body: ctx.body, plan: route, site: siteOf(target.hostname), doc });
    } catch (e) {
      if (doc) pool.lastRoute = { at: Date.now(), host: target.host, error: explain(e), hops: [], rule: route.rule };
      const [status, title, detail] = describeFailure(e);
      return errorPage(req, res, status, title, detail, target);
    }
    const upRes = up.res;
    const upMs = Date.now() - started;
    if (doc) {
      pool.lastRoute = {
        at: Date.now(),
        host: target.host,
        status: upRes.statusCode,
        ms: upMs,
        hops: pool.describe(up.route),
        direct: !up.route,
        fellBack: !!up.fellBack,
        attempts: up.attempts,
        rule: route.rule,
        mode: route.mode,
      };
    }
    res.on('close', () => {
      if (!upRes.complete) upRes.destroy();
    });
    upRes.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });

    // ---- response headers
    for (const line of [].concat(upRes.headers['set-cookie'] || [])) sess.jar.set(line, target);
    const raw = upRes.rawHeaders;
    const status = upRes.statusCode;
    res.statusCode = status;
    for (let i = 0; i < raw.length; i += 2) {
      const lower = raw[i].toLowerCase();
      if (DROP_RES.has(lower)) continue;
      let value = raw[i + 1];
      if (lower === 'location') {
        // Redirects stay inside the proxy. One to a script or data URL is not a redirect at all.
        if (/^\s*(?:javascript|data|vbscript|blob|file|about|view-source)\s*:/i.test(value)) continue;
        value = proxify(value, target);
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
      if (dest === 'empty' && upRes.headers['set-cookie'] && ctx.ref) {
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
    let buf;
    try {
      buf = await readAll(upRes, MAX_REWRITE);
    } catch (e) {
      if (!res.headersSent) return errorPage(req, res, 502, 'Could not load', explain(e), target);
      return res.destroy();
    }
    try {
      if (decoder && buf.length) buf = await new Promise((resolve, reject) => decoder(buf, (e, r) => (e ? reject(e) : resolve(r))));
    } catch {
      return errorPage(req, res, 502, 'Could not load', 'The response was corrupted on the way.', target);
    }

    const t1 = Date.now();
    const text = decodeText(buf, charsetOf(type, buf, kind === 'html'));
    let out;
    let outType;
    if (kind === 'html') {
      out = rewriteHtml(text, target.href, { inject: bootstrap(sess, target) });
      outType = (type.split(';')[0].trim() || 'text/html') + '; charset=utf-8';
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
        out = WORKER_SHIM(target.href) + out;
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
    const url = new URL(target.href.replace(/^ws/, 'http'));
    const route = plan(url.hostname);
    if (route.mode === 'block') return deny(403, 'Forbidden');
    const sess = session(req, null, isSecure(req));
    let origin = q.get('o') || '';
    try {
      origin = new URL(origin).origin;
    } catch {
      origin = url.origin;
    }
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
    if (config.value.spoof.on) {
      const sp = spoofFor(sess).headers;
      if (sp['user-agent']) headers['User-Agent'] = sp['user-agent'];
      if (sp['accept-language']) headers['Accept-Language'] = sp['accept-language'];
    }
    const cookie = sess.jar.header(url);
    if (cookie) headers.Cookie = cookie;
    socket.on('error', () => {});
    let up;
    try {
      up = await send({ url, method: 'GET', headers, body: null, plan: route, site: siteOf(url.hostname), upgrade: true });
    } catch {
      return deny(502, 'Bad Gateway');
    }
    const res = up.res;
    for (const line of [].concat(res.headers['set-cookie'] || [])) sess.jar.set(line, url);
    if (!res.upgrade) {
      res.resume();
      return deny(res.statusCode === 101 ? 502 : res.statusCode, 'Refused');
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

  return { handle, upgrade, plan, errorPage, realReferer, isSecure, spoofFor };
}

module.exports = { createProxy, classify, charsetOf };
