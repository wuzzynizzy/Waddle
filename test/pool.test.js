'use strict';
const { site, judge, canary, httpProxy, socks5Proxy, tarball, world, closeAll, until, sleep } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Config, DATA_DIR } = require('../lib/config');
const { Pool, fetchSource, judgeEcho, sourceId, endpoints } = require('../lib/pool');
const net = require('../lib/net');

const pools = [];
test.after(async () => {
  for (const p of pools) p.stop();
  net.dropAgents();
  await closeAll();
});

function makePool(patch) {
  const config = new Config();
  config.reset();
  config.patch({
    dns: { auto: false },
    // No header echo and no canary pages unless a test names them: proxies are then kept for HTTPS only.
    pool: Object.assign(
      { discover: false, checkTimeout: 1500, concurrency: 20, target: 40, recheckMinutes: 30, echo: '', canaries: [] },
      patch.pool
    ),
    route: patch.route || {},
  });
  try {
    fs.rmSync(path.join(DATA_DIR, 'pool.json'), { force: true });
  } catch {
    /* none */
  }
  const pool = new Pool(config);
  pools.push(pool);
  return { pool, config };
}

test('harvest -> check -> live: finds the working proxies, learns protocol, speed, address and country', async () => {
  const w = await world();
  const { pool } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3 && pool.summary().checked >= 4);
  const s = pool.summary();
  assert.equal(s.found, 4);
  assert.deepEqual(s.byProto, { http: 1, socks4: 1, socks5: 1 });
  assert.deepEqual(s.countries, { US: 1, DE: 1, JP: 1 });
  const byAddr = Object.fromEntries(s.proxies.map((p) => [p.addr, p]));
  assert.equal(byAddr['127.0.0.1:' + w.h.port].proto, 'http');
  assert.equal(byAddr['127.0.0.1:' + w.s5.port].proto, 'socks5', 'an untyped address is probed until its protocol is known');
  assert.equal(byAddr['127.0.0.1:' + w.s5.port].cc, 'DE');
  assert.equal(byAddr['127.0.0.1:' + w.s5.port].ip, '203.0.113.20', 'the address the world sees, as reported by the judge');
  assert.equal(byAddr['127.0.0.1:' + w.s4.port].proto, 'socks4');
  for (const p of s.proxies) assert.ok(p.ms >= 0 && p.ms < 1500, 'measured response time: ' + p.ms);
  assert.equal(s.proxies.length, 3, 'the dead address is not listed');
  const src = s.sources.find((x) => x.type === 'url');
  assert.equal(src.state, 'ok');
  assert.equal(src.count, 4);
  assert.equal(src.alive, 3);
  assert.ok(['idle', 'checking'].includes(s.status), s.status);
  pool.stop();
});

test('rotation: per site, every request, by protocol and by country', async () => {
  const w = await world();
  const { pool, config } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3);

  // sticky: a site keeps its exit, different sites may differ, rotate() moves on
  const first = pool.route('a.test').key;
  for (let i = 0; i < 20; i++) assert.equal(pool.route('a.test').key, first);
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(pool.route('site' + i + '.test').key);
  assert.equal(seen.size, 3, 'all live proxies get used across sites');
  const tried = new Set([first]);
  assert.notEqual(pool.route('a.test', tried).key, first, 'an exit that was just tried is skipped');
  let moved = false;
  for (let i = 0; i < 30 && !moved; i++) {
    pool.rotate('a.test');
    moved = pool.route('a.test').key !== first;
  }
  assert.ok(moved, 'rotate() gives the site a new exit');

  config.patch({ route: { rotate: 'request' } });
  const each = new Set();
  for (let i = 0; i < 60; i++) each.add(pool.route('a.test').key);
  assert.equal(each.size, 3, 'every request can leave from a different exit');

  config.patch({ route: { rotate: 'timed' } });
  const timed = pool.route('a.test').key;
  for (let i = 0; i < 10; i++)
    assert.equal(pool.route('other' + i + '.test').key, timed, 'timed: one exit for everything until the clock runs out');

  config.patch({ route: { rotate: 'request', protocols: ['socks5'] } });
  for (let i = 0; i < 10; i++) assert.equal(pool.route('a.test').key, w.s5.key);
  assert.equal(pool.summary().usable, 1);
  config.patch({ route: { protocols: ['http', 'socks4', 'socks5'], countries: ['JP'] } });
  for (let i = 0; i < 10; i++) assert.equal(pool.route('a.test').cc, 'JP');
  config.patch({ route: { countries: [] } });
  for (let i = 0; i < 10; i++)
    assert.equal(pool.route('a.test', null, { countries: ['US'] }).key, w.h.key, 'a per-site rule can ask for a country');
  assert.equal(pool.route('a.test', null, { countries: ['FR'] }), null, 'nothing live there: no route');
  assert.equal(pool.route('a.test', new Set([w.h.key, w.s5.key, w.s4.key])), null, 'everything tried: no route');
  pool.stop();
});

