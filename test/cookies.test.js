'use strict';
require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Jar, session, siteOf } = require('../lib/cookies');

const U = new URL('https://www.shop.test/cart/view');
const names = (s) =>
  s
    .split('; ')
    .filter(Boolean)
    .map((c) => c.split('=')[0])
    .sort()
    .join(',');

test('scope: host-only, Domain, Path, Secure', () => {
  const j = new Jar();
  j.set('host=1; Path=/', U);
  j.set('dom=2; Domain=shop.test; Path=/', U);
  j.set('cart=3', U); // default path: /cart
  j.set('sec=4; Path=/; Secure', U);
  assert.equal(names(j.header(U)), 'cart,dom,host,sec');
  assert.equal(names(j.header(new URL('https://www.shop.test/'))), 'dom,host,sec', 'path-scoped cookie stays in its path');
  assert.equal(names(j.header(new URL('https://api.shop.test/'))), 'dom', 'only Domain cookies reach a sibling host');
  assert.equal(names(j.header(new URL('http://www.shop.test/'))), 'dom,host', 'Secure cookies never travel over plain HTTP');
  assert.equal(j.header(new URL('https://other.test/')), '');
  assert.equal(j.header(new URL('https://evilshop.test/')), '', 'suffix match is on label boundaries');
});

test('a site cannot set cookies for someone else or for a whole TLD', () => {
  const j = new Jar();
  j.set('a=1; Domain=other.test', U);
  j.set('b=2; Domain=test', U);
  j.set('c=3; Domain=co.uk', new URL('https://x.example.co.uk/'));
  assert.equal(j.size, 0);
});

test('HttpOnly is sent upstream but hidden from scripts, and scripts cannot create it', () => {
  const j = new Jar();
  j.set('sid=secret; Path=/; HttpOnly', U);
  j.set('theme=dark; Path=/', U);
  assert.equal(names(j.header(U)), 'sid,theme');
  assert.equal(j.visible(U), 'theme=dark');
  j.set('forged=1; Path=/; HttpOnly', U, true);
  j.set('sid=stolen; Path=/', U, true);
  assert.equal(names(j.header(U)), 'sid,theme');
  assert.ok(j.header(U).includes('sid=secret'), 'a script cannot overwrite an HttpOnly cookie');
});

test('expiry and deletion', () => {
  const j = new Jar();
  j.set('gone=1; Max-Age=0', U);
  j.set('old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', U);
  assert.equal(j.size, 0);
  j.set('a=1; Path=/', U);
  j.set('b=2; Path=/; Max-Age=3600', U);
  assert.equal(names(j.header(U)), 'a,b');
  j.set('a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', U);
  assert.equal(names(j.header(U)), 'b');
  j.set('b=3; Path=/', U);
  assert.equal(j.header(U), 'b=3', 'same name, domain and path replaces');
  j.clear();
  assert.equal(j.size, 0);
});

test('longer paths come first, as browsers send them', () => {
  const j = new Jar();
  j.set('x=root; Path=/', U);
  j.set('x=cart; Path=/cart', U);
  assert.equal(j.header(U), 'x=cart; x=root');
});

test('the jar is bounded', () => {
  const j = new Jar();
  for (let i = 0; i < 5000; i++) j.set('c' + i + '=v; Path=/', new URL('https://h' + (i % 50) + '.test/'));
  assert.ok(j.size <= 3000, 'size ' + j.size);
  j.set('big=' + 'x'.repeat(10000), U);
  assert.ok(!j.header(U).includes('big='), 'oversized cookies are refused');
});

test('siteOf: registrable domain', () => {
  const cases = {
    'www.shop.test': 'shop.test',
    'a.b.example.co.uk': 'example.co.uk',
    'example.com': 'example.com',
    localhost: 'localhost',
    '127.0.0.1': '127.0.0.1',
    'foo.bar.com.au': 'bar.com.au',
  };
  for (const [host, site] of Object.entries(cases)) assert.equal(siteOf(host), site, host);
});

function fake(cookie) {
  const headers = {};
  return {
    req: { headers: cookie ? { cookie } : {}, socket: {} },
    res: {
      getHeader: (k) => headers[k.toLowerCase()],
      setHeader: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      appendHeader: (k, v) => {
        headers[k.toLowerCase()] = [].concat(headers[k.toLowerCase()] || [], v);
      },
    },
    headers,
  };
}

test('sessions: one private jar per browser, kept by an HttpOnly cookie', () => {
  const a = fake();
  const s1 = session(a.req, a.res, false);
  const set = String([].concat(a.headers['set-cookie'])[0]);
  assert.match(set, /^waddle=[\w-]{20,}; /);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  const id = /^waddle=([^;]+)/.exec(set)[1];

  const again = fake('other=1; waddle=' + id);
  const s2 = session(again.req, again.res, false);
  assert.equal(s2.jar, s1.jar, 'same cookie, same jar');
  assert.equal(again.headers['set-cookie'], undefined, 'no new cookie for a known session');

  const b = fake();
  const s3 = session(b.req, b.res, false);
  assert.notEqual(s3.jar, s1.jar, 'another browser gets its own jar');
  assert.notEqual(s3.seed, s1.seed, 'and its own fingerprint seed');

  const forged = fake('waddle=made-up-value');
  const s4 = session(forged.req, forged.res, false);
  assert.notEqual(s4.jar, s1.jar);
  assert.ok(forged.headers['set-cookie'], 'unknown ids are replaced, never adopted');
});

test('sessions: inside an HTTPS iframe the cookie must be SameSite=None; Secure; Partitioned', () => {
  const a = fake();
  session(a.req, a.res, true);
  const set = String([].concat(a.headers['set-cookie'])[0]);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=None/);
  assert.match(set, /Partitioned/);
});

test('sessions: a WebSocket upgrade has no response object', () => {
  assert.doesNotThrow(() => session(fake().req, null, false));
});
