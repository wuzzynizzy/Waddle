'use strict';
// Response-time checks. Budgets are generous (CI machines are slow and noisy): they exist to
// catch a regression of an order of magnitude, not to benchmark. Run `npm run bench` for numbers.
const { site, browser, world, doh, closeAll, until, median } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const net = require('../lib/net');
const { Config } = require('../lib/config');
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

async function start(patch = {}) {
  const app = createApp();
  app.config.reset();
  app.config.patch(
    Object.assign({ dns: { mode: 'system' } }, patch, {
      pool: Object.assign({ on: false, sources: [], discover: false, checkTimeout: 1500 }, patch.pool),
    })
  );
  const { port } = await app.listen(0, '127.0.0.1');
  apps.push(app);
  return { app, port, b: browser(port) };
}

const row =
  '<div class="item"><a href="/item/123?ref=list&amp;x=1" title="An item">Item</a><img src="/img/123.jpg" srcset="/img/123.jpg 1x, /img/123@2x.jpg 2x" alt=""><p>Some text about the item.</p></div>\n';
const page = (rows) =>
  '<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/s.css"></head><body>' + row.repeat(rows) + '</body></html>';

test('overhead: a proxied page costs a few milliseconds more than fetching it directly', async (t) => {
  const html = page(300); // ~60 KB, a typical document
  const s = await site({
    '/': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html },
    '/pic': { headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(20000, 1) },
  });
  const { b } = await start();
  const direct = await timed(60, async () => {
    const r = await net.request({ url: new URL(s.url + '/') });
    await net.readAll(r);
  });
  await b.page(s.url + '/'); // warm up: session, connection
  const viaDoc = await timed(60, () => b.page(s.url + '/'));
  const viaBin = await timed(60, () => b.fetch(s.url + '/pic', s.url + '/', { dest: 'image' }));
  t.diagnostic(
    `direct ${fmt(direct.median)} | proxied page ${fmt(viaDoc.median)} (p95 ${fmt(viaDoc.p95)}) | proxied image ${fmt(viaBin.median)}`
  );
  assert.ok(viaDoc.median - direct.median < 40, 'median overhead for a 60 KB page: ' + fmt(viaDoc.median - direct.median));
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

test('concurrency: 200 simultaneous requests are all answered, quickly', async (t) => {
  const s = await site({ '/': { headers: { 'Content-Type': 'text/html' }, body: page(50) } });
  const { b } = await start();
  await b.page(s.url + '/');
  const t0 = process.hrtime.bigint();
  const all = await Promise.all(Array.from({ length: 200 }, (_, i) => b.page(s.url + '/?n=' + i)));
  const total = ms(t0);
  t.diagnostic(`200 concurrent pages in ${fmt(total)} (${(200 / (total / 1000)).toFixed(0)} req/s)`);
  assert.ok(all.every((r) => r.status === 200));
  assert.ok(total < 8000, '200 concurrent pages took ' + fmt(total));
});

test('through proxies: each hop adds little; connections are reused', async (t) => {
  const s = await site({ '/': { headers: { 'Content-Type': 'text/html' }, body: page(50) } });
  const w = await world();
  const { app, b } = await start({
    route: { mode: 'proxy', rotate: 'sticky' },
    pool: { on: true, sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
  });
  await until(() => app.pool.summary().alive === 3, 8000);
  const out = {};
  for (const hops of [1, 2, 3]) {
    app.config.patch({ route: { hops } });
    const t0 = process.hrtime.bigint();
    const cold = await b.page(s.url + '/');
    const first = ms(t0);
    assert.equal(cold.status, 200);
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
  // Counted in TCP connections: an HTTP exit is handed every plain-HTTP request by name, so its
  // request log grows with the traffic even when one connection carries all of it.
  for (const p of w.all)
    assert.ok(
      p.conns < 30,
      'connections were reused rather than opened per request (' + p.cc + ' accepted ' + p.conns + ' for 120+ requests)'
    );
  t.diagnostic('connections accepted for 123 requests: ' + w.all.map((p) => p.cc + ' ' + p.conns).join(', '));
});

test('a slow or dead exit does not hold a page hostage: it is dropped and the next one answers', async (t) => {
  const s = await site({ '/': { headers: { 'Content-Type': 'text/html' }, body: page(10) } });
  const w = await world();
  const { app, b } = await start({
    route: { mode: 'auto', rotate: 'request', retries: 2 },
    pool: { on: true, sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
  });
  await until(() => app.pool.summary().alive === 3, 8000);
  await w.h.close();
  await w.s5.close(); // two of three exits die without warning
  net.dropAgents();
  const runs = await timed(20, async () => {
    const r = await b.page(s.url + '/');
    assert.equal(r.status, 200);
  });
  t.diagnostic(`with 2 of 3 exits dead: median ${fmt(runs.median)}, worst ${fmt(runs.max)}`);
  assert.ok(runs.max < 2000, 'worst page load ' + fmt(runs.max));
  await until(() => app.pool.summary().alive === 1, 5000);
  const after = await timed(20, () => b.page(s.url + '/'));
  assert.ok(after.median < 60, 'once the dead exits are evicted, back to normal: ' + fmt(after.median));
});

test('measurements shown in the panel are real: proxy latency, speed test, DNS test', async () => {
  const slow = await site({
    '/': (req, res) =>
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
      }, 80),
  });
  const w = await world();
  const { app, b } = await start({
    route: { mode: 'proxy' },
    pool: { on: true, sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
  });
  await until(() => app.pool.summary().alive === 3, 8000);
  await b.page(slow.url + '/');
  const last = (await b.api('state')).json.pool.last;
  assert.ok(last.ms >= 75 && last.ms < 1000, 'route time reflects the 80 ms the site took: ' + last.ms);
  const speed = (await b.api('pool', { action: 'speed', url: slow.url + '/' })).json.results;
  for (const r of speed) assert.ok(r.ms >= 75 && r.ms < 1500, r.via + ': ' + r.ms);

  const fast = await doh({ 'site.test': ['10.0.0.1'] });
  const lag = await doh({ 'site.test': ['10.0.0.1'] }, { delay: 150 });
  const config = new Config();
  config.patch({ dns: { mode: 'doh', servers: [fast.url, lag.url], fallback: false } });
  const rows = await new Resolver(config).test('site.test');
  assert.ok(rows[0].ms < 100, 'fast resolver: ' + rows[0].ms);
  assert.ok(rows[1].ms >= 140 && rows[1].ms < 1000, 'slow resolver: ' + rows[1].ms);
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
  const config = new Config();
  config.patch({ dns: { mode: 'doh', strategy: 'fallback', servers: [dead.url, good.url], fallback: false } });
  const r = new Resolver(config);
  await r.resolve('a.test');
  const cached = await timed(2000, () => r.resolve('a.test'));
  assert.ok(cached.median < 0.5, 'cached lookup: ' + fmt(cached.median));
  for (const name of ['b.test', 'c.test', 'd.test', 'e.test']) await r.resolve(name);
  t.diagnostic(`cached lookup ${(cached.median * 1000).toFixed(0)} µs; dead resolver asked ${dead.log.length} times for 5 names`);
  assert.ok(dead.log.length <= 3, 'the dead resolver was rested after 3 failures (asked ' + dead.log.length + ' times)');
  config.reset();
});
