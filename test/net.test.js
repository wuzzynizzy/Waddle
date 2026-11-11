'use strict';
const { site, httpProxy, socks5Proxy, socks4Proxy, doh, listen, closeAll } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const tcp = require('net');
const { execFileSync } = require('child_process');
const path = require('path');
const net = require('../lib/net');
const { Config } = require('../lib/config');
const { Resolver } = require('../lib/dns');

test.after(() => {
  net.dropAgents();
  net.setResolver(null);
  return closeAll();
});

async function fetchText(o) {
  const res = await net.request(Object.assign({ timeout: 4000 }, o));
  return { status: res.statusCode, headers: res.headers, text: (await net.readAll(res, 1 << 20)).toString('utf8') };
}
const hop = (p, extra) => Object.assign({ proto: p.proto, host: p.host, port: p.port }, extra);
const chain = (...hops) => Object.assign({}, hops[hops.length - 1], { via: hops.slice(0, -1) });

test('no proxy, no request: a connection without one has to be asked for by name', async () => {
  const s = await site({ '/': { body: 'x' } });
  const url = new URL(s.url + '/');
  const e = await fetchText({ url }).catch((x) => x);
  assert.equal(e.code, 'EDIRECT');
  assert.equal(e.phase, 'policy');
  assert.equal(net.explain(e), 'no proxy');
  for (const proxy of [null, undefined, false, 0, '']) await assert.rejects(fetchText({ url, proxy }), { code: 'EDIRECT' });
  // `infra` has to be exactly true: something merely truthy does not open the door
  for (const infra of [1, 'yes', 'true', {}, []]) await assert.rejects(fetchText({ url, infra }), { code: 'EDIRECT' }, String(infra));
  // not for uploads, not for WebSockets, not when a connection is asked for afresh
  await assert.rejects(fetchText({ url, method: 'POST', body: Buffer.from('a=1') }), { code: 'EDIRECT' });
  await assert.rejects(fetchText({ url, fresh: true, address: '127.0.0.1' }), { code: 'EDIRECT' });
  await assert.rejects(
    net.request({ url: new URL(s.url + '/ws'), upgrade: true, headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }),
    {
      code: 'EDIRECT',
    }
  );
  assert.equal(s.hits.length, 0, 'nothing reached the site');
});

test('housekeeping request (the one way out without a proxy): method, headers (case kept), body', async () => {
  const s = await site({
    '/echo': (req, res, body) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Seen': req.method });
      res.end(body);
    },
  });
  const r = await fetchText({
    url: new URL(s.url + '/echo?x=1'),
    method: 'POST',
    headers: { 'X-CamelCase': 'yes', 'Content-Length': '5' },
    body: Buffer.from('hello'),
    infra: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'hello');
  assert.equal(r.headers['x-seen'], 'POST');
  const raw = s.last().raw;
  assert.ok(raw.includes('X-CamelCase'), 'header casing is sent as given, like a browser would');
  assert.equal(s.last().url, '/echo?x=1');
});

for (const [name, make] of [
  ['HTTP CONNECT', httpProxy],
  ['SOCKS5', socks5Proxy],
  ['SOCKS4', socks4Proxy],
]) {
  test('one hop through a ' + name + ' proxy', async () => {
    const s = await site({ '/': { body: 'through ' + name } });
    const p = await make();
    const r = await fetchText({ url: new URL(s.url + '/'), proxy: hop(p) });
    assert.equal(r.text, 'through ' + name);
    assert.equal(p.log.length, 1, 'the connection went through the proxy');
    net.dropAgents(hop(p));
  });
}

