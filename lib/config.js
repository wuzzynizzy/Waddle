'use strict';
// Settings: defaults, validation, persistence, and spoof-profile resolution.

const fs = require('fs');
const path = require('path');

const { place, COUNTRIES } = require('./geo');

const DATA_DIR = process.env.WADDLE_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const gh = (repo) => ({ type: 'github', repo, on: true });
const web = (url, proto) => ({ type: 'url', url, proto: proto || null, on: true });

const SEARCH = [
  { id: 'ddg', label: 'DuckDuckGo', url: 'https://duckduckgo.com/html/?q=%s' },
  { id: 'brave', label: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  { id: 'startpage', label: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  { id: 'mojeek', label: 'Mojeek', url: 'https://www.mojeek.com/search?q=%s' },
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search?q=%s' },
];

const SMALL_PROFILE = process.env.WADDLE_PROFILE === 'small';

const DEFAULTS = {
  route: {
    rotate: 'sticky', // sticky: one exit per site | request: new exit every request | timed
    minutes: 10, // how long a sticky / timed exit is kept
    hops: 1, // proxies chained per connection (1-16): entry -> … -> exit
    shorten: true, // when a chain of that length cannot be built or breaks, try a shorter one
    spread: true, // put the hops of a chain in different countries when the pool allows
    entry: [], // ISO codes the first hop may be in, empty = anywhere
    countries: [], // ISO codes the exit may be in, empty = anywhere
    protocols: ['http', 'socks4', 'socks5'],
    retries: 3, // other exits to try before giving up
    timeout: 20000,
    https: true, // HTTPS only: plain-HTTP addresses are upgraded, and refused when the site has no HTTPS
    // Per-site routing, first match wins: "<host pattern> <proxy|block> [CC,CC] [hops=N]"
    rules: [],
  },
  dns: {
    mode: 'auto', // auto: the exit looks names up, the stack takes over when it cannot | stack | exit
    strategy: 'fallback', // fallback: in order | race: fastest wins | rotate | split: one resolver per site | check: two must agree
    parallel: 2, // resolvers asked at once by "race" and "check"
    pad: true, // pad every question to a fixed size (RFC 8467) so its length gives nothing away
    servers: ['https://cloudflare-dns.com/dns-query', 'https://dns.quad9.net/dns-query', 'https://dns.google/dns-query'],
    auto: true, // keep a tested list of public no-log, no-filter resolvers behind the stack
    keep: 6, // how many of those to keep
    refreshHours: 24,
    feeds: [
      'https://raw.githubusercontent.com/DNSCrypt/dnscrypt-resolvers/master/v3/public-resolvers.md',
      'https://cdn.jsdelivr.net/gh/DNSCrypt/dnscrypt-resolvers@master/v3/public-resolvers.md',
      'https://download.dnscrypt.info/resolvers-list/v3/public-resolvers.md',
      'https://api.github.com/repos/DNSCrypt/dnscrypt-resolvers/contents/v3/public-resolvers.md',
    ],
    fallback: true, // the system resolver may look up list and resolver hosts (never visited sites) when the stack is unreachable
  },
  pool: {
    on: true, // harvest on a schedule
    target: SMALL_PROFILE ? 24 : 40, // live proxies to keep on hand
    concurrency: SMALL_PROFILE ? 12 : 80,
    checkTimeout: 7000,
    harvestMinutes: 30,
    recheckMinutes: 4,
    adaptive: true, // harvest sooner while short of proxies, later while full
    perSource: SMALL_PROFILE ? 2500 : 10000,
    discover: true, // search GitHub + GitLab for list repos nobody told us about
    discoverMax: SMALL_PROFILE ? 10 : 20,
    judge: 'https://www.cloudflare.com/cdn-cgi/trace',
    // A plain-HTTP page that answers with the request headers it received: shows what a proxy adds. Empty = skip.
    echo: 'http://httpbin.org/headers?show_env=1',
    // Known plain-HTTP pages ("<address> <expected text>"): a proxy that changes one is dropped,
    // one that cannot fetch any is kept for HTTPS only.
    canaries: [
      'http://detectportal.firefox.com/success.txt success',
      'http://captive.apple.com/hotspot-detect.html <HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>',
      'http://www.msftconnecttest.com/connecttest.txt Microsoft Connect Test',
    ],
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
      gh('officialputuid/KangProxy'),
      gh('ALIILAPRO/Proxy'),
      gh('Skillter/ProxyGather'),
      gh('fyvri/fresh-proxy-list'),
      gh('watchttvv/free-proxy-list'),
      gh('SoliSpirit/proxy-list'),
      gh('Tsprnay/Proxy-lists'),
      gh('hproxy-com/free-proxy-list'),
      gh('Thordata/awesome-free-proxy-list'),
      gh('vmheaven/VMHeaven.io-Free-Proxy-List'),
      web('https://solproxy.net/free-proxy-list/api.json', 'http'),
      web('https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text'),
      web('https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc'),
      web('https://spys.me/proxy.txt', 'http'),
      web('https://spys.me/socks.txt', 'socks5'),
      web('https://free-proxy-list.net/', 'http'),
      web('https://api.openproxylist.xyz/http.txt', 'http'),
      web('https://www.sslproxies.org/', 'http'),
      web('https://www.socks-proxy.net/', 'socks4'),
    ],
  },
  spoof: {
    on: true,
    system: 'win-chrome', // identity on a computer: preset id | custom | real
    phone: 'auto', // identity in mobile mode: auto (the phone that matches this browser) | preset id
    mobile: false, // mobile mode: a phone identity and a phone-sized page
    random: 'off', // off | session | site | timer   (a new, complete identity that often)
    randomMinutes: 30,
    match: true, // the randomizer keeps to identities this browser can pass for
    customUa: '',
    customPlatform: '',
    languages: 'exit', // exit: the exit country's | real | a list such as "en-US,en"
    timezone: 'exit', // exit: the exit country's | real | an IANA zone
    geo: 'block', // block | exit: a position in the exit country | real
    screen: 'auto', // auto: the identity's | real | WxH@dpr
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
    gpu: 'auto', // auto: the identity's | 0..n: one of the cards that system ships with
    audio: 'noise', // real | noise
    rects: 'real', // real | noise
    fonts: 'real', // real | limit
    cores: 'auto', // auto | 2 | 4 | 6 | 8 | 12 | 16
    memory: 'auto', // auto | 2 | 4 | 8
    touch: 'auto', // auto | off | on
    battery: 'generic', // generic: plugged in and full | random | real
    plugins: 'auto', // auto: what that browser ships with | none | real
    voices: 'generic', // generic: that system's stock voices | none | real
    media: 'generic', // generic: one camera, one microphone, one speaker | none | real
  },
  privacy: {
    cookies: 'first', // first: cookies only for the site in the address bar | all | none
    trackers: true, // refuse known tracking and advertising hosts
  },
  ui: {
    search: SEARCH[0].url,
    theme: 'auto', // auto | light | dark
    cloak: 'none', // tab disguise: none | docs | classroom | drive | notes | calculator | custom
    cloakTitle: '',
    panicKey: '', // one key that leaves at once; empty = off
    panicUrl: '', // where it goes; empty = a blank page
    links: [
      'DuckDuckGo https://duckduckgo.com/',
      'Wikipedia https://www.wikipedia.org/',
      'GitHub https://github.com/',
      'YouTube https://www.youtube.com/',
    ],
  },
};

const ENUMS = {
  'dns.mode': ['auto', 'stack', 'exit'],
  'dns.strategy': ['fallback', 'race', 'rotate', 'split', 'check'],
  'route.rotate': ['sticky', 'request', 'timed'],
  'spoof.random': ['off', 'session', 'site', 'timer'],
  'spoof.geo': ['block', 'exit', 'real'],
  'spoof.viewport': ['window', 'screen'],
  'spoof.theme': ['real', 'light', 'dark'],
  'spoof.motion': ['real', 'reduce', 'no-preference'],
  'spoof.network': ['real', 'wifi', '4g', '3g', '2g', 'slow-2g'],
  'spoof.webrtc': ['block', 'real'],
  'spoof.referer': ['full', 'origin', 'none'],
  'spoof.canvas': ['real', 'noise', 'block'],
  'spoof.webgl': ['real', 'spoof'],
  'spoof.gpu': ['auto', '0', '1', '2', '3', '4'],
  'spoof.audio': ['real', 'noise'],
  'spoof.rects': ['real', 'noise'],
  'spoof.fonts': ['real', 'limit'],
  'spoof.cores': ['auto', '2', '4', '6', '8', '12', '16'],
  'spoof.memory': ['auto', '2', '4', '8'],
  'spoof.touch': ['auto', 'off', 'on'],
  'spoof.battery': ['generic', 'random', 'real'],
  'spoof.plugins': ['auto', 'none', 'real'],
  'spoof.voices': ['generic', 'none', 'real'],
  'spoof.media': ['generic', 'none', 'real'],
  'privacy.cookies': ['first', 'all', 'none'],
  'ui.theme': ['auto', 'light', 'dark'],
  'ui.cloak': ['none', 'docs', 'classroom', 'drive', 'notes', 'calculator', 'custom'],
};
const RANGES = {
  'route.hops': [1, 16],
  'route.minutes': [1, 1440],
  'route.retries': [0, 8],
  'route.timeout': [3000, 120000],
  'dns.parallel': [2, 16],
  'dns.keep': [0, 128],
  'dns.refreshHours': [1, 720],
  'pool.target': [1, SMALL_PROFILE ? 80 : 2000],
  'pool.concurrency': [1, SMALL_PROFILE ? 32 : 400],
  'pool.checkTimeout': [1500, 30000],
  'pool.harvestMinutes': [5, 1440],
  'pool.recheckMinutes': [1, 120],
  'pool.perSource': [100, SMALL_PROFILE ? 20000 : 200000],
  'pool.discoverMax': [0, 500],
  'spoof.randomMinutes': [1, 1440],
};
const MAX_HOPS = RANGES['route.hops'][1];

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

// Graphics cards as WebGL reports them: [vendor, renderer, short name].
const d3d = (vendor, name, id) => [
  'Google Inc. (' + vendor + ')',
  'ANGLE (' + vendor + ', ' + name + ' (0x0000' + id + ') Direct3D11 vs_5_0 ps_5_0, D3D11)',
];
const GL = {
  rtx3060: [...d3d('NVIDIA', 'NVIDIA GeForce RTX 3060', '2503'), 'NVIDIA RTX 3060'],
  gtx1650: [...d3d('NVIDIA', 'NVIDIA GeForce GTX 1650', '1F82'), 'NVIDIA GTX 1650'],
  uhd630: [...d3d('Intel', 'Intel(R) UHD Graphics 630', '3E92'), 'Intel UHD 630'],
  irisXe: [...d3d('Intel', 'Intel(R) Iris(R) Xe Graphics', '46A6'), 'Intel Iris Xe'],
  rx580: [...d3d('AMD', 'Radeon RX 580 Series', '67DF'), 'AMD RX 580'],
  m1: ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'Apple M1'],
  m2: ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'Apple M2'],
  m3: ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', 'Apple M3'],
  mesaIntel: ['Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', 'Intel UHD 620'],
  mesaAmd: [
    'Google Inc. (AMD)',
    'ANGLE (AMD, AMD Radeon RX 580 Series (radeonsi, polaris10, LLVM 17.0.6, DRM 3.57), OpenGL 4.6)',
    'AMD RX 580',
  ],
  adreno740: ['Google Inc. (Qualcomm)', 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', 'Adreno 740'],
  adreno730: ['Google Inc. (Qualcomm)', 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)', 'Adreno 730'],
  mali: ['Google Inc. (ARM)', 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)', 'Mali-G715'],
  apple: ['Apple Inc.', 'Apple GPU', 'Apple GPU'],
  ffNvidia: ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar', 'NVIDIA (generic)'],
  ffIntel: ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) HD Graphics 400 Direct3D11 vs_5_0 ps_5_0), or similar', 'Intel (generic)'],
  ffAmd: ['Google Inc. (AMD)', 'ANGLE (AMD, Radeon R9 200 Series Direct3D11 vs_5_0 ps_5_0), or similar', 'AMD (generic)'],
  ffMesa: ['Mesa', 'Mesa Intel(R) UHD Graphics 620 (KBL GT2), or similar', 'Intel (generic)'],
  ffAdreno: ['Qualcomm', 'Adreno (TM) 740, or similar', 'Adreno (generic)'],
};

