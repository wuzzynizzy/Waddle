/* Waddle service worker.
   1. Whatever slips past rewriting is sent back through the proxy, so the browser itself never contacts a site.
   2. Every answer from Waddle carries "X-Waddle: 1". A page without it was put there by something in
      between (a host's edge speaking while the server is away) and is never shown: a plain
      "reconnecting" screen is, which comes back by itself.
   3. The app's own files are kept, so it still opens when the server cannot be reached.

   Requests that are already on the proxy are left exactly as the browser made them. A request re-sent
   from here would reach the server looking like a script's fetch(), whatever it really was, so pages
   are asked for by the browser itself (navigation preload) and only their answers are looked at. */
'use strict';
var P = '/~/';
var SHELL = 'waddle-shell-3';
var ASSET = /^\/-\/(?:app\.js|app\.css|client\.js|icon\.svg|fonts\/[\w-]+\.woff2)$/;
var PRELOAD = !!(self.registration && self.registration.navigationPreload);

self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return k.indexOf('waddle-shell-') === 0 && k !== SHELL ? caches.delete(k) : null;
          })
        );
      })
      .then(function () {
        return PRELOAD ? self.registration.navigationPreload.enable().catch(function () {}) : null;
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/** The real address behind a proxied one, or null. */
function real(href) {
  var s = String(href || '');
  if (s.indexOf(self.location.origin) === 0) s = s.slice(self.location.origin.length);
  if (s.indexOf(P) !== 0) return null;
  s = s
    .slice(P.length)
    .replace(/^f\/(?=https?:\/)/i, '')
    .replace(/^(https?):\/+/i, '$1://');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s);
  } catch (e) {
    return null;
  }
}

/**
 * The proxied page (or worker) a request was made by. Its referrer says so, unless a referrer policy
 * has cut that down to the bare origin, as happens for requests to other hosts: then the client is asked.
 */
function pageOf(e) {
  var r = e.request.referrer;
  if (r && real(r)) return Promise.resolve(r);
  if (!e.clientId) return Promise.resolve('');
  return self.clients.get(e.clientId).then(
    function (c) {
      return c && real(c.url) ? c.url : '';
    },
    function () {
      return '';
    }
  );
}

/** Is this Waddle's own answer? Only a readable same-origin response can be checked; a redirect in flight is let through. */
function marked(res) {
  return res.type !== 'basic' || res.headers.get('X-Waddle') === '1';
}

/** Put back the status the site really answered with. */
function restore(res) {
  var told = res.type === 'basic' ? res.headers.get('X-Waddle-Status') : null;
  var status = Number(told);
  if (!told || !(status >= 200 && status <= 599) || status === res.status) return res;
  var empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : res.body, { status: status, statusText: res.statusText, headers: res.headers });
}

var AWAY_CSS =
  '@font-face{font-family:Geist;src:url(/-/fonts/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}' +
  ':root{--bg:#f5f6f8;--card:#fff;--line:#e2e6eb;--text:#0e1620;--muted:#5d6875;--accent:#ff8a1f;--ink:#1c1206;color-scheme:light}' +
  '@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0b0f14;--card:#121821;--line:#232c38;--text:#e9eef4;--muted:#94a1b0;color-scheme:dark}}' +
  ':root[data-theme=dark]{--bg:#0b0f14;--card:#121821;--line:#232c38;--text:#e9eef4;--muted:#94a1b0;color-scheme:dark}' +
  '*{box-sizing:border-box}html{height:100%}' +
  'body{margin:0;min-height:100%;display:grid;place-items:center;padding:32px 20px;background:var(--bg);color:var(--text);' +
  'font:15px/1.55 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}' +
  'main{width:100%;max-width:440px}img{width:44px;height:44px;display:block;margin:0 0 20px}' +
  'h1{font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.01em;margin:0 0 8px}p{margin:0;color:var(--muted)}' +
  'button{font:inherit;font-weight:550;border:1px solid var(--accent);background:var(--accent);color:var(--ink);border-radius:10px;padding:9px 16px;cursor:pointer;margin:26px 0 0}' +
  'button:focus-visible{outline:2px solid var(--text);outline-offset:2px}' +
  '.wait{margin:18px 0 0;font-size:13px;color:var(--muted);min-height:1.5em}';

