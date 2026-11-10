'use strict';
// Waddle: a small web proxy with a self-feeding, rotating pool of free proxies.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('./lib/net');
const { Config, options, parseSource } = require('./lib/config');
const { Pool, sourceId } = require('./lib/pool');
const { Resolver } = require('./lib/dns');
const { createProxy } = require('./lib/proxy');
const { session, siteOf } = require('./lib/cookies');
const { PREFIX } = require('./lib/rewrite');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
const STATIC = { 'app.js': 1, 'app.css': 1, 'client.js': 1, 'sw.js': 1, 'icon.svg': 1 };

function readJson(req, max = 1 << 20) {
  return new Promise((resolve, reject) => {
    // Refuse without tearing the connection down, so the caller can still answer 413.
    const tooLarge = () => reject(Object.assign(new Error('too large'), { code: 'ETOOBIG' }));
    if (Number(req.headers['content-length']) > max) return tooLarge();
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.pause();
        tooLarge();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function readText(req, max = 16384) {
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) parts.push(c);
    });
    req.on('end', () => resolve(size <= max ? Buffer.concat(parts).toString('utf8') : ''));
    req.on('error', () => resolve(''));
  });
}

/** Turn what someone typed into a URL: an address stays an address, anything else is a search. */
/**
 * Was this request made by another website's page rather than by Waddle's own?
 * Browsers say so themselves (Sec-Fetch-Site). A plain top-level visit from elsewhere is welcome;
 * anything else (embedding, scripted requests, form posts, sockets) is not. Clients that send no
 * such header are not browsers carrying someone's session, so there is nothing to protect.
 * @param {boolean} [socket] WebSocket handshake: older browsers send only Origin, so check that too
 */
