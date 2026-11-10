'use strict';
// Settings: defaults, validation, persistence, and spoof-profile resolution.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.WADDLE_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const gh = (repo) => ({ type: 'github', repo, on: true });
const web = (url, proto) => ({ type: 'url', url, proto: proto || null, on: true });

const DEFAULTS = {
  route: {
    mode: 'auto', // auto: rotating proxies, direct when none work | proxy: proxies only | direct
    rotate: 'sticky', // sticky: one exit per site | request: new exit every request | timed
    minutes: 10, // how long a sticky / timed exit is kept
    retries: 2, // other proxies to try before giving up (or going direct in auto)
    protocols: ['http', 'socks4', 'socks5'],
    countries: [], // ISO codes, empty = anywhere
    timeout: 20000,
    hops: 1, // proxies chained per connection (1-3): entry -> … -> exit
    // Per-site routing, first match wins: "<host pattern> <direct|proxy|auto|block> [CC,CC] [hops=N]"
    rules: [],
  },
  dns: {
    mode: 'doh', // doh: encrypted DNS from the stack below | system: the host's resolver
    strategy: 'fallback', // fallback: in order | race: all at once, fastest wins | rotate: spread lookups
    servers: ['https://cloudflare-dns.com/dns-query', 'https://dns.quad9.net/dns-query', 'https://dns.google/dns-query'],
    fallback: true, // use the system resolver when the whole stack fails
    remote: true, // behind a proxy, let the exit resolve names (false: resolve here, connect by IP)
  },
  pool: {
    on: true,
    target: 40, // live proxies to keep on hand
    concurrency: 80,
    checkTimeout: 7000,
    harvestMinutes: 30,
    recheckMinutes: 4,
    perSource: 10000,
    discover: true, // search GitHub + GitLab for list repos nobody told us about
    discoverMax: 10,
    judge: 'https://www.cloudflare.com/cdn-cgi/trace',
    sources: [
      gh('monosans/proxy-list'),
      gh('TheSpeedX/PROXY-List'),
      gh('proxifly/free-proxy-list'),
      gh('hookzof/socks5_list'),
      gh('roosterkid/openproxylist'),
      gh('mmpx12/proxy-list'),
      gh('iplocate/free-proxy-list'),
      gh('elliottophellia/proxylist'),
      gh('ProxyScrape/free-proxy-list'),
      gh('zloi-user/hideip.me'),
      gh('vakhov/fresh-proxy-list'),
      gh('sunny9577/proxy-scraper'),
      gh('Zaeem20/FREE_PROXIES_LIST'),
      gh('ProxyScraper/ProxyScraper'),
      gh('MrMarble/proxy-list'),
      gh('themiralay/Proxy-List-World'),
      gh('Vann-Dev/proxy-list'),
      gh('dpangestuw/Free-Proxy'),
      gh('Anonym0usWork1221/Free-Proxies'),
      gh('VPSLabCloud/VPSLab-Free-Proxy-List'),
      web('https://solproxy.net/free-proxy-list/api.json', 'http'),
      web('https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text'),
      web('https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc'),
      web('https://spys.me/proxy.txt', 'http'),
      web('https://spys.me/socks.txt', 'socks5'),
      web('https://free-proxy-list.net/', 'http'),
      web('https://api.openproxylist.xyz/http.txt', 'http'),
    ],
  },
  spoof: {
    on: true,
    system: 'win-chrome', // preset id | random | custom | real
    customUa: '',
    customPlatform: '',
    languages: 'en-US,en', // '' = real
    timezone: '', // IANA zone, '' = real
    screen: 'real', // real | WxH@dpr
    viewport: 'window', // window | screen (lock the page to the spoofed screen's shape)
    theme: 'real', // real | light | dark
    motion: 'real', // real | reduce | no-preference
    network: 'real', // real | wifi | 4g | 3g | 2g | slow-2g
    saveData: false,
    webrtc: 'block', // block | real
    dnt: true,
    referer: 'origin', // full | origin | none   (what other sites see)
    canvas: 'noise', // real | noise | block
    webgl: 'spoof', // real | spoof
    audio: 'noise', // real | noise
    rects: 'real', // real | noise
    fonts: 'real', // real | limit
    devices: 'spoof', // real | spoof  (media devices, battery, plugins, voices)
  },
  ui: {
    search: 'https://duckduckgo.com/html/?q=%s',
  },
};

