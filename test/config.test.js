'use strict';
require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const c = require('../lib/config');

test('defaults are complete and self-consistent', () => {
  const cfg = new c.Config();
  assert.deepEqual(Object.keys(cfg.value), ['route', 'dns', 'pool', 'spoof', 'ui']);
  assert.equal(cfg.value.route.mode, 'auto');
  assert.equal(cfg.value.route.hops, 1);
  assert.equal(cfg.value.dns.mode, 'doh');
  assert.ok(cfg.value.dns.servers.length >= 2, 'a stack, not a single resolver');
  assert.ok(cfg.value.pool.sources.length >= 20);
  for (const s of cfg.value.pool.sources) assert.deepEqual(c.cleanSource(s), s, 'default source is already clean: ' + JSON.stringify(s));
  assert.ok(cfg.value.ui.search.includes('%s'));
});

test('patch: bad values are clamped or ignored, never stored', () => {
  const cfg = new c.Config();
  cfg.patch({
    route: {
      hops: 9,
      retries: -3,
      mode: 'bogus',
      rotate: 'request',
      timeout: 1,
      protocols: ['http', 'nope'],
      countries: ['us', 'DEU', 'd'],
    },
    pool: { target: 100000, concurrency: 0, on: 'yes' },
    spoof: { theme: 'purple', screen: '100x100', system: 'nope', languages: 5, canvas: 'block' },
    dns: { strategy: 'weird', servers: ['cloudflare', 'https://dns.example/dns-query', 'ftp://x', 'quad9', 'quad9'] },
    junk: { nested: true },
    __proto__: { polluted: true },
  });
  const v = cfg.value;
  assert.equal(v.route.hops, 3);
  assert.equal(v.route.retries, 0);
  assert.equal(v.route.mode, 'auto');
  assert.equal(v.route.rotate, 'request');
  assert.equal(v.route.timeout, 3000);
  assert.deepEqual(v.route.protocols, ['http']);
  assert.deepEqual(v.route.countries, ['US']);
  assert.equal(v.pool.target, 500);
  assert.equal(v.pool.concurrency, 1);
  assert.equal(v.pool.on, true);
  assert.equal(v.spoof.theme, 'real');
  assert.equal(v.spoof.screen, 'real');
  assert.equal(v.spoof.system, 'win-chrome');
  assert.equal(v.spoof.languages, 'en-US,en');
  assert.equal(v.spoof.canvas, 'block');
  assert.equal(v.dns.strategy, 'fallback');
  assert.deepEqual(v.dns.servers, [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.example/dns-query',
    'https://dns.quad9.net/dns-query',
  ]);
  assert.equal(v.junk, undefined);
  assert.equal({}.polluted, undefined);
  cfg.reset();
});

test('settings persist across restarts and reset restores defaults', () => {
  const a = new c.Config();
  a.patch({ route: { hops: 2 }, spoof: { theme: 'dark' } });
  const file = path.join(c.DATA_DIR, 'config.json');
  assert.ok(fs.existsSync(file));
  const b = new c.Config();
  assert.equal(b.value.route.hops, 2);
  assert.equal(b.value.spoof.theme, 'dark');
  let fired = 0;
  b.onChange(() => {
    fired++;
  });
  b.reset();
  assert.equal(fired, 1);
  assert.equal(b.value.route.hops, 1);
  assert.equal(new c.Config().value.spoof.theme, 'real');
});

test('a corrupt settings file is ignored, not fatal', () => {
  fs.writeFileSync(path.join(c.DATA_DIR, 'config.json'), '{"route": {"hops": 2'); // truncated write
  assert.equal(new c.Config().value.route.hops, 1);
  fs.writeFileSync(path.join(c.DATA_DIR, 'config.json'), '[1,2,3]');
  assert.equal(new c.Config().value.route.mode, 'auto');
  new c.Config().reset();
});

