'use strict';
// Outbound networking: direct or through an HTTP-CONNECT / SOCKS4 / SOCKS5 proxy.
// Hand-rolled so the whole thing stays dependency-free.

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const dns = require('dns');

const ALLOW_PRIVATE = process.env.WADDLE_ALLOW_PRIVATE === '1';

// Trust the OS certificate store as well as Node's bundled roots (needed behind
// TLS-inspecting networks, harmless elsewhere). Opt out with WADDLE_SYSTEM_CA=0.
(function useSystemCa() {
  if (process.env.WADDLE_SYSTEM_CA === '0') return;
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const all = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
    tls.setDefaultCACertificates([...all]);
  } catch {
    /* older Node: start with --use-system-ca or NODE_EXTRA_CA_CERTS instead */
  }
})();

function err(message, code, phase) {
  const e = new Error(message);
  if (code) e.code = code;
  if (phase) e.phase = phase;
  return e;
}

/** The 16 bytes of an IPv6 address in any of its spellings (::, embedded dotted quad, zone id). */
function v6bytes(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const quad = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (quad) s = quad[1] + ((+quad[2] << 8) | +quad[3]).toString(16) + ':' + ((+quad[4] << 8) | +quad[5]).toString(16);
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [],
    t = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16) & 0xffff, i * 2));
  return out;
}

/** True for loopback, private, link-local and other non-public addresses. */
function isPrivateAddr(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19))
    );
  }
  if (v === 6) {
    // Work on the bytes: "::ffff:127.0.0.1" is also spelled "::ffff:7f00:1".
    const b = v6bytes(ip);
    const zero = (from, to) => {
      for (let i = from; i < to; i++) if (b[i]) return false;
      return true;
    };
    const v4 = (i) => b[i] + '.' + b[i + 1] + '.' + b[i + 2] + '.' + b[i + 3];
    if (zero(0, 15) && b[15] <= 1) return true; // :: and ::1
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddr(v4(12)); // IPv4-mapped
    if (zero(0, 12)) return isPrivateAddr(v4(12)); // IPv4-compatible (deprecated)
    if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPrivateAddr(v4(12)); // NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddr(v4(2)); // 6to4
    if ((b[0] & 0xfe) === 0xfc) return true; // unique local fc00::/7
    if (b[0] === 0xfe && (b[1] & 0x80) === 0x80) return true; // link-local + site-local fe80::/9
    return b[0] === 0xff; // multicast
  }
  return false;
}

let resolver = null;
/** Plug in a resolver ({ lookup, resolve4, localForProxy }); null = the system's. */
function setResolver(r) {
  resolver = r;
}

// Addresses that just failed for a name are tried last for a while, so a host that has one dead
// or blocked address among several keeps working.
const SOUR_MS = 10 * 60000;
const sour = new Map(); // "name address" -> when it may be trusted again
function isSour(name, address) {
  const until = sour.get(name + ' ' + address);
  if (!until) return false;
  if (until > Date.now()) return true;
  sour.delete(name + ' ' + address);
  return false;
}
function markSour(name, address) {
  if (sour.size >= 2000) sour.clear();
  sour.set(name + ' ' + address, Date.now() + SOUR_MS);
}

/**
 * Wrap a resolver as a dns.lookup-style function that refuses internal addresses (blocks SSRF and
 * DNS rebinding) and puts addresses that recently failed last. `note(count)` is told how many
 * addresses the name has.
 */
