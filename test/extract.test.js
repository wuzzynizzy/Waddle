'use strict';
require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProxies, protoFromPath, normProto, isPublic, keyOf } = require('../lib/extract');

const addrs = (list) => list.map((p) => (p.proto || '?') + '://' + (p.user ? p.user + ':' + p.pass + '@' : '') + p.host + ':' + p.port);

test('plain ip:port lines, with noise around them', () => {
  const out = extractProxies('8.8.8.8:8080\n1.1.1.1:3128 # fast\nnot a proxy\n\t9.9.9.9:1080\r\n', null);
  assert.deepEqual(addrs(out), ['?://8.8.8.8:8080', '?://1.1.1.1:3128', '?://9.9.9.9:1080']);
});

test('schemes and credentials in front of the address', () => {
  const out = extractProxies('socks5://9.9.9.9:1080\nhttp://user:pw@4.4.4.4:8080\nSOCKS4://5.5.5.5:4145\nhttps://6.6.6.6:443', null);
  assert.deepEqual(addrs(out), ['socks5://9.9.9.9:1080', 'http://user:pw@4.4.4.4:8080', 'socks4://5.5.5.5:4145', 'http://6.6.6.6:443']);
});

test('the protocol hint applies only where a line does not say', () => {
  const out = extractProxies('14.14.14.14:1080\nhttp://15.15.15.15:80', 'socks5');
  assert.deepEqual(addrs(out), ['socks5://14.14.14.14:1080', 'http://15.15.15.15:80']);
});

test('JSON lists in the shapes list sites publish', () => {
  const out = extractProxies(
    JSON.stringify({
      data: [
        { ip: '7.7.7.7', port: 8080, protocol: 'socks5' },
        { ip: '7.7.7.8', port: '3128', type: 'https' },
        { host: '7.7.7.9', port: 4145, protocols: ['socks4'] },
        { ip: '7.7.7.10', port: 1080, protocols: ['http', 'socks5'] },
      ],
    }),
    null
  );
  assert.deepEqual(addrs(out), ['socks5://7.7.7.7:8080', 'http://7.7.7.8:3128', 'socks4://7.7.7.9:4145', 'socks5://7.7.7.10:1080']);
  assert.deepEqual(addrs(extractProxies(JSON.stringify({ socks5: ['3.3.3.3:1080'], http: ['4.4.4.4:80'] }), null)), [
    'socks5://3.3.3.3:1080',
    'http://4.4.4.4:80',
  ]);
  assert.deepEqual(addrs(extractProxies('["5.5.5.5:8080","socks4://6.6.6.6:4145"]', 'http')), [
    'http://5.5.5.5:8080',
    'socks4://6.6.6.6:4145',
  ]);
});

test('CSV and HTML tables: address and port in neighbouring cells', () => {
  assert.deepEqual(addrs(extractProxies('ip,port,country\n11.11.11.11,8080,US\n12.12.12.12,3128,DE', null)), [
    '?://11.11.11.11:8080',
    '?://12.12.12.12:3128',
  ]);
  assert.deepEqual(addrs(extractProxies('<tr><td>13.13.13.13</td><td>8080</td></tr>', 'http')), ['http://13.13.13.13:8080']);
});

test('private, reserved and malformed addresses never get in', () => {
  const junk =
    '127.0.0.1:80 10.0.0.1:80 192.168.1.1:80 172.16.0.1:8080 169.254.1.1:80 0.0.0.0:80 224.0.0.1:80 100.64.0.1:80 255.255.255.255:80 999.1.1.1:80 16.16.16.16:65536 16.16.16.17:99999';
  assert.deepEqual(
    extractProxies(junk + ' 15.15.15.15:80', null).map((p) => p.host),
    ['15.15.15.15']
  );
  assert.equal(extractProxies('127.0.0.1:8080', null, { allowPrivate: true }).length, 1);
  for (const ip of [
    '10.1.1.1',
    '192.168.0.1',
    '172.31.255.255',
    '127.0.0.1',
    '169.254.0.1',
    '100.64.0.1',
    '0.1.2.3',
    '224.0.0.1',
    '198.18.0.1',
  ])
    assert.equal(isPublic(ip), false, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '100.63.0.1']) assert.equal(isPublic(ip), true, ip);
});

test('limit stops early on huge inputs', () => {
  const big = Array.from({ length: 5000 }, (_, i) => '20.' + (i >> 8) + '.' + (i & 255) + '.1:8080').join('\n');
  assert.equal(extractProxies(big, null).length, 5000);
  assert.equal(extractProxies(big, null, { limit: 100 }).length, 100);
});

test('protocol from a file name', () => {
  assert.deepEqual(['socks5.txt', 'proxies/http.txt', 'list/SOCKS4_RAW.txt', 'https.txt', 'all.txt', 'data.json'].map(protoFromPath), [
    'socks5',
    'http',
    'socks4',
    'http',
    null,
    null,
  ]);
  assert.deepEqual(['HTTPS', 'socks5h', 'SOCKS4a', 'socks', 'http', 'vmess', '', null].map(normProto), [
    'http',
    'socks5',
    'socks4',
    'socks5',
    'http',
    null,
    null,
    null,
  ]);
  assert.equal(keyOf({ proto: 'http', host: '1.2.3.4', port: 80 }), 'http://1.2.3.4:80');
  assert.notEqual(keyOf({ proto: null, host: '1.2.3.4', port: 80 }), keyOf({ proto: 'http', host: '1.2.3.4', port: 80 }));
});

test('response time: hostile multi-megabyte input is handled in linear time', () => {
  // Lists come from strangers. None of these may stall the event loop.
  const cases = {
    digits: '1'.repeat(4e6),
    dots: '1.'.repeat(2e6),
    colons: ('1.1.1.1:' + ':'.repeat(50)).repeat(60000),
    almost: '12.34.56.'.repeat(400000),
    at: ('a:b@'.repeat(40) + '8.8.8.8:80 ').repeat(20000),
    slashes: ('/'.repeat(30) + '8.8.8.8:80 ').repeat(60000),
    spaces: ' '.repeat(4e6) + '8.8.8.8:80',
    commas: '1.2.3.4' + ','.repeat(4e6),
    json: '[' + '['.repeat(5000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    extractProxies(text, null);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, name + ' took ' + ms.toFixed(0) + ' ms');
  }
  const real = Array.from(
    { length: 200000 },
    (_, i) => 20 + (i % 70) + '.' + ((i >> 8) & 255) + '.' + (i & 255) + '.7:' + (1024 + (i % 60000))
  ).join('\n');
  const t0 = process.hrtime.bigint();
  const n = extractProxies(real, null).length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(n, 200000);
  assert.ok(ms < 2500, '200k-line list took ' + ms.toFixed(0) + ' ms');
});
