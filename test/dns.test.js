'use strict';
const { doh, httpProxy, socks5Proxy, closeAll, sleep } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Config, DATA_DIR } = require('../lib/config');
const { Resolver, encodeQuery, decodeAnswer, parseStamp, parseResolverList, operatorOf } = require('../lib/dns');
const net = require('../lib/net');

test.after(async () => {
  net.dropAgents();
  await closeAll();
});

function resolverFor(servers, extra, opt) {
  const config = new Config();
  config.reset();
  config.patch({
    dns: Object.assign({ strategy: 'fallback', servers: servers.map((s) => s.url || s), fallback: false, auto: false, pad: false }, extra),
  });
  fs.rmSync(path.join(DATA_DIR, 'dns.json'), { force: true });
  return new Resolver(config, opt);
}

/** A proxy stand-in as a route, the way the pool hands them out. */
const routeOf = (p) => ({ key: p.key, proto: p.proto, host: p.host, port: p.port, via: [] });

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

test("a site being visited: the question travels through the proxy route, and is never handed to this machine's own DNS", async () => {
  const a = await doh({ 'site.test': ['10.4.4.4'] });
  const px = await httpProxy();
  const r = resolverFor([a], { fallback: true });
  const got = await r.resolve('site.test', { via: routeOf(px) });
  assert.deepEqual(got.addresses, ['10.4.4.4']);
  assert.deepEqual(px.log, ['127.0.0.1:' + a.port], 'the resolver was reached through the proxy: it sees the exit, not this server');
  assert.equal(r.summary().last.routed, true);

  // Every resolver down: a housekeeping lookup may fall back to the system resolver; a visited site may not.
  const down = await doh({}, { fail: 500 });
  const r2 = resolverFor([down], { fallback: true });
  await assert.rejects(r2.resolve('localhost', { via: routeOf(px) }));
  assert.equal(r2.summary().system, 0, 'the system resolver was not asked about a site someone is visiting');
  assert.equal((await r2.resolve('localhost')).via, 'system', 'the same name as housekeeping: allowed');
  assert.equal(r2.summary().system, 1);

  // A dead proxy says nothing about the resolver behind it.
  const dead = await httpProxy({ refuse: 503 });
  const r3 = resolverFor([a]);
  for (let i = 0; i < 4; i++) await assert.rejects(r3.resolve('n' + i + '.site.test', { via: routeOf(dead) }), { phase: 'proxy' });
  const row = r3.summary().servers[0];
  assert.deepEqual([row.fail, row.down], [0, false], 'the resolver is not blamed, and not rested');
  assert.deepEqual((await r3.resolve('site.test', { via: routeOf(px) })).addresses, ['10.4.4.4']);
});

test('lookups in flight are shared only between lookups of the same kind', async () => {
  const a = await doh({ 'busy.test': ['10.0.0.1'] }, { delay: 60 });
  const px = await socks5Proxy();
  const r = resolverFor([a]);
  const via = routeOf(px);
  await Promise.all([r.resolve('busy.test', { via }), r.resolve('busy.test', { via }), r.resolve('busy.test'), r.resolve('busy.test')]);
  assert.equal(a.log.length, 2, 'one routed question and one direct one: neither waits on the other kind');
  assert.equal(px.log.length, 1);
});

