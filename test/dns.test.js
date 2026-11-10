'use strict';
const { doh, closeAll, sleep } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Config } = require('../lib/config');
const { Resolver, encodeQuery, decodeAnswer } = require('../lib/dns');

test.after(closeAll);

function resolverFor(servers, extra) {
  const config = new Config();
  config.reset();
  config.patch({
    dns: Object.assign({ mode: 'doh', strategy: 'fallback', servers: servers.map((s) => s.url || s), fallback: false }, extra),
  });
  return new Resolver(config);
}

test('wire format: query encoding and answer decoding', () => {
  const q = encodeQuery('www.example.com', 1);
  assert.equal(q.readUInt16BE(0), 0, 'id 0, so answers can be cached by intermediaries (RFC 8484)');
  assert.equal(q.readUInt16BE(4), 1, 'one question');
  assert.equal(q.subarray(12).toString('latin1'), '\x03www\x07example\x03com\x00\x00\x01\x00\x01');
  assert.throws(() => encodeQuery('a..b', 1));
  assert.throws(() => encodeQuery('x'.repeat(64) + '.com', 1));

  // header, question, a CNAME (skipped), two A records and an AAAA record, using name compression
  const answer = Buffer.concat([
    Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 4, 0, 0, 0, 0]),
    q.subarray(12),
    Buffer.from([0xc0, 0x0c, 0, 5, 0, 1, 0, 0, 0, 30, 0, 2, 0xc0, 0x10]),
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 93, 184, 216, 34]),
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4]),
    Buffer.from([0xc0, 0x0c, 0, 28, 0, 1, 0, 0, 0, 60, 0, 16, 0x26, 0x06, 0x28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  ]);
  assert.deepEqual(decodeAnswer(answer), {
    rcode: 0,
    answers: [
      { ttl: 300, address: '93.184.216.34' },
      { ttl: 60, address: '1.2.3.4' },
      { ttl: 60, address: '2606:2800:0:0:0:0:0:1' },
    ],
  });
  assert.equal(decodeAnswer(Buffer.from([0, 0, 0x81, 0x83, 0, 0, 0, 0, 0, 0, 0, 0])).rcode, 3);
  assert.throws(() => decodeAnswer(answer.subarray(0, answer.length - 5)), 'a truncated answer is an error, not a wrong address');
  assert.throws(() => decodeAnswer(Buffer.from([1, 2, 3])));
});

test('lookups go to the DoH server and are cached', async () => {
  const a = await doh({ 'site.test': ['10.1.2.3', '10.1.2.4'] });
  const r = resolverFor([a]);
  const first = await r.resolve('site.test');
  assert.deepEqual(first.addresses, ['10.1.2.3', '10.1.2.4']);
  assert.equal(first.via, a.name);
  assert.deepEqual(a.log, [{ name: 'site.test', type: 1 }]);
  await r.resolve('SITE.test.');
  await Promise.all([r.resolve('site.test'), r.resolve('site.test')]);
  assert.equal(a.log.length, 1, 'answered from cache');
  assert.equal(await r.resolve4('site.test'), '10.1.2.3');
  r.flush();
  await r.resolve('site.test');
  assert.equal(a.log.length, 2, 'flush empties the cache');
  assert.deepEqual((await r.resolve('8.8.8.8')).addresses, ['8.8.8.8'], 'literals need no lookup');
});

test('concurrent lookups of one name share a single query', async () => {
  const a = await doh({ 'busy.test': ['10.0.0.1'] }, { delay: 40 });
  const r = resolverFor([a]);
  await Promise.all(Array.from({ length: 20 }, () => r.resolve('busy.test')));
  assert.equal(a.log.length, 1);
});

test('stacking, in order: the next resolver takes over when one fails', async () => {
  const down = await doh({}, { fail: 500 });
  const up = await doh({ 'site.test': ['10.9.9.9'] });
  const r = resolverFor([down, up]);
  const got = await r.resolve('site.test');
  assert.deepEqual(got.addresses, ['10.9.9.9']);
  assert.equal(got.via, up.name);
  assert.equal(down.log.length, 1);

  // After three failures in a row a server is rested instead of being asked every time.
  await r.resolve('b.test').catch(() => {});
  await r.resolve('c.test').catch(() => {});
  const before = down.log.length;
  await r.resolve('d.test').catch(() => {});
  assert.equal(down.log.length, before, 'a dead server is skipped');
  const s = r.summary();
  assert.equal(s.servers[0].down, true);
  assert.equal(s.servers[1].down, false);
  assert.ok(s.servers[1].ok >= 1);
  assert.ok(s.servers[0].fail >= 3);
});

test('stacking, fastest: resolvers race and the first answer wins', async () => {
  const slow = await doh({ 'site.test': ['10.0.0.1'] }, { delay: 250 });
  const fast = await doh({ 'site.test': ['10.0.0.2'] });
  const r = resolverFor([slow, fast], { strategy: 'race' });
  const t0 = Date.now();
  const got = await r.resolve('site.test');
  assert.deepEqual(got.addresses, ['10.0.0.2']);
  assert.equal(got.via, fast.name);
  assert.ok(Date.now() - t0 < 200, 'did not wait for the slow one');
  assert.equal(slow.log.length, 1, 'both were asked');

  const broken = await doh({}, { fail: 503 });
  const r2 = resolverFor([broken, slow], { strategy: 'race' });
  assert.deepEqual((await r2.resolve('site.test')).addresses, ['10.0.0.1'], 'a failing racer does not sink the race');
});

