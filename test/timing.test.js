'use strict';
// Response-time checks. Budgets are generous (CI machines are slow and noisy): they exist to
// catch a regression of an order of magnitude, not to benchmark. Every page here travels the
// way pages always do in Waddle: through an exit (a stand-in on this machine).
const { site, browser, world, judge, canary, httpProxy, doh, closeAll, until, median } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const net = require('../lib/net');
const { Config, DATA_DIR } = require('../lib/config');
const { Resolver } = require('../lib/dns');

const apps = [];
test.after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  net.dropAgents();
  await closeAll();
});

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
async function timed(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn(i);
    out.push(ms(t0));
  }
  return { median: median(out), p95: out.slice().sort((a, b) => a - b)[Math.floor(n * 0.95)], max: Math.max(...out) };
}
const fmt = (x) => x.toFixed(1) + ' ms';

let shared;
async function exits() {
  if (!shared) shared = { judge: await judge('203.0.113.10', 'US'), canary: await canary(), px: await httpProxy() };
  return shared;
}

/**
 * A Waddle server cut off from everything outside this machine, with one live exit
 * (or, with `{ exit: false }`, whatever proxies the test's own settings bring).
 */
async function start(patch = {}, opt = {}) {
  const k = await exits();
  const app = createApp();
  app.config.reset();
  app.config.patch(
    Object.assign({}, patch, {
      dns: Object.assign({ auto: false, fallback: false }, patch.dns),
      route: Object.assign({ https: false }, patch.route),
      pool: Object.assign(
        { sources: [], discover: false, checkTimeout: 1500, judge: k.judge.url + '/trace', canaries: [k.canary.line], echo: '' },
        patch.pool
      ),
    })
  );
  const { port } = await app.listen(0, '127.0.0.1');
  apps.push(app);
  if (opt.exit !== false) {
    app.pool.addManual('http://127.0.0.1:' + k.px.port);
    await until(() => app.pool.alive.size === 1 && app.pool.summary().proxies[0].plain === true, 8000);
  }
  return { app, port, b: browser(port), px: k.px };
}

/** The same, fed by the little internet from support.world(): three exits of three kinds. */
async function routed(route) {
  const w = await world();
  const ctx = await start(
    { route, pool: { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, canaries: [w.canary] } },
    { exit: false }
  );
  await until(() => ctx.app.pool.summary().plain === 3, 8000);
  return Object.assign(ctx, { w });
}

const row =
  '<div class="item"><a href="/item/123?ref=list&amp;x=1" title="An item">Item</a><img src="/img/123.jpg" srcset="/img/123.jpg 1x, /img/123@2x.jpg 2x" alt=""><p>Some text about the item.</p></div>\n';
const page = (rows) =>
  '<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/s.css"></head><body>' + row.repeat(rows) + '</body></html>';

test('overhead: a page through Waddle costs a few milliseconds more than the same page through the exit alone', async (t) => {
  const html = page(300); // ~60 KB, a typical document
  const s = await site({
    '/': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html },
    '/pic': { headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(20000, 1) },
  });
  const { b, px } = await start();
  // The yardstick: the bare request through the same exit, with nothing rewritten and no session.
  const exit = { proto: 'http', host: '127.0.0.1', port: px.port };
  const bare = await timed(60, async () => {
    const r = await net.request({ url: new URL(s.url + '/'), proxy: exit });
    await net.readAll(r);
  });
  await b.page(s.url + '/'); // warm up: session, connection
  const viaDoc = await timed(60, () => b.page(s.url + '/'));
  const viaBin = await timed(60, () => b.fetch(s.url + '/pic', s.url + '/', { dest: 'image' }));
  t.diagnostic(
    `through the exit alone ${fmt(bare.median)} | page through Waddle ${fmt(viaDoc.median)} (p95 ${fmt(viaDoc.p95)}) | image through Waddle ${fmt(viaBin.median)}`
  );
  assert.ok(viaDoc.median - bare.median < 40, 'median overhead for a 60 KB page: ' + fmt(viaDoc.median - bare.median));
  assert.ok(viaBin.median < 40, 'pass-through median: ' + fmt(viaBin.median));
});