test('proxy credentials: HTTP Basic and SOCKS5 user/pass', async () => {
  const s = await site({ '/': { body: 'ok' } });
  const h = await httpProxy({ auth: 'bob:secret' });
  const k = await socks5Proxy({ auth: 'bob:secret' });
  const creds = { user: 'bob', pass: 'secret' };
  assert.equal((await fetchText({ url: new URL(s.url + '/'), proxy: hop(h, creds), fresh: true })).text, 'ok');
  assert.equal((await fetchText({ url: new URL(s.url + '/'), proxy: hop(k, creds), fresh: true })).text, 'ok');
  (await net.tunnel(hop(h, creds), '127.0.0.1', s.port)).destroy();

  await assert.rejects(
    fetchText({ url: new URL(s.url + '/'), proxy: hop(h), fresh: true }),
    { code: 'EPROXYREFUSED', phase: 'proxy' },
    'without the password the proxy refuses the tunnel'
  );
  await assert.rejects(net.tunnel(hop(h), '127.0.0.1', s.port), { code: 'EPROXYREFUSED', phase: 'proxy' });
  assert.equal(s.hits.length, 2, 'only the two requests that carried the right password got through');
  await assert.rejects(fetchText({ url: new URL(s.url + '/'), proxy: hop(k, { user: 'bob', pass: 'wrong' }), fresh: true }), {
    code: 'EPROXYREFUSED',
    phase: 'proxy',
  });
  await assert.rejects(fetchText({ url: new URL(s.url + '/'), proxy: hop(k), fresh: true }), { code: 'EPROXYREFUSED' });
});

test('proxy over proxy: two hops, entry -> exit -> site', async () => {
  const s = await site({ '/': { body: 'two hops' } });
  const entry = await socks5Proxy();
  const exit = await httpProxy();
  const r = await fetchText({ url: new URL(s.url + '/'), proxy: chain(hop(entry), hop(exit)), fresh: true });
  assert.equal(r.text, 'two hops');
  assert.deepEqual(entry.log, [{ host: '127.0.0.1', port: exit.port, byName: false }], 'the entry only ever sees the next hop');
  assert.deepEqual(exit.log, [s.host], 'only the exit sees the destination');
});

test('proxy over proxy over proxy: three hops of mixed kinds', async () => {
  const s = await site({ '/': { body: 'three hops' } });
  const a = await httpProxy();
  const b = await socks4Proxy();
  const c = await socks5Proxy();
  const r = await fetchText({ url: new URL(s.url + '/'), proxy: chain(hop(a), hop(b), hop(c)), fresh: true });
  assert.equal(r.text, 'three hops');
  assert.deepEqual(a.log, ['127.0.0.1:' + b.port]);
  assert.deepEqual(b.log, [{ host: '127.0.0.1', port: c.port }]);
  assert.deepEqual(c.log, [{ host: '127.0.0.1', port: s.port, byName: false }]);

  // every order works
  for (const order of [
    [c, a, b],
    [b, c, a],
  ]) {
    const again = await fetchText({ url: new URL(s.url + '/'), proxy: chain(...order.map((p) => hop(p))), fresh: true });
    assert.equal(again.text, 'three hops');
  }
});

test('a chain is reused for later requests (keep-alive through the tunnel)', async () => {
  const s = await site({ '/': { body: 'again' } });
  const a = await socks5Proxy();
  const b = await socks5Proxy();
  const proxy = chain(hop(a), hop(b));
  for (let i = 0; i < 3; i++) assert.equal((await fetchText({ url: new URL(s.url + '/'), proxy })).text, 'again');
  assert.equal(a.log.length, 1, 'one tunnel carried all three requests');
  net.dropAgents(hop(a));
  assert.equal((await fetchText({ url: new URL(s.url + '/'), proxy })).text, 'again');
  assert.equal(a.log.length, 2, 'dropAgents closes tunnels that pass through a hop');
});

test('when a chain breaks, the error names the hop that failed', async () => {
  const s = await site({ '/': { body: 'x' } });
  const good = await socks5Proxy();
  const refusing = await socks5Proxy({ refuse: true });
  const dead = { proto: 'http', host: '127.0.0.1', port: 9 };

  const e1 = await fetchText({ url: new URL(s.url + '/'), proxy: chain(hop(good), hop(refusing)), fresh: true }).catch((e) => e);
  assert.equal(e1.phase, 'proxy');
  assert.equal(e1.code, 'EPROXYREFUSED');
  assert.equal(e1.culprit.port, refusing.port, 'the exit refused');

  const e2 = await fetchText({ url: new URL(s.url + '/'), proxy: chain(hop(good), dead), fresh: true }).catch((e) => e);
  assert.equal(e2.phase, 'proxy');
  assert.equal(e2.culprit.port, good.port, 'the entry could not reach the next hop, so the entry is reported');

  const e3 = await fetchText({ url: new URL(s.url + '/'), proxy: chain(dead, hop(good)), fresh: true }).catch((e) => e);
  assert.equal(e3.phase, 'proxy');
  assert.equal(e3.culprit.port, 9);
  assert.equal(e3.sent, false, 'the site never saw this request, so it is safe to try another route');
});