test('routing rules: syntax', () => {
  const ok = (text, want) => {
    const r = c.parseRule(text);
    assert.ok(r, text);
    assert.deepEqual({ pattern: r.pattern, via: r.via, countries: r.countries, hops: r.hops }, want);
  };
  ok('*.a.test direct', { pattern: '*.a.test', via: 'direct', countries: [], hops: 0 });
  ok('b.test proxy us,de hops=2', { pattern: 'b.test', via: 'proxy', countries: ['US', 'DE'], hops: 2 });
  ok('B.Test PROXY hops=2 US', { pattern: 'b.test', via: 'proxy', countries: ['US'], hops: 2 });
  ok('https://c.test/path block', { pattern: 'c.test', via: 'block', countries: [], hops: 0 });
  ok('y.test auto hops=7', { pattern: 'y.test', via: 'auto', countries: [], hops: 3 });
  for (const bad of [
    '',
    'nonsense',
    '*',
    'x.test',
    'x.test sideways',
    'x.test proxy USA',
    'x.test proxy hops=two',
    'a b c d e',
    'bad$pattern direct',
    'x'.repeat(200) + '.test direct',
  ])
    assert.equal(c.parseRule(bad), null, bad);
});

test('routing rules: first match wins; a plain name covers its subdomains', () => {
  const rules = ['*.a.test direct', 'b.test proxy US,DE hops=2', '*ads* block', 'ads.b.test direct'];
  const via = (host) => {
    const r = c.matchRule(rules, host);
    return r ? r.via : null;
  };
  assert.equal(via('x.a.test'), 'direct');
  assert.equal(via('a.test'), null, '*.a.test does not cover a.test itself');
  assert.equal(via('b.test'), 'proxy');
  assert.equal(via('www.b.test'), 'proxy');
  assert.equal(via('notb.test'), null, 'no partial-label matches');
  assert.equal(via('myads.net'), 'block');
  assert.equal(via('ads.b.test'), 'proxy', 'earlier rule wins');
  assert.equal(via('WWW.B.TEST'), 'proxy', 'case-insensitive');
  assert.equal(via('none.test'), null);
  assert.equal(c.matchRule([], 'x.test'), null);
});

test('response time: wildcard rules cannot be turned into a slow regex', () => {
  const rules = ['*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b block'];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) c.matchRule(rules, 'a'.repeat(253));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, '200 hostile matches took ' + ms.toFixed(0) + ' ms');
});

test('proxy sources: everything someone might paste', () => {
  const p = (t) => c.parseSource(t, null);
  assert.deepEqual(p('TheSpeedX/PROXY-List'), { type: 'github', repo: 'TheSpeedX/PROXY-List', on: true });
  assert.deepEqual(p('https://github.com/monosans/proxy-list'), { type: 'github', repo: 'monosans/proxy-list', on: true });
  assert.deepEqual(p('github.com/a/b.git'), { type: 'github', repo: 'a/b', on: true });
  assert.deepEqual(p('https://github.com/a/b/tree/dev'), { type: 'github', repo: 'a/b', on: true, branch: 'dev' });
  assert.deepEqual(p('https://github.com/a/b/blob/main/http.txt'), { type: 'github', repo: 'a/b', on: true, branch: 'main' });
  assert.deepEqual(p('gitlab:group/sub/repo'), { type: 'gitlab', repo: 'group/sub/repo', on: true });
  assert.deepEqual(p('https://gitlab.com/g/sub/r/-/tree/main'), { type: 'gitlab', repo: 'g/sub/r', on: true, branch: 'main' });
  assert.deepEqual(p('https://example.com/list.txt'), { type: 'url', url: 'https://example.com/list.txt', proto: null, on: true });
  assert.deepEqual(
    p('spys.me/proxy.txt'),
    { type: 'url', url: 'https://spys.me/proxy.txt', proto: null, on: true },
    'a dotted first segment is a host, not a GitHub owner'
  );
  assert.deepEqual(c.parseSource('example.com/s.txt', 'socks5'), {
    type: 'url',
    url: 'https://example.com/s.txt',
    proto: 'socks5',
    on: true,
  });
  for (const bad of ['', 'not a source', 'word', 'ftp://x/y', 'javascript:alert(1)', 'x'.repeat(600)]) assert.equal(p(bad), null, bad);
});