const guarded = (look, note) =>
  function lookup(hostname, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    look(hostname, Object.assign({}, options, { all: true }), (e, found) => {
      if (e) return cb(e);
      let list = Array.isArray(found) ? found : [{ address: found, family: net.isIP(found) }];
      if (!list.length) return cb(Object.assign(new Error('getaddrinfo ENOTFOUND ' + hostname), { code: 'ENOTFOUND' }));
      if (!ALLOW_PRIVATE && list.some((a) => isPrivateAddr(a.address))) return cb(err('private address blocked: ' + hostname, 'EPRIVATE'));
      const fine = list.filter((a) => !isSour(hostname, a.address));
      if (fine.length && fine.length < list.length) list = fine.concat(list.filter((a) => !fine.includes(a)));
      if (note) note(list.length);
      if (options && options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };

const viaResolver = (h, o, cb) => (resolver ? resolver.lookup(h, o, cb) : dns.lookup(h, o, cb));
const viaSystem = (h, o, cb) => dns.lookup(h, o, cb);
/** Name lookup through the plugged-in resolver. */
const safeLookup = guarded(viaResolver);
/** Same, but always the system resolver (used to reach the DoH servers themselves). */
const systemLookup = guarded(viaSystem);

function resolve4(host) {
  if (resolver) return resolver.resolve4(host);
  return new Promise((resolve, reject) => dns.lookup(host, { family: 4 }, (e, a) => (e ? reject(e) : resolve(a))));
}

function assertPublicHost(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (ALLOW_PRIVATE) return;
  if (net.isIP(bare) ? isPrivateAddr(bare) : /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(bare)) {
    throw err('private address blocked: ' + host, 'EPRIVATE');
  }
}

// ---- tunnels ---------------------------------------------------------------

/** Buffered reads on a raw socket during a proxy handshake. */
function reader(sock) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let failure = null;
  const pump = () => {
    if (!waiting) return;
    if (waiting.ready(buf)) {
      const w = waiting;
      waiting = null;
      w.resolve();
    } else if (failure) {
      const w = waiting;
      waiting = null;
      w.reject(failure);
    }
  };
  // Paused-mode reads ('readable' + read()), the stream docs' recipe for parsing a header and
  // then handing the stream on: once the listener is gone the socket is back in its initial
  // state, so whoever takes over (the HTTP client, TLS, the next hop's handshake) just works.
  const onReadable = () => {
    let d;
    while ((d = sock.read()) !== null) buf = buf.length ? Buffer.concat([buf, d]) : d;
    pump();
  };
  const onError = (e) => {
    failure = failure || e;
    pump();
  };
  const onClose = () => {
    failure = failure || err('proxy closed the connection', 'EPROXYCLOSED');
    pump();
  };
  sock.on('readable', onReadable);
  sock.on('error', onError);
  sock.on('close', onClose);
  const wait = (ready) =>
    new Promise((resolve, reject) => {
      waiting = { ready, resolve, reject };
      pump();
    });
  return {
    async bytes(n) {
      await wait((b) => b.length >= n);
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    async until(marker, max) {
      await wait((b) => b.indexOf(marker) >= 0 || b.length > max);
      const i = buf.indexOf(marker);
      if (i < 0) throw err('proxy sent an oversized reply', 'EPROXYBAD');
      const out = buf.subarray(0, i + marker.length);
      buf = buf.subarray(i + marker.length);
      return out;
    },
    release() {
      sock.off('readable', onReadable);
      sock.off('error', onError);
      sock.off('close', onClose);
      if (buf.length) sock.unshift(buf); // anything read past the handshake belongs to the next reader
    },
  };
}

function tcp(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.setNoDelay(true);
    s.once('connect', () => {
      s.off('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });
}

async function viaHttp(sock, proxy, host, port) {
  const r = reader(sock);
  const target = (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
  let head = 'CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\nProxy-Connection: Keep-Alive\r\n';
  if (proxy.user) head += 'Proxy-Authorization: Basic ' + Buffer.from(proxy.user + ':' + (proxy.pass || '')).toString('base64') + '\r\n';
  sock.write(head + '\r\n');
  const reply = (await r.until(Buffer.from('\r\n\r\n'), 16384)).toString('latin1');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(reply);
  if (!m) throw err('not an HTTP proxy', 'EPROXYBAD');
  if (m[1] !== '200') throw err('proxy refused CONNECT (' + m[1] + ')', 'EPROXYREFUSED');
  r.release();
}

async function viaSocks5(sock, proxy, host, port) {
  const r = reader(sock);
  sock.write(proxy.user ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  const hello = await r.bytes(2);
  if (hello[0] !== 5) throw err('not a SOCKS5 proxy', 'EPROXYBAD');
  if (hello[1] === 2 && proxy.user) {
    const u = Buffer.from(proxy.user),
      p = Buffer.from(proxy.pass || '');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await r.bytes(2);
    if (auth[1] !== 0) throw err('SOCKS5 auth rejected', 'EPROXYREFUSED');
  } else if (hello[1] !== 0) {
    throw err('SOCKS5 proxy wants auth', 'EPROXYREFUSED');
  }
  // Always send the hostname so DNS resolves at the exit, never locally.
  const v = net.isIP(host);
  let addr;
  if (v === 4) addr = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (v === 6) addr = Buffer.concat([Buffer.from([4]), ip6Bytes(host)]);
  else {
    const h = Buffer.from(host);
    addr = Buffer.concat([Buffer.from([3, h.length]), h]);
  }
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  const rep = await r.bytes(4);
  if (rep[0] !== 5) throw err('bad SOCKS5 reply', 'EPROXYBAD');
  if (rep[1] !== 0) throw err('SOCKS5 connect failed (' + rep[1] + ')', 'EPROXYREFUSED');
  if (rep[3] === 1) await r.bytes(6);
  else if (rep[3] === 4) await r.bytes(18);
  else if (rep[3] === 3) await r.bytes((await r.bytes(1))[0] + 2);
  else throw err('bad SOCKS5 reply', 'EPROXYBAD');
  r.release();
}

function ip6Bytes(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [],
    t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

async function viaSocks4(sock, proxy, host, port) {
  const r = reader(sock);
  let ip = host;
  if (net.isIP(host) !== 4) {
    // SOCKS4 has no remote DNS; resolve here (4a is too rarely supported to rely on).
    ip = await resolve4(host);
  }
  sock.write(Buffer.from([4, 1, port >> 8, port & 255, ...ip.split('.').map(Number), 0]));
  const rep = await r.bytes(8);
  if (rep[0] !== 0 || rep[1] !== 0x5a) throw err('SOCKS4 connect failed (' + rep[1] + ')', rep[0] === 0 ? 'EPROXYREFUSED' : 'EPROXYBAD');
  r.release();
}

const HANDSHAKE = { http: viaHttp, socks5: viaSocks5, socks4: viaSocks4 };

/** Entry-to-exit list of hops for a proxy that may carry earlier hops in `via`. */
const chainOf = (proxy) => (proxy.via && proxy.via.length ? proxy.via.concat(proxy) : [proxy]);
const addrOf = (p) => p.proto + '://' + p.host + ':' + p.port;

/**
 * Open a raw TCP tunnel to host:port through `proxy` (and, before it, every hop in
 * `proxy.via`: entry -> … -> exit -> target), optionally upgrading to TLS.
 * Everything that goes wrong in here is a proxy's fault (phase = 'proxy'); `culprit`
 * names the hop that failed.
 */
async function tunnel(proxy, host, port, { secure = false, timeout = 8000, alpn = ['http/1.1'] } = {}) {
  const chain = chainOf(proxy);
  for (const p of chain) if (!HANDSHAKE[p.proto]) throw err('unsupported proxy type ' + p.proto, 'EPROXYBAD', 'proxy');
  let sock = null;
  let timedOut = false;
  let hop = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    if (sock) sock.destroy();
  }, timeout * chain.length);
  try {
    sock = await tcp(chain[0].host, chain[0].port);
    if (timedOut) {
      sock.destroy();
      throw err('proxy timed out', 'EPROXYTIMEOUT');
    }
    for (; hop < chain.length; hop++) {
      const next = chain[hop + 1];
      let h = next ? next.host : host;
      if (!next && resolver && resolver.localForProxy() && !net.isIP(h)) h = await resolver.resolve4(h);
      await HANDSHAKE[chain[hop].proto](sock, chain[hop], h, next ? next.port : port);
    }
    hop = chain.length - 1;
    if (!secure) return sock;
    const raw = sock;
    sock = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, ALPNProtocols: alpn });
      t.once('secureConnect', () => {
        t.off('error', reject);
        resolve(t);
      });
      t.once('error', reject);
      raw.once('close', () => reject(err('proxy closed the connection', 'EPROXYCLOSED')));
    });
    return sock;
  } catch (e) {
    if (sock) sock.destroy();
    const out = timedOut ? err('proxy timed out', 'EPROXYTIMEOUT') : e;
    out.phase = 'proxy';
    out.culprit = chain[Math.min(hop, chain.length - 1)];
    throw out;
  } finally {
    clearTimeout(timer);
  }
}

// ---- agents ----------------------------------------------------------------

const directHttp = new http.Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 16, timeout: 60000 });
const directHttps = new https.Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 16, timeout: 60000, ALPNProtocols: ['http/1.1'] });