test('a proxy that accepts and then says nothing times out as a proxy fault', async () => {
  const s = await site({ '/': { body: 'x' } });
  for (const silent of [await socks5Proxy({ dead: true }), await httpProxy({ dead: true })]) {
    const t0 = Date.now();
    const e = await net.tunnel(hop(silent), '127.0.0.1', s.port, { timeout: 300 }).catch((x) => x);
    assert.equal(e.code, 'EPROXYTIMEOUT', silent.proto);
    assert.equal(e.phase, 'proxy');
    assert.equal(e.culprit.port, silent.port);
    assert.ok(Date.now() - t0 < 1500, silent.proto + ' gave up after ' + (Date.now() - t0) + ' ms');
  }
  // A whole request has one more deadline: the time to the first byte of the answer.
  const silent = await httpProxy({ dead: true });
  const e = await fetchText({ url: new URL(s.url + '/'), proxy: hop(silent), fresh: true, timeout: 300 }).catch((x) => x);
  assert.equal(e.code, 'EPROXYTIMEOUT');
  assert.equal(e.phase, 'proxy');
  assert.equal(s.hits.length, 0);
});

test('something that is not a proxy at all', async () => {
  const s = await site({ '/': { body: 'x' } });
  const notProxy = await site({ '*': { body: 'I am a web server' } });
  for (const proto of ['http', 'socks5', 'socks4']) {
    const e = await net.tunnel({ proto, host: '127.0.0.1', port: notProxy.port }, '127.0.0.1', s.port, { timeout: 500 }).catch((x) => x);
    assert.ok(e instanceof Error, proto);
    assert.equal(e.phase, 'proxy', proto);
  }
  await assert.rejects(fetchText({ url: new URL(s.url + '/'), proxy: { proto: 'vmess', host: '127.0.0.1', port: 1 } }), {
    code: 'EPROXYBAD',
  });
});

/**
 * A site whose kept-alive connections go bad: it answers the first request on a connection and
 * resets any later one, which is how a connection that was dropped while idle looks to a client.
 * With `always`, it answers one request in total and resets everything after it.
 */
async function flakySite(always) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const nth = (req.socket.served = (req.socket.served || 0) + 1);
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push(req.method + ' #' + nth + (body ? ' ' + body : ''));
      if (always ? seen.length > 1 : nth > 1) return req.socket.resetAndDestroy();
      res.end('ok');
    });
  });
  const port = await listen(server);
  return { url: new URL('http://127.0.0.1:' + port + '/'), seen, server };
}

test('a kept-alive connection that died while idle is replaced without the caller noticing', async () => {
  const s = await flakySite(false);
  assert.equal((await fetchText({ url: s.url, infra: true })).text, 'ok');
  assert.equal(s.server.accepted, 1);

  const again = await fetchText({ url: s.url, infra: true });
  assert.equal(again.text, 'ok', 'the reset on the reused connection was absorbed');
  assert.equal(s.server.accepted, 2, 'by repeating the request on a new connection');
  assert.deepEqual(s.seen, ['GET #1', 'GET #2', 'GET #1']);

  const post = await fetchText({ url: s.url, method: 'POST', body: Buffer.from('a=1&b=2'), infra: true });
  assert.equal(post.text, 'ok');
  assert.deepEqual(s.seen.slice(3), ['POST #2 a=1&b=2', 'POST #1 a=1&b=2'], 'a body is repeated intact');

  // The same through proxies of every kind: there the kept-alive connection inside the tunnel is what went bad.
  for (const make of [socks5Proxy, socks4Proxy, httpProxy]) {
    const t = await flakySite(false);
    const p = await make();
    for (let i = 0; i < 3; i++) assert.equal((await fetchText({ url: t.url, proxy: hop(p) })).text, 'ok', p.proto);
    assert.equal(t.seen.length, 5, p.proto + ': three answers, two of them after one silent repeat');
  }
});

