/* Waddle service worker: whatever slips past rewriting is sent back through the proxy. */
'use strict';
var P = '/~/';
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

function real(href) {
  var s = String(href || '');
  if (s.indexOf(self.location.origin) === 0) s = s.slice(self.location.origin.length);
  if (s.indexOf(P) !== 0) return null;
  s = s.slice(P.length).replace(/^(https?):\/+/i, '$1://');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s);
  } catch (e) {
    return null;
  }
}

function pageOf(e) {
  var r = e.request.referrer;
  if (r && r.indexOf('about:') !== 0) return Promise.resolve(r);
  if (!e.clientId) return Promise.resolve('');
  return self.clients.get(e.clientId).then(
    function (c) {
      return c ? c.url : '';
    },
    function () {
      return '';
    }
  );
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
  var same = url.origin === self.location.origin;
  if (same && (url.pathname.indexOf(P) === 0 || url.pathname.indexOf('/-/') === 0)) return; // already on the proxy
  if (req.mode === 'navigate') return; // the server redirects stray navigations itself
  e.respondWith(
    pageOf(e).then(function (page) {
      var to;
      if (same) {
        var at = real(page);
        if (!at) return fetch(req);
        to = P + new URL(url.pathname + url.search, at.origin).href;
      } else {
        to = P + url.href;
      }
      var init = { method: req.method, headers: req.headers, credentials: 'same-origin', redirect: 'follow', cache: req.cache };
      if (page) init.referrer = page;
      if (req.method === 'GET' || req.method === 'HEAD') return fetch(to, init);
      return req.blob().then(function (body) {
        init.body = body;
        return fetch(to, init);
      });
    })
  );
});