const ENUMS = {
  'dns.mode': ['doh', 'system'],
  'dns.strategy': ['fallback', 'race', 'rotate'],
  'route.mode': ['auto', 'proxy', 'direct'],
  'route.rotate': ['sticky', 'request', 'timed'],
  'spoof.viewport': ['window', 'screen'],
  'spoof.theme': ['real', 'light', 'dark'],
  'spoof.motion': ['real', 'reduce', 'no-preference'],
  'spoof.network': ['real', 'wifi', '4g', '3g', '2g', 'slow-2g'],
  'spoof.webrtc': ['block', 'real'],
  'spoof.referer': ['full', 'origin', 'none'],
  'spoof.canvas': ['real', 'noise', 'block'],
  'spoof.webgl': ['real', 'spoof'],
  'spoof.audio': ['real', 'noise'],
  'spoof.rects': ['real', 'noise'],
  'spoof.fonts': ['real', 'limit'],
  'spoof.devices': ['real', 'spoof'],
};
const RANGES = {
  'route.hops': [1, 3],
  'route.minutes': [1, 1440],
  'route.retries': [0, 8],
  'route.timeout': [3000, 120000],
  'pool.target': [1, 500],
  'pool.concurrency': [1, 400],
  'pool.checkTimeout': [1500, 30000],
  'pool.harvestMinutes': [5, 1440],
  'pool.recheckMinutes': [1, 120],
  'pool.perSource': [100, 200000],
  'pool.discoverMax': [0, 50],
};

// ---- browser identities ------------------------------------------------------

const DAY = 864e5;
// Stable-channel estimates from the release cadence, so the claimed version never goes stale.
const chromeMajor = (now) => 143 + Math.max(0, Math.floor((now - Date.UTC(2025, 11, 2)) / (32 * DAY)));
const firefoxMajor = (now) => 145 + Math.max(0, Math.floor((now - Date.UTC(2025, 10, 11)) / (28 * DAY)));
function safariVersion(now) {
  const months = Math.max(0, Math.floor((now - Date.UTC(2025, 8, 15)) / (30.44 * DAY)));
  return 26 + Math.floor(months / 12) + '.' + Math.min(4, Math.floor((months % 12) / 2.5));
}

/** Chromium's GREASE algorithm for the Sec-CH-UA brand list. */
function chromeBrands(major, brand) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const grease = { brand: 'Not' + chars[major % 11] + 'A' + chars[(major + 1) % 11] + 'Brand', version: ['8', '99', '24'][major % 3] };
  const list = [grease, { brand: 'Chromium', version: String(major) }, { brand, version: String(major) }];
  const order = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ][major % 6];
  const out = [];
  list.forEach((b, i) => {
    out[order[i]] = b;
  });
  return out;
}

const GL = {
  win: ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  winIntel: ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  mac: ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
  linux: ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'],
  android: ['Google Inc. (Qualcomm)', 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)'],
  apple: ['Apple Inc.', 'Apple GPU'],
  ffWin: ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar'],
  ffLinux: ['Mesa', 'Mesa Intel(R) UHD Graphics 620 (KBL GT2), or similar'],
};