/** Keep-alive agent whose sockets are tunnels through one proxy. */
class TunnelAgent extends http.Agent {
  constructor(proxy, secure, timeout) {
    super({ keepAlive: true, maxSockets: 12, maxFreeSockets: 4, timeout: 45000 });
    this.proxy = proxy;
    this.secure = secure;
    this.connectTimeout = timeout;
    this.used = Date.now();
  }
  createConnection(options, cb) {
    tunnel(this.proxy, options.host, options.port, { secure: this.secure, timeout: this.connectTimeout }).then((s) => cb(null, s), cb);
  }
}

const agents = new Map(); // "hop>hop>exit|tls" -> agent
function agentFor(proxy, kind, timeout) {
  const key = chainOf(proxy).map(addrOf).join('>') + '|' + kind;
  let a = agents.get(key);
  if (!a) {
    a =
      kind === 'fwd'
        ? Object.assign(new http.Agent({ keepAlive: true, maxSockets: 12, maxFreeSockets: 4, timeout: 45000 }), { used: 0 })
        : new TunnelAgent(proxy, kind === 'tls', timeout);
    agents.set(key, a);
    if (agents.size > 400) {
      // drop the stalest third
      [...agents.entries()]
        .sort((x, y) => x[1].used - y[1].used)
        .slice(0, 130)
        .forEach(([k, v]) => {
          v.destroy();
          agents.delete(k);
        });
    }
  }
  a.used = Date.now();
  return a;
}

