'use strict';
// URL rewriting for HTML, CSS and JS. Every scanner here is a single forward
// pass with no nested quantifiers, so a hostile page cannot stall the server.

const PREFIX = '/~/';
const SKIP = /^(?:#|data:|blob:|javascript:|about:|mailto:|tel:|sms:|magnet:|intent:|market:|chrome:|view-source:)/i;

/** Proxied form of `raw` as found on a page at `base`. Non-web URLs are returned untouched. */
function proxify(raw, base) {
  const s = String(raw).trim();
  if (!s || SKIP.test(s) || s.startsWith(PREFIX)) return raw;
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
  return PREFIX + u.href;
}

/** The real URL behind a proxied path ("/~/https://host/x"), or null. */
function unproxify(path) {
  let s = String(path || '');
  const at = s.indexOf(PREFIX);
  if (at < 0) return null;
  s = s.slice(at + PREFIX.length);
  // Some intermediaries collapse "//": repair "https:/host" -> "https://host".
  s = s.replace(/^(https?|wss?):\/+/i, '$1://');
  if (!/^(https?|wss?):\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/]+:\d/.test(s)) return null; // some other scheme
    s = 'https://' + s.replace(/^\/+/, '');
  }
  try {
    const u = new URL(s);
    return u.hostname ? u : null;
  } catch {
    return null;
  }
}

// ---- entities -----------------------------------------------------------------

const LATIN1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para ' +
  'middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml ' +
  'Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave ' +
  'aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ' +
  'ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');
const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  Tab: '\t',
  NewLine: '\n',
  colon: ':',
  sol: '/',
  quest: '?',
  equals: '=',
  num: '#',
  period: '.',
  comma: ',',
  lpar: '(',
  rpar: ')',
  semi: ';',
  percnt: '%',
};
LATIN1.forEach((n, i) => {
  NAMED[n] = String.fromCharCode(160 + i);
});

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, dec, hex, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(cp);
  });
}

const encode = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- CSS ------------------------------------------------------------------------

