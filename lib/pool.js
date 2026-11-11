'use strict';
// The proxy pool: finds free proxies (GitHub, GitLab, any URL), proves which ones actually
// work and can be trusted, and hands out exits and chains with rotation and failover.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TarScanner } = require('./tar');
const { extractProxies, protoFromPath, keyOf } = require('./extract');
const { isIP } = require('net');
const { request, readAll, dropAgents, explain } = require('./net');
const { DATA_DIR, MAX_HOPS, cleanSource, parseCanary } = require('./config');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref()); // a pause never keeps the process from exiting
const sourceId = (s) => s.type + ':' + (s.repo || s.url);
const newStat = (id, def, extra) =>
  Object.assign(
    { id, def, count: 0, alive: 0, everAlive: 0, tried: 0, at: 0, error: '', state: 'pending', fails: 0, skip: 0, via: '' },
    extra
  );
// Headers a forwarding proxy adds to say who is behind it.
const TELLTALE = [
  'via',
  'forwarded',
  'x-real-ip',
  'client-ip',
  'x-client-ip',
  'proxy-connection',
  'x-proxy-id',
  'x-proxy-connection',
  'x-bluecoat-via',
];

/**
 * Housekeeping download. Goes through the pool when the pool can offer a route, and directly
 * otherwise: these are proxy lists and repository searches, never a site someone is visiting.
 * Redirects are followed by hand so every hop is validated.
 * @param {object} [opt] { route: () => proxy route | null, seen: (how) => void }
 */
async function get(url, headers, opt = {}, hops = 4) {
  const ask = (proxy) =>
    request({
      url: new URL(url),
      headers: Object.assign({ 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'gzip' }, headers),
      timeout: FETCH_MS,
      proxy: proxy || null,
      infra: !proxy,
    });
  const via = opt.route ? opt.route() : null;
  let res = null;
  if (via) res = await ask(via).catch(() => null);
  if (res && opt.seen) opt.seen('proxy');
  if (!res) {
    res = await ask(null);
    if (opt.seen) opt.seen('direct');
  }
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
    res.resume();
    return get(new URL(res.headers.location, url).href, headers, opt, hops - 1);
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
    get(url, { Accept: 'application/gzip, application/octet-stream' }, opt).then((r) => {
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
  const res = await get(url, { Accept: 'text/plain, application/json, text/html;q=0.9, */*;q=0.5' }, opt);
  if (res.statusCode !== 200) throw httpError(res);
  let body = await readAll(res, MAX_LIST_FILE);
  if (/gzip/i.test(res.headers['content-encoding'] || '')) body = zlib.gunzipSync(body, { maxOutputLength: MAX_LIST_FILE * 4 });
  return extractProxies(body.toString('utf8'), hint || protoFromPath(new URL(url).pathname), {
    allowPrivate: opt.allowPrivate,
    limit: opt.max * 2,
  });
}

/** @param {object} opt { max, allowPrivate, route?, seen? } */
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

async function getJson(url, headers, opt) {
  const res = await get(url, Object.assign({ Accept: 'application/json' }, headers), opt);
  if (res.statusCode !== 200) throw httpError(res);
  let body = await readAll(res, 4 << 20);
  if (/gzip/i.test(res.headers['content-encoding'] || '')) body = zlib.gunzipSync(body, { maxOutputLength: 16 << 20 });
  return JSON.parse(body.toString('utf8'));
}

/** Any file, as bytes (the resolver list, for one). */
async function getBuffer(url, headers, opt, max = 4 << 20) {
  const res = await get(url, headers, opt);
  if (res.statusCode !== 200) throw httpError(res);
  let body = await readAll(res, max);
  if (/gzip/i.test(res.headers['content-encoding'] || '')) body = zlib.gunzipSync(body, { maxOutputLength: max * 4 });
  return body;
}

/** What a header echo says about a proxy: 'clean' (nothing added), 'leaks' (it announces itself or passes an address on), '' (no verdict). */
function judgeEcho(body) {
  let h;
  try {
    const j = JSON.parse(body);
    h = j && typeof j === 'object' ? j.headers || j : null;
  } catch {
    return '';
  }
  if (!h || typeof h !== 'object') return '';
  const got = {};
  for (const k of Object.keys(h)) got[k.toLowerCase()] = [].concat(h[k]).join(', ');
  if (!('user-agent' in got) && !('host' in got)) return ''; // not an echo of request headers
  // The echo's own front end notes the one address it saw (the exit's). A second one came from the proxy.
  const forwarded = String(got['x-forwarded-for'] || '')
    .split(',')
    .filter((x) => x.trim()).length;
  return forwarded > 1 || TELLTALE.some((k) => k in got) ? 'leaks' : 'clean';
}

function whyOf(e) {
  const code = (e && e.code) || '';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'EPROXYTIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EADDRNOTAVAIL') return 'unreachable';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'EPROXYCLOSED') return 'reset';
  return 'other'; // something answered, just not as a working proxy
}