test('padding: questions are padded to a fixed size, so their length does not give the name away', async () => {
  const a = await doh({ 'a.test': ['10.0.0.1'], 'a-much-longer-name-than-that.example.test': ['10.0.0.2'] }, { sizes: true });
  const r = resolverFor([a], { pad: true });
  await r.resolve('a.test');
  await r.resolve('a-much-longer-name-than-that.example.test');
  assert.deepEqual(
    a.log.map((q) => [q.size, q.padded]),
    [
      [128, true],
      [128, true],
    ]
  );
  for (const name of ['x.test', 'a-much-longer-name-than-that.example.test', 'x'.repeat(60) + '.' + 'y'.repeat(60) + '.test'])
    assert.equal(encodeQuery(name, 1, true).length % 128, 0, name);
  assert.equal(encodeQuery('a.test', 1).length, 24, 'unpadded: as short as the name');

  const plain = await doh({ 'a.test': ['10.0.0.1'] }, { sizes: true });
  const off = resolverFor([plain], { pad: false });
  await off.resolve('a.test');
  assert.deepEqual([plain.log[0].size, plain.log[0].padded], [24, false]);

  // A server that cannot read the padding option is asked plainly from then on.
  const old = await doh({ 'a.test': ['10.0.0.1'], 'b.test': ['10.0.0.2'] }, { sizes: true, nopad: true });
  const r2 = resolverFor([old], { pad: true });
  assert.deepEqual((await r2.resolve('a.test')).addresses, ['10.0.0.1']);
  await r2.resolve('b.test');
  assert.deepEqual(
    old.log.map((q) => q.padded),
    [true, false, false],
    'one refusal, then no more padding for this server'
  );
});

test('stacking, one resolver per site: no single resolver sees everything that is visited', async () => {
  const hosts = {};
  const sites = Array.from({ length: 24 }, (_, i) => 'site' + i + '.test');
  for (const s of sites) for (const h of [s, 'www.' + s, 'cdn.' + s]) hosts[h] = ['10.0.0.1'];
  const servers = [await doh(hosts), await doh(hosts), await doh(hosts)];
  const r = resolverFor(servers, { strategy: 'split' });
  for (const s of sites) {
    const first = (await r.resolve(s)).via;
    assert.equal((await r.resolve('www.' + s)).via, first, 'every name of one site goes to the same resolver');
    assert.equal((await r.resolve('cdn.' + s)).via, first);
  }
  for (const d of servers) {
    assert.ok(d.log.length > 0, 'each resolver got some sites');
    assert.ok(new Set(d.log.map((q) => q.name.split('.').slice(-2).join('.'))).size < sites.length, 'and none of them got all');
  }
  assert.equal(
    servers.reduce((n, d) => n + d.log.length, 0),
    sites.length * 3
  );

  // the chosen resolver being down, the next one answers
  const down = await doh({}, { fail: 500 });
  const up = await doh(hosts);
  const r2 = resolverFor([down, up], { strategy: 'split' });
  for (const s of sites.slice(0, 6)) assert.equal((await r2.resolve(s)).via, up.name);
});

