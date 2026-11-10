'use strict';
// DNS changer: encrypted lookups (DNS-over-HTTPS, RFC 8484 wire format) through a
// stack of resolvers, with a cache, health tracking and an optional system fallback.

const dns = require('dns');
const net = require('net');
const { request, readAll, explain } = require('./net');

const TYPE_A = 1;
const TYPE_AAAA = 28;

/** Build a DNS query message. */
function encodeQuery(name, type) {
  const parts = [Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])]; // id 0, RD, one question
  for (const label of String(name).replace(/\.$/, '').split('.')) {
    const b = Buffer.from(label, 'ascii');
    if (!b.length || b.length > 63) throw new Error('bad host name');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0, 0, type, 0, 1]));
  return Buffer.concat(parts);
}

function skipName(buf, off) {
  for (;;) {
    const len = buf.readUInt8(off);
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += len + 1;
  }
}

/** Parse a DNS response: { rcode, answers: [{ address, ttl }] } (A / AAAA records only). */
function decodeAnswer(buf) {
  const rcode = buf.readUInt16BE(2) & 15;
  const questions = buf.readUInt16BE(4);
  const count = buf.readUInt16BE(6);
  let off = 12;
  for (let i = 0; i < questions; i++) off = skipName(buf, off) + 4;
  const answers = [];
  for (let i = 0; i < count; i++) {
    off = skipName(buf, off);
    const type = buf.readUInt16BE(off);
    const ttl = buf.readUInt32BE(off + 4);
    const len = buf.readUInt16BE(off + 8);
    off += 10;
    if (off + len > buf.length) throw new RangeError('truncated answer');
    if (type === TYPE_A && len === 4) {
      answers.push({ ttl, address: buf[off] + '.' + buf[off + 1] + '.' + buf[off + 2] + '.' + buf[off + 3] });
    } else if (type === TYPE_AAAA && len === 16) {
      const g = [];
      for (let k = 0; k < 16; k += 2) g.push(buf.readUInt16BE(off + k).toString(16));
      answers.push({ ttl, address: g.join(':') });
    }
    off += len;
  }
  return { rcode, answers };
}

const nameOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

class Resolver {
  constructor(config) {
    this.config = config;
    this.cache = new Map(); // host -> { addresses, until, via }
    this.flying = new Map(); // host -> promise
    this.stat = new Map(); // server url -> { ok, fail, streak, ms, downUntil, error }
    this.turn = 0;
    this.last = null;
    this.systemUsed = 0;
  }

  get cfg() {
    return this.config.value.dns;
  }
  active() {
    return this.cfg.mode === 'doh' && this.cfg.servers.length > 0;
  }
  /** Should names be resolved here even when the connection goes through a proxy? */
  localForProxy() {
    return this.active() && !this.cfg.remote;
  }

  _stat(url) {
    let s = this.stat.get(url);
    if (!s) {
      s = { ok: 0, fail: 0, streak: 0, ms: 0, downUntil: 0, error: '' };
      this.stat.set(url, s);
    }
    return s;
  }

  /** One question to one DoH server. */
  async query(server, host, type) {
    const st = this._stat(server);
    const t0 = Date.now();
    try {
      const res = await request({
        url: new URL(server),
        method: 'POST',
        system: true,
        timeout: 4000,
        headers: { Accept: 'application/dns-message', 'Content-Type': 'application/dns-message' },
        body: encodeQuery(host, type),
      });
      if (res.statusCode !== 200) {
        res.resume();
        throw new Error('HTTP ' + res.statusCode);
      }
      const msg = decodeAnswer(await readAll(res, 65536));
      st.ok++;
      st.streak = 0;
      st.error = '';
      const ms = Date.now() - t0;
      st.ms = st.ms ? Math.round(st.ms * 0.7 + ms * 0.3) : ms;
      return msg;
    } catch (e) {
      st.fail++;
      st.streak++;
      st.error = explain(e);
      if (st.streak >= 3) st.downUntil = Date.now() + 60000; // stop asking for a minute
      throw e;
    }
  }

  /** A records (AAAA when there are none) from one server. Resolves { addresses, ttl } or throws. */
  async ask(server, host) {
    let msg = await this.query(server, host, TYPE_A);
    if (msg.rcode === 0 && !msg.answers.length) msg = await this.query(server, host, TYPE_AAAA).catch(() => msg);
    if (msg.rcode === 3 || !msg.answers.length) {
      const e = new Error('no such host');
      e.code = 'ENOTFOUND';
      e.final = msg.rcode === 3 || msg.rcode === 0;
      throw e;
    }
    if (msg.rcode !== 0) throw new Error('resolver error ' + msg.rcode);
    const addresses = msg.answers.map((a) => a.address);
    if (addresses.every((a) => a === '0.0.0.0' || a === '0:0:0:0:0:0:0:0')) {
      const e = new Error('blocked by resolver');
      e.code = 'ENOTFOUND';
      e.final = true;
      throw e;
    }
    return { addresses, ttl: Math.min(...msg.answers.map((a) => a.ttl)), via: nameOf(server) };
  }

  _order() {
    const c = this.cfg;
    const now = Date.now();
    let list = c.servers.filter((u) => this._stat(u).downUntil <= now);
    if (c.strategy === 'rotate' && list.length > 1) {
      const k = this.turn++ % list.length;
      list = list.slice(k).concat(list.slice(0, k));
    }
    return list;
  }

