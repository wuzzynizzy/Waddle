'use strict';
const { site, browser, get, world, closeAll, until, sleep } = require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { createApp } = require('../server');
const net = require('../lib/net');

const apps = [];
test.after(async () => {
  for (const a of apps) await a.close().catch(() => {});
  net.dropAgents();
  await closeAll();
});
test.afterEach(() => net.dropAgents());

/** A Waddle server with the proxy pool off (traffic goes direct) unless a test says otherwise. */
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
  return { app, port, b: browser(port), origin: 'http://127.0.0.1:' + port };
}

const PAGE =
  '<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/s.css"></head><body><a href="/next">next</a><img src="pic.png"><form action="/post" method="post"></form><script src="https://cdn.test/lib.js"></script></body></html>';

// ---- pages ----------------------------------------------------------------------------

test('a page comes back rewritten, with the page script first in <head>', async () => {
  const s = await site({ '/dir/': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: PAGE } });
  const { b } = await start();
  const r = await b.page(s.url + '/dir/');
  const P = '/~/' + s.url;
  assert.equal(r.status, 200);
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
  const boot = JSON.parse(
    /data-w="([^"]+)"/
      .exec(r.text)[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  );
  assert.equal(boot.page.on, true);
  assert.match(boot.page.nav.ua, /Chrome\/\d+/);
  assert.equal(typeof boot.cookie, 'string');
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
  assert.equal(bad.status, 502, 'a corrupt body is an error page, not a crash');
  assert.equal(bad.headers['x-waddle-error'], '1');
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
  for (const gone of [
    'content-security-policy',
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
  ]) {
    assert.equal(r.headers[gone], undefined, gone);
  }
  assert.ok(
    !(r.headers['set-cookie'] || []).some((c) => /^sid=/.test(c)),
    "site cookies live in the server-side jar, never on Waddle's own origin"
  );
  assert.equal(r.headers['x-custom'], 'kept');
  assert.equal(r.headers['content-language'], 'en');
  if (r.headers.link)
    assert.ok(
      !/<\/style\.css>|<https:\/\/cdn\.test/.test(r.headers.link),
      'Link preloads may not point outside the proxy: ' + r.headers.link
    );
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
  assert.equal(dead.status, 502);
  assert.equal(dead.headers['x-waddle-error'], '1');
  assert.equal(dead.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(dead.text, /<h1>Could not connect<\/h1>/);
  assert.match(dead.text, /Retry/);
  const sub = await b.fetch('http://127.0.0.1:1/x.js', s.url + '/', { dest: 'script' });
  assert.equal(sub.status, 502);
  assert.equal(sub.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(sub.text, 'Could not connect: Connection refused.');

  const nx = await b.page('http://no-such-host.invalid/<script>alert(1)</script>?"><img/src=x/onerror=alert(2)>');
  assert.equal(nx.status, 502);
  assert.match(nx.text, /<h1>Site not found<\/h1>/);
  assert.ok(!nx.text.includes('<script>alert(1)') && !nx.text.includes('<img/src=x'), 'the address is escaped in the error page');

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
  assert.equal(slow.status, 504);
  assert.match(slow.text, /<h1>Timed out<\/h1><p>The site took too long to answer\./);
  assert.ok(Date.now() - t0 < 6000, 'gave up after ' + (Date.now() - t0) + ' ms');
  const last = (await b.api('state')).json.pool.last;
  assert.equal(last.host, s.host);
  assert.equal(last.error, 'timed out');
  void app;
});

test('routing rules: block, and per-site overrides', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, app } = await start({ route: { rules: ['localhost block'] } });
  const blocked = await b.page('http://localhost:' + s.port + '/');
  assert.equal(blocked.status, 403);
  assert.match(blocked.text, /<h1>Blocked<\/h1>/);
  assert.equal(s.hits.length, 0, 'a blocked site is never contacted');
  const sub = await b.fetch('http://localhost:' + s.port + '/ad.js', s.url + '/', { dest: 'script' });
  assert.equal(sub.status, 403);
  assert.match(sub.text, /^Blocked/);
  assert.equal((await b.page(s.url + '/')).status, 200, 'other sites are unaffected');
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