test('a request is repeated once at most, and never on a connection that was new', async () => {
  const s = await flakySite(true);
  assert.equal((await fetchText({ url: s.url, infra: true })).text, 'ok');
  const e = await fetchText({ url: s.url, infra: true }).catch((x) => x);
  assert.equal(e.code, 'ECONNRESET', 'the second failure is reported, not retried for ever');
  assert.equal(e.phase, 'target');
  assert.deepEqual(s.seen, ['GET #1', 'GET #2', 'GET #1'], 'one repeat, on a new connection');

  const fresh = await fetchText({ url: s.url, infra: true }).catch((x) => x);
  assert.equal(fresh.code, 'ECONNRESET');
  assert.equal(s.seen.length, 4, 'a reset on a brand-new connection is a real failure and is not repeated');
});

test('a name with several addresses: one that cuts connections off is tried last from then on', async (t) => {
  // Two "homes" for one name on the same port. The first accepts a connection and resets it as
  // soon as the TLS greeting arrives, the way a filtering network does. The second is reachable
  // but does not speak TLS, which fails in a different way and so tells the two apart.
  const hits = { first: 0, second: 0 };
  const first = tcp.createServer((c) => {
    hits.first++;
    c.on('error', () => {});
    c.once('data', () => c.resetAndDestroy());
  });
  const second = tcp.createServer((c) => {
    hits.second++;
    c.on('error', () => {});
    c.once('data', () => c.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  });
  const port = await listen(first);
  const bind = (host) =>
    new Promise((resolve, reject) => {
      second.once('error', reject);
      second.listen(port, host, () => resolve(host));
    });
  const other = await bind('127.0.0.2').catch(() => bind('::1').catch(() => null));
  if (!other) return t.skip('this machine has a single loopback address');
  t.after(() => new Promise((done) => second.close(done)));

  const homes = [
    { address: '127.0.0.1', family: 4 },
    { address: other, family: tcp.isIP(other) },
  ];
  net.setResolver({ lookup: (h, o, cb) => (o && o.all ? cb(null, homes) : cb(null, homes[0].address, homes[0].family)) });
  t.after(() => net.setResolver(null));
  const url = new URL('https://two-homes.test:' + port + '/');

  const e1 = await fetchText({ url, fresh: true, infra: true }).catch((x) => x);
  assert.ok(e1 instanceof Error);
  assert.deepEqual(hits, { first: 1, second: 1 }, 'cut off by the first address, the request moved to the second');
  assert.notEqual(e1.code, 'ECONNRESET', 'and what is reported is what the second address did');

  await fetchText({ url, fresh: true, infra: true }).catch((x) => x);
  assert.deepEqual(hits, { first: 1, second: 2 }, 'later requests go straight to the address that is not cut off');

  // A name with one address has nowhere else to go: one attempt, one error.
  net.setResolver({ lookup: (h, o, cb) => (o && o.all ? cb(null, homes.slice(0, 1)) : cb(null, '127.0.0.1', 4)) });
  const e3 = await fetchText({ url: new URL('https://one-home.test:' + port + '/'), fresh: true, infra: true }).catch((x) => x);
  assert.equal(e3.code, 'ECONNRESET');
  assert.equal(hits.first, 2);
});

test('target errors are told apart from proxy errors', async () => {
  const p = await socks5Proxy();
  const e = await fetchText({ url: new URL('http://127.0.0.1:9/'), proxy: hop(p), fresh: true }).catch((x) => x);
  assert.equal(e.phase, 'proxy', 'through a proxy an unreachable site looks like a refused tunnel');
  assert.equal(e.code, 'EPROXYREFUSED');
  assert.equal(e.hop, 0, 'and names the hop that could get no further');
  const direct = await fetchText({ url: new URL('http://127.0.0.1:9/'), infra: true }).catch((x) => x);
  assert.equal(direct.phase, 'target');
  assert.equal(direct.code, 'ECONNREFUSED');
  assert.equal(direct.sent, false);
});

test('a slow site trips the response timeout', async () => {
  const s = await site({ '/slow': () => {} });
  const t0 = Date.now();
  const e = await fetchText({ url: new URL(s.url + '/slow'), timeout: 300, infra: true }).catch((x) => x);
  assert.equal(e.code, 'ETIMEDOUT');
  assert.equal(e.phase, 'target');
  assert.equal(e.sent, true, 'the request did reach the site: not safe to repeat blindly');
  assert.ok(Date.now() - t0 < 2000);

  // Through a proxy there is no telling which of the two is slow: the route gets the blame, and the request still counts as sent.
  const p = await httpProxy();
  const viaProxy = await fetchText({ url: new URL(s.url + '/slow'), proxy: hop(p), fresh: true, timeout: 300 }).catch((x) => x);
  assert.equal(viaProxy.code, 'EPROXYTIMEOUT');
  assert.equal(viaProxy.phase, 'proxy');
  assert.equal(viaProxy.sent, true);
  assert.equal(s.hits.length, 2);
});

test('readAll enforces its size limit', async () => {
  const s = await site({
    '/big': (req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(300000, 97));
    },
  });
  const res = await net.request({ url: new URL(s.url + '/big'), infra: true });
  await assert.rejects(net.readAll(res, 100000), { code: 'ETOOBIG' });
  const ok = await net.request({ url: new URL(s.url + '/big'), infra: true });
  assert.equal((await net.readAll(ok, 400000)).length, 300000);
});