  async _resolve(host) {
    const c = this.cfg;
    const servers = this._order();
    let failure = null;
    if (servers.length) {
      if (c.strategy === 'race') {
        try {
          return await Promise.any(
            servers.map((s) =>
              this.ask(s, host).catch((e) => {
                if (e.final) return { nx: e }; // an authoritative "no" settles the race too
                throw e;
              })
            )
          ).then((r) => {
            if (r.nx) throw r.nx;
            return r;
          });
        } catch (e) {
          failure = e.final ? e : (e.errors && e.errors[0]) || e;
        }
      } else {
        for (const s of servers) {
          try {
            return await this.ask(s, host);
          } catch (e) {
            failure = e;
            if (e.final) break;
          }
        }
      }
    }
    if (failure && failure.final) throw failure;
    if (c.fallback) {
      const list = await new Promise((resolve, reject) => dns.lookup(host, { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
      this.systemUsed++;
      const v4 = list.filter((a) => a.family === 4);
      return { addresses: (v4.length ? v4 : list).map((a) => a.address), ttl: 60, via: 'system' };
    }
    throw failure || Object.assign(new Error('no DNS server is reachable'), { code: 'EAI_AGAIN' });
  }

  /** @returns {Promise<{addresses: string[], via: string}>} */
  resolve(host) {
    host = String(host).toLowerCase().replace(/\.$/, '');
    if (net.isIP(host)) return Promise.resolve({ addresses: [host], via: 'literal' });
    const hit = this.cache.get(host);
    if (hit && hit.until > Date.now()) return hit.error ? Promise.reject(hit.error) : Promise.resolve(hit);
    let p = this.flying.get(host);
    if (p) return p;
    const t0 = Date.now();
    p = this._resolve(host)
      .then(
        (r) => {
          const entry = { addresses: r.addresses, via: r.via, until: Date.now() + Math.min(3600, Math.max(30, r.ttl || 60)) * 1000 };
          this._remember(host, entry);
          this.last = { host, via: r.via, ms: Date.now() - t0, address: r.addresses[0] };
          return entry;
        },
        (e) => {
          if (e.final) this._remember(host, { error: e, until: Date.now() + 30000 });
          this.last = { host, via: '', ms: Date.now() - t0, error: explain(e) };
          throw e;
        }
      )
      .finally(() => this.flying.delete(host));
    this.flying.set(host, p);
    return p;
  }

  _remember(host, entry) {
    this.cache.delete(host);
    this.cache.set(host, entry);
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
  }

  async resolve4(host) {
    if (!this.active()) {
      return new Promise((resolve, reject) => dns.lookup(host, { family: 4 }, (e, a) => (e ? reject(e) : resolve(a))));
    }
    const r = await this.resolve(host);
    const v4 = r.addresses.find((a) => net.isIP(a) === 4);
    if (!v4) throw Object.assign(new Error('no IPv4 address for ' + host), { code: 'ENOTFOUND' });
    return v4;
  }

  /** Drop-in for dns.lookup. */
  lookup(hostname, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    if (!this.active() || net.isIP(hostname)) return dns.lookup(hostname, options, cb);
    this.resolve(hostname).then((r) => {
      const want = options && options.family;
      let list = r.addresses.map((a) => ({ address: a, family: net.isIP(a) }));
      if (want === 4 || want === 6) list = list.filter((a) => a.family === want);
      if (!list.length) return cb(Object.assign(new Error('getaddrinfo ENOTFOUND ' + hostname), { code: 'ENOTFOUND' }));
      if (options && options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    }, cb);
  }

  flush() {
    this.cache.clear();
    for (const s of this.stat.values()) {
      s.downUntil = 0;
      s.streak = 0;
    }
  }

  /** Ask every server in the stack about `host`: [{ name, url, ms, address } | { name, url, error }] */
  async test(host) {
    host = String(host || 'example.com').toLowerCase();
    const jobs = this.cfg.servers.map(async (url) => {
      const t0 = Date.now();
      try {
        const r = await this.ask(url, host);
        return { name: nameOf(url), url, ms: Date.now() - t0, address: r.addresses[0] };
      } catch (e) {
        return { name: nameOf(url), url, error: explain(e) };
      }
    });
    jobs.push(
      new Promise((resolve) => {
        const t0 = Date.now();
        dns.lookup(host, { family: 4 }, (e, a) =>
          resolve(e ? { name: 'system', url: '', error: explain(e) } : { name: 'system', url: '', ms: Date.now() - t0, address: a })
        );
      })
    );
    return Promise.all(jobs);
  }

  summary() {
    const c = this.cfg;
    const now = Date.now();
    return {
      mode: c.mode,
      strategy: c.strategy,
      cached: this.cache.size,
      system: this.systemUsed,
      last: this.last,
      servers: c.servers.map((url) => {
        const s = this._stat(url);
        return { url, name: nameOf(url), ok: s.ok, fail: s.fail, ms: s.ms, down: s.downUntil > now, error: s.streak ? s.error : '' };
      }),
    };
  }
}

module.exports = { Resolver, encodeQuery, decodeAnswer };
