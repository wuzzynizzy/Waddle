'use strict';
// Name lookups: DNS-over-HTTPS (RFC 8484 wire format) through a stack of resolvers, with a cache,
// health tracking, padded questions, and a list of public resolvers that keeps itself up to date.
//
// Two kinds of lookup, kept apart on purpose:
//   - a visited site: the question travels through a proxy route (`via`) or is not asked at all.
//     Neither the resolver nor this machine's own DNS ever sees who wants that name.
//   - housekeeping (the hosts proxy lists and resolvers live on): asked directly, with the
//     system resolver as an optional last resort.

const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { request, readAll, explain } = require('./net');
const { siteOf } = require('./cookies');
const { DATA_DIR, DNS_BOOTSTRAP, hash32 } = require('./config');

const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_OPT = 41;
const PAD_BLOCK = 128; // RFC 8467: pad questions to a multiple of 128 bytes
const STATE_FILE = path.join(DATA_DIR, 'dns.json');
const PROBE_NAME = 'example.com';

/** Build a DNS query message. With `pad`, an EDNS(0) padding option brings it to a fixed size. */
function encodeQuery(name, type, pad) {
  const parts = [Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, pad ? 1 : 0])]; // id 0, RD, one question
  let size = 12;
  for (const label of String(name).replace(/\.$/, '').split('.')) {
    const b = Buffer.from(label, 'ascii');
    if (!b.length || b.length > 63) throw new Error('bad host name');
    parts.push(Buffer.from([b.length]), b);
    size += b.length + 1;
  }
  parts.push(Buffer.from([0, 0, type, 0, 1]));
  size += 5;
  if (pad) {
    // OPT pseudo-record: root name, type 41, UDP size 4096, no flags, then option 12 (padding).
    const fixed = 11 + 4;
    const fill = (PAD_BLOCK - ((size + fixed) % PAD_BLOCK)) % PAD_BLOCK;
    const opt = Buffer.alloc(fixed + fill);
    opt.writeUInt16BE(TYPE_OPT, 1);
    opt.writeUInt16BE(4096, 3);
    opt.writeUInt16BE(4 + fill, 9);
    opt.writeUInt16BE(12, 11);
    opt.writeUInt16BE(fill, 13);
    parts.push(opt);
  }
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

// ---- the public resolver list ---------------------------------------------------------------

/**
 * Decode a DNS stamp (https://dnscrypt.info/stamps-specifications). Only DNS-over-HTTPS stamps
 * are of use here. @returns {{url, address, dnssec, nolog, nofilter}|null}
 */
function parseStamp(text) {
  const m = /^sdns:\/\/([A-Za-z0-9_-]+)$/.exec(String(text || '').trim());
  if (!m) return null;
  try {
    const b = Buffer.from(m[1], 'base64url');
    if (b[0] !== 0x02) return null;
    const props = b.readUInt32LE(1);
    let o = 9;
    const lp = () => {
      const n = b.readUInt8(o++);
      if (o + n > b.length) throw new RangeError('truncated stamp');
      const v = b.subarray(o, o + n);
      o += n;
      return v;
    };
    let address = lp().toString('latin1');
    for (;;) {
      // certificate hashes: a list whose items say whether another follows
      const n = b.readUInt8(o++);
      o += n & 0x7f;
      if (!(n & 0x80)) break;
    }
    const host = lp().toString('latin1');
    const pathname = lp().toString('latin1') || '/dns-query';
    if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) || !/^\/[\x21-\x7e]*$/.test(pathname)) return null;
    let port = '';
    const withPort = /^(.*?)(?::(\d{1,5}))?$/.exec(address);
    if (withPort && withPort[2]) {
      address = withPort[1];
      port = withPort[2];
    }
    address = address.replace(/^\[|\]$/g, '');
    if (address && !net.isIP(address)) address = '';
    const hostPort = /:\d+$/.test(host) || !port || port === '443' ? host : host + ':' + port;
    return {
      url: new URL('https://' + hostPort.toLowerCase() + pathname).href,
      address,
      dnssec: !!(props & 1),
      nolog: !!(props & 2),
      nofilter: !!(props & 4),
    };
  } catch {
    return null;
  }
}