test('proxy over proxy: routes are built 1, 2 or 3 hops deep from distinct live proxies', async () => {
  const w = await world();
  const target = await site({ '/': { body: 'reached' } });
  const { pool, config } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
    route: { rotate: 'request' },
  });
  pool.start();
  await until(() => pool.summary().alive === 3);

  assert.deepEqual(pool.route('a.test').via, []);
  for (const hops of [2, 3]) {
    for (let i = 0; i < 15; i++) {
      const r = pool.route('a.test', null, { hops });
      const keys = r.via.map((c) => c.key).concat(r.key);
      assert.equal(keys.length, hops);
      assert.equal(new Set(keys).size, hops, 'no proxy appears twice in a chain');
      assert.deepEqual(
        pool.describe(r).map((x) => x.addr),
        keys.map((k) => k.replace(/^\w+:\/\//, ''))
      );
    }
  }
  config.patch({ route: { hops: 3 } });
  const r = pool.route('a.test');
  assert.equal(r.via.length, 2, 'the global hop setting is the default');

  // and the chain really carries traffic end to end
  w.h.log.length = 0;
  w.s5.log.length = 0;
  w.s4.log.length = 0;
  const res = await net.request({ url: new URL(target.url + '/'), proxy: r, fresh: true, timeout: 4000 });
  assert.equal((await net.readAll(res)).toString(), 'reached');
  assert.equal(w.h.log.length + w.s5.log.length + w.s4.log.length, 3, 'all three proxies took part');
  assert.equal(target.hits.length, 1);

  // a sticky site keeps its whole chain, so tunnels can be reused
  config.patch({ route: { rotate: 'sticky', hops: 2 } });
  const one = pool.route('keep.test');
  for (let i = 0; i < 10; i++) {
    const again = pool.route('keep.test');
    assert.equal(again.key, one.key);
    assert.equal(again.via[0].key, one.via[0].key);
  }
  pool.stop();
});

test('feedback: three failed requests in a row evict a proxy; a single failure triggers a re-check that removes a dead one at once', async () => {
  const w = await world();
  const { pool } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
    route: { rotate: 'request' },
  });
  pool.start();
  await until(() => pool.summary().alive === 3);

  const exit = pool.route('a.test', new Set([w.s5.key, w.s4.key]));
  assert.equal(exit.key, w.h.key);
  pool.report(exit, true, 40);
  assert.equal(pool.summary().proxies.find((p) => p.addr === '127.0.0.1:' + w.h.port).hits, 1);
  pool.report(exit, false);
  pool.report(exit, false);
  pool.report(exit, false);
  assert.equal(pool.summary().alive, 2, 'three failures in a row: out');
  for (let i = 0; i < 20; i++) assert.notEqual(pool.route('a.test').key, w.h.key);

  await w.s5.close(); // this one really dies
  const dead = pool.route('b.test', new Set([w.s4.key]));
  assert.equal(dead.key, w.s5.key);
  pool.report(dead, false);
  await until(() => !pool.summary().proxies.some((p) => p.addr === '127.0.0.1:' + w.s5.port), 3000);
  assert.ok(pool.summary().proxies.some((p) => p.addr === '127.0.0.1:' + w.s4.port));
  pool.stop();
});

test('response-time test: each live exit, timed side by side; nothing is ever timed directly', async () => {
  const w = await world();
  const slowSite = await site({ '/': (req, res) => setTimeout(() => res.end('ok'), 60) });
  const { pool } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, canaries: [w.canary] },
  });
  pool.start();
  await until(() => pool.summary().alive === 3 && pool.summary().proxies.every((p) => p.plain));
  const rows = await pool.speed(slowSite.url + '/');
  assert.equal(rows.length, 3, 'one row per exit, and no row for a direct connection: Waddle does not make those');
  assert.equal(slowSite.hits.length, 3);
  for (const r of rows) {
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.ok(r.ms >= 55 && r.ms < 1500, r.via + ': ' + r.ms + ' ms');
  }
  assert.deepEqual(rows.map((r) => r.via.split(' ')[1]).sort(), ['DE', 'JP', 'US']);
  const def = await pool.speed();
  assert.equal(def.length, 3, 'defaults to the judge');
  await w.s4.close();
  const after = await pool.speed(slowSite.url + '/');
  assert.ok(
    after.some((r) => r.error),
    'a proxy that fails the test reports an error instead of a time'
  );
  pool.stop();
});

test('proxies added by hand are checked first; pasted junk is ignored', async () => {
  const w = await world();
  const { pool } = makePool({ pool: { sources: [], judge: w.judgeUrl } });
  pool.start();
  assert.equal(
    pool.addManual(`here are some:\nsocks5://127.0.0.1:${w.s5.port}\n127.0.0.1:${w.h.port}\nnot-a-proxy\n127.0.0.1:${w.h.port}`),
    2
  );
  await until(() => pool.summary().alive === 2);
  assert.equal(pool.addManual('127.0.0.1:' + w.s4.port, 'socks4'), 1);
  await until(() => pool.summary().alive === 3);
  assert.equal(pool.summary().sources.find((s) => s.id === 'manual').count, 3);
  assert.equal(pool.addManual(''), 0);
  pool.stop();
});

test('the live list survives a restart', async () => {
  const w = await world();
  const { pool, config } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3);
  pool.stop();
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'pool.json')));

  await w.list.close(); // the list is gone; only what was saved can bring the proxies back
  const again = new Pool(config);
  pools.push(again);
  again.start();
  await until(() => again.summary().alive === 3);
  again.stop();
});