test('first byte: binary bodies are streamed, not held until complete', async () => {
  let release;
  const s = await site({
    '/stream': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.write(Buffer.alloc(65536, 1));
      release = () => res.end(Buffer.alloc(1000, 2));
    },
  });
  const { port } = await start();
  const http = require('http');
  const t0 = process.hrtime.bigint();
  const first = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/~/' + s.url + '/stream', agent: false, headers: { 'Sec-Fetch-Dest': 'video' } }, (res) => {
        res.once('data', () => {
          resolve(ms(t0));
          res.on('data', () => {});
        });
      })
      .on('error', reject);
  });
  assert.ok(first < 500, 'first bytes arrived after ' + fmt(first) + ' while the upstream was still sending');
  release();
});

test('throughput: a 2 MB page is rewritten quickly and the time is reported', async (t) => {
  const html = page(10000);
  const s = await site({ '/big': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html } });
  const { b } = await start();
  await b.page(s.url + '/big');
  const t0 = process.hrtime.bigint();
  const r = await b.page(s.url + '/big');
  const total = ms(t0);
  const rw = Number(/rw;dur=(\d+)/.exec(r.headers['server-timing'])[1]);
  t.diagnostic(
    `${(html.length / 1048576).toFixed(1)} MB page: total ${fmt(total)}, rewrite ${rw} ms (${(html.length / 1048576 / (rw / 1000 || 0.001)).toFixed(0)} MB/s)`
  );
  assert.equal(r.text.split('/~/' + s.url + '/item/123').length - 1, 10000);
  assert.ok(rw < 1500, 'rewrite took ' + rw + ' ms');
  assert.ok(total < 3000, 'total ' + fmt(total));
});

test('concurrency: 200 simultaneous requests through one exit are all answered, quickly', async (t) => {
  const s = await site({ '/': { headers: { 'Content-Type': 'text/html' }, body: page(50) } });
  const { b, px } = await start();
  await b.page(s.url + '/');
  const before = px.conns;
  const t0 = process.hrtime.bigint();
  const all = await Promise.all(Array.from({ length: 200 }, (_, i) => b.page(s.url + '/?n=' + i)));
  const total = ms(t0);
  t.diagnostic(
    `200 concurrent pages in ${fmt(total)} (${(200 / (total / 1000)).toFixed(0)} req/s) over ${px.conns - before} new connections to the exit`
  );
  assert.ok(all.every((r) => r.status === 200));
  assert.ok(total < 8000, '200 concurrent pages took ' + fmt(total));
  // (Not one per request. Fewer than a quarter of them: twelve at a time, some closed and reopened as the burst ebbs.)
  assert.ok(px.conns - before < 50, 'a burst does not open a connection per request: the exit saw ' + (px.conns - before) + ' new ones');
});

test('through proxies: each hop adds little; connections are reused', async (t) => {
  const s = await site({ '/': { headers: { 'Content-Type': 'text/html' }, body: page(50) } });
  const { app, b, w } = await routed({ rotate: 'sticky' });
  const base = w.all.map((p) => p.conns);
  const out = {};
  for (const hops of [1, 2, 3]) {
    app.config.patch({ route: { hops } });
    const t0 = process.hrtime.bigint();
    const cold = await b.page(s.url + '/');
    const first = ms(t0);
    assert.equal(cold.status, 200);
    assert.equal((await b.api('state')).json.pool.last.hops.length, hops);
    const warm = await timed(40, () => b.page(s.url + '/'));
    out[hops] = { first, warm: warm.median };
    assert.ok(first < 1500, hops + ' hop(s), first request (builds the tunnel): ' + fmt(first));
    assert.ok(warm.median < 60, hops + ' hop(s), later requests (reuse it): ' + fmt(warm.median));
  }
  t.diagnostic(
    Object.entries(out)
      .map(([h, v]) => `${h} hop${h > 1 ? 's' : ''}: first ${fmt(v.first)}, then ${fmt(v.warm)}`)
      .join(' | ')
  );
  const opened = w.all.map((p, i) => p.conns - base[i]);
  for (const [i, p] of w.all.entries())
    assert.ok(
      opened[i] < 30,
      'connections were reused rather than opened per request (' + p.cc + ' accepted ' + opened[i] + ' for 120+ requests)'
    );
  t.diagnostic('connections accepted for 123 requests: ' + w.all.map((p, i) => p.cc + ' ' + opened[i]).join(', '));
});

