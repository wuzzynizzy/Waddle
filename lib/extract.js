'use strict';
// Pull proxies out of anything: plain lists, URLs with schemes, CSV, JSON, HTML tables.

const PROTOS = { http: 'http', https: 'http', socks4: 'socks4', socks4a: 'socks4', socks5: 'socks5', socks5h: 'socks5', socks: 'socks5' };

const IP = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}';
// Every quantifier here is bounded and nothing is nested, so matching stays linear
// no matter what a list file contains (a single megabyte-long token included).
const CORE_RE = new RegExp('(?<![\\d.])(' + IP + ')[ \\t]{0,3}:[ \\t]{0,3}(\\d{2,5})(?!\\d)', 'g');
// Looked for only in the few characters right before an ip:port hit.
const SCHEME_RE = /(https?|socks4a?|socks5h?|socks):\/\/$/i;
const AUTH_RE = /(?:(https?|socks4a?|socks5h?|socks):\/\/)?([^\s:@\/"'<>,]{1,64}):([^\s@\/"'<>,]{1,64})@$/i;
// ip , port   /   ip <tab> port   /   "ip","port"   /   <td>ip</td><td>port</td>
const PAIR_RE = new RegExp(
  '(?<![\\d.])(' + IP + ')(?![\\d.:])"?[ \\t]{0,8}(?:[,;\\t|]|</t[dh]>\\s{0,40}<t[dh][^>]{0,200}>)[ \\t]{0,8}"?(\\d{2,5})(?![\\d.])',
  'gi'
);

function isPublic(ip) {
  const p = ip.split('.').map(Number);
  if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return false;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGNAT
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return false;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
  return true;
}

/** Guess the protocol a list file holds from its path, e.g. "proxies/socks5.txt". */
function protoFromPath(path) {
  const s = String(path || '').toLowerCase();
  if (/socks[-_ ]?5/.test(s)) return 'socks5';
  if (/socks[-_ ]?4/.test(s)) return 'socks4';
  if (/(^|[^a-z])https?([^a-z]|$)/.test(s)) return 'http';
  return null;
}

function normProto(v) {
  if (Array.isArray(v)) {
    const all = v.map(normProto).filter(Boolean);
    return all.includes('socks5') ? 'socks5' : all.includes('socks4') ? 'socks4' : all[0] || null;
  }
  if (typeof v !== 'string') return null;
  return (
    PROTOS[
      v
        .trim()
        .toLowerCase()
        .replace(/:\/\/.*$/, '')
    ] || null
  );
}

function add(out, proto, host, port, user, pass, allowPrivate) {
  port = Number(port);
  if (!(port > 0 && port < 65536)) return;
  if (!allowPrivate && !isPublic(host)) return;
  const p = { proto: proto || null, host, port };
  if (user) {
    p.user = user;
    p.pass = pass || '';
  }
  out.push(p);
}

function fromJson(node, hint, out, opt, depth) {
  if (depth > 6 || node == null || out.length >= (opt.limit || Infinity)) return;
  if (Array.isArray(node)) {
    for (const v of node) {
      if (typeof v === 'string') fromText(v, hint, out, opt);
      else fromJson(v, hint, out, opt, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') return;
  const ip = node.ip || node.host || node.addr || node.address || node.ipAddress || node.ip_address || node.IP;
  const port = node.port || node.Port || node.PORT;
  const proto = normProto(node.protocol || node.protocols || node.type || node.scheme || node.proxyType) || hint;
  if (typeof ip === 'string' && port && new RegExp('^' + IP + '$').test(ip.trim())) {
    add(out, proto, ip.trim(), port, node.username || node.user, node.password || node.pass, opt.allowPrivate);
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      if (v.length < 200) fromText(v, normProto(k) || hint, out, opt);
    } else if (v && typeof v === 'object') fromJson(v, normProto(k) || hint, out, opt, depth + 1);
  }
}

function fromText(text, hint, out, opt) {
  let m;
  const before = out.length;
  const limit = opt.limit || Infinity;
  CORE_RE.lastIndex = 0;
  while ((m = CORE_RE.exec(text))) {
    // A scheme or credentials can only sit directly in front: "…://" or "…@".
    const prev = text.charCodeAt(m.index - 1);
    let pre = null;
    if (prev === 47) pre = SCHEME_RE.exec(text.slice(Math.max(0, m.index - 10), m.index));
    else if (prev === 64) pre = AUTH_RE.exec(text.slice(Math.max(0, m.index - 140), m.index));
    pre = pre || [];
    add(out, normProto(pre[1]) || hint, m[1], m[2], pre[2], pre[3], opt.allowPrivate);
    if (out.length >= limit) return;
  }
  if (out.length === before) {
    // nothing in ip:port form, try ip,port / table cells
    PAIR_RE.lastIndex = 0;
    while ((m = PAIR_RE.exec(text))) {
      add(out, hint, m[1], m[2], null, null, opt.allowPrivate);
      if (out.length >= limit) return;
    }
  }
}

/**
 * @param {string} text  file / response body
 * @param {string|null} hint protocol to assume when a line does not say
 * @returns {{proto:string|null,host:string,port:number,user?:string,pass?:string}[]}
 */
function extractProxies(text, hint, opt = {}) {
  const out = [];
  const t = text.trimStart();
  if (t[0] === '[' || t[0] === '{') {
    try {
      fromJson(JSON.parse(t), hint || null, out, opt, 0);
      return out;
    } catch {
      /* not JSON after all */
    }
  }
  fromText(text, hint || null, out, opt);
  return out;
}

const keyOf = (p) => (p.proto || '?') + '://' + p.host + ':' + p.port;

module.exports = { extractProxies, protoFromPath, isPublic, keyOf, normProto };