const WIN_SCREENS = ['1920x1080@1', '1536x864@1.25', '1366x768@1', '2560x1440@1', '1280x720@1.5', '1920x1200@1'];
const MAC_SCREENS = ['1440x900@2', '1512x982@2', '1728x1117@2', '1470x956@2', '2560x1440@2'];
const LINUX_SCREENS = ['1920x1080@1', '2560x1440@1', '1366x768@1', '1920x1200@1'];

// kind: where it runs. weight: how common it is among real visitors (the randomizer's odds).
const SYSTEMS = {
  'win-chrome': {
    label: 'Windows · Chrome',
    kind: 'desktop',
    family: 'win',
    weight: 40,
    os: 'Windows NT 10.0; Win64; x64',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'Win32',
    chPlatform: 'Windows',
    chVersion: '19.0.0',
    arch: 'x86',
    cores: 12,
    coreChoices: [4, 8, 12, 16],
    memory: 8,
    gpus: [GL.rtx3060, GL.uhd630, GL.irisXe, GL.gtx1650, GL.rx580],
    screens: WIN_SCREENS,
  },
  'win-edge': {
    label: 'Windows · Edge',
    kind: 'desktop',
    family: 'win',
    weight: 9,
    os: 'Windows NT 10.0; Win64; x64',
    engine: 'chromium',
    brand: 'Microsoft Edge',
    platform: 'Win32',
    chPlatform: 'Windows',
    chVersion: '19.0.0',
    arch: 'x86',
    cores: 8,
    coreChoices: [4, 8, 12],
    memory: 8,
    gpus: [GL.uhd630, GL.irisXe, GL.rtx3060, GL.gtx1650],
    screens: WIN_SCREENS,
  },
  'win-firefox': {
    label: 'Windows · Firefox',
    kind: 'desktop',
    family: 'win',
    weight: 5,
    os: 'Windows NT 10.0; Win64; x64',
    engine: 'gecko',
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    cores: 8,
    coreChoices: [4, 8, 12, 16],
    gpus: [GL.ffNvidia, GL.ffIntel, GL.ffAmd],
    screens: WIN_SCREENS,
  },
  'mac-chrome': {
    label: 'macOS · Chrome',
    kind: 'desktop',
    family: 'mac',
    weight: 12,
    os: 'Macintosh; Intel Mac OS X 10_15_7',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'MacIntel',
    chPlatform: 'macOS',
    chVersion: '15.6.1',
    arch: 'arm',
    cores: 8,
    coreChoices: [8, 10, 12],
    memory: 8,
    gpus: [GL.m2, GL.m1, GL.m3],
    screens: MAC_SCREENS,
  },
  'mac-safari': {
    label: 'macOS · Safari',
    kind: 'desktop',
    family: 'mac',
    weight: 9,
    os: 'Macintosh; Intel Mac OS X 10_15_7',
    engine: 'webkit',
    platform: 'MacIntel',
    cores: 8,
    coreChoices: [8],
    gpus: [GL.apple],
    screens: MAC_SCREENS,
  },
  'linux-chrome': {
    label: 'Linux · Chrome',
    kind: 'desktop',
    family: 'linux',
    weight: 3,
    os: 'X11; Linux x86_64',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'Linux x86_64',
    chPlatform: 'Linux',
    chVersion: '6.8.0',
    arch: 'x86',
    cores: 8,
    coreChoices: [4, 8, 12, 16],
    memory: 8,
    gpus: [GL.mesaIntel, GL.mesaAmd],
    screens: LINUX_SCREENS,
  },
  'linux-firefox': {
    label: 'Linux · Firefox',
    kind: 'desktop',
    family: 'linux',
    weight: 2,
    os: 'X11; Linux x86_64',
    engine: 'gecko',
    platform: 'Linux x86_64',
    oscpu: 'Linux x86_64',
    cores: 8,
    coreChoices: [4, 8, 12, 16],
    gpus: [GL.ffMesa],
    screens: LINUX_SCREENS,
  },
  'chromeos-chrome': {
    label: 'ChromeOS · Chrome',
    kind: 'desktop',
    family: 'chromeos',
    weight: 2,
    os: 'X11; CrOS x86_64 14541.0.0',
    engine: 'chromium',
    brand: 'Google Chrome',
    platform: 'Linux x86_64',
    chPlatform: 'Chrome OS',
    chVersion: '16181.61.0',
    arch: 'x86',
    cores: 4,
    coreChoices: [2, 4, 8],
    memory: 4,
    gpus: [GL.mesaIntel],
    screens: ['1366x768@1', '1920x1080@1.25', '1536x864@1.25'],
  },
  'android-chrome': {
    label: 'Android · Chrome',
    kind: 'phone',
    family: 'android',
    weight: 40,
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
    coreChoices: [8],
    memory: 8,
    touch: 5,
    gpus: [GL.adreno740, GL.mali, GL.adreno730],
    screens: ['412x915@2.625', '360x800@3', '384x854@2.8125', '412x892@2.625'],
  },
  'android-firefox': {
    label: 'Android · Firefox',
    kind: 'phone',
    family: 'android',
    weight: 2,
    os: 'Android 15; Mobile',
    engine: 'gecko',
    platform: 'Linux armv81',
    oscpu: 'Linux armv81',
    mobile: true,
    cores: 8,
    coreChoices: [8],
    touch: 5,
    gpus: [GL.ffAdreno],
    screens: ['412x915@2.625', '360x800@3'],
  },
  'iphone-safari': {
    label: 'iPhone · Safari',
    kind: 'phone',
    family: 'ios',
    weight: 38,
    os: 'iPhone; CPU iPhone OS 18_6 like Mac OS X',
    engine: 'webkit',
    platform: 'iPhone',
    mobile: true,
    cores: 4,
    coreChoices: [4],
    touch: 5,
    gpus: [GL.apple],
    screens: ['390x844@3', '393x852@3', '430x932@3', '375x812@3'],
  },
  'ipad-safari': {
    label: 'iPad · Safari',
    kind: 'tablet',
    family: 'ios',
    weight: 0,
    // iPadOS asks for desktop sites by default: it says it is a Mac, and gives itself away by touch.
    os: 'Macintosh; Intel Mac OS X 10_15_7',
    engine: 'webkit',
    platform: 'MacIntel',
    cores: 8,
    coreChoices: [8],
    touch: 5,
    gpus: [GL.apple],
    screens: ['820x1180@2', '834x1194@2', '1024x1366@2'],
  },
};

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
  '1512x982@2',
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