/** Shown in place of a page when the server did not answer: waits, and comes back by itself. */
function away() {
  var html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Reconnecting</title><style>' +
    AWAY_CSS +
    '</style><script>try{var t=localStorage.getItem("waddle.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>' +
    '</head><body><main><img src="/-/icon.svg" alt=""><h1>Reconnecting</h1>' +
    '<p>Waddle is not answering right now. This page comes back by itself.</p>' +
    '<button id="go">Try again</button><div class="wait" id="wait" role="status"></div></main><script>(function(){' +
    'var wait=2,left=wait,w=document.getElementById("wait"),busy=false;' +
    'try{if(parent!==window)parent.postMessage({waddle:1,kind:"away"},location.origin)}catch(e){}' +
    'function ping(){if(busy)return;busy=true;w.textContent="Checking";' +
    'fetch("/-/ping",{cache:"no-store"}).then(function(r){return r.headers.get("X-Waddle")==="1"},function(){return false}).then(function(up){' +
    'busy=false;if(up){location.reload();return}wait=Math.min(30,wait*2);left=wait})}' +
    'document.getElementById("go").onclick=ping;' +
    'setInterval(function(){if(busy)return;if(left<=0){ping();return}w.textContent="Trying again in "+left+" s";left--},1000)' +
    '})()</script></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Waddle': '1', 'X-Waddle-Error': 'away' },
  });
}

/** The answer to a navigation: the one the browser already asked for itself, or else asked for now. */
function answer(e) {
  var ask = function () {
    return fetch(e.request);
  };
  if (!e.preloadResponse) return ask();
  return Promise.resolve(e.preloadResponse).then(function (res) {
    return res || ask();
  }, ask);
}

/** A page being opened. */
function nav(e) {
  return answer(e).then(
    function (res) {
      return marked(res) ? res : away();
    },
    function () {
      return away();
    }
  );
}

/** One of the app's own files: from the server when it answers, from the kept copy when it does not. */
function shell(e, key, page) {
  var kept = function () {
    return caches.match(key, { cacheName: SHELL }).then(function (hit) {
      return hit || (page ? away() : Response.error());
    });
  };
  return (page ? answer(e) : fetch(e.request)).then(function (res) {
    if (res.type === 'basic' && res.status === 200 && res.headers.get('X-Waddle') === '1') {
      var copy = res.clone();
      e.waitUntil(
        caches
          .open(SHELL)
          .then(function (c) {
            return c.put(key, copy);
          })
          .catch(function () {})
      );
      return res;
    }
    return marked(res) ? res : kept();
  }, kept);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  var same = url.origin === self.location.origin;
  var path = url.pathname;

  if (req.mode === 'navigate') {
    // Without a preloaded answer (a form being posted, an older browser) the browser's own request goes out untouched.
    if (!PRELOAD || req.method !== 'GET') return;
    // A proxied page, or a stray navigation from one (the server sends that back in).
    if (path.indexOf(P) === 0 || real(req.referrer)) e.respondWith(nav(e));
    else if (path === '/' || path === '/index.html') e.respondWith(shell(e, '/', true));
    else e.respondWith(answer(e));
    return;
  }
  if (same && path.indexOf(P) === 0) return; // already on the proxy: nothing to add
  if (same && path.indexOf('/-/') === 0) {
    // The app's files are kept; its API, sockets and the rest speak for themselves.
    if (req.method === 'GET' && ASSET.test(path)) e.respondWith(shell(e, path, false));
    return;
  }
  // A request that escaped rewriting: through the proxy it goes.
  e.respondWith(
    pageOf(e).then(function (page) {
      var to;
      if (same) {
        var at = real(page);
        if (!at) return fetch(req); // the app's own (its icon, say)
        to = P + new URL(url.pathname + url.search, at.origin).href;
      } else {
        to = P + url.href;
      }
      // Sent again from here it would look like a script's fetch(): say what it was (an image, a worker, …).
      var headers = new Headers(req.headers);
      headers.set('X-Waddle-Dest', req.destination || 'empty');
      headers.set('X-Waddle-Mode', req.mode);
      var init = { method: req.method, headers: headers, credentials: 'same-origin', redirect: 'follow', cache: req.cache };
      if (page) init.referrer = page;
      var check = function (res) {
        return marked(res) ? restore(res) : Response.error();
      };
      if (req.method === 'GET' || req.method === 'HEAD') return fetch(to, init).then(check);
      return req.blob().then(function (body) {
        init.body = body;
        return fetch(to, init).then(check);
      });
    })
  );
});