test('sources can be switched off and the pool can be cleared or turned off', async () => {
  const w = await world();
  const src = { type: 'url', url: w.listUrl, proto: null, on: true };
  const { pool, config } = makePool({ pool: { sources: [src], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3);
  config.patch({ pool: { sources: [Object.assign({}, src, { on: false })] } });
  assert.equal(pool.summary().sources[0].state, 'off');
  assert.equal(pool.summary().found, 3, 'unverified leftovers of a disabled source are dropped; live proxies stay');
  pool.clear();
  assert.equal(pool.summary().alive, 0);
  assert.equal(pool.summary().found, 0);
  config.patch({ pool: { on: false } });
  await sleep(2100);
  assert.equal(pool.summary().status, 'off');
  assert.equal(pool.route('a.test'), null);
  pool.stop();
});

test('with nothing reachable the checker backs off and says why, instead of hammering', async () => {
  const lines = Array.from({ length: 600 }, (_, i) => '127.0.0.1:' + (20000 + i)).join('\n');
  const list = await site({ '/dead.txt': { headers: { 'Content-Type': 'text/plain' }, body: lines } });
  const j = await judge('198.51.100.1', 'ZZ');
  const { pool } = makePool({
    pool: {
      sources: [{ type: 'url', url: list.url + '/dead.txt', proto: null, on: true }],
      judge: j.url + '/trace',
      concurrency: 100,
      checkTimeout: 1000,
    },
  });
  pool.start();
  await until(() => pool.summary().status === 'paused', 15000, 100);
  const s = pool.summary();
  assert.match(s.note, /none of the last \d+ proxies answered/);
  assert.ok(s.resumeIn > 0 && s.resumeIn <= 60);
  assert.equal(s.alive, 0);
  pool.stop();
});

// ---- sources ------------------------------------------------------------------------

const many = (base, n, port) => Array.from({ length: n }, (_, i) => base + '.' + (i + 1) + ':' + port).join('\n') + '\n';

test('a GitHub repository is harvested from its snapshot: list files in, everything else out', async () => {
  const archive = tarball('proxy-list-main', {
    'http.txt': many('20.1.1', 5, 8080),
    'proxies/socks5.txt': many('20.2.2', 4, 1080),
    'data/all.json': JSON.stringify([{ ip: '20.3.3.1', port: 3128, protocol: 'socks4' }]),
    'README.md': '| address | port |\n|---|---|\n| 20.5.5.5 | 8080 |\n',
    'v2ray.txt': many('20.8.8', 3, 443),
    'src/main.py': 'PROXY = "20.7.7.7:8080"',
    'package.json': '{"x":"20.6.6.6:80"}',
  });
  const hub = await site({
    '/owner/proxy-list/tar.gz/HEAD': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
      res.end(archive);
    },
    '/owner/proxy-list/tar.gz/refs/heads/dev': (req, res) => {
      res.writeHead(200);
      res.end(tarball('proxy-list-dev', { 'socks4.txt': many('20.4.4', 2, 4145) }));
    },
  });
  const old = Object.assign({}, endpoints);
  endpoints.githubArchive = hub.url;
  try {
    const list = await fetchSource({ type: 'github', repo: 'owner/proxy-list', on: true }, { max: 1000, allowPrivate: false });
    const by = (proto) => list.filter((p) => p.proto === proto).length;
    assert.equal(list.length, 11);
    assert.equal(by('http'), 5, 'http.txt -> protocol from the file name');
    assert.ok(
      list.some((p) => p.host === '20.5.5.5' && p.port === 8080 && p.proto === null),
      'a table in the README counts; its protocol is found out by probing'
    );
    assert.equal(by('socks5'), 4);
    assert.equal(by('socks4'), 1, 'JSON entries carry their own protocol');
    assert.ok(!list.some((p) => /^20\.[6-9]\./.test(p.host)), 'source code, package.json and v2ray lists are not proxy lists');
    const dev = await fetchSource({ type: 'github', repo: 'owner/proxy-list', branch: 'dev', on: true }, { max: 1000 });
    assert.equal(dev.length, 2);
    assert.equal(dev[0].proto, 'socks4');
    await assert.rejects(fetchSource({ type: 'github', repo: 'owner/missing', on: true }, { max: 1000 }), { status: 404 });
  } finally {
    Object.assign(endpoints, old);
  }
});

test('a GitLab repository is harvested through its archive API', async () => {
  const lab = await site({
    '/api/v4/projects/group%2Fsub%2Flists/repository/archive.tar.gz': (req, res) => {
      res.writeHead(200);
      res.end(tarball('lists-main-abc', { 'socks5.txt': many('21.1.1', 6, 1080) }));
    },
  });
  const old = Object.assign({}, endpoints);
  endpoints.gitlab = lab.url;
  try {
    const list = await fetchSource({ type: 'gitlab', repo: 'group/sub/lists', on: true }, { max: 1000 });
    assert.equal(list.length, 6);
    assert.equal(list[0].proto, 'socks5');
    assert.equal(lab.last().url, '/api/v4/projects/group%2Fsub%2Flists/repository/archive.tar.gz');
  } finally {
    Object.assign(endpoints, old);
  }
});

test('web lists: text, JSON, gzip, redirects, and a per-source cap', async () => {
  const zlib = require('zlib');
  const web = await site({
    '/plain.txt': { headers: { 'Content-Type': 'text/plain' }, body: many('22.1.1', 3, 8080) },
    '/socks5.txt': { headers: { 'Content-Type': 'text/plain' }, body: many('22.2.2', 2, 1080) },
    '/api': {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [{ ip: '22.3.3.1', port: '8080', protocols: ['socks4'] }] }),
    },
    '/gz': (req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(many('22.4.4', 4, 3128)));
    },
    '/moved': (req, res) => {
      res.writeHead(302, { Location: '/plain.txt' });
      res.end();
    },
    '/big.txt': { body: many('22.5.5', 200, 80) },
    '/gone': { status: 410, body: '' },
  });
  const f = (p, proto) => fetchSource({ type: 'url', url: web.url + p, proto: proto || null, on: true }, { max: 50 });
  assert.equal((await f('/plain.txt')).length, 3);
  assert.equal((await f('/plain.txt', 'socks5'))[0].proto, 'socks5', 'the protocol chosen for the source applies');
  assert.equal((await f('/socks5.txt'))[0].proto, 'socks5', 'else the file name decides');
  assert.deepEqual(
    (await f('/api')).map((p) => p.proto + ' ' + p.host + ':' + p.port),
    ['socks4 22.3.3.1:8080']
  );
  assert.equal((await f('/gz')).length, 4);
  assert.equal((await f('/moved')).length, 3);
  assert.ok((await f('/big.txt')).length <= 100, 'capped');
  await assert.rejects(f('/gone'), { status: 410 });
  assert.match(web.hits[0].headers['user-agent'], /Mozilla/);
});

