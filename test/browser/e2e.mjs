// Browser end-to-end check: a real Chrome drives the real server against a local fixture site.
//
// Waddle itself has no dependencies, so this script is not part of `npm test`. To run it:
//
//   npm install --no-save puppeteer-core
//   CHROME=/path/to/chrome npm run test:browser
//
// Without CHROME it looks for Chrome, Chromium or Edge in the usual places, then for the
// self-contained build from `@sparticuz/chromium` if that package is installed.
//
//   LIVE=1        also browse pypi.org through Waddle (needs the internet)
//   SHOTS=<dir>   save screenshots there
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lookIn = [createRequire(path.join(root, 'package.json')), createRequire(path.join(process.cwd(), 'package.json'))];
function load(name) {
  for (const r of lookIn) {
    try {
      const m = r(name);
      return m && m.default ? m.default : m;
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    }
  }
  return null;
}
function stop(why) {
  console.error(why + '\n\nSee docs/testing.md for the setup.');
  process.exit(2);
}

const puppeteer = load('puppeteer-core');
if (!puppeteer) stop('puppeteer-core is not installed. Run: npm install --no-save puppeteer-core');

const chrome = { path: process.env.CHROME || '', args: [], shell: false };
if (!chrome.path) {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const onPath = (process.env.PATH || '').split(path.delimiter).flatMap((d) => names.map((n) => path.join(d, n)));
  chrome.path =
    onPath.concat(fixed).find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || '';
}
if (!chrome.path) {
  const pack = load('@sparticuz/chromium');
  if (pack) {
    chrome.path = await pack.executablePath();
    chrome.args = pack.args;
    chrome.shell = true;
  }
}
if (!chrome.path) stop('No Chrome found. Set CHROME=/path/to/chrome, or run: npm install --no-save @sparticuz/chromium');
if (/headless[-_]shell/i.test(chrome.path)) chrome.shell = true;

const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waddle-e2e-'));
process.env.WADDLE_ALLOW_PRIVATE = '1'; // the fixture site lives on 127.0.0.1
process.env.WADDLE_DATA = dataDir;
const { createApp } = require(path.join(root, 'server.js'));
const LIVE = process.env.LIVE === '1';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail) : ''));
};