test('DNS at the exit: the name itself travels down the chain, whatever kind the exit is', async () => {
  const s = await site({ '/': { body: 'resolved at the exit' } });
  const hosts = { 'only-the-exit-knows.test': '127.0.0.1' };
  const exit5 = await socks5Proxy({ hosts });
  const exitH = await httpProxy({ hosts });
  const exit4 = await socks4Proxy({ hosts });
  const url = new URL('http://only-the-exit-knows.test:' + s.port + '/');
  assert.equal((await fetchText({ url, proxy: hop(exit5), fresh: true })).text, 'resolved at the exit');
  assert.deepEqual(exit5.log, [{ host: 'only-the-exit-knows.test', port: s.port, byName: true }]);
  assert.equal((await fetchText({ url, proxy: hop(exitH), fresh: true })).text, 'resolved at the exit');
  assert.deepEqual(exitH.log, ['only-the-exit-knows.test:' + s.port], 'a tunnel to a name: the proxy looks it up');
  assert.equal((await fetchText({ url, proxy: hop(exit4), fresh: true })).text, 'resolved at the exit');
  assert.deepEqual(
    exit4.log,
    [{ host: 'only-the-exit-knows.test', port: s.port, byName: true }],
    'the oldest kind can be handed a name too (SOCKS4a)'
  );
  assert.equal(s.last().headers.host, 'only-the-exit-knows.test:' + s.port);

  // A SOCKS4 server that takes numbers only refuses; the name is not looked up on this machine instead.
  const old = await socks4Proxy({ hosts, no4a: true });
  await assert.rejects(fetchText({ url, proxy: hop(old), fresh: true }), { code: 'EPROXYREFUSED', phase: 'proxy' });
  assert.equal(s.hits.length, 3);

  // In a chain the name goes to the exit alone: the hops before it only ever see the next hop.
  const entry = await socks5Proxy();
  const exit = await httpProxy({ hosts });
  assert.equal((await fetchText({ url, proxy: chain(hop(entry), hop(exit)), fresh: true })).text, 'resolved at the exit');
  assert.deepEqual(entry.log, [{ host: '127.0.0.1', port: exit.port, byName: false }]);
  assert.deepEqual(exit.log, ['only-the-exit-knows.test:' + s.port]);
});