test('autofind: new list repositories are discovered on GitHub and GitLab, vetted, and added as sources', async () => {
  const good = tarball('fresh-main', { 'http.txt': many('23.1.1', 40, 8080) });
  const tiny = tarball('tiny-main', { 'http.txt': many('23.2.2', 3, 8080) });
  const hubHits = [];
  const hub = await site({
    '/search/repositories': (req, res, body, url) => {
      hubHits.push(url.searchParams.get('q'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            { full_name: 'newcomer/fresh-proxy-list', stargazers_count: 50, description: 'updated hourly' },
            { full_name: 'someone/tiny-proxy-list', stargazers_count: 40, description: 'three proxies' },
            { full_name: 'vpn/v2ray-proxy-list', stargazers_count: 9000, description: 'vmess nodes' },
            { full_name: 'nikita29a/FreeProxyList', stargazers_count: 8000, description: 'on the deny list' },
            { full_name: 'tool/proxy-list-checker', stargazers_count: 7000, description: 'a proxy checker tool' },
            { full_name: 'known/already-there', stargazers_count: 6000, description: 'configured by hand' },
            { full_name: 'broken/proxy-list', stargazers_count: 30, description: 'archive 404s' },
          ],
        })
      );
    },
    '/newcomer/fresh-proxy-list/tar.gz/HEAD': (req, res) => {
      res.writeHead(200);
      res.end(good);
    },
    '/someone/tiny-proxy-list/tar.gz/HEAD': (req, res) => {
      res.writeHead(200);
      res.end(tiny);
    },
    '/known/already-there/tar.gz/HEAD': (req, res) => {
      res.writeHead(200);
      res.end(tiny);
    },
  });
  const lab = await site({
    '/api/v4/projects': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([{ path_with_namespace: 'labgroup/proxy-list', default_branch: 'trunk', star_count: 5, description: 'gitlab list' }])
      );
    },
    '/api/v4/projects/labgroup%2Fproxy-list/repository/archive.tar.gz': (req, res) => {
      res.writeHead(200);
      res.end(tarball('proxy-list-trunk', { 'socks5.txt': many('23.3.3', 30, 1080) }));
    },
  });
  const j = await judge('198.51.100.1', 'ZZ');
  const old = Object.assign({}, endpoints);
  Object.assign(endpoints, { githubApi: hub.url, githubArchive: hub.url, gitlab: lab.url, gitlabGap: 0 });
  try {
    const { pool, config } = makePool({
      pool: {
        sources: [{ type: 'github', repo: 'known/already-there', on: true }],
        judge: j.url + '/trace',
        discover: true,
        discoverMax: 5,
        on: true,
        concurrency: 1,
        target: 1,
      },
    });
    await pool.harvest();
    const found = config.value.pool.sources
      .filter((s) => s.found)
      .map(sourceId)
      .sort();
    assert.deepEqual(found, ['github:newcomer/fresh-proxy-list', 'gitlab:labgroup/proxy-list']);
    assert.equal(config.value.pool.sources.find((s) => s.type === 'gitlab').branch, 'trunk');
    assert.ok(
      hubHits.length >= 1 && hubHits.every((q) => /pushed:>\d{4}-\d\d-\d\d/.test(q)),
      'only recently updated repositories are searched for'
    );
    const names = pool.summary().sources.map((s) => s.name);
    assert.ok(names.includes('newcomer/fresh-proxy-list') && names.includes('labgroup/proxy-list'));
    assert.ok(pool.summary().found >= 70, 'their proxies are queued for checking: ' + pool.summary().found);
    const vetted = hub.hits.filter((h) => /tar\.gz/.test(h.url)).map((h) => h.url.split('/').slice(1, 3).join('/'));
    assert.ok(
      !vetted.includes('vpn/v2ray-proxy-list') &&
        !vetted.includes('nikita29a/FreeProxyList') &&
        !vetted.includes('tool/proxy-list-checker'),
      'obvious non-lists are never downloaded'
    );

    // a second harvest does not re-vet what was rejected, and does not add duplicates
    const before = hub.hits.length;
    await pool.harvest();
    assert.deepEqual(
      config.value.pool.sources
        .filter((s) => s.found)
        .map(sourceId)
        .sort(),
      found
    );
    assert.ok(
      !hub.hits.slice(before).some((h) => /tiny-proxy-list|broken\/proxy-list/.test(h.url)),
      'rejected repositories are remembered'
    );
    pool.stop();

    // with discovery switched off nothing is searched
    const quiet = makePool({ pool: { sources: [], judge: j.url + '/trace', discover: false } });
    const n = hubHits.length;
    await quiet.pool.harvest();
    assert.equal(hubHits.length, n);
    quiet.pool.stop();
  } finally {
    Object.assign(endpoints, old);
  }
});

