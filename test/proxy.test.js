'use strict';
const { site, browser, get, world, judge, canary, doh, httpProxy, socks5Proxy, closeAll, until, sleep } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createApp } = require('../server');
const net = require('../lib/net');
const { PAGE_CSP, GUARD_CSP } = require('../lib/proxy');

const apps = [];
test.after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  net.dropAgents();
  await closeAll();
});
test.afterEach(() => net.dropAgents());

// Waddle never connects to a site itself, so even the simplest test needs an exit. One is shared by every
// test that does not care which: an HTTP proxy stand-in that the judge places in the United States.
let shared;
async function exits() {
  if (!shared) shared = { judge: await judge('203.0.113.10', 'US'), canary: await canary(), px: await httpProxy() };
  return shared;
}

/**
 * A Waddle server with one live exit, cut off from everything outside this machine: no proxy lists,
 * no resolver list, no system resolver. HTTPS-only is off unless a test asks for it, since the stand-in sites speak plain HTTP.
 * @param {object} [opt] { exit: false } starts it with no proxy at all
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
    k.px.log.length = 0;
  }
  return { app, port, b: browser(port), origin: 'http://127.0.0.1:' + port, px: k.px };
}

/** The settings a proxied document starts with, as its page script reads them. */
const bootOf = (html) =>
  JSON.parse(
    /data-w="([^"]+)"/
      .exec(html)[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  );

const PAGE =
  '<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/s.css"></head><body><a href="/next">next</a><img src="pic.png"><form action="/post" method="post"></form><script src="https://cdn.test/lib.js"></script></body></html>';

// ---- pages ----------------------------------------------------------------------------

test('a page comes back rewritten, with the page script first in <head>', async () => {
  const s = await site({ '/dir/': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: PAGE } });
  const { b, px } = await start();
  const r = await b.page(s.url + '/dir/');
  const P = '/~/' + s.url;
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-waddle'], '1', "every answer carries Waddle's mark");
  assert.deepEqual(px.log, [s.host], 'the page was fetched through the exit, in a tunnel');
  assert.equal(s.hits.length, 1);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(r.text, /^<!doctype html><html><head><script src="\/-\/client\.js\?v=[\w-]+" data-w="[^"]+"><\/script><title>/);
  for (const want of [
    `href="${P}/s.css"`,
    `href="${P}/next"`,
    `src="${P}/dir/pic.png"`,
    `action="${P}/post"`,
    'src="/~/https://cdn.test/lib.js"',
  ])
    assert.ok(r.text.includes(want), want);
  const boot = bootOf(r.text);
  assert.equal(boot.page.on, true);
  assert.match(boot.page.nav.ua, /Chrome\/\d+/);
  assert.equal(typeof boot.cookie, 'string');
  assert.equal(boot.jar, true, 'the page in the address bar may keep cookies');
  assert.equal(boot.part, undefined, 'and its storage is its own');
  assert.equal(r.headers['content-security-policy'], PAGE_CSP, 'frames, plugins and form posts can only go to Waddle');
  assert.match(r.headers['server-timing'], /^up;dur=\d+, rw;dur=\d+$/, 'upstream and rewrite times are reported');
  assert.equal(r.headers['cache-control'], 'no-store', 'documents carry session state, so they are not cached');
});

test('sub-resources: CSS and module scripts are rewritten, everything else passes through byte for byte', async () => {
  const png = crypto.randomBytes(70000);
  const s = await site({
    '/s.css': {
      headers: { 'Content-Type': 'text/css', 'Cache-Control': 'max-age=600', ETag: '"v1"' },
      body: 'body{background:url(/bg.png)} @import "more.css";',
    },
    '/m.js': { headers: { 'Content-Type': 'text/javascript' }, body: 'import x from "/dep.js"; fetch("/api")' },
    '/classic.js': {
      headers: { 'Content-Type': 'text/javascript' },
      body: 'var s = "import x from \'/dep.js\'"; location.href = "/x"; obj.import("/y");',
    },
    '/pic.png': (req, res) => {
      if (req.headers['if-none-match'] === '"p1"') {
        res.writeHead(304, { ETag: '"p1"' });
        return res.end();
      }
      if (req.headers.range === 'bytes=10-19') {
        res.writeHead(206, { 'Content-Type': 'image/png', 'Content-Range': 'bytes 10-19/70000', 'Content-Length': 10 });
        return res.end(png.subarray(10, 20));
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        ETag: '"p1"',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes',
      });
      res.end(png);
    },
    '/data.json': { headers: { 'Content-Type': 'application/json' }, body: '{"href":"/not/rewritten"}' },
    '/map.json': { headers: { 'Content-Type': 'application/json' }, body: '{"imports":{"a":"/a.js"}}' },
    '/v.m3u8': { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }, body: '#EXTM3U\n#EXTINF:4,\nseg1.ts\n' },
  });
  const { b } = await start();
  const P = '/~/' + s.url,
    from = s.url + '/';

  const css = await b.fetch(s.url + '/s.css', from, { dest: 'style' });
  assert.equal(css.text, `body{background:url(${P}/bg.png)} @import "${P}/more.css";`);
  assert.equal(css.headers['cache-control'], 'max-age=600', 'static files stay cacheable in the browser');
  assert.match(css.headers['server-timing'], /rw;dur=/);

  const mod = await b.fetch(s.url + '/m.js', from, { dest: 'script' });
  assert.equal(mod.text, `import x from "${P}/dep.js"; fetch("/api")`);
  const classic = await b.fetch(s.url + '/classic.js', from, { dest: 'script' });
  assert.equal(
    classic.text,
    'var s = "import x from \'/dep.js\'"; location.href = "/x"; obj.import("/y");',
    'ordinary code is never touched, even when a string looks like an import'
  );

  const img = await b.fetch(s.url + '/pic.png', from, { dest: 'image' });
  assert.equal(img.status, 200);
  assert.ok(img.body.equals(png), 'binary data is untouched');
  assert.equal(img.headers['content-length'], '70000');
  assert.equal(img.headers.etag, '"p1"');
  assert.equal(img.headers['cache-control'], 'public, max-age=3600');
  const cached = await b.fetch(s.url + '/pic.png', from, { dest: 'image', headers: { 'If-None-Match': '"p1"' } });
  assert.equal(cached.status, 304, 'conditional requests work through the proxy');
  const part = await b.fetch(s.url + '/pic.png', from, { dest: 'video', headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 10-19/70000');
  assert.ok(part.body.equals(png.subarray(10, 20)), 'range requests (media seeking) work');

  assert.equal((await b.fetch(s.url + '/data.json', from)).text, '{"href":"/not/rewritten"}', 'data is data');
  assert.equal(
    (await b.fetch(s.url + '/v.m3u8', from)).text,
    `#EXTM3U\n#EXTINF:4,\n${P}/seg1.ts\n`,
    'HLS playlists point back at the proxy'
  );
});

test('compressed and oddly encoded pages are decoded before rewriting', async () => {
  const html = '<html><head><title>é</title></head><body><a href="/x">caf\u00e9 \u65e5\u672c</a></body></html>';
  const s = await site({
    '/gzip': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(html));
    },
    '/deflate': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'deflate' });
      res.end(zlib.deflateSync(html));
    },
    '/br': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'br' });
      res.end(zlib.brotliCompressSync(html));
    },
    '/latin1': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=ISO-8859-1' });
      res.end(Buffer.from('<html><head></head><body><a href="/x">caf\xe9</a></body></html>', 'latin1'));
    },
    '/meta': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(Buffer.from('<html><head><meta charset="windows-1252"></head><body><a href="/x">caf\xe9 \x80</a></body></html>', 'latin1'));
    },
    '/sjis': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=Shift_JIS' });
      res.end(
        Buffer.concat([
          Buffer.from('<html><head></head><body><a href="/x">'),
          Buffer.from([0x93, 0xfa, 0x96, 0x7b]),
          Buffer.from('</a></body></html>'),
        ])
      );
    },
    '/bom': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html)]));
    },
    '/badgzip': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      res.end('this is not gzip');
    },
  });
  const { b } = await start();
  const link = `href="/~/${s.url}/x"`;
  for (const p of ['/gzip', '/deflate', '/br', '/bom']) {
    const r = await b.page(s.url + p, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes(link) && r.text.includes('caf\u00e9 \u65e5\u672c'), p);
  }
  const latin = await b.page(s.url + '/latin1');
  assert.ok(latin.text.includes(link) && latin.text.includes('caf\u00e9'), 'ISO-8859-1 from the header');
  assert.equal(latin.headers['content-type'], 'text/html; charset=utf-8', 'everything is delivered as UTF-8');
  const meta = await b.page(s.url + '/meta');
  assert.ok(meta.text.includes('caf\u00e9 \u20ac'), 'windows-1252 from <meta charset>');
  assert.ok((await b.page(s.url + '/sjis')).text.includes('\u65e5\u672c'), 'Shift_JIS');
  const bad = await b.page(s.url + '/badgzip');
  assert.equal(bad.headers['x-waddle-error'], 'broken', 'a corrupt body is an error page, not a crash');
  assert.equal(bad.headers['x-waddle-status'], '502');
  assert.equal(bad.status, 200, 'sent as 200: see the edge test below');
  assert.match(bad.text, /<h1>Could not load<\/h1>/);
  assert.equal(bad.headers['content-security-policy'], undefined, "nothing of the site's answer is left on it");
});

test('redirects stay inside the proxy', async () => {
  const s = await site({
    '/rel': (req, res) => {
      res.writeHead(302, { Location: 'next?x=1' });
      res.end();
    },
    '/abs': (req, res) => {
      res.writeHead(301, { Location: 'https://other.test/p?q=a b' });
      res.end();
    },
    '/scheme': (req, res) => {
      res.writeHead(307, { Location: '//cdn.test/x' });
      res.end();
    },
    '/refresh': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', Refresh: '3; url=/later' });
      res.end('<html></html>');
    },
    '/js': (req, res) => {
      res.writeHead(302, { Location: 'javascript:alert(1)' });
      res.end();
    },
  });
  const { b } = await start();
  assert.equal((await b.page(s.url + '/dir/../rel')).headers.location, '/~/' + s.url + '/next?x=1');
  const abs = await b.page(s.url + '/abs');
  assert.equal(abs.status, 301);
  assert.equal(abs.headers.location, '/~/https://other.test/p?q=a%20b');
  assert.equal((await b.page(s.url + '/scheme')).headers.location, '/~/http://cdn.test/x');
  assert.equal((await b.page(s.url + '/refresh')).headers.refresh, '3; url=/~/' + s.url + '/later');
  const js = await b.page(s.url + '/js');
  assert.ok(!/^javascript:/i.test(js.headers.location || ''), 'a script URL is never handed to the browser as a redirect on our origin');
});

test('forms and uploads: the body arrives unchanged; HEAD has no body; oversized uploads are refused', async () => {
  const seen = [];
  const s = await site({
    '/post': (req, res, body) => {
      seen.push({
        method: req.method,
        type: req.headers['content-type'],
        len: body.length,
        sha: crypto.createHash('sha1').update(body).digest('hex'),
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('got ' + body.length);
    },
  });
  const { b, port } = await start();
  const form = await b.page(s.url + '/post', {
    method: 'POST',
    body: 'a=1&b=%C3%A9',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(form.text, 'got 12');
  assert.equal(seen[0].type, 'application/x-www-form-urlencoded');
  const blob = crypto.randomBytes(3 << 20);
  const up = await b.fetch(s.url + '/post', s.url + '/', {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(up.text, 'got ' + blob.length);
  assert.equal(seen[1].method, 'PUT');
  assert.equal(seen[1].sha, crypto.createHash('sha1').update(blob).digest('hex'), '3 MB upload intact');
  const head = await b.fetch(s.url + '/post', s.url + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const before = seen.length;
  // Declared size over the limit: refused before a byte of it is read.
  const declared = await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/~/' + s.url + '/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 40 << 20 },
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      }
    );
    req.on('error', () => resolve('reset'));
    req.write(Buffer.alloc(1 << 16));
  });
  assert.equal(declared, 413);
  // No declared size (chunked): cut off as soon as the limit is crossed.
  const chunked = await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/~/' + s.url + '/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', () => resolve('reset'));
    const block = Buffer.alloc(1 << 20);
    let sent = 0;
    const more = () => {
      if (req.destroyed || sent >= 40) return req.destroyed || req.end();
      sent++;
      req.write(block, () => setImmediate(more));
    };
    more();
  });
  assert.ok(chunked === 413 || chunked === 'reset', 'a 40 MB chunked upload is cut off: ' + chunked);
  assert.equal(seen.length, before, 'neither reaches the site');
});

// ---- privacy ---------------------------------------------------------------------------

