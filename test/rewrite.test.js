'use strict';
require('./support');
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../lib/rewrite');

const B = 'https://site.test/dir/page.html?x=1';
const P = '/~/https://site.test';

test('proxify: every way of writing a URL lands on the proxy', () => {
  const cases = {
    '/a?b=1#h': P + '/a?b=1#h',
    'img.png': P + '/dir/img.png',
    '../up': P + '/up',
    '?q=2': P + '/dir/page.html?q=2',
    '//cdn.test/x.js': '/~/https://cdn.test/x.js',
    'https://other.test/': '/~/https://other.test/',
    'http://plain.test/p': '/~/http://plain.test/p',
    '  /spaced  ': P + '/spaced',
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(r.proxify(from, B), to, from);
});

test('proxify: what is not a web address is left alone', () => {
  for (const u of ['#frag', '', 'data:text/plain,hi', 'javascript:void(0)', 'mailto:a@b.c', 'tel:+1', 'blob:https://x/1', 'about:blank'])
    assert.equal(r.proxify(u, B), u, u);
  assert.equal(r.proxify('/~/https://already.test/', B), '/~/https://already.test/', 'never double-wraps');
});

test('unproxify: the address behind a proxied path', () => {
  const href = (p) => {
    const u = r.unproxify(p);
    return u && u.href;
  };
  assert.equal(href('/~/https://a.test/x?y=1'), 'https://a.test/x?y=1');
  assert.equal(href('/~/a.test/x'), 'https://a.test/x', 'scheme is optional');
  assert.equal(href('/~/https:/a.test/x'), 'https://a.test/x', 'survives slash-collapsing proxies');
  assert.equal(href('/~/http://a.test:8080/'), 'http://a.test:8080/');
  assert.equal(href('/~/https://a.test/%7Euser?x=%20y'), 'https://a.test/%7Euser?x=%20y', 'bytes are preserved');
  for (const bad of ['/other', '/~/', '/~/javascript:alert(1)', '/~/ftp://a.test/', '/~/file:///etc/passwd'])
    assert.equal(r.unproxify(bad), null, bad);
});

test('round trip', () => {
  for (const u of ['https://a.test/', 'https://a.test/p/q?x=1&y=%2F', 'http://a.test:81/a%20b', 'https://xn--bcher-kva.test/ü?q=ü']) {
    assert.equal(r.unproxify(r.proxify(u, B)).href, new URL(u).href, u);
  }
});

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><meta http-equiv="refresh" content="5; url=/next">
<link rel="stylesheet" href="s.css" integrity="sha256-x" crossorigin><script src="//cdn.test/a.js" integrity="sha384-y" nonce="n"></script>
<style>body{background:url("/bg.png")}</style><script>var a = "<a href=\\"/not-touched\\">";</script></head>
<body><a href="/abs" target="_top" ping="/ping">x</a><a href="rel">r</a><a href="#top">f</a><a HREF=/unquoted>u</a><a href='/single'>s</a><a href="javascript:go()">j</a>
<img src="pic.jpg" srcset="a.jpg 1x, /b.jpg 2x"><form action="/post" method="post"><button formaction=/b2></button></form>
<iframe src="https://frame.test/"></iframe><video poster="/p.png"><source src="/v.mp4"></video><div style="background:url(/d.png)"></div>
<svg><image xlink:href="/i.svg"/><use href="#id"/></svg><object data="/o.swf"></object>
<script type="importmap">{"imports":{"lib":"/lib.js"}}</script><script type="module">import x from "/mod.js";</script></body></html>`;

test('rewriteHtml: attributes, inline CSS, module scripts', () => {
  const out = r.rewriteHtml(HTML, B, { inject: '<INJECT>' });
  const has = (s) => assert.ok(out.includes(s), 'missing: ' + s);
  has('<head><INJECT><meta charset');
  has(`href="${P}/dir/s.css"`);
  has('src="/~/https://cdn.test/a.js"');
  has(`href="${P}/abs"`);
  has(`href="${P}/dir/rel"`);
  has('href="#top"');
  has(`HREF="${P}/unquoted"`);
  has(`href="${P}/single"`);
  has('href="javascript:go()"');
  has(`src="${P}/dir/pic.jpg"`);
  has(`srcset="${P}/dir/a.jpg 1x, ${P}/b.jpg 2x"`);
  has(`action="${P}/post"`);
  has(`formaction="${P}/b2"`);
  has('src="/~/https://frame.test/"');
  has(`poster="${P}/p.png"`);
  has(`src="${P}/v.mp4"`);
  has(`url(${P}/d.png)`);
  has(`url("${P}/bg.png")`);
  has(`xlink:href="${P}/i.svg"`);
  has('href="#id"');
  has(`data="${P}/o.swf"`);
  has(`"lib":"${P}/lib.js"`);
  has(`import x from "${P}/mod.js"`);
  has(`content="5; url=${P}/next"`);
  has('target="_self"');
});

test('rewriteHtml: what would break or leak is removed', () => {
  const out = r.rewriteHtml(HTML, B, { inject: '' });
  assert.ok(!/integrity=/.test(out), 'integrity hashes no longer match rewritten files');
  assert.ok(!/Content-Security-Policy/i.test(out), 'meta CSP would block the proxy');
  assert.ok(!/ping=/.test(out), 'ping would phone home directly');
  assert.ok(out.includes('var a = "<a href=\\"/not-touched\\">";'), 'script text is not parsed as markup');
  assert.ok(out.includes('nonce="n"'));
});

test('rewriteHtml: <base> changes what relative URLs mean', () => {
  const out = r.rewriteHtml('<head><base href="/base/"></head><a href="rel">r</a><img src="/abs.png">', B, { inject: '' });
  assert.ok(out.includes(`<base href="${P}/base/">`));
  assert.ok(out.includes(`href="${P}/base/rel"`));
  assert.ok(out.includes(`src="${P}/abs.png"`));
});

test('rewriteHtml: a document without <head> still gets the page script first', () => {
  for (const html of ['<p>hi</p>', '<html><body>hi</body></html>', '<!doctype html><title>t</title>', '']) {
    const out = r.rewriteHtml(html, B, { inject: '<INJECT>' });
    assert.ok(out.includes('<INJECT>'), JSON.stringify(html));
    const first = out.search(/<(?!!doctype|html|head|INJECT)[a-z]/i);
    assert.ok(first < 0 || out.indexOf('<INJECT>') < first, 'injected before any content: ' + JSON.stringify(out.slice(0, 80)));
  }
});

test('rewriteCss', () => {
  const out = r.rewriteCss(
    '@import url(/a.css); @import "b.css"; .x{background:url( "/c.png" )} .y{background:URL(d.png)} .z{src:url(data:font/woff2;base64,AA==)} @font-face{src:url(//cdn.test/f.woff2)}',
    B
  );
  assert.equal(
    out,
    `@import url(${P}/a.css); @import "${P}/dir/b.css"; .x{background:url( "${P}/c.png" )} .y{background:URL(${P}/dir/d.png)} .z{src:url(data:font/woff2;base64,AA==)} @font-face{src:url(/~/https://cdn.test/f.woff2)}`
  );
});

