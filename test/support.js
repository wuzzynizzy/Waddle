'use strict';
// Shared test kit: an isolated data directory plus small local stand-ins for everything
// Waddle talks to (web sites, HTTP/SOCKS proxies, a DNS-over-HTTPS server, a judge), so
// the whole suite runs offline. Require this before anything from ../lib.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

process.env.WADDLE_ALLOW_PRIVATE = '1'; // the stand-ins live on 127.0.0.1
process.env.WADDLE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'waddle-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(process.env.WADDLE_DATA, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const servers = new Set();
function listen(server) {
  const sockets = new Set();
  server.accepted = 0; // TCP connections ever accepted: shows whether clients reuse them
  server.on('connection', (s) => {
    server.accepted++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  servers.add(server);
  server.kill = () =>
    new Promise((resolve) => {
      servers.delete(server);
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
/** Stop every stand-in started through this file. */
async function closeAll() {
  await Promise.all([...servers].map((s) => s.kill()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 20) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met within ' + ms + ' ms');
    await sleep(step);
  }
}

/** A web site. `routes` maps a path to (req, res, body, url); every request is recorded in `.hits`. */
async function site(routes = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const url = new URL(req.url, 'http://x');
      hits.push({
        method: req.method,
        url: req.url,
        path: url.pathname,
        headers: req.headers,
        raw: req.rawHeaders,
        body: body.toString('utf8'),
      });
      const h = routes[url.pathname] || routes['*'];
      if (!h) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      if (typeof h === 'function') return h(req, res, body, url);
      res.writeHead(h.status || 200, h.headers || { 'Content-Type': 'text/html' });
      res.end(h.body || '');
    });
  });
  // Tiny RFC 6455 echo server: replies "echo:<text>" to every text frame.
  server.on('upgrade', (req, socket) => {
    hits.push({ method: 'WS', url: req.url, path: req.url, headers: req.headers, raw: req.rawHeaders, body: '' });
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.on('data', (buf) => {
      const len = buf[1] & 127;
      const mask = buf.subarray(2, 6);
      const data = Buffer.from(buf.subarray(6, 6 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if ((buf[0] & 15) === 1) socket.write(Buffer.concat([Buffer.from([0x81, data.length + 5]), Buffer.from('echo:'), data]));
      if ((buf[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    socket.on('error', () => {});
  });
  const port = await listen(server);
  return {
    port,
    host: '127.0.0.1:' + port,
    url: 'http://127.0.0.1:' + port,
    hits,
    routes,
    close: server.kill,
    last: () => hits[hits.length - 1],
  };
}

/** Where a proxy stand-in really connects: `hosts` plays the part of DNS at the exit, `ports` lets each exit reach its own copy of a service (as if it sat in another country). */
function dial(opt, host, port) {
  const mapped = opt.hosts && opt.hosts[host];
  return net.connect({ host: mapped || host, port: (opt.ports && opt.ports[port]) || port });
}

/** HTTP CONNECT proxy. Options: auth 'user:pass', hosts {name: ip}, refuse (status), dead (accept then hang). */
async function httpProxy(opt = {}) {
  const log = [];
  // Plain HTTP is forwarded the classic way: "GET http://host/path" sent to the proxy itself.
  const server = http.createServer((req, res) => {
    log.push(req.method + ' ' + req.url);
    if (opt.dead) return;
    if (opt.refuse) {
      res.writeHead(opt.refuse);
      return res.end();
    }
    if (opt.auth && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(opt.auth).toString('base64')) {
      res.writeHead(407);
      return res.end();
    }
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const headers = Object.assign({}, req.headers);
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    if (opt.via) headers.via = '1.1 mock'; // what a "transparent" proxy adds
    const mapped = opt.hosts && opt.hosts[u.hostname];
    const up = http.request(
      {
        host: mapped || u.hostname,
        port: (opt.ports && opt.ports[u.port]) || u.port || 80,
        path: u.pathname + u.search,
        method: req.method,
        headers,
        agent: false,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    log.push(req.url);
    socket.on('error', () => {});
    if (opt.dead) return;
    if (opt.refuse) return socket.end('HTTP/1.1 ' + opt.refuse + ' No\r\n\r\n');
    if (opt.auth && req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(opt.auth).toString('base64')) {
      return socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    }
    const at = req.url.lastIndexOf(':');
    const up = dial(opt, req.url.slice(0, at).replace(/^\[|\]$/g, ''), Number(req.url.slice(at + 1)));
    let open = false;
    up.on('connect', () => {
      open = true;
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => {
      // Once the tunnel is open its bytes belong to the two ends: a proxy can only hang up.
      if (open) socket.destroy();
      else if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    socket.on('close', () => up.destroy());
  });
  const port = await listen(server);
  return {
    proto: 'http',
    host: '127.0.0.1',
    port,
    log,
    opt,
    /** TCP connections accepted so far. */
    get conns() {
      return server.accepted;
    },
    close: server.kill,
    addr: '127.0.0.1:' + port,
    def: { proto: 'http', host: '127.0.0.1', port },
  };
}

/** SOCKS5 proxy (no-auth or user/pass). `log` records { host, port, byName }. */
async function socks5Proxy(opt = {}) {
  const log = [];
  const server = net.createServer((c) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0) {
          if (buf[0] !== 5) return c.destroy(); // not SOCKS5: real servers hang up
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          if (opt.auth) {
            if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff]));
            c.write(Buffer.from([5, 2]));
            stage = 1;
          } else {
            c.write(Buffer.from([5, 0]));
            stage = 2;
          }
        } else if (stage === 1) {
          if (buf.length < 2) return;
          const ul = buf[1];
          if (buf.length < 3 + ul) return;
          const pl = buf[2 + ul];
          if (buf.length < 3 + ul + pl) return;
          const got = buf.subarray(2, 2 + ul).toString() + ':' + buf.subarray(3 + ul, 3 + ul + pl).toString();
          buf = buf.subarray(3 + ul + pl);
          if (got !== opt.auth) return c.end(Buffer.from([1, 1]));
          c.write(Buffer.from([1, 0]));
          stage = 2;
        } else {
          if (buf.length < 5) return;
          let host;
          let len;
          if (buf[3] === 1) {
            len = 10;
            if (buf.length < len) return;
            host = [...buf.subarray(4, 8)].join('.');
          } else if (buf[3] === 3) {
            len = 7 + buf[4];
            if (buf.length < len) return;
            host = buf.subarray(5, 5 + buf[4]).toString();
          } else {
            len = 22;
            if (buf.length < len) return;
            host = '::1';
          }
          const port = buf.readUInt16BE(len - 2);
          const rest = buf.subarray(len);
          c.off('data', onData);
          log.push({ host, port, byName: buf[3] === 3 });
          if (opt.dead) return;
          if (opt.refuse) return c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          const up = dial(opt, host, port);
          let open = false;
          up.on('connect', () => {
            open = true;
            c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (rest.length) up.write(rest);
            c.pipe(up);
            up.pipe(c);
          });
          up.on('error', () => {
            // Before the tunnel exists a failure is reported in SOCKS terms; after that the stream
            // belongs to the two ends, and all a proxy can do is hang up.
            if (open) c.destroy();
            else if (c.writable) c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          });
          c.on('close', () => up.destroy());
          return;
        }
      }
    };
    c.on('data', onData);
  });
  const port = await listen(server);
  return {
    proto: 'socks5',
    host: '127.0.0.1',
    port,
    log,
    opt,
    /** TCP connections accepted so far. */
    get conns() {
      return server.accepted;
    },
    close: server.kill,
    addr: '127.0.0.1:' + port,
    def: { proto: 'socks5', host: '127.0.0.1', port },
  };
}

/** SOCKS4 proxy. */
async function socks4Proxy(opt = {}) {
  const log = [];
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      if (buf[0] !== 4) return c.destroy(); // an HTTP or SOCKS5 client knocking on a SOCKS4 door
      const end = buf.indexOf(0, 8);
      if (end < 0) return;
      const port = buf.readUInt16BE(2);
      const host = [...buf.subarray(4, 8)].join('.');
      const rest = buf.subarray(end + 1);
      c.off('data', onData);
      log.push({ host, port });
      if (opt.refuse) return c.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
      const up = dial(opt, host, port);
      let open = false;
      up.on('connect', () => {
        open = true;
        c.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
        if (rest.length) up.write(rest);
        c.pipe(up);
        up.pipe(c);
      });
      up.on('error', () => {
        if (open) c.destroy();
        else if (c.writable) c.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
      });
      c.on('close', () => up.destroy());
    };
    c.on('data', onData);
  });
  const port = await listen(server);
  return {
    proto: 'socks4',
    host: '127.0.0.1',
    port,
    log,
    opt,
    /** TCP connections accepted so far. */
    get conns() {
      return server.accepted;
    },
    close: server.kill,
    addr: '127.0.0.1:' + port,
    def: { proto: 'socks4', host: '127.0.0.1', port },
  };
}

/**
 * DNS-over-HTTPS server (RFC 8484 wire format, spoken over plain HTTP here).
 * `hosts` maps a name to a list of IPv4 addresses; unknown names get NXDOMAIN.
 * Options: delay (ms), fail (HTTP status), name.
 */
async function doh(hosts = {}, opt = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      const q = Buffer.concat(parts);
      let off = 12;
      const labels = [];
      while (q[off]) {
        labels.push(q.subarray(off + 1, off + 1 + q[off]).toString());
        off += q[off] + 1;
      }
      const name = labels.join('.');
      const type = q.readUInt16BE(off + 1);
      log.push({ name, type });
      if (opt.delay) await sleep(opt.delay);
      if (opt.fail) {
        res.writeHead(opt.fail);
        return res.end();
      }
      const known = Object.prototype.hasOwnProperty.call(hosts, name);
      const ips = known && type === 1 ? hosts[name] : [];
      const header = Buffer.alloc(12);
      header.writeUInt16BE(0x8180 | (known ? 0 : 3), 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(ips.length, 6);
      const answers = ips.map((ip) =>
        Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4]), Buffer.from(ip.split('.').map(Number))])
      );
      res.writeHead(200, { 'Content-Type': 'application/dns-message' });
      res.end(Buffer.concat([header, q.subarray(12, off + 5), ...answers]));
    });
  });
  const port = await listen(server);
  return { port, url: 'http://127.0.0.1:' + port + '/dns-query', name: '127.0.0.1:' + port, log, opt, hosts, close: server.kill };
}