const SYSTEMS = {
  'win-chrome': {
    label: 'Windows · Chrome',
    os: 'Windows NT 10.0; Win64; x64',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'Win32',
    chPlatform: 'Windows',
    chVersion: '19.0.0',
    arch: 'x86',
    cores: 12,
    memory: 8,
    gl: GL.win,
  },
  'win-edge': {
    label: 'Windows · Edge',
    os: 'Windows NT 10.0; Win64; x64',
    engine: 'chromium',
    brand: 'Microsoft Edge',
    platform: 'Win32',
    chPlatform: 'Windows',
    chVersion: '19.0.0',
    arch: 'x86',
    cores: 8,
    memory: 8,
    gl: GL.winIntel,
  },
  'win-firefox': {
    label: 'Windows · Firefox',
    os: 'Windows NT 10.0; Win64; x64',
    engine: 'gecko',
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    cores: 8,
    gl: GL.ffWin,
  },
  'mac-chrome': {
    label: 'macOS · Chrome',
    os: 'Macintosh; Intel Mac OS X 10_15_7',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'MacIntel',
    chPlatform: 'macOS',
    chVersion: '15.6.1',
    arch: 'arm',
    cores: 8,
    memory: 8,
    gl: GL.mac,
  },
  'mac-safari': {
    label: 'macOS · Safari',
    os: 'Macintosh; Intel Mac OS X 10_15_7',
    engine: 'webkit',
    platform: 'MacIntel',
    cores: 8,
    gl: GL.apple,
  },
  'linux-chrome': {
    label: 'Linux · Chrome',
    os: 'X11; Linux x86_64',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'Linux x86_64',
    chPlatform: 'Linux',
    chVersion: '6.8.0',
    arch: 'x86',
    cores: 8,
    memory: 8,
    gl: GL.linux,
  },
  'linux-firefox': {
    label: 'Linux · Firefox',
    os: 'X11; Linux x86_64',
    engine: 'gecko',
    platform: 'Linux x86_64',
    oscpu: 'Linux x86_64',
    cores: 8,
    gl: GL.ffLinux,
  },
  'android-chrome': {
    label: 'Android · Chrome',
    os: 'Linux; Android 10; K',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'Linux armv81',
    chPlatform: 'Android',
    chVersion: '15.0.0',
    arch: '',
    mobile: true,
    model: 'Pixel 8',
    cores: 8,
    memory: 8,
    touch: 5,
    gl: GL.android,
  },
  'iphone-safari': {
    label: 'iPhone · Safari',
    os: 'iPhone; CPU iPhone OS 18_6 like Mac OS X',
    engine: 'webkit',
    platform: 'iPhone',
    mobile: true,
    cores: 4,
    touch: 5,
    gl: GL.apple,
  },
};
const RANDOM_POOL = ['win-chrome', 'win-edge', 'win-firefox', 'mac-chrome', 'mac-safari', 'linux-chrome', 'linux-firefox'];

const NETWORKS = {
  wifi: { effectiveType: '4g', downlink: 10, rtt: 50, type: 'wifi' },
  '4g': { effectiveType: '4g', downlink: 7.4, rtt: 100, type: 'cellular' },
  '3g': { effectiveType: '3g', downlink: 1.35, rtt: 300, type: 'cellular' },
  '2g': { effectiveType: '2g', downlink: 0.25, rtt: 1350, type: 'cellular' },
  'slow-2g': { effectiveType: 'slow-2g', downlink: 0.05, rtt: 2100, type: 'cellular' },
};

const SCREENS = [
  '1920x1080@1',
  '2560x1440@1',
  '1366x768@1',
  '1536x864@1.25',
  '1440x900@2',
  '1680x1050@1',
  '2560x1600@2',
  '1280x1024@1',
  '1024x768@1',
  '3440x1440@1',
  '3840x2160@1.5',
  '390x844@3',
  '412x915@2.625',
  '820x1180@2',
];