test('what the site sees: a clean, coherent browser, and nothing about the real one', async () => {
  const s = await site({
    '/echo': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    },
  });
  const { b, app, origin } = await start();
  const real = {
    'User-Agent': 'RealBrowser/1.0 (my actual machine)',
    'Accept-Language': 'fr-CA,fr;q=0.9',
    'X-Forwarded-For': '9.9.9.9',
    Forwarded: 'for=9.9.9.9',
    Via: '1.1 corp-proxy',
    'X-Real-IP': '9.9.9.9',
    'CF-Connecting-IP': '9.9.9.9',
    'Sec-CH-UA': '"Real";v="1"',
    'Sec-CH-UA-Platform': '"RealOS"',
    Origin: origin,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Waddle': '1',
    Authorization: 'Bearer page-token',
  };
  const r = await b.fetch(s.url + '/echo', s.url + '/app/page?secret=1', { headers: real });
  const h = JSON.parse(r.text);
  assert.match(
    h['user-agent'],
    /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/
  );
  assert.equal(h['accept-language'], 'en-US,en;q=0.9');
  for (const leak of [
    'x-forwarded-for',
    'forwarded',
    'via',
    'x-real-ip',
    'cf-connecting-ip',
    'x-waddle',
    'x-forwarded-host',
    'x-forwarded-proto',
  ])
    assert.equal(h[leak], undefined, leak + ' must not reach the site');
  assert.equal(h.host, s.host);
  assert.equal(h.origin, s.url, "Origin is the page's real origin, not Waddle's");
  assert.equal(h.referer, s.url + '/app/page?secret=1', 'same-origin Referer is the real page address');
  assert.equal(h['x-requested-with'], 'XMLHttpRequest', "the page's own headers pass");
  assert.equal(h.authorization, 'Bearer page-token');
  assert.ok(!JSON.stringify(h).includes('RealBrowser') && !JSON.stringify(h).includes('RealOS') && !JSON.stringify(h).includes('fr-CA'));
  assert.ok(!/waddle=/.test(h.cookie || ''), "Waddle's own session cookie stays home");
  assert.equal(h['sec-ch-ua'], undefined, 'like Chrome, no client hints over plain HTTP');

  // Referer policy for cross-site requests: origin only by default, full or none on request.
  const other = await site({
    '/echo': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    },
  });
  const cross = async () => JSON.parse((await b.fetch(other.url + '/echo', s.url + '/app/page?secret=1')).text).referer;
  assert.equal(await cross(), s.url + '/');
  app.config.patch({ spoof: { referer: 'none' } });
  assert.equal(await cross(), undefined);
  app.config.patch({ spoof: { referer: 'full' } });
  assert.equal(await cross(), s.url + '/app/page?secret=1');

  // Another identity: the headers change together.
  app.config.patch({ spoof: { system: 'win-firefox', languages: 'de-DE,de', dnt: false } });
  const ff = JSON.parse((await b.fetch(s.url + '/echo', s.url + '/')).text);
  assert.match(ff['user-agent'], /Gecko\/20100101 Firefox\/\d+\.0$/);
  assert.equal(ff['accept-language'], 'de-DE,de;q=0.9');
  assert.equal(ff.dnt, undefined);
  assert.equal(ff['sec-gpc'], undefined);
  app.config.patch({ spoof: { dnt: true } });
  const dnt = JSON.parse((await b.fetch(s.url + '/echo', s.url + '/')).text);
  assert.equal(dnt.dnt, '1');
  assert.equal(dnt['sec-gpc'], '1');

  // Spoofing off: the real browser shows through, but the address-revealing headers are still dropped.
  app.config.patch({ spoof: { on: false } });
  const off = JSON.parse((await b.fetch(s.url + '/echo', s.url + '/', { headers: real })).text);
  assert.equal(off['user-agent'], 'RealBrowser/1.0 (my actual machine)');
  assert.equal(off['x-forwarded-for'], undefined);
});

test('header names reach the site spelled as a browser spells them, also when a front in between lower-cased them', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, port } = await start();
  const names = () => s.last().raw.filter((x, i) => i % 2 === 0);
  // Straight from a browser: the names pass as they were written, the page's own included.
  await b.page(s.url + '/', { headers: { 'User-Agent': 'RealBrowser/1.0', 'Upgrade-Insecure-Requests': '1', 'X-CUSTOM-thing': 'kept' } });
  let seen = names();
  assert.equal(seen[0], 'Host');
  for (const n of [
    'User-Agent',
    'Accept',
    'Upgrade-Insecure-Requests',
    'X-CUSTOM-thing',
    'Accept-Encoding',
    'Accept-Language',
    'DNT',
    'Sec-GPC',
  ])
    assert.ok(seen.includes(n), n + ' in ' + seen.join(', '));

  // Through an HTTP/2 host or CDN every name arrives in lower case. Sites are spoken to over HTTP/1.1,
  // where no browser writes "user-agent": the usual spelling is put back.
  const r = await get(port, '/~/' + s.url + '/', {
    headers: {
      host: '127.0.0.1:' + port,
      connection: 'close',
      'user-agent': 'RealBrowser/1.0',
      accept: 'text/html,*/*',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
      'accept-language': 'fr',
      'x-custom-thing': 'kept',
      cookie: b.cookie,
    },
  });
  assert.equal(r.status, 200);
  seen = names();
  assert.deepEqual(
    seen.filter((n) => n === n.toLowerCase()),
    [],
    'no lower-case names among ' + seen.join(', ')
  );
  for (const n of [
    'Host',
    'User-Agent',
    'Accept',
    'Sec-Fetch-Site',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Dest',
    'Upgrade-Insecure-Requests',
    'X-Custom-Thing',
    'Accept-Language',
    'DNT',
    'Sec-GPC',
  ])
    assert.ok(seen.includes(n), n + ' in ' + seen.join(', '));
  assert.equal(s.last().headers['x-custom-thing'], 'kept');
});

test('what the browser gets back: site headers that would break or escape the proxy are removed', async () => {
  const s = await site({
    '/': (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'",
        'Content-Security-Policy-Report-Only': "default-src 'self'",
        'X-Frame-Options': 'DENY',
        'Strict-Transport-Security': 'max-age=31536000',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-site',
        'Report-To': '{"group":"x"}',
        NEL: '{"report_to":"x"}',
        'Alt-Svc': 'h3=":443"',
        Link: '</style.css>; rel=preload; as=style, <https://cdn.test/a.js>; rel=preload',
        'Clear-Site-Data': '"*"',
        'Set-Cookie': 'sid=1; Path=/',
        'X-Custom': 'kept',
        'Content-Language': 'en',
        'Permissions-Policy': 'camera=()',
        'Access-Control-Allow-Origin': 'https://elsewhere.test',
      });
      res.end('<html><head></head><body></body></html>');
    },
  });
  const { b } = await start();
  const r = await b.page(s.url + '/');
  assert.equal(r.headers['content-security-policy'], PAGE_CSP, "the site's policy is replaced by Waddle's own");
  for (const gone of [
    'content-security-policy-report-only',
    'x-frame-options',
    'strict-transport-security',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'report-to',
    'nel',
    'alt-svc',
    'clear-site-data',
    'permissions-policy',
    'link',
  ]) {
    assert.equal(r.headers[gone], undefined, gone);
  }
  assert.ok(
    !(r.headers['set-cookie'] || []).some((c) => /^sid=/.test(c)),
    "site cookies live in the server-side jar, never on Waddle's own origin"
  );
  assert.equal(r.headers['x-custom'], 'kept');
  assert.equal(r.headers['content-language'], 'en');
  assert.equal(r.headers['referrer-policy'], 'same-origin', 'the browser never sends a Waddle address to anyone else');
});

test('cookies: kept per visitor on the server, sent back to the right site only', async () => {
  const s = await site({
    '/login': (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': ['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/', 'gone=1; Max-Age=0'],
      });
      res.end('<html><head></head></html>');
    },
    '/whoami': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(req.headers.cookie || '');
    },
    '/api': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'api=1; Path=/' });
      res.end('{}');
    },
  });
  const { b, port, origin } = await start();
  const page = s.url + '/login';
  const login = await b.page(page);
  assert.match(b.cookie, /^waddle=/);
  const boot = /data-w="([^"]+)"/.exec(login.text)[1].replace(/&quot;/g, '"');
  assert.equal(JSON.parse(boot).cookie, 'theme=dark', 'the page starts with its script-visible cookies; HttpOnly ones are never exposed');
  assert.equal((await b.fetch(s.url + '/whoami', page)).text, 'sid=abc; theme=dark');
  assert.equal((await b.fetch('http://localhost:' + s.port + '/whoami', page)).text, '', 'another host gets none of them');

  // fetch()/XHR replies tell the page script about new cookies
  const api = await b.fetch(s.url + '/api', page);
  assert.equal(decodeURIComponent(api.headers['x-waddle-cookie']), 'theme=dark; api=1');
  // document.cookie reads and writes go through /-/cookie
  const ref = { Referer: origin + '/~/' + page };
  assert.equal((await b.raw('/-/cookie', { headers: ref })).text, 'theme=dark; api=1');
  assert.equal(
    (await b.raw('/-/cookie', { method: 'POST', body: 'js=2; Path=/', headers: Object.assign({ 'Content-Type': 'text/plain' }, ref) }))
      .status,
    204
  );
  await b.raw('/-/cookie', { method: 'POST', body: 'sid=stolen; Path=/', headers: Object.assign({ 'Content-Type': 'text/plain' }, ref) });
  assert.equal(
    (await b.fetch(s.url + '/whoami', page)).text,
    'sid=abc; theme=dark; api=1; js=2',
    'a script cannot overwrite an HttpOnly cookie'
  );
  assert.equal((await b.raw('/-/cookie')).text, '', 'without a page there is no cookie context');

  // a second visitor has an empty jar
  const b2 = browser(port);
  assert.equal((await b2.fetch(s.url + '/whoami', page)).text, '');
  assert.equal((await b.api('state')).json.cookies, 4);
  assert.equal((await b2.api('state')).json.cookies, 0);
  // clearing
  assert.equal((await b.api('cookies', {})).json.cookies, 0);
  assert.equal((await b.fetch(s.url + '/whoami', page)).text, '');
});

test('cookies do not cross sites', async () => {
  const hosts = {};
  const s = await site({
    '*': (req, res) => {
      hosts[req.headers.host] = req.headers.cookie || '';
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'who=' + req.headers.host.split(':')[0] + '; Path=/' });
      res.end('<html></html>');
    },
  });
  const { b } = await start();
  // localhost and 127.0.0.1 are different sites that happen to be the same server
  await b.page('http://localhost:' + s.port + '/');
  await b.page('http://127.0.0.1:' + s.port + '/');
  await b.page('http://localhost:' + s.port + '/again');
  await b.page('http://127.0.0.1:' + s.port + '/again');
  assert.equal(hosts['localhost:' + s.port], 'who=localhost');
  assert.equal(hosts['127.0.0.1:' + s.port], 'who=127.0.0.1');
});

// ---- failures --------------------------------------------------------------------------

