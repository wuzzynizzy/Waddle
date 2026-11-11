/* Waddle page script. Runs first in every proxied document, and at the top of every worker a page
   starts: keeps every request on the proxy and presents the configured identity (system, screen,
   locale, …), the same one in the page, its frames and its workers. */
(function () {
  'use strict';
  var MARK = '__waddle$';
  var P = '/~/';
  var G = typeof self !== 'undefined' ? self : this;
  var ORIGIN = G.location.origin;
  var WORKER = typeof document === 'undefined'; // inside a worker there is no page, only requests and an identity
  var SELF = ORIGIN + '/-/client.js';
  var data = {};
  if (WORKER) {
    data = G.__waddle || {};
    try {
      delete G.__waddle;
    } catch (e) {
      /* stays */
    }
    if (data.src) SELF = data.src;
  } else {
    var script = document.currentScript;
    try {
      data = JSON.parse(script.getAttribute('data-w')) || {};
    } catch (e) {
      /* no settings */
    }
    try {
      if (script && script.src) SELF = script.src;
      if (script && script.parentNode) script.parentNode.removeChild(script);
    } catch (e) {
      /* fine */
    }
  }
  var page = data.page || {};
  var SKIP = /^(?:#|data:|blob:|javascript:|about:|mailto:|tel:|sms:|magnet:)/i;
  var ABS = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rng(s) {
    // mulberry32
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Real href behind a proxied URL, or null. */
  function unp(href) {
    var s = String(href);
    if (s.indexOf(ORIGIN) === 0) s = s.slice(ORIGIN.length);
    if (s.indexOf(P) !== 0) return null;
    s = s
      .slice(P.length)
      .replace(/^f\/(?=(?:https?|wss?):\/)/i, '') // "f/" marks a document shown in a frame
      .replace(/^(https?|wss?):\/+/i, '$1://');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }

  /**
   * @param {boolean} [own] the window belongs to the document this script was loaded by. Without it, the
   *   window is a blank frame that some page made, prepared from outside with that page's settings.
   */
  function install(W, own) {
    if (!W) return;
    var D = W.document; // undefined in a worker
    try {
      var was = W[MARK];
      // Done already for the document this window shows. A mark left for another document is the one a
      // page put on a frame while it was still blank; the browser keeps that window when the frame then
      // loads a real document, and that document's own hooks go on top of the ones that stood down.
      if (was && (!D || was.doc === D)) return;
      Object.defineProperty(W, MARK, { value: { doc: D }, writable: true, configurable: true });
    } catch (e) {
      return;
    }
    var N = W.navigator;
    var L = W.location;
    var safe = function (fn) {
      try {
        fn();
      } catch (e) {
        /* one broken hook must not take the others down */
      }
    };
    // Hooks put into a blank frame from outside belong to the blank document. Once another document has
    // the window they stand down: every one of them passes straight through to what it wrapped.
    var stale = false;
    var gone = function () {
      return !own && (stale || (stale = W.document !== D));
    };
    /** `hook` while this install is in charge, `pass` after it has stood down. */
    var guard = function (hook, pass) {
      if (own) return hook;
      return function () {
        return gone() ? pass.apply(this, arguments) : hook.apply(this, arguments);
      };
    };
    /** An event listener that stops listening once this install has stood down. */
    var listen = function (target, type, fn, capture) {
      target.addEventListener(
        type,
        own
          ? fn
          : function (e) {
              if (!gone()) return fn.call(this, e);
            },
        capture
      );
    };

    // ---- look native ------------------------------------------------------------
    var natives = new W.WeakMap();
    var fts = W.Function.prototype.toString;
    var mask = function (fn, name) {
      natives.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }');
      return fn;
    };
    safe(function () {
      W.Function.prototype.toString = mask(function toString() {
        return natives.has(this) ? natives.get(this) : fts.call(this);
      }, 'toString');
    });
    var getter = function (obj, prop, fn) {
      try {
        var d = Object.getOwnPropertyDescriptor(obj, prop);
        var before =
          d && d.get
            ? d.get
            : function () {
                return d ? d.value : undefined;
              };
        Object.defineProperty(obj, prop, {
          get: mask(guard(fn, before), 'get ' + prop),
          set: d && d.set,
          enumerable: d ? d.enumerable : true,
          configurable: true,
        });
      } catch (e) {
        /* not configurable here */
      }
    };
    var value = function (obj, prop, v) {
      getter(obj, prop, function () {
        return v;
      });
    };
    var drop = function (obj, prop) {
      try {
        delete obj[prop];
        if (prop in obj)
          Object.defineProperty(obj, prop, {
            get: mask(function () {
              return undefined;
            }, 'get ' + prop),
            configurable: true,
          });
      } catch (e) {
        /* stays */
      }
    };
    var wrap = function (obj, prop, make) {
      try {
        if (!obj) return;
        var d = Object.getOwnPropertyDescriptor(obj, prop);
        var o = obj[prop];
        if (typeof o !== 'function') return;
        var f = mask(guard(make(o), o), prop);
        try {
          Object.defineProperty(f, 'name', { value: prop, configurable: true });
          Object.defineProperty(f, 'length', { value: o.length, configurable: true });
        } catch (e) {
          /* cosmetic */
        }
        Object.defineProperty(obj, prop, { value: f, writable: true, configurable: true, enumerable: d ? d.enumerable : true });
      } catch (e) {
        /* leave native */
      }
    };
    var ctor = function (name, fix) {
      var Native = W[name];
      if (typeof Native !== 'function') return;
      var F = function () {
        var a = [].slice.call(arguments);
        var extra = null;
        try {
          if (!gone()) extra = fix(a);
        } catch (e) {
          /* pass through */
        }
        var obj = Reflect.construct(Native, a, new.target || F);
        if (extra)
          try {
            extra(obj);
          } catch (e) {
            /* cosmetic */
          }
        return obj;
      };
      F.prototype = Native.prototype;
      Object.getOwnPropertyNames(Native).forEach(function (k) {
        if (k === 'prototype' || k === 'length' || k === 'name') return;
        try {
          Object.defineProperty(F, k, Object.getOwnPropertyDescriptor(Native, k));
        } catch (e) {
          /* skip */
        }
      });
      try {
        Object.defineProperty(F, 'name', { value: name });
      } catch (e) {
        /* cosmetic */
      }
      mask(F, name);
      try {
        W[name] = F;
      } catch (e) {
        /* read-only */
      }
    };

    // ---- addresses --------------------------------------------------------------
    var baseKey = null;
    var baseVal = null;
    var realBase = function () {
      if (!D) return data.base || unp(L.href);
      var b = D.baseURI || L.href;
      if (b !== baseKey) {
        baseKey = b;
        baseVal = unp(b);
      }
      return baseVal;
    };
    var needs = function (s) {
      return ABS.test(s) || (s.charCodeAt(0) === 47 && s.indexOf(P) !== 0 && s.indexOf('/-/') !== 0);
    };
    /** Proxied form of a URL that would otherwise leave the proxy; everything else unchanged. */
    var px = function (u) {
      if (u == null) return u;
      var s = String(u).trim();
      if (!s || SKIP.test(s) || !needs(s)) return u;
      var base = realBase();
      if (!base) return u;
      var a;
      try {
        a = new W.URL(s, base);
      } catch (e) {
        return u;
      }
      if (a.origin === ORIGIN) {
        if (a.pathname.indexOf(P) === 0 || a.pathname.indexOf('/-/') === 0) return u;
        try {
          a = new W.URL(a.pathname + a.search + a.hash, base);
        } catch (e) {
          return u;
        }
      }
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
      return P + a.href;
    };
    /** The same for the content of a frame: marked, so the server can tell what a page embeds from what a visitor opens. */
    var pxFrame = function (u) {
      var r = px(u);
      if (r == null) return r;
      try {
        var s = String(r).trim();
        if (!s || SKIP.test(s)) return r;
        var a = new W.URL(s, D ? D.baseURI : L.href);
        if (a.origin !== ORIGIN || a.pathname.indexOf(P) !== 0) return r;
        var rest = a.href.slice(ORIGIN.length + P.length);
        return /^f\/https?:\//i.test(rest) ? r : P + 'f/' + rest;
      } catch (e) {
        return r;
      }
    };
    var pxSet = function (v) {
      var parts = String(v).split(/(\s+)/);
      var expect = true;
      for (var i = 0; i < parts.length; i++) {
        var t = parts[i];
        if (!t || /^\s+$/.test(t)) continue;
        var tail = '';
        while (t.slice(-1) === ',') {
          t = t.slice(0, -1);
          tail += ',';
        }
        if (expect && t) t = px(t);
        expect = tail !== '';
        parts[i] = t + tail;
      }
      return parts.join('');
    };
    var internal = function (u) {
      try {
        var a = new W.URL(String(u), L.href);
        return a.origin === ORIGIN && a.pathname.indexOf('/-/api') === 0;
      } catch (e) {
        return false;
      }
    };
    var realOrigin = function () {
      try {
        return new W.URL(realBase()).origin;
      } catch (e) {
        return ORIGIN;
      }
    };
    var realHost = function () {
      try {
        return new W.URL(realBase()).host;
      } catch (e) {
        return '';
      }
    };

    // ---- cookies (kept on the server; this is the page's view of them) ---------------
    // data.jar === false: this document is a third party where it is shown (or cookies are off), and gets none.
    var mayCookie = data.jar !== false;
    var jar = [];
    var readJar = function (text) {
      jar = [];
      String(text || '')
        .split('; ')
        .forEach(function (pair) {
          if (!pair) return;
          var i = pair.indexOf('=');
          jar.push(i < 0 ? ['', pair] : [pair.slice(0, i), pair.slice(i + 1)]);
        });
    };
    if (mayCookie) readJar(data.cookie);
    var cookieEcho = function (v) {
      if (v != null && mayCookie)
        try {
          readJar(decodeURIComponent(v));
        } catch (e) {
          /* ignore */
        }
    };
    var nfetch = W.fetch;
    safe(function () {
      if (!D) return;
      var cd = Object.getOwnPropertyDescriptor(W.Document.prototype, 'cookie');
      if (!cd) return;
      Object.defineProperty(W.Document.prototype, 'cookie', {
        configurable: true,
        enumerable: cd.enumerable,
        get: mask(
          guard(function () {
            return jar
              .map(function (c) {
                return c[0] ? c[0] + '=' + c[1] : c[1];
              })
              .join('; ');
          }, cd.get),
          'get cookie'
        ),
        set: mask(function (line) {
          if (gone()) return cd.set.call(this, line);
          if (!mayCookie) return;
          line = String(line);
          var parts = line.split(';');
          var first = parts[0];
          var i = first.indexOf('=');
          var name = (i < 0 ? '' : first.slice(0, i)).trim();
          var val = (i < 0 ? first : first.slice(i + 1)).trim();
          var expired = false;
          for (var k = 1; k < parts.length; k++) {
            var a = parts[k].trim().toLowerCase();
            if (a.indexOf('max-age=') === 0 && parseInt(a.slice(8), 10) <= 0) expired = true;
            if (a.indexOf('expires=') === 0 && Date.parse(parts[k].trim().slice(8)) <= Date.now()) expired = true;
            if (a === 'httponly') return;
          }
          jar = jar.filter(function (c) {
            return c[0] !== name;
          });
          if (!expired) jar.push([name, val]);
          try {
            nfetch
              .call(W, '/-/cookie', {
                method: 'POST',
                body: line,
                keepalive: true,
                credentials: 'same-origin',
                headers: { 'content-type': 'text/plain' },
              })
              .catch(function () {});
          } catch (e) {
            /* offline */
          }
        }, 'set cookie'),
      });
      if (!mayCookie) value(W.Navigator.prototype, 'cookieEnabled', false);
    });

    // ---- network ----------------------------------------------------------------
    // Some hosts replace 502/504 answers with pages of their own, so the server sends those under another
    // code and names the real one in a header. The service worker puts it back; this covers the times it is not there.
    var realStatus = function (res) {
      var told = res.headers.get('x-waddle-status');
      var st = Number(told);
      if (!told || !(st >= 100 && st <= 599) || st === res.status) return;
      Object.defineProperty(res, 'status', { value: st, configurable: true });
      Object.defineProperty(res, 'ok', { value: st >= 200 && st <= 299, configurable: true });
    };
    wrap(W, 'fetch', function (o) {
      return function (input, init) {
        try {
          if (typeof input === 'string' || input instanceof W.URL) input = px(String(input));
          else if (input && input.url) {
            var u = px(input.url);
            if (u !== input.url) input = new W.Request(u, input);
          }
          if (internal(typeof input === 'string' ? input : input.url)) return W.Promise.reject(new W.TypeError('Failed to fetch'));
        } catch (e) {
          /* send as is */
        }
        var p = o.call(this, input, init);
        p.then(
          function (res) {
            try {
              realStatus(res);
              cookieEcho(res.headers.get('x-waddle-cookie'));
            } catch (e) {
              /* opaque */
            }
          },
          function () {}
        );
        return p;
      };
    });
    safe(function () {
      var seen = new W.WeakSet();
      wrap(W.XMLHttpRequest.prototype, 'open', function (o) {
        return function (method, url) {
          var a = [].slice.call(arguments);
          try {
            a[1] = px(String(url));
            if (internal(a[1])) a[1] = '/-/blocked';
          } catch (e) {
            /* as is */
          }
          if (!seen.has(this)) {
            seen.add(this);
            this.addEventListener('readystatechange', function () {
              if (this.readyState === 2)
                try {
                  cookieEcho(this.getResponseHeader('x-waddle-cookie'));
                } catch (e) {
                  /* none */
                }
            });
          }
          return o.apply(this, a);
        };
      });
      var sd = Object.getOwnPropertyDescriptor(W.XMLHttpRequest.prototype, 'status');
      getter(W.XMLHttpRequest.prototype, 'status', function () {
        var st = sd.get.call(this);
        if (st === 500)
          try {
            var told = Number(this.getResponseHeader('x-waddle-status'));
            if (told >= 100 && told <= 599) return told;
          } catch (e) {
            /* not there yet */
          }
        return st;
      });
    });
    safe(function () {
      wrap(W.Navigator.prototype, 'sendBeacon', function (o) {
        return function (u, d) {
          return o.call(this, px(u), d);
        };
      });
    });
    if (!D)
      wrap(W, 'importScripts', function (o) {
        return function () {
          return o.apply(this, [].map.call(arguments, px));
        };
      });
    ctor('WebSocket', function (a) {
      var base = realBase() || L.href;
      var u = new W.URL(String(a[0]), base);
      if (u.origin === ORIGIN || u.origin === ORIGIN.replace(/^http/, 'ws')) u = new W.URL(u.pathname + u.search, base);
      u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
      var real = u.href;
      a[0] = ORIGIN.replace(/^http/, 'ws') + '/-/ws?u=' + encodeURIComponent(real) + '&o=' + encodeURIComponent(realOrigin());
      return function (ws) {
        Object.defineProperty(ws, 'url', { value: real, configurable: true });
      };
    });
    ctor('EventSource', function (a) {
      a[0] = px(a[0]);
    });
    // A worker fetched from the site gets this script put in front of it by the server. One built from a
    // Blob never touches the server, so it is started through a small wrapper that loads this script first.
    var wrapped = new W.Set();
    ctor('Worker', function (a) {
      var u = String(a[0]);
      if (/^blob:/i.test(u) && !(a[1] && a[1].type === 'module')) {
        var boot =
          'self.__waddle=' +
          JSON.stringify({ page: page, base: realBase(), part: data.part, src: SELF }) +
          ';importScripts(' +
          JSON.stringify(SELF) +
          ');importScripts(' +
          JSON.stringify(u) +
          ');';
        wrapped.add(u);
        a[0] = W.URL.createObjectURL(new W.Blob([boot], { type: 'text/javascript' }));
      } else a[0] = px(a[0]);
    });
    safe(function () {
      // Pages revoke a Blob address right after starting the worker; the wrapper still has to read it.
      wrap(W.URL, 'revokeObjectURL', function (o) {
        return function (u) {
          if (wrapped.has(String(u))) {
            wrapped.delete(String(u));
            W.setTimeout(function () {
              o.call(W.URL, u);
            }, 60000);
            return undefined;
          }
          return o.apply(this, arguments);
        };
      });
    });
    ctor('SharedWorker', function (a) {
      a[0] = px(a[0]);
    });

    // Every proxied site lives on Waddle's own origin, so anything keyed by origin gets a name of its own:
    // one bucket per real site, and a separate one again when that site is only embedded in another's page.
    var bucket = function () {
      return (data.part ? data.part + '\u0002' : '') + realOrigin();
    };
    safe(function () {
      var pre = bucket() + '|';
      wrap(W.IDBFactory.prototype, 'open', function (o) {
        return function (name) {
          arguments[0] = pre + name;
          return o.apply(this, arguments);
        };
      });
      wrap(W.IDBFactory.prototype, 'deleteDatabase', function (o) {
        return function (name) {
          arguments[0] = pre + name;
          return o.apply(this, arguments);
        };
      });
      wrap(W.IDBFactory.prototype, 'databases', function (o) {
        return function () {
          return o.call(this).then(function (list) {
            return list
              .filter(function (d) {
                return String(d.name).indexOf(pre) === 0;
              })
              .map(function (d) {
                return { name: d.name.slice(pre.length), version: d.version };
              });
          });
        };
      });
      var nd = Object.getOwnPropertyDescriptor(W.IDBDatabase.prototype, 'name');
      getter(W.IDBDatabase.prototype, 'name', function () {
        var n = nd.get.call(this);
        return n.indexOf(pre) === 0 ? n.slice(pre.length) : n;
      });
    });
    safe(function () {
      var pre = bucket() + '|';
      var CS = W.CacheStorage.prototype;
      ['open', 'has', 'delete'].forEach(function (k) {
        wrap(CS, k, function (o) {
          return function (name) {
            arguments[0] = pre + name;
            return o.apply(this, arguments);
          };
        });
      });
      wrap(CS, 'keys', function (o) {
        return function () {
          return o.call(this).then(function (list) {
            return list
              .filter(function (k) {
                return k.indexOf(pre) === 0;
              })
              .map(function (k) {
                return k.slice(pre.length);
              });
          });
        };
      });
      wrap(CS, 'match', function (o) {
        return function (req, opt) {
          var me = this;
          if (opt && opt.cacheName) return o.call(me, req, Object.assign({}, opt, { cacheName: pre + opt.cacheName }));
          // Without a name every cache is searched: only this site's may be.
          return me.keys().then(function (names) {
            var next = function (i) {
              if (i >= names.length) return undefined;
              return o.call(me, req, Object.assign({}, opt, { cacheName: pre + names[i] })).then(function (hit) {
                return hit || next(i + 1);
              });
            };
            return next(0);
          });
        };
      });
    });
    ctor('BroadcastChannel', function (a) {
      var name = String(a[0]);
      a[0] = bucket() + '|' + name;
      return function (ch) {
        Object.defineProperty(ch, 'name', { value: name, configurable: true });
      };
    });

    if (D) pageHooks();
    if (page.on) identity();

    function pageHooks() {
      var controlled = false;
      safe(function () {
        controlled = !!(N.serviceWorker && N.serviceWorker.controller);
      });
      safe(function () {
        // sites' own service workers would collide with the proxy's
        var sp = W.ServiceWorkerContainer && W.ServiceWorkerContainer.prototype;
        if (!sp) return;
        wrap(sp, 'register', function () {
          return function () {
            return W.Promise.reject(new W.DOMException('Service workers are unavailable.', 'SecurityError'));
          };
        });
        wrap(sp, 'getRegistration', function () {
          return function () {
            return W.Promise.resolve(undefined);
          };
        });
        wrap(sp, 'getRegistrations', function () {
          return function () {
            return W.Promise.resolve([]);
          };
        });
      });

      // Nothing may leave for the open internet on its own. With the service worker in
      // charge strays are re-routed; without it they are refused outright.
      safe(function () {
        if (controlled || !realBase() || !D.head) return;
        var m = D.createElement('meta');
        m.httpEquiv = 'Content-Security-Policy';
        // A blank frame has no address of its own, so Waddle's is spelled out.
        m.content =
          "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob: " + ORIGIN.replace(/^http/, 'ws');
        D.head.insertBefore(m, D.head.firstChild);
      });

      // ---- DOM --------------------------------------------------------------------
      var nSet = W.Element.prototype.setAttribute;
      var URL_ATTR = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'xlink:href'];
      var EMBEDS = { iframe: 1, frame: 1, embed: 1, object: 1 }; // elements whose content is another document
      var FRAME_PROP = { HTMLIFrameElement: 1, HTMLFrameElement: 1, HTMLEmbedElement: 1, HTMLObjectElement: 1 };
      // A frame sandboxed out of its origin would fall out of the service worker's reach, and its requests with it.
      var sandbox = function (v) {
        v = String(v);
        return /(?:^|\s)allow-same-origin(?:\s|$)/i.test(v) ? v : (v + ' allow-same-origin').trim();
      };
      [
        ['HTMLAnchorElement', 'href'],
        ['HTMLAreaElement', 'href'],
        ['HTMLLinkElement', 'href'],
        ['HTMLImageElement', 'src'],
        ['HTMLScriptElement', 'src'],
        ['HTMLIFrameElement', 'src'],
        ['HTMLFrameElement', 'src'],
        ['HTMLEmbedElement', 'src'],
        ['HTMLSourceElement', 'src'],
        ['HTMLTrackElement', 'src'],
        ['HTMLMediaElement', 'src'],
        ['HTMLInputElement', 'src'],
        ['HTMLInputElement', 'formAction'],
        ['HTMLButtonElement', 'formAction'],
        ['HTMLFormElement', 'action'],
        ['HTMLObjectElement', 'data'],
        ['HTMLVideoElement', 'poster'],
        ['HTMLImageElement', 'srcset'],
        ['HTMLSourceElement', 'srcset'],
      ].forEach(function (x) {
        safe(function () {
          var proto = W[x[0]].prototype;
          var d = Object.getOwnPropertyDescriptor(proto, x[1]);
          if (!d || !d.set) return;
          var fix = x[1] === 'srcset' ? pxSet : FRAME_PROP[x[0]] ? pxFrame : px;
          var framed = !!FRAME_PROP[x[0]];
          Object.defineProperty(proto, x[1], {
            get: d.get,
            set: mask(
              guard(function (v) {
                if (framed && this.hasAttribute('sandbox')) {
                  var sb = this.getAttribute('sandbox');
                  if (sandbox(sb) !== sb) nSet.call(this, 'sandbox', sandbox(sb));
                }
                return d.set.call(this, fix(v));
              }, d.set),
              'set ' + x[1]
            ),
            enumerable: d.enumerable,
            configurable: true,
          });
        });
      });
      var fixAttr = function (el, name, v) {
        var n = String(name).toLowerCase();
        if (n === 'srcset' || n === 'imagesrcset') return pxSet(v);
        if (URL_ATTR.indexOf(n) >= 0) {
          if (n === 'data' && el.localName !== 'object') return v;
          return EMBEDS[el.localName] && (n === 'src' || n === 'data') ? pxFrame(v) : px(v);
        }
        if (n === 'target' && /^_(?:top|parent)$/i.test(String(v))) return '_self';
        if (n === 'sandbox' && el.localName === 'iframe') return sandbox(v);
        return v;
      };
      wrap(W.Element.prototype, 'setAttribute', function (o) {
        return function (name, v) {
          try {
            if (String(name).toLowerCase() === 'integrity') return undefined;
            v = fixAttr(this, name, v);
          } catch (e) {
            /* as is */
          }
          return o.call(this, name, v);
        };
      });
      wrap(W.Element.prototype, 'setAttributeNS', function (o) {
        return function (ns, name, v) {
          try {
            v = fixAttr(this, String(name).replace(/^.*:/, '') === 'href' ? 'href' : name, v);
          } catch (e) {
            /* as is */
          }
          return o.call(this, ns, name, v);
        };
      });
      var WATCH = URL_ATTR.concat(['srcset', 'imagesrcset', 'target', 'integrity', 'sandbox']);
      var fixEl = function (el) {
        if (!el || el.nodeType !== 1 || !el.attributes || !el.attributes.length) return;
        for (var i = 0; i < WATCH.length; i++) {
          var a = WATCH[i];
          if (!el.hasAttribute(a)) continue;
          if (a === 'integrity') {
            el.removeAttribute(a);
            continue;
          }
          var v = el.getAttribute(a);
          var f = fixAttr(el, a, v);
          if (f !== v) nSet.call(el, a, f);
        }
      };
      var SEL = '[href],[src],[action],[srcset],[poster],[data],[formaction],[integrity],[target],[sandbox]';

      // ---- theme / motion (CSS side) ---------------------------------------------------
      var theme = page.on ? page.theme : null;
      var motion = page.on ? page.motion : null;
      // A phone has a finger where a computer has a mouse; pages ask about that too.
      var finger = page.on && page.nav ? (page.nav.mobile ? 'coarse' : page.nav.touch ? null : 'fine') : null;
      var YES = '(min-width:0px)';
      var NO = '(max-width:0px)';
      var media = function (q) {
        var s = String(q);
        if (finger)
          s = s
            .replace(/\(\s*(?:any-)?pointer\s*:\s*(none|coarse|fine)\s*\)/gi, function (m, v) {
              return v.toLowerCase() === finger ? YES : NO;
            })
            .replace(/\(\s*(?:any-)?hover\s*:\s*(none|hover)\s*\)/gi, function (m, v) {
              return (v.toLowerCase() === 'hover') === (finger === 'fine') ? YES : NO;
            });
        if (theme)
          s = s.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, function (m, v) {
            return v.toLowerCase() === theme ? YES : NO;
          });
        if (motion)
          s = s.replace(/\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)/gi, function (m, v) {
            return (v || 'reduce').toLowerCase() === motion ? YES : NO;
          });
        return s;
      };
      var MQ = /prefers-|pointer|hover/;
      var restyle = !!(theme || motion || finger);
      var sheets = new W.WeakSet();
      var themeRules = function (list, depth) {
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          try {
            if (r.media && r.media.mediaText && MQ.test(r.media.mediaText)) {
              var s = media(r.media.mediaText);
              if (s !== r.media.mediaText) r.media.mediaText = s;
            }
            if (r.styleSheet) themeSheet(r.styleSheet);
            if (r.cssRules && r.cssRules.length && depth < 8) themeRules(r.cssRules, depth + 1);
          } catch (e) {
            /* unreadable rule */
          }
        }
      };
      var themeSheet = function (sh) {
        if (!sh || sheets.has(sh)) return;
        try {
          var rules = sh.cssRules; // throws until the sheet has loaded
          sheets.add(sh);
          if (sh.media && MQ.test(sh.media.mediaText)) sh.media.mediaText = media(sh.media.mediaText);
          themeRules(rules, 0);
        } catch (e) {
          /* later */
        }
      };
      var themeAll = function () {
        if (restyle) for (var i = 0; i < D.styleSheets.length; i++) themeSheet(D.styleSheets[i]);
      };
      if (restyle) {
        wrap(W, 'matchMedia', function (o) {
          return function (q) {
            var s = media(q);
            var r = o.call(this, s);
            if (s !== String(q))
              try {
                Object.defineProperty(r, 'media', { value: String(q), configurable: true });
              } catch (e) {
                /* cosmetic */
              }
            return r;
          };
        });
        safe(function () {
          wrap(W.CSSStyleSheet.prototype, 'insertRule', function (o) {
            return function (rule) {
              arguments[0] = media(rule);
              return o.apply(this, arguments);
            };
          });
        });
        safe(function () {
          wrap(W.CSSStyleSheet.prototype, 'replaceSync', function (o) {
            return function (text) {
              return o.call(this, media(text));
            };
          });
        });
        safe(function () {
          wrap(W.CSSStyleSheet.prototype, 'replace', function (o) {
            return function (text) {
              return o.call(this, media(text));
            };
          });
        });
        D.addEventListener(
          'load',
          function (e) {
            var t = e.target;
            if (t && t.sheet) {
              sheets.delete(t.sheet);
              themeSheet(t.sheet);
            }
          },
          true
        );
        D.addEventListener('DOMContentLoaded', themeAll);
        listen(W, 'load', themeAll);
      }
      var themeEl = function (el) {
        if (!restyle || el.nodeType !== 1) return;
        var n = el.localName;
        if (n === 'style') {
          if (el.sheet) {
            sheets.delete(el.sheet);
            themeSheet(el.sheet);
          }
          return;
        }
        if ((n === 'link' || n === 'source') && el.hasAttribute('media')) {
          var m = el.getAttribute('media');
          var s = media(m);
          if (s !== m) nSet.call(el, 'media', s);
        }
      };

      // Frames the page creates empty (about:blank) never load this script, and a fresh window is a place to
      // read the real browser from. They are reached into as soon as they appear or are touched.
      var frameWindow = Object.getOwnPropertyDescriptor(W.HTMLIFrameElement.prototype, 'contentWindow');
      var reach = function (el) {
        try {
          var w = frameWindow.get.call(el);
          if (!w || w === W || !/^about:/.test(w.location.href)) return;
          // A frame that is given a document brings this script along with it, and that document's own settings:
          // it is blank only for the moment, and what is put into its window now would still be there afterwards.
          var src = el.getAttribute('src');
          if ((src && !/^\s*(?:about:|javascript:)/i.test(src)) || el.hasAttribute('srcdoc')) return;
          install(w);
        } catch (e) {
          /* another origin, or not a frame */
        }
      };
      safe(function () {
        var mo = new W.MutationObserver(function (list) {
          for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (m.type === 'attributes') {
              fixEl(m.target);
              continue;
            }
            if (m.target && m.target.localName === 'style') themeEl(m.target);
            for (var k = 0; k < m.addedNodes.length; k++) {
              var node = m.addedNodes[k];
              if (node.nodeType !== 1) continue;
              fixEl(node);
              themeEl(node);
              if (node.localName === 'iframe') reach(node);
              if (node.firstElementChild) {
                var all = node.querySelectorAll(SEL);
                for (var j = 0; j < all.length; j++) fixEl(all[j]);
                var fr = node.querySelectorAll('iframe');
                for (var f = 0; f < fr.length; f++) reach(fr[f]);
                if (restyle) {
                  var st = node.querySelectorAll('style,link[media],source[media]');
                  for (var q = 0; q < st.length; q++) themeEl(st[q]);
                }
              }
            }
          }
        });
        mo.observe(D, { childList: true, subtree: true, attributes: true, attributeFilter: WATCH });
      });

      // ---- navigation ---------------------------------------------------------------
      var realParent = W.parent;
      var isTop = false; // true when this document is the page shown in Waddle's frame
      safe(function () {
        isTop = realParent !== W && realParent.location.origin === ORIGIN && realParent.location.pathname.indexOf(P) !== 0;
      });
      var notify = function (kind) {
        if (!isTop) return;
        try {
          realParent.postMessage(
            {
              waddle: 1,
              kind: kind,
              url: unp(L.href),
              title: D.title || '',
              viewport: page.on && page.viewport && page.screen ? [page.screen.iw, page.screen.ih] : null,
              theme: theme,
            },
            ORIGIN
          );
        } catch (e) {
          /* shell gone */
        }
      };
      var openInShell = function (url) {
        if (!isTop) return false;
        try {
          var raw = url == null ? '' : String(url);
          var real = '';
          if (raw) {
            if (raw.indexOf(ORIGIN + P) === 0 || raw.indexOf(P) === 0) real = unp(raw);
            else {
              var parsed = new W.URL(raw, realBase());
              if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
              real = parsed.href;
            }
            if (!real || !/^https?:\/\//i.test(real)) return false;
          }
          realParent.postMessage({ waddle: 1, kind: 'open', url: real }, ORIGIN);
          return true;
        } catch (e) {
          return false;
        }
      };
      ['pushState', 'replaceState'].forEach(function (k) {
        wrap(W.History.prototype, k, function (o) {
          return function (state, title, url) {
            var a = [].slice.call(arguments);
            if (a.length > 2 && a[2] != null)
              try {
                a[2] = px(String(a[2]));
              } catch (e) {
                /* as is */
              }
            var r = o.apply(this, a);
            notify(k === 'replaceState' ? 'replace' : 'nav');
            return r;
          };
        });
      });
      wrap(W, 'open', function (o) {
        return function (u, target) {
          var a = [].slice.call(arguments);
          if (isTop && (target == null || String(target).toLowerCase() !== '_self')) {
            if (openInShell(u == null ? '' : u)) return null;
          }
          if (a.length && a[0] != null && a[0] !== '')
            try {
              a[0] = px(String(a[0]));
            } catch (e) {
              /* as is */
            }
          if (typeof a[1] === 'string' && /^_(?:top|parent)$/i.test(a[1])) a[1] = '_self';
          return o.apply(this, a);
        };
      });
      listen(
        W,
        'click',
        function (e) {
          try {
            var el = e.target && e.target.closest && e.target.closest('a[href],area[href]');
            if (!el) return;
            fixEl(el);
            var target = String(el.getAttribute('target') || '').toLowerCase();
            if (isTop && (target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey)) {
              var href = unp(el.href || el.getAttribute('href'));
              if (openInShell(href)) {
                e.preventDefault();
                e.stopImmediatePropagation();
              }
            }
          } catch (err) {
            /* ignore */
          }
        },
        true
      );
      listen(
        W,
        'auxclick',
        function (e) {
          if (e.button !== 1 || !isTop) return;
          try {
            var a = e.target && e.target.closest && e.target.closest('a[href],area[href]');
            if (a && openInShell(unp(a.href || a.getAttribute('href')))) {
              e.preventDefault();
              e.stopImmediatePropagation();
            }
          } catch (err) {
            /* ignore */
          }
        },
        true
      );
      listen(
        W,
        'submit',
        function (e) {
          try {
            fixEl(e.target);
            if (e.submitter) fixEl(e.submitter);
          } catch (err) {
            /* ignore */
          }
        },
        true
      );
      wrap(W.HTMLFormElement.prototype, 'submit', function (o) {
        return function () {
          try {
            fixEl(this);
          } catch (e) {
            /* as is */
          }
          return o.call(this);
        };
      });
      safe(function () {
        // location.href = "https://elsewhere" cannot be hooked; the Navigation API sees it
        if (!W.navigation || !W.navigation.addEventListener) return;
        listen(W.navigation, 'navigate', function (e) {
          try {
            var dest = new W.URL(e.destination.url);
            if (dest.origin === ORIGIN || !/^https?:$/.test(dest.protocol)) return;
            if (!e.cancelable || e.hashChange || e.downloadRequest != null || e.formData) return;
            e.preventDefault();
            if (e.navigationType === 'replace') L.replace(P + dest.href);
            else L.assign(P + dest.href);
          } catch (err) {
            /* let it go */
          }
        });
      });
      listen(W, 'hashchange', function () {
        notify('pop');
      });
      listen(W, 'popstate', function () {
        notify('pop');
      });
      listen(W, 'pagehide', function () {
        notify('leave');
      });
      D.addEventListener('DOMContentLoaded', function () {
        notify('ready');
        safe(function () {
          var t = D.querySelector('title');
          if (t)
            new W.MutationObserver(function () {
              notify('nav');
            }).observe(t, { childList: true, characterData: true, subtree: true });
        });
      });
      listen(W, 'load', function () {
        notify('load');
      });
      notify('start');

      // ---- being framed, messaging, storage ---------------------------------------------
      safe(function () {
        if (!isTop) return; // the page must believe it is a top-level tab
        Object.defineProperty(W, 'parent', {
          get: mask(function () {
            return W;
          }, 'get parent'),
          set: function () {},
          configurable: true,
        });
        Object.defineProperty(W, 'frameElement', {
          get: mask(function () {
            return null;
          }, 'get frameElement'),
          configurable: true,
        });
      });
      safe(function () {
        // every proxied frame shares Waddle's origin, so real target origins never match
        var npm = W.postMessage;
        W.postMessage = mask(function postMessage() {
          var a = [].slice.call(arguments);
          if (gone()) return npm.apply(this === undefined ? W : this, a);
          if (typeof a[1] === 'string') {
            if (a[1] !== '*' && a[1] !== '/') a[1] = ORIGIN;
          } else if (a[1] && typeof a[1].targetOrigin === 'string' && a[1].targetOrigin !== '*' && a[1].targetOrigin !== '/')
            a[1] = Object.assign({}, a[1], { targetOrigin: ORIGIN });
          return npm.apply(this === undefined ? W : this, a);
        }, 'postMessage');
      });
      safe(function () {
        var od = Object.getOwnPropertyDescriptor(W.MessageEvent.prototype, 'origin');
        getter(W.MessageEvent.prototype, 'origin', function () {
          var o = od.get.call(this);
          try {
            if (o === ORIGIN && this.source && this.source.location) {
              var r = unp(this.source.location.href);
              if (r) return new W.URL(r).origin;
            }
          } catch (e) {
            /* cross-origin source */
          }
          return o;
        });
      });
      safe(function () {
        value(
          W.Document.prototype,
          'referrer',
          (function () {
            var r = unp(D.referrer);
            return r || '';
          })()
        );
      });
      safe(function () {
        var dd = Object.getOwnPropertyDescriptor(W.Document.prototype, 'domain');
        Object.defineProperty(W.Document.prototype, 'domain', {
          get: mask(
            guard(function () {
              return realHost().replace(/:\d+$/, '');
            }, dd.get),
            'get domain'
          ),
          set: function () {},
          configurable: true,
        });
      });

      // localStorage / sessionStorage: one bucket per real site instead of one for everybody.
      ['localStorage', 'sessionStorage'].forEach(function (name) {
        safe(function () {
          var d = Object.getOwnPropertyDescriptor(W, name);
          if (!d || !d.get) return;
          var made = null;
          var build = function (store) {
            var pre = bucket() + '\u0001';
            var proto = Object.getPrototypeOf(store);
            var keys = function () {
              var out = [];
              for (var i = 0; i < store.length; i++) {
                var k = proto.key.call(store, i);
                if (k.indexOf(pre) === 0) out.push(k.slice(pre.length));
              }
              return out;
            };
            var api = {
              getItem: function (k) {
                return proto.getItem.call(store, pre + k);
              },
              setItem: function (k, v) {
                proto.setItem.call(store, pre + k, v);
              },
              removeItem: function (k) {
                proto.removeItem.call(store, pre + k);
              },
              clear: function () {
                keys().forEach(function (k) {
                  proto.removeItem.call(store, pre + k);
                });
              },
              key: function (i) {
                var k = keys()[i];
                return k === undefined ? null : k;
              },
            };
            Object.keys(api).forEach(function (k) {
              mask(api[k], k);
            });
            return new W.Proxy(store, {
              get: function (t, p) {
                if (p === 'length') return keys().length;
                if (typeof p === 'symbol') return Reflect.get(t, p);
                if (Object.prototype.hasOwnProperty.call(api, p)) return api[p];
                var v = proto.getItem.call(t, pre + p);
                if (v !== null) return v;
                var f = p in proto ? proto[p] : undefined;
                return typeof f === 'function' ? f.bind(t) : f;
              },
              set: function (t, p, v) {
                proto.setItem.call(t, pre + String(p), String(v));
                return true;
              },
              deleteProperty: function (t, p) {
                proto.removeItem.call(t, pre + String(p));
                return true;
              },
              has: function (t, p) {
                return p in api || p === 'length' || proto.getItem.call(t, pre + String(p)) !== null;
              },
              ownKeys: function () {
                return keys();
              },
              getOwnPropertyDescriptor: function (t, p) {
                var v = typeof p === 'string' ? proto.getItem.call(t, pre + p) : null;
                return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
              },
            });
          };
          Object.defineProperty(W, name, {
            get: mask(
              guard(function () {
                return made || (made = build(d.get.call(W)));
              }, d.get),
              'get ' + name
            ),
            configurable: true,
            enumerable: d.enumerable,
          });
        });
      });
      ['contentWindow', 'contentDocument'].forEach(function (k) {
        safe(function () {
          var d = Object.getOwnPropertyDescriptor(W.HTMLIFrameElement.prototype, k);
          getter(W.HTMLIFrameElement.prototype, k, function () {
            reach(this);
            return d.get.call(this);
          });
        });
      });
    } // pageHooks

    // ================================ identity ====================================
    function identity() {
      var NP = (W.Navigator || W.WorkerNavigator).prototype;
      var nv = page.nav;
      var seed = (page.seed ^ hash((data.part || '') + realHost())) >>> 0; // steady per site per session, different across sites
      // A worker's navigator is a smaller thing than a page's: only what is really there is given a value.
      var set = function (k, v) {
        if (!WORKER || k in N) value(NP, k, v);
      };

      if (nv) {
        safe(function () {
          value(NP, 'userAgent', nv.ua);
          value(NP, 'appVersion', nv.appVersion);
          value(NP, 'platform', nv.platform);
          set('vendor', nv.vendor);
          set('productSub', nv.productSub);
          value(NP, 'hardwareConcurrency', nv.cores);
          set('maxTouchPoints', nv.touch || 0);
          set('webdriver', false);
          if (nv.engine === 'chromium') value(NP, 'deviceMemory', nv.memory || 8);
          else drop(NP, 'deviceMemory');
          if (nv.engine === 'gecko') {
            set('oscpu', nv.oscpu);
            set('buildID', '20181001000000');
          } else {
            drop(NP, 'oscpu');
            drop(NP, 'buildID');
          }
        });
        safe(function () {
          if (!nv.uaData) {
            drop(NP, 'userAgentData');
            return;
          }
          var ud = nv.uaData;
          var low = { brands: ud.brands, mobile: !!ud.mobile, platform: ud.platform };
          var obj = {
            get brands() {
              return ud.brands.map(function (b) {
                return { brand: b.brand, version: b.version };
              });
            },
            get mobile() {
              return !!ud.mobile;
            },
            get platform() {
              return ud.platform;
            },
            getHighEntropyValues: mask(function getHighEntropyValues(hints) {
              var out = JSON.parse(JSON.stringify(low));
              [].concat(hints || []).forEach(function (h) {
                if (ud[h] !== undefined) out[h] = JSON.parse(JSON.stringify(ud[h]));
              });
              return W.Promise.resolve(out);
            }, 'getHighEntropyValues'),
            toJSON: mask(function toJSON() {
              return JSON.parse(JSON.stringify(low));
            }, 'toJSON'),
          };
          if (W.NavigatorUAData) Object.setPrototypeOf(obj, W.NavigatorUAData.prototype);
          value(NP, 'userAgentData', obj);
        });
        safe(function () {
          if (nv.engine === 'chromium') {
            if (D && !W.chrome) W.chrome = { app: {}, runtime: {} };
            return;
          }
          Object.defineProperty(W, 'chrome', { value: undefined, writable: true, configurable: true });
          [
            'getBattery',
            'keyboard',
            'bluetooth',
            'usb',
            'hid',
            'serial',
            'connection',
            'mozConnection',
            'webkitConnection',
            'scheduling',
            'windowControlsOverlay',
          ].forEach(function (k) {
            drop(NP, k);
          });
          if (W.Performance) drop(W.Performance.prototype, 'memory');
        });
        safe(function () {
          if (D && nv.touch && !('ontouchstart' in W)) W.ontouchstart = null;
        });
        safe(function () {
          // phones answer to window.orientation; computers have no such thing
          if (!D || !nv.mobile || 'orientation' in W) return;
          Object.defineProperty(W, 'orientation', {
            get: mask(function () {
              return 0;
            }, 'get orientation'),
            set: function () {},
            configurable: true,
            enumerable: true,
          });
          W.onorientationchange = null;
        });
      }
      if (page.dnt)
        safe(function () {
          set('doNotTrack', '1');
          set('globalPrivacyControl', true);
        });

      // ---- language + time zone -----------------------------------------------------
      var lang = page.languages && page.languages[0];
      var tz = page.tz;
      var NDTF = W.Intl && W.Intl.DateTimeFormat;
      if (lang)
        safe(function () {
          var list = Object.freeze(page.languages.slice());
          value(NP, 'language', lang);
          value(NP, 'languages', list);
        });
      if ((lang || tz) && W.Intl) {
        [
          'DateTimeFormat',
          'NumberFormat',
          'Collator',
          'PluralRules',
          'RelativeTimeFormat',
          'ListFormat',
          'DisplayNames',
          'Segmenter',
        ].forEach(function (name) {
          safe(function () {
            var Nat = W.Intl[name];
            if (!Nat) return;
            var F = function (locales, options) {
              if (lang && locales === undefined) locales = lang;
              if (tz && name === 'DateTimeFormat') {
                options = Object.assign({}, options);
                if (options.timeZone === undefined) options.timeZone = tz;
              }
              return Reflect.construct(Nat, [locales, options], new.target && new.target !== F ? new.target : Nat);
            };
            F.prototype = Nat.prototype;
            F.supportedLocalesOf = Nat.supportedLocalesOf.bind(Nat);
            try {
              Object.defineProperty(F, 'name', { value: name });
            } catch (e) {
              /* cosmetic */
            }
            mask(F, name);
            W.Intl[name] = F;
          });
        });
        ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (k) {
          wrap(W.Date.prototype, k, function (o) {
            return function (l, opt) {
              if (lang && l === undefined) l = lang;
              if (tz) {
                opt = Object.assign({}, opt);
                if (opt.timeZone === undefined) opt.timeZone = tz;
              }
              return o.call(this, l, opt);
            };
          });
        });
        if (lang)
          wrap(W.Number.prototype, 'toLocaleString', function (o) {
            return function (l, opt) {
              return o.call(this, l === undefined ? lang : l, opt);
            };
          });
      }
      if (tz && NDTF) {
        safe(function () {
          var ND = W.Date;
          var DP = ND.prototype;
          var gt = DP.getTime;
          var fmt = new NDTF('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
          });
          var longName = new NDTF('en-US', { timeZone: tz, timeZoneName: 'long' });
          var cache = new W.Map();
          var offsetAt = function (t) {
            // minutes east of UTC at instant t
            var key = Math.floor(t / 900000);
            var v = cache.get(key);
            if (v !== undefined) return v;
            var p = {};
            fmt.formatToParts(new ND(t)).forEach(function (x) {
              p[x.type] = x.value;
            });
            v = Math.round(
              (ND.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000) / 60000
            );
            if (cache.size > 4000) cache.clear();
            cache.set(key, v);
            return v;
          };
          var shifted = function (d) {
            var t = gt.call(d);
            return isNaN(t) ? null : new ND(t + offsetAt(t) * 60000);
          };
          var MAP = {
            getFullYear: 'getUTCFullYear',
            getMonth: 'getUTCMonth',
            getDate: 'getUTCDate',
            getDay: 'getUTCDay',
            getHours: 'getUTCHours',
            getMinutes: 'getUTCMinutes',
          };
          Object.keys(MAP).forEach(function (k) {
            var u = DP[MAP[k]];
            wrap(DP, k, function () {
              return function () {
                var s = shifted(this);
                return s ? u.call(s) : NaN;
              };
            });
          });
          wrap(DP, 'getTimezoneOffset', function () {
            return function () {
              var t = gt.call(this);
              return isNaN(t) ? NaN : -offsetAt(t);
            };
          });
          var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          var two = function (n) {
            return (n < 10 ? '0' : '') + n;
          };
          var datePart = function (s) {
            return DAYS[s.getUTCDay()] + ' ' + MONTHS[s.getUTCMonth()] + ' ' + two(s.getUTCDate()) + ' ' + s.getUTCFullYear();
          };
          var timePart = function (d, s) {
            var off = offsetAt(gt.call(d));
            var abs = Math.abs(off);
            var name = '';
            longName.formatToParts(d).forEach(function (x) {
              if (x.type === 'timeZoneName') name = x.value;
            });
            return (
              two(s.getUTCHours()) +
              ':' +
              two(s.getUTCMinutes()) +
              ':' +
              two(s.getUTCSeconds()) +
              ' GMT' +
              (off < 0 ? '-' : '+') +
              two(Math.floor(abs / 60)) +
              two(abs % 60) +
              (name ? ' (' + name + ')' : '')
            );
          };
          wrap(DP, 'toString', function () {
            return function () {
              var s = shifted(this);
              return s ? datePart(s) + ' ' + timePart(this, s) : 'Invalid Date';
            };
          });
          wrap(DP, 'toDateString', function () {
            return function () {
              var s = shifted(this);
              return s ? datePart(s) : 'Invalid Date';
            };
          });
          wrap(DP, 'toTimeString', function () {
            return function () {
              var s = shifted(this);
              return s ? timePart(this, s) : 'Invalid Date';
            };
          });
        });
      }

      if (tz && W.Temporal && W.Temporal.Now) {
        // the newer date API reads the clock's zone on its own
        safe(function () {
          var TN = W.Temporal.Now;
          wrap(TN, 'timeZoneId', function () {
            return function () {
              return tz;
            };
          });
          ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO'].forEach(function (k) {
            wrap(TN, k, function (o) {
              return function (zone) {
                return o.call(this, zone === undefined ? tz : zone);
              };
            });
          });
        });
      }

      // ---- screen ---------------------------------------------------------------------
      var sc = page.screen;
      if (sc) {
        safe(function () {
          var SP = W.Screen.prototype;
          value(SP, 'width', sc.w);
          value(SP, 'height', sc.h);
          value(SP, 'availWidth', sc.aw);
          value(SP, 'availHeight', sc.ah);
          value(SP, 'availLeft', 0);
          value(SP, 'availTop', 0);
          value(SP, 'colorDepth', sc.depth);
          value(SP, 'pixelDepth', sc.depth);
          var win = function (k, v) {
            try {
              var wd = Object.getOwnPropertyDescriptor(W, k);
              Object.defineProperty(W, k, {
                get: mask(
                  guard(
                    function () {
                      return v;
                    },
                    wd && wd.get
                      ? wd.get
                      : function () {
                          return wd ? wd.value : undefined;
                        }
                  ),
                  'get ' + k
                ),
                set: function () {},
                configurable: true,
                enumerable: true,
              });
            } catch (e) {
              /* fixed */
            }
          };
          win('devicePixelRatio', sc.dpr);
          win('outerWidth', sc.aw);
          win('outerHeight', sc.ah);
          win('screenX', 0);
          win('screenY', 0);
          win('screenLeft', 0);
          win('screenTop', 0);
          if (W.ScreenOrientation) {
            value(W.ScreenOrientation.prototype, 'type', sc.w >= sc.h ? 'landscape-primary' : 'portrait-primary');
            value(W.ScreenOrientation.prototype, 'angle', 0);
          }
        });
      }

      // ---- connection -------------------------------------------------------------------
      safe(function () {
        var nt = page.net;
        if (!nt || !N.connection) return;
        var CP = Object.getPrototypeOf(N.connection);
        ['effectiveType', 'downlink', 'rtt', 'saveData', 'type'].forEach(function (k) {
          if (nt[k] !== undefined) value(CP, k, nt[k]);
        });
      });
      if (page.webrtc === 'block') {
        // WebRTC talks to the network directly and gives away the real address
        [
          'RTCPeerConnection',
          'webkitRTCPeerConnection',
          'mozRTCPeerConnection',
          'RTCDataChannel',
          'RTCSessionDescription',
          'RTCIceCandidate',
        ].forEach(function (k) {
          safe(function () {
            if (k in W) Object.defineProperty(W, k, { value: undefined, writable: true, configurable: true });
          });
        });
      }

      // ---- canvas / WebGL / audio / layout fingerprints -----------------------------------
      var noise = function (d) {
        var r = rng(seed);
        var n = d.length;
        var step = Math.max(4, Math.floor(n / 4 / 700) * 4);
        for (var i = Math.floor(r() * 16) * 4; i < n; i += step + Math.floor(r() * 4) * 4) {
          if (d[i + 3] === 0) continue;
          var c = i + Math.floor(r() * 3);
          d[c] ^= 1;
        }
      };
      if (page.canvas === 'noise' || page.canvas === 'block') {
        safe(function () {
          var CP2 = W.CanvasRenderingContext2D.prototype;
          var nGet = CP2.getImageData;
          var nPut = CP2.putImageData;
          var nDraw = CP2.drawImage;
          var nCtx = W.HTMLCanvasElement.prototype.getContext;
          var make = W.Document.prototype.createElement;
          var block = page.canvas === 'block';
          var copy = function (canvas) {
            var w = canvas.width;
            var h = canvas.height;
            if (!w || !h || w * h > 16e6) return canvas;
            var c = make.call(D, 'canvas');
            c.width = w;
            c.height = h;
            if (block) return c;
            var x = nCtx.call(c, '2d');
            nDraw.call(x, canvas, 0, 0);
            var img = nGet.call(x, 0, 0, w, h);
            noise(img.data);
            nPut.call(x, img, 0, 0);
            return c;
          };
          wrap(W.HTMLCanvasElement.prototype, 'toDataURL', function (o) {
            return function () {
              return o.apply(copy(this), arguments);
            };
          });
          wrap(W.HTMLCanvasElement.prototype, 'toBlob', function (o) {
            return function () {
              return o.apply(copy(this), arguments);
            };
          });
          wrap(CP2, 'getImageData', function (o) {
            return function () {
              var img = o.apply(this, arguments);
              if (block) img.data.fill(0);
              else noise(img.data);
              return img;
            };
          });
        });
        safe(function () {
          // canvases that are not on the page: the only kind a worker has
          var OC = W.OffscreenCanvas;
          var OP = W.OffscreenCanvasRenderingContext2D.prototype;
          var oGet = OP.getImageData;
          var oPut = OP.putImageData;
          var oDraw = OP.drawImage;
          var oCtx = OC.prototype.getContext;
          var blank = page.canvas === 'block';
          var ocopy = function (canvas) {
            var w = canvas.width;
            var h = canvas.height;
            if (!w || !h || w * h > 16e6) return canvas;
            var c = new OC(w, h);
            var x = oCtx.call(c, '2d');
            if (blank) return c;
            oDraw.call(x, canvas, 0, 0);
            var img = oGet.call(x, 0, 0, w, h);
            noise(img.data);
            oPut.call(x, img, 0, 0);
            return c;
          };
          wrap(OC.prototype, 'convertToBlob', function (o) {
            return function () {
              return o.apply(ocopy(this), arguments);
            };
          });
          wrap(OP, 'getImageData', function (o) {
            return function () {
              var img = o.apply(this, arguments);
              if (blank) img.data.fill(0);
              else noise(img.data);
              return img;
            };
          });
        });
        ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach(function (name) {
          safe(function () {
            // pixels read back from a 3D scene identify the graphics stack as well as a 2D drawing does
            wrap(W[name].prototype, 'readPixels', function (o) {
              return function () {
                var out = o.apply(this, arguments);
                var buf = arguments[6];
                if (buf && buf.length && (buf instanceof W.Uint8Array || buf instanceof W.Uint8ClampedArray)) {
                  if (page.canvas === 'block') buf.fill(0);
                  else noise(buf);
                }
                return out;
              };
            });
          });
        });
      }
      if (page.webgl === 'spoof' && nv && nv.gl) {
        ['WebGLRenderingContext', 'WebGL2RenderingContext'].forEach(function (name) {
          safe(function () {
            wrap(W[name].prototype, 'getParameter', function (o) {
              return function (k) {
                if (k === 37445) return nv.gl[0];
                if (k === 37446) return nv.gl[1];
                return o.apply(this, arguments);
              };
            });
          });
        });
      }
      if (page.audio === 'noise') {
        safe(function () {
          var done = new W.WeakSet();
          wrap(W.AudioBuffer.prototype, 'getChannelData', function (o) {
            return function () {
              var d = o.apply(this, arguments);
              if (!done.has(d)) {
                done.add(d);
                var r = rng(seed);
                for (var i = 0; i < d.length; i += 89) d[i] += (r() - 0.5) * 1e-7;
              }
              return d;
            };
          });
          wrap(W.AnalyserNode.prototype, 'getFloatFrequencyData', function (o) {
            return function (arr) {
              var out = o.apply(this, arguments);
              var r = rng(seed);
              for (var i = 0; i < arr.length; i += 7) arr[i] += (r() - 0.5) * 1e-4;
              return out;
            };
          });
        });
      }
      if (page.rects === 'noise') {
        safe(function () {
          var r = rng(seed);
          var dx = (r() - 0.5) * 2e-3;
          var dy = (r() - 0.5) * 2e-3;
          var dw = (r() - 0.5) * 2e-3;
          var dh = (r() - 0.5) * 2e-3;
          var bend = function (o) {
            return function () {
              var b = o.apply(this, arguments);
              return new W.DOMRect(b.x + dx, b.y + dy, b.width + dw, b.height + dh);
            };
          };
          wrap(W.Element.prototype, 'getBoundingClientRect', bend);
          wrap(W.Range.prototype, 'getBoundingClientRect', bend);
        });
      }
      if (page.fonts === 'limit') {
        safe(function () {
          var BASE =
            /^(?:arial|helvetica|times new roman|times|courier new|courier|georgia|verdana|tahoma|trebuchet ms|serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i;
          wrap(W.FontFaceSet.prototype, 'check', function (o) {
            return function (font) {
              var fam = String(font)
                .replace(/^.*?\d+(?:px|pt|em|rem|%)\s*(?:\/\s*[\d.]+\w*)?\s*/i, '')
                .split(',')[0]
                .trim()
                .replace(/^["']|["']$/g, '');
              return BASE.test(fam) ? o.apply(this, arguments) : false;
            };
          });
          if ('queryLocalFonts' in W) Object.defineProperty(W, 'queryLocalFonts', { value: undefined, writable: true, configurable: true });
        });
      }
      // ---- cameras and microphones, battery, storage, plugins, voices, location --------------------------
      if (page.media === 'generic' || page.media === 'none')
        safe(function () {
          var dev = function (kind) {
            var o = { deviceId: '', kind: kind, label: '', groupId: '' };
            o.toJSON = function () {
              return { deviceId: '', kind: kind, label: '', groupId: '' };
            };
            return o;
          };
          var kinds = page.media === 'none' ? [] : ['audioinput', 'videoinput', 'audiooutput'];
          wrap(W.MediaDevices.prototype, 'enumerateDevices', function () {
            return function () {
              return W.Promise.resolve(kinds.map(dev));
            };
          });
        });
      if (page.battery)
        safe(function () {
          if (!NP.getBattery) return;
          var b = page.battery;
          var battery = {
            charging: !!b.charging,
            chargingTime: b.charging ? (b.level >= 1 ? 0 : Math.round((1 - b.level) * 7200)) : Infinity,
            dischargingTime: b.charging ? Infinity : Math.round(b.level * 21600),
            level: b.level,
            onchargingchange: null,
            onlevelchange: null,
            onchargingtimechange: null,
            ondischargingtimechange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () {
              return true;
            },
          };
          try {
            if (W.BatteryManager) Object.setPrototypeOf(battery, W.BatteryManager.prototype);
          } catch (e) {
            /* a plain object will do */
          }
          wrap(NP, 'getBattery', function () {
            return function () {
              return W.Promise.resolve(battery);
            };
          });
        });
      safe(function () {
        // how much disk there is, and how much of it every site here has used together, is nobody's business
        wrap(W.StorageManager.prototype, 'estimate', function () {
          return function () {
            return W.Promise.resolve({ quota: 10737418240, usage: 0 });
          };
        });
      });
      if (page.plugins && D)
        safe(function () {
          var none = page.plugins === 'none';
          // Every current browser on a computer lists the same five; that one is left as it is.
          if (!none && N.plugins && N.plugins.length === 5 && N.pdfViewerEnabled) return;
          var NAMES = none
            ? []
            : ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
          var TYPES = none ? [] : ['application/pdf', 'text/pdf'];
          var listOf = function (arr, items, key) {
            items.forEach(function (it, i) {
              Object.defineProperty(arr, i, { value: it, enumerable: true, configurable: true });
              Object.defineProperty(arr, it[key], { value: it, enumerable: false, configurable: true });
            });
            Object.defineProperty(arr, 'length', { value: items.length, configurable: true });
            Object.defineProperty(arr, 'item', {
              value: mask(function item(i) {
                return items[i >>> 0] || null;
              }, 'item'),
              configurable: true,
              writable: true,
            });
            Object.defineProperty(arr, 'namedItem', {
              value: mask(function namedItem(n) {
                for (var i = 0; i < items.length; i++) if (items[i][key] === String(n)) return items[i];
                return null;
              }, 'namedItem'),
              configurable: true,
              writable: true,
            });
            Object.defineProperty(arr, W.Symbol.iterator, {
              value: function () {
                return items[W.Symbol.iterator]();
              },
              configurable: true,
              writable: true,
            });
            return arr;
          };
          var like = function (o, name) {
            try {
              if (W[name]) Object.setPrototypeOf(o, W[name].prototype);
            } catch (e) {
              /* a plain object will do */
            }
            return o;
          };
          var mimes = TYPES.map(function (t) {
            return like({ type: t, suffixes: 'pdf', description: 'Portable Document Format' }, 'MimeType');
          });
          var plugins = NAMES.map(function (name) {
            var pl = like({ name: name, filename: 'internal-pdf-viewer', description: 'Portable Document Format' }, 'Plugin');
            return listOf(pl, mimes, 'type');
          });
          mimes.forEach(function (m) {
            Object.defineProperty(m, 'enabledPlugin', { value: plugins[0], enumerable: true, configurable: true });
          });
          var pa = listOf(like({}, 'PluginArray'), plugins, 'name');
          Object.defineProperty(pa, 'refresh', { value: mask(function refresh() {}, 'refresh'), configurable: true, writable: true });
          value(NP, 'plugins', pa);
          value(NP, 'mimeTypes', listOf(like({}, 'MimeTypeArray'), mimes, 'type'));
          value(NP, 'pdfViewerEnabled', !none);
        });
      if (page.voices && D)
        safe(function () {
          var SS = W.SpeechSynthesis.prototype;
          var real = SS.getVoices;
          var fakes = page.voices.map(function (v, i) {
            var o = { voiceURI: v[0], name: v[0], lang: v[1], localService: !!v[2], default: i === 0 };
            try {
              if (W.SpeechSynthesisVoice) Object.setPrototypeOf(o, W.SpeechSynthesisVoice.prototype);
            } catch (e) {
              /* a plain object will do */
            }
            return o;
          });
          wrap(SS, 'getVoices', function () {
            return function () {
              return fakes.slice();
            };
          });
          // A page that picks one of the listed voices still has to be able to speak: it gets a real one in that language.
          var vd = Object.getOwnPropertyDescriptor(W.SpeechSynthesisUtterance.prototype, 'voice');
          Object.defineProperty(W.SpeechSynthesisUtterance.prototype, 'voice', {
            get: vd.get,
            set: mask(function (v) {
              if (v && fakes.indexOf(v) >= 0) {
                var lang = v.lang;
                var have = real.call(W.speechSynthesis);
                var same = null;
                for (var i = 0; i < have.length; i++)
                  if (have[i].lang === lang) {
                    same = have[i];
                    break;
                  }
                if (!same) this.lang = lang;
                v = same;
              }
              return vd.set.call(this, v);
            }, 'set voice'),
            enumerable: vd.enumerable,
            configurable: true,
          });
        });
      if (page.geo && D)
        safe(function () {
          var geo = page.geo;
          var GP = W.Geolocation.prototype;
          var refuse = function (fail) {
            if (typeof fail !== 'function') return;
            W.setTimeout(
              function () {
                fail({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
              },
              20 + (seed % 60)
            );
          };
          var answer = function (ok) {
            W.setTimeout(
              function () {
                var c = {
                  latitude: geo.lat,
                  longitude: geo.lon,
                  accuracy: geo.acc,
                  altitude: null,
                  altitudeAccuracy: null,
                  heading: null,
                  speed: null,
                };
                var coords = Object.assign({}, c);
                coords.toJSON = function () {
                  return Object.assign({}, c);
                };
                var at = Date.now();
                ok({
                  coords: coords,
                  timestamp: at,
                  toJSON: function () {
                    return { coords: Object.assign({}, c), timestamp: at };
                  },
                });
              },
              150 + (seed % 400)
            );
          };
          var need = function (ok, what) {
            if (typeof ok !== 'function')
              throw new W.TypeError("Failed to execute '" + what + "' on 'Geolocation': parameter 1 is not of type 'Function'.");
          };
          var watches = 0;
          wrap(GP, 'getCurrentPosition', function () {
            return function (ok, fail) {
              need(ok, 'getCurrentPosition');
              if (geo.deny) refuse(fail);
              else answer(ok);
            };
          });
          wrap(GP, 'watchPosition', function () {
            return function (ok, fail) {
              need(ok, 'watchPosition');
              if (geo.deny) refuse(fail);
              else answer(ok);
              return ++watches;
            };
          });
          wrap(GP, 'clearWatch', function () {
            return function () {};
          });
          wrap(W.Permissions.prototype, 'query', function (o) {
            return function (d) {
              if (!d || d.name !== 'geolocation') return o.apply(this, arguments);
              var st = {
                name: 'geolocation',
                state: geo.deny ? 'denied' : 'prompt',
                onchange: null,
                addEventListener: function () {},
                removeEventListener: function () {},
                dispatchEvent: function () {
                  return true;
                },
              };
              try {
                if (W.PermissionStatus) Object.setPrototypeOf(st, W.PermissionStatus.prototype);
              } catch (e) {
                /* a plain object will do */
              }
              return W.Promise.resolve(st);
            };
          });
        });
    } // identity
  }

  install(G, true);
})();