test('a source that fails is reported with a short reason and does not stop the others', async () => {
  const w = await world();
  const { pool } = makePool({
    pool: {
      judge: w.judgeUrl,
      sources: [
        { type: 'url', url: 'http://127.0.0.1:9/none.txt', proto: null, on: true },
        { type: 'url', url: w.list.url + '/missing.txt', proto: null, on: true },
        { type: 'url', url: w.listUrl, proto: null, on: true },
      ],
    },
  });
  await pool.harvest();
  const s = pool.summary().sources;
  assert.deepEqual(
    s.map((x) => x.state),
    ['error', 'error', 'ok']
  );
  assert.equal(s[0].error, 'connection refused');
  assert.equal(s[1].error, 'HTTP 404');
  assert.equal(pool.summary().found, 4);
  pool.stop();
});

// ---- vetting ------------------------------------------------------------------------

test('vetting: an exit that changes unencrypted pages is dropped; one that cannot carry them is kept for HTTPS only', async () => {
  const j = await judge('203.0.113.50', 'NL');
  const can = await canary();
  const honest = [await httpProxy(), await socks5Proxy(), await httpProxy()];
  const liar = await httpProxy({ tamper: true });
  const narrow = await httpProxy({ closed: [can.port] }); // connects to the judge, not to the canary: "443 only"
  const { pool } = makePool({ pool: { sources: [], judge: j.url + '/trace', canaries: [can.line] } });
  pool.start();

  pool.addManual(honest.map((p) => p.proto + '://' + p.addr).join('\n'));
  await until(() => pool.summary().alive === 3 && pool.summary().plain === 3);
  assert.ok(
    pool.summary().proxies.every((p) => p.plain && !p.leaks),
    'the known page came back word for word: these may carry plain HTTP'
  );

  pool.addManual('http://' + narrow.addr);
  await until(() => pool.summary().alive === 4);
  const kept = pool.summary().proxies.find((p) => p.addr === narrow.addr);
  assert.equal(kept.plain, false, 'no proof either way: kept, for HTTPS only');
  for (let i = 0; i < 40; i++) assert.notEqual(pool.route('s' + i + '.test', null, { plain: true }).key, 'http://' + narrow.addr);
  const all = new Set();
  for (let i = 0; i < 80; i++) all.add(pool.route('t' + i + '.test').key);
  assert.ok(all.has('http://' + narrow.addr), 'HTTPS cannot be altered on the way, so there it is as good as any');

  const checked = pool.summary().checked;
  pool.addManual('http://' + liar.addr);
  await until(() => pool.summary().checked > checked);
  await sleep(100);
  const s = pool.summary();
  assert.equal(s.alive, 4, 'the page came back changed, and other proxies deliver it intact: never used');
  assert.ok(!s.proxies.some((p) => p.addr === liar.addr));
  assert.equal(s.sources.find((x) => x.id === 'manual').bad, 1);
  pool.stop();
});

test('vetting: a page that no proxy gets right is taken to have changed, and convicts nobody', async () => {
  const j = await judge('203.0.113.51', 'NL');
  const moved = await site({ '/ok.txt': { headers: { 'Content-Type': 'text/plain' }, body: 'something else now' } });
  const p = await httpProxy();
  const { pool } = makePool({ pool: { sources: [], judge: j.url + '/trace', canaries: [moved.url + '/ok.txt waddle-canary'] } });
  pool.start();
  pool.addManual('http://' + p.addr);
  await until(() => pool.summary().alive === 1);
  assert.equal(pool.summary().proxies[0].plain, false);
  assert.equal(pool.route('a.test', null, { plain: true }), null, 'not proven: no plain HTTP through it');
  assert.ok(pool.route('a.test'), 'and still an exit for HTTPS');
  pool.stop();
});

test('vetting: a header echo shows which exits announce themselves; those never carry plain HTTP', async () => {
  const w = await world();
  // Through the US exit the echo is one that saw a forwarding header: the mark of a proxy that says it is one.
  const told = await site({
    '/headers': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: Object.assign({ Via: '1.1 squid', 'X-Forwarded-For': '192.0.2.7, 203.0.113.10' }, req.headers) }));
    },
  });
  w.h.map(w.echoSite.port, told.port);
  const { pool } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, canaries: [w.canary], echo: w.echoUrl },
  });
  pool.start();
  await until(() => pool.summary().alive === 3 && pool.summary().plain === 2);
  const by = Object.fromEntries(pool.summary().proxies.map((p) => [p.cc, p]));
  assert.deepEqual([by.US.leaks, by.US.plain], [true, false]);
  assert.deepEqual([by.DE.leaks, by.DE.plain], [false, true]);
  assert.deepEqual([by.JP.leaks, by.JP.plain], [false, true]);
  for (let i = 0; i < 40; i++) assert.notEqual(pool.route('s' + i + '.test', null, { plain: true }).cc, 'US');

  // what counts as a leak
  const echoOf = (headers) => JSON.stringify({ headers });
  assert.equal(judgeEcho(echoOf({ Host: 'x', 'User-Agent': 'y' })), 'clean');
  assert.equal(
    judgeEcho(echoOf({ Host: 'x', 'X-Forwarded-For': '203.0.113.9' })),
    'clean',
    "the echo's own front end notes the one address it saw"
  );
  assert.equal(judgeEcho(echoOf({ Host: 'x', 'X-Forwarded-For': '192.0.2.1, 203.0.113.9' })), 'leaks');
  assert.equal(judgeEcho(echoOf({ Host: 'x', Via: '1.1 proxy' })), 'leaks');
  assert.equal(judgeEcho(echoOf({ Host: 'x', 'Proxy-Connection': 'keep-alive' })), 'leaks');
  assert.equal(judgeEcho('<html>not an echo</html>'), '');
  assert.equal(judgeEcho(JSON.stringify({ origin: '1.2.3.4' })), '', 'no request headers in it: no verdict');
  pool.stop();
});