test('stacking, cross-check: an address beats a "no", and the resolver that said no is marked', async () => {
  const honest = await doh({ 'site.test': ['10.0.0.1'] });
  const censor = await doh({});
  const blocker = await doh({ 'site.test': ['0.0.0.0'] });
  const r = resolverFor([censor, honest, blocker], { strategy: 'check', parallel: 3 });
  const got = await r.resolve('site.test');
  assert.deepEqual(got.addresses, ['10.0.0.1']);
  assert.equal(got.via, honest.name);
  assert.equal(censor.log.length + honest.log.length + blocker.log.length >= 3, true, 'all three were asked');
  const rows = r.summary().servers;
  assert.deepEqual(
    rows.map((x) => x.lies),
    [1, 0, 1],
    'the two that refused a name another resolver could answer'
  );
  await assert.rejects(r.resolve('ghost.test'), { code: 'ENOTFOUND' }, 'when they all say no, it is a no');
  assert.deepEqual(
    r.summary().servers.map((x) => x.lies),
    [1, 0, 1],
    'agreeing is not lying'
  );

  // "parallel" is how many are asked at once; the rest are only asked if those fail
  const a = await doh({ 'x.test': ['10.0.0.1'] });
  const b = await doh({ 'x.test': ['10.0.0.1'] });
  const c = await doh({ 'x.test': ['10.0.0.1'] });
  const r2 = resolverFor([a, b, c], { strategy: 'check', parallel: 2 });
  await r2.resolve('x.test');
  assert.deepEqual([a.log.length, b.log.length, c.log.length], [1, 1, 0]);
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

test('response-time test: every resolver is timed side by side, through a route or not at all', async () => {
  const fast = await doh({ 'site.test': ['10.0.0.1'] });
  const slow = await doh({ 'site.test': ['10.0.0.2'] }, { delay: 120 });
  const dead = await doh({}, { fail: 500 });
  const px = await httpProxy();
  const r = resolverFor([fast, slow, dead]);

  const none = await r.test('site.test');
  assert.deepEqual(
    none.map((x) => [x.name, x.error]),
    [fast, slow, dead].map((d) => [d.name, 'no proxy']),
    'a name someone typed is not asked about directly'
  );
  assert.equal(fast.log.length + slow.log.length + dead.log.length, 0);

  const rows = await r.test('site.test', routeOf(px));
  assert.deepEqual(
    rows.map((x) => x.name),
    [fast.name, slow.name, dead.name]
  );
  assert.equal(rows[0].address, '10.0.0.1');
  assert.ok(rows[0].ms >= 0 && rows[0].ms < 100, 'fast: ' + rows[0].ms + ' ms');
  assert.equal(rows[1].address, '10.0.0.2');
  assert.ok(rows[1].ms >= 110, 'slow: ' + rows[1].ms + ' ms');
  assert.ok(rows[2].error, 'dead resolver reports an error');
  assert.equal(px.log.length, 3, 'every question went through the proxy');
});

test('summary reports the stack and the last answer', async () => {
  const a = await doh({ 'site.test': ['10.0.0.1'] });
  const r = resolverFor([a]);
  await r.resolve('site.test');
  await sleep(1);
  const s = r.summary();
  assert.equal(s.mode, 'auto');
  assert.equal(s.strategy, 'fallback');
  assert.equal(s.cached, 1);
  assert.equal(s.last.host, 'site.test');
  assert.equal(s.last.via, a.name);
  assert.equal(s.last.address, '10.0.0.1');
  assert.equal(s.last.routed, false);
  assert.ok(s.last.ms >= 0);
  assert.deepEqual(
    s.servers.map((x) => [x.url, x.name, x.ok, x.fail, x.down, x.auto, x.lies]),
    [[a.url, a.name, 1, 0, false, false, 0]]
  );
  assert.deepEqual(s.feed, { at: 0, listed: 0, tested: 0, kept: 0, error: '', busy: false });
});

// ---- the public resolver list ---------------------------------------------------------

/** A DNS stamp as the public lists carry them. props: 1 DNSSEC, 2 keeps no logs, 4 filters nothing. */
function stamp({ address = '', host, pathname = '/dns-query', props = 7, proto = 2, hashes = [] }) {
  const lp = (v) => Buffer.concat([Buffer.from([Buffer.byteLength(v)]), Buffer.from(v)]);
  const p = Buffer.alloc(8);
  p.writeUInt32LE(props, 0);
  const set = hashes.length
    ? Buffer.concat(hashes.map((h, i) => Buffer.concat([Buffer.from([h.length | (i < hashes.length - 1 ? 0x80 : 0)]), h])))
    : Buffer.from([0]);
  return 'sdns://' + Buffer.concat([Buffer.from([proto]), p, lp(address), set, lp(host), lp(pathname)]).toString('base64url');
}

test('stamps: the address, name and promises of a DNS-over-HTTPS server', () => {
  assert.deepEqual(parseStamp(stamp({ address: '192.0.2.10', host: 'doh.alpha.test' })), {
    url: 'https://doh.alpha.test/dns-query',
    address: '192.0.2.10',
    dnssec: true,
    nolog: true,
    nofilter: true,
  });
  const two = parseStamp(
    stamp({
      address: '192.0.2.10:8443',
      host: 'DoH.Alpha.test',
      pathname: '/q',
      props: 2,
      hashes: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    })
  );
  assert.deepEqual(two, { url: 'https://doh.alpha.test:8443/q', address: '192.0.2.10', dnssec: false, nolog: true, nofilter: false });
  assert.equal(parseStamp(stamp({ host: 'doh.alpha.test' })).address, '', 'no address given: found by name');
  assert.equal(parseStamp(stamp({ address: '[2001:db8::1]', host: 'v6.test' })).address, '2001:db8::1');
  assert.equal(parseStamp(stamp({ address: '192.0.2.1', host: 'x.test', proto: 1 })), null, 'DNSCrypt, not DNS-over-HTTPS');
  assert.equal(parseStamp(stamp({ address: '192.0.2.1', host: 'x.test/evil' })), null);
  assert.equal(parseStamp(stamp({ address: '192.0.2.1', host: 'x.test', pathname: 'no-slash' })), null);
  for (const junk of ['', 'sdns://', 'sdns://AgcAAAAAAAAA', 'sdns://!!!', 'https://x.test/dns-query', 'sdns://' + 'A'.repeat(4000)])
    assert.equal(parseStamp(junk), null, junk.slice(0, 30));

  assert.equal(operatorOf('https://doh.alpha.test/dns-query'), 'alpha.test');
  assert.equal(operatorOf('https://dns2.alpha.test:8443/q'), 'alpha.test');
  assert.equal(operatorOf('https://resolver.example.co.uk/dns-query'), 'example.co.uk');
  assert.equal(operatorOf('https://192.0.2.10/dns-query'), '192.0', 'a bare address: its network');
});

const LIST = [
  '# public-resolvers',
  '',
  'A list of public DNS servers.',
  '',
  '## alpha',
  'Run by Alpha. No logs, no filter, DNSSEC.',
  '',
  stamp({ address: '192.0.2.10', host: 'doh.alpha.test' }),
  '',
  '## alpha-second',
  "Alpha's other site.",
  '',
  stamp({ address: '192.0.2.11', host: 'doh2.alpha.test' }),
  '',
  '## beta',
  'Beta, a non-profit. No EDNS client subnet, no logs.',
  '',
  stamp({ address: '192.0.2.20', host: 'dns.beta.test' }),
  '',
  '## gamma',
  'Gamma keeps an old address in its stamp.',
  '',
  stamp({ address: '192.0.2.99', host: 'doh.gamma.test', pathname: '/resolve' }),
  '',
  '## liar',
  'Answers every question, also those that have no answer.',
  '',
  stamp({ address: '192.0.2.30', host: 'doh.liar.test' }),
  '',
  '## gone',
  'Listed, and no longer there.',
  '',
  stamp({ address: '192.0.2.40', host: 'doh.gone.test' }),
  '',
  '## logs',
  'Keeps logs.',
  '',
  stamp({ address: '192.0.2.50', host: 'doh.logs.test', props: 5 }),
  '',
  '## filter',
  'Blocks ads and malware.',
  '',
  stamp({ address: '192.0.2.51', host: 'doh.filter.test', props: 3 }),
  '',
  '## subnet',
  'Anycast resolver with EDNS client subnet.',
  '',
  stamp({ address: '192.0.2.52', host: 'doh.subnet.test' }),
  '',
  '## crypt',
  'A DNSCrypt server.',
  '',
  stamp({ address: '192.0.2.53', host: 'crypt.test', proto: 1 }),
  '',
  '## six',
  'Reachable over IPv6 only.',
  '',
  stamp({ address: '[2001:db8::53]', host: 'doh.six.test' }),
  '',
].join('\n');

test("the public list: only resolvers that promise no logs and no filtering, speak DoH over IPv4 and keep the asker's network to themselves", () => {
  const list = parseResolverList(LIST);
  assert.deepEqual(
    list.map((x) => x.name),
    ['alpha', 'alpha-second', 'beta', 'gamma', 'liar', 'gone']
  );
  assert.deepEqual(list[0], {
    url: 'https://doh.alpha.test/dns-query',
    address: '192.0.2.10',
    name: 'alpha',
    about: 'Run by Alpha. No logs, no filter, DNSSEC.',
  });
  assert.equal(list[3].url, 'https://doh.gamma.test/resolve');
  assert.deepEqual(parseResolverList(''), []);
  assert.deepEqual(parseResolverList('## x\nno stamp here\n'), []);
  const twice = '## a\n' + stamp({ host: 'same.test' }) + '\n## b\n' + stamp({ host: 'same.test' }) + '\n';
  assert.equal(parseResolverList(twice).length, 1, 'one server listed twice counts once');
});

/**
 * The resolvers on the list, as stand-ins. Listed resolvers are HTTPS servers and the stand-ins speak plain
 * HTTP, so the last step is swapped here; the route and the question are passed on untouched.
 */
async function listed(seen) {
  const hosts = { 'example.com': ['93.184.216.34'] };
  const d = {
    'doh.alpha.test': await doh(hosts, { delay: 120 }),
    'doh2.alpha.test': await doh(hosts, { delay: 200 }),
    'dns.beta.test': await doh(hosts),
    'doh.gamma.test': await doh(hosts, { delay: 60 }),
    'doh.liar.test': await doh(hosts, { invent: '198.51.100.7' }),
    'doh.gone.test': await doh(hosts, { fail: 500 }),
  };
  const request = (o) => {
    const host = o.url.hostname;
    if (!d[host]) return net.request(o);
    seen.push({ host, proxy: !!o.proxy, infra: !!o.infra, address: o.address || '' });
    // the address in gamma's stamp is out of date: nothing answers there
    if (o.address === '192.0.2.99')
      return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', phase: 'target' }));
    return net.request(Object.assign({}, o, { url: new URL(d[host].url), address: '' }));
  };
  return { d, request };
}

test('the public list keeps itself current: downloaded, tested through a proxy, the quickest honest ones kept, one per operator', async () => {
  const seen = [];
  const w = await listed(seen);
  const px = await httpProxy();
  const own = await doh({ 'site.test': ['10.0.0.1'] });
  const fetched = [];
  const fetch = async (url, headers) => {
    fetched.push([url, headers.Accept || '']);
    if (fetched.length === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    return Buffer.from(LIST);
  };
  let lend = null;
  const feeds = ['https://lists.test/first.md', 'https://api.github.com/repos/x/y/contents/v3/public-resolvers.md'];
  const r = resolverFor([own], { auto: true, keep: 2, refreshHours: 24, feeds }, { fetch, request: w.request, route: () => lend });
  assert.equal(r.due(), true, 'nothing found yet: due at once');

  // no proxy to test through: nothing on the list is contacted
  await r.refresh();
  assert.equal(seen.length, 0, 'listed resolvers are strangers: none was contacted directly');
  assert.deepEqual(
    fetched,
    [
      [feeds[0], ''],
      [feeds[1], 'application/vnd.github.raw'],
    ],
    'the next list is asked when one fails'
  );
  let feed = r.summary().feed;
  assert.equal(feed.listed, 6);
  assert.equal(feed.error, 'waiting for a proxy to test through');
  assert.equal(r.due(), false);
  assert.equal(r.due(Date.now() + 61000), true, 'it looks again a minute later');
  assert.deepEqual(r.servers(), [own.url]);

  lend = routeOf(px);
  await r.refresh();
  assert.equal(fetched.length, 2, 'the list is not downloaded again just because a proxy turned up');
  assert.equal(seen.length, 12);
  assert.ok(
    seen.every((q) => q.proxy && !q.infra),
    'every question to a listed resolver went through the proxy'
  );
  assert.equal(
    seen.find((q) => q.host === 'doh.alpha.test').address,
    '192.0.2.10',
    'reached at the address in its stamp: nobody is asked where it lives'
  );
  assert.deepEqual(
    r.found.map((f) => f.name),
    ['beta', 'gamma', 'alpha'],
    'quickest first; the liar, the dead one and the second server of an operator already kept are out'
  );
  const gamma = seen.filter((q) => q.host === 'doh.gamma.test').map((q) => q.address);
  assert.deepEqual(gamma, ['192.0.2.99', '', ''], 'the address in a stamp went stale: found by name from then on');
  assert.ok(
    w.d['doh.liar.test'].log.some((q) => /^waddle-[a-z0-9]+\.example\.com$/.test(q.name)),
    'each one is asked about a name that cannot exist'
  );
  assert.deepEqual(
    r.servers(),
    [own.url, 'https://dns.beta.test/dns-query', 'https://doh.gamma.test/resolve'],
    'your own stack first, then the best two'
  );
  feed = r.summary().feed;
  assert.deepEqual([feed.listed, feed.tested, feed.kept, feed.error, feed.busy], [6, 6, 2, '', false]);
  assert.deepEqual(
    r.summary().servers.map((x) => [x.auto, x.label]),
    [
      [false, ''],
      [true, 'beta'],
      [true, 'gamma'],
    ]
  );
  assert.equal(r.due(), false);
  assert.equal(r.due(Date.now() + 23 * 3600000), false);
  assert.equal(r.due(Date.now() + 25 * 3600000), true, 'once a day unless set otherwise');

  // a found resolver is used like any other, after the configured ones
  own.opt.fail = 500;
  const got = await r.resolve('example.com', { via: lend });
  assert.equal(got.via, 'dns.beta.test', 'your own resolver being down, the best of the found ones answers');
  assert.deepEqual(got.addresses, ['93.184.216.34']);

  // what was found survives a restart
  const again = new Resolver(r.config, { fetch, request: w.request, route: () => lend });
  assert.deepEqual(
    again.found.map((f) => [f.name, f.url, f.address]),
    [
      ['beta', 'https://dns.beta.test/dns-query', '192.0.2.20'],
      ['gamma', 'https://doh.gamma.test/resolve', '192.0.2.99'],
      ['alpha', 'https://doh.alpha.test/dns-query', '192.0.2.10'],
    ]
  );
  assert.equal(again.due(), false, 'and it is not tested all over again at every start');

  // a round in which nothing answers leaves yesterday's list in place
  const dead = await httpProxy({ refuse: 503 });
  lend = routeOf(dead);
  await r.refresh(true);
  assert.equal(fetched.length, 3, 'asked for by hand: the list is downloaded again');
  assert.deepEqual(
    r.found.map((f) => f.name),
    ['beta', 'gamma', 'alpha']
  );
  assert.equal(r.summary().feed.error, 'none of 6 listed resolvers answered through the proxy');

  // switched off: the stack is exactly what was typed in
  r.config.patch({ dns: { auto: false } });
  assert.deepEqual(r.servers(), [own.url]);
  assert.equal(r.due(Date.now() + 1e9), false);
  assert.equal(r.summary().feed.kept, 0);
});

test('the public list: when no list can be downloaded it says so, and tries again in ten minutes', async () => {
  const fetch = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  };
  const r = resolverFor(
    [],
    { auto: true, keep: 3, feeds: ['https://lists.test/a.md', 'https://lists.test/b.md'] },
    { fetch, route: () => null }
  );
  await r.refresh();
  assert.equal(r.summary().feed.error, 'no such host');
  assert.equal(r.due(), false);
  assert.equal(r.due(Date.now() + 9 * 60000), false);
  assert.equal(r.due(Date.now() + 11 * 60000), true);

  const empty = resolverFor(
    [],
    { auto: true, keep: 3, feeds: ['https://lists.test/a.md'] },
    { fetch: async () => Buffer.from('# nothing\n'), route: () => null }
  );
  await empty.refresh();
  assert.equal(empty.summary().feed.error, 'nothing usable in the list');

  const off = resolverFor([], { auto: true, keep: 0, feeds: ['https://lists.test/a.md'] }, { fetch, route: () => null });
  assert.equal(off.due(), false, 'keeping none: nothing to do');
});