test('plain HTTP is tunnelled too: a proxy that only carries bytes cannot add a header saying who is behind it', async () => {
  const s = await site({ '/': { body: 'plain' } });
  const p = await httpProxy({ via: true }); // adds "Via" to any request it is handed to forward
  for (let i = 0; i < 2; i++) {
    const r = await fetchText({ url: new URL(s.url + '/?n=' + i), proxy: hop(p), headers: { 'X-Mine': '1', 'User-Agent': 'test' } });
    assert.equal(r.text, 'plain');
  }
  assert.deepEqual(p.log, [s.host], 'one CONNECT for both requests, and no "GET http://…" for the proxy to rewrite');
  for (const hit of s.hits) {
    for (const added of ['via', 'forwarded', 'x-forwarded-for', 'x-real-ip', 'proxy-connection', 'proxy-authorization'])
      assert.equal(hit.headers[added], undefined, added);
    assert.deepEqual(
      hit.raw.filter((_, i) => i % 2 === 0),
      ['X-Mine', 'User-Agent', 'Host', 'Connection'],
      'exactly the headers that were sent'
    );
    assert.equal(hit.url.slice(0, 4), '/?n=', 'and the request line is the ordinary one, not the absolute form proxies are sent');
  }
  net.dropAgents(hop(p));
});

test('housekeeping connections look names up through the resolver stack; proxied ones ask nobody here', async () => {
  const s = await site({ '/': { body: 'found' } });
  const d = await doh({ 'doh-only.test': ['127.0.0.1'] });
  const config = new Config();
  config.reset();
  config.patch({ dns: { servers: [d.url], fallback: false, auto: false, pad: false } });
  const resolver = new Resolver(config);
  net.setResolver(resolver);
  try {
    const r = await fetchText({ url: new URL('http://doh-only.test:' + s.port + '/'), fresh: true, infra: true });
    assert.equal(r.text, 'found');
    assert.deepEqual(d.log, [{ name: 'doh-only.test', type: 1 }]);
    await assert.rejects(fetchText({ url: new URL('http://unknown.test:' + s.port + '/'), fresh: true, infra: true }), {
      code: 'ENOTFOUND',
    });
    const asked = d.log.length;

    // `system`: this machine's resolver even with another one plugged in (how the resolvers themselves are found)
    assert.equal(
      (await fetchText({ url: new URL('http://localhost:' + s.port + '/'), fresh: true, infra: true, system: true })).text,
      'found'
    );

    // `address`: connect there and look nothing up; the request still names the host
    assert.equal(
      (await fetchText({ url: new URL('http://pinned.test:' + s.port + '/'), fresh: true, infra: true, address: '127.0.0.1' })).text,
      'found'
    );
    assert.equal(s.last().headers.host, 'pinned.test:' + s.port);

    // through a proxy, `address` is what the exit is told: the name never reaches it
    const exit = await socks5Proxy();
    assert.equal(
      (await fetchText({ url: new URL('http://pinned.test:' + s.port + '/'), proxy: hop(exit), fresh: true, address: '127.0.0.1' })).text,
      'found'
    );
    assert.deepEqual(exit.log, [{ host: '127.0.0.1', port: s.port, byName: false }]);
    assert.equal(s.last().headers.host, 'pinned.test:' + s.port);
    const four = await socks4Proxy();
    assert.equal(
      (await fetchText({ url: new URL('http://pinned.test:' + s.port + '/'), proxy: hop(four), fresh: true, address: '127.0.0.1' })).text,
      'found'
    );
    assert.deepEqual(four.log, [{ host: '127.0.0.1', port: s.port }]);

    // and without one the exit gets the name: a proxied request never causes a lookup on this side
    const naming = await socks5Proxy({ hosts: { 'doh-only.test': '127.0.0.1' } });
    assert.equal(
      (await fetchText({ url: new URL('http://doh-only.test:' + s.port + '/'), proxy: hop(naming), fresh: true })).text,
      'found'
    );
    assert.deepEqual(naming.log, [{ host: 'doh-only.test', port: s.port, byName: true }]);
    assert.equal(d.log.length, asked, 'the resolver was not asked again after the two housekeeping lookups');
  } finally {
    net.setResolver(null);
    config.reset();
  }
});