test('DNS servers: presets by name, addresses, nothing else', () => {
  assert.equal(c.cleanDns('cloudflare'), 'https://cloudflare-dns.com/dns-query');
  assert.equal(c.cleanDns('Quad9'), 'https://dns.quad9.net/dns-query');
  assert.equal(c.cleanDns('dns.example'), 'https://dns.example/dns-query');
  assert.equal(c.cleanDns('https://x.example/custom'), 'https://x.example/custom');
  for (const bad of ['', 'ftp://x', 'a b', null]) assert.equal(c.cleanDns(bad), null, String(bad));
  assert.ok(c.options.dns.length >= 8, 'a good list of free resolvers to pick from');
  for (const d of c.options.dns) {
    assert.match(d.url, /^https:\/\//);
    assert.equal(c.cleanDns(d.id), d.url);
  }
});

test('screens', () => {
  assert.deepEqual(c.parseScreen('1920x1080@1'), { w: 1920, h: 1080, dpr: 1, aw: 1920, ah: 1040, iw: 1920, ih: 953, depth: 24 });
  const phone = c.parseScreen('390x844@3');
  assert.equal(phone.dpr, 3);
  assert.equal(phone.ah, 844, 'no taskbar on a phone');
  assert.ok(phone.ih < phone.h);
  for (const bad of ['real', 'junk', '99999x1@1', '0x0@1', '']) assert.equal(c.parseScreen(bad), null, bad);
  for (const s of c.options.screens) assert.ok(c.parseScreen(s), s);
});

test('identities: every preset is coherent from headers to navigator', () => {
  const base = JSON.parse(JSON.stringify(c.DEFAULTS.spoof));
  for (const { id } of c.options.systems) {
    const { page, headers } = c.resolveSpoof(Object.assign({}, base, { system: id }), 'seed');
    const n = page.nav;
    assert.equal(headers['user-agent'], n.ua, id);
    if (n.engine === 'gecko') assert.match(n.appVersion, /^5\.0 \((Windows|X11|Macintosh)\)$/, id + ': Firefox keeps appVersion short');
    else assert.equal(n.appVersion, n.ua.replace(/^Mozilla\//, ''), id);
    if (n.engine === 'chromium') {
      assert.match(n.ua, /Chrome\/\d+\.0\.0\.0/, id);
      assert.equal(n.vendor, 'Google Inc.', id);
      assert.ok(n.uaData && headers['sec-ch-ua'], id);
      const major = /Chrome\/(\d+)/.exec(n.ua)[1];
      assert.ok(headers['sec-ch-ua'].includes('v="' + major + '"'), id + ': client hints carry the UA version');
      assert.equal(headers['sec-ch-ua-platform'], '"' + n.uaData.platform + '"', id);
      assert.equal(headers['sec-ch-ua-mobile'], n.mobile ? '?1' : '?0', id);
    } else {
      assert.equal(n.uaData, undefined, id + ': only Chromium has userAgentData');
      assert.equal(headers['sec-ch-ua'], null, id + ': and only Chromium sends client hints');
      assert.equal(n.vendor, n.engine === 'gecko' ? '' : 'Apple Computer, Inc.', id);
    }
    if (/^win-/.test(id)) {
      assert.equal(n.platform, 'Win32', id);
      assert.match(n.ua, /Windows NT 10\.0/, id);
    }
    if (/^mac-/.test(id)) {
      assert.equal(n.platform, 'MacIntel', id);
      assert.match(n.ua, /Macintosh/, id);
    }
    if (/^linux-/.test(id)) {
      assert.match(n.platform, /^Linux/, id);
      assert.match(n.ua, /Linux/, id);
    }
    if (/^(android|iphone)-/.test(id)) {
      assert.equal(n.mobile, true, id);
      assert.ok(n.touch > 0, id);
    } else {
      assert.equal(n.mobile, false, id);
      assert.equal(n.touch, 0, id);
    }
    assert.ok(n.gl && n.gl.length === 2 && n.gl[1].length > 5, id + ': a GPU that fits');
    assert.ok(n.cores >= 2, id);
  }
});

test('identities: browser versions follow the calendar instead of going stale', () => {
  const base = Object.assign(JSON.parse(JSON.stringify(c.DEFAULTS.spoof)), { system: 'win-chrome' });
  const major = (now) => Number(/Chrome\/(\d+)/.exec(c.resolveSpoof(base, 's', now).page.nav.ua)[1]);
  const y2026 = major(Date.UTC(2026, 0, 1)),
    y2027 = major(Date.UTC(2027, 0, 1));
  assert.ok(y2026 >= 143, 'Chrome ' + y2026);
  assert.ok(y2027 - y2026 >= 9 && y2027 - y2026 <= 14, 'about a dozen releases a year, got ' + (y2027 - y2026));
});

test('identities: random is stable per session; settings map through', () => {
  const base = JSON.parse(JSON.stringify(c.DEFAULTS.spoof));
  const pick = (seed) => c.resolveSpoof(Object.assign({}, base, { system: 'random' }), seed).page.nav.ua;
  assert.equal(pick('a'), pick('a'));
  assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(pick)).size > 1);
  assert.notEqual(c.resolveSpoof(base, 'a').page.seed, c.resolveSpoof(base, 'b').page.seed);

  const s = c.resolveSpoof(
    Object.assign({}, base, {
      languages: 'de-DE, de ,en',
      timezone: 'Asia/Tokyo',
      screen: '1366x768@1',
      viewport: 'screen',
      theme: 'dark',
      motion: 'reduce',
      network: '3g',
      saveData: true,
      dnt: true,
    }),
    'x'
  );
  assert.deepEqual(s.page.languages, ['de-DE', 'de', 'en']);
  assert.equal(s.headers['accept-language'], 'de-DE,de;q=0.9,en;q=0.8');
  assert.equal(s.page.tz, 'Asia/Tokyo');
  assert.equal(s.page.screen.w, 1366);
  assert.equal(s.page.viewport, true);
  assert.equal(s.page.theme, 'dark');
  assert.equal(s.page.motion, 'reduce');
  assert.equal(s.page.net.effectiveType, '3g');
  assert.equal(s.page.net.saveData, true);
  assert.equal(s.headers['save-data'], 'on');
  assert.equal(s.headers.dnt, '1');
  assert.equal(s.headers['sec-gpc'], '1');

  const real = c.resolveSpoof(Object.assign({}, base, { system: 'real', languages: '', screen: 'real' }), 'x');
  assert.equal(real.page.nav, null);
  assert.equal(real.page.languages, null);
  assert.equal(real.page.screen, null);
  assert.equal(real.headers['user-agent'], undefined, 'the real browser headers pass through');

  const custom = c.resolveSpoof(
    Object.assign({}, base, { system: 'custom', customUa: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }),
    'x'
  );
  assert.equal(custom.page.nav.engine, 'gecko');
  assert.equal(custom.page.nav.platform, 'Linux x86_64');
  assert.equal(custom.headers['sec-ch-ua'], null);

  assert.deepEqual(c.resolveSpoof(Object.assign({}, base, { on: false }), 'x'), { page: { on: false }, headers: {} });
});

test('client hints match what Chrome really sends', () => {
  // Captured from Chrome 131 on Windows.
  const ua = c
    .chromeBrands(131, 'Google Chrome')
    .map((b) => '"' + b.brand + '";v="' + b.version + '"')
    .join(', ');
  assert.equal(ua, '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
});