// ---- housekeeping -------------------------------------------------------------------

test('own downloads: direct while proxies are scarce, through the pool once there are three to spare', async () => {
  const w = await world();
  const { pool } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  assert.equal(pool.lend(), null, 'nothing live yet: lists have to be fetched directly');
  pool.start();
  await until(() => pool.summary().alive === 3);
  assert.equal(pool.summary().sources[0].via, 'direct', 'the first download had no proxy to go through');
  const before = w.all.reduce((n, p) => n + p.log.length, 0);
  const hits = w.list.hits.length;
  await pool.harvest(true);
  assert.equal(w.list.hits.length, hits + 1);
  assert.equal(pool.summary().sources[0].via, 'proxy', 'with three live proxies the list host sees one of them instead');
  assert.equal(
    w.all.reduce((n, p) => n + p.log.length, 0),
    before + 1
  );
  pool.stop();
});

test('adaptive harvesting: sooner while short of proxies, later once full or when the network blocks them', async () => {
  const w = await world();
  const { pool, config } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, harvestMinutes: 30, target: 4 },
  });
  assert.equal(pool._interval(), 10 * 60000, 'nearly empty: three times as often');
  pool.start();
  await until(() => pool.summary().alive === 3);
  assert.equal(pool._interval(), 30 * 60000, 'most of the way there: the plain schedule');
  config.patch({ pool: { target: 3 } });
  assert.equal(pool._interval(), 60 * 60000, 'full: half as often');
  config.patch({ pool: { adaptive: false, target: 40 } });
  assert.equal(pool._interval(), 30 * 60000, 'switched off: exactly what the setting says');
  const s = pool.summary();
  assert.ok(s.nextHarvest > 0 && s.nextHarvest <= 1800, 'the summary says when the next round is due: ' + s.nextHarvest);
  pool.stop();
});

test('health in one word: off, empty, starting, ok', async () => {
  const w = await world();
  const a = makePool({ pool: { sources: [], judge: w.judgeUrl } });
  assert.equal(a.pool.health(), 'empty', 'no sources and nothing added by hand');
  a.config.patch({ pool: { on: false } });
  assert.equal(a.pool.health(), 'off');
  const b = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  b.pool.start();
  assert.equal(b.pool.health(), 'starting', 'lists are on their way and nothing has been tested yet');
  await until(() => b.pool.summary().alive === 3);
  assert.equal(b.pool.health(), 'ok');
  b.pool.stop();
  const gone = await site({});
  const c = makePool({ pool: { sources: [{ type: 'url', url: gone.url + '/none.txt', proto: null, on: true }], judge: w.judgeUrl } });
  c.pool.start();
  await until(() => c.pool.summary().sources[0].state === 'error');
  assert.equal(c.pool.health(), 'nolists', 'every list failed to download');
  c.pool.stop();
});

