'use strict';
// Server-side cookie jars, one per browser session. Site cookies never reach the
// user's browser, so sites stay isolated from each other and from Waddle itself.

const crypto = require('crypto');

// Suffixes under which anyone can register a name; a cookie may not span one.
const MULTI_SUFFIX = new Set(
  (
    'co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk com.au net.au org.au edu.au gov.au co.nz net.nz org.nz ' +
    'co.jp ne.jp or.jp ac.jp go.jp com.br net.br org.br gov.br com.cn net.cn org.cn gov.cn com.hk com.tw com.sg com.my com.ph co.in net.in ' +
    'org.in firm.in gen.in ind.in co.kr or.kr co.za org.za com.mx com.ar com.co com.tr com.ua com.ru co.id co.il co.th com.vn com.pk com.eg ' +
    'com.sa com.ng github.io gitlab.io pages.dev workers.dev vercel.app netlify.app herokuapp.com web.app firebaseapp.com appspot.com ' +
    'blogspot.com cloudfront.net azurewebsites.net s3.amazonaws.com fly.dev onrender.com e2b.app'
  ).split(' ')
);

/** Registrable domain ("eTLD+1"), good enough without shipping the whole public suffix list. */
function siteOf(host) {
  host = String(host || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const p = host.split('.');
  if (p.length <= 2) return host;
  const two = p.slice(-2).join('.');
  return MULTI_SUFFIX.has(two) ? p.slice(-3).join('.') : two;
}

const isSuffix = (d) => !d.includes('.') || MULTI_SUFFIX.has(d);

function pathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/');
}

class Jar {
  constructor() {
    this.items = new Map(); // "domain|path|name" -> cookie
  }

  /**
   * Store one Set-Cookie value (or one `document.cookie = …` assignment).
   * @returns the stored/deleted cookie record, or null if it was rejected
   */
  set(line, url, fromScript) {
    line = String(line || '');
    if (!line || line.length > 8192) return null;
    const parts = line.split(';');
    const first = parts.shift();
    const eq = first.indexOf('=');
    if (eq < 0) return null;
    const name = first.slice(0, eq).trim();
    let value = first.slice(eq + 1).trim();
    if (!name || /[\s,;\x00-\x1f]/.test(name)) return null;
    if (value.length > 1 && value[0] === '"' && value[value.length - 1] === '"') value = value.slice(1, -1);

    const host = url.hostname.toLowerCase();
    const c = { name, value, domain: host, hostOnly: true, path: null, secure: false, httpOnly: false, expires: 0, made: Date.now() };
    let maxAge = null;
    for (const raw of parts) {
      const i = raw.indexOf('=');
      const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : raw.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (d === host) {
          c.hostOnly = false;
          continue;
        }
        if (!host.endsWith('.' + d) || isSuffix(d)) return null; // not ours to set
        c.domain = d;
        c.hostOnly = false;
      } else if (k === 'path') {
        if (v[0] === '/') c.path = v;
      } else if (k === 'expires') {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) c.expires = Math.max(1, t); // 0 means "session cookie", so the epoch must not collapse into it
      } else if (k === 'max-age') {
        if (/^-?\d+$/.test(v)) maxAge = parseInt(v, 10);
      } else if (k === 'secure') {
        c.secure = true;
      } else if (k === 'httponly') {
        c.httpOnly = true;
      }
    }
    if (maxAge !== null) c.expires = maxAge <= 0 ? 1 : Date.now() + maxAge * 1000;
    if (!c.path) {
      const p = url.pathname;
      const cut = p.lastIndexOf('/');
      c.path = cut > 0 ? p.slice(0, cut) : '/';
    }
    if (fromScript && c.httpOnly) return null;
    if (name.startsWith('__Host-') && (!c.hostOnly || c.path !== '/')) return null;

    const key = c.domain + '|' + c.path + '|' + name;
    const old = this.items.get(key);
    if (fromScript && old && old.httpOnly) return null; // scripts cannot touch HttpOnly cookies
    if (c.expires && c.expires <= Date.now()) {
      this.items.delete(key);
      c.gone = true;
      return c;
    }
    if (old) c.made = old.made;
    this.items.delete(key);
    this.items.set(key, c);
    if (this.items.size > 3000) this.items.delete(this.items.keys().next().value);
    return c;
  }

  /** Cookies that apply to `url`, most specific path first. */
  match(url, forScript) {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || '/';
    const https = url.protocol === 'https:' || url.protocol === 'wss:';
    const now = Date.now();
    const out = [];
    for (const [key, c] of this.items) {
      if (c.expires && c.expires <= now) {
        this.items.delete(key);
        continue;
      }
      if (c.hostOnly ? host !== c.domain : host !== c.domain && !host.endsWith('.' + c.domain)) continue;
      if (!pathMatch(path, c.path)) continue;
      if (c.secure && !https) continue;
      if (forScript && c.httpOnly) continue;
      out.push(c);
    }
    return out.sort((a, b) => b.path.length - a.path.length || a.made - b.made);
  }

  header(url) {
    return this.match(url, false)
      .map((c) => c.name + '=' + c.value)
      .join('; ');
  }

  /** What `document.cookie` shows on a page at `url`. */
  visible(url) {
    return this.match(url, true)
      .map((c) => c.name + '=' + c.value)
      .join('; ');
  }

  clear() {
    this.items.clear();
  }
  get size() {
    return this.items.size;
  }
}

// ---- sessions ---------------------------------------------------------------

const sessions = new Map();
const IDLE = 24 * 3600 * 1000;
const COOKIE = 'waddle';

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.used > IDLE) sessions.delete(id);
  while (sessions.size > 2000) sessions.delete(sessions.keys().next().value);
}
setInterval(sweep, 600000).unref();

/**
 * Find or create the session for a request, identified by an HttpOnly cookie.
 * There is deliberately no fallback to address/user-agent matching: two people
 * behind one NAT must never end up sharing a cookie jar.
 */
function session(req, res, secure) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]{20,64})').exec(req.headers.cookie || '');
  let s = m && sessions.get(m[1]);
  if (!s) {
    const id = crypto.randomBytes(24).toString('base64url');
    s = { id, jar: new Jar(), seed: crypto.randomBytes(12).toString('base64url'), used: Date.now() };
    sessions.set(id, s);
    if (res && !res.headersSent) {
      // Inside an embedded preview we are a third party: that needs SameSite=None + Partitioned.
      res.appendHeader(
        'Set-Cookie',
        COOKIE + '=' + id + '; Path=/; HttpOnly; Max-Age=31536000' + (secure ? '; Secure; SameSite=None; Partitioned' : '; SameSite=Lax')
      );
    }
  }
  s.used = Date.now();
  return s;
}

module.exports = { Jar, session, siteOf };
