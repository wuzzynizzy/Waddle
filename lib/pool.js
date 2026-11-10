'use strict';
// The proxy pool: finds free proxies (GitHub, GitLab, any URL), proves which ones
// actually work, and hands out working exits with rotation and failover.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TarScanner } = require('./tar');
const { extractProxies, protoFromPath, keyOf } = require('./extract');
const { isIP } = require('net');
const { request, readAll, dropAgents, explain } = require('./net');
const { DATA_DIR, cleanSource } = require('./config');

const STATE_FILE = path.join(DATA_DIR, 'pool.json');
const UA = 'Mozilla/5.0 (compatible; Waddle/1.0)';
const LIST_FILE = /\.(txt|csv|json|list|lst|md)$/i;
const MAX_CANDIDATES = 150000; // memory bound: unchecked addresses kept at any one time
// Repos that look like proxy lists to a search but are not worth a download: stalled
// archives, lists of dead or malformed entries, and collections of Tor bridges.
const DENY = new Set(
  [
    'nikita29a/freeproxylist',
    'ercindedeoglu/proxies',
    'mzyui/proxy-list',
    'rix4uni/fresh-proxy-list',
    'sevenworksdev/proxy-list',
    'gfpcom/free-proxy-list',
    'topchina/proxy-list',
    'crossxx-labs/free-proxy',
    'argh94/proxy-list',
    'delta-kronecker/tor-bridges-collector',
  ].map((r) => 'github:' + r)
);
// Paths that hold other kinds of servers, not HTTP/SOCKS proxies.
const NOT_PROXIES =
  /v2ray|vmess|vless|trojan|shadowsocks|(^|[^a-z])ss(r)?([^a-z]|$)|clash|mtproto|telegram|wireguard|openvpn|hysteria|tuic|sing-?box|bridge|obfs|snowflake|webtunnel|(^|[^a-z])tor([^a-z]|$)|onion|node_modules|package(-lock)?\.json|requirements/i;
const MAX_ARCHIVE = 25 << 20; // compressed bytes per repo snapshot
const MAX_INFLATED = 400 << 20; // and unpacked: a tiny archive must not be able to inflate without end
/** Where repositories live. Overridable for mirrors, GitHub Enterprise or a self-hosted GitLab. */
const trim = (u) => String(u).replace(/\/+$/, '');
const endpoints = {
  githubApi: trim(process.env.WADDLE_GITHUB_API || 'https://api.github.com'),
  githubArchive: trim(process.env.WADDLE_GITHUB_ARCHIVE || 'https://codeload.github.com'),
  gitlab: trim(process.env.WADDLE_GITLAB || 'https://gitlab.com'),
  gitlabGap: 13000, // ms between GitLab archive downloads (its rate limit is about five a minute)
};
const MAX_LIST_FILE = 8 << 20;
const FETCH_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sourceId = (s) => s.type + ':' + (s.repo || s.url);
const newStat = (id, def, extra) =>
  Object.assign({ id, def, count: 0, alive: 0, everAlive: 0, tried: 0, at: 0, error: '', state: 'pending', fails: 0 }, extra);

/** Follow redirects by hand so every hop is validated. */
async function get(url, headers, hops = 4) {
  const res = await request({
    url: new URL(url),
    headers: Object.assign({ 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'gzip' }, headers),
    timeout: FETCH_MS,
  });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
    res.resume();
    return get(new URL(res.headers.location, url).href, headers, hops - 1);
  }
  return res;
}

function httpError(res) {
  res.resume();
  const e = new Error('HTTP ' + res.statusCode);
  e.status = res.statusCode;
  return e;
}