const CSS_HIT = /url\(|@import/gi;
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** Rewrite url(...) and @import "..." targets. */
function rewriteCss(css, base) {
  if (css.length < 5) return css;
  let out = '';
  let last = 0;
  let m;
  CSS_HIT.lastIndex = 0;
  while ((m = CSS_HIT.exec(css))) {
    let i = CSS_HIT.lastIndex;
    const isImport = m[0].length > 4;
    while (i < css.length && isSpace(css.charCodeAt(i))) i++;
    const q = css.charCodeAt(i);
    let start;
    let end;
    let quoted = false;
    if (q === 34 || q === 39) {
      quoted = true;
      start = ++i;
      while (i < css.length) {
        const c = css.charCodeAt(i);
        if (c === q || c === 10 || c === 13) break;
        if (c === 92) i++; // escaped character
        i++;
      }
      if (css.charCodeAt(i) !== q) {
        CSS_HIT.lastIndex = Math.min(i, css.length);
        continue;
      }
      end = i;
    } else {
      if (isImport) continue; // "@import url(" is picked up as url(
      start = i;
      while (i < css.length) {
        const c = css.charCodeAt(i);
        if (c === 41 || c === 40 || c === 34 || c === 39 || isSpace(c)) break;
        i++;
      }
      end = i;
      while (i < css.length && isSpace(css.charCodeAt(i))) i++;
      if (css.charCodeAt(i) !== 41) {
        CSS_HIT.lastIndex = Math.max(CSS_HIT.lastIndex, end);
        continue;
      }
    }
    const raw = css.slice(start, end);
    if (raw && !SKIP.test(raw)) {
      const plain =
        raw.indexOf('\\') < 0
          ? raw
          : raw.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (x, hex, ch) =>
              hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : ch
            );
      const to = proxify(plain, base);
      if (to !== plain) {
        out +=
          css.slice(last, start) +
          (quoted
            ? to.replace(/["'\\\n]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ')
            : to.replace(/[()'"\s\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')));
        last = end;
      }
    }
    CSS_HIT.lastIndex = Math.max(CSS_HIT.lastIndex, end);
  }
  return last ? out + css.slice(last) : css;
}

// ---- JS -------------------------------------------------------------------------

// import … from "x" / export … from "x" / import "x" / import("x"), absolute targets only:
// relative ones already resolve correctly against the proxied script URL.
// Module specifiers that would leave the proxy: absolute URLs, //host/… and /absolute/paths.
// Relative ones ("./x.js") already resolve against the proxied address and are left alone.
const JS_SPEC = '((?:https?:)?\\/\\/[^"\'\\s\\\\]{1,2048}|\\/(?!\\/|~\\/)[^"\'\\s\\\\]{0,2048})';
// import "x" / import a, {b} from "x" / export * from "x": only where a statement can start, so
// that text inside a string or a comment that merely looks like an import is not touched.
const JS_STATIC = new RegExp(
  '(^|[;}\\n\\r])([ \\t]*(?:import[ \\t]*|(?:import|export)\\b[^"\'`;()=]{1,600}?\\bfrom[ \\t]*))(["\'])' + JS_SPEC + '\\3',
  'g'
);
// import("x") can sit anywhere in an expression, but not behind a dot, a quote or an identifier.
const JS_DYNAMIC = new RegExp('(^|[^\\w$.\'"`\\\\])(import[ \\t]{0,4}\\([ \\t]{0,4})(["\'])' + JS_SPEC + '\\3', 'g');

function rewriteJs(js, base) {
  if (js.indexOf('import') < 0 && js.indexOf('export') < 0) return js;
  const fix = (m, before, lead, q, spec) => {
    const to = proxify(spec, base);
    return to === spec ? m : before + lead + q + to + q;
  };
  return js.replace(JS_STATIC, fix).replace(JS_DYNAMIC, fix);
}

/** Import map: every target and scope is a URL. */
function rewriteImportMap(json, base) {
  let map;
  try {
    map = JSON.parse(json);
  } catch {
    return json;
  }
  const fix = (o) => {
    const r = {};
    for (const [k, v] of Object.entries(o || {})) {
      const key = /^(?:https?:)?\/\/|^\//.test(k) ? proxify(k, base) : k;
      r[key] = typeof v === 'string' ? proxify(v, base) : v;
    }
    return r;
  };
  if (map && typeof map === 'object') {
    if (map.imports) map.imports = fix(map.imports);
    if (map.scopes) {
      const s = {};
      for (const [k, v] of Object.entries(map.scopes)) s[proxify(k, base)] = fix(v);
      map.scopes = s;
    }
    if (map.integrity) delete map.integrity;
  }
  return JSON.stringify(map).replace(/</g, '\\u003c');
}

/** HLS playlists: each non-comment line and every URI="…" is a URL. */
function rewriteM3u8(text, base) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t[0] === '#') return line.replace(/URI="([^"]{1,4096})"/g, (m, u) => 'URI="' + proxify(u, base) + '"');
      return proxify(t, base);
    })
    .join('\n');
}

// ---- HTML -----------------------------------------------------------------------

function rewriteSrcset(value, base) {
  const out = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && (isSpace(value.charCodeAt(i)) || value[i] === ',')) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !isSpace(value.charCodeAt(j))) j++;
    let url = value.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) {
      let e = url.length;
      while (e > 0 && url.charCodeAt(e - 1) === 44) e--;
      url = url.slice(0, e);
    } else {
      let k = j;
      let depth = 0;
      while (k < n) {
        const c = value[k];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth <= 0) break;
        k++;
      }
      desc = value.slice(j, k).trim();
      j = k;
    }
    if (url) out.push(proxify(url, base) + (desc ? ' ' + desc : ''));
    i = j;
  }
  return out.join(', ');
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'xlink:href']);
const DROP_ATTRS = new Set(['integrity', 'ping', 'referrerpolicy', 'manifest']);
const RAW_TEXT = /^(?:textarea|title|xmp|noembed|plaintext)$/;
const HINT_REL = /(?:^|\s)(?:preconnect|dns-prefetch)(?:\s|$)/i;

