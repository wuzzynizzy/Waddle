'use strict';
// Waddle: a small web proxy with a self-feeding, rotating pool of free proxies.

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const net = require('./lib/net');
const { Config, options, parseSource } = require('./lib/config');
const { Pool, sourceId, getBuffer } = require('./lib/pool');
const { Resolver } = require('./lib/dns');
const { createProxy, settle } = require('./lib/proxy');
const { session, siteOf, renew } = require('./lib/cookies');
const { PREFIX } = require('./lib/rewrite');
const trackers = require('./lib/trackers');

const PUBLIC = path.join(__dirname, 'public');
const ROOT_ASSETS = {
  'install.sh': path.join(__dirname, 'install.sh'),
  'install.ps1': path.join(__dirname, 'install.ps1'),
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
};
const STATIC = {
  'app.js': 1,
  'local.js': 1,
  'app.css': 1,
  'tour.css': 1,
  'tour.js': 1,
  'client.js': 1,
  'sw.js': 1,
  'tour.html': 1,
  'install.sh': 1,
  'install.ps1': 1,
  'icon.svg': 1,
  'fonts/geist.woff2': 1,
  'fonts/geist-mono.woff2': 1,
};
const PUBLIC_ROUTES = new Set([
  '/tour',
  '/tour/',
  '/download',
  '/install.sh',
  '/install.ps1',
  '/favicon.ico',
  '/-/icon.svg',
  '/-/tour.css',
  '/-/tour.js',
  '/-/fonts/geist.woff2',
  '/-/fonts/geist-mono.woff2',
]);

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
  const pool = new Pool(config);
  // The resolver's own errands: its list comes through the pool when there are proxies to spare, and
  // the resolvers on that list are only ever tried through a proxy.
  const resolver = new Resolver(config, {
    fetch: (url, headers) => getBuffer(url, headers, pool.housekeeping()),
    route: () => pool.lend() || pool.route('~dns', null, { hops: 1 }),
  });
  net.setResolver(resolver);
  let chores = null;
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
      const body = fs.readFileSync(ROOT_ASSETS[name] || path.join(PUBLIC, name));
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
    resolver,
    clientVersion: () => asset('client.js').tag,
    clientSource: () => asset('client.js').body.toString('utf8'),
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
    if (name === 'index.html')
      body = Buffer.from(body.toString('utf8').replace(/\{\{v\}\}/g, asset('app.js').tag + asset('app.css').tag + asset('local.js').tag));
    else if (name === 'tour.html')
      body = Buffer.from(body.toString('utf8').replace(/\{\{v\}\}/g, asset('tour.css').tag + asset('tour.js').tag));
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const json = (res, status, data) => {
    const body = Buffer.from(JSON.stringify(data));
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Waddle': '1',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };

  const state = (sess, req) => ({
    config: config.value,
    options,
    pool: Object.assign(pool.summary(), { last: sess ? sess.last : null }),
    dns: resolver.summary(),
    cookies: sess ? sess.jar.size : 0,
    blocked: sess ? sess.blocked : 0,
    trackers: trackers.size,
    identity: sess ? proxy.spoofFor(sess, req).info : null,
    plain: sess ? [...sess.plain] : [],
    uptime: Math.round((Date.now() - started) / 1000),
  });

  async function api(req, res, name) {
    // A custom header forces a CORS preflight, so no other website can drive this API.
    if (req.headers['x-waddle'] !== '1') return json(res, 403, { error: 'forbidden' });
    const sess = session(req, res, proxy.isSecure(req));
    if (req.method === 'GET' && name === 'state') return json(res, 200, state(sess, req));
    if (req.method === 'GET' && name === 'backup')
      return json(res, 200, {
        format: 'waddle-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        config: config.value,
      });
    if (req.method === 'GET' && name === 'inspect') {
      let target = null;
      try {
        const q = new URL(req.url, 'http://waddle.local').searchParams.get('url') || '';
        const u = new URL(q);
        if (u.protocol === 'http:' || u.protocol === 'https:') target = u;
      } catch {
        /* no selected page */
      }
      const cookies = target
        ? sess.jar.match(target, false).map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expires: c.expires || 0,
            value: c.httpOnly ? '' : c.value,
          }))
        : [];
      return json(res, 200, { requests: (sess.inspect || []).slice(0, 150), cookies });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
    let body;
    try {
      body = await readJson(req, name === 'backup' ? 10 << 20 : 1 << 20);
    } catch (e) {
      if (e && e.code === 'ETOOBIG') {
        res.setHeader('Connection', 'close');
        return json(res, 413, { error: 'too large' });
      }
      return json(res, 400, { error: 'bad json' });
    }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad json' });

    if (name === 'backup') {
      if (
        body.format !== 'waddle-backup' ||
        body.version !== 1 ||
        !body.config ||
        typeof body.config !== 'object' ||
        Array.isArray(body.config)
      )
        return json(res, 400, { error: 'unsupported or invalid backup' });
      try {
        config.replace(body.config);
      } catch {
        return json(res, 400, { error: 'invalid configuration' });
      }
      return json(res, 200, state(sess, req));
    }
    if (name === 'config') {
      if (body.reset === true) config.reset();
      else config.patch(body);
      return json(res, 200, state(sess, req));
    }
    if (name === 'pool') {
      const out = {};
      switch (body.action) {
        case 'harvest':
          pool.harvest(true).catch(() => {}); // asked for by hand: also retry the sources that are resting
          break;
        case 'rotate':
          pool.rotate(body.site ? siteOf(String(body.site)) : undefined);
          break;
        case 'clear':
          pool.clear();
          pool.harvest(true).catch(() => {});
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
      return json(res, 200, Object.assign(out, state(sess, req)));
    }
    if (name === 'dns') {
      if (body.action === 'flush') {
        resolver.flush();
        return json(res, 200, state(sess, req));
      }
      if (body.action === 'refresh') {
        resolver.refresh(true).catch(() => {});
        return json(res, 200, state(sess, req));
      }
      if (body.action === 'test') {
        const host = String(body.host || 'example.com')
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/[/:].*$/, '');
        if (!/^[a-z0-9.-]{1,253}$/.test(host)) return json(res, 400, { error: 'bad host' });
        // The question travels the way a visit to that site would: through its exit, never directly.
        const via = pool.route(siteOf(host), null, {});
        return json(res, 200, Object.assign({ host, results: await resolver.test(host, via), via: pool.describe(via) }, state(sess, req)));
      }
      return json(res, 400, { error: 'unknown action' });
    }
    if (name === 'cookies') {
      sess.jar.clear();
      return json(res, 200, state(sess, req));
    }
    if (name === 'identity') {
      // New identity: cookies, fingerprint, exits and chains, remembered choices, cached lookups. All of it starts over.
      renew(sess);
      pool.forget();
      resolver.flush();
      return json(res, 200, state(sess, req));
    }
    if (name === 'plain') {
      // "Continue without HTTPS" for one host, for this session only.
      const host = String(body.host || '')
        .trim()
        .toLowerCase();
      if (!/^[a-z0-9.-]{1,253}$/.test(host)) return json(res, 400, { error: 'bad host' });
      if (body.on === false) sess.plain.delete(host);
      else {
        sess.plain.add(host);
        if (sess.plain.size > 200) sess.plain.delete(sess.plain.values().next().value);
      }
      return json(res, 200, state(sess, req));
    }
    return json(res, 404, { error: 'not found' });
  }

  const refuse = (res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Waddle': '1' });
    res.end('Cross-site requests are not served.');
  };

  async function route(req, res) {
    const url = req.url;
    // Every answer says it is Waddle's. One that does not was put there by something in between.
    res.setHeader('X-Waddle', '1');
    settle(req);
    if (url === '/-/ping') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    } // health checks need no password
    const pathOnly = url.split('?')[0];
    if (!PUBLIC_ROUTES.has(pathOnly) && !allowed(req)) {
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
        // A document embedded in another site's page is a third party there, and is treated like one.
        const may = !!ref && proxy.cookiesAllowed(ref, proxy.ownerOf(sess, ref));
        if (req.method === 'POST') {
          const line = await readText(req);
          if (may && line) sess.jar.set(line, ref, true);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(may ? sess.jar.visible(ref) : '');
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
    if (pathname === '/tour' || pathname === '/tour/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      return sendAsset(req, res, 'tour.html', { 'Referrer-Policy': 'no-referrer' });
    }
    if (pathname === '/download') {
      res.writeHead(302, { Location: '/tour#self-host', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (pathname === '/install.sh' || pathname === '/install.ps1') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
      }
      const filename = pathname.slice(1);
      return sendAsset(req, res, filename, { 'Content-Disposition': 'attachment; filename="' + filename + '"' });
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
      if (!res.headersSent) proxy.errorPage(req, res, { status: 500, title: 'Something broke', detail: e && e.message });
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
          // Keep the list of public resolvers current: looked at once a minute, refreshed when it is due.
          chores = setInterval(() => {
            if (resolver.due()) resolver.refresh().catch(() => {});
          }, 60000);
          chores.unref();
          const first = setTimeout(() => {
            if (resolver.due()) resolver.refresh().catch(() => {});
          }, 15000);
          first.unref();
          resolve(server.address());
        });
      });
    },
    close() {
      pool.stop();
      clearInterval(chores);
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy(); // includes upgraded (WebSocket) connections, which close() would wait on forever
        net.dropAgents();
      });
    },
  };
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    opener.once('error', () => console.log('Open ' + url + ' in your browser.'));
    opener.unref();
  } catch {
    console.log('Open ' + url + ' in your browser.');
  }
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
      const url = 'http://' + name + ':' + a.port;
      console.log('Waddle is up on ' + url + (everywhere ? ' (all network interfaces)' : ''));
      if (process.env.WADDLE_OPEN_BROWSER === '1') openBrowser(url);
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