/** Close every pooled connection that passes through `proxy` (as any hop); all of them when called bare. */
function dropAgents(proxy) {
  const addr = proxy ? addrOf(proxy) : null;
  for (const [k, v] of agents) {
    if (!addr || k.slice(0, k.lastIndexOf('|')).split('>').includes(addr)) {
      v.destroy();
      agents.delete(k);
    }
  }
  if (!addr) {
    directHttp.destroy();
    directHttps.destroy();
  }
}

// ---- requests --------------------------------------------------------------

/**
 * One HTTP exchange. Resolves with the response stream once headers arrive.
 * @param {object} o
 * @param {URL} o.url
 * @param {string} [o.method]
 * @param {object} [o.headers]
 * @param {Buffer|null} [o.body]
 * @param {object|null} [o.proxy] {proto,host,port,user?,pass?}; null = direct
 * @param {number} [o.timeout] ms to first byte
 * @param {number} [o.connectTimeout]
 * @param {boolean} [o.fresh] skip pooled sockets (used by the checker)
 * @param {boolean} [o.system] resolve with the system resolver even when another one is plugged in
 */
function request(o) {
  return exchange(o, false, false);
}

/** Close the idle kept-alive connections an agent holds to one host: if one went stale, so did its siblings. */
function dropIdle(agent, host, port) {
  if (!agent || !agent.freeSockets) return;
  const prefix = host + ':' + port + ':';
  for (const name of Object.keys(agent.freeSockets)) {
    if (name.startsWith(prefix)) for (const s of [...agent.freeSockets[name]]) s.destroy();
  }
}