test('failures are explained: a readable page for documents, one line for everything else', async () => {
  const s = await site({ '/slow': () => {}, '/': { body: PAGE } });
  const { b, app } = await start({ route: { timeout: 3000 } });
  const dead = await b.page('http://127.0.0.1:1/');
  assert.equal(dead.headers['x-waddle-error'], 'connect');
  assert.equal(dead.headers['x-waddle-status'], '502');
  assert.equal(dead.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(dead.headers['cache-control'], 'no-store');
  assert.match(dead.text, /<h1>Could not connect<\/h1><p>No exit that was tried could reach this address\. The site may be down\.<\/p>/);
  assert.match(dead.text, /<div class="host">127\.0\.0\.1:1<\/div>/);
  assert.match(dead.text, /<button class="go" data-act="retry">Try again<\/button><button data-act="exit" hidden>New exit<\/button>/);
  const sub = await b.fetch('http://127.0.0.1:1/x.js', s.url + '/', { dest: 'script' });
  assert.equal(sub.headers['x-waddle-error'], 'connect');
  assert.equal(sub.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(sub.text, 'Could not connect: No exit that was tried could reach this address. The site may be down.');
  const head = await b.fetch('http://127.0.0.1:1/x.js', s.url + '/', { dest: 'script', method: 'HEAD' });
  assert.equal(head.headers['x-waddle-error'], 'connect');
  assert.equal(head.body.length, 0);

  // A site that is down is not the exit's fault: asking for it over and over costs the pool nothing.
  for (let i = 0; i < 6; i++) await b.fetch('http://127.0.0.1:1/' + i + '.png', s.url + '/', { dest: 'image' });
  assert.equal(app.pool.alive.size, 1);
  assert.equal((await b.page(s.url + '/')).status, 200);

  // With the exit looking names up, a name that does not exist looks like any other site it could not reach...
  const hostile = 'http://no-such-host.invalid/<script>alert(1)</script>?"><img/src=x/onerror=alert(2)>';
  const nx = await b.page(hostile);
  assert.equal(nx.headers['x-waddle-error'], 'connect');
  assert.ok(!nx.text.includes('<script>alert(1)') && !nx.text.includes('<img/src=x'), 'the address is escaped in the error page');
  assert.ok(!/<\/script>[^]*<\/script>[^]*<\/script>/.test(nx.text), 'and cannot close the script it is quoted in');

  for (const bad of [
    '/~/',
    '/~/notaurl::',
    '/~/javascript:alert(1)',
    '/~/file:///etc/passwd',
    '/~/ftp://x.test/',
    '/~/http://',
    '/~/http://user:pw@/',
  ]) {
    const r = await b.raw(bad);
    assert.equal(r.status, 400, bad);
    assert.match(r.text, /^Bad address/);
  }
  const t0 = Date.now();
  const slow = await b.page(s.url + '/slow');
  assert.equal(slow.headers['x-waddle-error'], 'timeout');
  assert.equal(slow.headers['x-waddle-status'], '504');
  assert.match(slow.text, /<h1>Timed out<\/h1><p>The proxies that were tried took too long\./);
  assert.ok(Date.now() - t0 < 6000, 'gave up after ' + (Date.now() - t0) + ' ms');
  const last = (await b.api('state')).json.pool.last;
  assert.equal(last.host, s.host);
  assert.equal(last.error, 'Timed out');
  assert.deepEqual(last.hops, []);
  assert.equal(app.pool.alive.size, 1, 'nor is a slow site held against the exit');
});

test('a name that does not exist is reported as such when the resolvers are asked (through the exit)', async () => {
  const d = await doh({ 'known.test': ['127.0.0.1'] });
  const s = await site({ '/': { body: PAGE } });
  const { b, px } = await start({ dns: { mode: 'stack', servers: [d.url], pad: false } });
  const nx = await b.page('http://no-such-host.test/');
  assert.equal(nx.headers['x-waddle-error'], 'dns');
  assert.equal(nx.headers['x-waddle-status'], '502');
  assert.match(nx.text, /<h1>Site not found<\/h1><p>There is no site at this address\.<\/p>/);
  assert.deepEqual(px.log, ['127.0.0.1:' + d.port], 'the question itself went through the exit, and nothing else did');
  // ...and a name that does exist reaches the exit as a number: the exit is told nothing it could look up.
  px.log.length = 0;
  const ok = await b.page('http://known.test:' + s.port + '/');
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes('Fixture'));
  assert.equal(s.last().headers.host, 'known.test:' + s.port, 'the site is still asked for by name');
  assert.ok(px.log.includes(s.host) && !px.log.some((l) => /known\.test/.test(l)), JSON.stringify(px.log));
});

test('statuses that a CDN or host in front of Waddle replaces with its own page are never sent as they are', async () => {
  const codes = [502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530];
  const routes = { '/api': { status: 503, headers: { 'Content-Type': 'application/json' }, body: '{"busy":true}' } };
  for (const c of codes)
    routes['/' + c] = {
      status: c,
      headers: { 'Content-Type': 'text/html', 'X-Site': 'yes' },
      body: '<html><head></head><body>site says ' + c + '</body></html>',
    };
  for (const c of [404, 500, 503])
    routes['/' + c] = { status: c, headers: { 'Content-Type': 'text/html' }, body: '<html><body>site says ' + c + '</body></html>' };
  const s = await site(routes);
  const { b } = await start();
  for (const c of codes) {
    const doc = await b.page(s.url + '/' + c);
    assert.equal(doc.status, 200, c + ' as a page');
    assert.equal(doc.headers['x-waddle-status'], String(c));
    assert.equal(doc.headers['x-waddle'], '1');
    assert.equal(doc.headers['x-waddle-error'], undefined, "it is the site's page, not one of Waddle's");
    assert.ok(
      doc.text.includes('site says ' + c) && doc.text.includes('/-/client.js'),
      "the site's own error page is shown, rewritten like any other"
    );
    assert.equal(doc.headers['x-site'], 'yes');
    const sub = await b.fetch(s.url + '/' + c, s.url + '/', { dest: 'image' });
    assert.equal(sub.status, 500, c + ' as a file: still a failure to the page that asked');
    assert.equal(sub.headers['x-waddle-status'], String(c));
  }
  // Every other status is the site's own business and passes as it is.
  for (const c of [404, 500, 503]) {
    const doc = await b.page(s.url + '/' + c);
    assert.equal(doc.status, c);
    assert.equal(doc.headers['x-waddle-status'], undefined);
  }
  const api = await b.fetch(s.url + '/api', s.url + '/');
  assert.equal(api.status, 503);
  assert.equal(api.text, '{"busy":true}');
  // Waddle's own failures follow the same rule, and say which kind they are.
  const dead = await b.page('http://127.0.0.1:1/');
  assert.deepEqual([dead.status, dead.headers['x-waddle-status'], dead.headers['x-waddle-error']], [200, '502', 'connect']);
  const file = await b.fetch('http://127.0.0.1:1/a.css', s.url + '/', { dest: 'style' });
  assert.deepEqual([file.status, file.headers['x-waddle-status'], file.headers['x-waddle-error']], [500, '502', 'connect']);
});

test('no proxy, no page: with nothing to route through, the site is never contacted', async () => {
  const s = await site({ '/': { body: PAGE }, '/pic.png': { headers: { 'Content-Type': 'image/png' }, body: 'PNG' } });
  const { b, app, px } = await start({}, { exit: false });
  const none = await b.page(s.url + '/');
  assert.equal(none.status, 200);
  assert.equal(none.headers['x-waddle-error'], 'noproxy');
  assert.equal(none.headers['x-waddle-status'], '502');
  assert.match(none.text, /<h1>No proxy lists<\/h1>/);
  assert.match(none.text, /<button data-act="proxies" hidden>Proxies<\/button>/);
  const sub = await b.fetch(s.url + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal(sub.status, 500);
  assert.equal(sub.headers['x-waddle-error'], 'noproxy');
  const post = await b.page(s.url + '/', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(post.headers['x-waddle-error'], 'noproxy');
  let last = (await b.api('state')).json.pool.last;
  assert.equal(last.error, 'No proxy lists');
  assert.deepEqual(last.hops, []);

  // Harvesting switched off and nothing added by hand
  app.config.patch({ pool: { on: false } });
  assert.match((await b.page(s.url + '/')).text, /<h1>No proxies<\/h1>/);
  app.config.patch({ pool: { on: true } });

  // A proxy that does not answer is no proxy: still searching, and the page says it will try again by itself.
  const silent = await httpProxy({ dead: true });
  app.pool.addManual('http://127.0.0.1:' + silent.port);
  const searching = await b.page(s.url + '/');
  assert.equal(searching.headers['x-waddle-error'], 'noproxy');
  assert.match(searching.text, /<h1>Finding a proxy<\/h1>/);
  assert.match(searching.text, /"retry":[46]/);

  assert.equal(s.hits.length, 0, 'in all of this the site was never contacted');

  // The moment one works, pages load.
  app.pool.addManual('http://127.0.0.1:' + px.port);
  await until(() => app.pool.alive.size === 1 && app.pool.summary().proxies[0].plain === true, 8000);
  const ok = await b.page(s.url + '/');
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes('Fixture'));
  last = (await b.api('state')).json.pool.last;
  assert.equal(last.status, 200);
  assert.equal(last.hops.length, 1);
  assert.equal(last.hops[0].addr, '127.0.0.1:' + px.port);

  // Filters that leave nothing are reported as such, not worked around.
  app.config.patch({ route: { countries: ['FR'] } });
  const filtered = await b.page(s.url + '/');
  assert.match(filtered.text, /<h1>No proxy matches<\/h1>/);
  app.config.patch({ route: { countries: [], protocols: ['socks5'] } });
  assert.match((await b.page(s.url + '/')).text, /<h1>No proxy matches<\/h1>/);
  assert.equal(s.hits.length, 1);
});

test('plain HTTP goes only through an exit that has proven it leaves such pages alone', async () => {
  const s = await site({ '/': { body: PAGE } });
  const k = await exits();
  // This exit is alive, but it cannot fetch the known page (it only connects to the judge): unproven.
  const blind = await httpProxy({ closed: [k.canary.port] });
  const { b, app } = await start({}, { exit: false });
  app.pool.addManual('http://127.0.0.1:' + blind.port);
  await until(() => app.pool.alive.size === 1, 8000);
  assert.equal(app.pool.summary().proxies[0].plain, false);
  const r = await b.page(s.url + '/');
  assert.equal(r.headers['x-waddle-error'], 'noproxy');
  assert.match(r.text, /<h1>No safe proxy for plain HTTP<\/h1>/);
  assert.equal(s.hits.length, 0);
  assert.ok(!blind.log.includes(s.host), 'the unproven exit was not even asked');

  // Nor is one that hands the known page back changed.
  const liar = await httpProxy({ tamper: true });
  app.pool.addManual('http://127.0.0.1:' + liar.port);
  await until(() => app.pool.alive.size === 2, 8000);
  assert.notEqual(app.pool.summary().proxies.find((x) => x.addr === liar.addr).plain, true);
  assert.equal((await b.page(s.url + '/')).headers['x-waddle-error'], 'noproxy');
  assert.equal(s.hits.length, 0);

  // With an honest exit in the pool, plain pages load, and through that one alone.
  app.config.patch({ route: { rotate: 'request' } });
  app.pool.addManual('http://127.0.0.1:' + k.px.port);
  await until(() => app.pool.summary().proxies.some((x) => x.addr === k.px.addr && x.plain === true), 8000);
  k.px.log.length = 0;
  for (let i = 0; i < 12; i++) assert.equal((await b.page(s.url + '/?' + i)).status, 200);
  assert.equal(s.hits.length, 12);
  assert.ok(k.px.log.includes(s.host));
  assert.ok(!liar.log.includes(s.host) && !blind.log.includes(s.host), 'the other two never carried an unencrypted page');
});

test('HTTPS only: plain addresses are asked for over HTTPS, and staying on HTTP takes a deliberate yes', async () => {
  const s = await site({ '/': { body: PAGE }, '/pic.png': { headers: { 'Content-Type': 'image/png' }, body: 'PNG' } });
  const { b, port } = await start({ route: { https: true } });
  const host = '127.0.0.1';
  const up = await b.page(s.url + '/a?b=1');
  assert.equal(up.status, 307);
  assert.equal(up.headers.location, '/~/https://' + s.host + '/a?b=1');
  assert.equal(up.headers['x-waddle-upgrade'], 'https');
  const sub = await b.fetch(s.url + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal(sub.status, 307, 'files too');
  assert.equal(sub.headers.location, '/~/https://' + s.host + '/pic.png');
  const frame = await b.raw('/~/f/' + s.url + '/', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' },
  });
  assert.equal(frame.headers.location, '/~/f/https://' + s.host + '/', 'a frame stays a frame');
  assert.equal(s.hits.length, 0, 'nothing was sent without encryption');

  // The site has no HTTPS (the stand-in speaks plain HTTP): the error says so and offers the way on.
  const tls = await b.page('https://' + s.host + '/');
  assert.equal(tls.headers['x-waddle-error'], 'nohttps');
  assert.match(tls.text, /<h1>No secure connection<\/h1><p>This site did not answer over HTTPS\.<\/p>/);
  assert.match(tls.text, /<button data-act="plain" hidden>Continue without HTTPS<\/button>/);
  s.hits.length = 0;

  // A site that keeps sending visitors back to plain HTTP is not followed round in circles.
  let loop;
  for (let i = 0; i < 4; i++) loop = await b.page('http://localhost:' + s.port + '/loop');
  assert.equal(loop.headers['x-waddle-error'], 'nohttps');
  assert.match(loop.text, /This site only works without HTTPS\./);

  // "Continue without HTTPS": this host, this session.
  assert.equal((await b.api('plain', { host: 'not a host!' })).status, 400);
  const st = (await b.api('plain', { host })).json;
  assert.deepEqual(st.plain, [host]);
  const ok = await b.page(s.url + '/');
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes('Fixture'));
  const pic = (who, at) => who.fetch(at + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal((await pic(b, s.url)).status, 200);
  assert.equal((await pic(b, 'http://localhost:' + s.port)).status, 307, 'other hosts are still upgraded');
  assert.equal((await pic(browser(port), s.url)).status, 307, 'and so is everybody else');
  assert.deepEqual((await b.api('plain', { host, on: false })).json.plain, []);
  assert.equal((await pic(b, s.url)).status, 307, 'the yes can be taken back');
});

test('private and local addresses are off limits, whatever the proxies would do with them', async () => {
  // A fresh server with default safety (the suite itself runs with the override that lets it use 127.0.0.1).
  const script = `
    const { createApp } = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const http = require('http');
    const get = (port, p, headers) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
        let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    (async () => {
      const inner = http.createServer((q, s) => s.end('internal')).listen(0, '127.0.0.1');
      await new Promise((r) => inner.once('listening', r));
      const app = createApp();
      app.config.reset();
      app.config.patch({ pool: { sources: [], discover: false, canaries: [], echo: '' }, dns: { auto: false }, route: { https: false } });
      const { port } = await app.listen(0, '127.0.0.1');
      const out = {};
      const doc = { Accept: 'text/html', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' };
      for (const host of ['127.0.0.1:' + inner.address().port, 'localhost:' + inner.address().port, '192.168.1.1', '10.0.0.1', '169.254.169.254', '[::1]', 'router.local', '0x7f.1', '2130706433']) {
        for (const scheme of ['http', 'https']) {
          const r = await get(port, '/~/' + scheme + '://' + host + '/', doc);
          out[scheme + '://' + host] = [r.status, r.headers['x-waddle-error'], r.headers['x-waddle-status'], /<h1>Blocked<\\/h1>/.test(r.body)].join(' ');
        }
      }
      const file = await get(port, '/~/http://192.168.1.1/x.png', { 'Sec-Fetch-Dest': 'image' });
      out.file = [file.status, file.headers['x-waddle-error'], file.body].join(' ');
      console.log(JSON.stringify(out));
      await app.close();
      inner.close();
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });`;
  const env = Object.assign({}, process.env, { WADDLE_DATA: path.join(process.env.WADDLE_DATA, 'private') });
  delete env.WADDLE_ALLOW_PRIVATE;
  const stdout = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000 }, (e, so, se) =>
      e ? reject(new Error(se || e.message)) : resolve(so)
    )
  );
  const out = JSON.parse(stdout);
  assert.equal(Object.keys(out).length, 19);
  for (const [what, got] of Object.entries(out)) {
    if (what === 'file') assert.equal(got, '403 private Blocked: Private and local addresses are off limits.');
    else assert.equal(got, '200 private 403 true', what);
  }
});