const SENDS_SUBNET =
  /\+\s*ecs\b|\becs\s+(?:resolver|enabled|support)|(?:with|sends?|supports?|and)\s+(?:edns\s+)?client[- ]subnet|edns client subnet$/i;
const NO_SUBNET =
  /no\s+(?:edns\s+)?(?:client[- ]subnet|ecs)|without\s+(?:edns\s+)?(?:client[- ]subnet|ecs)|(?:client[- ]subnet|ecs)\s+(?:is\s+)?(?:disabled|stripped|off)/i;

/**
 * Read a resolver list in the DNSCrypt project's format and keep what a private lookup wants:
 * DNS-over-HTTPS, declared as keeping no logs and filtering nothing, reachable over IPv4, and
 * not described as passing the asker's network on to other servers (EDNS Client Subnet).
 * @returns [{ url, address, name, about }]
 */
function parseResolverList(text) {
  const out = [];
  const seen = new Set();
  for (const block of String(text || '')
    .split(/^## /m)
    .slice(1)) {
    const cut = block.indexOf('\n');
    const name = (cut < 0 ? block : block.slice(0, cut)).trim().slice(0, 80);
    const about = block
      .slice(cut < 0 ? block.length : cut)
      .replace(/^sdns:\/\/\S+$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (SENDS_SUBNET.test(about.replace(NO_SUBNET, ''))) continue;
    for (const m of block.matchAll(/^sdns:\/\/\S+$/gm)) {
      const s = parseStamp(m[0]);
      if (!s || !s.nolog || !s.nofilter) continue;
      if (s.address && net.isIP(s.address) !== 4) continue;
      const host = nameOf(s.url).replace(/:\d+$/, '');
      if (net.isIP(host) === 6 || host.startsWith('[')) continue;
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push({ url: s.url, address: s.address, name, about: about.slice(0, 160) });
    }
  }
  return out;
}

/** Who runs a resolver, near enough: its registrable domain, or the network of a bare address. */
function operatorOf(url) {
  const host = nameOf(url).replace(/:\d+$/, '');
  if (net.isIP(host) === 4) return host.split('.').slice(0, 2).join('.');
  return siteOf(host);
}

class Resolver {
  /**
   * @param {object} config
   * @param {object} [opt]
   * @param {(url: string, headers?: object) => Promise<Buffer>} [opt.fetch] how the resolver list is downloaded
   * @param {() => object|null} [opt.route] a proxy route for testing listed resolvers (they are never tested directly)
   * @param {Function} [opt.request] the transport, when it is not the usual one (tests)
   */
  constructor(config, opt = {}) {
    this.config = config;
    this.fetch = opt.fetch || null;
    this.route = opt.route || (() => null);
    this.request = opt.request || request;
    this.cache = new Map(); // host -> { addresses, until, via }
    this.flying = new Map(); // host -> promise
    this.stat = new Map(); // server url -> { ok, fail, streak, ms, downUntil, error, nopad, lies }
    this.turn = 0;
    this.last = null;
    this.systemUsed = 0;
    this.found = []; // tested public resolvers, best first: { url, address, name, ms, at }
    this.feed = { at: 0, listed: 0, tested: 0, error: '', busy: false, retry: 0 };
    this.listed = null; // the public list as last downloaded: { at, items }
    this._load();
  }

  get cfg() {
    return this.config.value.dns;
  }

  /** Every resolver in play, in order: the configured stack, then the tested public ones. */
  servers() {
    const c = this.cfg;
    const list = c.servers.slice();
    if (c.auto) for (const f of this.found.slice(0, c.keep)) if (!list.includes(f.url)) list.push(f.url);
    return list;
  }

  /** The address to connect to for a resolver, when it is known without asking anyone. */
  addressOf(url) {
    const f = this.found.find((x) => x.url === url);
    if (f && f.address) return f.address;
    const host = nameOf(url).replace(/:\d+$/, '');
    return DNS_BOOTSTRAP[host] || '';
  }

  _stat(url) {
    let s = this.stat.get(url);
    if (!s) {
      s = { ok: 0, fail: 0, streak: 0, ms: 0, downUntil: 0, error: '', nopad: false, lies: 0 };
      this.stat.set(url, s);
    }
    return s;
  }

  /**
   * One question to one DoH server.
   * @param {object} [via] proxy route; without one the question goes out directly (housekeeping names only)
   */
  async query(server, host, type, via) {
    const st = this._stat(server);
    const t0 = Date.now();
    const pad = this.cfg.pad && !st.nopad;
    const address = st.nopin ? '' : this.addressOf(server);
    try {
      // Asked directly, a resolver whose address is not known has to be found with the system's
      // DNS; when that is switched off there is no way to reach it.
      if (!via && !address && !this.cfg.fallback && !net.isIP(new URL(server).hostname))
        throw Object.assign(new Error('address unknown (system resolver is off)'), { code: 'EAI_AGAIN' });
      let res;
      try {
        res = await this.request({
          url: new URL(server),
          method: 'POST',
          proxy: via || null,
          infra: !via,
          system: true,
          address,
          timeout: via ? 8000 : 4000,
          headers: { Accept: 'application/dns-message', 'Content-Type': 'application/dns-message' },
          body: encodeQuery(host, type, pad),
        });
      } catch (e) {
        // The address on file may have moved: next time, find it by name.
        if (address && e.phase !== 'proxy' && !st.nopin && (via || this.cfg.fallback)) {
          st.nopin = true;
          return this.query(server, host, type, via);
        }
        throw e;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw Object.assign(new Error('HTTP ' + res.statusCode), { phase: 'target' });
      }
      const msg = decodeAnswer(await readAll(res, 65536));
      if (msg.rcode === 1 && pad) {
        // A server that cannot read the padding option: ask it plainly from now on.
        st.nopad = true;
        return this.query(server, host, type, via);
      }
      st.ok++;
      st.streak = 0;
      st.error = '';
      const ms = Date.now() - t0;
      st.ms = st.ms ? Math.round(st.ms * 0.7 + ms * 0.3) : ms;
      return msg;
    } catch (e) {
      // A proxy that dropped the connection says nothing about the resolver behind it.
      if (!(via && e.phase === 'proxy')) {
        st.fail++;
        st.streak++;
        st.error = explain(e);
        if (st.streak >= 3) st.downUntil = Date.now() + 60000; // stop asking for a minute
      }
      throw e;
    }
  }

  /** A records (AAAA when there are none) from one server. Resolves { addresses, ttl } or throws. */
  async ask(server, host, via) {
    let msg = await this.query(server, host, TYPE_A, via);
    if (msg.rcode === 0 && !msg.answers.length) msg = await this.query(server, host, TYPE_AAAA, via).catch(() => msg);
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
      e.blocked = true;
      throw e;
    }
    return { addresses, ttl: Math.min(...msg.answers.map((a) => a.ttl)), via: nameOf(server) };
  }

  _order(host) {
    const c = this.cfg;
    const now = Date.now();
    let list = this.servers().filter((u) => this._stat(u).downUntil <= now);
    if (list.length < 2) return list;
    let k = 0;
    if (c.strategy === 'rotate') k = this.turn++ % list.length;
    // One resolver per site: no single resolver ever sees the whole of what is visited.
    else if (c.strategy === 'split') k = hash32(siteOf(host)) % list.length;
    return k ? list.slice(k).concat(list.slice(0, k)) : list;
  }

  /** Several resolvers at once; the first usable answer wins, and a firm "no" settles it too. */
  _race(servers, host, via) {
    return Promise.any(
      servers.map((s) =>
        this.ask(s, host, via).catch((e) => {
          if (e.final) return { nx: e };
          throw e;
        })
      )
    ).then(
      (r) => {
        if (r.nx) throw r.nx;
        return r;
      },
      (e) => {
        throw (e.errors && e.errors[0]) || e;
      }
    );
  }

  /**
   * Cross-check: the same question to several resolvers. An address beats a "no": a resolver
   * that blocks or invents a refusal is outvoted by one that answers, and is marked for it.
   */
  async _check(servers, host, via) {
    const got = await Promise.all(
      servers.map((s) =>
        this.ask(s, host, via).then(
          (r) => ({ s, r }),
          (e) => ({ s, e })
        )
      )
    );
    const yes = got.filter((x) => x.r);
    const no = got.filter((x) => x.e && x.e.final);
    if (yes.length) {
      for (const x of no) this._stat(x.s).lies++;
      return Object.assign({}, yes[0].r, { checked: yes.length + no.length, disputed: no.length > 0 });
    }
    if (no.length) throw no[0].e;
    throw got[0].e;
  }

  async _resolve(host, via) {
    const c = this.cfg;
    const servers = this._order(host);
    let failure = null;
    const groups = [];
    if ((c.strategy === 'race' || c.strategy === 'check') && servers.length > 1) {
      groups.push(servers.slice(0, c.parallel));
      for (const s of servers.slice(c.parallel)) groups.push([s]);
    } else for (const s of servers) groups.push([s]);
    for (const group of groups) {
      try {
        if (group.length === 1) return await this.ask(group[0], host, via);
        return c.strategy === 'check' ? await this._check(group, host, via) : await this._race(group, host, via);
      } catch (e) {
        failure = e;
        if (e.final) break;
      }
    }
    if (failure && failure.final) throw failure;
    // The system resolver is for housekeeping names only: a visited site is never handed to it.
    if (!via && c.fallback) {
      const list = await new Promise((resolve, reject) => dns.lookup(host, { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
      this.systemUsed++;
      const v4 = list.filter((a) => a.family === 4);
      return { addresses: (v4.length ? v4 : list).map((a) => a.address), ttl: 60, via: 'system' };
    }
    throw failure || Object.assign(new Error('no DNS server is reachable'), { code: 'EAI_AGAIN' });
  }

  /**
   * @param {string} host
   * @param {object} [opt] { via: proxy route }. With a route the question travels through it;
   *   without one it is a housekeeping lookup and goes out directly.
   * @returns {Promise<{addresses: string[], via: string}>}
   */
  resolve(host, opt = {}) {
    host = String(host).toLowerCase().replace(/\.$/, '');
    if (net.isIP(host)) return Promise.resolve({ addresses: [host], via: 'literal' });
    const hit = this.cache.get(host);
    if (hit && hit.until > Date.now()) return hit.error ? Promise.reject(hit.error) : Promise.resolve(hit);
    // Lookups in flight are shared only with others of the same kind: a housekeeping one may not answer for a site.
    const key = (opt.via ? 'via ' : 'direct ') + host;
    let p = this.flying.get(key);
    if (p) return p;
    const t0 = Date.now();
    p = this._resolve(host, opt.via || null)
      .then(
        (r) => {
          const entry = { addresses: r.addresses, via: r.via, until: Date.now() + Math.min(3600, Math.max(30, r.ttl || 60)) * 1000 };
          this._remember(host, entry);
          this.last = { host, via: r.via, ms: Date.now() - t0, address: r.addresses[0], routed: !!opt.via };
          return entry;
        },
        (e) => {
          if (e.final) this._remember(host, { error: e, until: Date.now() + 30000 });
          this.last = { host, via: '', ms: Date.now() - t0, error: explain(e), routed: !!opt.via };
          throw e;
        }
      )
      .finally(() => this.flying.delete(key));
    this.flying.set(key, p);
    return p;
  }

  _remember(host, entry) {
    this.cache.delete(host);
    this.cache.set(host, entry);
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
  }

  /** One IPv4 address for `host` (see resolve()). */
  async resolve4(host, opt) {
    const r = await this.resolve(host, opt);
    const v4 = r.addresses.find((a) => net.isIP(a) === 4);
    if (!v4) throw Object.assign(new Error('no IPv4 address for ' + host), { code: 'ENOTFOUND', final: true });
    return v4;
  }

  /** Drop-in for dns.lookup, for housekeeping connections (the only ones made without a proxy). */
  lookup(hostname, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    if (net.isIP(hostname)) return dns.lookup(hostname, options, cb);
    if (!this.servers().length) {
      if (this.cfg.fallback) return dns.lookup(hostname, options, cb);
      return cb(Object.assign(new Error('no resolver is set'), { code: 'EAI_AGAIN' }));
    }
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

  /**
   * Ask every resolver in play about `host`, side by side.
   * @param {object} [via] route to ask through; a name someone typed is never asked about directly
   * @returns [{ name, url, ms, address } | { name, url, error }]
   */
  async test(host, via) {
    host = String(host || PROBE_NAME).toLowerCase();
    if (!via) return this.servers().map((url) => ({ name: nameOf(url), url, error: 'no proxy' }));
    return Promise.all(
      this.servers().map(async (url) => {
        const t0 = Date.now();
        try {
          const r = await this.ask(url, host, via);
          return { name: nameOf(url), url, ms: Date.now() - t0, address: r.addresses[0] };
        } catch (e) {
          return { name: nameOf(url), url, error: explain(e) };
        }
      })
    );
  }

  // ---- the list that keeps itself current ---------------------------------------------------

  /** Is it time to look at the public list again? */
  due(now = Date.now()) {
    const c = this.cfg;
    if (!c.auto || !c.keep || this.feed.busy) return false;
    const every = c.refreshHours * 3600000;
    // Until something has been found, try again sooner; while only a proxy is missing, sooner still.
    const wait = this.feed.retry || (this.found.length ? every : Math.min(every, 10 * 60000));
    return now - this.feed.at > wait;
  }

  /** The public list: downloaded when it is due and remembered in between, so waiting for a proxy does not fetch it again. */
  async _listed(force) {
    const c = this.cfg;
    if (!force && this.listed && Date.now() - this.listed.at < c.refreshHours * 3600000) return this.listed.items;
    let error = '';
    for (const url of c.feeds) {
      try {
        const headers = /^https:\/\/api\.github\.com\//.test(url) ? { Accept: 'application/vnd.github.raw' } : {};
        const items = parseResolverList((await this.fetch(url, headers)).toString('utf8'));
        if (items.length) {
          this.listed = { at: Date.now(), items };
          return items;
        }
        error = 'nothing usable in the list';
      } catch (e) {
        error = e.status ? 'HTTP ' + e.status : explain(e);
      }
    }
    throw new Error(error || 'no list');
  }

  /**
   * Download the public resolver list, test what it offers through a proxy route, keep the best.
   * Without a route nothing is tested (listed resolvers are strangers: they are not contacted directly).
   * @param {boolean} [force] asked for by hand: download the list again even if it is recent
   */
  async refresh(force) {
    const c = this.cfg;
    if (this.feed.busy || !this.fetch) return this.found;
    this.feed.busy = true;
    try {
      let listed;
      this.feed.retry = 0;
      try {
        listed = await this._listed(force);
      } catch (e) {
        this.feed.at = Date.now();
        this.feed.error = e.message;
        return this.found;
      }
      this.feed.at = Date.now();
      this.feed.listed = listed.length;
      this.feed.error = '';
      const via = this.route();
      if (!via) {
        this.feed.error = 'waiting for a proxy to test through';
        this.feed.retry = 60000; // look again in a minute
        return this.found;
      }
      // Yesterday's winners first, then a shuffled sample of the rest, at most two per operator.
      const known = new Map(listed.map((x) => [x.url, x]));
      const pool = this.found.filter((f) => known.has(f.url)).map((f) => known.get(f.url));
      const rest = listed.filter((x) => !pool.includes(x)).sort(() => Math.random() - 0.5);
      const perOp = new Map();
      const sample = [];
      for (const x of pool.concat(rest)) {
        const op = operatorOf(x.url);
        const n = perOp.get(op) || 0;
        if (n >= 2 || c.servers.includes(x.url)) continue;
        perOp.set(op, n + 1);
        sample.push(x);
        if (sample.length >= Math.max(24, c.keep * 5)) break;
      }
      const results = [];
      let next = 0;
      const bogus = 'waddle-' + Math.random().toString(36).slice(2, 10) + '.' + PROBE_NAME;
      const worker = async () => {
        while (next < sample.length) {
          const x = sample[next++];
          this.found.some((f) => f.url === x.url) ||
            this.found.push({ url: x.url, address: x.address, name: x.name, ms: 0, at: 0, trial: true });
          const t0 = Date.now();
          try {
            const r = await this.ask(x.url, PROBE_NAME, this.route() || via);
            if (!r.addresses.some((a) => net.isIP(a) && !/^(0\.|127\.|10\.|192\.168\.)/.test(a))) continue;
            const ms = Date.now() - t0;
            // A name that cannot exist must come back as such: a resolver that invents an answer is out.
            const lied = await this.ask(x.url, bogus, this.route() || via).then(
              () => true,
              (e) => !e.final
            );
            if (!lied) results.push({ url: x.url, address: x.address, name: x.name, ms, at: Date.now() });
          } catch {
            /* not this one */
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
      this.feed.tested = sample.length;
      results.sort((a, b) => a.ms - b.ms);
      const kept = [];
      const ops = new Set();
      for (const r of results) {
        const op = operatorOf(r.url);
        if (ops.has(op)) continue; // one per operator among the keepers: a stack of one company's servers is no stack
        ops.add(op);
        kept.push(r);
        if (kept.length >= Math.max(c.keep, 1) * 2) break;
      }
      if (kept.length) this.found = kept;
      else {
        this.found = this.found.filter((f) => !f.trial);
        this.feed.error = 'none of ' + sample.length + ' listed resolvers answered through the proxy';
      }
      this._save();
      return this.found;
    } finally {
      this.found = this.found.filter((f) => !f.trial);
      this.feed.busy = false;
    }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ found: this.found, at: this.feed.at, listed: this.feed.listed }));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch {
      /* best effort */
    }
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      this.found = (j.found || [])
        .filter((f) => f && typeof f.url === 'string' && /^https:\/\//.test(f.url) && (!f.address || net.isIP(f.address)))
        .slice(0, 40)
        .map((f) => ({
          url: f.url,
          address: f.address || '',
          name: String(f.name || '').slice(0, 80),
          ms: Number(f.ms) || 0,
          at: Number(f.at) || 0,
        }));
      this.feed.at = Number(j.at) || 0;
      this.feed.listed = Number(j.listed) || 0;
    } catch {
      /* first run */
    }
  }

  summary() {
    const c = this.cfg;
    const now = Date.now();
    const auto = c.auto ? this.found.slice(0, c.keep).map((f) => f.url) : [];
    return {
      mode: c.mode,
      strategy: c.strategy,
      cached: this.cache.size,
      system: this.systemUsed,
      last: this.last,
      servers: this.servers().map((url) => {
        const s = this._stat(url);
        const f = this.found.find((x) => x.url === url);
        return {
          url,
          name: nameOf(url),
          label: f && auto.includes(url) && !c.servers.includes(url) ? f.name : '',
          auto: auto.includes(url) && !c.servers.includes(url),
          ok: s.ok,
          fail: s.fail,
          ms: s.ms || (f ? f.ms : 0),
          down: s.downUntil > now,
          error: s.streak ? s.error : '',
          lies: s.lies,
        };
      }),
      feed: {
        at: this.feed.at,
        listed: this.feed.listed,
        tested: this.feed.tested,
        kept: auto.length,
        error: this.feed.error,
        busy: this.feed.busy,
      },
    };
  }
}

module.exports = { Resolver, encodeQuery, decodeAnswer, parseStamp, parseResolverList, operatorOf };