test('rewriteJs: only module specifiers that would escape; code is never rewritten', () => {
  const out = r.rewriteJs(
    'import a from "/a.js"; import {b} from "./b.js"; import "https://cdn.test/c.js"; export {d} from "//cdn.test/d.js"; import("/e.js"); fetch("/api")',
    B
  );
  assert.equal(
    out,
    `import a from "${P}/a.js"; import {b} from "./b.js"; import "/~/https://cdn.test/c.js"; export {d} from "/~/https://cdn.test/d.js"; import("${P}/e.js"); fetch("/api")`,
    "relative specifiers already resolve under the proxy; runtime calls are the page script's job"
  );
  const forms = {
    'import"/min.js";import{a as b}from"/min2.js";export*from"/min3.js"': `import"${P}/min.js";import{a as b}from"${P}/min2.js";export*from"${P}/min3.js"`,
    "import x, { y as z } from '/q.js'": `import x, { y as z } from '${P}/q.js'`,
    'import {\n  a,\n  b\n} from "/multi.js";': `import {\n  a,\n  b\n} from "${P}/multi.js";`,
    'export * as ns from "/ns.js"': `export * as ns from "${P}/ns.js"`,
    'const m = await import( "/lazy.js" )': `const m = await import( "${P}/lazy.js" )`,
    'x ? import("/a.js") : import(\'/b.js\')': `x ? import("${P}/a.js") : import('${P}/b.js')`,
    'function f(){}import k from"/after-brace.js"': `function f(){}import k from"${P}/after-brace.js"`,
  };
  for (const [src, want] of Object.entries(forms)) assert.equal(r.rewriteJs(src, B), want, src);
});

test('rewriteJs: things that only look like imports are left alone', () => {
  for (const src of [
    'var x = 1; // no imports',
    'var s = "import x from \'/dep.js\'";',
    'var s = \'import "/dep.js"\';',
    'const doc = `use import x from "/dep.js" in your code`;',
    'obj.import("/y"); $import("/z"); reimport("/w")',
    'var s = "import(\'/q.js\')";',
    'export const path = "/not/a/module";',
    'export default "/also/not";',
    'const from = "/x"; go(from, "/y")',
    'log("copied from " + "/tmp")',
    'import x from "./relative.js"; import("../up.js"); import y from "bare-name"',
    'import z from "/~/https://already.test/z.js"',
  ])
    assert.equal(r.rewriteJs(src, B), src, src);
});