test('routing rules: block a site, or pin its country and chain length', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, app } = await start({ route: { rules: ['localhost block'] } });
  const blocked = await b.page('http://localhost:' + s.port + '/');
  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers['x-waddle-status'], '403');
  assert.equal(blocked.headers['x-waddle-error'], 'rule');
  assert.match(blocked.text, /<h1>Blocked<\/h1><p>A routing rule blocks this site\.<\/p>/);
  assert.equal(s.hits.length, 0, 'a blocked site is never contacted');
  const sub = await b.fetch('http://localhost:' + s.port + '/ad.js', s.url + '/', { dest: 'script' });
  assert.equal(sub.status, 403);
  assert.match(sub.text, /^Blocked/);
  assert.equal((await b.page(s.url + '/')).status, 200, 'other sites are unaffected');
  // There is no rule that sends a site around the proxies: one that tries is not a rule.
  const st = (await b.api('config', { route: { rules: ['localhost direct', '127.0.0.1 direct', '* direct', 'localhost block'] } })).json;
  assert.deepEqual(st.config.route.rules, ['localhost block']);
  app.config.patch({ route: { rules: ['127.0.0.1 proxy FR'] } });
  const none = await b.page(s.url + '/');
  assert.equal(none.headers['x-waddle-error'], 'noproxy');
  assert.match(none.text, /<h1>No proxy matches<\/h1>/);
  assert.equal(s.hits.length, 1, 'a rule nothing can satisfy stops the page; it is not quietly ignored');
  app.config.patch({ route: { rules: ['127.0.0.1 proxy US'] } });
  assert.equal((await b.page(s.url + '/')).status, 200);
  assert.equal((await b.api('state')).json.pool.last.rule, '127.0.0.1');
  app.config.patch({ route: { rules: [] } });
  assert.equal((await b.page('http://localhost:' + s.port + '/')).status, 200);
});

// ---- the app around the proxy ------------------------------------------------------------

test('shell and static files', async () => {
  const { port } = await start();
  const shell = await get(port, '/');
  assert.equal(shell.status, 200);
  assert.equal(shell.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(!shell.text.includes('{{v}}'), 'the cache tag is filled in');
  assert.match(shell.text, /\/-\/app\.js\?v=[\w-]+/);
  assert.equal(shell.headers['x-content-type-options'], 'nosniff');
  assert.match(String(shell.headers['set-cookie']), /^waddle=.*HttpOnly/);
  for (const [p, type] of [
    ['/-/app.js', 'text/javascript; charset=utf-8'],
    ['/-/client.js', 'text/javascript; charset=utf-8'],
    ['/-/app.css', 'text/css; charset=utf-8'],
    ['/-/icon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/svg+xml'],
  ]) {
    const r = await get(port, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.ok(r.body.length > 300, p);
    const again = await get(port, p, { headers: { 'If-None-Match': r.headers.etag } });
    assert.equal(again.status, 304, p + ' revalidates');
  }
  const sw = await get(port, '/-/sw.js');
  assert.equal(sw.headers['service-worker-allowed'], '/');
  assert.equal((await get(port, '/-/ping')).status, 204);
  const robots = await get(port, '/robots.txt');
  assert.equal(robots.text, 'User-agent: *\nDisallow: /\n');
  for (const p of [
    '/-/nope',
    '/-/../server.js',
    '/-/%2e%2e/server.js',
    '/-/..%2fserver.js',
    '/-/..%5cserver.js',
    '/-/app.js/../../package.json',
    '/sitemap.xml',
    '/nothing-here',
  ]) {
    const r = await get(port, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('createApp') && !r.text.includes('"name"'), p);
  }
  assert.equal((await get(port, '/-/app.js', { method: 'POST', body: 'x' })).status, 405);
});

test('address bar input: addresses, bare hosts, searches, and the /host/path shortcut', async () => {
  const { port } = await start();
  const go = async (q) => (await get(port, '/-/go?q=' + encodeURIComponent(q))).headers.location;
  assert.equal(await go('https://x.test/p?q=1#frag'), '/#https://x.test/p?q=1#frag');
  assert.equal(await go('example.com'), '/#https://example.com/');
  assert.equal(await go('example.com/a?b=c'), '/#https://example.com/a?b=c');
  assert.equal(await go('localhost:3000/x'), '/#https://localhost:3000/x');
  assert.equal(await go('93.184.216.34'), '/#https://93.184.216.34/');
  assert.equal(await go('how to waddle'), '/#https://duckduckgo.com/html/?q=how%20to%20waddle');
  assert.equal(await go('what is node.js'), '/#https://duckduckgo.com/html/?q=what%20is%20node.js');
  assert.equal(
    await go('javascript:alert(1)'),
    '/#https://duckduckgo.com/html/?q=javascript%3Aalert(1)',
    'anything that is not a web address is searched for'
  );
  assert.equal((await get(port, '/-/go')).headers.location, '/');
  assert.equal((await get(port, '/example.com/path?x=1')).headers.location, '/#https://example.com/path?x=1');
  assert.equal((await get(port, '/https://example.com/path')).headers.location, '/#https://example.com/path');
});

test('requests that escape rewriting are caught by their Referer and sent back into the proxy', async () => {
  const { port, origin } = await start();
  const from = { Referer: origin + '/~/https://site.test/dir/page?x=1' };
  const stray = await get(port, '/assets/app.js?v=2', { headers: from });
  assert.equal(stray.status, 307);
  assert.equal(stray.headers.location, '/~/https://site.test/assets/app.js?v=2');
  assert.equal((await get(port, '/api/save', { method: 'POST', body: '{}', headers: from })).status, 307, '307 keeps the method and body');
  assert.equal(
    (await get(port, '/assets/app.js', { headers: { Referer: origin + '/somewhere/else' } })).status,
    404,
    'a Referer that is not a proxied page proves nothing'
  );
  assert.equal((await get(port, '/assets/app.js')).status, 404);
  assert.equal((await get(port, '/-/app.js', { headers: from })).status, 200, "Waddle's own files are never mistaken for strays");
});

test('inspector API is session-local, redacts HttpOnly cookie values and reports the proxy route', async () => {
  const s = await site({
    '/': {
      headers: {
        'Content-Type': 'text/html',
        'Set-Cookie': ['sid=secret; Path=/; HttpOnly', 'theme=light; Path=/'],
        'X-Example': 'kept only in the upstream response',
      },
      body: '<!doctype html><title>Inspector fixture</title><p>hello</p>',
    },
    '/pixel.png': { headers: { 'Content-Type': 'image/png' }, body: 'pixel' },
  });
  const { b } = await start();
  await b.page(s.url + '/');
  await b.fetch(s.url + '/pixel.png', s.url + '/');
  const inspected = await b.api('inspect?url=' + encodeURIComponent(s.url + '/'));
  assert.equal(inspected.headers['x-waddle'], '1');
  assert.ok(inspected.json.requests.length >= 2);
  const document = inspected.json.requests.find((x) => x.url === s.url + '/');
  assert.ok(document);
  assert.equal(document.status, 200);
  assert.equal(document.waddleStatus, 200);
  assert.equal(document.route[0].cc, 'US');
  assert.equal(document.headers['content-type'], 'text/html');
  assert.equal(document.headers['set-cookie'], '[values kept in Waddle’s cookie jar]');
  assert.ok(document.bytes > 0);
  assert.ok(document.ms >= 0);
  assert.deepEqual(
    inspected.json.cookies.map((x) => [x.name, x.httpOnly, x.value]),
    [
      ['sid', true, ''],
      ['theme', false, 'light'],
    ]
  );
  assert.equal((await b.raw('/-/api/inspect', { headers: {} })).status, 403);
  const other = await start({}, { exit: false });
  assert.deepEqual((await other.b.api('inspect')).json.requests, [], 'another browser session sees no request history');
  await b.api('identity', {});
  assert.deepEqual((await b.api('inspect')).json.requests, [], 'a new identity clears server-side inspector data');
});

test('settings API: guarded, validated, and everything it changes takes effect', async () => {
  const s = await site({ '/': { body: PAGE } });
  const d = await doh({ 'looked-up.test': ['10.9.8.7'] });
  const { b, port, app, px } = await start({ dns: { servers: [d.url], pad: false } });
  // guard
  assert.equal((await get(port, '/-/api/state')).status, 403, 'needs the custom header (which a cross-site form or image cannot send)');
  assert.equal(
    (
      await get(port, '/-/api/config', {
        method: 'POST',
        body: '{"route":{"hops":3}}',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
    403
  );
  assert.equal(app.config.value.route.hops, 1);
  assert.equal(
    (
      await get(port, '/-/api/config', {
        method: 'POST',
        body: 'route=x',
        headers: { 'X-Waddle': '1', 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    ).status,
    415
  );
  assert.equal(
    (
      await get(port, '/-/api/config', {
        method: 'POST',
        body: '{broken',
        headers: { 'X-Waddle': '1', 'Content-Type': 'application/json' },
      })
    ).status,
    400
  );
  assert.equal(
    (await get(port, '/-/api/nope', { method: 'POST', body: '{}', headers: { 'X-Waddle': '1', 'Content-Type': 'application/json' } }))
      .status,
    404
  );
  assert.equal((await get(port, '/-/api/state', { method: 'DELETE', headers: { 'X-Waddle': '1' } })).status, 405);
  const huge = await get(port, '/-/api/config', {
    method: 'POST',
    body: JSON.stringify({ route: { rules: ['x'.repeat(1500000)] } }),
    headers: { 'X-Waddle': '1', 'Content-Type': 'application/json' },
  });
  assert.equal(huge.status, 413, 'an oversized settings body is refused with an answer, not a dropped connection');
  assert.equal((await b.api('pool', { action: 'explode' })).status, 400);
  assert.equal((await b.api('dns', { action: 'test', host: 'not a host!' })).status, 400);
  assert.equal((await b.api('dns', { action: 'explode' })).status, 400);
  assert.equal((await b.api('pool', { action: 'source', text: 'not a source' })).status, 400);

  // state
  const first = await b.api('state');
  assert.equal(first.headers['x-waddle'], '1');
  assert.equal(first.headers['cache-control'], 'no-store');
  const st = first.json;
  assert.deepEqual(Object.keys(st), ['config', 'options', 'pool', 'dns', 'cookies', 'blocked', 'trackers', 'identity', 'plain', 'uptime']);
  assert.equal(st.config.route.mode, undefined, 'there is no "direct" to choose');
  assert.ok(
    st.options.systems.length >= 12 && st.options.screens.length >= 10 && st.options.dns.length >= 8 && st.options.countries.length >= 100
  );
  assert.equal(st.options.maxHops, 16);
  assert.equal(st.pool.health, 'ok');
  assert.deepEqual([st.pool.alive, st.pool.usable, st.pool.plain], [1, 1, 1]);
  assert.deepEqual(st.pool.countries, { US: 1 });
  assert.equal(st.pool.last, null, 'nothing has been opened in this session yet');
  assert.ok(st.trackers > 100);
  assert.equal(st.blocked, 0);
  assert.deepEqual(st.plain, []);
  assert.equal(st.identity.id, 'win-chrome');

  // config
  const patched = (
    await b.api('config', { route: { mode: 'direct', hops: 2, rules: ['ads.test block', 'nonsense'] }, spoof: { theme: 'dark' }, nope: 1 })
  ).json;
  assert.equal(patched.config.route.mode, undefined);
  assert.equal(patched.config.nope, undefined);
  assert.equal(patched.config.route.hops, 2);
  assert.deepEqual(patched.config.route.rules, ['ads.test block']);
  assert.equal(app.config.value.spoof.theme, 'dark');
  app.config.patch({ route: { hops: 1 } });
  const page = await b.page(s.url + '/');
  assert.equal(bootOf(page.text).page.theme, 'dark', 'the next page load carries the new identity');
  const reset = (await b.api('config', { reset: true })).json;
  const k = await exits(); // back to the rig's settings at once: the defaults name real hosts
  app.config.patch({
    dns: { auto: false, fallback: false, servers: [d.url], pad: false },
    route: { https: false },
    pool: { sources: [], discover: false, canaries: [k.canary.line], judge: k.judge.url + '/trace', echo: '' },
  });
  assert.equal(reset.config.route.hops, 1);
  assert.equal(reset.config.route.https, true);
  assert.equal(reset.config.spoof.theme, 'real');
  assert.equal(reset.config.privacy.cookies, 'first');

  // sources (the lists themselves are never downloaded here: their hosts do not exist for this rig's resolver)
  let r = (await b.api('pool', { action: 'source', text: 'https://github.com/owner/some-list' })).json;
  assert.deepEqual(r.config.pool.sources, [{ type: 'github', repo: 'owner/some-list', on: true }]);
  r = (await b.api('pool', { action: 'source', text: 'gitlab:group/list' })).json;
  r = (await b.api('pool', { action: 'source', text: 'lists.test/socks.txt', proto: 'socks5' })).json;
  assert.deepEqual(
    r.config.pool.sources.map((x) => x.type),
    ['github', 'gitlab', 'url']
  );
  assert.equal(r.config.pool.sources[2].proto, 'socks5');
  r = (await b.api('pool', { action: 'source', text: 'owner/some-list' })).json;
  assert.equal(r.config.pool.sources.length, 3, 'no duplicates');
  r = (await b.api('pool', { action: 'toggle', id: 'gitlab:group/list', on: false })).json;
  assert.equal(r.config.pool.sources[1].on, false);
  assert.equal(r.pool.sources.find((x) => x.id === 'gitlab:group/list').state, 'off');
  r = (await b.api('pool', { action: 'unsource', id: 'github:owner/some-list' })).json;
  assert.deepEqual(
    r.config.pool.sources.map((x) => x.type),
    ['gitlab', 'url']
  );
  app.config.patch({ pool: { sources: [] } });

  // dns: the test question travels through the exit, like the lookups it stands for
  px.log.length = 0;
  r = (await b.api('dns', { action: 'test', host: 'https://Looked-Up.test/some/page' })).json;
  assert.equal(r.host, 'looked-up.test');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].address, '10.9.8.7');
  assert.ok(r.results[0].ms >= 0);
  assert.equal(r.via.length, 1);
  assert.equal(r.via[0].addr, px.addr);
  assert.ok(px.log.includes('127.0.0.1:' + d.port), 'asked through the exit');
  assert.deepEqual(
    d.log.filter((q) => q.name === 'looked-up.test'),
    [{ name: 'looked-up.test', type: 1 }]
  );
  assert.equal((await b.api('dns', { action: 'flush' })).status, 200);
  assert.equal((await b.api('dns', { action: 'refresh' })).status, 200);
});

test('versioned backups export and replace server configuration safely', async () => {
  const { b, app, port } = await start({ spoof: { theme: 'dark' } }, { exit: false });
  assert.equal((await get(port, '/-/api/backup')).status, 403, 'backup export requires the same Waddle API header');
  const exported = await b.api('backup');
  assert.equal(exported.status, 200);
  assert.deepEqual([exported.json.format, exported.json.version], ['waddle-backup', 1]);
  assert.equal(exported.json.config.spoof.theme, 'dark');

  const invalid = await b.api('backup', { format: 'other', version: 1, config: { ui: { theme: 'light' } } });
  assert.equal(invalid.status, 400);
  assert.equal(app.config.value.spoof.theme, 'dark', 'reject an unsupported backup without changing settings');

  const config = {
    route: { hops: 16, rules: ['deep.example proxy hops=16'] },
    dns: { strategy: 'check', parallel: 12, servers: ['cloudflare', 'quad9', 'google'] },
    ui: { theme: 'light' },
  };
  const restored = await b.api('backup', { format: 'waddle-backup', version: 1, config });
  assert.equal(restored.status, 200);
  assert.equal(app.config.value.route.hops, 16);
  assert.equal(app.config.value.route.rules[0], 'deep.example proxy hops=16');
  assert.equal(app.config.value.dns.parallel, 12);
  assert.equal(app.config.value.spoof.theme, 'real', 'replacement restores defaults for omitted settings');
  assert.equal(restored.json.config.ui.theme, 'light');
});

test('tour and installer stay downloadable when the browser app uses a password', async () => {
  const oldPassword = process.env.WADDLE_PASSWORD;
  const oldUser = process.env.WADDLE_USER;
  process.env.WADDLE_PASSWORD = 'test-only-secret';
  process.env.WADDLE_USER = 'tour-test';
  let s;
  try {
    s = await start({ pool: { sources: [], discover: false, on: false } }, { exit: false });
  } finally {
    if (oldPassword == null) delete process.env.WADDLE_PASSWORD;
    else process.env.WADDLE_PASSWORD = oldPassword;
    if (oldUser == null) delete process.env.WADDLE_USER;
    else process.env.WADDLE_USER = oldUser;
  }
  const root = await get(s.port, '/');
  assert.equal(root.status, 401, 'the proxy shell remains behind its password');
  const tour = await get(s.port, '/tour');
  assert.equal(tour.status, 200);
  assert.match(tour.text, /Take the scenic route/);
  assert.match(tour.text, /github\.com\/wuzzynizzy\/Waddle/);
  for (const path of ['/install.sh', '/install.ps1']) {
    const script = await get(s.port, path);
    assert.equal(script.status, 200, path);
    assert.match(script.headers['content-disposition'], /attachment/);
    assert.match(script.text, /Node.js 20|node 20|node --version|Node 20/i);
  }
  for (const asset of ['/-/tour.css?v=test', '/-/tour.js?v=test', '/-/fonts/geist.woff2', '/-/icon.svg'])
    assert.equal((await get(s.port, asset)).status, 200, asset);
  const auth = 'Basic ' + Buffer.from('tour-test:test-only-secret').toString('base64');
  assert.equal((await get(s.port, '/', { headers: { Authorization: auth } })).status, 200);
});

test('a page cannot use its own requests to reach the settings API', async () => {
  // From inside a proxied page every URL is rewritten, so "/-/api/config" means the SITE's path.
  const s = await site({
    '*': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('site saw ' + req.url);
    },
  });
  const { b, app } = await start();
  const r = await b.fetch(s.url + '/-/api/config', s.url + '/', {
    method: 'POST',
    body: '{"route":{"hops":4}}',
    headers: { 'Content-Type': 'application/json', 'X-Waddle': '1' },
  });
  assert.equal(r.text, 'site saw /-/api/config');
  assert.equal(app.config.value.route.hops, 1);
  assert.equal(s.last().headers['x-waddle'], undefined);
  // Nor can the site set Waddle's own marks on its answers: the shell would take its page for one of Waddle's.
  const forged = await site({
    '/': (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'X-Waddle-Error': 'noproxy',
        'X-Waddle-Status': '502',
        'X-Waddle-Cookie': 'a%3D1',
        'X-Waddle-Upgrade': 'https',
      });
      res.end('<html><head></head><body>hello</body></html>');
    },
  });
  const f = await b.page(forged.url + '/');
  for (const h of ['x-waddle-error', 'x-waddle-status', 'x-waddle-cookie', 'x-waddle-upgrade']) assert.equal(f.headers[h], undefined, h);
  assert.equal(f.headers['x-waddle'], '1');
});

test('other websites cannot use your session: only a plain top-level visit is served to them', async () => {
  const s = await site({
    '/': { body: PAGE },
    '/pic.png': { headers: { 'Content-Type': 'image/png' }, body: 'PNG' },
    '/transfer': { headers: { 'Content-Type': 'text/plain' }, body: 'done' },
  });
  const { b, port, origin } = await start();
  await b.page(s.url + '/');
  const as = (site, mode, dest, extra) =>
    Object.assign({ Cookie: b.cookie, 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': mode, 'Sec-Fetch-Dest': dest }, extra);
  const P = '/~/' + s.url;
  // Waddle's own pages
  assert.equal((await get(port, P + '/pic.png', { headers: as('same-origin', 'no-cors', 'image') })).status, 200);
  assert.equal((await get(port, P + '/', { headers: as('same-origin', 'navigate', 'iframe') })).status, 200);
  assert.equal((await get(port, P + '/', { headers: as('none', 'navigate', 'document') })).status, 200, 'typed or bookmarked');
  // a link on another website
  assert.equal((await get(port, P + '/', { headers: as('cross-site', 'navigate', 'document') })).status, 200);
  // everything else another website could try
  const hits = s.hits.length;
  for (const [what, r] of Object.entries({
    'hotlinked image': get(port, P + '/pic.png', { headers: as('cross-site', 'no-cors', 'image') }),
    'scripted fetch': get(port, P + '/transfer', { headers: as('cross-site', 'cors', 'empty') }),
    'framing a proxied page (clickjacking)': get(port, P + '/', { headers: as('cross-site', 'navigate', 'iframe') }),
    'auto-submitted form': get(port, P + '/transfer', {
      method: 'POST',
      body: 'to=evil',
      headers: as('cross-site', 'navigate', 'document', { 'Content-Type': 'application/x-www-form-urlencoded' }),
    }),
    'a sibling subdomain': get(port, P + '/pic.png', { headers: as('same-site', 'no-cors', 'image') }),
    'reading cookies': get(port, '/-/cookie', { headers: as('cross-site', 'cors', 'empty', { Referer: origin + P + '/' }) }),
    'planting a cookie': get(port, '/-/cookie', {
      method: 'POST',
      body: 'sid=evil',
      headers: as('cross-site', 'no-cors', 'empty', { Referer: origin + P + '/', 'Content-Type': 'text/plain' }),
    }),
    'the settings API': get(port, '/-/api/state', { headers: as('cross-site', 'cors', 'empty', { 'X-Waddle': '1' }) }),
    'a stray path': get(port, '/pic.png', { headers: as('cross-site', 'no-cors', 'image', { Referer: origin + P + '/' }) }),
  })) {
    const res = await r;
    assert.ok(res.status === 403 || res.status === 404, what + ' -> ' + res.status);
  }
  assert.equal(s.hits.length, hits, 'none of it reached the site');
  // the shell itself may be embedded (a hosted preview pane does exactly that)
  assert.equal((await get(port, '/', { headers: as('cross-site', 'navigate', 'iframe') })).status, 200);
  assert.equal((await get(port, '/-/app.js', { headers: as('cross-site', 'no-cors', 'script') })).status, 200);
});

test('password protection: everything is behind it, and it never leaks to sites', async () => {
  const s = await site({
    '/echo': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    },
  });
  process.env.WADDLE_PASSWORD = 'hunter2';
  let ctx;
  try {
    ctx = await start();
  } finally {
    delete process.env.WADDLE_PASSWORD;
  }
  const { port } = ctx;
  const good = 'Basic ' + Buffer.from('waddle:hunter2').toString('base64');
  for (const p of ['/', '/-/app.js', '/-/api/state', '/~/' + s.url + '/echo', '/-/go?q=x']) {
    const r = await get(port, p, { headers: { 'X-Waddle': '1' } });
    assert.equal(r.status, 401, p);
    assert.match(r.headers['www-authenticate'], /^Basic /);
  }
  assert.equal(
    (await get(port, '/', { headers: { Authorization: 'Basic ' + Buffer.from('waddle:wrong').toString('base64') } })).status,
    401
  );
  assert.equal((await get(port, '/', { headers: { Authorization: good } })).status, 200);
  const echoed = JSON.parse((await get(port, '/~/' + s.url + '/echo', { headers: { Authorization: good } })).text);
  assert.equal(echoed.authorization, undefined, 'the Waddle password is not forwarded to the sites you visit');
  assert.equal((await get(port, '/-/ping')).status, 204, 'health checks stay open');
});

// ---- WebSocket ---------------------------------------------------------------------------

/** Minimal WebSocket client: resolves with { status, send(text) -> reply, close() }. */
function ws(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: Object.assign(
        {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        },
        headers
      ),
    });
    req.on('upgrade', (res, socket) => {
      const send = (text) =>
        new Promise((done) => {
          const data = Buffer.from(text),
            mask = crypto.randomBytes(4);
          const out = Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, Buffer.from(data.map((x, i) => x ^ mask[i % 4]))]);
          socket.once('data', (d) => done(d.subarray(2).toString()));
          socket.write(out);
        });
      resolve({ status: res.statusCode, headers: res.headers, send, close: () => socket.destroy() });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });
}

