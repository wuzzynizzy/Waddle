'use strict';
require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TarScanner } = require('../lib/tar');

/** Build a POSIX tar archive in memory. */
function tar(files) {
  const blocks = [];
  for (const f of files) {
    const data = Buffer.from(f.data || '');
    const h = Buffer.alloc(512);
    h.write(f.name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(' ', 148, 156);
    h.write(f.type || '0', 156);
    h.write('ustar\0' + '00', 257);
    if (f.prefix) h.write(f.prefix, 345, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function scan(archive, chunk, want) {
  const got = {};
  const asked = [];
  const s = new TarScanner({
    want: (p, size) => {
      asked.push(p + ':' + size);
      return want(p, size);
    },
    onFile: (p, buf) => {
      got[p] = buf.toString('utf8');
    },
  });
  for (let i = 0; i < archive.length; i += chunk) s.write(archive.subarray(i, i + chunk));
  return { got, asked, done: s.done };
}

const FILES = [
  { name: 'repo-main/', type: '5' },
  { name: 'repo-main/http.txt', data: '1.1.1.1:80\n2.2.2.2:8080\n' },
  { name: 'repo-main/README.md', data: '# readme' },
  { name: 'repo-main/big.bin', data: 'x'.repeat(5000) },
  { name: 'repo-main/proxies/socks5.txt', data: 'y'.repeat(1300) },
  { name: 'repo-main/empty.txt', data: '' },
];

test('reads the files it is asked for and skips the rest', () => {
  const { got, asked, done } = scan(tar(FILES), 65536, (p) => p.endsWith('.txt'));
  assert.deepEqual(Object.keys(got).sort(), ['repo-main/empty.txt', 'repo-main/http.txt', 'repo-main/proxies/socks5.txt']);
  assert.equal(got['repo-main/http.txt'], '1.1.1.1:80\n2.2.2.2:8080\n');
  assert.equal(got['repo-main/proxies/socks5.txt'].length, 1300);
  assert.ok(asked.includes('repo-main/big.bin:5000'), 'size is offered to want()');
  assert.ok(!asked.some((a) => a.startsWith('repo-main/:')), 'directories are not offered');
  assert.equal(done, true);
});

test('any chunking gives the same result', () => {
  const archive = tar(FILES);
  const ref = JSON.stringify(scan(archive, archive.length, () => true).got);
  for (const chunk of [1, 7, 100, 511, 512, 513, 1000, 4096]) {
    assert.equal(JSON.stringify(scan(archive, chunk, () => true).got), ref, 'chunk size ' + chunk);
  }
});

test('long paths: ustar prefix field and pax headers', () => {
  const long = 'repo-main/' + 'deep/'.repeat(30) + 'http.txt';
  const pax = (path) => {
    const body = ' path=' + path + '\n';
    let len = body.length + 2;
    len = String(len + String(len).length - 2).length + body.length;
    return len + body;
  };
  const archive = tar([
    { name: 'socks4.txt', prefix: 'repo-main/a/very/long/prefix', data: '3.3.3.3:1080' },
    { name: 'PaxHeader', type: 'x', data: pax(long) },
    { name: 'truncated-name.txt', data: '4.4.4.4:80' },
    { name: 'repo-main/after.txt', data: '5.5.5.5:80' },
  ]);
  const { got } = scan(archive, 300, () => true);
  assert.equal(got['repo-main/a/very/long/prefix/socks4.txt'], '3.3.3.3:1080');
  assert.equal(got[long], '4.4.4.4:80', 'pax path replaces the short name');
  assert.equal(got['repo-main/after.txt'], '5.5.5.5:80', 'pax path applies to one entry only');
});

test('garbage and truncated archives do not throw', () => {
  assert.doesNotThrow(() => scan(Buffer.from('this is not a tar archive at all'.repeat(100)), 100, () => true));
  const archive = tar(FILES);
  const cut = scan(archive.subarray(0, 1500), 512, () => true);
  assert.equal(cut.done, false);
  assert.deepEqual(Object.keys(cut.got), ['repo-main/http.txt']);
});