/** Parse the attributes of a start tag beginning at `i` (just past the tag name). */
function readAttrs(html, i) {
  const n = html.length;
  const attrs = [];
  for (;;) {
    let slash = false;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (c === 47) {
        slash = true;
        i++;
      } else if (isSpace(c)) {
        slash = false;
        i++;
      } else break;
    }
    if (i >= n) return null;
    if (html.charCodeAt(i) === 62) return { attrs, end: i + 1, selfClose: slash };
    const ns = i;
    i++; // the first character is always part of the name (even "=")
    while (i < n) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
      i++;
    }
    const name = html.slice(ns, i);
    let j = i;
    while (j < n && isSpace(html.charCodeAt(j))) j++;
    let value = null;
    let quote = '';
    if (html.charCodeAt(j) === 61) {
      j++;
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      const q = html.charCodeAt(j);
      if (q === 34 || q === 39) {
        const close = html.indexOf(html[j], j + 1);
        if (close < 0) return null;
        value = html.slice(j + 1, close);
        quote = html[j];
        i = close + 1;
      } else {
        const vs = j;
        while (j < n) {
          const c = html.charCodeAt(j);
          if (isSpace(c) || c === 62) break;
          j++;
        }
        value = html.slice(vs, j);
        i = j;
      }
    }
    attrs.push({ name, lower: name.toLowerCase(), value, quote, raw: html.slice(ns, i) });
  }
}

const get = (attrs, name) => {
  for (const a of attrs) if (a.lower === name) return a.value === null ? '' : decode(a.value);
  return null;
};

/**
 * @param {string} html
 * @param {URL|string} base   real URL of the document
 * @param {object} [opt]
 * @param {string} [opt.inject]  markup placed before anything else that can run or load
 * @returns {string}
 */