test("WebSockets are relayed, with the real origin, the spoofed identity and the site's cookies", async () => {
  const s = await site({
    '/login': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=ws1; Path=/; HttpOnly' });
      res.end('<html></html>');
    },
  });
  const { b, port, origin } = await start();
  await b.page(s.url + '/login');
  const path = '/-/ws?u=' + encodeURIComponent('ws://' + s.host + '/socket?room=1') + '&o=' + encodeURIComponent(s.url);
  const sock = await ws(port, path, {
    Cookie: b.cookie,
    Origin: origin,
    'User-Agent': 'RealBrowser/1.0',
    'Sec-WebSocket-Protocol': 'chat',
  });
  assert.equal(sock.status, 101);
  assert.equal(await sock.send('hello'), 'echo:hello');
  assert.equal(await sock.send('again'), 'echo:again');
  sock.close();
  const seen = s.last();
  assert.equal(seen.method, 'WS');
  assert.equal(seen.url, '/socket?room=1');
  assert.equal(seen.headers.origin, s.url, 'the site sees its own origin');
  assert.equal(seen.headers.cookie, 'sid=ws1', 'including HttpOnly cookies, as a browser would send');
  assert.match(seen.headers['user-agent'], /Chrome\/\d+/);
  assert.equal(seen.headers['sec-websocket-protocol'], 'chat');
  assert.ok(!/waddle=/.test(seen.headers.cookie));

  for (const bad of [
    '/-/ws',
    '/-/ws?u=' + encodeURIComponent('http://' + s.host + '/'),
    '/-/ws?u=' + encodeURIComponent('ws://127.0.0.1:1/'),
    '/nothing',
  ]) {
    const r = await ws(port, bad, { Cookie: b.cookie, Origin: origin }).catch(() => ({ status: 'reset' }));
    assert.notEqual(r.status, 101, bad);
  }
  // Browsers do not stop other websites from opening sockets here, so the server has to.
  const foreign = await ws(port, path, { Cookie: b.cookie, Origin: 'https://evil.test' }).catch(() => ({ status: 'reset' }));
  assert.equal(foreign.status, 403, 'an old browser on another website: Origin gives it away');
  const modern = await ws(port, path, {
    Cookie: b.cookie,
    Origin: 'https://evil.test',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'websocket',
    'Sec-Fetch-Dest': 'websocket',
  }).catch(() => ({ status: 'reset' }));
  assert.equal(modern.status, 403, 'a current browser says so itself');
  const own = await ws(port, path, {
    Cookie: b.cookie,
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'websocket',
    'Sec-Fetch-Dest': 'websocket',
  });
  assert.equal(own.status, 101);
  own.close();
  const behindProxy = await ws(port, path, { Cookie: b.cookie, Origin: 'https://waddle.example', 'X-Forwarded-Host': 'waddle.example' });
  assert.equal(behindProxy.status, 101, 'behind a reverse proxy the public name arrives as X-Forwarded-Host');
  behindProxy.close();
  const tool = await ws(port, path, {});
  assert.equal(tool.status, 101, 'a non-browser client has no Origin and no borrowed session');
  tool.close();
});

// ---- privacy --------------------------------------------------------------------------