// Stock speech voices per system: [name, language, local]. The first one is the default.
const VOICES = {
  win: [
    ['Microsoft David - English (United States)', 'en-US', 1],
    ['Microsoft Mark - English (United States)', 'en-US', 1],
    ['Microsoft Zira - English (United States)', 'en-US', 1],
  ],
  mac: [
    ['Samantha', 'en-US', 1],
    ['Alex', 'en-US', 1],
    ['Daniel', 'en-GB', 1],
    ['Karen', 'en-AU', 1],
    ['Moira', 'en-IE', 1],
    ['Tessa', 'en-ZA', 1],
  ],
  ios: [
    ['Samantha', 'en-US', 1],
    ['Daniel', 'en-GB', 1],
    ['Karen', 'en-AU', 1],
  ],
  android: [
    ['English United States', 'en-US', 1],
    ['English United Kingdom', 'en-GB', 1],
  ],
  linux: [],
  chromeos: [['Chrome OS US English', 'en-US', 1]],
};
// Chrome on a computer adds its own network voices to the system's.
const CHROME_VOICES = [
  ['Google US English', 'en-US', 0],
  ['Google UK English Female', 'en-GB', 0],
  ['Google UK English Male', 'en-GB', 0],
  ['Google Deutsch', 'de-DE', 0],
  ['Google español', 'es-ES', 0],
  ['Google français', 'fr-FR', 0],
];