class Pool {
  constructor(config) {
    this.config = config;
    this.cand = new Map(); // key -> candidate
    this.alive = new Map(); // key -> candidate currently proven to work
    this.src = new Map(); // source id -> stats
    this.queue = []; // candidates waiting for a first check
    // Which exit is in use where: site -> { key, until }. "*" stands for every site (rotate = timed), and
    // "<site>|<guest>" for a third party on that site's pages that could not use the site's exit.
    this.sticky = new Map();
    this.memo = new Map(); // site (or site|guest) -> Map(exit key -> { ok, bad, at, good }): what worked where. Memory only, never written to disk.
    this.canary = new Map(); // canary url -> { pass, fail }
    this.active = 0;
    this.status = 'starting';
    this.note = '';
    this.checked = 0;
    this.everAlive = 0; // proxies that passed a check since this process started
    this.misses = 0; // checks since the last success
    this.why = { refused: 0, timeout: 0, unreachable: 0, reset: 0, other: 0 }; // how those failed
    this.pausedUntil = 0;
    this.backoff = 0;
    this.lastHarvest = 0;
    this.harvesting = false;
    this.stopped = false;
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

  /** A one-hop route for Waddle's own downloads, once there are proxies to spare; null means "go direct". */
  lend() {
    const list = this._usable();
    return list.length >= 3 ? this._wrap(this._choose(list), []) : null;
  }

  /** How housekeeping downloads travel: through the pool when it can, directly when it cannot. */
  housekeeping(seen) {
    return { route: () => this.lend(), seen };
  }

  /**
   * @param {boolean} [force] asked for by hand: also retry sources that are resting after repeated failures
   */
  async harvest(force) {
    if (this.harvesting || this.stopped) return;
    this.harvesting = true;
    this.lastHarvest = Date.now();
    this._syncSources();
    const opt = { max: this.cfg.pool.perSource, allowPrivate: process.env.WADDLE_ALLOW_PRIVATE === '1' };
    try {
      const jobs = [...this.src.values()].filter((s) => {
        if (!s.def || !s.def.on || s.id === 'manual') return false;
        // A source that keeps failing is left alone for a few rounds instead of being asked every time.
        if (!force && s.skip > 0) {
          s.skip--;
          return false;
        }
        return true;
      });
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
            const how = this.housekeeping((via) => {
              st.via = via;
            });
            const list = await fetchSource(st.def, Object.assign(how, opt));
            this._add(list, st.id, opt.max);
            st.state = 'ok';
            st.error = '';
            st.fails = 0;
          } catch (e) {
            st.state = 'error';
            st.error = e.status ? 'HTTP ' + e.status : explain(e);
            st.fails++;
            if (st.fails >= 3) st.skip = Math.min(8, 2 ** (st.fails - 3));
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
    const how = this.housekeeping();
    const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const cands = [];
    const notes = [];
    const ghHeaders = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (process.env.WADDLE_GITHUB_TOKEN) ghHeaders.Authorization = 'Bearer ' + process.env.WADDLE_GITHUB_TOKEN;
    for (const q of ['proxy-list in:name pushed:>' + since, 'topic:proxy-list pushed:>' + since, 'free-proxy in:name pushed:>' + since]) {
      try {
        const r = await getJson(
          endpoints.githubApi + '/search/repositories?per_page=30&sort=stars&order=desc&q=' + encodeURIComponent(q),
          ghHeaders,
          // a token is only ever sent straight to GitHub
          ghHeaders.Authorization ? {} : how
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
            new Date(Date.now() - 14 * 864e5).toISOString(),
          {},
          how
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
        const list = await fetchSource(def, Object.assign({}, how, opt));
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

  /** How much of what a source lists turns out to work: 0..1, smoothed so a new source starts in the middle. */
  _yield(id) {
    const s = this.src.get(id);
    return s ? ((s.everAlive || 0) + 1) / (s.tried + 20) : 0;
  }

  /** Best sources first, interleaved so one giant dump cannot starve the rest. Warm (previously working) ones lead. */
  _order() {
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
      .map(([id, list]) => ({ w: id === 'manual' ? 1e9 : this._yield(id), list, i: 0, credit: 0 }))
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

  /** Time between harvests: sooner while short of proxies, later while full or while nothing can be reached. */
  _interval() {
    const p = this.cfg.pool;
    let minutes = p.harvestMinutes;
    if (p.adaptive) {
      const fill = this.alive.size / p.target;
      if (this.health() === 'blocked') minutes *= 2;
      else if (fill < 0.25) minutes = Math.max(5, minutes / 3);
      else if (fill >= 1) minutes *= 2;
    }
    return minutes * 60000;
  }

  // ---- checking --------------------------------------------------------------

  _tick() {
    if (this.stopped) return;
    const now = Date.now();
    const p = this.cfg.pool;
    for (const [site, s] of this.sticky) if (s.until < now) this.sticky.delete(site);
    if (p.on) {
      if (!this.harvesting && now - this.lastHarvest > this._interval()) this.harvest();
      // Dead proxies come back; give them another go once the fresh ones run out.
      if (!this.queue.length && !this.harvesting && this.alive.size < p.target && now > this.pausedUntil) {
        const again = [];
        for (const c of this.cand.values()) if (!this.alive.has(c.key) && !c.bad && c.at && now - c.at > 45 * 60000) again.push(c);
        if (again.length) {
          this.queue = again;
          this._order();
        }
      }
    }
    this._pump();
    this._refresh();
  }

  /** What the pool is doing right now, in one word. */
  _refresh() {
    if (this.stopped) return;
    if (this.harvesting) {
      this.status = 'harvesting';
      this.note = '';
    } else if (Date.now() < this.pausedUntil) this.status = 'paused';
    else if (this.active > 0) {
      this.status = 'checking';
      this.note = '';
    } else {
      this.status = this.cfg.pool.on ? 'idle' : 'off';
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
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const c = this.queue[i];
      // With harvesting off, only what was added by hand (or worked before) is still checked.
      if (!p.on && c.src !== 'manual' && !c.warm) continue;
      this.queue.splice(i, 1); // the queue is kept best-last, so this is O(1) in the usual case
      if (this.cand.get(c.key) === c && !c.busy && !this.alive.has(c.key)) return c;
    }
    return null;
  }

  _pump() {
    if (this.stopped) return;
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

  /** One small request through a proxy, with a deadline on the whole exchange. */
  async _fetch(c, proto, href) {
    const p = this.cfg.pool;
    const res = await request({
      url: new URL(href),
      proxy: { proto, host: c.host, port: c.port, user: c.user, pass: c.pass },
      fresh: true,
      timeout: p.checkTimeout,
      connectTimeout: p.checkTimeout,
      headers: { 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
    });
    const timer = setTimeout(() => res.destroy(), p.checkTimeout);
    try {
      return { status: res.statusCode, body: (await readAll(res, 65536)).toString('utf8') };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Real request through the proxy to the judge over verified TLS. */
  async _probe(c, proto) {
    const url = new URL(this.cfg.pool.judge);
    const t0 = Date.now();
    const { status, body } = await this._fetch(c, proto, url.href);
    const ms = Date.now() - t0;
    // Over HTTPS the certificate already proves the tunnel is honest; plain HTTP judges need a clean 2xx.
    const ok = url.protocol === 'https:' ? status < 500 : status >= 200 && status < 300;
    if (!ok) throw new Error('judge said ' + status);
    const out = { ms, ip: '', cc: '', colo: '' };
    let m;
    if ((m = /^ip=(.+)$/m.exec(body))) {
      out.ip = m[1].trim();
      if ((m = /^loc=([A-Z]{2})$/m.exec(body))) out.cc = m[1];
      if ((m = /^colo=([A-Z]{3})$/m.exec(body))) out.colo = m[1];
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

  /**
   * Can this proxy be trusted with pages that are not encrypted?
   *   plain = true   known pages came back byte for byte
   *   plain = null   it does not carry plain HTTP at all (HTTPS only: nothing to tamper with)
   *   plain = false  it changed a page on the way: never used again
   *   anon  = 'clean' | 'leaks' | ''   what a header echo showed it adds to a request
   */
  async _vet(c) {
    const p = this.cfg.pool;
    let plain = null;
    for (const line of p.canaries) {
      const cn = parseCanary(line);
      if (!cn) continue;
      let st = this.canary.get(cn.url);
      if (!st) this.canary.set(cn.url, (st = { pass: 0, fail: 0 }));
      // A page nobody gets right is a page that changed, not proof against every proxy.
      if (st.fail >= 8 && !st.pass) continue;
      let r;
      try {
        r = await this._fetch(c, c.proto, cn.url);
      } catch {
        continue; // could not be fetched through it: try the next page
      }
      if (r.status === 200 && r.body.trim() === cn.expect) {
        st.pass++;
        plain = true;
        break;
      }
      st.fail++;
      // Only a page that other proxies do deliver intact can convict this one.
      if (st.pass >= 3) {
        plain = false;
        break;
      }
    }
    let anon = '';
    if (plain && p.echo) {
      try {
        anon = judgeEcho((await this._fetch(c, c.proto, p.echo)).body);
      } catch {
        /* no verdict */
      }
    }
    c.plain = plain;
    c.anon = anon;
    c.vetAt = Date.now();
  }

  async _check(c) {
    const st = this.src.get(c.src);
    const wasAlive = this.alive.has(c.key);
    const protos = c.proto ? [c.proto] : ['http', 'socks5', 'socks4'];
    let hit = null;
    let failure = null;
    for (const proto of protos) {
      try {
        hit = await this._probe(c, proto);
        hit.proto = proto;
        break;
      } catch (e) {
        failure = e;
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
      // Before it carries anyone's traffic: does it leave unencrypted pages alone? Asked again a few times a day.
      if (!c.vetAt || now - c.vetAt > 6 * 3600000) {
        await this._vet(c);
        if (c.plain === false) {
          c.bad = 'changes pages';
          if (st) st.bad = (st.bad || 0) + 1;
          if (wasAlive) this._evict(c);
          return;
        }
      }
      c.ms = c.ms ? Math.round(c.ms * 0.6 + hit.ms * 0.4) : hit.ms;
      c.ip = hit.ip || c.ip || '';
      c.cc = hit.cc || c.cc || '';
      c.colo = hit.colo || c.colo || '';
      c.fails = 0;
      c.streak = 0;
      c.passes = (c.passes || 0) + 1;
      c.next = Date.now() + this.cfg.pool.recheckMinutes * 60000 * (0.8 + Math.random() * 0.4);
      c.warm = false;
      if (!wasAlive) {
        c.since = now;
        this.alive.set(c.key, c);
        this.everAlive++;
        if (st) {
          st.alive++;
          st.everAlive = (st.everAlive || 0) + 1;
        }
      }
      this.misses = 0;
      this.backoff = 0;
      for (const k of Object.keys(this.why)) this.why[k] = 0;
    } else {
      c.fails++;
      this.why[whyOf(failure)]++;
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
    this.relays.delete(c.key);
  }

  /**
   * Where things stand, in one word:
   * ok | starting | searching | blocked (many tried, none ever answered) | nolists | empty | off
   */
  health() {
    if (this.alive.size) return 'ok';
    const srcs = [...this.src.values()].filter((s) => s.def && s.def.on !== false && s.id !== 'manual');
    if (!this.cfg.pool.on && !this.cand.size) return 'off';
    if (!srcs.length && !this.cand.size) return 'empty';
    if (this.checked >= 300 && !this.everAlive) return 'blocked';
    if (srcs.length && srcs.every((s) => s.state === 'error') && !this.queue.length) return 'nolists';
    if (!this.checked) return 'starting';
    return 'searching';
  }

  // ---- rotation --------------------------------------------------------------

  /** Live proxies that may serve as an exit. @param {object} [opt] { plain: must be proven honest with unencrypted pages } */
  _usable(countries, opt) {
    const r = this.cfg.route;
    const want = countries && countries.length ? countries : r.countries;
    const out = [];
    for (const c of this.alive.values()) {
      if (!r.protocols.includes(c.proto)) continue;
      if (want.length && !want.includes(c.cc)) continue;
      if (opt && opt.plain && !(c.plain === true && c.anon !== 'leaks')) continue;
      out.push(c);
    }
    return out;
  }

  _choose(list, memo) {
    // Faster and steadier proxies win more often, but everyone gets traffic.
    let total = 0;
    const w = list.map((c) => {
      let v = (1 / ((c.ms || 3000) + 300)) * (1 / (1 + (c.streak || 0) * 2)) * Math.min(3, 1 + (c.passes || 0) * 0.25);
      const m = memo && memo.get(c.key);
      if (m && m.good) v *= 4; // it worked for this site the last time
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
   * Note how an exit did with a site, so the next visit starts with one that works there.
   * @param {string} [guest] the third party the answer came from, when it was not the site itself: kept apart, it says nothing about the site
   */
  remember(site, route, ok, guest) {
    if (!site || !route) return;
    if (guest) site += '|' + guest;
    let m = this.memo.get(site);
    if (!m) {
      if (this.memo.size >= 2000) this.memo.delete(this.memo.keys().next().value);
      this.memo.set(site, (m = new Map()));
    }
    const e = m.get(route.key) || { ok: 0, bad: 0, at: 0, good: false };
    if (ok) e.ok++;
    else e.bad++;
    e.good = !!ok; // the latest answer is the one that counts: a site that starts refusing an exit has changed its mind
    e.at = Date.now();
    m.set(route.key, e);
    if (m.size > 40) m.delete(m.keys().next().value);
  }

  /**
   * Pick an exit for a request made on behalf of `site`.
   * @param {string} site registrable domain of the page the request belongs to
   * @param {Set<string>} [tried] keys already tried for this request
   * @param {string[]} [countries]
   * @param {object} [opt] { plain, vary: Set of protocols already tried (others are preferred),
   *   guest: the third party's site when the request goes to one, again: this is a second try (default: when `tried` is not empty) }
   */
  pick(site, tried, countries, opt = {}) {
    const r = this.cfg.route;
    const now = Date.now();
    let usable = this._usable(countries, opt).filter((c) => !tried || !tried.has(c.key));
    if (!usable.length) return null;
    const memo = this.memo.get(opt.guest ? site + '|' + opt.guest : site);
    if (memo) {
      // Exits this site turned away the last time, and not long ago, are a last resort.
      const fine = usable.filter((c) => {
        const m = memo.get(c.key);
        return !(m && !m.good && now - m.at < 30 * 60000);
      });
      if (fine.length) usable = fine;
    }
    if (opt.vary && opt.vary.size) {
      // After a failure, a different kind of proxy is the better second guess.
      const other = usable.filter((c) => !opt.vary.has(c.proto));
      if (other.length) usable = other;
    }
    if (r.rotate !== 'sticky' && r.rotate !== 'timed') return this._choose(usable, memo);
    const ok = (key) => usable.find((c) => c.key === key);
    const held = (k) => {
      const s = this.sticky.get(k);
      return s && s.until > now ? s : null;
    };
    const main = this._main(site);
    const s = held(main);
    const cur = s && ok(s.key);
    if (cur) return cur;
    // The exit in use is alive but cannot carry this one request. A second try borrows another exit, and so does a
    // third party with needs of its own (a rule for its host, plain HTTP, or it turned the exit away): one file
    // must not change where the rest of the page leaves from. Anything else moves the site. (See pin().)
    const again = opt.again !== undefined ? opt.again : !!(tried && tried.size);
    if (!s || !this.alive.has(s.key) || !(again || opt.guest)) return this._hold(main, this._choose(usable, memo));
    if (!opt.guest) return this._choose(usable, memo);
    // A third party keeps the exit it borrowed, so that it too is met from one place.
    const side = held(main + '|' + opt.guest);
    const lent = side && ok(side.key);
    if (lent) return lent;
    const c = this._choose(usable, memo);
    return again && side ? c : this._hold(main + '|' + opt.guest, c);
  }

  /** The name an exit is held under: the site, or one name for all of them when a single exit serves everything. */
  _main(site) {
    return this.cfg.route.rotate === 'timed' ? '*' : site;
  }

  _hold(name, c) {
    this.sticky.delete(name);
    this.sticky.set(name, { key: c.key, until: Date.now() + this.cfg.route.minutes * 60000 });
    if (this.sticky.size > 5000) this.sticky.delete(this.sticky.keys().next().value);
    return c;
  }

  _wrap(exit, via) {
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
      colo: exit.colo,
      via,
      cand: exit,
    };
  }

  /** The exit a site would get right now, without choosing or changing anything. */
  peek(site) {
    const hold = this.sticky.get(this._main(site));
    return (hold && hold.until > Date.now() && this.alive.get(hold.key)) || null;
  }

  /**
   * A full route for `site`: the exit from pick() plus, when more than one hop is asked
   * for, relay proxies in front of it (entry -> relay -> exit). Returns an object that
   * net.request accepts as `proxy`; `cand` is the exit's pool record.
   * @param {object} [opt] { hops, countries, plain, vary, avoid: Set of keys not to relay through }
   */
  route(site, tried, opt = {}) {
    // An exit that no chain can be built in front of is passed over like one that does not fit the settings
    // (the site moves to one that can be reached); only exits that had their go make this a second try.
    const how = Object.assign({}, opt, { again: !!(tried && tried.size) });
    const skip = new Set(tried || []);
    for (;;) {
      const exit = this.pick(site, skip, opt.countries, how);
      if (!exit) return null;
      const via = this._relays(exit, tried, opt);
      if (via) return this._wrap(exit, via);
      skip.add(exit.key);
    }
  }

  /** The proxies to put in front of `exit`, entry first. [] for a single hop; null when the chain that is asked for cannot be built. */
  _relays(exit, tried, opt) {
    const r = this.cfg.route;
    const hops = Math.max(1, Math.min(MAX_HOPS, opt.hops || r.hops || 1));
    const via = [];
    if (hops > 1) {
      // Relays only need to be alive, quick and willing to connect onward. SOCKS first: HTTP proxies often refuse odd ports.
      const all = [...this.alive.values()]
        .filter((c) => c.key !== exit.key && !c.norelay && !(tried && tried.has(c.key)) && !(opt.avoid && opt.avoid.has(c.key)))
        .sort((a, b) => (a.proto === 'http') - (b.proto === 'http') || (a.ms || 9e9) - (b.ms || 9e9));
      // Another port on a machine already in the chain adds nothing. (Loopback is the exception: proxies
      // there are stand-ins on a test rig, each one a machine of its own.)
      const machine = (c) => (/^(?:127\.|\[?::1\]?$)/.test(c.host) ? c.host + ':' + c.port : c.host);
      const hosts = new Set([machine(exit)]);
      const lands = new Set(exit.cc ? [exit.cc] : []);
      const free = (c) => !hosts.has(machine(c));
      const take = (c) => {
        via.push(c);
        hosts.add(machine(c));
        if (c.cc) lands.add(c.cc);
      };
      const choose = (list) => {
        if (r.spread) {
          const abroad = list.filter((c) => c.cc && !lands.has(c.cc)); // a country the chain does not pass through yet
          if (abroad.length) list = abroad;
        }
        list = list.slice(0, 6);
        return list[Math.floor(Math.random() * Math.min(3, list.length))];
      };
      const entryOk = (c) => !r.entry.length || r.entry.includes(c.cc);
      // Keep the same chain while it lasts, so connections can be reused.
      const kept = (this.relays.get(exit.key) || []).map((k) => all.find((c) => c.key === k)).filter(Boolean);
      if (kept.length && entryOk(kept[0])) for (const c of kept) if (free(c) && via.length < hops - 1) take(c);
      if (!via.length) {
        const first = choose(all.filter((c) => free(c) && entryOk(c)));
        if (first) take(first);
        else if (r.entry.length) return null; // the entry has to be in a named country and nothing live is
      }
      while (via.length && via.length < hops - 1) {
        const next = choose(all.filter(free));
        if (!next) break;
        take(next);
      }
      // Not enough live proxies for the whole chain: a shorter one, when that is allowed.
      if (via.length < hops - 1 && !r.shorten) return null;
      this.relays.set(
        exit.key,
        via.map((c) => c.key)
      );
      if (this.relays.size > 2000) this.relays.delete(this.relays.keys().next().value);
    }
    return via;
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
    this.forget();
    this.checked = 0;
    this.everAlive = 0;
    for (const k of Object.keys(this.why)) this.why[k] = 0;
    for (const st of this.src.values()) {
      st.count = 0;
      st.alive = 0;
      st.tried = 0;
      st.skip = 0;
      st.state = 'pending';
      st.error = '';
    }
    this._save();
  }

  /**
   * Response-time test: time one small request to `url` through the fastest exits.
   * @returns [{via, ms, status}|{via, error}]
   */
  async speed(url, n = 6) {
    const target = new URL(url || this.cfg.pool.judge);
    const one = async (c) => {
      const label = c.proto + '://' + c.host + ':' + c.port + (c.cc ? ' ' + c.cc : '');
      const t0 = Date.now();
      try {
        const res = await request({
          url: target,
          proxy: c,
          fresh: true,
          timeout: 10000,
          connectTimeout: 8000,
          headers: { 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
        });
        const first = Date.now() - t0;
        res.on('error', () => {});
        res.destroy();
        this.report(c, true, first);
        return { via: label, ms: first, status: res.statusCode };
      } catch (e) {
        return { via: label, error: explain(e), failed: c };
      }
    };
    const list = this._usable(null, { plain: target.protocol === 'http:' })
      .sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9))
      .slice(0, n);
    const rows = await Promise.all(list.map(one));
    // A failure counts against an exit only when another exit reached the same address (or the address is the
    // pool's own test page): otherwise the address is the problem.
    const reachable = !url || rows.some((r) => !r.failed);
    for (const r of rows) {
      if (r.failed && reachable) this.report(r.failed, false);
      delete r.failed;
    }
    return rows;
  }

  /**
   * Feedback from real traffic.
   * @param {boolean} [stay] the failure is about one site, not about the proxy as such (it could not get there
   *   while another exit could): it counts, but the other sites this exit serves stay with it
   */
  report(c, ok, ms, stay) {
    if (!c) return;
    if (c.cand) c = c.cand;
    if (ok) {
      c.streak = 0;
      c.sour = 0;
      c.hits = (c.hits || 0) + 1;
      if (ms) c.ms = Math.round((c.ms || ms) * 0.8 + ms * 0.2);
      return;
    }
    c.streak = (c.streak || 0) + 1;
    c.sour = (c.sour || 0) + 1; // unlike the streak, not forgiven by passing the pool's own test: only by carrying something
    c.errs = (c.errs || 0) + 1;
    if (!stay) for (const [site, s] of this.sticky) if (s.key === c.key) this.sticky.delete(site);
    // Three failures in a row, or five with not one page carried in between (a proxy that passes the test and does nothing else).
    if (c.streak >= 3 || c.sour >= 5) {
      c.sour = 0;
      c.fails = 2;
      this._evict(c);
      c.at = Date.now();
    } else c.next = Date.now(); // re-verify right away
    this._pump();
  }

  /**
   * A request through `route` failed with `e`: work out which hop let it down and note it.
   *
   * A proxy that cannot be reached, speaks gibberish or asks for a password is at fault for certain.
   * An exit that answered properly and then could not reach the site, or whose connection died later,
   * may be blameless: the site may simply be down, and a dead site must not cost the pool its exits.
   * With `benefit` set, such an exit is not marked down here. It is tested again right away, and the
   * caller reports it (report(route, false)) if another exit then manages what this one could not.
   * @param {boolean} [benefit] give an exit that may be blameless the benefit of the doubt
   * @returns {{key: string, relay: boolean, doubt: boolean}} the hop at fault; `doubt`: it may not be its fault
   */
  blame(route, e, benefit) {
    const chain = (route.via || []).concat(route.cand || route);
    let at = chain.length - 1;
    if (e && e.culprit) {
      const i = chain.findIndex((c) => c.host === e.culprit.host && c.port === e.culprit.port);
      if (i >= 0) at = i;
    }
    const c = chain[at];
    const relay = at < chain.length - 1;
    if (relay) {
      this.relays.delete((route.cand || route).key); // build this chain differently next time
      if (e && e.code === 'EPROXYREFUSED' && !e.auth) {
        // It answers but will not connect onward to another proxy: fine as an exit, no use as a relay.
        c.refusals = (c.refusals || 0) + 1;
        if (c.refusals >= 2) c.norelay = true;
        return { key: c.key, relay, doubt: false };
      }
    }
    const certain = !e || e.auth || e.code === 'EPROXYBAD' || e.stage === 'connect';
    if (benefit && !relay && !certain) {
      const now = Date.now();
      if (now - (c.at || 0) > 10000) {
        c.next = now; // not tested in the last seconds: test it now
        this._pump();
      }
      return { key: c.key, relay, doubt: true };
    }
    this.report(c, false);
    return { key: c.key, relay, doubt: false };
  }

  /**
   * Keep `site` on this exit from here on (a page that only loaded on a second try stays with the exit that worked).
   * @param {string} [guest] a third party on the site's pages: only it is kept there, the site stays where it is
   */
  pin(site, route, guest) {
    const r = this.cfg.route.rotate;
    if (r !== 'sticky' && r !== 'timed') return;
    const c = this.alive.get(route.key);
    if (c) this._hold(this._main(site) + (guest ? '|' + guest : ''), c);
  }

  /**
   * Drop the current exit(s) so the next request gets a new one: for one site and the third parties on it, or for all.
   * @param {string} [guest] only this third party's own exit; the site keeps its own
   */
  rotate(site, guest) {
    if (site && guest) {
      this.sticky.delete(this._main(site) + '|' + guest);
      return;
    }
    if (!site) this.sticky.clear();
    else {
      for (const k of [...this.sticky.keys()]) {
        if (k === site || k === '*' || k.startsWith(site + '|') || k.startsWith('*|')) this.sticky.delete(k);
      }
    }
    this.relays.clear();
  }

  /** New identity: every site gets a new exit and a new chain, and what worked where is forgotten. */
  forget() {
    this.sticky.clear();
    this.relays.clear();
    this.memo.clear();
    dropAgents();
  }

  // ---- reporting / persistence -----------------------------------------------

  summary() {
    this._refresh();
    const now = Date.now();
    const byProto = { http: 0, socks4: 0, socks5: 0 };
    const countries = {};
    const list = [];
    let plain = 0;
    for (const c of this.alive.values()) {
      byProto[c.proto] = (byProto[c.proto] || 0) + 1;
      if (c.cc) countries[c.cc] = (countries[c.cc] || 0) + 1;
      if (c.plain === true && c.anon !== 'leaks') plain++;
      list.push(c);
    }
    list.sort((a, b) => (a.ms || 9e9) - (b.ms || 9e9));
    const p = this.cfg.pool;
    return {
      on: p.on,
      status: this.status,
      health: this.health(),
      why: Object.assign({}, this.why),
      note: this.status === 'paused' ? this.note : '',
      resumeIn: this.status === 'paused' ? Math.max(0, Math.round((this.pausedUntil - now) / 1000)) : 0,
      found: this.cand.size,
      checked: this.checked,
      waiting: this.queue.length,
      alive: this.alive.size,
      usable: this._usable().length,
      plain,
      byProto,
      countries,
      discover: this.discoverNote || '',
      nextHarvest: this.lastHarvest && p.on ? Math.max(0, Math.round((this.lastHarvest + this._interval() - now) / 1000)) : 0,
      proxies: list.slice(0, 60).map((c) => ({
        proto: c.proto,
        addr: c.host + ':' + c.port,
        ms: c.ms,
        cc: c.cc,
        ip: c.ip,
        hits: c.hits || 0,
        errs: c.errs || 0,
        plain: c.plain === true && c.anon !== 'leaks',
        leaks: c.anon === 'leaks',
        relay: !c.norelay,
      })),
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
        worked: s.everAlive || 0,
        bad: s.bad || 0,
        resting: s.skip > 0,
        via: s.via,
      })),
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
        colo: c.colo,
        passes: c.passes,
        norelay: c.norelay || undefined,
      }));
      const src = {};
      for (const s of this.src.values()) src[s.id] = { tried: s.tried, everAlive: s.everAlive || 0, bad: s.bad || 0 };
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
        this.src.set(id, newStat(id, null, { tried: s.tried || 0, everAlive: s.everAlive || 0, bad: s.bad || 0 }));
      }
      // Yesterday's winners are the best first guesses today. They are checked (and vetted) again before any use.
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
          colo: a.colo,
          passes: a.passes,
          norelay: !!a.norelay,
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

module.exports = { Pool, fetchSource, getBuffer, judgeEcho, sourceId, endpoints };