test('stacking, rotate: questions are spread across resolvers', async () => {
  const a = await doh({ 'one.test': ['10.0.0.1'], 'two.test': ['10.0.0.1'], 'three.test': ['10.0.0.1'], 'four.test': ['10.0.0.1'] });
  const b = await doh(a.hosts);
  const r = resolverFor([a, b], { strategy: 'rotate' });
  const via = [];
  for (const name of ['one.test', 'two.test', 'three.test', 'four.test']) via.push((await r.resolve(name)).via);
  assert.deepEqual(via, [a.name, b.name, a.name, b.name]);
  assert.equal(a.log.length, 2);
  assert.equal(b.log.length, 2);
});

test('"no such host" is final: it is not retried down the stack, and it is cached', async () => {
  const a = await doh({});
  const b = await doh({ 'ghost.test': ['10.6.6.6'] });
  const r = resolverFor([a, b], { fallback: true });
  await assert.rejects(r.resolve('ghost.test'), { code: 'ENOTFOUND' });
  assert.equal(b.log.length, 0, 'a second resolver is not shopped for a different answer');
  await assert.rejects(r.resolve('ghost.test'), { code: 'ENOTFOUND' });
  assert.equal(a.log.filter((q) => q.type === 1).length, 1, 'negative answers are cached too');
});

test('a resolver that blocks a name (answers 0.0.0.0) is reported as blocked', async () => {
  const a = await doh({ 'ads.test': ['0.0.0.0'] });
  const r = resolverFor([a]);
  await assert.rejects(r.resolve('ads.test'), /blocked by resolver/);
});

test('system fallback: used only when the whole stack is unreachable, and only if allowed', async () => {
  const down = await doh({}, { fail: 500 });
  const withFallback = resolverFor([down], { fallback: true });
  const got = await withFallback.resolve('localhost');
  assert.equal(got.via, 'system');
  assert.ok(got.addresses.includes('127.0.0.1'));
  assert.equal(withFallback.summary().system, 1);

  const strict = resolverFor([down], { fallback: false });
  await assert.rejects(strict.resolve('localhost'));
  const none = resolverFor(['http://127.0.0.1:9/dns-query'], { fallback: false });
  await assert.rejects(none.resolve('localhost'));
});

test('mode "system" bypasses the stack entirely', async () => {
  const a = await doh({ localhost: ['10.5.5.5'] });
  const r = resolverFor([a], { mode: 'system' });
  assert.equal(r.active(), false);
  assert.equal(await r.resolve4('localhost'), '127.0.0.1');
  const viaLookup = await new Promise((resolve, reject) =>
    r.lookup('localhost', { family: 4 }, (e, addr) => (e ? reject(e) : resolve(addr)))
  );
  assert.equal(viaLookup, '127.0.0.1');
  assert.equal(a.log.length, 0);
});

test('lookup() is a drop-in for dns.lookup', async () => {
  const a = await doh({ 'site.test': ['10.1.1.1', '10.1.1.2'] });
  const r = resolverFor([a]);
  const one = await new Promise((resolve, reject) =>
    r.lookup('site.test', { family: 4 }, (e, address, family) => (e ? reject(e) : resolve({ address, family })))
  );
  assert.deepEqual(one, { address: '10.1.1.1', family: 4 });
  const all = await new Promise((resolve, reject) => r.lookup('site.test', { all: true }, (e, list) => (e ? reject(e) : resolve(list))));
  assert.deepEqual(all, [
    { address: '10.1.1.1', family: 4 },
    { address: '10.1.1.2', family: 4 },
  ]);
  await assert.rejects(new Promise((resolve, reject) => r.lookup('site.test', { family: 6 }, (e, x) => (e ? reject(e) : resolve(x)))), {
    code: 'ENOTFOUND',
  });
  await assert.rejects(new Promise((resolve, reject) => r.lookup('nope.test', (e, x) => (e ? reject(e) : resolve(x)))), {
    code: 'ENOTFOUND',
  });
});

test('response-time test: every resolver in the stack is timed side by side', async () => {
  const fast = await doh({ 'site.test': ['10.0.0.1'] });
  const slow = await doh({ 'site.test': ['10.0.0.2'] }, { delay: 120 });
  const dead = await doh({}, { fail: 500 });
  const r = resolverFor([fast, slow, dead]);
  const rows = await r.test('site.test');
  assert.deepEqual(
    rows.map((x) => x.name),
    [fast.name, slow.name, dead.name, 'system']
  );
  assert.equal(rows[0].address, '10.0.0.1');
  assert.ok(rows[0].ms >= 0 && rows[0].ms < 100, 'fast: ' + rows[0].ms + ' ms');
  assert.equal(rows[1].address, '10.0.0.2');
  assert.ok(rows[1].ms >= 110, 'slow: ' + rows[1].ms + ' ms');
  assert.ok(rows[2].error, 'dead resolver reports an error');
  assert.ok(rows[3].error || rows[3].address, 'system row is always present');
});

test('summary reports the stack and the last answer', async () => {
  const a = await doh({ 'site.test': ['10.0.0.1'] });
  const r = resolverFor([a]);
  await r.resolve('site.test');
  await sleep(1);
  const s = r.summary();
  assert.equal(s.mode, 'doh');
  assert.equal(s.strategy, 'fallback');
  assert.equal(s.cached, 1);
  assert.equal(s.last.host, 'site.test');
  assert.equal(s.last.via, a.name);
  assert.equal(s.last.address, '10.0.0.1');
  assert.ok(s.last.ms >= 0);
  assert.deepEqual(
    s.servers.map((x) => [x.url, x.name, x.ok, x.fail, x.down]),
    [[a.url, a.name, 1, 0, false]]
  );
});