function buildSystem(id, now) {
  const s = SYSTEMS[id];
  const nav = {
    id,
    engine: s.engine,
    family: s.family,
    platform: s.platform,
    cores: s.cores,
    touch: s.touch || 0,
    mobile: !!s.mobile,
    gl: s.gpus[0].slice(0, 2),
  };
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
    nav.ua = 'Mozilla/5.0 (' + s.os + '; rv:' + v + '.0) Gecko/' + (s.mobile ? v + '.0' : '20100101') + ' Firefox/' + v + '.0';
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
      ? '5.0 (' + (s.os.startsWith('Windows') ? 'Windows' : s.os.startsWith('Mac') ? 'Macintosh' : s.mobile ? 'Android' : 'X11') + ')'
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

/** Which engine a real browser is, from its own User-Agent. Never sent anywhere: it only decides what passes for real. */
function realBrowser(ua) {
  ua = String(ua || '');
  if (!ua) return null;
  const engine = /(?:CriOS|FxiOS|EdgiOS)\//.test(ua)
    ? 'webkit'
    : /Firefox\//.test(ua)
      ? 'gecko'
      : /(?:Chrome|Chromium|Edg)\//.test(ua)
        ? 'chromium'
        : /AppleWebKit\//.test(ua)
          ? 'webkit'
          : '';
  if (!engine) return null;
  return { engine, mobile: /Mobile|Android|iPhone|iPad/.test(ua) };
}

const PHONE_FOR = { chromium: 'android-chrome', webkit: 'iphone-safari', gecko: 'android-firefox' };

/** Pick by weight, steadily for a given key. */
function weighted(ids, key) {
  let total = 0;
  for (const id of ids) total += SYSTEMS[id].weight || 1;
  let x = hash32(key) % total;
  for (const id of ids) {
    x -= SYSTEMS[id].weight || 1;
    if (x < 0) return id;
  }
  return ids[ids.length - 1];
}
const pickOf = (list, key) => list[hash32(key) % list.length];

/**
 * Turn the saved spoof settings into the concrete identity one page presents:
 * `page` goes to the injected script, `headers` go on upstream requests, `info` to the settings panel.
 * @param {object} spoof  the saved settings
 * @param {string} seed   the browser session's secret
 * @param {number} [now]
 * @param {object} [ctx]  { site, cc: the exit's country, colo: its nearest data centre, real: realBrowser() of the visitor }
 */
function resolveSpoof(spoof, seed, now = Date.now(), ctx = {}) {
  if (!spoof.on) return { page: { on: false }, headers: {}, info: { on: false } };
  const real = ctx.real || null;
  const mobile = !!spoof.mobile;
  const random = spoof.random !== 'off';
  // Everything random hangs off one key, so a single identity is coherent and repeatable.
  let key = String(seed);
  if (spoof.random === 'site') key += '|' + (ctx.site || '');
  if (spoof.random === 'timer') key += '|' + Math.floor(now / (spoof.randomMinutes * 60000));

  let nav = null;
  let id = mobile ? spoof.phone : spoof.system;
  if (random) {
    let ids = Object.keys(SYSTEMS).filter((k) => SYSTEMS[k].kind === (mobile ? 'phone' : 'desktop'));
    if (spoof.match && real) {
      const same = ids.filter((k) => SYSTEMS[k].engine === real.engine);
      if (same.length) ids = same;
    }
    id = weighted(ids, 'sys' + key);
  } else if (mobile && !SYSTEMS[id]) id = PHONE_FOR[real ? real.engine : 'chromium'] || 'android-chrome';
  const sys = SYSTEMS[id];
  if (sys) nav = buildSystem(id, now);
  else if (id === 'custom' && spoof.customUa.trim()) {
    const ua = spoof.customUa.trim();
    const engine = /Firefox\//.test(ua) ? 'gecko' : /Chrome\//.test(ua) ? 'chromium' : 'webkit';
    const base = buildSystem(engine === 'gecko' ? 'win-firefox' : engine === 'chromium' ? 'win-chrome' : 'mac-safari', now);
    nav = Object.assign(base, { id: 'custom', ua, appVersion: ua.replace(/^Mozilla\//, ''), uaData: null });
    nav.platform =
      spoof.customPlatform.trim() ||
      (/Windows/.test(ua)
        ? 'Win32'
        : /iPhone/.test(ua)
          ? 'iPhone'
          : /Mac/.test(ua)
            ? 'MacIntel'
            : /Android/.test(ua)
              ? 'Linux armv81'
              : 'Linux x86_64');
    nav.family = /Windows/.test(ua)
      ? 'win'
      : /iPhone|iPad/.test(ua)
        ? 'ios'
        : /Mac/.test(ua)
          ? 'mac'
          : /Android/.test(ua)
            ? 'android'
            : 'linux';
    nav.mobile = /Mobile|Android|iPhone/.test(ua);
    nav.touch = nav.mobile ? 5 : 0;
  }

  // The device behind the browser: taken from what that system really ships with.
  let screen = null;
  if (spoof.screen === 'auto') {
    if (sys && (random || mobile)) screen = parseScreen(random ? pickOf(sys.screens, 'scr' + key) : sys.screens[0]);
  } else if (spoof.screen !== 'real') screen = parseScreen(spoof.screen);
  if (nav) {
    if (spoof.cores !== 'auto') nav.cores = Number(spoof.cores);
    else if (sys && random) nav.cores = pickOf(sys.coreChoices, 'cpu' + key);
    if (nav.engine === 'chromium') {
      if (spoof.memory !== 'auto') nav.memory = Number(spoof.memory);
      else if (sys && random && sys.kind === 'desktop') nav.memory = pickOf([4, 8, 8, 8], 'mem' + key);
    }
    if (sys) {
      const at =
        spoof.gpu === 'auto' ? (random ? hash32('gpu' + key) % sys.gpus.length : 0) : Math.min(Number(spoof.gpu), sys.gpus.length - 1);
      nav.gl = sys.gpus[at].slice(0, 2);
    }
    if (spoof.touch === 'on') nav.touch = nav.touch || 10;
    else if (spoof.touch === 'off') nav.touch = 0;
  }

  // Where the visitor appears to be: by default, wherever the connection comes out.
  const where = place(ctx.cc, ctx.colo);
  let languages = null;
  if (spoof.languages === 'exit') languages = where ? where.languages : ['en-US', 'en'];
  else if (spoof.languages !== 'real') {
    languages = spoof.languages
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!languages.length) languages = null;
  }
  let tz = null;
  if (spoof.timezone === 'exit') tz = where ? where.tz : 'UTC';
  else if (spoof.timezone !== 'real') tz = spoof.timezone;
  let geo = null; // null: the real one
  if (spoof.geo === 'block') geo = { deny: true };
  else if (spoof.geo === 'exit') {
    // A steady spot within a few kilometres of the country's largest city.
    const r = (k) => (hash32(k + key + (where ? where.cc : '')) / 4294967296 - 0.5) * 0.12;
    geo = where
      ? { lat: +(where.lat + r('la')).toFixed(5), lon: +(where.lon + r('lo')).toFixed(5), acc: 1200 + (hash32('ac' + key) % 2400) }
      : { deny: true };
  }

  const family = nav ? nav.family : '';
  const net = NETWORKS[spoof.network] || null;
  let voices = null;
  if (spoof.voices === 'none') voices = [];
  else if (spoof.voices === 'generic' && nav) {
    voices = (VOICES[family] || []).slice();
    if (nav.engine === 'chromium' && !nav.mobile && family !== 'chromeos') voices = voices.concat(CHROME_VOICES);
  }
  let battery = null;
  if (spoof.battery === 'generic') battery = { charging: true, level: 1 };
  else if (spoof.battery === 'random') {
    const level = 0.2 + (hash32('bat' + key) % 76) / 100;
    battery = { charging: hash32('chg' + key) % 3 === 0, level: +level.toFixed(2) };
  }
  const page = {
    on: true,
    seed: hash32('fp' + key),
    nav,
    languages,
    tz,
    geo,
    screen,
    viewport: !!screen && (spoof.viewport === 'screen' || mobile),
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
    battery,
    // Chrome on Android has no PDF viewer and so no plugins; everything else lists the same five.
    plugins: spoof.plugins === 'real' ? null : spoof.plugins === 'none' || (nav && nav.mobile && nav.engine !== 'webkit') ? 'none' : 'pdf',
    voices,
    media: spoof.media === 'real' ? null : spoof.media,
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
  if (languages) {
    headers['accept-language'] = languages.map((l, i) => (i ? l + ';q=' + Math.max(0.1, 1 - i * 0.1).toFixed(1) : l)).join(',');
  }
  if (spoof.dnt) {
    headers.dnt = '1';
    headers['sec-gpc'] = '1';
  }
  if (spoof.saveData) headers['save-data'] = 'on';
  // A claimed engine that is not the one really running cannot be hidden from a site that looks closely.
  const info = {
    on: true,
    id: nav ? nav.id : 'real',
    label: sys ? sys.label : nav ? 'Custom' : 'Real browser',
    engine: nav ? nav.engine : real ? real.engine : '',
    mobile: nav ? nav.mobile : false,
    detectable: !!(nav && (nav.id === 'custom' || (real && real.engine !== nav.engine))),
    tz,
    languages,
    cc: where ? where.cc : '',
    screen: screen ? screen.w + ' × ' + screen.h : '',
    cores: nav ? nav.cores : 0,
    gpu: sys && nav ? (sys.gpus.find((g) => g[1] === nav.gl[1]) || [])[2] || '' : '',
  };
  return { page, headers, info };
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
// `ip`: where each one lives. Knowing it means its name never has to be looked up anywhere else first.
const DNS_PRESETS = [
  { id: 'cloudflare', label: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query', ip: '104.16.248.249' },
  {
    id: 'cloudflare-security',
    label: 'Cloudflare (malware blocking)',
    url: 'https://security.cloudflare-dns.com/dns-query',
    ip: '1.1.1.2',
  },
  { id: 'quad9', label: 'Quad9', url: 'https://dns.quad9.net/dns-query', ip: '9.9.9.9' },
  { id: 'quad9-plain', label: 'Quad9 (unfiltered)', url: 'https://dns10.quad9.net/dns-query', ip: '9.9.9.10' },
  { id: 'google', label: 'Google', url: 'https://dns.google/dns-query', ip: '8.8.8.8' },
  { id: 'adguard', label: 'AdGuard (ad blocking)', url: 'https://dns.adguard-dns.com/dns-query', ip: '94.140.14.14' },
  { id: 'adguard-plain', label: 'AdGuard (unfiltered)', url: 'https://unfiltered.adguard-dns.com/dns-query', ip: '94.140.14.140' },
  { id: 'mullvad', label: 'Mullvad', url: 'https://dns.mullvad.net/dns-query', ip: '194.242.2.2' },
  { id: 'mullvad-adblock', label: 'Mullvad (ad blocking)', url: 'https://adblock.dns.mullvad.net/dns-query', ip: '194.242.2.3' },
  { id: 'opendns', label: 'OpenDNS', url: 'https://doh.opendns.com/dns-query', ip: '146.112.41.2' },
  { id: 'dnssb', label: 'DNS.SB', url: 'https://doh.dns.sb/dns-query', ip: '185.222.222.222' },
  { id: 'controld', label: 'Control D', url: 'https://freedns.controld.com/p0', ip: '76.76.2.11' },
  { id: 'wikimedia', label: 'Wikimedia', url: 'https://wikimedia-dns.org/dns-query', ip: '185.71.138.138' },
];
const DNS_BOOTSTRAP = {};
for (const d of DNS_PRESETS) DNS_BOOTSTRAP[new URL(d.url).hostname] = d.ip;

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

/**
 * "<host pattern> <proxy|block> [CC,CC] [hops=N]" -> rule, or null when it makes no sense.
 * Patterns: example.com (and its subdomains), *.example.com, *tracker*, * (everything).
 * There is no rule that sends a site around the proxies: nothing ever leaves without one.
 */
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
  if (!pattern || pattern.length > 120 || !/^[a-z0-9.*:_-]+$/.test(pattern) || !['proxy', 'block'].includes(via)) return null;
  const rule = { pattern, via, countries: [], hops: 0 };
  for (const extra of parts.slice(2)) {
    const h = /^hops=(\d{1,2})$/i.exec(extra);
    if (h) rule.hops = Math.max(1, Math.min(MAX_HOPS, Number(h[1])));
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

const httpUrl = (text, secureOnly) => {
  try {
    const u = new URL(text);
    if (u.protocol !== 'https:' && (secureOnly || u.protocol !== 'http:')) return null;
    return u;
  } catch {
    return null;
  }
};

/** "<address> <expected text>": a page whose content is known in advance. */
function parseCanary(text) {
  const t = String(text || '').trim();
  const cut = t.search(/\s/);
  if (cut < 0 || t.length > 600) return null;
  const u = httpUrl(t.slice(0, cut));
  const expect = t.slice(cut).trim();
  if (!u || u.protocol !== 'http:' || !expect) return null; // HTTPS cannot be altered on the way, so there is nothing to test
  return { url: u.href, expect };
}

/** "Name https://address" (or just the address) -> { name, url } */
function parseLink(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return null;
  const cut = t.lastIndexOf(' ');
  const raw = cut < 0 ? t : t.slice(cut + 1);
  const u = httpUrl(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!u || !u.hostname.includes('.')) return null;
  const name = (cut < 0 ? '' : t.slice(0, cut).trim()) || u.hostname.replace(/^www\./, '');
  return { name: name.slice(0, 40), url: u.href };
}

const LIMITS = { 'dns.servers': 64, 'dns.feeds': 8, 'pool.sources': 2000, 'pool.canaries': 6, 'ui.links': 12 };
const MAX_SOURCES = LIMITS['pool.sources'];
const countryList = (val) => val.map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));

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
        .slice(0, MAX_SOURCES);
    } else if (Array.isArray(cur)) {
      if (!Array.isArray(val)) continue;
      val = val
        .filter((x) => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean);
      if (at === 'route.protocols') val = val.filter((x) => ['http', 'socks4', 'socks5'].includes(x));
      if (at === 'route.countries' || at === 'route.entry') val = countryList(val);
      if (at === 'route.rules') val = val.filter((x) => x.length < 300 && parseRule(x));
      if (at === 'dns.servers') val = val.map(cleanDns).filter(Boolean);
      if (at === 'dns.feeds') val = val.filter((x) => x.length < 400 && httpUrl(x, process.env.WADDLE_ALLOW_PRIVATE !== '1'));
      if (at === 'pool.canaries') val = val.filter(parseCanary);
      if (at === 'ui.links')
        val = val
          .map(parseLink)
          .filter(Boolean)
          .map((l) => l.name + ' ' + l.url);
      base[key] = [...new Set(val)].slice(0, LIMITS[at] || 100);
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
      if (at === 'spoof.system' && !(SYSTEMS[val] && SYSTEMS[val].kind === 'desktop') && !['custom', 'real'].includes(val)) continue;
      if (at === 'spoof.phone' && val !== 'auto' && !(SYSTEMS[val] && SYSTEMS[val].kind !== 'desktop')) continue;
      if (at === 'spoof.screen' && val !== 'real' && val !== 'auto' && !parseScreen(val)) continue;
      if (at === 'spoof.timezone') {
        if (!val) val = 'real';
        if (val !== 'exit' && val !== 'real') {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: val });
          } catch {
            continue;
          }
        }
      }
      if (at === 'spoof.languages') {
        if (!val) val = 'real';
        if (
          val !== 'exit' &&
          val !== 'real' &&
          !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*(\s*,\s*[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*){0,9}$/.test(val)
        )
          continue;
      }
      if (at === 'ui.search') {
        const preset = SEARCH.find((x) => x.id === val.toLowerCase());
        if (preset) val = preset.url;
      }
      if (at === 'pool.echo' && val && !httpUrl(val)) continue;
      if (at === 'pool.judge' || at === 'ui.search') {
        if (!httpUrl(val.replace('%s', 'x'))) continue;
        if (at === 'ui.search' && !val.includes('%s')) continue;
      }
      if (at === 'ui.panicUrl' && val && !httpUrl(val)) continue;
      if (at === 'ui.panicKey' && val.length > 20) continue;
      if (at === 'ui.cloakTitle') val = val.slice(0, 80);
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
  replace(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('configuration must be an object');
    const next = clone(DEFAULTS);
    merge(next, p, '');
    this.value = next;
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
  systems: Object.keys(SYSTEMS).map((id) => ({
    id,
    label: SYSTEMS[id].label,
    kind: SYSTEMS[id].kind,
    engine: SYSTEMS[id].engine,
    gpus: SYSTEMS[id].gpus.map((g) => g[2]),
  })),
  screens: SCREENS,
  networks: Object.keys(NETWORKS),
  dns: DNS_PRESETS.map((d) => ({ id: d.id, label: d.label, url: d.url })),
  search: SEARCH,
  countries: Object.keys(COUNTRIES).map((cc) => [cc, COUNTRIES[cc][0]]),
  maxHops: MAX_HOPS,
  maxDnsServers: LIMITS['dns.servers'],
  maxSources: MAX_SOURCES,
  profile: SMALL_PROFILE ? 'small' : 'standard',
};

module.exports = {
  Config,
  DEFAULTS,
  DATA_DIR,
  DNS_BOOTSTRAP,
  SYSTEMS,
  MAX_HOPS,
  resolveSpoof,
  realBrowser,
  parseSource,
  cleanSource,
  parseScreen,
  parseRule,
  parseCanary,
  parseLink,
  matchRule,
  cleanDns,
  chromeBrands,
  hash32,
  options,
};