/** A document that the page at `from` embeds (an iframe): its address carries the frame mark. */
const frameOf = (b, origin, url, from) =>
  b.raw('/~/f/' + url, {
    headers: { Accept: 'text/html,*/*', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', Referer: origin + '/~/' + from },
  });

test('trackers and ad hosts are refused before anything leaves, and counted', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, app, port, origin, px } = await start();
  const from = s.url + '/';
  await b.page(from);
  px.log.length = 0;
  const outside = () => px.log.filter((l) => !l.startsWith('127.0.0.1:')); // (the pool's own test page is on this machine)

  const r = await b.fetch('https://www.google-analytics.com/analytics.js', from, { dest: 'script' });
  assert.equal(r.status, 403);
  assert.equal(r.headers['x-waddle-blocked'], 'tracker');
  assert.equal(r.headers['x-waddle'], '1');
  assert.equal(r.body.length, 0, 'to the page it is a request that failed, as with any blocker');
  for (const u of [
    'https://stats.g.doubleclick.net/collect?v=1',
    'http://connect.facebook.net/en_US/fbevents.js',
    'https://www.facebook.com/tr?id=1&ev=PageView',
  ]) {
    assert.equal((await b.fetch(u, from, { dest: 'image' })).headers['x-waddle-blocked'], 'tracker', u);
  }
  assert.deepEqual(outside(), [], 'no exit was asked for any of them');
  // Only the tracking address of a site that is also a place people visit.
  const fb = await b.fetch('https://www.facebook.com/somebody', from);
  assert.equal(fb.headers['x-waddle-blocked'], undefined);
  assert.deepEqual(outside(), ['www.facebook.com:443']);

  // Opened as a page, a tracker gets an explanation instead of an empty answer.
  const doc = await b.page('https://doubleclick.net/');
  assert.deepEqual([doc.status, doc.headers['x-waddle-status'], doc.headers['x-waddle-error']], [200, '403', 'tracker']);
  assert.match(doc.text, /<h1>Blocked<\/h1>/);
  assert.ok(doc.text.includes('Tracker blocking is on'));
  // Sockets too.
  const sock = await ws(port, '/-/ws?u=' + encodeURIComponent('wss://analytics.tiktok.com/live') + '&o=' + encodeURIComponent(s.url), {
    Cookie: b.cookie,
    Origin: origin,
  }).catch(() => ({ status: 'reset' }));
  assert.equal(sock.status, 403);

  assert.equal((await b.api('state')).json.blocked, 6, 'counted for this visitor');
  assert.equal((await browser(port).api('state')).json.blocked, 0, 'and for nobody else');
  assert.ok((await b.api('state')).json.trackers > 150);

  // Off: the request goes out like any other.
  app.config.patch({ privacy: { trackers: false } });
  px.log.length = 0;
  const off = await b.fetch('https://www.google-analytics.com/analytics.js', from, { dest: 'script' });
  assert.equal(off.headers['x-waddle-blocked'], undefined);
  assert.deepEqual(outside(), ['www.google-analytics.com:443']);
});

test('cookie policy: by default only the site in the address bar keeps cookies', async () => {
  const seen = [];
  const s = await site({
    '*': (req, res, body, url) => {
      const host = req.headers.host.split(':')[0];
      const json = url.pathname.endsWith('.json');
      seen.push({ host, path: url.pathname, cookie: req.headers.cookie || '' });
      res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/html', 'Set-Cookie': 'id=' + host + '; Path=/' });
      res.end(json ? '{}' : '<html><head></head><body></body></html>');
    },
  });
  const { b, app, origin } = await start();
  // One server under two names: two sites, as far as cookies go.
  const A = 'http://127.0.0.1:' + s.port;
  const B = 'http://localhost:' + s.port;
  const last = () => seen[seen.length - 1].cookie;
  const scriptSees = async (doc) => (await b.raw('/-/cookie', { headers: { Referer: origin + '/~/' + doc } })).text;
  const scriptSets = (doc, line) =>
    b.raw('/-/cookie', { method: 'POST', body: line, headers: { 'Content-Type': 'text/plain', Referer: origin + '/~/' + doc } });

  // -- first party only (the default)
  let r = await b.page(A + '/');
  assert.equal(bootOf(r.text).jar, true);
  r = await b.fetch(B + '/pixel.json', A + '/');
  assert.equal(last(), '');
  assert.equal(r.headers['x-waddle-cookie'], undefined);
  await b.fetch(B + '/pixel.json', A + '/');
  assert.equal(last(), '', 'the cookie the third party tried to set was not kept');
  r = await b.fetch(A + '/api.json', A + '/');
  assert.equal(last(), 'id=127.0.0.1', "the page's own site gets its cookies");
  assert.equal(decodeURIComponent(r.headers['x-waddle-cookie']), 'id=127.0.0.1');

  // The other site inside a frame on the page: a guest. No cookies in, none out, none for its scripts.
  r = await frameOf(b, origin, B + '/widget', A + '/');
  assert.equal(last(), '');
  let boot = bootOf(r.text);
  assert.deepEqual([boot.jar, boot.cookie, boot.part], [false, '', '127.0.0.1']);
  assert.equal(await scriptSees('f/' + B + '/widget'), '');
  await scriptSets('f/' + B + '/widget', 'js=1; Path=/');
  await b.fetch(B + '/data.json', 'f/' + B + '/widget');
  assert.equal(last(), '', 'what the frame loads from its own site is third-party too');
  // A page the frame moves on to stays a guest.
  r = await b.raw('/~/' + B + '/widget2', {
    headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', Referer: origin + '/~/f/' + B + '/widget' },
  });
  assert.equal(last(), '');
  assert.equal(bootOf(r.text).part, '127.0.0.1');

  // Opened in the address bar, the same site is the first party, and starts with nothing from before.
  r = await b.page(B + '/');
  assert.equal(last(), '');
  assert.deepEqual([bootOf(r.text).jar, bootOf(r.text).part], [true, undefined]);
  await b.fetch(B + '/api.json', B + '/');
  assert.equal(last(), 'id=localhost');
  assert.equal(await scriptSees(B + '/'), 'id=localhost');
  // Back on the first page it is a third party again, cookies or not.
  await b.fetch(B + '/pixel.json', A + '/');
  assert.equal(last(), '');
  r = await frameOf(b, origin, B + '/widget', A + '/');
  assert.equal(last(), '');
  assert.equal(bootOf(r.text).cookie, '');

  // -- all: third parties keep cookies as well (their storage in a frame still stays apart)
  app.config.patch({ privacy: { cookies: 'all' } });
  await b.fetch(B + '/pixel.json', A + '/');
  assert.equal(last(), 'id=localhost');
  r = await frameOf(b, origin, B + '/widget', A + '/');
  boot = bootOf(r.text);
  assert.deepEqual([boot.jar, boot.cookie, boot.part], [true, 'id=localhost', '127.0.0.1']);
  await scriptSets('f/' + B + '/widget', 'js=1; Path=/');
  assert.equal(await scriptSees('f/' + B + '/widget'), 'id=localhost; js=1');

  // -- none: nobody gets any, and nothing new is kept
  app.config.patch({ privacy: { cookies: 'none' } });
  r = await b.page(A + '/');
  assert.equal(last(), '');
  assert.equal(bootOf(r.text).jar, false);
  assert.equal(await scriptSees(A + '/'), '');
  await scriptSets(A + '/', 'late=1; Path=/');
  app.config.patch({ privacy: { cookies: 'first' } });
  await b.page(A + '/');
  assert.equal(last(), 'id=127.0.0.1', 'what was there before is used again; nothing was added meanwhile');
});

test('workers start with the page script in front and the identity of their page', async () => {
  const code = 'importScripts("/lib.js"); fetch("/api")';
  const s = await site({
    '/': { body: PAGE },
    '/widget': { body: '<html><head></head><body></body></html>' },
    '/w.js': { headers: { 'Content-Type': 'text/javascript' }, body: code },
  });
  const { b, origin } = await start();
  const page = await b.page(s.url + '/');
  const client = (await b.raw('/-/client.js')).text;

  for (const dest of ['worker', 'sharedworker']) {
    const r = await b.fetch(s.url + '/w.js', s.url + '/', { dest });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], GUARD_CSP, 'whatever gets past the page script can still only reach Waddle');
    const m = /^self\.__waddle=(\{.*\});\n/.exec(r.text);
    assert.ok(m, dest);
    const boot = JSON.parse(m[1]);
    assert.equal(boot.base, s.url + '/w.js', 'the address its relative URLs are meant against');
    assert.deepEqual(boot.page, bootOf(page.text).page, 'the same identity as the page that started it');
    assert.equal(boot.part, undefined);
    assert.equal(r.text, m[0] + client + '\n' + code);
  }
  // Loaded as an ordinary script, the same file is left alone.
  const plain = await b.fetch(s.url + '/w.js', s.url + '/', { dest: 'script' });
  assert.equal(plain.text, code);
  assert.equal(plain.headers['content-security-policy'], undefined);

  // A worker started by a guest document keeps its storage apart, like the document.
  const G = 'http://localhost:' + s.port;
  await frameOf(b, origin, G + '/widget', s.url + '/');
  const guest = await b.fetch(G + '/w.js', 'f/' + G + '/widget', { dest: 'worker' });
  assert.equal(JSON.parse(/^self\.__waddle=(\{.*\});\n/.exec(guest.text)[1]).part, '127.0.0.1');

  // Sites' own service workers would sit between the page and Waddle's: they are not served.
  const hits = s.hits.length;
  const sw = await b.fetch(s.url + '/w.js', s.url + '/', { dest: 'serviceworker' });
  assert.equal(sw.status, 404);
  assert.equal(s.hits.length, hits);
});

test('a request the service worker had to send again is read as what it was; nothing of Waddle’s reaches the site', async () => {
  const css = 'body{background:url(/bg.png)}';
  const html = '<html><head></head><body><a href="/x">x</a></body></html>';
  const s = await site({
    '/': { body: PAGE },
    '/s.css': { headers: { 'Content-Type': 'text/css' }, body: css },
    '/page': { body: html },
    '/echo': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.headers));
    },
  });
  const { b } = await start();
  const from = s.url + '/';
  // What the browser makes of a request a worker passes on: a script's fetch(), whatever it was before.
  const resent = { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' };
  const note = (dest, mode) => Object.assign({ 'X-Waddle-Dest': dest }, mode ? { 'X-Waddle-Mode': mode } : {}, resent);

  let r = await b.fetch(s.url + '/s.css', from, { headers: note('style', 'no-cors') });
  assert.equal(r.text, 'body{background:url(/~/' + s.url + '/bg.png)}', 'with the note it is a stylesheet again, and rewritten');
  r = await b.fetch(s.url + '/s.css', from, { headers: resent });
  assert.equal(r.text, css, 'without one it is data for a script, and left alone');

  r = await b.fetch(s.url + '/echo', from, {
    headers: Object.assign(note('image', 'no-cors'), {
      'Service-Worker': 'script',
      'Service-Worker-Navigation-Preload': 'true',
      'X-Waddle-Extra': '1',
    }),
  });
  const h = JSON.parse(r.text);
  assert.deepEqual([h['sec-fetch-dest'], h['sec-fetch-mode'], h['sec-fetch-site']], ['image', 'no-cors', 'same-origin']);
  for (const k of Object.keys(h)) assert.ok(!/^x-waddle|^service-worker/.test(k), k + ' must not reach the site');

  // The note cannot turn a fetch() into a page: a page gets the visitor's cookies and identity written into it.
  for (const dest of ['document', 'iframe', 'frame', 'embed', 'object', 'Not A Dest!']) {
    r = await b.fetch(s.url + '/page', from, { headers: note(dest) });
    assert.equal(r.text, html, dest);
  }
  // Nor does it mean anything on a request that is not a fetch().
  r = await b.fetch(s.url + '/s.css', from, { dest: 'image', headers: { 'X-Waddle-Dest': 'style' } });
  assert.equal(r.text, css);
  // A navigation that reaches the server this way is still a page.
  r = await b.raw('/~/' + s.url + '/page', { headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'navigate' } });
  assert.ok(r.text.includes('/-/client.js') && r.text.includes('href="/~/' + s.url + '/x"'));
});

test('HTTPS only covers sockets: ws:// is asked for as wss://', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, port, origin } = await start({ route: { https: true } });
  await b.api('state');
  const path = '/-/ws?u=' + encodeURIComponent('ws://' + s.host + '/socket') + '&o=' + encodeURIComponent(s.url);
  const open = () => ws(port, path, { Cookie: b.cookie, Origin: origin }).catch(() => ({ status: 'reset' }));
  const first = await open();
  assert.notEqual(first.status, 101, 'the stand-in site has no TLS, so the socket fails');
  assert.equal(s.hits.filter((x) => x.method === 'WS').length, 0, 'rather than being opened in the clear');
  // Staying on plain HTTP for a host is a deliberate choice, and covers its sockets too.
  assert.deepEqual((await b.api('plain', { host: '127.0.0.1', on: true })).json.plain, ['127.0.0.1']);
  const second = await open();
  assert.equal(second.status, 101);
  assert.equal(await second.send('hi'), 'echo:hi');
  second.close();
});