/** Download a repo snapshot and scan every list-looking file in it. Never hangs. */
function scanArchive(url, hint, opt) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let res = null;
    let gunzip = null;
    const found = [];
    const finish = (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (res) res.destroy();
      if (gunzip) gunzip.destroy();
      // A capped or cut-off download still yields whatever was scanned so far.
      if (e && !found.length) reject(e);
      else resolve(found);
    };
    const timer = setTimeout(() => finish(new Error('timed out')), FETCH_MS + 15000);
    get(url, { Accept: 'application/gzip, application/octet-stream' }).then((r) => {
      res = r;
      if (finished) return r.destroy();
      if (r.statusCode !== 200) return finish(httpError(r));
      let bytes = 0;
      gunzip = zlib.createGunzip();
      const tar = new TarScanner({
        want: (p, size) => size > 8 && size <= MAX_LIST_FILE && LIST_FILE.test(p) && !NOT_PROXIES.test(p.slice(p.indexOf('/') + 1)),
        onFile: (p, data) => {
          if (found.length >= opt.max * 3) return;
          const rel = p.slice(p.indexOf('/') + 1);
          const list = extractProxies(data.toString('utf8'), protoFromPath(rel) || hint, {
            allowPrivate: opt.allowPrivate,
            limit: opt.max * 2,
          });
          for (const x of list) found.push(x);
        },
      });
      r.on('data', (d) => {
        bytes += d.length;
        if (bytes > MAX_ARCHIVE) finish();
      });
      r.on('error', finish);
      r.on('aborted', () => finish(new Error('connection dropped')));
      let inflated = 0;
      gunzip.on('data', (d) => {
        inflated += d.length;
        if (inflated > MAX_INFLATED) return finish();
        try {
          tar.write(d);
        } catch (e) {
          finish(e);
        }
      });
      gunzip.on('end', () => finish());
      gunzip.on('error', (e) => finish(found.length ? null : e));
      r.pipe(gunzip);
    }, finish);
  });
}

async function fetchList(url, hint, opt) {
  const res = await get(url, { Accept: 'text/plain, application/json, text/html;q=0.9, */*;q=0.5' });
  if (res.statusCode !== 200) throw httpError(res);
  let body = await readAll(res, MAX_LIST_FILE);
  if (/gzip/i.test(res.headers['content-encoding'] || '')) body = zlib.gunzipSync(body, { maxOutputLength: MAX_LIST_FILE * 4 });
  return extractProxies(body.toString('utf8'), hint || protoFromPath(new URL(url).pathname), {
    allowPrivate: opt.allowPrivate,
    limit: opt.max * 2,
  });
}

function fetchSource(src, opt) {
  if (src.type === 'github') {
    const ref = src.branch ? 'refs/heads/' + src.branch : 'HEAD';
    return scanArchive(endpoints.githubArchive + '/' + src.repo + '/tar.gz/' + ref, protoFromPath(src.repo), opt);
  }
  if (src.type === 'gitlab') {
    const q = src.branch ? '?sha=' + encodeURIComponent(src.branch) : '';
    return scanArchive(
      endpoints.gitlab + '/api/v4/projects/' + encodeURIComponent(src.repo) + '/repository/archive.tar.gz' + q,
      protoFromPath(src.repo),
      opt
    );
  }
  return fetchList(src.url, src.proto, opt);
}

async function getJson(url, headers) {
  const res = await get(url, Object.assign({ Accept: 'application/json' }, headers));
  if (res.statusCode !== 200) throw httpError(res);
  let body = await readAll(res, 4 << 20);
  if (/gzip/i.test(res.headers['content-encoding'] || '')) body = zlib.gunzipSync(body, { maxOutputLength: 16 << 20 });
  return JSON.parse(body.toString('utf8'));
}

class Pool {
  constructor(config) {
    this.config = config;
    this.cand = new Map(); // key -> candidate
    this.alive = new Map(); // key -> candidate currently proven to work
    this.src = new Map(); // source id -> stats
    this.queue = []; // candidates waiting for a first check
    this.sticky = new Map(); // site -> { key, until }
    this.timed = null; // { key, until } for rotate = timed
    this.active = 0;
    this.status = 'starting';
    this.note = '';
    this.checked = 0;
    this.misses = 0; // checks since the last success
    this.pausedUntil = 0;
    this.backoff = 0;
    this.lastHarvest = 0;
    this.harvesting = false;
    this.lastRoute = null;
    this.stopped = false;
    this.rr = 0;
    this._load();
  }

  get cfg() {
    return this.config.value;
  }