test('blame: a dead proxy is marked down at once; an exit that only failed to reach a site gets the benefit of the doubt', async () => {
  const w = await world();
  const { pool } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, recheckMinutes: 30 },
    route: { rotate: 'request' },
  });
  pool.start();
  await until(() => pool.summary().alive === 3);
  const errs = (p) => pool.summary().proxies.find((x) => x.addr === p.addr).errs;
  const exit = pool.route('a.test', new Set([w.s5.key, w.s4.key]));
  assert.equal(exit.key, w.h.key);

  // The exit answered and said it could not connect onward (the site may be down), or the exchange died later.
  const gone = new URL('http://127.0.0.1:1/');
  const e1 = await net.request({ url: gone, proxy: exit, fresh: true }).catch((x) => x);
  assert.deepEqual([e1.code, e1.stage, e1.auth], ['EPROXYREFUSED', 'handshake', undefined]);
  assert.deepEqual(pool.blame(exit, e1, true), { key: w.h.key, relay: false, doubt: true });
  const late = Object.assign(new Error('proxy timed out'), { code: 'EPROXYTIMEOUT', phase: 'proxy', culprit: exit });
  assert.equal(pool.blame(exit, late, true).doubt, true);
  const tls = Object.assign(new Error('wrong version number'), { code: 'EPROTO', phase: 'proxy', culprit: exit, stage: 'tls' });
  assert.equal(pool.blame(exit, tls, true).doubt, true);
  assert.equal(errs(w.h), 0, 'nothing is held against it yet');
  assert.equal(pool.summary().alive, 3);
  // ...unless the caller knows better (the pool's own test page, say): then it counts.
  assert.equal(pool.blame(exit, e1).doubt, false);
  assert.equal(errs(w.h), 1);
  pool.report(exit, true, 20);

  // Certain: it asks for a password, speaks something else, or cannot be reached at all.
  const locked = await httpProxy({ auth: 'u:p' });
  const e2 = await net.tunnel({ proto: 'http', host: '127.0.0.1', port: locked.port }, '127.0.0.1', w.main.port).catch((x) => x);
  assert.deepEqual([e2.code, e2.auth, e2.stage], ['EPROXYREFUSED', true, 'handshake']);
  const e3 = await net.tunnel({ proto: 'socks5', host: '127.0.0.1', port: w.h.port }, '127.0.0.1', w.main.port).catch((x) => x);
  assert.equal(e3.code, 'EPROXYBAD', 'an HTTP proxy spoken to in SOCKS');
  const e4 = await net.tunnel({ proto: 'http', host: '127.0.0.1', port: w.dead }, '127.0.0.1', w.main.port).catch((x) => x);
  assert.deepEqual([e4.code, e4.stage, e4.hop], ['ECONNREFUSED', 'connect', 0]);
  for (const e of [e2, e3, e4]) assert.equal(pool.blame(exit, Object.assign(e, { culprit: exit }), true).doubt, false, e.code);
  assert.equal(pool.summary().alive, 2, 'three certain failures in a row: out');

  // A relay that would not connect onward is no use as a relay, and is not marked down as an exit.
  const chain = pool.route('b.test', null, { hops: 2 });
  const relay = chain.via[0];
  const refused = Object.assign(new Error('proxy refused CONNECT (403)'), {
    code: 'EPROXYREFUSED',
    phase: 'proxy',
    culprit: relay,
    stage: 'handshake',
  });
  assert.deepEqual(pool.blame(chain, refused, true), { key: relay.key, relay: true, doubt: false });
  assert.equal(pool.blame(chain, refused, true).relay, true);
  assert.equal(pool.summary().alive, 2);
  assert.equal(pool.summary().proxies.find((x) => x.addr === relay.host + ':' + relay.port).relay, false);
  for (let i = 0; i < 20; i++) {
    const r = pool.route('b.test', null, { hops: 2 });
    assert.ok(!r.via.some((c) => c.key === relay.key), 'it is not put in the middle of a chain again');
    // It can still be the exit, with the other proxy in front; when the other one is the exit, nothing is left to relay.
    assert.equal(r.via.length, r.key === relay.key ? 1 : 0);
  }
  pool.stop();
});

test('five failures with nothing carried in between drop a proxy, however often it passes the pool’s own test', async () => {
  const w = await world();
  const { pool } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
    route: { rotate: 'request' },
  });
  pool.start();
  await until(() => pool.summary().alive === 3);
  const exit = pool.route('a.test', new Set([w.s5.key, w.s4.key]));
  for (let i = 0; i < 4; i++) {
    pool.report(exit, false);
    // each failure has it tested again at once; it passes (the judge is all it is good for), which forgives the streak
    await until(() => exit.cand.streak === 0, 3000);
    assert.equal(pool.summary().alive, 3, 'after failure ' + (i + 1));
  }
  pool.report(exit, false);
  assert.equal(pool.summary().alive, 2, 'the fifth is one too many');
  // One page carried wipes the slate.
  const other = pool.route('a.test', new Set([w.s4.key]));
  for (let i = 0; i < 4; i++) {
    pool.report(other, false);
    await until(() => other.cand.streak === 0, 3000);
  }
  pool.report(other, true, 30);
  pool.report(other, false);
  assert.equal(pool.summary().alive, 2);
  pool.stop();
});

test('a second try borrows another exit without moving the site; the site moves when the page loads there', async () => {
  const w = await world();
  const { pool, config } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3);
  const home = pool.route('a.test');
  for (let i = 0; i < 10; i++) {
    const borrowed = pool.route('a.test', new Set([home.key]));
    assert.notEqual(borrowed.key, home.key);
    assert.equal(pool.route('a.test').key, home.key, 'one file that needed another exit does not move the page');
  }
  assert.equal(pool.peek('a.test').key, home.key);
  const other = pool.route('a.test', new Set([home.key]));
  pool.pin('a.test', other);
  for (let i = 0; i < 10; i++) assert.equal(pool.route('a.test').key, other.key);
  // A site with no exit yet takes the one a second try finds.
  const fresh = pool.route('new.test', new Set([home.key]));
  assert.equal(pool.route('new.test').key, fresh.key);

  // "One exit for everything, changed on a timer" behaves the same way.
  config.patch({ route: { rotate: 'timed' } });
  const timed = pool.route('x.test');
  assert.equal(pool.route('y.test').key, timed.key);
  const lent = pool.route('x.test', new Set([timed.key]));
  assert.notEqual(lent.key, timed.key);
  assert.equal(pool.route('z.test').key, timed.key);
  pool.pin('x.test', lent);
  assert.equal(pool.route('z.test').key, lent.key);
  pool.stop();
});

test('an exit that no allowed entry can be put in front of is passed over for one that can', async () => {
  const w = await world();
  const { pool, config } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
    route: { hops: 2, entry: ['JP'], rotate: 'sticky' },
  });
  pool.start();
  await until(() => pool.summary().alive === 3);
  for (let i = 0; i < 40; i++) {
    const r = pool.route('site' + i + '.test');
    assert.ok(r, 'site ' + i);
    assert.deepEqual([r.via.length, r.via[0].cc], [1, 'JP']);
    assert.notEqual(r.cc, 'JP');
    assert.equal(pool.route('site' + i + '.test').key, r.key, 'and the site stays with the exit it ended up with');
  }
  config.patch({ route: { rotate: 'request', countries: ['JP'] } });
  assert.equal(pool.route('only-jp.test'), null, 'the only allowed exit is also the only allowed entry: no chain');
  config.patch({ route: { countries: [], entry: ['FR'] } });
  assert.equal(pool.route('any.test'), null);
  config.patch({ route: { entry: [], hops: 3 } });
  const three = pool.route('any.test');
  assert.equal(three.via.length, 2);
  pool.stop();
});