function exchange(o, again, moved) {
  return new Promise((resolve, reject) => {
    const url = o.url;
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port) || (secure ? 443 : 80);
    const headers = Object.assign({}, o.headers);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) headers.Host = url.host;
    const opt = { method: o.method || 'GET', headers, setHost: false };
    const proxy = o.proxy || null;
    let lib = http;
    let addresses = 1; // how many addresses the name has (direct connections)

    try {
      if (!proxy) {
        assertPublicHost(host);
        lib = secure ? https : http;
        Object.assign(opt, { host, port, path: url.pathname + url.search });
        opt.lookup = guarded(o.system ? viaSystem : viaResolver, (n) => {
          addresses = n;
        });
        opt.agent = o.fresh ? false : secure ? directHttps : directHttp;
        if (secure) {
          opt.servername = net.isIP(host) ? undefined : host;
          opt.ALPNProtocols = ['http/1.1'];
        }
      } else if (proxy.proto === 'http' && !secure && !o.upgrade && !(proxy.via && proxy.via.length)) {
        // Plain HTTP through an HTTP proxy: classic absolute-URI forwarding.
        Object.assign(opt, { host: proxy.host, port: proxy.port, path: url.href.replace(/#.*$/, '') });
        headers['Proxy-Connection'] = 'Keep-Alive';
        if (proxy.user) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.user + ':' + (proxy.pass || '')).toString('base64');
        opt.agent = o.fresh ? false : agentFor(proxy, 'fwd');
      } else {
        Object.assign(opt, { host, port, path: url.pathname + url.search });
        if (o.fresh) {
          opt.createConnection = (_o, cb) => {
            tunnel(proxy, host, port, { secure, timeout: o.connectTimeout || 8000 }).then((s) => cb(null, s), cb);
          };
        } else {
          opt.agent = agentFor(proxy, secure ? 'tls' : 'raw', o.connectTimeout || 8000);
        }
      }
    } catch (e) {
      return reject(e);
    }

    let settled = false;
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(v);
      }
    };
    const req = lib.request(opt);
    const timer = setTimeout(() => {
      req.destroy(err((proxy ? 'proxy' : 'upstream') + ' timed out', proxy ? 'EPROXYTIMEOUT' : 'ETIMEDOUT', proxy ? 'proxy' : 'target'));
    }, o.timeout || 20000);
    let sent = false;
    req.on('finish', () => {
      sent = true;
    });
    let peer = ''; // the address a new direct connection reached
    if (!proxy)
      req.on('socket', (sock) => {
        if (sock.connecting) sock.once('connect', () => (peer = sock.remoteAddress || ''));
      });
    req.on('response', (res) => done(resolve, res));
    req.on('timeout', () => req.destroy(err('connection went idle', 'ETIMEDOUT')));
    req.on('upgrade', (res, socket, head) => {
      res.upgrade = { socket, head };
      done(resolve, res);
    });
    req.on('error', (e) => {
      // A kept-alive connection can be closed at the far end (or dropped by something in between)
      // while it sits idle, and the first sign is a reset on the next request. The request was never
      // looked at, so it is repeated once on a new connection, as browsers do.
      const stale = req.reusedSocket && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || /socket hang up/i.test(e.message || ''));
      if (stale && !again && !settled) {
        settled = true;
        clearTimeout(timer);
        dropIdle(opt.agent, opt.host, opt.port);
        exchange(o, true, moved).then(resolve, reject);
        return;
      }
      // Connected, then cut off before a single byte of the request went out: that address is
      // dead or blocked on this network. Remember it, and try the name's next address once.
      if (
        peer &&
        !sent &&
        !settled &&
        (e.code === 'ECONNRESET' || e.code === 'EPIPE' || /socket hang up|before secure TLS/i.test(e.message || ''))
      ) {
        markSour(host, peer);
        if (addresses > 1 && !moved) {
          settled = true;
          clearTimeout(timer);
          exchange(o, again, true).then(resolve, reject);
          return;
        }
      }
      if (!e.phase) e.phase = proxy ? 'proxy' : 'target';
      if (proxy && !e.culprit) e.culprit = proxy;
      e.sent = sent; // false: the target never saw this request, so repeating it is safe
      done(reject, e);
    });
    if (o.body && o.body.length) req.end(o.body);
    else req.end();
  });
}

/** Read a response body fully, with a size cap. */
function readAll(res, max = 8 << 20) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    res.on('data', (d) => {
      size += d.length;
      if (size > max) {
        reject(err('response too large', 'ETOOBIG'));
        res.destroy();
        return;
      } // reject first: destroy() emits 'aborted'
      parts.push(d);
    });
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', reject);
    res.on('aborted', () => reject(err('response aborted', 'ECONNRESET')));
    res.on('close', () => reject(err('response cut short', 'ECONNRESET'))); // no-op once resolved
  });
}

/** Short, human wording for a network failure. */
function explain(e) {
  const code = (e && e.code) || '';
  const msg = (e && e.message) || String(e);
  if (code === 'EPRIVATE') return 'private address blocked';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'no such host';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ETIMEDOUT' || code === 'EPROXYTIMEOUT' || /timed out/i.test(msg)) return 'timed out';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  if (/^(CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS_CERT)/.test(code) || /certificate/i.test(msg)) return 'bad certificate';
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up|disconnected before secure|closed the connection|aborted/i.test(msg))
    return 'connection reset';
  if (code === 'ETOOBIG') return 'too large';
  return msg.length > 80 ? msg.slice(0, 80) : msg;
}

module.exports = {
  request,
  readAll,
  tunnel,
  dropAgents,
  isPrivateAddr,
  safeLookup,
  systemLookup,
  setResolver,
  assertPublicHost,
  explain,
  chainOf,
  ALLOW_PRIVATE,
};
