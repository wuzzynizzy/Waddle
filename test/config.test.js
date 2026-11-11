'use strict';
require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const c = require('../lib/config');

test('defaults are complete and self-consistent', () => {
  const cfg = new c.Config();
  const v = cfg.value;
  assert.deepEqual(Object.keys(v), ['route', 'dns', 'pool', 'spoof', 'privacy', 'ui']);
  assert.equal(v.route.hops, 1);
  assert.equal(v.route.https, true, 'HTTPS only');
  assert.equal(v.dns.mode, 'auto');
  assert.ok(v.dns.servers.length >= 2, 'a stack, not a single resolver');
  assert.deepEqual([v.dns.pad, v.dns.auto], [true, true]);
  assert.ok(v.dns.feeds.length >= 2);
  assert.ok(v.pool.sources.length >= 30);
  for (const s of v.pool.sources) assert.deepEqual(c.cleanSource(s), s, 'default source is already clean: ' + JSON.stringify(s));
  assert.equal(new Set(v.pool.sources.map((s) => (s.repo || s.url).toLowerCase())).size, v.pool.sources.length, 'no source twice');
  assert.ok(v.pool.canaries.length >= 2);
  for (const line of v.pool.canaries) assert.ok(c.parseCanary(line), line);
  assert.match(v.pool.echo, /^http:\/\//, 'the header echo is asked over plain HTTP: that is where a proxy can add something');
  assert.match(v.pool.judge, /^https:\/\//);
  assert.ok(v.ui.search.includes('%s'));
  assert.equal(Object.hasOwn(v.ui, 'links'), false, 'the minimal start screen has no configured quick visits');
  // the private choice is the default one
  assert.deepEqual([v.privacy.cookies, v.privacy.trackers], ['first', true]);
  assert.deepEqual(
    [v.spoof.languages, v.spoof.timezone, v.spoof.geo, v.spoof.webrtc, v.spoof.referer],
    ['exit', 'exit', 'block', 'block', 'origin']
  );
  assert.deepEqual([v.ui.cloak, v.ui.panicKey], ['none', '']);
});

test('homepage theme is browser-local, not a server configuration setting', () => {
  const cfg = new c.Config();
  assert.equal(Object.hasOwn(cfg.value.ui, 'theme'), false);
  cfg.patch({ ui: { theme: 'midnight' } });
  assert.equal(Object.hasOwn(cfg.value.ui, 'theme'), false, 'legacy theme values are ignored');
});

test('there is no setting that lets a site be reached without a proxy', () => {
  const cfg = new c.Config();
  cfg.patch({ route: { mode: 'direct', direct: true, rules: ['a.test direct', 'b.test auto', 'c.test proxy'] }, dns: { mode: 'system' } });
  assert.equal(cfg.value.route.mode, undefined);
  assert.equal(cfg.value.route.direct, undefined);
  assert.deepEqual(cfg.value.route.rules, ['c.test proxy'], 'rules can choose a route or block a site; they cannot go around');
  assert.equal(cfg.value.dns.mode, 'auto', "and no lookup mode that asks this machine's own DNS about a site");
  assert.ok(!JSON.stringify(c.DEFAULTS).includes('direct'));
  cfg.reset();
});

test('patch: bad values are clamped or ignored, never stored', () => {
  const cfg = new c.Config();
  cfg.patch({
    route: {
      hops: 9,
      retries: -3,
      rotate: 'request',
      timeout: 1,
      minutes: 0,
      https: 'no',
      protocols: ['http', 'nope'],
      countries: ['us', 'DEU', 'd'],
      entry: ['de', 'xx1', 7],
    },
    pool: {
      target: 100000,
      concurrency: 0,
      on: 'yes',
      harvestMinutes: 1,
      echo: 'ftp://x/y',
      judge: 'not a url',
      canaries: ['https://secure.test/x ok', 'http://plain.test/x  the words ', 'http://nothing.test/', 'junk'],
    },
    spoof: {
      theme: 'purple',
      screen: '100x100',
      system: 'android-chrome',
      phone: 'win-chrome',
      languages: 5,
      canvas: 'block',
      random: 'always',
      gpu: '9',
    },
    dns: {
      strategy: 'weird',
      keep: 99,
      parallel: 1,
      refreshHours: 0,
      servers: ['cloudflare', 'https://dns.example/dns-query', 'ftp://x', 'quad9', 'quad9'],
    },
    privacy: { cookies: 'some', trackers: 'no' },
    ui: {
      theme: 'neon',
      cloak: 'bank',
      cloakTitle: 'x'.repeat(200),
      panicUrl: 'javascript:alert(1)',
      panicKey: 'k'.repeat(30),
      search: 'https://find.test/?q=',
      links: ['Docs https://docs.test/'],
    },
    junk: { nested: true },
    __proto__: { polluted: true },
  });
  const v = cfg.value;
  assert.equal(v.route.hops, 9);
  assert.equal(v.route.retries, 0);
  assert.equal(v.route.rotate, 'request');
  assert.equal(v.route.timeout, 3000);
  assert.equal(v.route.minutes, 1);
  assert.equal(v.route.https, true);
  assert.deepEqual(v.route.protocols, ['http']);
  assert.deepEqual(v.route.countries, ['US']);
  assert.deepEqual(v.route.entry, ['DE']);
  assert.equal(v.pool.target, 2000);
  assert.equal(v.pool.concurrency, 1);
  assert.equal(v.pool.on, true);
  assert.equal(v.pool.harvestMinutes, 5);
  assert.equal(v.pool.echo, c.DEFAULTS.pool.echo);
  assert.equal(v.pool.judge, c.DEFAULTS.pool.judge);
  assert.deepEqual(v.pool.canaries, ['http://plain.test/x  the words'], 'a canary is a plain-HTTP address and the text expected there');
  assert.equal(v.spoof.theme, 'real');
  assert.equal(v.spoof.screen, 'auto');
  assert.equal(v.spoof.system, 'win-chrome', 'a phone is not a computer identity');
  assert.equal(v.spoof.phone, 'auto', 'and a computer is not a phone identity');
  assert.equal(v.spoof.languages, 'exit');
  assert.equal(v.spoof.canvas, 'block');
  assert.equal(v.spoof.random, 'off');
  assert.equal(v.spoof.gpu, 'auto');
  assert.equal(v.dns.strategy, 'fallback');
  assert.deepEqual([v.dns.keep, v.dns.parallel, v.dns.refreshHours], [99, 2, 1]);
  assert.deepEqual(v.dns.servers, [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.example/dns-query',
    'https://dns.quad9.net/dns-query',
  ]);
  assert.deepEqual([v.privacy.cookies, v.privacy.trackers], ['first', true]);
  assert.deepEqual([v.ui.cloak, v.ui.panicUrl, v.ui.panicKey], ['none', '', '']);
  assert.equal(v.ui.cloakTitle.length, 80);
  assert.equal(v.ui.search, c.DEFAULTS.ui.search, 'a search address without a place for the words is no use');
  assert.equal(Object.hasOwn(v.ui, 'links'), false, 'legacy quick visit settings are ignored');
  assert.equal(v.junk, undefined);
  assert.equal({}.polluted, undefined);

  // and what is good is taken as written
  cfg.patch({
    spoof: {
      system: 'mac-safari',
      phone: 'iphone-safari',
      mobile: true,
      languages: 'de-DE, de ,en',
      timezone: 'Asia/Tokyo',
      random: 'site',
      gpu: '2',
    },
    privacy: { cookies: 'none', trackers: false },
    ui: { search: 'brave', cloak: 'docs', panicKey: 'Escape', panicUrl: 'https://classroom.test/', theme: 'dark' },
    pool: { echo: '' },
    dns: { mode: 'exit', strategy: 'split' },
  });
  assert.deepEqual(
    [v.spoof.system, v.spoof.phone, v.spoof.mobile, v.spoof.random, v.spoof.gpu],
    ['mac-safari', 'iphone-safari', true, 'site', '2']
  );
  assert.deepEqual([v.spoof.languages, v.spoof.timezone], ['de-DE, de ,en', 'Asia/Tokyo']);
  assert.deepEqual([v.privacy.cookies, v.privacy.trackers], ['none', false]);
  assert.equal(v.ui.search, 'https://search.brave.com/search?q=%s', 'a search engine can be named');
  assert.deepEqual([v.ui.cloak, v.ui.panicKey, v.ui.panicUrl], ['docs', 'Escape', 'https://classroom.test/']);
  assert.equal(Object.hasOwn(v.ui, 'theme'), false, 'an older server theme setting is ignored');
  assert.equal(v.pool.echo, '', 'emptied: that test is skipped');
  assert.deepEqual([v.dns.mode, v.dns.strategy], ['exit', 'split']);
  cfg.patch({ spoof: { languages: '', timezone: 'Mars/Olympus' } });
  assert.equal(v.spoof.languages, 'real', "emptied: the browser's own");
  assert.equal(v.spoof.timezone, 'Asia/Tokyo', 'a zone that does not exist is not stored');
  cfg.patch({ spoof: { languages: 'not a language list!' } });
  assert.equal(v.spoof.languages, 'real');
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
  assert.equal(new c.Config().value.dns.mode, 'auto');
  new c.Config().reset();
});

test('routing rules: syntax', () => {
  const ok = (text, want) => {
    const r = c.parseRule(text);
    assert.ok(r, text);
    assert.deepEqual({ pattern: r.pattern, via: r.via, countries: r.countries, hops: r.hops }, want);
  };
  ok('*.a.test block', { pattern: '*.a.test', via: 'block', countries: [], hops: 0 });
  ok('b.test proxy us,de hops=2', { pattern: 'b.test', via: 'proxy', countries: ['US', 'DE'], hops: 2 });
  ok('B.Test PROXY hops=2 US', { pattern: 'b.test', via: 'proxy', countries: ['US'], hops: 2 });
  ok('https://c.test/path block', { pattern: 'c.test', via: 'block', countries: [], hops: 0 });
  ok('y.test proxy hops=7', { pattern: 'y.test', via: 'proxy', countries: [], hops: 7 });
  ok('* proxy hops=3', { pattern: '*', via: 'proxy', countries: [], hops: 3 });
  for (const bad of [
    '',
    'nonsense',
    '*',
    'x.test',
    'x.test sideways',
    'x.test direct',
    'x.test auto',
    'x.test proxy USA',
    'x.test proxy hops=two',
    'a b c d e',
    'bad$pattern proxy',
    'x'.repeat(200) + '.test proxy',
  ])
    assert.equal(c.parseRule(bad), null, bad);
});

test('routing rules: first match wins; a plain name covers its subdomains', () => {
  const rules = ['*.a.test block', 'b.test proxy US,DE hops=2', '*ads* block', 'ads.b.test proxy'];
  const via = (host) => {
    const r = c.matchRule(rules, host);
    return r ? r.via : null;
  };
  assert.equal(via('x.a.test'), 'block');
  assert.equal(via('a.test'), null, '*.a.test does not cover a.test itself');
  assert.equal(via('b.test'), 'proxy');
  assert.equal(via('www.b.test'), 'proxy');
  assert.equal(via('notb.test'), null, 'no partial-label matches');
  assert.equal(via('myads.net'), 'block');
  assert.equal(via('ads.b.test'), 'proxy', 'earlier rule wins');
  assert.equal(via('WWW.B.TEST'), 'proxy', 'case-insensitive');
  assert.equal(via('none.test'), null);
  assert.equal(c.matchRule([], 'x.test'), null);
  assert.deepEqual(c.matchRule(rules, 'www.b.test').countries, ['US', 'DE']);
  assert.equal(c.matchRule(rules, 'www.b.test').hops, 2);
  assert.equal(c.matchRule(['* proxy hops=4'], 'anything.test').hops, 4, 'a lone * covers every site');
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

const BASE = () => JSON.parse(JSON.stringify(c.DEFAULTS.spoof));
/** The identity a set of settings gives: computers are picked with `system`, phones and tablets with `phone` in mobile mode. */
const identity = (id, extra, seed = 'seed', ctx) =>
  c.resolveSpoof(
    Object.assign(BASE(), c.SYSTEMS[id].kind === 'desktop' ? { system: id } : { mobile: true, phone: id }, extra),
    seed,
    Date.now(),
    ctx
  );

test('identities: every preset is coherent from headers to navigator', () => {
  assert.ok(c.options.systems.length >= 12);
  for (const { id, kind } of c.options.systems) {
    const { page, headers, info } = identity(id);
    const n = page.nav;
    assert.equal(n.id, id);
    assert.equal(headers['user-agent'], n.ua, id);
    if (n.engine === 'gecko')
      assert.match(n.appVersion, /^5\.0 \((Windows|X11|Macintosh|Android)\)$/, id + ': Firefox keeps appVersion short');
    else assert.equal(n.appVersion, n.ua.replace(/^Mozilla\//, ''), id);
    if (n.engine === 'chromium') {
      assert.match(n.ua, /Chrome\/\d+\.0\.0\.0/, id);
      assert.equal(n.vendor, 'Google Inc.', id);
      assert.ok(n.uaData && headers['sec-ch-ua'], id);
      const major = /Chrome\/(\d+)/.exec(n.ua)[1];
      assert.ok(headers['sec-ch-ua'].includes('v="' + major + '"'), id + ': client hints carry the UA version');
      assert.equal(headers['sec-ch-ua-platform'], '"' + n.uaData.platform + '"', id);
      assert.equal(headers['sec-ch-ua-mobile'], n.mobile ? '?1' : '?0', id);
      assert.ok(n.memory >= 2, id + ': Chromium reports memory');
    } else {
      assert.equal(n.uaData, undefined, id + ': only Chromium has userAgentData');
      assert.equal(headers['sec-ch-ua'], null, id + ': and only Chromium sends client hints');
      assert.equal(n.vendor, n.engine === 'gecko' ? '' : 'Apple Computer, Inc.', id);
      assert.equal(n.memory, undefined, id + ': and only Chromium reports memory');
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
    if (id === 'chromeos-chrome') assert.match(n.ua, /CrOS/, id);
    if (kind === 'phone') {
      assert.equal(n.mobile, true, id);
      assert.ok(n.touch > 0, id);
      assert.match(n.ua, /Mobile/, id);
      assert.ok(page.screen && page.screen.w < 600, id + ': a phone-sized screen comes with a phone');
      assert.equal(page.viewport, true, id + ': and the page is laid out for it');
    } else if (kind === 'tablet') {
      assert.equal(n.mobile, false, id + ': an iPad asks for desktop pages');
      assert.equal(n.platform, 'MacIntel', id);
      assert.ok(n.touch > 0, id + ': and gives itself away by touch');
      assert.ok(page.screen && page.screen.w >= 600, id);
    } else {
      assert.equal(n.mobile, false, id);
      assert.equal(n.touch, 0, id);
      assert.equal(page.screen, null, id + ': a computer keeps the real screen unless told otherwise');
      assert.equal(page.viewport, false, id);
    }
    assert.ok(n.gl && n.gl.length === 2 && n.gl[1].length > 5, id + ': a GPU that fits');
    assert.ok(
      c.SYSTEMS[id].gpus.some((g) => g[1] === n.gl[1]),
      id + ': one that system ships with'
    );
    assert.ok(n.cores >= 2, id);
    assert.deepEqual([info.on, info.id, info.label, info.engine, info.mobile], [true, id, c.SYSTEMS[id].label, n.engine, n.mobile], id);
    assert.ok(info.gpu, id + ': the panel can name the graphics card');
    // plugins: Chrome on Android has none; everything else lists the PDF viewer
    assert.equal(page.plugins, id.startsWith('android-') ? 'none' : 'pdf', id);
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

test('identities: settings map through', () => {
  const base = BASE();
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
      cores: '4',
      memory: '2',
      gpu: '2',
      touch: 'on',
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
  assert.deepEqual([s.page.nav.cores, s.page.nav.memory, s.page.nav.touch], [4, 2, 10]);
  assert.equal(s.page.nav.gl[1], c.SYSTEMS['win-chrome'].gpus[2][1], 'the third card that system ships with');
  assert.deepEqual([s.info.cores, s.info.gpu, s.info.screen, s.info.tz], [4, 'Intel Iris Xe', '1366 × 768', 'Asia/Tokyo']);
  assert.equal(identity('mac-safari', { gpu: '4' }).page.nav.gl[1], 'Apple GPU', 'a choice past the end of the list is the last one');
  assert.equal(identity('iphone-safari', { touch: 'off' }).page.nav.touch, 0);
  assert.equal(identity('win-firefox', { memory: '2' }).page.nav.memory, undefined, 'Firefox has no deviceMemory to set');

  const quiet = c.resolveSpoof(Object.assign({}, base, { dnt: false }), 'x');
  assert.equal(quiet.headers.dnt, undefined);
  assert.equal(quiet.headers['sec-gpc'], undefined);
  assert.equal(quiet.page.net, null);

  const real = c.resolveSpoof(
    Object.assign({}, base, { system: 'real', languages: 'real', timezone: 'real', screen: 'real', geo: 'real' }),
    'x'
  );
  assert.equal(real.page.nav, null);
  assert.equal(real.page.languages, null);
  assert.equal(real.page.tz, null);
  assert.equal(real.page.screen, null);
  assert.equal(real.page.geo, null);
  assert.equal(real.headers['user-agent'], undefined, 'the real browser headers pass through');
  assert.equal(real.headers['accept-language'], undefined);
  assert.deepEqual([real.info.id, real.info.label], ['real', 'Real browser']);

  const custom = c.resolveSpoof(
    Object.assign({}, base, { system: 'custom', customUa: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }),
    'x'
  );
  assert.equal(custom.page.nav.engine, 'gecko');
  assert.equal(custom.page.nav.platform, 'Linux x86_64');
  assert.equal(custom.headers['sec-ch-ua'], null);
  assert.deepEqual([custom.info.id, custom.info.label, custom.info.detectable], ['custom', 'Custom', true]);
  const phone = c.resolveSpoof(
    Object.assign({}, base, {
      system: 'custom',
      customUa: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    }),
    'x'
  );
  assert.deepEqual(
    [phone.page.nav.platform, phone.page.nav.mobile, phone.page.nav.touch, phone.page.nav.family],
    ['iPhone', true, 5, 'ios']
  );
  assert.equal(
    c.resolveSpoof(
      Object.assign({}, base, { system: 'custom', customUa: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0.0.0', customPlatform: 'Win64' }),
      'x'
    ).page.nav.platform,
    'Win64'
  );
  assert.equal(
    c.resolveSpoof(Object.assign({}, base, { system: 'custom', customUa: '  ' }), 'x').page.nav,
    null,
    'custom with nothing typed: the real one'
  );

  assert.deepEqual(c.resolveSpoof(Object.assign({}, base, { on: false }), 'x'), { page: { on: false }, headers: {}, info: { on: false } });
});

test('identities: language, clock and position follow the country the connection leaves from', () => {
  const at = (cc, colo, extra) => c.resolveSpoof(Object.assign(BASE(), extra), 'seed', Date.now(), { cc, colo });
  const de = at('DE');
  assert.deepEqual(de.page.languages, ['de-DE', 'de', 'en-US', 'en']);
  assert.equal(de.headers['accept-language'], 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.equal(de.page.tz, 'Europe/Berlin');
  assert.deepEqual([de.info.cc, de.info.tz], ['DE', 'Europe/Berlin']);
  assert.deepEqual(at('JP').page.languages, ['ja-JP', 'ja', 'en-US', 'en']);
  assert.deepEqual(at('GB').page.languages, ['en-GB', 'en']);
  assert.equal(at('gb').page.tz, 'Europe/London');
  assert.equal(at('US').page.tz, 'America/New_York', 'a large country: where most of its people live');
  assert.equal(at('US', 'LAX').page.tz, 'America/Los_Angeles', 'unless the exit is known to sit on the other coast');
  assert.equal(at('US', 'ORD').page.tz, 'America/Chicago');
  assert.equal(at('AU', 'PER').page.tz, 'Australia/Perth');
  assert.equal(at('DE', 'LAX').page.tz, 'Europe/Berlin', 'a data centre code only counts in a country with several zones');

  // nothing known about the exit: the most common answers, never the real ones
  for (const none of [at(''), at('ZZ'), at(undefined)]) {
    assert.deepEqual(none.page.languages, ['en-US', 'en']);
    assert.equal(none.page.tz, 'UTC');
    assert.equal(none.info.cc, '');
  }

  // set by hand: the exit no longer matters
  const fixed = at('DE', '', { languages: 'fr-FR,fr', timezone: 'America/Chicago' });
  assert.deepEqual([fixed.page.languages, fixed.page.tz], [['fr-FR', 'fr'], 'America/Chicago']);
  const own = at('DE', '', { languages: 'real', timezone: 'real' });
  assert.deepEqual([own.page.languages, own.page.tz, own.headers['accept-language']], [null, null, undefined]);

  // position
  assert.deepEqual(at('DE').page.geo, { deny: true }, 'refused unless asked for');
  assert.equal(at('DE', '', { geo: 'real' }).page.geo, null);
  const spot = at('DE', '', { geo: 'exit' }).page.geo;
  assert.ok(Math.abs(spot.lat - 52.52) < 0.07 && Math.abs(spot.lon - 13.4) < 0.07, 'near Berlin: ' + JSON.stringify(spot));
  assert.ok(spot.acc >= 1200 && spot.acc < 3600);
  assert.deepEqual(at('DE', '', { geo: 'exit' }).page.geo, spot, 'the same spot every time for one session');
  assert.notDeepEqual(
    c.resolveSpoof(Object.assign(BASE(), { geo: 'exit' }), 'other', Date.now(), { cc: 'DE' }).page.geo,
    spot,
    'another session, another spot'
  );
  const west = at('US', 'LAX', { geo: 'exit' }).page.geo;
  assert.ok(
    Math.abs(west.lat - 34.05) < 0.07 && Math.abs(west.lon + 118.24) < 0.07,
    'the position agrees with the clock: ' + JSON.stringify(west)
  );
  assert.deepEqual(at('', '', { geo: 'exit' }).page.geo, { deny: true }, 'no known country: no made-up position');
});

test('identities: the randomiser gives a whole new identity per session, per site or by the clock', () => {
  const spoof = (extra) => Object.assign(BASE(), extra);
  const id = (r) => [r.page.nav.id, r.page.nav.cores, r.page.nav.gl[1], r.page.screen && r.page.screen.w, r.page.seed].join('|');
  const pick = (extra, seed, now, ctx) => c.resolveSpoof(spoof(extra), seed, now || 1e12, ctx);
  const seeds = Array.from({ length: 60 }, (_, i) => 'seed' + i);

  // off: the chosen system, and nothing about the hardware varies
  assert.equal(new Set(seeds.map((s) => pick({}, s).page.nav.id)).size, 1);
  assert.equal(new Set(seeds.map((s) => pick({}, s).page.nav.gl[1])).size, 1);
  assert.equal(new Set(seeds.map((s) => pick({}, s).page.seed)).size, seeds.length, 'the noise seed still differs per session');

  // per session
  assert.equal(id(pick({ random: 'session' }, 'a')), id(pick({ random: 'session' }, 'a')));
  assert.equal(
    id(pick({ random: 'session' }, 'a', 1e12, { site: 'x.test' })),
    id(pick({ random: 'session' }, 'a', 2e12, { site: 'y.test' })),
    'the same on every site, all session long'
  );
  const kinds = new Set(seeds.map((s) => pick({ random: 'session' }, s).page.nav.id));
  assert.ok(kinds.size >= 4, 'several systems turn up: ' + [...kinds]);
  for (const k of kinds) assert.equal(c.SYSTEMS[k].kind, 'desktop', k + ': computers only, outside mobile mode');
  const count = seeds.filter((s) => pick({ random: 'session' }, s).page.nav.id === 'win-chrome').length;
  assert.ok(count > seeds.length / 5, 'the common ones turn up more often (Windows Chrome: ' + count + ' of ' + seeds.length + ')');

  // every part of a random identity comes from the same real machine
  for (const s of seeds) {
    const r = pick({ random: 'session' }, s);
    const sys = c.SYSTEMS[r.page.nav.id];
    assert.ok(
      sys.screens.includes(r.page.screen.w + 'x' + r.page.screen.h + '@' + r.page.screen.dpr),
      r.page.nav.id + ' with ' + JSON.stringify(r.page.screen)
    );
    assert.ok(sys.coreChoices.includes(r.page.nav.cores), r.page.nav.id + ' with ' + r.page.nav.cores + ' cores');
    assert.ok(
      sys.gpus.some((g) => g[1] === r.page.nav.gl[1]),
      r.page.nav.id + ' with ' + r.page.nav.gl[1]
    );
    assert.equal(r.headers['user-agent'], r.page.nav.ua);
  }

  // per site
  const sites = Array.from({ length: 40 }, (_, i) => 'site' + i + '.test');
  assert.equal(
    id(pick({ random: 'site' }, 'a', 1e12, { site: 'x.test' })),
    id(pick({ random: 'site' }, 'a', 2e12, { site: 'x.test' })),
    'one site always meets the same visitor'
  );
  assert.ok(
    new Set(sites.map((site) => id(pick({ random: 'site' }, 'a', 1e12, { site })))).size > 30,
    'and different sites meet different ones'
  );

  // by the clock
  const t0 = 1e12 - (1e12 % (30 * 60000));
  assert.equal(id(pick({ random: 'timer' }, 'a', t0)), id(pick({ random: 'timer' }, 'a', t0 + 29 * 60000)));
  assert.ok(
    new Set(Array.from({ length: 40 }, (_, i) => id(pick({ random: 'timer' }, 'a', t0 + i * 30 * 60000)))).size > 30,
    'a new one every half hour'
  );
  assert.equal(
    id(pick({ random: 'timer', randomMinutes: 5 }, 'a', t0)),
    id(pick({ random: 'timer', randomMinutes: 5 }, 'a', t0 + 4 * 60000))
  );
  assert.notEqual(
    id(pick({ random: 'timer', randomMinutes: 5 }, 'a', t0)),
    id(pick({ random: 'timer', randomMinutes: 5 }, 'a', t0 + 5 * 60000))
  );

  // kept to what the real browser can pass for
  for (const engine of ['chromium', 'gecko', 'webkit']) {
    const got = new Set(seeds.map((s) => pick({ random: 'session' }, s, 1e12, { real: { engine } }).page.nav.engine));
    assert.deepEqual([...got], [engine], 'a ' + engine + ' browser is only ever given ' + engine + ' identities');
    assert.ok(seeds.every((s) => pick({ random: 'session' }, s, 1e12, { real: { engine } }).info.detectable === false));
  }
  const free = new Set(seeds.map((s) => pick({ random: 'session', match: false }, s, 1e12, { real: { engine: 'gecko' } }).page.nav.engine));
  assert.ok(free.size > 1, 'with matching off, anything goes');
  assert.ok(
    seeds.some((s) => pick({ random: 'session', match: false }, s, 1e12, { real: { engine: 'gecko' } }).info.detectable),
    'and the panel says so'
  );

  // mobile mode: phones only
  const phones = new Set(seeds.map((s) => pick({ random: 'session', mobile: true }, s).page.nav.id));
  assert.ok(phones.size >= 2, [...phones].join());
  for (const k of phones) assert.equal(c.SYSTEMS[k].kind, 'phone', k);
});

test('identities: mobile mode picks the phone this browser can pass for', () => {
  const phone = (real, extra) => c.resolveSpoof(Object.assign(BASE(), { mobile: true }, extra), 's', Date.now(), { real }).page.nav.id;
  assert.equal(phone({ engine: 'chromium' }), 'android-chrome');
  assert.equal(phone({ engine: 'webkit' }), 'iphone-safari');
  assert.equal(phone({ engine: 'gecko' }), 'android-firefox');
  assert.equal(phone(null), 'android-chrome');
  assert.equal(phone({ engine: 'chromium' }, { phone: 'iphone-safari' }), 'iphone-safari', 'or the one that was chosen');
  assert.equal(phone({ engine: 'chromium' }, { phone: 'ipad-safari' }), 'ipad-safari');
  const r = c.resolveSpoof(Object.assign(BASE(), { mobile: true, phone: 'iphone-safari' }), 's', Date.now(), {
    real: { engine: 'chromium' },
  });
  assert.equal(r.info.detectable, true, 'Safari claimed from Chrome: a site that looks closely can tell');
  assert.deepEqual([r.page.screen.w, r.page.screen.h, r.page.screen.dpr], [390, 844, 3]);
  assert.equal(
    c.resolveSpoof(Object.assign(BASE(), { mobile: true, screen: '1920x1080@1' }), 's').page.screen.w,
    1920,
    'a screen set by hand wins'
  );

  // what this browser really is, read from its own User-Agent (never sent anywhere)
  const real = c.realBrowser;
  assert.deepEqual(
    real('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'),
    { engine: 'chromium', mobile: false }
  );
  assert.deepEqual(
    real('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'),
    { engine: 'chromium', mobile: false }
  );
  assert.deepEqual(real('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), { engine: 'gecko', mobile: false });
  assert.deepEqual(
    real('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'),
    { engine: 'webkit', mobile: false }
  );
  assert.deepEqual(
    real('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36'),
    { engine: 'chromium', mobile: true }
  );
  assert.deepEqual(
    real(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0.0.0 Mobile/15E148 Safari/604.1'
    ),
    { engine: 'webkit', mobile: true },
    'every browser on an iPhone is Safari underneath'
  );
  assert.deepEqual(
    real(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15'
    ),
    { engine: 'webkit', mobile: true }
  );
  for (const none of ['', undefined, 'curl/8.5.0', 'Waddle']) assert.equal(real(none), null, String(none));
});

test('identities: voices, battery, plugins and devices are those of an ordinary machine', () => {
  const win = identity('win-chrome').page;
  assert.equal(win.voices[0][0], 'Microsoft David - English (United States)');
  assert.ok(
    win.voices.some((v) => v[0] === 'Google US English' && v[2] === 0),
    'Chrome on a computer adds its network voices'
  );
  assert.ok(!identity('win-firefox').page.voices.some((v) => /^Google/.test(v[0])), 'Firefox does not');
  assert.equal(identity('mac-safari').page.voices[0][0], 'Samantha');
  assert.ok(!identity('android-chrome').page.voices.some((v) => /^Google /.test(v[0])), 'nor Chrome on a phone');
  assert.deepEqual(identity('win-chrome', { voices: 'none' }).page.voices, []);
  assert.equal(identity('win-chrome', { voices: 'real' }).page.voices, null);

  assert.deepEqual(win.battery, { charging: true, level: 1 }, 'plugged in and full: what most computers report');
  assert.equal(identity('win-chrome', { battery: 'real' }).page.battery, null);
  const levels = new Set();
  for (let i = 0; i < 40; i++) {
    const b = identity('win-chrome', { battery: 'random' }, 'seed' + i).page.battery;
    assert.ok(b.level >= 0.2 && b.level <= 0.95 && typeof b.charging === 'boolean', JSON.stringify(b));
    levels.add(b.level);
  }
  assert.ok(levels.size > 10);
  assert.deepEqual(
    identity('win-chrome', { battery: 'random' }, 'k').page.battery,
    identity('win-chrome', { battery: 'random' }, 'k').page.battery,
    'steady within a session'
  );

  assert.equal(win.plugins, 'pdf');
  assert.equal(identity('win-chrome', { plugins: 'none' }).page.plugins, 'none');
  assert.equal(identity('win-chrome', { plugins: 'real' }).page.plugins, null);
  assert.equal(win.media, 'generic');
  assert.equal(identity('win-chrome', { media: 'none' }).page.media, 'none');
  assert.equal(identity('win-chrome', { media: 'real' }).page.media, null);
  assert.deepEqual(
    [win.webrtc, win.canvas, win.webgl, win.audio, win.rects, win.fonts],
    ['block', 'noise', 'spoof', 'noise', 'real', 'real']
  );
});

test('canary pages: syntax', () => {
  assert.deepEqual(c.parseCanary('http://a.test/ok.txt success'), { url: 'http://a.test/ok.txt', expect: 'success' });
  assert.deepEqual(c.parseCanary('  http://a.test/x   <b>two  words</b> '), { url: 'http://a.test/x', expect: '<b>two  words</b>' });
  for (const bad of [
    '',
    'http://a.test/x',
    'https://a.test/x ok',
    'ftp://a.test/x ok',
    'nothing here',
    'http://a.test/x ' + 'y'.repeat(600),
  ])
    assert.equal(c.parseCanary(bad), null, bad.slice(0, 40));
});

test('what the settings panel is offered', () => {
  const o = c.options;
  assert.equal(o.maxHops, 16);
  assert.equal(c.MAX_HOPS, 16);
  assert.equal(o.maxDnsServers, 64);
  assert.equal(o.maxSources, 2000);
  for (const s of o.systems) {
    assert.ok(s.label && ['desktop', 'phone', 'tablet'].includes(s.kind) && ['chromium', 'gecko', 'webkit'].includes(s.engine), s.id);
    assert.ok(s.gpus.length >= 1 && s.gpus.every((g) => typeof g === 'string' && g), s.id);
  }
  assert.ok(o.countries.length >= 100);
  for (const [cc, name] of o.countries) assert.ok(/^[A-Z]{2}$/.test(cc) && name, cc);
  for (const s of o.search) assert.ok(s.id && s.label && s.url.includes('%s'), s.id);
  assert.ok(o.networks.includes('4g'));
  assert.ok(Object.keys(c.DNS_BOOTSTRAP).length >= 8, 'the stock resolvers come with their addresses, so nobody is asked where they live');
  for (const [host, ip] of Object.entries(c.DNS_BOOTSTRAP)) assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, host);
});

test('resolver stacks, source lists and proxy chains have large validated limits', () => {
  const cfg = new c.Config();
  cfg.patch({
    route: { hops: 99, rules: ['deep.example proxy hops=99'] },
    dns: {
      parallel: 99,
      keep: 999,
      servers: Array.from({ length: 70 }, (_, i) => 'https://resolver' + i + '.example/dns-query'),
    },
    pool: {
      target: 5000,
      concurrency: 900,
      sources: Array.from({ length: 2010 }, (_, i) => ({ type: 'github', repo: 'owner' + i + '/proxy-list', on: true })),
    },
  });
  assert.equal(cfg.value.route.hops, 16);
  assert.equal(c.matchRule(cfg.value.route.rules, 'deep.example').hops, 16);
  assert.equal(cfg.value.dns.parallel, 16);
  assert.equal(cfg.value.dns.keep, 128);
  assert.equal(cfg.value.dns.servers.length, 64);
  assert.equal(cfg.value.pool.target, 2000);
  assert.equal(cfg.value.pool.concurrency, 400);
  assert.equal(cfg.value.pool.sources.length, 2000);
  cfg.reset();
});

test('the small-server profile lowers background-work defaults', () => {
  const run = spawnSync(
    process.execPath,
    [
      '-e',
      "const c=require('./lib/config');const x=new c.Config();console.log(JSON.stringify({profile:c.options.profile,target:x.value.pool.target,concurrency:x.value.pool.concurrency,perSource:x.value.pool.perSource}));",
    ],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: Object.assign({}, process.env, { WADDLE_PROFILE: 'small', WADDLE_DATA: path.join(c.DATA_DIR, 'small-profile') }),
    }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { profile: 'small', target: 24, concurrency: 12, perSource: 2500 });
});

test('client hints match what Chrome really sends', () => {
  // Captured from Chrome 131 on Windows.
  const ua = c
    .chromeBrands(131, 'Google Chrome')
    .map((b) => '"' + b.brand + '";v="' + b.version + '"')
    .join(', ');
  assert.equal(ua, '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
});