test('settings API: guarded, validated, and everything it changes takes effect', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, port, app } = await start();
  // guard
  assert.equal((await get(port, '/-/api/state')).status, 403, 'needs the custom header (which a cross-site form or image cannot send)');
  assert.equal(
    (
      await get(port, '/-/api/config', {
        method: 'POST',
        body: '{"route":{"mode":"direct"}}',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
    403
  );
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
  assert.equal((await b.api('pool', { action: 'source', text: 'not a source' })).status, 400);

  // state
  const st = (await b.api('state')).json;
  assert.deepEqual(Object.keys(st), ['config', 'options', 'pool', 'dns', 'cookies', 'uptime']);
  assert.equal(st.config.route.mode, 'auto');
  assert.ok(st.options.systems.length >= 9 && st.options.screens.length >= 10 && st.options.dns.length >= 8);
  assert.equal(st.pool.on, false);

  // config
  const patched = (
    await b.api('config', { route: { mode: 'direct', hops: 2, rules: ['ads.test block', 'nonsense'] }, spoof: { theme: 'dark' }, nope: 1 })
  ).json;
  assert.equal(patched.config.route.mode, 'direct');
  assert.equal(patched.config.route.hops, 2);
  assert.deepEqual(patched.config.route.rules, ['ads.test block']);
  assert.equal(app.config.value.spoof.theme, 'dark');
  const page = await b.page(s.url + '/');
  assert.ok(page.text.includes('&quot;theme&quot;:&quot;dark&quot;'), 'the next page load carries the new identity');
  const reset = (await b.api('config', { reset: true })).json;
  assert.equal(reset.config.route.mode, 'auto');
  assert.equal(reset.config.spoof.theme, 'real');
  app.config.patch({ dns: { mode: 'system' }, pool: { on: false, sources: [], discover: false } });

  // sources
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

  // dns
  r = (await b.api('dns', { action: 'test', host: 'localhost' })).json;
  assert.equal(r.host, 'localhost');
  assert.equal(r.results[r.results.length - 1].name, 'system');
  assert.equal(r.results[r.results.length - 1].address, '127.0.0.1');
  assert.equal((await b.api('dns', { action: 'flush' })).status, 200);
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
    body: '{"route":{"mode":"direct"}}',
    headers: { 'Content-Type': 'application/json', 'X-Waddle': '1' },
  });
  assert.equal(r.text, 'site saw /-/api/config');
  assert.equal(app.config.value.route.mode, 'auto');
  assert.equal(s.last().headers['x-waddle'], undefined);
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

// ---- through the pool ---------------------------------------------------------------------

/** A server whose pool is fed by the little internet from support.world(). */
async function routed(route, setup) {
  const w = await world();
  if (setup) await setup(w);
  const ctx = await start({
    route: Object.assign({ mode: 'proxy', rotate: 'request' }, route),
    pool: { on: true, sources: [{ type: 'url', url: w.listUrl, proto: null, on: true }], judge: w.judgeUrl },
  });
  await until(() => ctx.app.pool.summary().alive === 3, 8000);
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
  const { b, w } = await routed({});
  const r = await b.page(s.url + '/');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Fixture'));
  assert.equal(
    w.all.reduce((n, p) => n + p.log.length, 0),
    1,
    'exactly one proxy carried it'
  );
  const last = (await b.api('state')).json.pool.last;
  assert.equal(last.host, s.host);
  assert.equal(last.status, 200);
  assert.equal(last.direct, false);
  assert.equal(last.attempts, 1);
  assert.equal(last.hops.length, 1);
  assert.equal(last.hops[0].cc, used(w), 'the exit shown is the exit used');
  assert.match(last.hops[0].addr, /^127\.0\.0\.1:\d+$/);
  assert.ok(last.ms >= 0);
  // sub-resources go through the pool too, but do not replace the page's route report
  await b.fetch(s.url + '/pic.png', s.url + '/', { dest: 'image' });
  assert.equal((await b.api('state')).json.pool.last.at, last.at);
});

test('proxy over proxy: a 2- or 3-hop chain carries the page, entry first, exit last', async () => {
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
});

test('per-site rules pick the country, the chain length, or no proxy at all', async () => {
  const s = await site({ '/': { body: PAGE } });
  const { b, app, w } = await routed({ rules: [] });
  const load = async (host) => {
    for (const p of w.all) p.log.length = 0;
    s.hits.length = 0;
    const r = await b.page('http://' + host + ':' + s.port + '/');
    return { r, last: (await b.api('state')).json.pool.last };
  };

  app.config.patch({ route: { rules: ['127.0.0.1 proxy JP'] } });
  for (let i = 0; i < 5; i++) {
    const { last } = await load('127.0.0.1');
    assert.equal(last.hops[0].cc, 'JP');
    assert.equal(last.rule, '127.0.0.1');
  }
  app.config.patch({ route: { rules: ['127.0.0.1 proxy hops=2'] } });
  assert.equal((await load('127.0.0.1')).last.hops.length, 2);
  app.config.patch({ route: { rules: ['127.0.0.1 direct'] } });
  const direct = await load('127.0.0.1');
  assert.equal(direct.last.direct, true);
  assert.equal(used(w), '', 'no proxy was touched');
  assert.equal(s.hits.length, 1);
  app.config.patch({ route: { rules: ['127.0.0.1 proxy FR'] } });
  const none = await load('127.0.0.1');
  assert.equal(none.r.status, 502);
  assert.match(none.r.text, /No working proxy/);
  assert.equal(s.hits.length, 0, 'proxy-only means it never silently goes direct');
});