/** One request to a server on 127.0.0.1. Resolves { status, headers, raw, body (Buffer), text }. */
function get(port, pathname, opt = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opt.headers);
    const body = opt.body == null ? null : Buffer.from(opt.body);
    if (body) headers['Content-Length'] = body.length;
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: opt.method || (body ? 'POST' : 'GET'), headers, agent: false },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(parts);
          if (res.headers['content-encoding'] === 'gzip' && opt.decode !== false) buf = zlib.gunzipSync(buf);
          resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, body: buf, text: buf.toString('utf8') });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body || undefined);
  });
}

/** A browser-ish client for one Waddle app: keeps the session cookie between calls. */
function browser(port) {
  let cookie = '';
  const call = async (pathname, opt = {}) => {
    const headers = Object.assign({}, opt.headers);
    if (cookie) headers.Cookie = cookie;
    const r = await get(port, pathname, Object.assign({}, opt, { headers }));
    for (const line of r.headers['set-cookie'] || []) {
      const m = /^(waddle=[^;]+)/.exec(line);
      if (m) cookie = m[1];
    }
    return r;
  };
  return {
    /** Load a page the way a tab would. */
    page: (url, opt = {}) =>
      call(
        '/~/' + url,
        Object.assign({}, opt, {
          headers: Object.assign({ Accept: 'text/html,*/*', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' }, opt.headers),
        })
      ),
    /** A sub-resource or fetch() made by the page at `from`. */
    fetch: (url, from, opt = {}) =>
      call(
        '/~/' + url,
        Object.assign({}, opt, {
          headers: Object.assign(
            {
              Accept: '*/*',
              'Sec-Fetch-Dest': opt.dest || 'empty',
              'Sec-Fetch-Mode': 'cors',
              Referer: 'http://127.0.0.1:' + port + '/~/' + from,
            },
            opt.headers
          ),
        })
      ),
    api: async (name, body) => {
      const r = await call('/-/api/' + name, {
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : null,
        headers: Object.assign({ 'X-Waddle': '1' }, body ? { 'Content-Type': 'application/json' } : {}),
      });
      return Object.assign(r, { json: JSON.parse(r.text) });
    },
    raw: call,
    get cookie() {
      return cookie;
    },
  };
}

/** A .tar.gz repository snapshot, as GitHub and GitLab serve them. `files` maps path -> text. */
function tarball(top, files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write((top + '/' + name).slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(' ', 148, 156);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** A local port with nothing listening on it (connections are refused at once). */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A judge: tells a proxy checker which address and country it is seen from. */
function judge(ip, cc) {
  return site({ '/trace': { headers: { 'Content-Type': 'text/plain' }, body: 'fl=1\nh=judge\nip=' + ip + '\nts=1\nloc=' + cc + '\n' } });
}

/**
 * A little internet for routing tests: a judge, three working proxies of the three kinds, each
 * in its own "country" (every exit sees its own copy of the judge), one dead address, and a
 * web page that lists them all the way public proxy lists do.
 */
async function world() {
  const main = await judge('198.51.100.1', 'ZZ');
  const mk = async (make, ip, cc) => {
    const j = await judge(ip, cc);
    const p = await make({ ports: { [main.port]: j.port } });
    // map(port, other): through this exit, connections to `port` land on `other` instead: how a
    // site that treats visitors differently by address looks from here.
    return Object.assign(p, {
      cc,
      ip,
      key: p.proto + '://127.0.0.1:' + p.port,
      map: (from, to) => {
        p.opt.ports[from] = to;
      },
    });
  };
  const h = await mk(httpProxy, '203.0.113.10', 'US');
  const s5 = await mk(socks5Proxy, '203.0.113.20', 'DE');
  const s4 = await mk(socks4Proxy, '203.0.113.30', 'JP');
  const dead = await closedPort();
  const text = `http://127.0.0.1:${h.port}\n127.0.0.1:${s5.port}\nsocks4://127.0.0.1:${s4.port}\n127.0.0.1:${dead}\n`;
  const list = await site({ '/list.txt': { headers: { 'Content-Type': 'text/plain' }, body: text } });
  return { main, h, s5, s4, list, dead, all: [h, s5, s4], judgeUrl: main.url + '/trace', listUrl: list.url + '/list.txt' };
}

/** Median of a list of numbers. */
const median = (list) => {
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

module.exports = {
  site,
  httpProxy,
  socks5Proxy,
  socks4Proxy,
  doh,
  judge,
  tarball,
  closedPort,
  world,
  get,
  browser,
  closeAll,
  sleep,
  until,
  median,
  listen,
};