test('the check page shows what a site would see, by asking the test page through the exit a new site would get', async () => {
  const { b, app, px, port } = await start();
  const k = await exits();
  const r = await b.page('https://check.waddle.invalid/');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-waddle'], '1');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(r.text.includes('visited from <b>203.0.113.10</b> in United States'), 'address and country as the test page saw them');
  const shown = JSON.parse(/var D=(\{.*?\});var real=/.exec(r.text)[1]);
  assert.deepEqual([shown.exit.ip, shown.exit.cc, shown.exit.hops.length, shown.exitError], ['203.0.113.10', 'US', 1, '']);
  assert.match(shown.sent['User-Agent'], /Chrome\/\d+/);
  assert.equal(shown.sent['Accept-Language'], 'en-US,en;q=0.9');
  assert.deepEqual([shown.sent.DNT, shown.sent['Sec-GPC']], ['1', '1']);
  assert.equal(shown.visitor, '', 'the visitor here is on this machine: no public address to show');
  assert.deepEqual(shown.policy, {
    geo: 'block',
    dns: 'by the exit; your resolvers when it cannot',
    https: false,
    cookies: 'refused',
    trackers: true,
  });
  assert.deepEqual(px.log, ['127.0.0.1:' + k.judge.port], 'only the test page was asked, and through the exit');
  const boot = bootOf(r.text);
  assert.deepEqual(
    [boot.jar, boot.page.tz, boot.page.languages[0]],
    [false, 'America/New_York', 'en-US'],
    'the page reads itself with the identity a site would be shown'
  );
  const last = (await b.api('state')).json.pool.last;
  assert.deepEqual([last.host, last.status, last.hops.length], ['waddle:check', 200, 1]);

  // Behind a reverse proxy the visitor's own address is known, and shown to them for comparison (never sent anywhere).
  const far = await b.page('https://check.waddle.invalid/', { headers: { 'X-Forwarded-For': '198.51.100.77, 10.0.0.1' } });
  assert.equal(JSON.parse(/var D=(\{.*?\});var real=/.exec(far.text)[1]).visitor, '198.51.100.77');

  // An exit that stops answering is said to have failed; with none at all the page says that.
  px.opt.refuse = true;
  net.dropAgents();
  const bad = await b.page('https://check.waddle.invalid/');
  px.opt.refuse = false;
  assert.equal(bad.status, 200);
  assert.match(JSON.parse(/var D=(\{.*?\});var real=/.exec(bad.text)[1]).exitError, /^The exit did not answer the test \(/);
  assert.equal((await b.api('state')).json.pool.last.error, 'Exit failed');
  app.pool.clear();
  const none = await b.page('https://check.waddle.invalid/');
  assert.equal(none.status, 200);
  const told = JSON.parse(/var D=(\{.*?\});var real=/.exec(none.text)[1]);
  assert.equal(told.exit, null);
  assert.ok(told.exitError.length > 0 && none.text.includes('<p class="lead">' + told.exitError.replace(/&/g, '&amp;')), told.exitError);
  assert.equal((await browser(port).page('https://check.waddle.invalid/')).status, 200);
});

// ---- through the pool ---------------------------------------------------------------------

/** A server whose pool is fed by the little internet from support.world(): three exits, of three kinds, in three countries. */
async function routed(route, setup, patch = {}) {
  const w = await world();
  if (setup) await setup(w);
  const ctx = await start(
    Object.assign({}, patch, {
      route: Object.assign({ rotate: 'request' }, route),
      pool: Object.assign(
        { sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl, canaries: [w.canary], echo: w.echoUrl },
        patch.pool
      ),
    }),
    { exit: false }
  );
  await until(() => ctx.app.pool.summary().plain === 3, 8000);
  for (const p of w.all) p.log.length = 0;
  return Object.assign(ctx, { w });
}
const used = (w) =>
  w.all
    .filter((p) => p.log.length)
    .map((p) => p.cc)
    .sort()
    .join(',');

test('pages are fetched through a live proxy, and the route is reported', async () => {
  const s = await site({ '/': { body: PAGE }, '/pic.png': { headers: { 'Content-Type': 'image/png' }, body: 'PNG' } });
  const { b, w, port } = await routed({});
  const r = await b.page(s.url + '/');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Fixture'));
  assert.equal(
    w.all.reduce((n, p) => n + p.log.length, 0),
    1,
    'exactly one proxy carried it'
  );
  const state = (await b.api('state')).json;
  const last = state.pool.last;
  assert.equal(last.host, s.host);
  assert.equal(last.status, 200);
  assert.equal(last.direct, undefined, 'there is no such thing any more');
  assert.equal(last.attempts, 1);
  assert.equal(last.hops.length, 1);
  assert.equal(last.hops[0].cc, used(w), 'the exit shown is the exit used');
  assert.match(last.hops[0].addr, /^127\.0\.0\.1:\d+$/);
  assert.ok(last.ms >= 0);
  assert.equal(state.identity.cc, last.hops[0].cc, 'and the identity shown is the one that page was given');
  // sub-resources go through the pool too, but do not replace the page's route report
  await b.fetch(s.url + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal((await b.api('state')).json.pool.last.at, last.at);
  // the report is the visitor's own: nobody else sees where they have been
  const other = (await browser(port).api('state')).json;
  assert.equal(other.pool.last, null);
  assert.equal(other.pool.alive, 3);
});

test('a page and everything on it leave from one exit with one face; a frame that is turned away gets an exit of its own', async () => {
  const html = '<html><head></head><body>ok</body></html>';
  const mk = () =>
    site({
      '*': (req, res, body, url) => {
        const img = url.pathname.endsWith('.png');
        res.writeHead(200, { 'Content-Type': img ? 'image/png' : 'text/html' });
        res.end(img ? 'PNG' : html);
      },
    });
  const a = await mk(); // the site in the address bar
  const g = await mk(); // a third party on its pages
  const wall = await site({ '*': { status: 403, body: '<html><body>denied</body></html>' } });
  const { b, app, w, origin } = await routed({ rotate: 'sticky', retries: 2 });
  const A = 'http://127.0.0.1:' + a.port;
  const G = 'http://localhost:' + g.port;
  const went = (p, s) => p.log.filter((l) => (typeof l === 'string' ? l.endsWith(':' + s.port) : l.port === s.port)).length;
  const through = (s) =>
    w.all
      .filter((p) => went(p, s))
      .map((p) => p.cc)
      .join(',');

  const page = await b.page(A + '/');
  const exit = (await b.api('state')).json.pool.last.hops[0];
  const home = w.all.find((p) => p.addr === exit.addr);
  for (let i = 0; i < 6; i++) await b.fetch(G + '/pic' + i + '.png', A + '/', { dest: 'image' });
  const frame = await frameOf(b, origin, G + '/widget', A + '/');
  assert.equal(frame.status, 200);
  await b.fetch(G + '/inner.png', 'f/' + G + '/widget', { dest: 'image' });
  assert.equal(through(a), home.cc);
  assert.equal(through(g), home.cc, "the third party was met from the page's exit, and from no other");
  // One face: the frame is told the same things about the browser as the page, and so is the third party's server.
  const [top, sub] = [bootOf(page.text), bootOf(frame.text)];
  assert.deepEqual(sub.page, top.page);
  assert.equal(sub.part, '127.0.0.1', 'while its storage is kept apart from the same site opened on its own');
  assert.equal(g.last().headers['accept-language'], a.hits[0].headers['accept-language']);
  assert.equal(g.last().headers['user-agent'], a.hits[0].headers['user-agent']);
  assert.equal((await b.api('state')).json.pool.last.host, a.host, 'the route that is reported is still the page’s, not the frame’s');

  // The third party starts refusing the page's exit, and only that one.
  home.map(g.port, wall.port);
  net.dropAgents();
  for (const p of w.all) p.log.length = 0;
  const again = await frameOf(b, origin, G + '/widget?2', A + '/');
  assert.equal(again.status, 200, 'the frame loads through another exit');
  assert.equal(wall.hits.length, 1);
  const side = w.all.find((p) => p !== home && went(p, g));
  assert.ok(side);
  for (let i = 0; i < 5; i++) {
    assert.equal((await frameOf(b, origin, G + '/widget?n=' + i, A + '/')).status, 200);
    await b.fetch(G + '/more' + i + '.png', A + '/', { dest: 'image' });
  }
  assert.equal(wall.hits.length, 1, 'from then on it goes straight to the exit that works for it');
  assert.equal(w.all.filter((p) => p !== home && went(p, g)).length, 1, 'one exit of its own, not a new one each time');
  // And the page has not moved.
  for (const p of w.all) p.log.length = 0;
  for (let i = 0; i < 5; i++) assert.equal((await b.page(A + '/?' + i)).status, 200);
  assert.equal(through(a), home.cc);
  assert.equal((await b.api('state')).json.pool.last.hops[0].addr, exit.addr);
  assert.equal(app.pool.alive.size, 3, 'being turned away by one site is nothing against a proxy');
  for (const p of app.pool.summary().proxies) assert.equal(p.errs, 0, p.addr);

  // Opened in the address bar, the third party is a site of its own: an exit of its own choosing, and no memory of the frame.
  const own = await b.page(G + '/');
  assert.equal(bootOf(own.text).part, undefined);
  assert.equal((await b.api('state')).json.pool.last.host, 'localhost:' + g.port);
});

test('proxy over proxy: chains of 2 and 3 hops carry the page, and only the exit learns where it is going', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, app, w } = await routed({ hops: 2 });
  let r = await b.page(s.url + '/');
  assert.equal(r.status, 200);
  let last = (await b.api('state')).json.pool.last;
  assert.equal(last.hops.length, 2);
  assert.equal(new Set(last.hops.map((h) => h.addr)).size, 2);
  assert.equal(w.all.filter((p) => p.log.length).length, 2, 'two proxies took part');

  app.config.patch({ route: { hops: 3 } });
  for (const p of w.all) p.log.length = 0;
  r = await b.page(s.url + '/');
  assert.equal(r.status, 200);
  last = (await b.api('state')).json.pool.last;
  assert.equal(last.hops.length, 3);
  assert.equal(used(w), 'DE,JP,US', 'all three took part');
  const exit = w.all.find((p) => p.addr === last.hops[2].addr);
  const sawSite = (p) => JSON.stringify(p.log).includes(String(s.port));
  assert.ok(sawSite(exit), 'the exit connected to the site');
  for (const p of w.all) if (p !== exit) assert.ok(!sawSite(p), p.cc + ' (not the exit) never learned where the traffic was going');
  const entry = w.all.find((p) => p.addr === last.hops[0].addr);
  assert.equal(new Set(last.hops.map((h) => h.cc)).size, 3, 'spread over three countries');
  assert.ok(entry !== exit);

  // More hops than there are proxies: the longest chain that can be built, or, if that is not wanted, none.
  app.config.patch({ route: { hops: 5 } });
  r = await b.page(s.url + '/');
  assert.equal(r.status, 200);
  assert.equal((await b.api('state')).json.pool.last.hops.length, 3);
  app.config.patch({ route: { shorten: false } });
  const hits = s.hits.length;
  r = await b.page(s.url + '/');
  assert.equal(r.headers['x-waddle-error'], 'noproxy');
  assert.match(r.text, /<h1>Not enough proxies<\/h1>/);
  assert.equal(s.hits.length, hits);

  // The first hop can be kept to named countries: it is the one proxy that sees this server's address.
  app.config.patch({ route: { hops: 2, shorten: true, entry: ['JP'] } });
  for (let i = 0; i < 10; i++) {
    r = await b.page(s.url + '/?' + i);
    assert.equal(r.status, 200);
    last = (await b.api('state')).json.pool.last;
    assert.deepEqual([last.hops.length, last.hops[0].cc], [2, 'JP']);
    assert.notEqual(last.hops[1].cc, 'JP', 'so the Japanese proxy is never the exit: there would be nothing to put in front of it');
  }
  app.config.patch({ route: { entry: ['FR'] } });
  r = await b.page(s.url + '/');
  assert.equal(r.headers['x-waddle-error'], 'noproxy');
  assert.match(r.text, /<h1>No entry proxy<\/h1>/);
});

test('a full 16-hop chain carries a page, with only the exit seeing the destination', async () => {
  const w = await world();
  const extra = [];
  for (let i = 0; i < 13; i++) extra.push(await httpProxy());
  const all = w.all.concat(extra);
  const { b, app } = await start(
    {
      route: { hops: 16, shorten: false, spread: false },
      pool: { sources: [], on: false, judge: w.judgeUrl, canaries: [w.canary], echo: '' },
    },
    { exit: false }
  );
  app.pool.addManual(all.map((p) => p.proto + '://' + p.host + ':' + p.port).join('\n'));
  await until(() => app.pool.alive.size === 16 && app.pool.summary().plain === 16, 15000);
  for (const p of all) p.log.length = 0;
  const s = await site({ '/': { body: PAGE } });
  const r = await b.page(s.url + '/');
  assert.equal(r.status, 200);
  const last = (await b.api('state')).json.pool.last;
  assert.equal(last.hops.length, 16);
  assert.equal(new Set(last.hops.map((h) => h.addr)).size, 16);
  assert.equal(all.filter((p) => p.log.length).length, 16, 'all 16 distinct proxies took part');
  const exit = all.find((p) => p.addr === last.hops[15].addr);
  const sawSite = (p) => p.log.some((entry) => (typeof entry === 'string' ? entry.endsWith(':' + s.port) : entry.port === s.port));
  assert.ok(exit && sawSite(exit), 'the exit connected to the website');
  for (const p of all) if (p !== exit) assert.ok(!sawSite(p), 'a relay did not learn the destination');
});

