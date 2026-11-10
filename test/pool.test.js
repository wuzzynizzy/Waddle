'use strict';
const { site, judge, tarball, world, closeAll, until, sleep } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Config, DATA_DIR } = require('../lib/config');
const { Pool, fetchSource, sourceId, endpoints } = require('../lib/pool');
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
    dns: { mode: 'system' },
    pool: Object.assign({ discover: false, checkTimeout: 1500, concurrency: 20, target: 40, recheckMinutes: 30 }, patch.pool),
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

test('response-time test: direct and each live proxy, timed side by side', async () => {
  const w = await world();
  const slowSite = await site({ '/': (req, res) => setTimeout(() => res.end('ok'), 60) });
  const { pool } = makePool({ pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl } });
  pool.start();
  await until(() => pool.summary().alive === 3);
  const rows = await pool.speed(slowSite.url + '/');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].via, 'direct');
  for (const r of rows) {
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.ok(r.ms >= 55 && r.ms < 1500, r.via + ': ' + r.ms + ' ms');
  }
  assert.deepEqual(
    rows
      .slice(1)
      .map((r) => r.via.split(' ')[1])
      .sort(),
    ['DE', 'JP', 'US']
  );
  const def = await pool.speed();
  assert.equal(def.length, 4, 'defaults to the judge');
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
