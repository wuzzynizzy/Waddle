// Browser end-to-end check: a real Chrome drives the real server against stand-ins on this
// machine: fixture sites, a proxy to reach them through (Waddle never fetches a site itself),
// and a front that behaves like a host's edge, to show what a visitor sees when the server
// is away.
//
// Waddle itself has no dependencies, so this script is not part of `npm test`. To run it:
//
//   npm install --no-save puppeteer-core
//   CHROME=/path/to/chrome npm run test:browser
//
// Without CHROME it looks for Chrome, Chromium or Edge in the usual places, then for the
// self-contained build from `@sparticuz/chromium` if that package is installed.
//
//   SHOTS=<dir>   save screenshots there
//   VERBOSE=1     list failed requests and console errors at the end
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
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
// The kit gives this run a data directory of its own and the stand-ins (all on 127.0.0.1).
const kit = require(path.join(root, 'test/support.js'));
const { createApp } = require(path.join(root, 'server.js'));
const { PAGE_CSP } = require(path.join(root, 'lib/proxy.js'));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture site -----------------------------------------------------------------
// One server under two names: http://127.0.0.1:<port> is the site that gets visited, and
// http://localhost:<port> is another site as far as cookies, storage and exits go.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const seen = [];
let sitePort = 0;
const site = http.createServer((req, res) => {
  seen.push({ url: req.url, method: req.method, host: req.headers.host, headers: req.headers });
  const u = new URL(req.url, 'http://x');
  const html = (body, headers) => {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html' }, headers));
    res.end(body);
  };
  if (u.pathname === '/') {
    return html(
      `<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="/style.css">
<style>@media (prefers-color-scheme: dark){ body{ --scheme: dark } } @media (prefers-color-scheme: light){ body{ --scheme: light } }</style></head>
<body><h1 id="h">Fixture</h1><a id="link" href="/page2?x=1">next</a><img id="img" src="/pixel.png">
<form id="f" action="/echo" method="post"><input name="a" value="1"></form>
<iframe id="guest" src="http://localhost:${sitePort}/widget?set=1" width="300" height="60"></iframe>
<script src="/app.js"></script>
<script src="https://www.google-analytics.com/analytics.js"></script></body></html>`,
      {
        'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'pref=blue; Path=/'],
        'Content-Security-Policy': "default-src 'none'",
        'X-Frame-Options': 'DENY',
      }
    );
  }
  if (u.pathname === '/widget') {
    return html(
      `<!doctype html><html><head><title>Widget</title></head><body><p id="w">widget</p>
<script>window.kept = (function(){ try { ${u.searchParams.get('set') ? "localStorage.setItem('where','in a frame');" : ''} return localStorage.getItem('where'); } catch (e) { return 'error'; } })();</script></body></html>`,
      { 'Set-Cookie': 'wid=1; Path=/', 'X-Frame-Options': 'SAMEORIGIN' }
    );
  }
  // An ordinary page with a stylesheet and a picture of its own: what the screenshots show.
  if (u.pathname === '/tour') {
    return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field notes</title><link rel="stylesheet" href="/tour.css"></head><body>
<header><a class="brand" href="/tour">Field notes</a><nav><a href="/tour">Journal</a><a href="/tour">Maps</a><a href="/tour">About</a></nav></header>
<main><p class="kicker">Journal · Day 14</p><h1>The long walk to open water</h1>
<p class="lead">Emperor penguins walk for days across the sea ice between the colony and the open sea. They are not fast, and they do not need to be.</p>
<img src="/tour.svg" alt="Penguins walking in a line across the ice" width="720" height="280">
<p>They go in single file, each in the tracks of the one ahead, and when the ice slopes the right way they drop to their bellies and slide.</p>
<p class="note">A stand-in page. It is served by a test website on this machine and reaches the browser through a test proxy.</p></main></body></html>`);
  }
  if (u.pathname === '/tour.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(`*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#17202e;background:#f7f9fc}
header{display:flex;align-items:center;gap:24px;padding:16px clamp(20px,6vw,64px);background:#fff;border-bottom:1px solid #e3e8f0}
.brand{font-weight:700;font-size:18px;color:#17202e;text-decoration:none;margin-right:auto}nav{display:flex;gap:20px}nav a{color:#5a6577;text-decoration:none;font-size:15px}
main{max-width:768px;margin:0 auto;padding:40px 24px 64px}.kicker{margin:0;color:#0b6bcb;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
h1{font-size:40px;line-height:1.15;margin:8px 0 16px;letter-spacing:-.02em}.lead{font-size:20px;color:#3b4658;margin:0 0 28px}
img{display:block;width:100%;height:auto;border-radius:16px;margin:0 0 28px}.note{margin-top:32px;padding:14px 16px;border-radius:12px;background:#eaf2fd;color:#27405f;font-size:15px}
@media (max-width:600px){h1{font-size:30px}.lead{font-size:18px}nav{display:none}main{padding:28px 20px 48px}}`);
  }
  if (u.pathname === '/tour.svg') {
    const bird = (x, y, s) =>
      `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="0" rx="13" ry="24" fill="#1b2433"/><ellipse cx="2" cy="3" rx="8" ry="18" fill="#fff"/>` +
      `<circle cx="3" cy="-20" r="9" fill="#1b2433"/><path d="M10-21l9 3-9 3z" fill="#ff8a1f"/><path d="M-4 23h10l4 4h-16z" fill="#ff8a1f"/></g>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 280"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfdcff"/><stop offset="1" stop-color="#eef6ff"/></linearGradient></defs>` +
        `<rect width="720" height="280" fill="url(#s)"/><circle cx="590" cy="70" r="34" fill="#fff6d8"/><path d="M0 170l90-50 80 40 110-70 120 80 90-45 110 55 120-40v140H0z" fill="#dcebfb"/>` +
        `<path d="M0 200q180-30 360-8t360-12v100H0z" fill="#fff"/>` +
        [0, 1, 2, 3, 4].map((i) => bird(150 + i * 100, 196 - (i % 2) * 4, 1 - i * 0.06)).join('') +
        `</svg>`
    );
  }
  if (u.pathname === '/style.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end('h1{background:url(/bg.png)} @import "/more.css";');
  }
  if (u.pathname === '/more.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end('p{color:red}');
  }
  if (u.pathname === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('window.appLoaded = true;');
  }
  if (u.pathname === '/worker.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(
      `self.onmessage = async () => {
  let fetched = null;
  try { fetched = await fetch('/api/data').then((r) => r.json()); } catch (e) { fetched = { error: String(e) }; }
  postMessage({ ua: navigator.userAgent, lang: navigator.language, langs: (navigator.languages || []).join(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, platform: navigator.platform, cores: navigator.hardwareConcurrency, fetched });
};`
    );
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
    req.on('end', () => html('<title>Echo</title><pre id="out">' + req.method + ' ' + b + '</pre>'));
    return;
  }
  if (u.pathname === '/page2') {
    return html('<title>Page 2</title><p id="p2">two ' + u.search + '</p><script>document.cookie="js=1; path=/";</script>');
  }
  if (u.pathname === '/redir') {
    res.writeHead(302, { Location: '/page2?from=redir' });
    return res.end();
  }
  if (/^\/(?:pixel|bg|stray\d?)\.png$/.test(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PNG);
  }
  res.writeHead(404);
  res.end('nope');
});
// minimal RFC 6455 echo so the WebSocket relay can be exercised without dependencies
site.on('upgrade', (req, socket) => {
  seen.push({ url: req.url, method: 'WS', host: req.headers.host, headers: req.headers });
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
let siteConnections = 0; // every TCP connection the fixture ever accepted
const siteSockets = new Set();
site.on('connection', (s) => {
  siteConnections++;
  siteSockets.add(s);
  s.on('close', () => siteSockets.delete(s));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
sitePort = site.address().port;
const SITE = 'http://127.0.0.1:' + sitePort;
const OTHER = 'http://localhost:' + sitePort;

// ---- the way out: one proxy stand-in, which a test page places in the United States ------
const judge = await kit.judge('203.0.113.10', 'US');
const canary = await kit.canary();
const px = await kit.httpProxy();
const tunnels = () => px.log.filter((l) => String(l).endsWith(':' + sitePort)).length; // connections the exit opened to the fixture

const hermetic = {
  pool: { sources: [], discover: false, checkTimeout: 1500, judge: judge.url + '/trace', canaries: [canary.line], echo: '' },
  dns: { auto: false, fallback: false },
  route: { https: false }, // the fixture speaks plain HTTP; HTTPS-only gets its own part below
};
let app = createApp();
app.config.reset();
app.config.patch(
  Object.assign({}, hermetic, {
    spoof: { system: 'win-firefox', languages: 'de-DE,de', timezone: 'Asia/Tokyo', screen: '1366x768@1', theme: 'dark', network: '3g' },
  })
);
const addr = await app.listen(0, '127.0.0.1');
app.pool.addManual('http://127.0.0.1:' + px.port);
await kit.until(() => app.pool.alive.size === 1 && app.pool.summary().proxies[0].plain === true, 8000);

// ---- a front, as hosts put one before an app: when the app does not answer, it answers itself ----
const edge = { down: false, replaced: 0, edgeStatuses: [] };
const EDGE_PAGE =
  '<!doctype html><html><head><title>502 Bad gateway</title><link rel="stylesheet" href="/cdn-cgi/styles/main.css"></head><body><h1>Bad gateway</h1><p>The web server reported a bad gateway error.</p></body></html>';
const front = http.createServer((req, res) => {
  if (edge.down) {
    edge.replaced++;
    res.writeHead(502, { 'Content-Type': 'text/html', Server: 'edge' });
    return res.end(EDGE_PAGE);
  }
  const up = http.request(
    { host: '127.0.0.1', port: addr.port, method: req.method, path: req.url, headers: req.headers, setHost: false, agent: false },
    (r) => {
      // A real edge swaps answers with these codes for a page of its own. Waddle must never send one.
      if (r.statusCode === 502 || r.statusCode === 504 || (r.statusCode >= 520 && r.statusCode <= 530))
        edge.edgeStatuses.push(r.statusCode + ' ' + req.url);
      res.writeHead(r.statusCode, r.statusMessage, r.rawHeaders);
      r.pipe(res);
    }
  );
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'text/html', Server: 'edge' });
    res.end(EDGE_PAGE);
  });
  req.pipe(up);
});
front.on('upgrade', (req, socket, head) => {
  if (edge.down) return socket.destroy();
  const up = net.connect(addr.port, '127.0.0.1', () => {
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
const frontSockets = new Set();
front.on('connection', (s) => {
  frontSockets.add(s);
  s.on('close', () => frontSockets.delete(s));
});
await new Promise((r) => front.listen(0, '127.0.0.1', r));
const BASE = 'http://localhost:' + front.address().port;

const root0 = typeof process.getuid === 'function' && process.getuid() === 0;
const browser = await puppeteer.launch({
  executablePath: chrome.path,
  headless: chrome.shell ? 'shell' : true,
  // Chrome refuses to start its sandbox as root or in most containers.
  args: [...chrome.args, ...(root0 || chrome.shell || process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []), '--disable-gpu'],
  defaultViewport: { width: 1280, height: 800 },
});
const realUA = await browser.userAgent();
const page = await browser.newPage();
const tourPage = await browser.newPage();
const tourErrors = [];
tourPage.on('pageerror', (e) => tourErrors.push(String(e)));
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const bad = [];
const docs = []; // headers of proxied documents, as the browser received them
page.on('response', (r) => {
  const url = r.url().replace(/^http:\/\/localhost:\d+/, '');
  if (r.request().resourceType() === 'document' && url.startsWith('/~/')) docs.push({ url, status: r.status(), headers: r.headers() });
  if (r.status() >= 400) bad.push(r.status() + ' ' + r.request().resourceType() + ' ' + url.slice(0, 150));
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
page.on('console', (m) => {
  if (m.type() === 'error') bad.push('console: ' + m.text().slice(0, 200));
});
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
/** A screenshot of the window, or of one element of it. */
const shot = async (name, selector) => {
  if (!SHOTS) return;
  const file = path.join(SHOTS, name + '.png');
  const toastWasHidden = await page.$eval('#toast', (n) => n.hidden).catch(() => true);
  if (!toastWasHidden) await page.$eval('#toast', (n) => (n.hidden = true));
  try {
    if (selector) await (await page.$(selector)).screenshot({ path: file });
    else await page.screenshot({ path: file });
  } finally {
    if (!toastWasHidden) await page.$eval('#toast', (n) => (n.hidden = false));
  }
};
/** The view as it is, at a phone's width: a screenshot, and whether everything still fits the screen. */
const phone = async (name) => {
  await page.setViewport({ width: 390, height: 780 });
  await sleep(400);
  await shot(name);
  const fits = await page.evaluate(() => {
    const tabs = document.getElementById('tabs');
    const shown = [...document.querySelectorAll('#bar > *')].filter((n) => n.getClientRects().length);
    return {
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bar: shown.every((n) => n.getBoundingClientRect().left >= 0 && n.getBoundingClientRect().right <= innerWidth + 0.5),
      tabs: document.getElementById('drawer').hidden || tabs.scrollWidth <= tabs.clientWidth,
      address: Math.round(document.getElementById('nav').getBoundingClientRect().width),
    };
  });
  await page.setViewport({ width: 1280, height: 800 });
  await sleep(300);
  return fits;
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
    if (Date.now() - t0 > ms) throw new Error('frame wait timed out: ' + String(fn).slice(0, 120));
    await sleep(100);
  }
};
const addrBar = () => page.$eval('#addr', (n) => n.value);
const goTo = (text) =>
  page.evaluate((u) => {
    document.getElementById('addr').value = u;
    document.getElementById('nav').requestSubmit();
  }, text);
const state = () => page.evaluate(() => fetch('/-/api/state', { headers: { 'x-waddle': '1' } }).then((r) => r.json()));
const tabTo = async (name) => {
  if (await page.$eval('#drawer', (d) => d.hidden)) await page.click('#gear');
  await page.evaluate((n) => [...document.querySelectorAll('#tabs button')].find((b) => b.textContent === n).click(), name);
};
/** Press the control in the settings panel that carries this key. */
const press = (key) =>
  page.evaluate((k) => {
    const x = [...document.querySelectorAll('#panel [data-k]')].find((n) => n.getAttribute('data-k') === k);
    if (!x) throw new Error('no control ' + k);
    x.click();
  }, key);
const canvasPrint = () => {
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
};

try {
  // ---- illustrated product tour: route builder, resolver demo and installers
  await tourPage.goto(BASE + '/tour', { waitUntil: 'networkidle0' });
  check(
    'the Waddle tour opens with its hand-drawn penguin artwork',
    (await tourPage.title()).includes('Waddle') && (await tourPage.$('.scene-art')) !== null
  );
  const tourMascot = await tourPage.$eval('.scene-art', (svg) => ({
    circles: svg.querySelectorAll('circle').length,
    orbitDecorations: svg.querySelectorAll('.orbit-node, .tiny-label, .snow-stars').length,
    eyes: getComputedStyle(svg.querySelector('.penguin-eyes')).animationName,
    wing: getComputedStyle(svg.querySelector('.wing-wave')).animationName,
    foot: getComputedStyle(svg.querySelector('.penguin-foot')).animationName,
    scarf: getComputedStyle(svg.querySelector('.scarf-tail')).animationName,
  }));
  check(
    'the tour keeps only Waddle’s face circles and removes decorative orbits',
    tourMascot.circles === 4 && tourMascot.orbitDecorations === 0,
    tourMascot
  );
  check(
    'Waddle animates his eyes, wings, feet and scarf independently',
    tourMascot.eyes === 'penguin-blink' &&
      tourMascot.wing === 'hello-wave' &&
      tourMascot.foot === 'foot-step' &&
      tourMascot.scarf === 'scarf-sway',
    tourMascot
  );
  const supportingMascots = await tourPage.evaluate(() => ({
    miniWing: getComputedStyle(document.querySelector('.mini-wing-wave')).animationName,
    miniEyes: getComputedStyle(document.querySelector('.mini-eyes')).animationName,
    closingWing: getComputedStyle(document.querySelector('.closing-wing-wave')).animationName,
    closingEyes: getComputedStyle(document.querySelector('.closing-eyes')).animationName,
    closingFoot: getComputedStyle(document.querySelector('.closing-foot')).animationName,
    closingCircles: document.querySelectorAll('.closing-art svg circle').length,
    closingRing: getComputedStyle(document.querySelector('.closing-section'), '::before').content !== 'none',
  }));
  check(
    'the smaller Waddles also wave, blink and step',
    supportingMascots.miniWing === 'hello-wave' &&
      supportingMascots.miniEyes === 'penguin-blink' &&
      supportingMascots.closingWing === 'hello-wave' &&
      supportingMascots.closingEyes === 'penguin-blink' &&
      supportingMascots.closingFoot === 'foot-step',
    supportingMascots
  );
  check(
    'the tour closing mascot has no decorative orbit circles',
    supportingMascots.closingCircles === 2 && !supportingMascots.closingRing,
    supportingMascots
  );
  check('the old promotional wording is absent from the tour', !(await tourPage.$eval('body', (n) => /perfected/i.test(n.textContent))));
  check(
    'tour includes direct self-host installers and the GitHub source',
    (await tourPage.$eval('#unixCode', (n) => /waddle\.wisp\.uno\/install\.sh/.test(n.textContent))) &&
      (await tourPage.$eval('#windowsCode', (n) => /install\.ps1/.test(n.textContent)))
  );
  await tourPage.click('#hopPlus');
  await tourPage.click('#hopPlus');
  check(
    'the tour route demo interactively adds proxy hops',
    (await tourPage.$eval('#hopCount', (n) => n.textContent)) === '3 hops' && (await tourPage.$$('.chain-node')).length === 5
  );
  for (let i = 0; i < 13; i++) await tourPage.click('#hopPlus');
  check(
    'the route demo reaches its documented 16-hop ceiling',
    (await tourPage.$eval('#hopCount', (n) => n.textContent)) === '16 hops' && (await tourPage.$eval('#hopPlus', (n) => n.disabled))
  );
  await tourPage.click('.strategy[data-strategy="check"]');
  check(
    'the tour DNS demo explains resolver cross-checks',
    (await tourPage.$eval('#strategyNote', (n) => n.textContent)).includes('Conflicting answers')
  );
  await tourPage.click('#addResolver');
  check(
    'the tour DNS demo can grow its resolver stack',
    (await tourPage.$$('.resolver-row')).length === 4 &&
      (await tourPage.$eval('#resolverCount', (n) => n.textContent)) === '4 / 64 in stack'
  );
  await tourPage.click('#tabWindows');
  check(
    'the tour switches to the Windows PowerShell installer',
    !(await tourPage.$eval('#windowsCode', (n) => n.hidden)) && (await tourPage.$eval('#unixCode', (n) => n.hidden))
  );
  await tourPage.setViewport({ width: 390, height: 820 });
  await tourPage.click('#menuToggle');
  check(
    'the tour navigation opens accessibly on a phone',
    (await tourPage.$eval('#menuToggle', (n) => n.getAttribute('aria-expanded'))) === 'true' &&
      !(await tourPage.$eval('#mobileNav', (n) => n.hidden))
  );
  if (SHOTS) await tourPage.screenshot({ path: path.join(SHOTS, 'waddle-tour.png'), fullPage: true });

  // ---- shell
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  check('landing renders', (await page.$eval('#landing h1', (n) => n.textContent)) === 'Waddle');
  const homeMascot = await page.$eval('.hero svg', (svg) => ({
    circles: svg.querySelectorAll('circle').length,
    rings: ['::before', '::after'].some((pseudo) => getComputedStyle(svg.parentElement, pseudo).content !== 'none'),
    eyes: getComputedStyle(svg.querySelector('.home-eyes')).animationName,
    wing: getComputedStyle(svg.querySelector('.wave')).animationName,
    foot: getComputedStyle(svg.querySelector('.home-foot')).animationName,
    torso: getComputedStyle(svg.querySelector('.home-torso')).animationName,
  }));
  check('the homepage mascot has no decorative rings', homeMascot.circles === 4 && !homeMascot.rings, homeMascot);
  check(
    'the homepage animates Waddle’s blinking, wave, feet and body',
    homeMascot.eyes === 'home-blink' &&
      homeMascot.wing === 'home-wave' &&
      homeMascot.foot === 'home-step' &&
      homeMascot.torso === 'home-breathe',
    homeMascot
  );
  check('the old promotional wording is absent from the homepage', !(await page.$eval('body', (n) => /perfected/i.test(n.textContent))));
  await page.waitForFunction(() => document.querySelectorAll('#chips .pill').length >= 4, { timeout: 5000 });
  const chips = await page.$$eval('#chips .pill', (n) => n.map((x) => x.textContent));
  check(
    'status chips: live proxies, hops, lookups, identity',
    chips.length === 4 && chips[0] === '1 live' && chips[1] === '1 hop' && chips[2] === 'DNS · auto',
    chips
  );
  check(
    'a claimed browser of another kind than the real one is flagged',
    await page.$eval('#chips .pill:nth-child(4) i', (n) => n.classList.contains('warn')).catch(() => false),
    chips
  );
  check('quick links shown', (await page.$$eval('#links .tile', (n) => n.length)) === 4);
  await shot('landing');
  const small = await phone('phone-landing');
  check('at a phone’s width the start page fits the screen', !small.sideways && small.bar, small);
  const checkpointFile = await page.evaluate(async () => {
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let resolveText;
    let filename = '';
    const contents = new Promise((resolve) => {
      resolveText = resolve;
    });
    URL.createObjectURL = function (blob) {
      blob.text().then(resolveText);
      return originalCreate.call(URL, blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      filename = this.download;
      return originalClick.call(this);
    };
    try {
      document.querySelector('#checkpoint').click();
      const text = await contents;
      return { filename: filename, text: text };
    } finally {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
  const checkpointBackup = JSON.parse(checkpointFile.text);
  check(
    'the homepage checkpoint directly downloads a portable backup, without opening settings',
    checkpointFile.filename.startsWith('waddle-backup-') &&
      checkpointFile.filename.endsWith('.json') &&
      checkpointBackup.format === 'waddle-backup' &&
      checkpointBackup.version === 1 &&
      checkpointBackup.config &&
      checkpointBackup.browser &&
      Array.isArray(checkpointBackup.tabs) &&
      !('cookies' in checkpointBackup) &&
      (await page.$eval('#drawer', (n) => n.hidden)),
    {
      filename: checkpointFile.filename,
      format: checkpointBackup.format,
      version: checkpointBackup.version,
      hasConfig: !!checkpointBackup.config,
      hasBrowser: !!checkpointBackup.browser,
      hasTabs: Array.isArray(checkpointBackup.tabs),
      hasCookies: 'cookies' in checkpointBackup,
      drawerHidden: await page.$eval('#drawer', (n) => n.hidden),
    }
  );
  await page.type('#q', SITE + '/');
  await page.keyboard.press('Enter');
  let f = await waitFrame(() => document.title === 'Fixture' && window.appLoaded === true);
  check('page loads through the proxy', true);
  check('address bar shows the real URL', (await addrBar()) === SITE + '/');
  check('shell hash tracks the page', (await page.evaluate(() => location.hash)) === '#' + SITE + '/');
  check('page title mirrored', (await page.title()).startsWith('Fixture'));
  check(
    'an address without HTTPS is marked as such',
    await page.$eval('#lock', (n) => n.classList.contains('open') && n.title === 'Not encrypted')
  );
  check('the exit carried it', tunnels() > 0 && siteConnections === tunnels(), { tunnels: tunnels(), connections: siteConnections });
  await page
    .waitForFunction(() => /^US · \d+ ms$/.test(document.querySelector('#route span').textContent), { timeout: 6000 })
    .catch(() => {});
  check(
    'the route is shown: exit country and time',
    /^US · \d+ ms$/.test(await page.$eval('#route span', (n) => n.textContent)),
    await page.$eval('#route span', (n) => n.textContent)
  );
  const first = docs.find((d) => d.url === '/~/' + SITE + '/');
  check(
    'the document carries Waddle’s policy, not the site’s',
    !!first && first.headers['content-security-policy'] === PAGE_CSP && !first.headers['x-frame-options'],
    first && first.headers
  );
  check('every answer is marked as Waddle’s', !!first && first.headers['x-waddle'] === '1');

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
    out.idb = await new Promise((res) => {
      const q = indexedDB.open('app', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('s');
      q.onsuccess = async () => {
        const name = q.result.name;
        q.result.close();
        const list = indexedDB.databases ? (await indexedDB.databases()).map((x) => x.name) : ['app'];
        res({ name, list });
      };
      q.onerror = () => res({ error: String(q.error) });
    });
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
    out.tracker = typeof window.ga;
    const guest = document.getElementById('guest');
    out.guestSrc = guest.getAttribute('src');
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
  check('IndexedDB: the page sees its own names', info.idb.name === 'app' && info.idb.list.join() === 'app', info.idb);
  const rawDbs = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((x) => x.name) : null));
  if (rawDbs) check('IndexedDB: kept apart per site underneath', rawDbs.includes(SITE + '|app') && !rawDbs.includes('app'), rawDbs);
  check('WebSocket relayed', info.ws === 'echo:hi|ws://127.0.0.1:' + sitePort + '/ws', info.ws);
  check('a leak guard is active (service worker or CSP)', info.csp || info.sw, info);
  console.log('     service worker controlling: ' + info.sw + ', meta CSP: ' + info.csp);
  check('upstream never sees the browser address', info.fetch.xff === null);
  check('Referer mapped to the real page', info.fetch.referer === SITE + '/', info.fetch.referer);
  check('a tracker on the page was refused', info.tracker === 'undefined' && (await state()).blocked >= 1);

  // ---- what slips past rewriting: caught by the service worker (or refused outright without one)
  const before = seen.length;
  await f.evaluate((other) => {
    const a = document.createElement('div');
    a.setAttribute('style', 'width:10px;height:10px;background:url(/stray2.png)');
    const b = document.createElement('div');
    b.setAttribute('style', 'width:10px;height:10px;background:url(' + other + '/stray3.png)');
    document.body.append(a, b);
  }, OTHER);
  await sleep(800);
  const strays = seen.slice(before).filter((x) => /^\/stray[23]\.png/.test(x.url));
  if (info.sw) {
    check(
      'requests that escape rewriting are sent through the proxy by the service worker',
      strays.length === 2 &&
        strays.some((x) => x.host === '127.0.0.1:' + sitePort) &&
        strays.some((x) => x.host === 'localhost:' + sitePort),
      strays.map((x) => x.host + x.url)
    );
    check(
      'and arrive as what they were, from the page they were on',
      strays.every((x) => x.headers['sec-fetch-dest'] === 'image' && x.headers.referer === SITE + '/' && !('x-waddle-dest' in x.headers)),
      strays.map((x) => x.headers)
    );
  } else check('without the service worker, requests that escape rewriting are refused', strays.length === 0, strays.length);

  // ---- a third party in a frame
  const guest = f.childFrames().find((x) => /\/widget/.test(x.url()));
  check('an embedded document is addressed as such', info.guestSrc === '/~/f/' + OTHER + '/widget?set=1' && !!guest, [
    info.guestSrc,
    guest && guest.url(),
  ]);
  const g = await guest.evaluate(async () => ({
    title: document.title,
    kept: window.kept,
    cookie: document.cookie,
    sent: (await fetch('/api/data').then((r) => r.json())).cookie,
    ua: navigator.userAgent,
    lang: navigator.language,
    parent: window.parent !== window,
  }));
  check('it loads, and is told the same things about the browser', g.title === 'Widget' && g.kept === 'in a frame' && g.parent, g);
  check('as a third party it gets no cookies: none to read, none sent', g.cookie === '' && g.sent === '', g);

  // ---- workers
  const worker = await f.evaluate(
    () =>
      new Promise((res) => {
        const w = new Worker('/worker.js');
        w.onmessage = (e) => res(e.data);
        w.onerror = (e) => res({ error: e.message || 'worker error' });
        w.postMessage('go');
        setTimeout(() => res({ error: 'timeout' }), 5000);
      })
  );
  const blobWorker = await f.evaluate(
    () =>
      new Promise((res) => {
        const src =
          'postMessage({ ua: navigator.userAgent, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = (e) => res(e.data);
        w.onerror = (e) => res({ error: e.message || 'worker error' });
        setTimeout(() => res({ error: 'timeout' }), 5000);
      })
  );

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
  check('the frame on the page has the same identity', g.ua === id.ua && g.lang === id.lang, g);
  check(
    'a worker has the same identity as its page',
    worker.ua === id.ua && worker.langs === id.langs && worker.tz === id.tz && worker.platform === id.platform && worker.cores === id.cores,
    worker
  );
  check(
    'a worker’s requests go through the proxy, with the page’s cookies and identity',
    !!worker.fetched && worker.fetched.ok === true && worker.fetched.ua === id.ua && /sid=abc123/.test(worker.fetched.cookie || ''),
    worker.fetched
  );
  check(
    'a worker made from a Blob has it too',
    blobWorker.ua === id.ua && blobWorker.lang === id.lang && blobWorker.tz === id.tz,
    blobWorker
  );

  // ---- navigation
  await f.click('#link');
  f = await waitFrame(() => document.title === 'Page 2');
  check('link click navigates inside the proxy', (await f.evaluate(() => document.getElementById('p2').textContent)) === 'two ?x=1');
  check('address bar follows navigation', (await addrBar()) === SITE + '/page2?x=1');
  await sleep(200);
  await f.evaluate(() => fetch('/api/data').then((r) => r.json()));
  check(
    'document.cookie writes reach the jar',
    /js=1/.test(seen[seen.length - 1].headers.cookie || ''),
    seen[seen.length - 1].headers.cookie
  );
  await page.click('#back');
  f = await waitFrame(() => document.title === 'Fixture');
  check('back button works', true);
  await f.evaluate(() => document.getElementById('f').submit());
  f = await waitFrame(() => document.title === 'Echo');
  check('form POST goes through', (await f.evaluate(() => document.getElementById('out').textContent)) === 'POST a=1');
  await goTo(SITE + '/redir');
  f = await waitFrame(() => document.title === 'Page 2');
  check('redirects stay inside the proxy', (await addrBar()) === SITE + '/page2?from=redir');
  await f.evaluate((u) => {
    location.href = u;
  }, OTHER + '/page2?escaped=1');
  f = await waitFrame(() => /escaped=1/.test(document.getElementById('p2') ? document.getElementById('p2').textContent : ''));
  check('location.href to another origin is caught', (await f.evaluate(() => location.pathname)).startsWith('/~/'));
  check('canvas noise differs between sites', (await f.evaluate(canvasPrint)) !== id.canvas);

  // ---- the same third party, opened in the address bar: a site of its own
  await goTo(OTHER + '/widget');
  f = await waitFrame(() => document.title === 'Widget');
  const own = await f.evaluate(async () => ({
    kept: window.kept,
    cookie: document.cookie,
    sent: (await fetch('/api/data').then((r) => r.json())).cookie,
  }));
  check('storage it filled as a guest is not there when it is visited itself', own.kept === null, own);
  check('visited itself, it keeps its cookies', /wid=1/.test(own.cookie) && /wid=1/.test(own.sent), own);

  // ---- an ordinary page: its own stylesheet and picture arrive, and it is laid out by them
  await goTo(SITE + '/tour');
  f = await waitFrame(() => document.title === 'Field notes' && document.images.length === 1 && document.images[0].complete);
  const tour = await f.evaluate(() => ({
    heading: getComputedStyle(document.querySelector('h1')).fontSize,
    picture: document.images[0].naturalWidth,
    sheet: document.styleSheets[0].href,
  }));
  check(
    'a page is laid out by its own stylesheet and shows its own picture, both fetched through the proxy',
    tour.heading === '40px' && tour.picture > 0 && tour.sheet.includes('/~/' + SITE + '/tour.css'),
    tour
  );
  await shot('browsing');
  const held = await phone('phone-browsing');
  check(
    'at a phone’s width the toolbar keeps its buttons on screen and room for the address',
    !held.sideways && held.bar && held.address >= 150,
    held
  );

  // ---- settings drawer
  await goTo(SITE + '/');
  f = await waitFrame(() => document.title === 'Fixture' && window.appLoaded === true);
  await page.click('#gear');
  await page.waitForSelector('#panel .row');
  check('settings drawer opens', true);
  check(
    'six tabs',
    (await page.$$eval('#tabs button', (n) => n.map((x) => x.textContent).join())) === 'Route,Proxies,DNS,Identity,Privacy,General'
  );
  await tabTo('Route');
  await page.waitForFunction(() => [...document.querySelectorAll('#panel h2')].some((h) => h.textContent === 'Last page'));
  const lastCard = await page.$eval('#panel .list', (n) =>
    [...n.children].map((r) => [...r.children].map((c) => c.textContent).join(' | '))
  );
  check(
    'the Route tab shows the page’s route: site, exit, country',
    lastCard.length === 2 && lastCard[0].includes('127.0.0.1:' + sitePort) && /^exit \| http:\/\/127\.0\.0\.1:\d+ \| US$/.test(lastCard[1]),
    lastCard
  );
  await shot('route', '#drawer');
  const narrow = await phone('phone-settings');
  check('at a phone’s width all six tabs are in view', !narrow.sideways && narrow.tabs, narrow);
  await tabTo('Identity');
  await page.waitForFunction(() => [...document.querySelectorAll('#panel label')].some((l) => l.textContent === 'Canvas'));
  check(
    'the Identity tab says what is presented, and that it can be told apart',
    await page.$eval(
      '#panel .card',
      (n) => /Firefox/.test(n.textContent) && /Detectable/.test(n.textContent) && /de-DE · Asia\/Tokyo/.test(n.textContent)
    ),
    await page.$eval('#panel .card', (n) => n.textContent)
  );
  await shot('identity', '#drawer');
  await press('spoof.theme=light');
  await sleep(600);
  check('a change in the drawer is saved on the server', app.config.value.spoof.theme === 'light');
  await page.click('#reload');
  await sleep(300);
  f = await waitFrame(() => document.readyState === 'complete' && typeof matchMedia === 'function' && window.appLoaded === true);
  check('new setting applies on reload', (await f.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)) === true);

  // Language and time zone can follow the exit instead of being fixed: this one is in the United States.
  await press('spoof.languages=exit');
  await press('spoof.timezone=exit');
  await sleep(600);
  await page.click('#reload');
  await sleep(300);
  f = await waitFrame(() => document.readyState === 'complete' && window.appLoaded === true);
  const follow = await f.evaluate(async () => ({
    lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sent: (await fetch('/api/data').then((r) => r.json())).lang,
  }));
  check(
    'language and time zone follow the exit’s country',
    follow.lang === 'en-US' && follow.tz === 'America/New_York' && /^en-US,en;q=0\.9/.test(follow.sent),
    follow
  );

  // ---- text typed into the drawer is not lost to redraws
  await tabTo('Proxies');
  await page.waitForSelector('#manual');
  check(
    'the Proxies tab lists the live proxy',
    await page.$$eval('#panel .list', (lists) =>
      lists.some((l) => /http/.test(l.textContent) && /US/.test(l.textContent) && /\d+ ms/.test(l.textContent))
    )
  );
  await shot('proxies', '#drawer');
  await page.type('#manual', 'socks5://203.0.113.9:1080');
  await page.evaluate(() => document.activeElement.blur());
  await sleep(4600); // long enough for one background refresh
  await tabTo('DNS');
  await page.waitForSelector('#panel [data-k="dnspick"]');
  check('the custom resolver field is not there until asked for', (await page.$('#dnsurl')) === null);
  await shot('dns', '#drawer');
  await press('dnspick');
  await page.waitForSelector('#panel .dd-opt');
  await page.evaluate(() => [...document.querySelectorAll('#panel .dd-opt')].find((o) => /Custom address/.test(o.textContent)).click());
  await page.waitForSelector('#dnsurl');
  check('choosing Custom shows and focuses it', await page.$eval('#dnsurl', (n) => document.activeElement === n));
  await page.type('#dnsurl', 'https://dns.example/dns-query');
  await page.keyboard.press('Enter');
  await sleep(700);
  check('Enter adds the resolver', app.config.value.dns.servers.includes('https://dns.example/dns-query'), app.config.value.dns.servers);
  check('the field is gone afterwards', (await page.$('#dnsurl')) === null);
  await tabTo('Proxies');
  await page.waitForSelector('#manual');
  check(
    'unsent text survives refreshes and tab changes',
    (await page.$eval('#manual', (n) => n.value)) === 'socks5://203.0.113.9:1080',
    await page.$eval('#manual', (n) => n.value)
  );
  await page.$eval('#manual', (n) => {
    n.value = '';
  });
  await tabTo('General');
  await page.waitForSelector('#panel [data-k="ui.theme=dark"]');
  await press('ui.theme=dark');
  await sleep(100);
  check('the app’s own theme changes at once', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  await shot('general-dark');
  await press('ui.theme=auto');
  await sleep(400);

  // ---- what sites see
  await tabTo('Privacy');
  await page.waitForSelector('#panel [data-k="btn:What sites see"]');
  await shot('privacy', '#drawer');
  await press('btn:What sites see');
  f = await waitFrame(() => document.title === 'What sites see' && document.querySelectorAll('#fp tbody tr').length > 5);
  check('the check page opens under its own name', (await addrBar()) === 'waddle:check' && (await page.$eval('#drawer', (d) => d.hidden)));
  const seenBy = await f.evaluate(() => ({
    lead: document.querySelector('.lead').textContent,
    path: document.getElementById('path').textContent,
    rows: [...document.querySelectorAll('#net tbody tr, #fp tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent)),
    sent: [...document.querySelectorAll('#sent tr')].map((tr) => [...tr.children].map((c) => c.textContent)),
  }));
  check(
    'it names the exit’s address and country',
    /visited from 203\.0\.113\.10 in United States/.test(seenBy.lead) && /http US/.test(seenBy.path),
    seenBy.lead
  );
  const browserRow = seenBy.rows.find((r) => r[0] === 'Browser') || [];
  check(
    'it sets what a site reads next to what the browser really is',
    /Firefox\/\d+/.test(browserRow[1] || '') && (browserRow[2] || '') === realUA,
    browserRow
  );
  check(
    'it lists the headers that go out',
    seenBy.sent.some((r) => r[0] === 'User-Agent' && /Firefox/.test(r[1])) &&
      seenBy.sent.some((r) => r[0] === 'Accept-Language' && /^en-US/.test(r[1])),
    seenBy.sent
  );
  await shot('check');

  // ---- HTTPS only
  app.config.patch({ route: { https: true } });
  await goTo(SITE + '/page2?secure=1');
  f = await waitFrame(() => !!document.querySelector('[data-act="plain"]'), null, 12000);
  const nohttps = await f.evaluate(() => ({ h1: document.querySelector('h1').textContent, text: document.body.textContent }));
  check(
    'HTTPS only: a site without HTTPS is not loaded in the clear',
    nohttps.h1 === 'No secure connection' && !seen.some((x) => /secure=1/.test(x.url)),
    nohttps.h1
  );
  await shot('nohttps');
  await f.click('[data-act="plain"]');
  f = await waitFrame(() => document.title === 'Page 2' && /secure=1/.test(document.getElementById('p2').textContent), null, 12000);
  check(
    '"Continue without HTTPS" is a choice for that site alone',
    (await state()).plain.join() === '127.0.0.1' && (await addrBar()) === SITE + '/page2?secure=1'
  );
  app.config.patch({ route: { https: false } });

  // ---- the server is away: the visitor sees Waddle's own page, never the host's
  await goTo(SITE + '/');
  f = await waitFrame(() => document.title === 'Fixture' && window.appLoaded === true);
  if (info.sw) {
    edge.down = true;
    await f.click('#link');
    f = await waitFrame(() => document.title === 'Reconnecting', null, 8000);
    check(
      'with the server away, the host’s error page is never shown: a reconnecting page is',
      edge.replaced > 0 && (await f.evaluate(() => !/Bad gateway/.test(document.body.textContent)))
    );
    await page.waitForFunction(() => !document.getElementById('away').hidden, { timeout: 6000 }).catch(() => {});
    check('the app says so too', await page.$eval('#away', (n) => !n.hidden && /Reconnecting/.test(n.textContent)));
    await shot('away');
    edge.down = false;
    f = await waitFrame(() => document.title === 'Page 2', null, 15000);
    check('and the page comes back by itself', (await addrBar()) === SITE + '/page2?x=1');
    await page.waitForFunction(() => document.getElementById('away').hidden, { timeout: 8000 }).catch(() => {});
    check('the notice goes away again', await page.$eval('#away', (n) => n.hidden));
  }

  // ---- no proxy, no page
  await goTo(SITE + '/');
  f = await waitFrame(() => document.title === 'Fixture' && window.appLoaded === true);
  app.pool.clear();
  const quietAt = seen.length;
  const dialled = px.log.length;
  await goTo(SITE + '/page2?noproxy=1');
  f = await waitFrame(() => !!document.querySelector('[data-act="proxies"]'), null, 8000);
  const none = await f.evaluate(() => document.querySelector('h1').textContent);
  await sleep(300);
  check(
    'with no proxy nothing is fetched: the site is not contacted, by any route',
    /^No prox/.test(none) && seen.length === quietAt && px.log.length === dialled && !seen.some((x) => /noproxy=1/.test(x.url)),
    { none, requests: seen.length - quietAt }
  );
  await shot('noproxy');
  await f.click('[data-act="proxies"]');
  await page.waitForSelector('#manual');
  check('the page’s button opens the Proxies tab', await page.$eval('#tabs button.on', (n) => n.textContent === 'Proxies'));
  await page.type('#manual', 'http://127.0.0.1:' + px.port);
  await page.evaluate(() => document.querySelector('#manual + .btns .btn').click());
  await kit.until(() => app.pool.alive.size === 1 && app.pool.summary().proxies[0].plain === true, 8000);
  await page.click('#reload');
  f = await waitFrame(() => document.title === 'Page 2' && /noproxy=1/.test(document.getElementById('p2').textContent), null, 12000);
  check('a proxy added by hand brings the page back', true);

  // ---- browser tabs, local library, inspection and frontend preferences
  await page.keyboard.press('Escape');
  await goTo(SITE + '/tour');
  f = await waitFrame(() => document.title === 'Field notes' && document.querySelector('img') && document.querySelector('img').complete);
  check('one browser tab starts open', (await page.$$eval('#tabbar .tabgroup', (n) => n.length)) === 1);
  await page.click('#newTab');
  await page.waitForFunction(() => document.querySelectorAll('#tabbar .tabgroup').length === 2);
  check('the plus button opens a second Waddle tab', (await page.$$eval('#tabbar .tabgroup', (n) => n.length)) === 2);
  await goTo(SITE + '/page2?tab=one');
  f = await waitFrame(() => document.title === 'Page 2' && /tab=one/.test(document.body.textContent));
  await goTo(SITE + '/page2?tab=two');
  f = await waitFrame(() => document.title === 'Page 2' && /tab=two/.test(document.body.textContent));
  await page.click('#back');
  await page.waitForFunction(() => document.getElementById('addr').value.endsWith('page2?tab=one'));
  check('each tab has its own back and forward history', true);
  await page.evaluate(() => document.querySelector('#tabbar .browser-tab').click());
  f = await waitFrame(() => document.title === 'Field notes');
  check('switching tabs restores the page in the first tab', (await addrBar()) === SITE + '/tour');
  await f.evaluate(() => {
    const a = document.createElement('a');
    a.id = 'open-in-waddle-tab';
    a.href = '/tour?from=new-tab';
    a.target = '_blank';
    a.textContent = 'Open a separate tab';
    document.body.appendChild(a);
  });
  await f.click('#open-in-waddle-tab');
  await page.waitForFunction(() => document.querySelectorAll('#tabbar .tabgroup').length === 3);
  await page.waitForFunction(() => document.getElementById('addr').value.includes('from=new-tab'));
  f = await waitFrame(() => document.title === 'Field notes');
  check(
    'a page link targeting a new window opens a Waddle tab',
    (await addrBar()).includes('from=new-tab') && (await page.$$eval('#tabbar .tabgroup', (n) => n.length)) === 3
  );
  check('the active tab shows its own exit status', await page.$eval('#tabbar .tabgroup.active .dot', (n) => n.classList.contains('ok')));
  await page.click('#bookmark');
  check(
    'the toolbar star adds a browser-local bookmark',
    await page.evaluate(() => WaddleLocal.get().bookmarks.some((x) => /from=new-tab/.test(x.url)))
  );
  await page.click('#library');
  await page.waitForSelector('#libraryPanel:not([hidden])');
  check('the library lists the saved bookmark', await page.$eval('#libraryContent', (n) => /from=new-tab/.test(n.textContent)));
  await page.type('#newFolder', 'Research');
  await page.click('#libraryContent .folder-tools .btn');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#libraryContent .library-select option')].some((x) => x.value === 'Research')
  );
  await page.select('#libraryContent .library-filters .library-select', 'All');
  await page.select('#libraryContent .folder-select', 'Research');
  check('bookmarks can be organised into folders', await page.$eval('#libraryContent', (n) => /Research/.test(n.textContent)));
  await shot('library');
  const exportText = await page.evaluate(async () => {
    const createObjectURL = URL.createObjectURL;
    let content = Promise.resolve('');
    URL.createObjectURL = function (blob) {
      content = blob.text();
      return createObjectURL.call(URL, blob);
    };
    try {
      [...document.querySelectorAll('#libraryContent button')].find((b) => b.textContent === 'Export JSON').click();
      return await content;
    } finally {
      URL.createObjectURL = createObjectURL;
    }
  });
  const exportData = JSON.parse(exportText);
  check(
    'bookmarks can be exported as JSON',
    exportData.format === 'waddle-bookmarks' && exportData.version === 1 && exportData.bookmarks.length > 0
  );
  const importFile = '/tmp/waddle-bookmark-import.json';
  fs.writeFileSync(
    importFile,
    JSON.stringify({
      format: 'waddle-bookmarks',
      version: 1,
      folders: ['Imported'],
      bookmarks: [{ url: 'https://example.org/read-later', title: 'Imported bookmark', folder: 'Imported' }],
    })
  );
  await (await page.$('#libraryContent input[type="file"]')).uploadFile(importFile);
  await page.waitForFunction(() => WaddleLocal.get().bookmarks.some((x) => x.url === 'https://example.org/read-later'));
  check('a browser bookmarks JSON file can be imported', true);
  const htmlImportFile = '/tmp/waddle-bookmark-import.html';
  fs.writeFileSync(
    htmlImportFile,
    '<!doctype NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://example.net/from-html">HTML bookmark</A></DL>'
  );
  await (await page.$('#libraryContent input[type="file"]')).uploadFile(htmlImportFile);
  await page.waitForFunction(() => WaddleLocal.get().bookmarks.some((x) => x.url === 'https://example.net/from-html'));
  check('browser bookmark HTML can be imported', true);
  await page.evaluate(() =>
    [...document.querySelectorAll('#libraryContent button')].find((b) => b.textContent === 'Save for later').click()
  );
  await page.click('#libraryTabs button:nth-child(2)');
  await page.waitForFunction(() => document.querySelector('#libraryContent').textContent.includes('Field notes'));
  check(
    'a page can be saved for later without downloading it',
    await page.$eval('#libraryContent', (n) => /Field notes/.test(n.textContent))
  );
  await page.click('#libraryTabs button:nth-child(3)');
  await page.waitForFunction(() => document.querySelectorAll('#libraryContent .library-entry').length > 0);
  await page.type('#libraryContent .library-search', 'Field notes');
  check('local history can be searched by page title', await page.$eval('#libraryContent', (n) => /Field notes/.test(n.textContent)));

  // A page's requests, upstream headers, cookies and rewritten source are available in the inspector.
  await page.keyboard.press('Escape');
  await goTo(SITE + '/');
  f = await waitFrame(() => document.title === 'Fixture' && window.appLoaded === true);
  await page.click('#library');
  await page.click('#libraryTabs button:nth-child(4)');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#inspectorBody .inspect-request')].some((n) => n.textContent.includes('/'))
  );
  await shot('inspect');
  check(
    'inspect lists requests with status, type, bytes, time and exit',
    await page.$eval('#inspectorBody', (n) => /200/.test(n.textContent) && /US/.test(n.textContent) && /ms/.test(n.textContent))
  );
  await page.click('#libraryContent .inspect-tabs button:nth-child(2)');
  check('inspect shows response headers', await page.$eval('#inspectorBody', (n) => /content-type/.test(n.textContent)));
  await page.click('#libraryContent .inspect-tabs button:nth-child(3)');
  await page.waitForFunction(() => document.querySelector('#inspectorBody').textContent.includes('sid'));
  check(
    'inspect shows cookie names and hides HttpOnly values',
    await page.$eval('#inspectorBody', (n) => /value hidden/.test(n.textContent))
  );
  await page.click('#libraryContent .inspect-tabs button:nth-child(4)');
  check(
    'inspect shows the rewritten page source without its private bootstrap',
    await page.$eval('#inspectorBody', (n) => /Fixture/.test(n.textContent) && /Waddle bootstrap omitted/.test(n.textContent))
  );
  await page.click('#libraryClose');

  // A start page built only from this browser's local library, with web suggestions off by default.
  await page.click('#home');
  await page.waitForFunction(() => !document.getElementById('homePicks').hidden);
  await page.type('#q', 'Field notes');
  await page.waitForSelector('#suggestions .suggest-item');
  await shot('recommendations');
  check(
    'local recommendations and address suggestions use this browser’s library',
    await page.$eval('#suggestions', (n) => /Bookmark|History|Saved|Open tab/.test(n.textContent))
  );
  check('external web suggestions are opt-in', await page.evaluate(() => WaddleLocal.preferences().externalSuggestions === false));
  await page.click('#gear');
  await tabTo('General');
  await shot('frontend-settings');
  await press('local.accent');
  await page.waitForSelector('#panel .dd-opt');
  await page.evaluate(() => [...document.querySelectorAll('#panel .dd-opt')].find((n) => n.textContent.trim() === 'Blue').click());
  check(
    'accent colour applies immediately and stays in this browser',
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#3578d4')
  );
  await press('local.density');
  await page.waitForSelector('#panel .dd-opt');
  await page.evaluate(() => [...document.querySelectorAll('#panel .dd-opt')].find((n) => n.textContent.trim() === 'Compact').click());
  await press('local.textSize');
  await page.waitForSelector('#panel .dd-opt');
  await page.evaluate(() => [...document.querySelectorAll('#panel .dd-opt')].find((n) => n.textContent.trim() === 'Large').click());
  check(
    'density and text size are configurable',
    await page.evaluate(
      () => document.documentElement.dataset.density === 'compact' && document.documentElement.dataset.textSize === 'large'
    )
  );
  await press('local.tabPosition');
  await page.waitForSelector('#panel .dd-opt');
  await page.evaluate(() =>
    [...document.querySelectorAll('#panel .dd-opt')].find((n) => n.textContent.trim() === 'Below the page').click()
  );
  check(
    'the browser tab strip can move below the page',
    await page.evaluate(
      () => document.body.dataset.tabPosition === 'bottom' && getComputedStyle(document.querySelector('#tabbar')).order === '4'
    )
  );
  await press('local.showStatus');
  check('start-page status chips can be hidden', await page.$eval('#chips', (n) => n.hidden));
  await press('local.showStatus');
  await press('local.showLinks');
  check('quick links can be hidden', await page.$eval('#links', (n) => n.hidden));
  await press('local.showLinks');
  await press('btn:Reset frontend settings');
  await page.waitForFunction(() => WaddleLocal.preferences().accent === 'orange' && WaddleLocal.preferences().tabPosition === 'top');
  check(
    'frontend preferences can be reset without changing server config',
    app.config.value.ui.theme === 'auto' && app.config.value.ui.links.length > 0
  );
  await page.click('#gear');

  // New identity clears history and site data, but keeps bookmarks and read-later items.
  await page.click('#fresh');
  await page.click('#fresh');
  await page.waitForFunction(() => WaddleLocal.get().history.length === 0);
  check('New identity clears local browsing history', await page.evaluate(() => WaddleLocal.get().history.length === 0));
  check(
    'New identity keeps bookmarks and saved pages',
    await page.evaluate(() => WaddleLocal.get().bookmarks.length > 0 && WaddleLocal.get().saved.length > 0)
  );
  check('New identity closes extra Waddle tabs', (await page.$$eval('#tabbar .tabgroup', (n) => n.length)) === 1);

  // A full migration backup moves both server settings and the browser-local shelf.
  await page.click('#gear');
  await tabTo('General');
  await page.waitForSelector('#panel [data-k="btn:Export full backup"]');
  const backupText = await page.evaluate(async () => {
    const original = URL.createObjectURL;
    let resolveText;
    const content = new Promise((resolve) => {
      resolveText = resolve;
    });
    URL.createObjectURL = function (blob) {
      blob.text().then(resolveText);
      return original.call(URL, blob);
    };
    try {
      document.querySelector('[data-k="btn:Export full backup"]').click();
      return await content;
    } finally {
      URL.createObjectURL = original;
    }
  });
  const fullBackup = JSON.parse(backupText);
  check(
    'a full backup contains server settings, the local library and tabs but no session cookies',
    fullBackup.format === 'waddle-backup' &&
      fullBackup.version === 1 &&
      fullBackup.config &&
      fullBackup.browser.library.bookmarks.length > 0 &&
      Array.isArray(fullBackup.tabs) &&
      !('cookies' in fullBackup)
  );
  await page.evaluate(() => WaddleLocal.savePreferences({ accent: 'blue' }));
  app.config.patch({ ui: { theme: 'dark' } });
  const migrationFile = '/tmp/waddle-full-backup.json';
  fs.writeFileSync(migrationFile, backupText);
  page.once('dialog', (dialog) => dialog.accept());
  const restoreNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 });
  await (await page.$('#panel input[aria-label="Restore a Waddle backup"]')).uploadFile(migrationFile);
  await restoreNavigation;
  await page.waitForFunction(() => window.WaddleLocal && document.querySelectorAll('#chips .pill').length >= 4, { timeout: 8000 });
  check(
    'restoring a backup migrates local preferences and replaces server settings',
    app.config.value.ui.theme === fullBackup.config.ui.theme &&
      (await page.evaluate(() => WaddleLocal.preferences().accent)) === fullBackup.browser.preferences.accent
  );

  await page.keyboard.press('Escape');

  // ---- nothing reached the fixture except through the exit
  const direct = seen.filter((x) => /HeadlessChrome/.test(x.headers['user-agent'] || '') || (x.headers['user-agent'] || '') === realUA);
  check(
    'no request reached the site with the real browser’s user agent',
    direct.length === 0,
    direct.map((x) => x.url)
  );
  const told = seen.filter((x) => [x.headers.referer, x.headers.origin].some((v) => v && v.includes('localhost:' + front.address().port)));
  check(
    'no request told the site where Waddle runs',
    told.length === 0,
    told.map((x) => x.url)
  );
  check('every connection the site ever got came through the exit', siteConnections === tunnels(), {
    connections: siteConnections,
    tunnels: tunnels(),
  });
  check(
    'Waddle never answered with a status that a host’s edge replaces with its own page',
    edge.edgeStatuses.length === 0,
    edge.edgeStatuses.slice(0, 5)
  );
  check('no uncaught errors in the page', errors.length === 0, errors.slice(0, 3));
  check('no uncaught errors on the tour page', tourErrors.length === 0, tourErrors.slice(0, 3));
} catch (e) {
  check('run completed', false, String((e && e.stack) || e));
  await shot('failure');
} finally {
  await browser.close();
  await app.close();
  for (const s of frontSockets) s.destroy();
  front.close();
  for (const s of siteSockets) s.destroy();
  site.close();
  require(path.join(root, 'lib/net.js')).dropAgents();
  await kit.closeAll();
}
if (process.env.VERBOSE === '1') {
  console.log('--- responses >= 400, failed requests and console errors');
  for (const b of [...new Set(bad)].slice(0, 80)) console.log('   ' + b);
}
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