function buildSystem(id, now) {
  const s = SYSTEMS[id];
  const nav = { engine: s.engine, platform: s.platform, cores: s.cores, touch: s.touch || 0, mobile: !!s.mobile, gl: s.gl };
  if (s.engine === 'chromium') {
    const v = chromeMajor(now);
    const edge = s.brand === 'Microsoft Edge';
    nav.ua =
      'Mozilla/5.0 (' +
      s.os +
      ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
      v +
      '.0.0.0' +
      (s.mobile ? ' Mobile' : '') +
      ' Safari/537.36' +
      (edge ? ' Edg/' + v + '.0.0.0' : '');
    nav.vendor = 'Google Inc.';
    nav.productSub = '20030107';
    nav.memory = s.memory;
    nav.uaData = {
      brands: chromeBrands(v, s.brand),
      mobile: !!s.mobile,
      platform: s.chPlatform,
      platformVersion: s.chVersion,
      architecture: s.arch,
      bitness: s.arch ? '64' : '',
      model: s.model || '',
      uaFullVersion: v + '.0.0.0',
      wow64: false,
      fullVersionList: chromeBrands(v, s.brand).map((b) => ({
        brand: b.brand,
        version: /^Not/.test(b.brand) ? b.version + '.0.0.0' : v + '.0.0.0',
      })),
    };
  } else if (s.engine === 'gecko') {
    const v = firefoxMajor(now);
    nav.ua = 'Mozilla/5.0 (' + s.os + '; rv:' + v + '.0) Gecko/20100101 Firefox/' + v + '.0';
    nav.vendor = '';
    nav.productSub = '20100101';
    nav.oscpu = s.oscpu;
  } else {
    const v = safariVersion(now);
    nav.ua =
      'Mozilla/5.0 (' +
      s.os +
      ') AppleWebKit/605.1.15 (KHTML, like Gecko) Version/' +
      v +
      (s.mobile ? ' Mobile/15E148 Safari/604.1' : ' Safari/605.1.15');
    nav.vendor = 'Apple Computer, Inc.';
    nav.productSub = '20030107';
  }
  nav.appVersion =
    nav.engine === 'gecko'
      ? '5.0 (' + (s.os.startsWith('Windows') ? 'Windows' : s.os.startsWith('Mac') ? 'Macintosh' : 'X11') + ')'
      : nav.ua.replace(/^Mozilla\//, '');
  return nav;
}

function parseScreen(v) {
  const m = /^(\d{3,5})x(\d{3,5})(?:@(\d(?:\.\d+)?))?$/.exec(String(v || ''));
  if (!m) return null;
  const w = +m[1],
    h = +m[2],
    dpr = +(m[3] || 1);
  if (w < 240 || h < 240 || w > 10000 || h > 10000 || dpr < 0.5 || dpr > 5) return null;
  const mobile = w < 600;
  // What a maximised browser would report on that display.
  const ah = mobile ? h : h - 40;
  return { w, h, dpr, aw: w, ah, iw: w, ih: mobile ? h - 110 : ah - 87, depth: 24 };
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Turn the saved spoof settings into the concrete identity one session presents:
 * `page` goes to the injected script, `headers` go on upstream requests.
 */
function resolveSpoof(spoof, seed, now = Date.now()) {
  if (!spoof.on) return { page: { on: false }, headers: {} };
  let nav = null;
  let id = spoof.system;
  if (id === 'random') id = RANDOM_POOL[hash32('sys' + seed) % RANDOM_POOL.length];
  if (SYSTEMS[id]) nav = buildSystem(id, now);
  else if (id === 'custom' && spoof.customUa.trim()) {
    const ua = spoof.customUa.trim();
    const engine = /Firefox\//.test(ua) ? 'gecko' : /Chrome\//.test(ua) ? 'chromium' : 'webkit';
    const base = buildSystem(engine === 'gecko' ? 'win-firefox' : engine === 'chromium' ? 'win-chrome' : 'mac-safari', now);
    nav = Object.assign(base, { ua, appVersion: ua.replace(/^Mozilla\//, ''), uaData: null });
    nav.platform =
      spoof.customPlatform.trim() ||
      (/Windows/.test(ua)
        ? 'Win32'
        : /Mac/.test(ua)
          ? 'MacIntel'
          : /iPhone/.test(ua)
            ? 'iPhone'
            : /Android/.test(ua)
              ? 'Linux armv81'
              : 'Linux x86_64');
    nav.mobile = /Mobile|Android|iPhone/.test(ua);
  }
  const languages = spoof.languages
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const net = NETWORKS[spoof.network] || null;
  const page = {
    on: true,
    seed: hash32('fp' + seed),
    nav,
    languages: languages.length ? languages : null,
    tz: spoof.timezone || null,
    screen: parseScreen(spoof.screen),
    viewport: spoof.viewport === 'screen',
    theme: spoof.theme === 'real' ? null : spoof.theme,
    motion: spoof.motion === 'real' ? null : spoof.motion,
    net: net ? Object.assign({ saveData: !!spoof.saveData }, net) : spoof.saveData ? { saveData: true } : null,
    webrtc: spoof.webrtc,
    dnt: !!spoof.dnt,
    canvas: spoof.canvas,
    webgl: spoof.webgl,
    audio: spoof.audio,
    rects: spoof.rects,
    fonts: spoof.fonts,
    devices: spoof.devices,
  };
  const headers = {};
  if (nav) {
    headers['user-agent'] = nav.ua;
    if (nav.uaData) {
      headers['sec-ch-ua'] = nav.uaData.brands.map((b) => '"' + b.brand + '";v="' + b.version + '"').join(', ');
      headers['sec-ch-ua-mobile'] = nav.mobile ? '?1' : '?0';
      headers['sec-ch-ua-platform'] = '"' + nav.uaData.platform + '"';
    } else {
      headers['sec-ch-ua'] = null;
      headers['sec-ch-ua-mobile'] = null;
      headers['sec-ch-ua-platform'] = null;
    }
  }
  if (languages.length) {
    headers['accept-language'] = languages.map((l, i) => (i ? l + ';q=' + Math.max(0.1, 1 - i * 0.1).toFixed(1) : l)).join(',');
  }
  if (spoof.dnt) {
    headers.dnt = '1';
    headers['sec-gpc'] = '1';
  }
  if (spoof.saveData) headers['save-data'] = 'on';
  return { page, headers };
}

// ---- load / save / patch -----------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));

function cleanSource(s) {
  if (!s || typeof s !== 'object') return null;
  const on = s.on !== false;
  if ((s.type === 'github' || s.type === 'gitlab') && typeof s.repo === 'string') {
    const repo = s.repo
      .trim()
      .replace(/^https?:\/\/(www\.)?git(hub|lab)\.com\//i, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo) || repo.length > 200) return null;
    const out = { type: s.type, repo, on };
    if (typeof s.branch === 'string' && /^[\w./-]{1,100}$/.test(s.branch)) out.branch = s.branch;
    if (s.found) out.found = true;
    return out;
  }
  if (s.type === 'url' && typeof s.url === 'string') {
    let u;
    try {
      u = new URL(s.url.trim());
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const proto = ['http', 'socks4', 'socks5'].includes(s.proto) ? s.proto : null;
    return { type: 'url', url: u.href, proto, on };
  }
  return null;
}

/** "owner/repo", a github/gitlab URL, or any list URL -> source object. */
function parseSource(text, proto) {
  const t = String(text || '').trim();
  if (!t || t.length > 500) return null;
  // Repository pages, with or without a branch: github.com/owner/repo[/tree/branch/…]
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([\w.-]+)(?:\/.*)?)?\/?$/i.exec(t);
  if (m) return cleanSource({ type: 'github', repo: m[1], branch: m[2] });
  m = /^(?:https?:\/\/)?(?:www\.)?gitlab\.com\/([\w.-]+(?:\/[\w.-]+)+?)(?:\.git)?(?:\/-\/(?:tree|blob)\/([\w.-]+)(?:\/.*)?)?\/?$/i.exec(t);
  if (m) return cleanSource({ type: 'gitlab', repo: m[1], branch: m[2] });
  // GitHub owners cannot contain dots, so "spys.me/proxy.txt" is a URL, not a repo.
  if (/^[A-Za-z0-9-]+\/[\w.-]+$/.test(t)) return cleanSource({ type: 'github', repo: t });
  if (/^gitlab:/i.test(t)) return cleanSource({ type: 'gitlab', repo: t.slice(7) });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) return null;
  if (/\s/.test(t) || !/^(?:https?:\/\/)?[^/\s]+\.[^/\s]+/i.test(t)) return null; // needs to look like an address
  return cleanSource({ type: 'url', url: /^https?:\/\//i.test(t) ? t : 'https://' + t, proto });
}
const DNS_PRESETS = [
  { id: 'cloudflare', label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { id: 'cloudflare-security', label: 'Cloudflare (malware blocking)', url: 'https://security.cloudflare-dns.com/dns-query' },
  { id: 'quad9', label: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
  { id: 'google', label: 'Google', url: 'https://dns.google/dns-query' },
  { id: 'adguard', label: 'AdGuard (ad blocking)', url: 'https://dns.adguard-dns.com/dns-query' },
  { id: 'adguard-plain', label: 'AdGuard (unfiltered)', url: 'https://unfiltered.adguard-dns.com/dns-query' },
  { id: 'mullvad', label: 'Mullvad', url: 'https://dns.mullvad.net/dns-query' },
  { id: 'mullvad-adblock', label: 'Mullvad (ad blocking)', url: 'https://adblock.dns.mullvad.net/dns-query' },
  { id: 'opendns', label: 'OpenDNS', url: 'https://doh.opendns.com/dns-query' },
  { id: 'dnssb', label: 'DNS.SB', url: 'https://doh.dns.sb/dns-query' },
  { id: 'controld', label: 'Control D', url: 'https://freedns.controld.com/p0' },
  { id: 'wikimedia', label: 'Wikimedia', url: 'https://wikimedia-dns.org/dns-query' },
];

/** A DoH endpoint: preset id or https URL. */
function cleanDns(text) {
  const t = String(text || '').trim();
  const preset = DNS_PRESETS.find((d) => d.id === t.toLowerCase());
  if (preset) return preset.url;
  if (!t || t.length > 300 || /\s/.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
    if (u.protocol !== 'https:' && process.env.WADDLE_ALLOW_PRIVATE !== '1') return null;
    if (!u.hostname.includes('.') && process.env.WADDLE_ALLOW_PRIVATE !== '1') return null;
    if (u.pathname === '/') u.pathname = '/dns-query';
    return u.href;
  } catch {
    return null;
  }
}

/**
 * "<host pattern> <direct|proxy|auto|block> [CC,CC] [hops=N]"
 * Patterns: example.com (and its subdomains), *.example.com, *tracker*, * (everything).
 */
/** Wildcard match in linear-ish time ('*' = any run of characters); no regex, so no backtracking blow-ups. */
function glob(p, s) {
  let pi = 0,
    si = 0,
    star = -1,
    mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === s[si]) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

/** "<host pattern> <direct|proxy|auto|block> [CC,CC] [hops=N]" -> rule, or null when it makes no sense. */
function parseRule(text) {
  const parts = String(text || '')
    .trim()
    .split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return null;
  const pattern = parts[0]
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const via = parts[1].toLowerCase();
  if (!pattern || pattern.length > 120 || !/^[a-z0-9.*:_-]+$/.test(pattern) || !['direct', 'proxy', 'auto', 'block'].includes(via))
    return null;
  const rule = { pattern, via, countries: [], hops: 0 };
  for (const extra of parts.slice(2)) {
    const h = /^hops=(\d{1,2})$/i.exec(extra);
    if (h) rule.hops = Math.max(1, Math.min(3, Number(h[1])));
    else if (/^[A-Za-z]{2}(,[A-Za-z]{2}){0,30}$/.test(extra)) rule.countries = extra.toUpperCase().split(',');
    else return null;
  }
  // A plain name covers the site and everything under it; a pattern with * is matched as written.
  rule.test = pattern.includes('*') ? (host) => glob(pattern, host) : (host) => host === pattern || host.endsWith('.' + pattern);
  return rule;
}
const ruleCache = new Map();
/** First rule matching `host`, or null. */
function matchRule(rules, host) {
  host = String(host || '').toLowerCase();
  for (const text of rules || []) {
    let r = ruleCache.get(text);
    if (r === undefined) {
      r = parseRule(text);
      if (ruleCache.size > 2000) ruleCache.clear();
      ruleCache.set(text, r);
    }
    if (r && r.test(host)) return r;
  }
  return null;
}

function merge(base, patch, trail) {
  for (const key of Object.keys(patch || {})) {
    if (!(key in base)) continue;
    const at = trail ? trail + '.' + key : key;
    const cur = base[key];
    let val = patch[key];
    if (at === 'pool.sources') {
      if (!Array.isArray(val)) continue;
      const seen = new Set();
      base[key] = val
        .map(cleanSource)
        .filter((s) => {
          if (!s) return false;
          const id = s.type + ':' + (s.repo || s.url).toLowerCase();
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, 300);
    } else if (Array.isArray(cur)) {
      if (!Array.isArray(val)) continue;
      val = val
        .filter((x) => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean);
      if (at === 'route.protocols') val = val.filter((x) => ['http', 'socks4', 'socks5'].includes(x));
      if (at === 'route.countries') val = val.map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
      if (at === 'route.rules') val = val.filter((x) => x.length < 300 && parseRule(x));
      if (at === 'dns.servers') val = val.map(cleanDns).filter(Boolean).slice(0, 8);
      base[key] = [...new Set(val)].slice(0, 100);
    } else if (cur && typeof cur === 'object') {
      if (val && typeof val === 'object') merge(cur, val, at);
    } else if (typeof cur === 'boolean') {
      if (typeof val === 'boolean') base[key] = val;
    } else if (typeof cur === 'number') {
      val = Number(val);
      if (!Number.isFinite(val)) continue;
      const r = RANGES[at];
      base[key] = r ? Math.min(r[1], Math.max(r[0], Math.round(val))) : val;
    } else if (typeof cur === 'string') {
      if (typeof val !== 'string' || val.length > 2000) continue;
      val = val.trim();
      if (ENUMS[at] && !ENUMS[at].includes(val)) continue;
      if (at === 'spoof.system' && !SYSTEMS[val] && !['random', 'custom', 'real'].includes(val)) continue;
      if (at === 'spoof.screen' && val !== 'real' && !parseScreen(val)) continue;
      if (at === 'spoof.timezone' && val) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: val });
        } catch {
          continue;
        }
      }
      if (at === 'pool.judge' || at === 'ui.search') {
        try {
          if (!/^https?:$/.test(new URL(val.replace('%s', 'x')).protocol)) continue;
        } catch {
          continue;
        }
        if (at === 'ui.search' && !val.includes('%s')) continue;
      }
      base[key] = val;
    }
  }
  return base;
}

class Config {
  constructor() {
    this.value = clone(DEFAULTS);
    this.listeners = [];
    try {
      merge(this.value, JSON.parse(fs.readFileSync(FILE, 'utf8')), '');
    } catch {
      /* first run */
    }
  }
  patch(p) {
    merge(this.value, p, '');
    this.save();
    for (const fn of this.listeners) fn(this.value);
    return this.value;
  }
  reset() {
    this.value = clone(DEFAULTS);
    this.save();
    for (const fn of this.listeners) fn(this.value);
    return this.value;
  }
  onChange(fn) {
    this.listeners.push(fn);
  }
  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(this.value, null, 2));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) {
      console.error('config save failed:', e.message);
    }
  }
}

const options = {
  systems: Object.keys(SYSTEMS).map((id) => ({ id, label: SYSTEMS[id].label })),
  screens: SCREENS,
  networks: Object.keys(NETWORKS),
  dns: DNS_PRESETS,
};

module.exports = {
  Config,
  DEFAULTS,
  DATA_DIR,
  resolveSpoof,
  parseSource,
  cleanSource,
  parseScreen,
  parseRule,
  matchRule,
  cleanDns,
  chromeBrands,
  hash32,
  options,
};