test('a dead exit does not hold a page hostage: the next one answers, and the dead one is dropped', async (t) => {
  const s = await site({ '/': { headers: { 'Content-Type': 'text/html' }, body: page(10) } });
  const { app, b, w } = await routed({ rotate: 'sticky', retries: 2 });
  await w.h.close();
  await w.s5.close(); // two of three exits die without warning
  net.dropAgents();
  const worst = [];
  // The site sits on one dead exit, then on the other: each time the page has to find its way to the one that is left.
  for (const dead of [w.h, w.s5]) {
    app.pool.pin('127.0.0.1', { key: dead.key });
    const t0 = process.hrtime.bigint();
    const r = await b.page(s.url + '/');
    worst.push(ms(t0));
    assert.equal(r.status, 200);
    assert.equal((await b.api('state')).json.pool.last.hops[0].cc, 'JP');
  }
  t.diagnostic(`with 2 of 3 exits dead, a page pinned to a dead one took ${worst.map(fmt).join(' and ')}`);
  assert.ok(Math.max(...worst) < 2000, 'worst page load ' + fmt(Math.max(...worst)));
  await until(() => app.pool.summary().alive === 1, 5000);
  const after = await timed(20, () => b.page(s.url + '/'));
  assert.ok(after.median < 60, 'once the dead exits are evicted, back to normal: ' + fmt(after.median));
});

test('measurements shown in the panel are real: route time, response-time test, resolver test', async () => {
  const slow = await site({
    '/': (req, res) =>
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
      }, 80),
  });
  const { b, w } = await routed({});
  await b.page(slow.url + '/');
  const last = (await b.api('state')).json.pool.last;
  assert.ok(last.ms >= 75 && last.ms < 1000, 'route time reflects the 80 ms the site took: ' + last.ms);
  const speed = (await b.api('pool', { action: 'speed', url: slow.url + '/' })).json.results;
  assert.equal(speed.length, 3, 'one row per exit; there is no direct connection to time');
  for (const r of speed) assert.ok(r.ms >= 75 && r.ms < 1500, r.via + ': ' + r.ms);

  // Resolvers are timed the way they are used: through an exit.
  const fast = await doh({ 'site.test': ['10.0.0.1'] });
  const lag = await doh({ 'site.test': ['10.0.0.1'] }, { delay: 150 });
  const config = new Config();
  config.reset();
  config.patch({ dns: { servers: [fast.url, lag.url], fallback: false, auto: false, pad: false } });
  fs.rmSync(path.join(DATA_DIR, 'dns.json'), { force: true });
  const resolver = new Resolver(config);
  const via = { proto: w.h.proto, host: w.h.host, port: w.h.port, via: [] };
  const rows = await resolver.test('site.test', via);
  assert.deepEqual(
    rows.map((x) => x.address),
    ['10.0.0.1', '10.0.0.1']
  );
  assert.ok(rows[0].ms < 100, 'fast resolver: ' + rows[0].ms);
  assert.ok(rows[1].ms >= 140 && rows[1].ms < 1000, 'slow resolver: ' + rows[1].ms);
  assert.deepEqual(
    (await resolver.test('site.test')).map((x) => x.error),
    ['no proxy', 'no proxy'],
    'with no exit there is nothing to time: a typed name is never asked about directly'
  );
  config.reset();
});

test('DNS: cached names cost nothing; a dead resolver costs one timeout, not one per lookup', async (t) => {
  const good = await doh({
    'a.test': ['10.0.0.1'],
    'b.test': ['10.0.0.2'],
    'c.test': ['10.0.0.3'],
    'd.test': ['10.0.0.4'],
    'e.test': ['10.0.0.5'],
  });
  const dead = await doh({}, { fail: 500 });
  const px = (await exits()).px;
  const via = { proto: px.proto, host: px.host, port: px.port, via: [] };
  const config = new Config();
  config.reset();
  config.patch({ dns: { strategy: 'fallback', servers: [dead.url, good.url], fallback: false, auto: false, pad: false } });
  fs.rmSync(path.join(DATA_DIR, 'dns.json'), { force: true });
  const r = new Resolver(config);
  await r.resolve('a.test', { via });
  const cached = await timed(2000, () => r.resolve('a.test', { via }));
  assert.ok(cached.median < 0.5, 'cached lookup: ' + fmt(cached.median));
  for (const name of ['b.test', 'c.test', 'd.test', 'e.test']) await r.resolve(name, { via });
  t.diagnostic(`cached lookup ${(cached.median * 1000).toFixed(0)} µs; dead resolver asked ${dead.log.length} times for 5 names`);
  assert.ok(dead.log.length <= 3, 'the dead resolver was rested after 3 failures (asked ' + dead.log.length + ' times)');
  config.reset();
});