function isForeign(req, socket) {
  const h = req.headers;
  const site = h['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return false;
  if (site)
    return !(h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-dest'] === 'document' && (req.method === 'GET' || req.method === 'HEAD'));
  if (socket && h.origin) {
    let host;
    try {
      host = new URL(h.origin).host;
    } catch {
      return true;
    }
    const own = [h.host, ...String(h['x-forwarded-host'] || '').split(',')]
      .map((x) =>
        String(x || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean);
    return !own.includes(host.toLowerCase());
  }
  return false;
}

function resolveInput(text, search) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    try {
      return new URL(t).href;
    } catch {
      /* search for it */
    }
  }
  if (
    (!/\s/.test(t) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(t)) ||
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(t) ||
    /^localhost(?::\d+)?(?:\/.*)?$/i.test(t)
  ) {
    try {
      return new URL('https://' + t).href;
    } catch {
      /* search for it */
    }
  }
  return search.replace('%s', encodeURIComponent(t));
}

function createApp() {
  const config = new Config();
  const resolver = new Resolver(config);
  net.setResolver(resolver);
  const pool = new Pool(config);
  const password = process.env.WADDLE_PASSWORD || '';
  const ownAuth = password ? 'Basic ' + Buffer.from((process.env.WADDLE_USER || 'waddle') + ':' + password).toString('base64') : '';
  const dev = process.env.WADDLE_DEV === '1';
  /** With a password set, every request has to carry it (compared in constant time). */
  const allowed = (req) => {
    if (!ownAuth) return true;
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(ownAuth);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const started = Date.now();

  const cache = new Map();
  function asset(name) {
    let a = cache.get(name);
    if (!a || dev) {
      const body = fs.readFileSync(path.join(PUBLIC, name));
      a = {
        body,
        type: TYPES[path.extname(name)] || 'application/octet-stream',
        tag: crypto.createHash('sha1').update(body).digest('base64url').slice(0, 12),
      };
      cache.set(name, a);
    }
    return a;
  }
  const proxy = createProxy({
    config,
    pool,
    get clientVersion() {
      return asset('client.js').tag;
    },
  });

  function sendAsset(req, res, name, extra) {
    let a;
    try {
      a = asset(name);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
    const pinned = /[?&]v=/.test(req.url);
    res.setHeader('Content-Type', a.type);
    res.setHeader('ETag', '"' + a.tag + '"');
    res.setHeader('Cache-Control', pinned ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for (const k of Object.keys(extra || {})) res.setHeader(k, extra[k]);
    if (req.headers['if-none-match'] === '"' + a.tag + '"') {
      res.statusCode = 304;
      return res.end();
    }
    let body = a.body;
    if (name === 'index.html') body = Buffer.from(body.toString('utf8').replace(/\{\{v\}\}/g, asset('app.js').tag + asset('app.css').tag));
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const json = (res, status, data) => {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };

  const state = (sess) => ({
    config: config.value,
    options,
    pool: pool.summary(),
    dns: resolver.summary(),
    cookies: sess ? sess.jar.size : 0,
    uptime: Math.round((Date.now() - started) / 1000),
  });

  async function api(req, res, name) {
    // A custom header forces a CORS preflight, so no other website can drive this API.
    if (req.headers['x-waddle'] !== '1') return json(res, 403, { error: 'forbidden' });
    const sess = session(req, res, proxy.isSecure(req));
    if (req.method === 'GET' && name === 'state') return json(res, 200, state(sess));
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      if (e && e.code === 'ETOOBIG') {
        res.setHeader('Connection', 'close');
        return json(res, 413, { error: 'too large' });
      }
      return json(res, 400, { error: 'bad json' });
    }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });

    if (name === 'config') {
      if (body.reset === true) config.reset();
      else config.patch(body);
      return json(res, 200, state(sess));
    }
    if (name === 'pool') {
      const out = {};
      switch (body.action) {
        case 'harvest':
          pool.harvest().catch(() => {});
          break;
        case 'rotate':
          pool.rotate(body.site ? siteOf(String(body.site)) : undefined);
          break;
        case 'clear':
          pool.clear();
          pool.harvest().catch(() => {});
          break;
        case 'add':
          out.added = pool.addManual(
            String(body.text || '').slice(0, 2e6),
            ['http', 'socks4', 'socks5'].includes(body.proto) ? body.proto : null
          );
          break;
        case 'speed': {
          let target;
          if (body.url != null && body.url !== '') {
            try {
              target = new URL(String(body.url));
            } catch {
              target = null;
            }
            if (!target || !/^https?:$/.test(target.protocol)) return json(res, 400, { error: 'not a web address' });
          }
          out.results = await pool.speed(target ? target.href : undefined);
          break;
        }
        case 'source': {
          const src = parseSource(String(body.text || ''), ['http', 'socks4', 'socks5'].includes(body.proto) ? body.proto : null);
          if (!src) return json(res, 400, { error: 'not a repository or list address' });
          const list = config.value.pool.sources;
          if (!list.some((s) => sourceId(s) === sourceId(src))) {
            config.patch({ pool: { sources: list.concat(src) } });
            pool.harvest().catch(() => {});
          }
          break;
        }
        case 'unsource':
          config.patch({ pool: { sources: config.value.pool.sources.filter((s) => sourceId(s) !== body.id) } });
          break;
        case 'toggle':
          config.patch({
            pool: {
              sources: config.value.pool.sources.map((s) => (sourceId(s) === body.id ? Object.assign({}, s, { on: !!body.on }) : s)),
            },
          });
          break;
        default:
          return json(res, 400, { error: 'unknown action' });
      }
      return json(res, 200, Object.assign(out, state(sess)));
    }
    if (name === 'dns') {
      if (body.action === 'flush') {
        resolver.flush();
        return json(res, 200, state(sess));
      }
      if (body.action === 'test') {
        const host = String(body.host || 'example.com')
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/[/:].*$/, '');
        if (!/^[a-z0-9.-]{1,253}$/.test(host)) return json(res, 400, { error: 'bad host' });
        return json(res, 200, Object.assign({ host, results: await resolver.test(host) }, state(sess)));
      }
      return json(res, 400, { error: 'unknown action' });
    }
    if (name === 'cookies') {
      sess.jar.clear();
      return json(res, 200, state(sess));
    }
    return json(res, 404, { error: 'not found' });
  }

  const refuse = (res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Cross-site requests are not served.');
  };

  async function route(req, res) {
    const url = req.url;
    if (url === '/-/ping') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    } // health checks need no password
    if (!allowed(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Waddle"', 'Content-Length': 0 });
      return res.end();
    }
    // Only Waddle's own pages may use the proxy, the cookie jar and the settings. Other websites
    // can link here (a plain top-level visit) and nothing more.
    const outsider = isForeign(req);
    if (url.startsWith(PREFIX)) return outsider ? refuse(res) : proxy.handle(req, res, { ownAuth });

    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    if (pathname.startsWith('/-/')) {
      const name = pathname.slice(3);
      if (name.startsWith('api/') || name === 'cookie') {
        if (outsider) return refuse(res);
      }
      if (name.startsWith('api/')) return api(req, res, name.slice(4));
      if (STATIC[name]) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' });
          return res.end();
        }
        return sendAsset(req, res, name, name === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : null);
      }
      if (name === 'ping') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (name === 'go') {
        // usable as a browser search keyword: /-/go?q=%s
        const to = resolveInput(new URL(url, 'http://x').searchParams.get('q'), config.value.ui.search);
        res.writeHead(302, { Location: to ? '/#' + to : '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (name === 'cookie') {
        // document.cookie, kept in the session jar on the server
        const ref = proxy.realReferer(req);
        const sess = session(req, res, proxy.isSecure(req));
        if (req.method === 'POST') {
          const line = await readText(req);
          if (ref && line) sess.jar.set(line, ref, true);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(ref ? sess.jar.visible(ref) : '');
      }
      res.statusCode = 404;
      return res.end();
    }

    // A request that escaped rewriting ("/logo.png" from a proxied page): send it back in.
    const ref = outsider ? null : proxy.realReferer(req);
    if (ref) {
      let to;
      try {
        to = new URL(url, ref.origin).href;
      } catch {
        to = null;
      }
      if (to) {
        res.writeHead(307, { Location: PREFIX + to, 'Cache-Control': 'no-store' });
        return res.end();
      }
    }
    if (pathname === '/' || pathname === '/index.html') {
      session(req, res, proxy.isSecure(req));
      return sendAsset(req, res, 'index.html', { 'Referrer-Policy': 'same-origin' });
    }
    if (pathname === '/favicon.ico') return sendAsset(req, res, 'icon.svg');
    if (pathname === '/robots.txt') {
      // a proxy has nothing a crawler should index
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    // waddle.host/example.com/page works as a shortcut (but "/sitemap.xml" is a file, not a site)
    if (
      /^\/(?:https?:\/\/?)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(pathname) &&
      !/^\/[^/]*\.(?:txt|xml|json|js|mjs|css|map|png|jpe?g|gif|ico|svg|webp|html?|php|webmanifest|woff2?)$/i.test(pathname)
    ) {
      const rest = url.slice(1).replace(/^(https?):\/+/i, '$1://');
      res.writeHead(302, { Location: '/#' + (/^https?:\/\//i.test(rest) ? rest : 'https://' + rest) });
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (process.env.WADDLE_DEBUG) console.error(req.method, req.url, e);
      if (!res.headersSent) proxy.errorPage(req, res, 500, 'Something broke', e && e.message);
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req)) return socket.destroy();
    if (!req.url.startsWith('/-/ws')) return socket.destroy();
    // Browsers do not apply the same-origin policy to WebSockets, so it is applied here.
    if (isForeign(req, true)) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    proxy.upgrade(req, socket, head).catch(() => socket.destroy());
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  server.on('clientError', (e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    config,
    pool,
    resolver,
    proxy,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          pool.start();
          resolve(server.address());
        });
      });
    },
    close() {
      pool.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy(); // includes upgraded (WebSocket) connections, which close() would wait on forever
        net.dropAgents();
      });
    },
  };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 8080;
  // This machine only, unless told otherwise: nobody means to run an open proxy on a shared network.
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host).then(
    (a) => {
      const local = /^(127\.|::1$)/.test(a.address);
      const everywhere = a.address === '0.0.0.0' || a.address === '::';
      const name = local || everywhere ? 'localhost' : a.family === 'IPv6' ? '[' + a.address + ']' : a.address;
      console.log('Waddle is up on http://' + name + ':' + a.port + (everywhere ? ' (all network interfaces)' : ''));
      if (!local && !process.env.WADDLE_PASSWORD)
        console.log('No WADDLE_PASSWORD is set: anyone who can reach this port can browse through Waddle and change its settings.');
    },
    (e) => {
      console.error(e.message);
      process.exit(1);
    }
  );
  // A proxy meets every kind of broken peer; one bad socket must not take the server down.
  process.on('uncaughtException', (e) => console.error('uncaught:', (e && e.stack) || e));
  process.on('unhandledRejection', (e) => console.error('unhandled:', (e && e.message) || e));
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
}

module.exports = { createApp, resolveInput, isForeign };