  start() {
    this.tick = setInterval(() => this._tick(), 2000);
    this.tick.unref();
    this.saver = setInterval(() => this._save(), 60000);
    this.saver.unref();
    this.config.onChange(() => {
      this._syncSources();
      this._pump();
    });
    this._syncSources();
    this._tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tick);
    clearInterval(this.saver);
    this._save();
  }

  // ---- harvesting ------------------------------------------------------------

  _syncSources() {
    const want = new Map(this.cfg.pool.sources.map((s) => [sourceId(s), s]));
    for (const id of [...this.src.keys()]) {
      if (!want.has(id) && id !== 'manual') {
        this._forget(id);
        this.src.delete(id);
      }
    }
    for (const [id, s] of want) {
      if (!this.src.has(id)) this.src.set(id, newStat(id, s));
      const st = this.src.get(id);
      st.def = s;
      if (!s.on) {
        st.state = 'off';
        this._forget(id);
      } else if (st.state === 'off') st.state = 'pending';
    }
  }

  _forget(id) {
    for (const [key, c] of this.cand) {
      if (c.src !== id || this.alive.has(key)) continue;
      this.cand.delete(key);
    }
    this.queue = this.queue.filter((c) => this.cand.get(c.key) === c);
  }

  _add(list, id, max) {
    const st = this.src.get(id);
    let fresh = 0,
      total = 0;
    const seen = new Set();
    for (const p of list) {
      const key = keyOf(p);
      if (seen.has(key)) continue;
      seen.add(key);
      if (++total > max) break;
      if (this.cand.has(key)) continue;
      if (this.cand.size >= MAX_CANDIDATES) continue;
      // An untyped duplicate of something already known by protocol adds nothing.
      if (!p.proto && ['http', 'socks5', 'socks4'].some((x) => this.cand.has(x + '://' + p.host + ':' + p.port))) continue;
      const c = { key, proto: p.proto, host: p.host, port: p.port, src: id, at: 0, fails: 0 };
      if (p.user) {
        c.user = p.user;
        c.pass = p.pass;
      }
      this.cand.set(key, c);
      this.queue.push(c);
      fresh++;
    }
    if (st) st.count = Math.min(total, max);
    return fresh;
  }

  /** Paste-in proxies from the UI. */
  addManual(text, proto) {
    if (!this.src.has('manual')) this.src.set('manual', newStat('manual', { type: 'manual', on: true }, { at: Date.now(), state: 'ok' }));
    const list = extractProxies(String(text || ''), ['http', 'socks4', 'socks5'].includes(proto) ? proto : null, {
      allowPrivate: process.env.WADDLE_ALLOW_PRIVATE === '1',
    });
    const before = this.src.get('manual').count;
    const fresh = this._add(list, 'manual', 5000);
    this.src.get('manual').count = before + fresh;
    // Hand-picked proxies jump the queue.
    const mine = this.queue.filter((c) => c.src === 'manual');
    this.queue = this.queue.filter((c) => c.src !== 'manual').concat(mine); // best last
    this._resume();
    this._pump();
    return fresh;
  }

  async harvest() {
    if (this.harvesting || this.stopped) return;
    this.harvesting = true;
    this.lastHarvest = Date.now();
    this._syncSources();
    const opt = { max: this.cfg.pool.perSource, allowPrivate: process.env.WADDLE_ALLOW_PRIVATE === '1' };
    try {
      const jobs = [...this.src.values()].filter((s) => s.def && s.def.on && s.id !== 'manual');
      let next = 0,
        gitlabGate = Promise.resolve();
      const run = async () => {
        while (next < jobs.length && !this.stopped) {
          const st = jobs[next++];
          if (st.def.type === 'gitlab') {
            // gitlab.com allows ~5 archive downloads a minute
            const gate = gitlabGate;
            gitlabGate = gate.then(() => sleep(endpoints.gitlabGap));
            await gate;
          }
          st.state = 'loading';
          try {
            const list = await fetchSource(st.def, opt);
            this._add(list, st.id, opt.max);
            st.state = 'ok';
            st.error = '';
            st.fails = 0;
          } catch (e) {
            st.state = 'error';
            st.error = e.status ? 'HTTP ' + e.status : explain(e);
            st.fails++;
          }
          st.at = Date.now();
          this._order();
          this._pump();
        }
      };
      await Promise.all([run(), run(), run(), run()]);
      if (this.cfg.pool.discover && this.cfg.pool.discoverMax > 0)
        await this._discover(opt).catch((e) => {
          this.discoverNote = e.message;
        });
      this._prune();
    } finally {
      this.harvesting = false;
      this._order();
      this._resume();
      this._pump();
      this._save();
    }
  }

  /** Look for list repos nobody configured: GitHub search + GitLab search. */
  async _discover(opt) {
    const known = new Set(this.cfg.pool.sources.map((s) => sourceId(s).toLowerCase()));
    const foundCount = this.cfg.pool.sources.filter((s) => s.found).length;
    let room = this.cfg.pool.discoverMax - foundCount;
    if (room <= 0) {
      this.discoverNote = '';
      return;
    }
    const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const cands = [];
    const notes = [];
    const ghHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (process.env.WADDLE_GITHUB_TOKEN) ghHeaders.Authorization = 'Bearer ' + process.env.WADDLE_GITHUB_TOKEN;
    for (const q of ['proxy-list in:name pushed:>' + since, 'topic:proxy-list pushed:>' + since, 'free-proxy in:name pushed:>' + since]) {
      try {
        const r = await getJson(
          endpoints.githubApi + '/search/repositories?per_page=30&sort=stars&order=desc&q=' + encodeURIComponent(q),
          ghHeaders
        );
        for (const it of r.items || [])
          cands.push({
            type: 'github',
            repo: it.full_name,
            stars: it.stargazers_count || 0,
            text: it.full_name + ' ' + (it.description || ''),
          });
      } catch (e) {
        notes.push(
          'github search: ' + (e.status === 403 || e.status === 429 ? 'rate limited' : e.status ? 'HTTP ' + e.status : explain(e))
        );
        break;
      }
    }
    for (const q of ['proxy-list', 'free-proxy']) {
      try {
        const r = await getJson(
          endpoints.gitlab +
            '/api/v4/projects?simple=true&per_page=20&order_by=last_activity_at&sort=desc&search=' +
            q +
            '&last_activity_after=' +
            new Date(Date.now() - 14 * 864e5).toISOString()
        );
        for (const it of Array.isArray(r) ? r : [])
          cands.push({
            type: 'gitlab',
            repo: it.path_with_namespace,
            branch: it.default_branch,
            stars: it.star_count || 0,
            text: it.path_with_namespace + ' ' + (it.description || ''),
          });
      } catch (e) {
        notes.push('gitlab search: ' + (e.status ? 'HTTP ' + e.status : explain(e)));
        break;
      }
    }
    const seen = new Set();
    const fresh = cands
      .filter((c) => {
        const id = (c.type + ':' + c.repo).toLowerCase();
        if (
          seen.has(id) ||
          known.has(id) ||
          DENY.has(id) ||
          this.rejected.has(id) ||
          NOT_PROXIES.test(c.text) ||
          /pirate|torrent|checker\b|brute|attack/i.test(c.text)
        )
          return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => b.stars - a.stars);
    const added = [];
    let gitlabTries = 0;
    for (const c of fresh) {
      if (room <= 0 || this.stopped) break;
      if (c.type === 'gitlab') {
        if (gitlabTries++ >= 3) continue;
        if (gitlabTries > 1) await sleep(endpoints.gitlabGap);
      }
      const def = cleanSource({ type: c.type, repo: c.repo, branch: c.branch, found: true });
      if (!def) continue;
      const id = sourceId(def);
      try {
        const list = await fetchSource(def, opt);
        if (new Set(list.map(keyOf)).size < 25) {
          this.rejected.add(id.toLowerCase());
          continue;
        }
        this.src.set(id, newStat(id, def, { at: Date.now(), state: 'ok' }));
        this._add(list, id, opt.max);
        added.push(def);
        room--;
      } catch {
        this.rejected.add(id.toLowerCase());
      }
    }
    if (added.length) this.config.patch({ pool: { sources: this.cfg.pool.sources.concat(added) } });
    this.discoverNote = notes.join('; ');
  }

  /** Auto-found sources that keep failing or never produce a live proxy get dropped again. */
  _prune() {
    const drop = new Set();
    for (const st of this.src.values()) {
      if (!st.def || !st.def.found) continue;
      if (st.fails >= 3 || (st.tried >= 600 && st.alive === 0 && st.everAlive === 0)) drop.add(st.id);
    }
    if (!drop.size) return;
    for (const id of drop) this.rejected.add(id.toLowerCase());
    this.config.patch({ pool: { sources: this.cfg.pool.sources.filter((s) => !drop.has(sourceId(s))) } });
  }

  /** Best sources first, interleaved so one giant dump cannot starve the rest. Warm (previously working) ones lead. */
  _order() {
    const yieldOf = (id) => {
      const s = this.src.get(id);
      return s ? ((s.everAlive || 0) + 1) / (s.tried + 20) : 0;
    };
    const groups = new Map();
    const warm = [];
    for (const c of this.queue) {
      if (c.warm) {
        warm.push(c);
        continue;
      }
      if (!groups.has(c.src)) groups.set(c.src, []);
      groups.get(c.src).push(c);
    }
    const lanes = [...groups.entries()]
      .map(([id, list]) => ({ w: id === 'manual' ? 1e9 : yieldOf(id), list, i: 0, credit: 0 }))
      .sort((a, b) => b.w - a.w);
    if (!lanes.length) {
      this.queue = warm.reverse();
      return;
    }
    const top = lanes[0].w || 1;
    const out = warm;
    let left = this.queue.length - warm.length;
    while (left > 0) {
      for (const lane of lanes) {
        if (lane.i >= lane.list.length) continue;
        lane.credit += Math.max(0.05, Math.min(1, lane.w / top)) * 4;
        while (lane.credit >= 1 && lane.i < lane.list.length) {
          out.push(lane.list[lane.i++]);
          lane.credit -= 1;
          left--;
        }
      }
    }
    this.queue = out.reverse(); // stored best-last: _next() pops
  }

  // ---- checking --------------------------------------------------------------

  _tick() {
    if (this.stopped) return;
    const now = Date.now();
    const p = this.cfg.pool;
    for (const [site, s] of this.sticky) if (s.until < now) this.sticky.delete(site);
    if (!p.on) {
      this.status = 'off';
      this.note = '';
      return;
    }
    if (!this.harvesting && now - this.lastHarvest > p.harvestMinutes * 60000) this.harvest();
    // Dead proxies come back; give them another go once the fresh ones run out.
    if (!this.queue.length && !this.harvesting && this.alive.size < p.target && now > this.pausedUntil) {
      const again = [];
      for (const c of this.cand.values()) if (!this.alive.has(c.key) && c.at && now - c.at > 45 * 60000) again.push(c);
      if (again.length) {
        this.queue = again;
        this._order();
      }
    }
    this._pump();
    this._refresh();
  }

  /** What the pool is doing right now, in one word. */
  _refresh() {
    if (this.stopped) return;
    if (!this.cfg.pool.on) {
      this.status = 'off';
      this.note = '';
    } else if (this.harvesting) {
      this.status = 'harvesting';
      this.note = '';
    } else if (Date.now() < this.pausedUntil) this.status = 'paused';
    else if (this.active > 0) {
      this.status = 'checking';
      this.note = '';
    } else {
      this.status = 'idle';
      this.note = '';
    }
  }

  _resume() {
    this.pausedUntil = 0;
    this.misses = 0;
  }

  _next() {
    const now = Date.now();
    const p = this.cfg.pool;
    for (const c of this.alive.values()) {
      if (!c.busy && c.next <= now) return c;
    }
    if (now < this.pausedUntil || this.alive.size >= p.target) return null;
    while (this.queue.length) {
      const c = this.queue.pop(); // the queue is kept best-last so this is O(1)
      if (this.cand.get(c.key) === c && !c.busy && !this.alive.has(c.key)) return c;
    }
    return null;
  }

  _pump() {
    if (this.stopped || !this.cfg.pool.on) return;
    while (this.active < this.cfg.pool.concurrency) {
      const c = this._next();
      if (!c) return;
      this.active++;
      c.busy = true;
      this._check(c)
        .catch(() => {})
        .then(() => {
          c.busy = false;
          this.active--;
          setImmediate(() => this._pump());
        });
    }
  }

  /** Real request through the proxy to the judge over verified TLS. */
  async _probe(c, proto) {
    const p = this.cfg.pool;
    const url = new URL(p.judge);
    const t0 = Date.now();
    const res = await request({
      url,
      proxy: { proto, host: c.host, port: c.port, user: c.user, pass: c.pass },
      fresh: true,
      timeout: p.checkTimeout,
      connectTimeout: p.checkTimeout,
      headers: { 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
    });
    const timer = setTimeout(() => res.destroy(), p.checkTimeout);
    let body;
    try {
      body = (await readAll(res, 65536)).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - t0;
    // Over HTTPS the certificate already proves the tunnel is honest; plain HTTP judges need a clean 2xx.
    const ok = url.protocol === 'https:' ? res.statusCode < 500 : res.statusCode >= 200 && res.statusCode < 300;
    if (!ok) throw new Error('judge said ' + res.statusCode);
    const out = { ms, ip: '', cc: '' };
    let m;
    if ((m = /^ip=(.+)$/m.exec(body))) {
      out.ip = m[1].trim();
      if ((m = /^loc=([A-Z]{2})$/m.exec(body))) out.cc = m[1];
    } else if (body.trimStart()[0] === '{') {
      try {
        const j = JSON.parse(body);
        out.ip = String(j.ip || j.origin || j.query || '')
          .split(',')[0]
          .trim();
        const cc = j.country_code || j.countryCode || j.country || j.cc || '';
        if (/^[A-Za-z]{2}$/.test(cc)) out.cc = cc.toUpperCase();
      } catch {
        /* not JSON */
      }
    } else if (/^\s*[\d.:a-fA-F]{7,45}\s*$/.test(body)) {
      out.ip = body.trim();
    } else if (/cdn-cgi\/trace/.test(url.pathname)) {
      throw new Error('judge reply was tampered with');
    }
    // A plain-HTTP judge proves nothing by status alone: any web server sitting at a listed
    // address answers 200 to a forwarded request. The reply has to look like the judge's.
    if (url.protocol !== 'https:' && !isIP(out.ip)) throw new Error('judge reply not recognised');
    return out;
  }

  async _check(c) {
    const st = this.src.get(c.src);
    const wasAlive = this.alive.has(c.key);
    const protos = c.proto ? [c.proto] : ['http', 'socks5', 'socks4'];
    let hit = null;
    for (const proto of protos) {
      try {
        hit = await this._probe(c, proto);
        hit.proto = proto;
        break;
      } catch (e) {
        // Nothing listening at all: other protocols will not do better.
        if (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'EPROXYTIMEOUT') break;
      }
    }
    const now = Date.now();
    c.at = now;
    this.checked++;
    if (st && !wasAlive) st.tried++;
    if (hit) {
      if (!c.proto) {
        // learned the protocol: re-key
        const key = hit.proto + '://' + c.host + ':' + c.port;
        this.cand.delete(c.key);
        if (this.cand.has(key)) return; // its typed twin is already tracked
        c.proto = hit.proto;
        c.key = key;
        this.cand.set(key, c);
      }
      c.ms = c.ms ? Math.round(c.ms * 0.6 + hit.ms * 0.4) : hit.ms;
      c.ip = hit.ip || c.ip || '';
      c.cc = hit.cc || c.cc || '';
      c.fails = 0;
      c.streak = 0;
      c.passes = (c.passes || 0) + 1;
      c.next = now + this.cfg.pool.recheckMinutes * 60000 * (0.8 + Math.random() * 0.4);
      c.warm = false;
      if (!wasAlive) {
        c.since = now;
        this.alive.set(c.key, c);
        if (st) {
          st.alive++;
          st.everAlive = (st.everAlive || 0) + 1;
        }
      }
      this.misses = 0;
      this.backoff = 0;
    } else {
      c.fails++;
      if (wasAlive) {
        // One bad check is not a death sentence; two in a row is. A check that fails right
        // after a real request failed counts as the second strike.
        if (c.fails >= 2 || c.streak > 0) this._evict(c);
        else c.next = now + 20000;
      }
      // A network that reaches no proxy at all: stop hammering and say so.
      if (++this.misses >= 500 && this.alive.size === 0) {
        this.backoff = Math.min(6, this.backoff + 1);
        this.pausedUntil = now + 60000 * 2 ** (this.backoff - 1);
        this.note = 'none of the last ' + this.misses + ' proxies answered';
        this.misses = 0;
      }
    }
  }

  _evict(c) {
    if (!this.alive.delete(c.key)) return;
    const st = this.src.get(c.src);
    if (st && st.alive > 0) st.alive--;
    dropAgents(c);
    for (const [site, s] of this.sticky) if (s.key === c.key) this.sticky.delete(site);
    if (this.timed && this.timed.key === c.key) this.timed = null;
  }

  // ---- rotation --------------------------------------------------------------

  _usable(countries) {
    const r = this.cfg.route;
    const want = countries && countries.length ? countries : r.countries;
    const out = [];
    for (const c of this.alive.values()) {
      if (!r.protocols.includes(c.proto)) continue;
      if (want.length && !want.includes(c.cc)) continue;
      out.push(c);
    }
    return out;
  }

  _choose(list) {
    // Faster and steadier proxies win more often, but everyone gets traffic.
    let total = 0;
    const w = list.map((c) => {
      const v = (1 / ((c.ms || 3000) + 300)) * (1 / (1 + (c.streak || 0) * 2)) * Math.min(3, 1 + (c.passes || 0) * 0.25);
      total += v;
      return v;
    });
    let x = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      x -= w[i];
      if (x <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /**
   * Pick an exit for a request to `site`.
   * @param {string} site registrable domain
   * @param {Set<string>} [tried] keys already tried for this request
   */
  pick(site, tried, countries) {
    const r = this.cfg.route;
    const now = Date.now();
    const usable = this._usable(countries).filter((c) => !tried || !tried.has(c.key));
    if (!usable.length) return null;
    const ok = (key) => usable.find((c) => c.key === key);
    if (r.rotate === 'sticky') {
      const s = this.sticky.get(site);
      const cur = s && s.until > now && ok(s.key);
      if (cur) return cur;
      const c = this._choose(usable);
      this.sticky.set(site, { key: c.key, until: now + r.minutes * 60000 });
      if (this.sticky.size > 5000) this.sticky.delete(this.sticky.keys().next().value);
      return c;
    }
    if (r.rotate === 'timed') {
      const cur = this.timed && this.timed.until > now && ok(this.timed.key);
      if (cur) return cur;
      const c = this._choose(usable);
      this.timed = { key: c.key, until: now + r.minutes * 60000 };
      return c;
    }
    return this._choose(usable);
  }

  /**
   * A full route for `site`: the exit from pick() plus, when more than one hop is asked
   * for, relay proxies in front of it (entry -> relay -> exit). Returns an object that
   * net.request accepts as `proxy`; `cand` is the exit's pool record.
   * @param {object} [opt] { hops, countries }
   */
  route(site, tried, opt = {}) {
    const exit = this.pick(site, tried, opt.countries);
    if (!exit) return null;
    const hops = Math.max(1, Math.min(3, opt.hops || this.cfg.route.hops || 1));
    const via = [];
    if (hops > 1) {
      // Relays only need to be alive and quick. SOCKS first: HTTP proxies often refuse CONNECT to odd ports.
      let relays = [...this.alive.values()]
        .filter((c) => c.key !== exit.key && !(tried && tried.has(c.key)))
        .sort((a, b) => (a.proto === 'http') - (b.proto === 'http') || (a.ms || 9e9) - (b.ms || 9e9));
      // Another port on the exit's own machine adds nothing; use those only when there is no one else.
      const elsewhere = relays.filter((c) => c.host !== exit.host);
      if (elsewhere.length >= hops - 1) relays = elsewhere;
      const kept = this.relays.get(exit.key) || [];
      for (const key of kept) {
        // keep the same chain while it lasts, so connections can be reused
        const c = relays.find((x) => x.key === key);
        if (c && via.length < hops - 1) via.push(c);
      }
      const fresh = relays.filter((c) => !via.includes(c)).slice(0, 6);
      while (via.length < hops - 1 && fresh.length) via.unshift(fresh.splice(Math.floor(Math.random() * Math.min(3, fresh.length)), 1)[0]);
      this.relays.set(
        exit.key,
        via.map((c) => c.key)
      );
      if (this.relays.size > 2000) this.relays.delete(this.relays.keys().next().value);
    }
    return {
      key: exit.key,
      proto: exit.proto,
      host: exit.host,
      port: exit.port,
      user: exit.user,
      pass: exit.pass,
      ms: exit.ms,
      ip: exit.ip,
      cc: exit.cc,
      via,
      cand: exit,
    };
  }

  /** Human description of a route: [{proto, addr, cc}] entry first. */
  describe(route) {
    if (!route) return [];
    return (route.via || []).concat(route).map((c) => ({ proto: c.proto, addr: c.host + ':' + c.port, cc: c.cc || '', ms: c.ms || 0 }));
  }

  /** Forget every proxy and start over. */
  clear() {
    for (const c of [...this.alive.values()]) this._evict(c);
    this.cand.clear();
    this.queue = [];
    this.sticky.clear();
    this.relays.clear();
    this.timed = null;
    this.checked = 0;
    for (const st of this.src.values()) {
      st.count = 0;
      st.alive = 0;
      st.tried = 0;
      st.state = 'pending';
      st.error = '';
    }
    this._save();
  }

  /**
   * Response-time test: time one small request to `url` directly and through the
   * fastest proxies. @returns [{via, ms, status}|{via, error}]
   */
  async speed(url, n = 5) {
    const target = new URL(url || this.cfg.pool.judge);
    const one = async (proxy, label) => {
      const t0 = Date.now();
      try {
        const res = await request({
          url: target,
          proxy,
          fresh: true,
          timeout: 10000,
          connectTimeout: 8000,
          headers: { 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
        });
        const first = Date.now() - t0;
        res.on('error', () => {});
        res.destroy();
        if (proxy) this.report(proxy, true, first);
        return { via: label, ms: first, status: res.statusCode };
      } catch (e) {
        if (proxy) this.report(e.culprit && e.culprit.host ? this.alive.get(e.culprit.key) || proxy : proxy, false);
        return { via: label, error: explain(e) };
      }
    };
    const list = this._usable()
      .sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9))
      .slice(0, n);
    const jobs = [one(null, 'direct')].concat(list.map((c) => one(c, c.proto + '://' + c.host + ':' + c.port + (c.cc ? ' ' + c.cc : ''))));
    return Promise.all(jobs);
  }

  /** Feedback from real traffic. */
  report(c, ok, ms) {
    if (!c) return;
    if (c.cand) c = c.cand;
    if (ok) {
      c.streak = 0;
      c.hits = (c.hits || 0) + 1;
      if (ms) c.ms = Math.round((c.ms || ms) * 0.8 + ms * 0.2);
      return;
    }
    c.streak = (c.streak || 0) + 1;
    c.errs = (c.errs || 0) + 1;
    for (const [site, s] of this.sticky) if (s.key === c.key) this.sticky.delete(site);
    if (this.timed && this.timed.key === c.key) this.timed = null;
    if (c.streak >= 3) {
      c.fails = 2;
      this._evict(c);
      c.at = Date.now();
    } else c.next = Date.now(); // re-verify right away
    this._pump();
  }

  /** Drop the current exit(s) so the next request gets a new one. */
  rotate(site) {
    if (site) this.sticky.delete(site);
    else this.sticky.clear();
    this.timed = null;
    this.relays.clear();
  }

  // ---- reporting / persistence -----------------------------------------------

  summary() {
    this._refresh();
    const now = Date.now();
    const byProto = { http: 0, socks4: 0, socks5: 0 };
    const countries = {};
    const list = [];
    for (const c of this.alive.values()) {
      byProto[c.proto] = (byProto[c.proto] || 0) + 1;
      if (c.cc) countries[c.cc] = (countries[c.cc] || 0) + 1;
      list.push(c);
    }
    list.sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9));
    const p = this.cfg.pool;
    return {
      on: p.on,
      status: this.status,
      note: this.status === 'paused' ? this.note : '',
      resumeIn: this.status === 'paused' ? Math.max(0, Math.round((this.pausedUntil - now) / 1000)) : 0,
      found: this.cand.size,
      checked: this.checked,
      waiting: this.queue.length,
      alive: this.alive.size,
      usable: this._usable().length,
      byProto,
      countries,
      discover: this.discoverNote || '',
      nextHarvest: this.lastHarvest ? Math.max(0, Math.round((this.lastHarvest + p.harvestMinutes * 60000 - now) / 1000)) : 0,
      proxies: list
        .slice(0, 60)
        .map((c) => ({ proto: c.proto, addr: c.host + ':' + c.port, ms: c.ms, cc: c.cc, ip: c.ip, hits: c.hits || 0, errs: c.errs || 0 })),
      sources: [...this.src.values()].map((s) => ({
        id: s.id,
        type: s.def ? s.def.type : 'manual',
        name: (s.def && (s.def.repo || s.def.url)) || 'added by hand',
        on: !s.def || s.def.on !== false,
        found: !!(s.def && s.def.found),
        state: s.state,
        error: s.error,
        count: s.count,
        alive: s.alive,
        tried: s.tried,
      })),
      last: this.lastRoute,
    };
  }

  _save() {
    try {
      const alive = [...this.alive.values()].map((c) => ({
        proto: c.proto,
        host: c.host,
        port: c.port,
        user: c.user,
        pass: c.pass,
        src: c.src,
        ms: c.ms,
        ip: c.ip,
        cc: c.cc,
        passes: c.passes,
      }));
      const src = {};
      for (const s of this.src.values()) src[s.id] = { tried: s.tried, everAlive: s.everAlive || 0 };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ alive, src, rejected: [...this.rejected].slice(-500) }));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch {
      /* best effort */
    }
  }

  _load() {
    this.rejected = new Set();
    this.relays = new Map(); // exit key -> relay keys in front of it
    try {
      const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      this.rejected = new Set(j.rejected || []);
      for (const [id, s] of Object.entries(j.src || {})) {
        this.src.set(id, newStat(id, null, { tried: s.tried || 0, everAlive: s.everAlive || 0 }));
      }
      // Yesterday's winners are the best first guesses today.
      for (const a of j.alive || []) {
        if (!a || !a.host || !a.port || !a.proto) continue;
        const c = {
          key: keyOf(a),
          proto: a.proto,
          host: a.host,
          port: a.port,
          src: a.src,
          at: 0,
          fails: 0,
          ms: a.ms,
          ip: a.ip,
          cc: a.cc,
          passes: a.passes,
          warm: true,
        };
        if (a.user) {
          c.user = a.user;
          c.pass = a.pass;
        }
        this.cand.set(c.key, c);
        this.queue.push(c);
      }
    } catch {
      /* first run */
    }
  }
}

module.exports = { Pool, fetchSource, sourceId, endpoints };