test('response-time test: an address nothing can reach is not held against the proxies', async () => {
  const w = await world();
  const up = await site({ '/': { body: 'ok' } });
  const { pool } = makePool({
    pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, canaries: [w.canary] },
  });
  pool.start();
  await until(() => pool.summary().alive === 3 && pool.summary().proxies.every((p) => p.plain));
  const errs = () => pool.summary().proxies.reduce((n, p) => n + p.errs, 0);
  const down = await pool.speed('http://127.0.0.1:1/');
  assert.equal(down.length, 3);
  for (const r of down) assert.ok(r.error && r.failed === undefined, JSON.stringify(r));
  assert.equal(errs(), 0);
  // One exit alone cannot reach an address the others can: that one is marked.
  w.s5.opt.refuse = true;
  const mixed = await pool.speed(up.url + '/');
  assert.equal(mixed.filter((r) => r.error).length, 1);
  assert.equal(errs(), 1);
  assert.equal(pool.summary().proxies.find((p) => p.addr === w.s5.addr).errs, 1);
  pool.stop();
});

test('a third party on a page leaves from the page’s exit; when it cannot, it gets one of its own and the page stays put', async () => {
  const w = await world();
  const { pool, config } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3);
  const page = pool.route('a.test');
  for (let i = 0; i < 10; i++) assert.equal(pool.route('a.test', null, { guest: 'cdn.test' }).key, page.key);

  // A rule sends one third party through another country: it goes there, every time through the same exit, and nothing else moves.
  const abroad = ['US', 'DE', 'JP'].filter((cc) => cc !== page.cc);
  const ads = pool.route('a.test', null, { guest: 'ads.test', countries: abroad });
  assert.ok(abroad.includes(ads.cc));
  for (let i = 0; i < 10; i++) {
    assert.equal(pool.route('a.test', null, { guest: 'ads.test', countries: abroad }).key, ads.key);
    assert.equal(pool.route('a.test').key, page.key, 'the page has not moved');
    assert.equal(pool.route('a.test', null, { guest: 'cdn.test' }).key, page.key, 'nor have its other third parties');
  }

  // A third party that turned the page's exit away is remembered apart: the page's own record stays clean.
  pool.remember('a.test', page, false, 'frame.test');
  pool.rotate('a.test', 'frame.test');
  const frame = pool.route('a.test', null, { guest: 'frame.test' });
  assert.notEqual(frame.key, page.key);
  for (let i = 0; i < 10; i++) {
    assert.equal(pool.route('a.test', null, { guest: 'frame.test' }).key, frame.key);
    assert.equal(pool.route('a.test').key, page.key);
  }
  // On another site's page the same third party starts again from that page's exit.
  const b = pool.route('b.test');
  assert.equal(pool.route('b.test', null, { guest: 'frame.test' }).key, b.key);
  // A second try for a third party borrows an exit too, and moves neither the page nor (once it has one) the third party.
  assert.notEqual(pool.route('a.test', new Set([page.key]), { guest: 'cdn.test' }).key, page.key);
  assert.equal(pool.route('a.test', null, { guest: 'cdn.test' }).key, page.key);
  assert.notEqual(pool.route('a.test', new Set([frame.key]), { guest: 'frame.test' }).key, frame.key);
  assert.equal(pool.route('a.test', null, { guest: 'frame.test' }).key, frame.key);
  // pin() with a guest moves the guest alone.
  const third = w.all.map((p) => p.key).find((k) => k !== page.key && k !== frame.key);
  pool.pin('a.test', { key: third }, 'frame.test');
  assert.equal(pool.route('a.test', null, { guest: 'frame.test' }).key, third);
  assert.equal(pool.route('a.test').key, page.key);

  // "New exit" for the site takes its third parties along.
  let moved = null;
  for (let i = 0; i < 40 && !moved; i++) {
    pool.rotate('a.test');
    const now = pool.route('a.test');
    if (now.key !== page.key && now.key !== third) moved = now;
  }
  assert.ok(moved);
  assert.equal(pool.route('a.test', null, { guest: 'cdn.test' }).key, moved.key);
  assert.equal(pool.route('b.test').key, b.key, 'other sites are left alone');

  // One exit for everything (changed on a timer): the same rules, with one page-exit for all sites.
  config.patch({ route: { rotate: 'timed' } });
  const all = pool.route('x.test');
  assert.equal(pool.route('y.test', null, { guest: 'cdn.test' }).key, all.key);
  const far = ['US', 'DE', 'JP'].filter((cc) => cc !== all.cc);
  const lent = pool.route('y.test', null, { guest: 'ads.test', countries: far });
  assert.ok(far.includes(lent.cc));
  assert.equal(pool.route('z.test').key, all.key, 'the one exit stays');
  assert.equal(pool.route('z.test', null, { guest: 'ads.test', countries: far }).key, lent.key);
  // A site's own needs do move it.
  const own = pool.route('z.test', null, { countries: far });
  assert.ok(far.includes(own.cc));
  assert.equal(pool.route('x.test').key, own.key);
  pool.stop();
});