test('per-site rules pick the country and the chain length; the identity follows the exit', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, app, w } = await routed({ rules: [] });
  const load = async (host) => {
    for (const p of w.all) p.log.length = 0;
    s.hits.length = 0;
    const r = await b.page('http://' + host + ':' + s.port + '/');
    return { r, last: (await b.api('state')).json.pool.last, seen: s.last() };
  };

  app.config.patch({ route: { rules: ['127.0.0.1 proxy JP', 'localhost proxy DE'] } });
  for (let i = 0; i < 5; i++) {
    const { last } = await load('127.0.0.1');
    assert.equal(last.hops[0].cc, 'JP');
    assert.equal(last.rule, '127.0.0.1');
  }
  // A page that leaves from Japan speaks Japanese and keeps Tokyo time; one that leaves from Germany, German and Berlin time.
  const jp = await load('127.0.0.1');
  assert.equal(jp.seen.headers['accept-language'], 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.deepEqual(bootOf(jp.r.text).page.languages, ['ja-JP', 'ja', 'en-US', 'en']);
  assert.equal(bootOf(jp.r.text).page.tz, 'Asia/Tokyo');
  const de = await load('localhost');
  assert.equal(de.last.hops[0].cc, 'DE');
  assert.equal(de.seen.headers['accept-language'], 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.equal(bootOf(de.r.text).page.tz, 'Europe/Berlin');
  assert.equal(
    bootOf(de.r.text).page.nav.ua,
    bootOf(jp.r.text).page.nav.ua,
    'the browser stays the same; only where it seems to be changes'
  );
  const id = (await b.api('state')).json.identity;
  assert.deepEqual([id.cc, id.tz, id.languages[0]], ['DE', 'Europe/Berlin', 'de-DE']);
  // Fixed values, when asked for, win over the exit's.
  app.config.patch({ spoof: { languages: 'pt-BR,pt', timezone: 'America/Sao_Paulo' } });
  const fixed = await load('127.0.0.1');
  assert.equal(fixed.seen.headers['accept-language'], 'pt-BR,pt;q=0.9');
  assert.equal(bootOf(fixed.r.text).page.tz, 'America/Sao_Paulo');
  app.config.patch({ spoof: { languages: 'exit', timezone: 'exit' } });

  app.config.patch({ route: { rules: ['127.0.0.1 proxy hops=2'] } });
  assert.equal((await load('127.0.0.1')).last.hops.length, 2);
  app.config.patch({ route: { rules: ['127.0.0.1 proxy US,DE hops=3'] } });
  for (let i = 0; i < 4; i++) {
    const { last } = await load('127.0.0.1');
    assert.equal(last.hops.length, 3);
    assert.ok(['US', 'DE'].includes(last.hops[2].cc), 'the countries in a rule are about the exit');
  }
  app.config.patch({ route: { rules: ['127.0.0.1 proxy FR'] } });
  const none = await load('127.0.0.1');
  assert.equal(none.r.headers['x-waddle-error'], 'noproxy');
  assert.match(none.r.text, /<h1>No proxy matches<\/h1>/);
  assert.equal(s.hits.length, 0);
  assert.equal(used(w), '', 'and no proxy was bothered with it');
});

test('when an exit is refused by the site (403/429/503), another exit is tried; when all are, the refusal is the answer', async () => {
  const s = await site({ '/': { body: PAGE } });
  const wall = await site({ '*': { status: 403, body: '<html><body>Access denied for your region</body></html>' } });
  // The US and DE exits are blocked by this site; JP is welcome. The site starts out on the US exit.
  const some = await routed({ retries: 2, rotate: 'sticky' }, (w) => {
    w.h.map(s.port, wall.port);
    w.s5.map(s.port, wall.port);
  });
  some.app.pool.pin('127.0.0.1', { key: some.w.h.key });
  const first = await some.b.page(s.url + '/');
  assert.equal(first.status, 200);
  assert.ok(first.text.includes('Fixture'));
  const met = wall.hits.length;
  assert.ok(met === 1 || met === 2, 'the blocked exits that were met (' + met + ') were moved away from');
  let last = (await some.b.api('state')).json.pool.last;
  assert.deepEqual([last.hops[0].cc, last.attempts], ['JP', met + 1]);
  for (let i = 0; i < 12; i++) assert.equal((await some.b.page(s.url + '/?n=' + i)).status, 200, 'request ' + i);
  assert.equal(wall.hits.length, met, 'and the site stays with the exit that is welcome: it is not asked through the others again');
  // Every request its own exit: the ones that were turned away are remembered all the same.
  some.app.config.patch({ route: { rotate: 'request' } });
  for (let i = 0; i < 12; i++) assert.equal((await some.b.page(s.url + '/?m=' + i)).status, 200);
  assert.ok(wall.hits.length <= 2, 'each blocked exit is met once at most (' + wall.hits.length + ')');
  last = (await some.b.api('state')).json.pool.last;
  assert.equal(last.hops[0].cc, 'JP');
  assert.equal(some.app.pool.alive.size, 3, 'being turned away by one site is nothing against a proxy');
  for (const p of some.app.pool.summary().proxies) assert.equal(p.errs, 0, p.addr);
  await some.app.close();

  // Every exit blocked: the site's own refusal is handed over. There is no other way to the site.
  const s2 = await site({ '/': { body: PAGE } });
  const all = await routed({ retries: 3 }, (w) => {
    for (const p of w.all) p.map(s2.port, wall.port);
  });
  wall.hits.length = 0;
  const refused = await all.b.page(s2.url + '/');
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['x-waddle-error'], undefined, "the site's own page");
  assert.ok(refused.text.includes('Access denied for your region'));
  assert.equal(wall.hits.length, 3, 'each exit had its go');
  assert.equal((await all.b.api('state')).json.pool.last.attempts, 3);
  assert.equal(s2.hits.length, 0);
});

test('a site that is down costs the pool nothing; an exit that fails where another gets through is marked down, and only what it failed for moves', async () => {
  const s = await site({ '/': { body: PAGE }, '/pic.png': { headers: { 'Content-Type': 'image/png' }, body: 'PNG' } });
  const lib = await site({ '/lib.js': { headers: { 'Content-Type': 'text/javascript' }, body: 'var x = 1;' } });
  const odd = await site({
    '*': { status: 407, headers: { 'Content-Type': 'text/plain', 'Proxy-Authenticate': 'Basic realm="x"' }, body: 'who goes there' },
  });
  const { b, app, w } = await routed({ retries: 3 });
  const errs = (p) => app.pool.summary().proxies.find((x) => x.addr === p.addr).errs;
  const went = (p, to) => p.log.filter((l) => (typeof l === 'string' ? l.endsWith(':' + to.port) : l.port === to.port)).length;
  const gone = 'http://127.0.0.1:1';
  for (let i = 0; i < 5; i++) {
    const r = await b.page(gone + '/?' + i);
    assert.equal(r.headers['x-waddle-error'], 'connect');
  }
  for (let i = 0; i < 10; i++) await b.fetch(gone + '/' + i + '.js', s.url + '/', { dest: 'script' });
  assert.equal(used(w), 'DE,JP,US', 'every exit was asked');
  // A site that answers 407 is a site with an odd answer. Everything is tunnelled, so it cannot be the proxy speaking.
  const r407 = await b.page(odd.url + '/');
  assert.equal(r407.status, 407);
  assert.equal(r407.headers['proxy-authenticate'], undefined);
  assert.equal(odd.hits.length, 1, 'passed on as it came, not tried again elsewhere');
  assert.equal(app.pool.alive.size, 3, 'and no proxy is the worse for any of it');
  for (const p of w.all) assert.equal(errs(p), 0, p.cc);

  // The page's exit cannot reach one third party on the page; the other exits can.
  app.config.patch({ route: { rotate: 'sticky' } });
  await b.page(s.url + '/');
  const first = (await b.api('state')).json.pool.last.hops[0];
  const home = w.all.find((p) => p.addr === first.addr);
  home.map(lib.port, w.dead);
  for (let i = 0; i < 5; i++) {
    const r = await b.fetch('http://localhost:' + lib.port + '/lib.js', s.url + '/', { dest: 'script' });
    assert.deepEqual([r.status, r.text], [200, 'var x = 1;'], 'the file arrives all the same, through another exit');
  }
  assert.equal(errs(home), 1, 'held against it once: after that the third party is sent another way from the start');
  assert.ok(app.pool.alive.has(home.key), 'it still passes the pool’s own test, so it stays in the pool');
  const carriers = () =>
    w.all
      .filter((p) => went(p, s))
      .map((p) => p.cc)
      .join(',');
  net.dropAgents(); // (new connections, so that the stand-ins see who carries what)
  for (const p of w.all) p.log.length = 0;
  for (let i = 0; i < 5; i++) assert.equal((await b.page(s.url + '/?' + i)).status, 200);
  await b.fetch(s.url + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal(carriers(), home.cc, 'and the page has stayed where it was: one file does not move it');

  // Now it cannot reach the site itself any more.
  home.map(s.port, w.dead);
  net.dropAgents();
  const r = await b.page(s.url + '/');
  assert.equal(r.status, 200, 'the page still loads');
  const moved = (await b.api('state')).json.pool.last;
  assert.equal(moved.attempts, 2);
  assert.notEqual(moved.hops[0].addr, home.addr);
  assert.equal(errs(home), 2);
  net.dropAgents();
  for (const p of w.all) p.log.length = 0;
  for (let i = 0; i < 10; i++) assert.equal((await b.page(s.url + '/?again' + i)).status, 200);
  await b.fetch(s.url + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal(carriers(), w.all.find((p) => p.addr === moved.hops[0].addr).cc, 'the site is not asked for through that exit again');
  assert.equal((await b.api('state')).json.pool.last.hops[0].addr, moved.hops[0].addr, 'it stays with the one that worked');
  assert.equal(app.pool.alive.size, 3);
});

test('a request with a body is never sent twice', async () => {
  const s = await site({
    '/buy': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('order placed');
    },
    '/slow': () => {},
  });
  const wall = await site({ '*': { status: 503, body: 'try later' } });
  const { b, app, w } = await routed({ retries: 3, timeout: 1500 }, (x) => {
    for (const p of x.all) p.map(s.port, wall.port);
  });
  const post = (path, body) =>
    b.fetch(s.url + path, s.url + '/', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const r = await post('/buy', 'item=1');
  assert.equal(r.status, 503, 'the first answer stands');
  assert.equal(wall.hits.length, 1, 'one exit, one attempt');
  assert.equal(s.hits.length, 0);

  // Sent, and then silence: it may have arrived. It is not sent again through another exit.
  for (const p of w.all) {
    delete p.opt.ports[s.port];
    p.log.length = 0;
  }
  net.dropAgents();
  const hung = await post('/slow', 'item=2');
  assert.equal(hung.headers['x-waddle-error'], 'timeout');
  assert.equal(s.hits.filter((h) => h.path === '/slow').length, 1, 'the site got it once');
  assert.equal(w.all.filter((p) => JSON.stringify(p.log).includes(String(s.port))).length, 1, 'and no second exit was handed it');

  // If the exit is dead before anything was sent, moving on is safe.
  await w.h.close();
  await w.s5.close();
  net.dropAgents();
  for (const p of w.all) p.log.length = 0;
  for (let i = 0; i < 6; i++) {
    const again = await post('/buy', 'n=' + i);
    assert.equal(again.status, 200);
    assert.equal(again.text, 'order placed');
  }
  const bought = s.hits.filter((h) => h.path === '/buy');
  assert.deepEqual(
    bought.map((h) => h.body),
    ['n=0', 'n=1', 'n=2', 'n=3', 'n=4', 'n=5'],
    'each delivered exactly once, by the exit that is left'
  );
  assert.ok(app.pool.alive.has(w.s4.key), 'the exit that delivered them is still in the pool');

  // With no exit left at all, nothing is delivered and nothing goes out some other way.
  await w.s4.close();
  net.dropAgents();
  const lost = await post('/buy', 'n=7');
  assert.ok(['connect', 'noproxy'].includes(lost.headers['x-waddle-error']), lost.headers['x-waddle-error']);
  assert.equal(s.hits.filter((h) => h.path === '/buy').length, 6);
});

test('pool actions from the settings panel: add by hand, rotate, speed test, clear', async () => {
  const w = await world();
  const s = await site({ '/': { body: PAGE } });
  const { b, app } = await start({ route: { rotate: 'sticky' }, pool: { judge: w.judgeUrl, canaries: [w.canary] } }, { exit: false });
  let r = (await b.api('pool', { action: 'add', text: `socks5://127.0.0.1:${w.s5.port}\n127.0.0.1:${w.h.port}\nrubbish`, proto: '' })).json;
  assert.equal(r.added, 2);
  r = (await b.api('pool', { action: 'add', text: '127.0.0.1:' + w.s4.port, proto: 'socks4' })).json;
  assert.equal(r.added, 1);
  await until(() => app.pool.summary().plain === 3, 8000);
  const st = (await b.api('state')).json.pool;
  assert.equal(st.alive, 3);
  assert.deepEqual(st.countries, { US: 1, DE: 1, JP: 1 });
  assert.deepEqual(st.byProto, { http: 1, socks4: 1, socks5: 1 });
  assert.equal(st.sources.find((x) => x.id === 'manual').count, 3);

  // sticky: the same exit for a site until "New exit"
  const exits = new Set();
  for (let i = 0; i < 6; i++) {
    await b.page(s.url + '/?' + i);
    exits.add((await b.api('state')).json.pool.last.hops[0].addr);
  }
  assert.equal(exits.size, 1);
  const before = [...exits][0];
  let moved = false;
  for (let i = 0; i < 20 && !moved; i++) {
    await b.api('pool', { action: 'rotate', site: '127.0.0.1' });
    await b.page(s.url + '/');
    moved = (await b.api('state')).json.pool.last.hops[0].addr !== before;
  }
  assert.ok(moved, 'rotate picks a new exit');

  r = (await b.api('pool', { action: 'speed', url: s.url + '/' })).json;
  assert.equal(r.results.length, 3, 'one row per exit, and none for a direct connection');
  for (const row of r.results) {
    assert.match(row.via, /^(http|socks4|socks5):\/\/127\.0\.0\.1:\d+ (US|DE|JP)$/);
    assert.equal(row.status, 200);
    assert.ok(row.ms >= 0 && row.ms < 2000);
  }
  assert.equal((await b.api('pool', { action: 'speed', url: 'file:///etc/passwd' })).status, 400);

  r = (await b.api('pool', { action: 'clear' })).json;
  assert.equal(r.pool.alive, 0);
  assert.equal(r.pool.found, 0);
  assert.equal((await b.page(s.url + '/')).headers['x-waddle-error'], 'noproxy');
});