test('when an exit is refused by the site (403/429/503), another exit is tried; then direct, if allowed', async () => {
  const s = await site({ '/': { body: PAGE } });
  const wall = await site({ '*': { status: 403, body: '<html><body>Access denied for your region</body></html>' } });
  // The US and DE exits are blocked by this site; JP is welcome.
  const some = await routed({ retries: 2 }, (w) => {
    w.h.map(s.port, wall.port);
    w.s5.map(s.port, wall.port);
  });
  for (let i = 0; i < 12; i++) {
    const r = await some.b.page(s.url + '/?n=' + i);
    assert.equal(r.status, 200, 'request ' + i);
    assert.ok(r.text.includes('Fixture'));
  }
  assert.ok(wall.hits.length > 0, 'blocked exits were met and rotated away from');
  const last = (await some.b.api('state')).json.pool.last;
  assert.equal(last.hops[0].cc, 'JP');
  await some.app.close();

  // Every exit blocked: "auto" falls back to a direct connection...
  const s2 = await site({ '/': { body: PAGE } });
  const all = await routed({ mode: 'auto', retries: 2 }, (w) => {
    for (const p of w.all) p.map(s2.port, wall.port);
  });
  wall.hits.length = 0;
  const r = await all.b.page(s2.url + '/');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Fixture'));
  const fell = (await all.b.api('state')).json.pool.last;
  assert.equal(fell.direct, true);
  assert.equal(fell.fellBack, true);
  assert.equal(fell.attempts, 4, 'three exits, then direct');
  assert.equal(wall.hits.length, 3);

  // ...while "proxy" hands over the site's own refusal rather than exposing your address.
  all.app.config.patch({ route: { mode: 'proxy' } });
  s2.hits.length = 0;
  const refused = await all.b.page(s2.url + '/');
  assert.equal(refused.status, 403);
  assert.ok(refused.text.includes('Access denied for your region'));
  assert.equal(s2.hits.length, 0);
});

test('a request with a body is never sent twice', async () => {
  const s = await site({
    '/buy': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('order placed');
    },
  });
  const wall = await site({ '*': { status: 503, body: 'try later' } });
  const { b, app, w } = await routed({ mode: 'auto', retries: 2 }, (x) => {
    for (const p of x.all) p.map(s.port, wall.port);
  });
  const r = await b.fetch(s.url + '/buy', s.url + '/', {
    method: 'POST',
    body: 'item=1',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.status, 503, 'the first answer stands');
  assert.equal(wall.hits.length, 1, 'one exit, one attempt');
  assert.equal(s.hits.length, 0, 'and no second submission over a direct connection');

  // If the exit is dead before anything was sent, moving on is safe.
  for (const p of w.all) await p.close();
  net.dropAgents();
  const again = await b.fetch(s.url + '/buy', s.url + '/', {
    method: 'POST',
    body: 'item=2',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.text, 'order placed');
  assert.equal(s.hits.length, 1, 'delivered exactly once');
  assert.equal(s.hits[0].body, 'item=2');
  await until(() => app.pool.summary().alive === 0, 5000);
});

test('pool actions from the settings panel: add by hand, rotate, speed test, clear', async () => {
  const w = await world();
  const s = await site({ '/': { body: PAGE } });
  const { b, app } = await start({ route: { mode: 'proxy', rotate: 'sticky' }, pool: { on: true, sources: [], judge: w.judgeUrl } });
  let r = (await b.api('pool', { action: 'add', text: `socks5://127.0.0.1:${w.s5.port}\n127.0.0.1:${w.h.port}\nrubbish`, proto: '' })).json;
  assert.equal(r.added, 2);
  r = (await b.api('pool', { action: 'add', text: '127.0.0.1:' + w.s4.port, proto: 'socks4' })).json;
  assert.equal(r.added, 1);
  await until(() => app.pool.summary().alive === 3, 8000);
  const st = (await b.api('state')).json.pool;
  assert.equal(st.alive, 3);
  assert.deepEqual(st.countries, { US: 1, DE: 1, JP: 1 });
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
  assert.equal(r.results.length, 4);
  assert.equal(r.results[0].via, 'direct');
  for (const row of r.results) {
    assert.equal(row.status, 200);
    assert.ok(row.ms >= 0 && row.ms < 2000);
  }
  assert.equal((await b.api('pool', { action: 'speed', url: 'file:///etc/passwd' })).status, 400);

  r = (await b.api('pool', { action: 'clear' })).json;
  assert.equal(r.pool.alive, 0);
  assert.equal(r.pool.found, 0);
  void sleep;
});