test('WebSocket-style upgrades are handed back as a raw socket, also through a chain', async () => {
  const s = await site({});
  const a = await socks5Proxy();
  const b = await httpProxy();
  for (const proxy of [null, chain(hop(a), hop(b))]) {
    const res = await net.request({
      url: new URL(s.url + '/ws'),
      proxy,
      infra: !proxy,
      upgrade: true,
      fresh: true,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    assert.equal(res.statusCode, 101);
    assert.equal(res.headers['sec-websocket-accept'], 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const sock = res.upgrade.socket;
    const frame = Buffer.concat([Buffer.from([0x81, 0x82, 1, 2, 3, 4]), Buffer.from([0x68 ^ 1, 0x69 ^ 2])]); // masked "hi"
    sock.write(frame);
    const reply = await new Promise((resolve) => sock.once('data', resolve));
    assert.equal(reply.subarray(2).toString(), 'echo:hi');
    sock.destroy();
  }
});

test('private addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    '::',
    'fe80::1%eth0',
  ])
    assert.equal(net.isPrivateAddr(ip), true, ip);
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::1',
    '2001:4860:4860::8888',
  ])
    assert.equal(net.isPrivateAddr(ip), false, ip);
});

test('without the test override, local and private targets are refused, with a proxy or without (SSRF guard)', () => {
  // A fresh process with the default settings: Waddle must not be usable to reach the server's own
  // network, nor to send a public proxy poking around in its own.
  const script = `
    const net = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'net.js'))});
    const http = require('http');
    const server = http.createServer((q, s) => s.end('internal')).listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const out = {};
      const proxy = { proto: 'http', host: '203.0.113.1', port: 8080 };
      const attempt = async (key, o) => {
        try { const r = await net.request(Object.assign({ timeout: 1500, connectTimeout: 1500 }, o)); out[key] = 'REACHED ' + r.statusCode; r.resume(); }
        catch (e) { out[key] = e.code || e.message; }
      };
      for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'db.internal', '[::1]', '0.0.0.0', '127.1', '2130706433', '017700000001', '0x7f.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:127.0.0.1]', '[::127.0.0.1]', '[fd00::1]']) {
        const url = new URL('http://' + host + ':' + port + '/');
        await attempt('housekeeping ' + host, { url, infra: true });
        await attempt('proxied ' + host, { url, proxy });
      }
      await attempt('proxied, resolved to a private address', { url: new URL('http://public.example:' + port + '/'), proxy, address: '10.1.2.3' });
      await attempt('proxied, resolved to loopback', { url: new URL('https://public.example/'), proxy, address: '127.0.0.1' });
      console.log(JSON.stringify(out));
      server.close(); process.exit(0);
    });`;
  const env = Object.assign({}, process.env);
  delete env.WADDLE_ALLOW_PRIVATE;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000 }));
  assert.ok(Object.keys(out).length >= 42);
  for (const [what, result] of Object.entries(out)) assert.equal(result, 'EPRIVATE', what + ' -> ' + result);
});

test('explain() turns errors into short plain words', () => {
  assert.equal(typeof net.explain(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'string');
  const said = (code, message) => net.explain(Object.assign(new Error(message || 'x'), { code }));
  assert.equal(said('EDIRECT'), 'no proxy');
  assert.equal(said('ENOPROXY'), 'no proxy');
  assert.equal(said('EPRIVATE'), 'private address blocked');
  assert.equal(said('ENOTFOUND'), 'no such host');
  assert.equal(said('EPROXYTIMEOUT'), 'timed out');
  assert.equal(said('CERT_HAS_EXPIRED'), 'bad certificate');
  assert.equal(said('ECONNRESET'), 'connection reset');
  assert.equal(said('', 'x'.repeat(300)).length, 80, 'anything else is cut short');
  assert.ok(net.explain(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:80'), { code: 'ECONNREFUSED' })).length < 40);
  assert.ok(
    !/1\.2\.3\.4/.test(net.explain(Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:80'), { code: 'ETIMEDOUT' }))),
    'no addresses in user-facing text'
  );
});
void http;