function rewriteHtml(html, base, opt = {}) {
  base = String(base);
  const docUrl = base;
  const n = html.length;
  const out = [];
  let i = 0;
  let injected = !opt.inject;
  let baseSeen = false;
  const END = {
    script: /<\/script/gi,
    style: /<\/style/gi,
    textarea: /<\/textarea/gi,
    title: /<\/title/gi,
    xmp: /<\/xmp/gi,
    noembed: /<\/noembed/gi,
  };

  const inject = () => {
    if (!injected) {
      injected = true;
      out.push(opt.inject);
    }
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    i = lt;
    const c = html.charCodeAt(lt + 1);

    if (c === 33) {
      // <!-- comment --> or <!doctype>
      if (html.startsWith('<!--', lt)) {
        const e = html.indexOf('-->', lt + 4);
        const stop = e < 0 ? n : e + 3;
        out.push(html.slice(lt, stop));
        i = stop;
      } else {
        const e = html.indexOf('>', lt);
        const stop = e < 0 ? n : e + 1;
        out.push(html.slice(lt, stop));
        i = stop;
      }
      continue;
    }
    if (c === 47 || c === 63) {
      // end tag / processing instruction
      const e = html.indexOf('>', lt);
      const stop = e < 0 ? n : e + 1;
      out.push(html.slice(lt, stop));
      i = stop;
      continue;
    }
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      out.push('<');
      i = lt + 1;
      continue;
    }

    // ---- start tag
    let j = lt + 1;
    while (j < n) {
      const k = html.charCodeAt(j);
      if (isSpace(k) || k === 62 || k === 47) break;
      j++;
    }
    const tag = html.slice(lt + 1, j).toLowerCase();
    const parsed = readAttrs(html, j);
    if (!parsed) {
      out.push(html.slice(lt));
      break;
    } // unterminated tag: leave the tail alone
    const { attrs } = parsed;
    i = parsed.end;

    if (tag !== 'html' && tag !== 'head') inject();

    let drop = false;
    let changed = false;
    const set = (a, v) => {
      a.raw = a.name + '="' + encode(v) + '"';
      changed = true;
    };
    const remove = (a) => {
      a.raw = '';
      changed = true;
    };

    if (tag === 'base') {
      const href = get(attrs, 'href');
      if (href !== null && !baseSeen) {
        baseSeen = true;
        try {
          base = new URL(href.trim(), docUrl).href;
        } catch {
          /* keep the document URL */
        }
      }
    } else if (tag === 'meta') {
      const equiv = (get(attrs, 'http-equiv') || '').trim().toLowerCase();
      const name = (get(attrs, 'name') || '').trim().toLowerCase();
      if (
        equiv === 'content-security-policy' ||
        equiv === 'content-security-policy-report-only' ||
        equiv === 'x-frame-options' ||
        equiv === 'origin-trial' ||
        name === 'referrer'
      ) {
        drop = true;
      } else if (equiv === 'refresh') {
        for (const a of attrs) {
          if (a.lower !== 'content' || a.value === null) continue;
          const v = decode(a.value);
          if (v.length > 2048) continue;
          const m = /^([\s\d.]*[;,]?\s*(?:url\s*=\s*)?)(["']?)([^"']*)\2\s*$/i.exec(v);
          if (m && m[3] && /[;,]|url/i.test(m[1])) set(a, m[1] + proxify(m[3].trim(), base));
        }
      }
    }

    if (!drop) {
      const rel = tag === 'link' ? get(attrs, 'rel') || '' : '';
      const hint = tag === 'link' && HINT_REL.test(rel); // would connect straight to a third party
      for (const a of attrs) {
        const k = a.lower;
        if (DROP_ATTRS.has(k)) {
          remove(a);
          continue;
        }
        if (a.value === null) continue;
        if (URL_ATTRS.has(k) || (k === 'data' && tag === 'object')) {
          if (hint) {
            remove(a);
            continue;
          }
          const v = decode(a.value).trim();
          // <base href> is rewritten relative to the document; everything else relative to the base
          const to = proxify(v, tag === 'base' ? docUrl : base);
          if (to !== v) set(a, to);
        } else if (k === 'srcset' || k === 'imagesrcset') {
          set(a, rewriteSrcset(decode(a.value), base));
        } else if (k === 'style') {
          const v = decode(a.value);
          const to = rewriteCss(v, base);
          if (to !== v) set(a, to);
        } else if (k === 'target') {
          const v = decode(a.value).trim().toLowerCase();
          if (v === '_top' || v === '_parent' || v === '_blank') set(a, '_self');
        } else if (k === 'srcdoc' && tag === 'iframe') {
          set(a, rewriteHtml(decode(a.value), base, opt));
        }
      }
      if (changed) {
        const body = attrs
          .map((a) => a.raw)
          .filter(Boolean)
          .join(' ');
        const selfClose = parsed.selfClose ? ' /' : '';
        out.push('<' + html.slice(lt + 1, j) + (body ? ' ' + body : '') + selfClose + '>');
      } else {
        out.push(html.slice(lt, i));
      }
    }

    if (tag === 'head') inject();

    // ---- elements whose content is not markup
    if (tag === 'script' || tag === 'style' || RAW_TEXT.test(tag)) {
      const re = END[tag];
      let stop = n;
      if (re) {
        re.lastIndex = i;
        const m = re.exec(html);
        if (m) stop = m.index;
      }
      let text = html.slice(i, stop);
      if (tag === 'style') {
        text = rewriteCss(text, base);
      } else if (tag === 'script' && get(attrs, 'src') === null) {
        const type = (get(attrs, 'type') || '').trim().toLowerCase();
        if (type === 'module') text = rewriteJs(text, base);
        else if (type === 'importmap') text = rewriteImportMap(text, base);
      }
      out.push(text);
      i = stop;
    }
  }
  inject();
  return out.join('');
}

module.exports = {
  PREFIX,
  proxify,
  unproxify,
  rewriteHtml,
  rewriteCss,
  rewriteJs,
  rewriteImportMap,
  rewriteM3u8,
  rewriteSrcset,
  decode,
  encode,
};