test('import maps, HLS playlists, srcset', () => {
  assert.equal(
    r.rewriteImportMap('{"imports":{"lib":"/lib.js","lib/":"https://cdn.test/lib/"},"scopes":{"/scope/":{"a":"/b.js"}}}', B),
    `{"imports":{"lib":"${P}/lib.js","lib/":"/~/https://cdn.test/lib/"},"scopes":{"${P}/scope/":{"a":"${P}/b.js"}}}`
  );
  assert.equal(r.rewriteImportMap('not json', B), 'not json');
  assert.equal(
    r.rewriteM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"\n#EXTINF:4,\nseg1.ts\nhttps://cdn.test/seg2.ts\n', B),
    `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${P}/key.bin"\n#EXTINF:4,\n${P}/dir/seg1.ts\n/~/https://cdn.test/seg2.ts\n`
  );
  assert.equal(
    r.rewriteSrcset('a.jpg 1x, /b.jpg 2x,https://c.test/c.jpg 640w, data:image/png;base64,AA== 3x', B),
    `${P}/dir/a.jpg 1x, ${P}/b.jpg 2x, /~/https://c.test/c.jpg 640w, data:image/png;base64,AA== 3x`
  );
});

test('entities', () => {
  assert.equal(r.decode('a&amp;b&#x2F;c&#47;d&quot;e&lt;f&gt;g'), 'a&b/c/d"e<f>g');
  assert.equal(r.encode('a&b<c>"d"'), 'a&amp;b&lt;c&gt;&quot;d&quot;');
  assert.ok(
    r.rewriteHtml('<a href="/a?x=1&amp;y=2">', B, { inject: '' }).includes(`href="${P}/a?x=1&amp;y=2"`),
    'entities survive the round trip'
  );
});

test('response time: hostile markup is handled in linear time', () => {
  const cases = {
    'unclosed tags': '<a '.repeat(300000),
    'unclosed attribute': '<a href="' + 'x'.repeat(1e6),
    'attribute soup': '<a ' + 'x=y '.repeat(250000) + '>',
    'nested quotes': ('<a href=\'"' + '"\''.repeat(20) + '>').repeat(20000),
    'open comment': '<!--' + '-'.repeat(1e6),
    'open script': '<script>' + '</scrip'.repeat(150000),
    'open style': '<style>' + 'url('.repeat(250000),
    'srcset commas': '<img srcset="' + ','.repeat(1e6) + '">',
    'meta refresh': '<meta http-equiv="refresh" content="' + '0;'.repeat(500000) + '">',
    'angle brackets': '<'.repeat(1e6),
    'spaces in tag': '<a' + ' '.repeat(1e6) + 'href=/x>',
  };
  for (const [name, html] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    r.rewriteHtml(html, B, { inject: '' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, name + ' took ' + ms.toFixed(0) + ' ms');
  }
  const css = {
    'open url': 'url('.repeat(300000),
    'open import': '@import "'.repeat(150000),
    'open comment': '/*'.repeat(500000),
    'url spaces': 'url(' + ' '.repeat(1e6),
  };
  for (const [name, text] of Object.entries(css)) {
    const t0 = process.hrtime.bigint();
    r.rewriteCss(text, B);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, 'css ' + name + ' took ' + ms.toFixed(0) + ' ms');
  }
  const js = {
    imports: 'import '.repeat(200000),
    'import(': 'import('.repeat(200000),
    from: ' from '.repeat(200000),
    quotes: '"'.repeat(1e6),
    'long clauses': (';import ' + 'a'.repeat(590)).repeat(3000),
    'export runs': ';export '.repeat(200000),
    'clause then nothing': ('\nimport {' + ' a,'.repeat(190)).repeat(3000),
  };
  for (const [name, text] of Object.entries(js)) {
    const t0 = process.hrtime.bigint();
    r.rewriteJs(text, B);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, 'js ' + name + ' took ' + ms.toFixed(0) + ' ms');
  }
});

test('response time: a large real-looking page rewrites at a healthy rate', () => {
  const row =
    '<div class="item"><a href="/item/123?ref=list&amp;x=1" title="An item">Item</a><img src="/img/123.jpg" srcset="/img/123.jpg 1x, /img/123@2x.jpg 2x" alt=""><p>Some text about the item that goes on for a bit.</p></div>\n';
  const html = '<!doctype html><html><head><title>Big</title></head><body>' + row.repeat(20000) + '</body></html>';
  const t0 = process.hrtime.bigint();
  const out = r.rewriteHtml(html, B, { inject: '<INJECT>' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const mbps = html.length / 1048576 / (ms / 1000);
  assert.equal(out.split(P + '/item/123').length - 1, 20000);
  assert.ok(mbps > 3, 'rewrote ' + (html.length / 1048576).toFixed(1) + ' MB at ' + mbps.toFixed(1) + ' MB/s');
});