// ---- fixture site -----------------------------------------------------------------
const seen = [];
const site = http.createServer((req, res) => {
  seen.push({ url: req.url, method: req.method, headers: req.headers });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'pref=blue; Path=/'],
      'Content-Security-Policy': "default-src 'none'",
      'X-Frame-Options': 'DENY',
    });
    return res.end(`<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/style.css">
<style>@media (prefers-color-scheme: dark){ body{ --scheme: dark } } @media (prefers-color-scheme: light){ body{ --scheme: light } }</style></head>
<body><h1 id="h">Fixture</h1><a id="link" href="/page2?x=1">next</a><img id="img" src="/pixel.png">
<form id="f" action="/echo" method="post"><input name="a" value="1"></form>
<script src="/app.js"></script></body></html>`);
  }
  if (u.pathname === '/style.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end('h1{background:url(/bg.png)} @import "/more.css";');
  }
  if (u.pathname === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('window.appLoaded = true;');
  }
  if (u.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fromxhr=1; Path=/' });
    return res.end(
      JSON.stringify({
        ok: true,
        cookie: req.headers.cookie || '',
        ua: req.headers['user-agent'],
        lang: req.headers['accept-language'],
        origin: req.headers.origin || null,
        referer: req.headers.referer || null,
        chua: req.headers['sec-ch-ua'] || null,
        dnt: req.headers.dnt || null,
        xff: req.headers['x-forwarded-for'] || null,
      })
    );
  }
  if (u.pathname === '/echo') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Echo</title><pre id="out">' + req.method + ' ' + b + '</pre>');
    });
    return;
  }
  if (u.pathname === '/page2') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<title>Page 2</title><p id="p2">two ' + u.search + '</p><script>document.cookie="js=1; path=/";</script>');
  }
  if (u.pathname === '/redir') {
    res.writeHead(302, { Location: '/page2?from=redir' });
    return res.end();
  }
  if (u.pathname === '/pixel.png' || u.pathname === '/bg.png' || u.pathname === '/stray.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    );
  }
  if (u.pathname === '/more.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end('p{color:red}');
  }
  res.writeHead(404);
  res.end('nope');
});
// minimal RFC 6455 echo so the WebSocket relay can be exercised without dependencies
site.on('upgrade', (req, socket) => {
  seen.push({ url: req.url, method: 'WS', headers: req.headers });
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.on('data', (buf) => {
    const len = buf[1] & 127;
    const mask = buf.subarray(2, 6);
    const data = Buffer.from(buf.subarray(6, 6 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if ((buf[0] & 15) === 1) socket.write(Buffer.concat([Buffer.from([0x81, data.length + 5]), Buffer.from('echo:'), data]));
  });
  socket.on('error', () => {});
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = 'http://127.0.0.1:' + site.address().port;

const app = createApp();
app.config.patch({
  pool: { on: false },
  dns: { mode: 'system' },
  spoof: { system: 'win-firefox', languages: 'de-DE,de', timezone: 'Asia/Tokyo', screen: '1366x768@1', theme: 'dark', network: '3g' },
});
const addr = await app.listen(0, '127.0.0.1');
const BASE = 'http://localhost:' + addr.port;

const root0 = typeof process.getuid === 'function' && process.getuid() === 0;
const browser = await puppeteer.launch({
  executablePath: chrome.path,
  headless: chrome.shell ? 'shell' : true,
  // Chrome refuses to start its sandbox as root or in most containers.
  args: [...chrome.args, ...(root0 || chrome.shell || process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []), '--disable-gpu'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const bad = [];
page.on('response', (r) => {
  if (r.status() >= 400)
    bad.push(
      r.status() +
        ' ' +
        r.request().resourceType() +
        ' ' +
        r
          .url()
          .replace(/^http:\/\/localhost:\d+/, '')
          .slice(0, 150)
    );
});
page.on('requestfailed', (r) =>
  bad.push(
    'FAILED ' +
      r.resourceType() +
      ' ' +
      r
        .url()
        .replace(/^http:\/\/localhost:\d+/, '')
        .slice(0, 150) +
      ' ' +
      (r.failure() || {}).errorText
  )
);
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') });
};
const frameOf = async () => {
  const h = await page.$('#frame');
  return h.contentFrame();
};
const waitFrame = async (fn, arg, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const f = await frameOf();
      if (f && (await f.evaluate(fn, arg))) return f;
    } catch {
      /* navigating */
    }
    if (Date.now() - t0 > ms) throw new Error('frame wait timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

try {
  // ---- shell
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  check('landing renders', (await page.$eval('#landing h1', (n) => n.textContent)) === 'Waddle');
  check('status chips shown', (await page.$$eval('#chips .chip', (n) => n.length)) === 4);
  await page.type('#q', SITE + '/');
  await page.keyboard.press('Enter');
  let f = await waitFrame(() => document.title === 'Fixture' && window.appLoaded === true);
  check('page loads through the proxy', true);
  check('address bar shows the real URL', (await page.$eval('#addr', (n) => n.value)) === SITE + '/');
  check('shell hash tracks the page', (await page.evaluate(() => location.hash)) === '#' + SITE + '/');
  check('page title mirrored', (await page.title()).startsWith('Fixture'));

  // ---- rewriting + hooks inside the page
  const info = await f.evaluate(async () => {
    const out = {};
    out.linkHref = document.getElementById('link').getAttribute('href');
    out.imgOk = document.getElementById('img').naturalWidth === 1;
    out.cssBg = getComputedStyle(document.getElementById('h')).backgroundImage;
    out.cookie = document.cookie;
    const r = await fetch('/api/data');
    out.fetch = await r.json();
    out.cookieAfterFetch = document.cookie;
    out.xhr = await new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open('GET', location.origin + '/api/data');
      x.onload = () => res(JSON.parse(x.responseText));
      x.onerror = () => res(null);
      x.send();
    });
    const im = new Image();
    out.stray = await new Promise((res) => {
      im.onload = () => res(im.getAttribute('src'));
      im.onerror = () => res('error');
      im.src = '/stray.png';
    });
    const d = document.createElement('div');
    d.innerHTML = '<img id="dyn" src="/pixel.png">';
    document.body.appendChild(d);
    await new Promise((r) => setTimeout(r, 50));
    out.dyn = document.getElementById('dyn').getAttribute('src');
    out.apiBlocked = await fetch('/-/api/state', { headers: { 'x-waddle': '1' } }).then(
      () => false,
      () => true
    );
    out.parentIsSelf = window.parent === window;
    out.frameElement = window.frameElement;
    localStorage.setItem('k', 'v');
    out.ls = localStorage.getItem('k');
    out.lsLen = localStorage.length;
    out.lsKeys = Object.keys(localStorage);
    out.ws = await new Promise((res) => {
      try {
        const w = new WebSocket('ws://' + new URL(document.baseURI.slice(document.baseURI.indexOf('/~/') + 3)).host + '/ws');
        w.onopen = () => w.send('hi');
        w.onmessage = (e) => {
          res(e.data + '|' + w.url);
          w.close();
        };
        w.onerror = () => res('error');
        setTimeout(() => res('timeout'), 4000);
      } catch (e) {
        res('threw ' + e.message);
      }
    });
    out.csp = !!document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    out.sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    return out;
  });
  check('links rewritten', info.linkHref === '/~/' + SITE + '/page2?x=1', info.linkHref);
  check('images load', info.imgOk);
  check('CSS url() rewritten and loaded', info.cssBg.includes('/~/' + SITE + '/bg.png'), info.cssBg);
  check('document.cookie hides HttpOnly', info.cookie === 'pref=blue', info.cookie);
  check(
    'server-side jar sends cookies upstream',
    /sid=abc123/.test(info.fetch.cookie) && /pref=blue/.test(info.fetch.cookie),
    info.fetch.cookie
  );
  check('cookies set by fetch responses appear', /fromxhr=1/.test(info.cookieAfterFetch), info.cookieAfterFetch);
  check('XHR to stray absolute URL is proxied', info.xhr && info.xhr.ok === true);
  check('stray root-relative image fixed', info.stray === '/~/' + SITE + '/stray.png', info.stray);
  check('innerHTML-inserted image fixed', info.dyn === '/~/' + SITE + '/pixel.png', info.dyn);
  check('settings API unreachable from pages', info.apiBlocked === true);
  check('page believes it is top-level', info.parentIsSelf === true && info.frameElement === null);
  check('localStorage namespaced per site', info.ls === 'v' && info.lsLen === 1 && info.lsKeys.join() === 'k', info);
  check('WebSocket relayed', info.ws === 'echo:hi|ws://127.0.0.1:' + site.address().port + '/ws', info.ws);
  check('a leak guard is active (service worker or CSP)', info.csp || info.sw, info);
  console.log('     service worker controlling: ' + info.sw + ', meta CSP: ' + info.csp);
  check('upstream never sees the browser address', info.fetch.xff === null);
  check('Referer mapped to the real page', info.fetch.referer === SITE + '/', info.fetch.referer);

  // ---- identity
  const id = await f.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 40;
    const x = c.getContext('2d');
    x.fillStyle = '#f60';
    x.fillRect(0, 0, 120, 40);
    x.fillStyle = '#069';
    x.font = '16px Arial';
    x.fillText('waddle', 4, 24);
    const a = c.toDataURL();
    const b = c.toDataURL();
    const gl = document.createElement('canvas').getContext('webgl');
    let glr = null;
    if (gl) {
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      glr = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null;
    }
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      oscpu: navigator.oscpu,
      uaData: typeof navigator.userAgentData,
      chrome: typeof window.chrome,
      lang: navigator.language,
      langs: navigator.languages.join(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offset: new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(),
      hours: new Date(Date.UTC(2026, 0, 15, 0, 0)).getHours(),
      str: new Date(Date.UTC(2026, 0, 15, 0, 0)).toString(),
      locale: new Date(Date.UTC(2026, 0, 15)).toLocaleDateString(),
      sw: screen.width,
      sh: screen.height,
      dpr: devicePixelRatio,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      light: matchMedia('(prefers-color-scheme: light)').matches,
      cssScheme: getComputedStyle(document.body).getPropertyValue('--scheme').trim(),
      conn: typeof navigator.connection,
      rtc: typeof RTCPeerConnection,
      dnt: navigator.doNotTrack,
      gpc: navigator.globalPrivacyControl,
      webdriver: navigator.webdriver,
      canvasStable: a === b,
      canvas: a.slice(-40),
      glr,
      native: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get),
      cores: navigator.hardwareConcurrency,
      mem: navigator.deviceMemory,
    };
  });
  check('user agent spoofed (Firefox on Windows)', /Firefox\/\d+/.test(id.ua) && /Windows NT 10/.test(id.ua), id.ua);
  check('UA request header matches the page', info.fetch.ua === id.ua, info.fetch.ua);
  check(
    'Chrome-only surfaces removed for a Firefox identity',
    id.uaData === 'undefined' && id.chrome === 'undefined' && id.conn === 'undefined' && id.mem === undefined && info.fetch.chua === null,
    id
  );
  check('platform / vendor / oscpu consistent', id.platform === 'Win32' && id.vendor === '' && /Windows NT 10/.test(id.oscpu), id);
  check('languages spoofed (page + header)', id.lang === 'de-DE' && id.langs === 'de-DE,de' && /^de-DE,de;q=0\.9/.test(info.fetch.lang), [
    id.langs,
    info.fetch.lang,
  ]);
  check(
    'time zone spoofed',
    id.tz === 'Asia/Tokyo' && id.offset === -540 && id.hours === 9 && /GMT\+0900 \(Japan Standard Time\)/.test(id.str),
    id
  );
  check('default locale follows language', /15\.1\.2026/.test(id.locale), id.locale);
  check('screen spoofed', id.sw === 1366 && id.sh === 768 && id.dpr === 1, id);
  check('colour scheme spoofed (matchMedia)', id.dark === true && id.light === false);
  check('colour scheme spoofed (CSS rules)', id.cssScheme === 'dark', id.cssScheme);
  check('WebRTC blocked', id.rtc === 'undefined');
  check('DNT + GPC set (page + header)', id.dnt === '1' && id.gpc === true && info.fetch.dnt === '1');
  check('webdriver flag hidden', id.webdriver === false);
  check('canvas noise is stable within a site', id.canvasStable);
  check('hooks look native', /\[native code\]/.test(id.native), id.native);
  if (id.glr !== null) check('WebGL renderer spoofed', /Intel|NVIDIA|AMD|Apple|Mesa|ANGLE|Adreno|Mali/i.test(id.glr), id.glr);

  // ---- navigation
  await f.click('#link');
  f = await waitFrame(() => document.title === 'Page 2');
  check('link click navigates inside the proxy', (await f.evaluate(() => document.getElementById('p2').textContent)) === 'two ?x=1');
  check('address bar follows navigation', (await page.$eval('#addr', (n) => n.value)) === SITE + '/page2?x=1');
  await new Promise((r) => setTimeout(r, 200));
  const jsCookie = seen.length;
  await f.evaluate(() => fetch('/api/data').then((r) => r.json()));
  check(
    'document.cookie writes reach the jar',
    /js=1/.test(seen[seen.length - 1].headers.cookie || ''),
    seen[seen.length - 1].headers.cookie
  );
  void jsCookie;
  await page.click('#back');
  f = await waitFrame(() => document.title === 'Fixture');
  check('back button works', true);
  await f.evaluate(() => document.getElementById('f').submit());
  f = await waitFrame(() => document.title === 'Echo');
  check('form POST goes through', (await f.evaluate(() => document.getElementById('out').textContent)) === 'POST a=1');
  await page.evaluate((u) => {
    document.getElementById('addr').value = u;
    document.getElementById('nav').requestSubmit();
  }, SITE + '/redir');
  f = await waitFrame(() => document.title === 'Page 2');
  check('redirects stay inside the proxy', (await page.$eval('#addr', (n) => n.value)) === SITE + '/page2?from=redir');
  await f.evaluate(
    (u) => {
      location.href = u;
    },
    SITE.replace('127.0.0.1', 'localhost') + '/page2?escaped=1'
  );
  f = await waitFrame(() => /escaped=1/.test(document.getElementById('p2') ? document.getElementById('p2').textContent : ''));
  check('location.href to another origin is caught', (await f.evaluate(() => location.pathname)).startsWith('/~/'));
  const canvas2 = await f.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 40;
    const x = c.getContext('2d');
    x.fillStyle = '#f60';
    x.fillRect(0, 0, 120, 40);
    x.fillStyle = '#069';
    x.font = '16px Arial';
    x.fillText('waddle', 4, 24);
    return c.toDataURL().slice(-40);
  });
  check('canvas noise differs between sites', canvas2 !== id.canvas);

  // ---- settings drawer
  await page.click('#gear');
  await page.waitForSelector('#panel .row');
  check('settings drawer opens', true);
  await page.evaluate(() => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === 'Identity').click());
  await page.waitForFunction(() => [...document.querySelectorAll('#panel label')].some((l) => l.textContent === 'Canvas'));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#panel .row')].find((r) => r.querySelector('label').textContent === 'Colour scheme');
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Light').click();
  });
  await new Promise((r) => setTimeout(r, 600));
  check('a change in the drawer is saved on the server', app.config.value.spoof.theme === 'light');
  await page.click('#reload');
  await new Promise((r) => setTimeout(r, 300));
  f = await waitFrame(() => document.readyState === 'complete' && typeof matchMedia === 'function');
  check('new setting applies on reload', (await f.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)) === true);

  // ---- text typed into the drawer is not lost to redraws
  const tabTo = (name) =>
    page.evaluate((n) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === n).click(), name);
  await tabTo('Proxies');
  await page.waitForSelector('#manual');
  await page.type('#manual', 'socks5://203.0.113.9:1080');
  await page.evaluate(() => document.activeElement.blur());
  await new Promise((r) => setTimeout(r, 4600)); // long enough for one background refresh
  await tabTo('DNS');
  await page.waitForSelector('#dnspick');
  check('the custom resolver field stays hidden until asked for', (await page.$eval('#dnsurl', (n) => n.hidden)) === true);
  await page.select('#dnspick', 'custom');
  check('choosing Custom shows and focuses it', await page.$eval('#dnsurl', (n) => !n.hidden && document.activeElement === n));
  await page.type('#dnsurl', 'https://dns.example/dns-query');
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 700));
  check('Enter adds the resolver', app.config.value.dns.servers.includes('https://dns.example/dns-query'), app.config.value.dns.servers);
  check('the field is cleared afterwards', await page.$eval('#dnsurl', (n) => n.hidden && n.value === ''));
  await tabTo('Proxies');
  await page.waitForSelector('#manual');
  check(
    'unsent text survives refreshes and tab changes',
    (await page.$eval('#manual', (n) => n.value)) === 'socks5://203.0.113.9:1080',
    await page.$eval('#manual', (n) => n.value)
  );

  check('no uncaught errors in the page', errors.length === 0, errors.slice(0, 3));
  const quiet = errors.length;

  // ---- the real internet (opt-in: a live site can change or be unreachable)
  if (LIVE) {
    app.config.patch({
      dns: { mode: 'doh' },
      spoof: { system: 'win-chrome', theme: 'real', timezone: '', languages: 'en-US,en', screen: 'real' },
    });
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      document.getElementById('addr').value = 'pypi.org';
      document.getElementById('nav').requestSubmit();
    });
    f = await waitFrame(() => /PyPI/.test(document.title) && document.readyState === 'complete', null, 30000);
    const live = await f.evaluate(() => ({
      title: document.title,
      imgs: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
      sheets: document.styleSheets.length,
      search: !!document.querySelector('input[name=q]'),
    }));
    check('pypi.org renders through Waddle', live.sheets > 0 && live.search, live);
    await shot('browsing');
    await f.evaluate(() => {
      const a = document.querySelector('a[href*="/help/"]') || document.querySelector('a[href*="/sponsors/"]');
      a.click();
    });
    f = await waitFrame(() => /Help|Sponsors/.test(document.title) && document.readyState === 'complete', null, 30000);
    check(
      'following a link on pypi.org works',
      /^https:\/\/pypi\.org\/(help|sponsors)\//.test(await page.$eval('#addr', (n) => n.value)),
      await page.$eval('#addr', (n) => n.value)
    );
    await page.evaluate(() => {
      document.getElementById('addr').value = 'https://pypi.org/project/requests/';
      document.getElementById('nav').requestSubmit();
    });
    f = await waitFrame(() => /requests/.test(document.title) && document.readyState === 'complete', null, 30000);
    check(
      'a pypi.org project page renders',
      (await f.evaluate(() => !!document.querySelector('.project-header__name, .package-header__name'))) === true
    );
    const route = await page.$eval('#route span', (n) => n.textContent);
    check('route status shows latency', /\d+ ms/.test(route), route);
  }
  // A live site's own script errors are reported, not counted: they are not Waddle's to fix.
  if (errors.length > quiet)
    console.log('     ' + (errors.length - quiet) + ' script error(s) raised by the live site itself, e.g. ' + errors[quiet].slice(0, 120));
} catch (e) {
  check('run completed', false, String((e && e.stack) || e));
  await shot('failure');
} finally {
  await browser.close();
  await app.close();
  site.close();
  site.closeAllConnections();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
if (process.env.VERBOSE === '1') {
  console.log('--- responses >= 400 and failed requests');
  for (const b of [...new Set(bad)].slice(0, 60)) console.log('   ' + b);
}
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
