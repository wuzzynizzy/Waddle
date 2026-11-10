/* Waddle page script. Runs first in every proxied document: keeps every request on
   the proxy and presents the configured identity (system, screen, locale, …). */
(function () {
  'use strict';
  var MARK = '__waddle$';
  var P = '/~/';
  var ORIGIN = location.origin;
  var script = document.currentScript;
  var data = {};
  try {
    data = JSON.parse(script.getAttribute('data-w')) || {};
  } catch (e) {
    /* no settings */
  }
  try {
    if (script && script.parentNode) script.parentNode.removeChild(script);
  } catch (e) {
    /* fine */
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
    s = s.slice(P.length).replace(/^(https?|wss?):\/+/i, '$1://');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }

  function install(W) {
    if (!W) return;
    try {
      if (W[MARK]) return;
      Object.defineProperty(W, MARK, { value: true });
    } catch (e) {
      return;
    }
    var D = W.document;
    var N = W.navigator;
    var L = W.location;
    var safe = function (fn) {
      try {
        fn();
      } catch (e) {
        /* one broken hook must not take the others down */
      }
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
        Object.defineProperty(obj, prop, {
          get: mask(fn, 'get ' + prop),
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
        var f = mask(make(o), prop);
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
          extra = fix(a);
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
    readJar(data.cookie);
    var cookieEcho = function (v) {
      if (v != null)
        try {
          readJar(decodeURIComponent(v));
        } catch (e) {
          /* ignore */
        }
    };
    var nfetch = W.fetch;
    safe(function () {
      var cd = Object.getOwnPropertyDescriptor(W.Document.prototype, 'cookie');
      if (!cd) return;
      Object.defineProperty(W.Document.prototype, 'cookie', {
        configurable: true,
        enumerable: cd.enumerable,
        get: mask(function () {
          return jar
            .map(function (c) {
              return c[0] ? c[0] + '=' + c[1] : c[1];
            })
            .join('; ');
        }, 'get cookie'),
        set: mask(function (line) {
          line = String(line);
          var parts = line.split(';');
          var first = parts[0];
          var i = first.indexOf('=');
          var name = (i < 0 ? '' : first.slice(0, i)).trim();
          var val = (i < 0 ? first : first.slice(i + 1)).trim();
          var gone = false;
          for (var k = 1; k < parts.length; k++) {
            var a = parts[k].trim().toLowerCase();
            if (a.indexOf('max-age=') === 0 && parseInt(a.slice(8), 10) <= 0) gone = true;
            if (a.indexOf('expires=') === 0 && Date.parse(parts[k].trim().slice(8)) <= Date.now()) gone = true;
            if (a === 'httponly') return;
          }
          jar = jar.filter(function (c) {
            return c[0] !== name;
          });
          if (!gone) jar.push([name, val]);
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
    });

    // ---- network ----------------------------------------------------------------
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
    });
    wrap(W.Navigator.prototype, 'sendBeacon', function (o) {
      return function (u, d) {
        return o.call(this, px(u), d);
      };
    });
    ctor('WebSocket', function (a) {
      var base = realBase() || L.href;
      var u = new W.URL(String(a[0]), base);
      if (u.origin === ORIGIN || u.host === L.host) u = new W.URL(u.pathname + u.search, base);
      u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
      var real = u.href;
      a[0] =
        (L.protocol === 'https:' ? 'wss://' : 'ws://') +
        L.host +
        '/-/ws?u=' +
        encodeURIComponent(real) +
        '&o=' +
        encodeURIComponent(realOrigin());
      return function (ws) {
        Object.defineProperty(ws, 'url', { value: real, configurable: true });
      };
    });
    ctor('EventSource', function (a) {
      a[0] = px(a[0]);
    });
    ctor('Worker', function (a) {
      a[0] = px(a[0]);
    });
    ctor('SharedWorker', function (a) {
      a[0] = px(a[0]);
    });

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
      m.content =
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob: " +
        (L.protocol === 'https:' ? 'wss://' : 'ws://') +
        L.host;
      D.head.insertBefore(m, D.head.firstChild);
    });

    // ---- DOM --------------------------------------------------------------------
    var nSet = W.Element.prototype.setAttribute;
    var URL_ATTR = ['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'xlink:href'];
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
        var fix = x[1] === 'srcset' ? pxSet : px;
        Object.defineProperty(proto, x[1], {
          get: d.get,
          set: mask(function (v) {
            return d.set.call(this, fix(v));
          }, 'set ' + x[1]),
          enumerable: d.enumerable,
          configurable: true,
        });
      });
    });
    var fixAttr = function (el, name, v) {
      var n = String(name).toLowerCase();
      if (n === 'srcset' || n === 'imagesrcset') return pxSet(v);
      if (URL_ATTR.indexOf(n) >= 0) return n === 'data' && el.localName !== 'object' ? v : px(v);
      if (n === 'target' && /^_(?:top|parent)$/i.test(String(v))) return '_self';
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
    var WATCH = URL_ATTR.concat(['srcset', 'imagesrcset', 'target', 'integrity']);
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
    var SEL = '[href],[src],[action],[srcset],[poster],[data],[formaction],[integrity],[target]';

    // ---- theme / motion (CSS side) ---------------------------------------------------
    var theme = page.on ? page.theme : null;
    var motion = page.on ? page.motion : null;
    var YES = '(min-width:0px)';
    var NO = '(max-width:0px)';
    var media = function (q) {
      var s = String(q);
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
    var sheets = new W.WeakSet();
    var themeRules = function (list, depth) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        try {
          if (r.media && r.media.mediaText && r.media.mediaText.indexOf('prefers-') >= 0) {
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
        if (sh.media && sh.media.mediaText.indexOf('prefers-') >= 0) sh.media.mediaText = media(sh.media.mediaText);
        themeRules(rules, 0);
      } catch (e) {
        /* later */
      }
    };
    var themeAll = function () {
      if (theme || motion) for (var i = 0; i < D.styleSheets.length; i++) themeSheet(D.styleSheets[i]);
    };
    if (theme || motion) {
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
      W.addEventListener('load', themeAll);
    }
    var themeEl = function (el) {
      if (!(theme || motion) || el.nodeType !== 1) return;
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
            if (node.firstElementChild) {
              var all = node.querySelectorAll(SEL);
              for (var j = 0; j < all.length; j++) fixEl(all[j]);
              if (theme || motion) {
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
          notify('nav');
          return r;
        };
      });
    });
    wrap(W, 'open', function (o) {
      return function (u, target) {
        var a = [].slice.call(arguments);
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
    W.addEventListener(
      'click',
      function (e) {
        try {
          var el = e.target && e.target.closest && e.target.closest('a[href],area[href]');
          if (el) fixEl(el);
        } catch (err) {
          /* ignore */
        }
      },
      true
    );
    W.addEventListener(
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
      W.navigation.addEventListener('navigate', function (e) {
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
    W.addEventListener('hashchange', function () {
      notify('nav');
    });
    W.addEventListener('popstate', function () {
      notify('nav');
    });
    W.addEventListener('pagehide', function () {
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
    W.addEventListener('load', function () {
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
      Object.defineProperty(W.Document.prototype, 'domain', {
        get: mask(function () {
          return realHost().replace(/:\d+$/, '');
        }, 'get domain'),
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
          var pre = realOrigin() + '\u0001';
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
          get: mask(function () {
            return made || (made = build(d.get.call(W)));
          }, 'get ' + name),
          configurable: true,
          enumerable: d.enumerable,
        });
      });
    });
    safe(function () {
      var pre = realOrigin() + '|';
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
      var nd = Object.getOwnPropertyDescriptor(W.IDBDatabase.prototype, 'name');
      getter(W.IDBDatabase.prototype, 'name', function () {
        var n = nd.get.call(this);
        return n.indexOf(pre) === 0 ? n.slice(pre.length) : n;
      });
    });

    // Frames the page creates empty (about:blank) never load this script; reach in when they are touched.
    ['contentWindow', 'contentDocument'].forEach(function (k) {
      safe(function () {
        var d = Object.getOwnPropertyDescriptor(W.HTMLIFrameElement.prototype, k);
        getter(W.HTMLIFrameElement.prototype, k, function () {
          var r = d.get.call(this);
          try {
            var w = k === 'contentWindow' ? r : r && r.defaultView;
            if (w && w !== W && /^about:/.test(w.location.href)) install(w);
          } catch (e) {
            /* cross-origin */
          }
          return r;
        });
      });
    });

    if (!page.on) return;

    // ================================ identity ====================================
    var NP = W.Navigator.prototype;
    var nv = page.nav;
    var seed = (page.seed ^ hash(realHost())) >>> 0; // steady per site per session, different across sites

    if (nv) {
      safe(function () {
        value(NP, 'userAgent', nv.ua);
        value(NP, 'appVersion', nv.appVersion);
        value(NP, 'platform', nv.platform);
        value(NP, 'vendor', nv.vendor);
        value(NP, 'productSub', nv.productSub);
        value(NP, 'hardwareConcurrency', nv.cores);
        value(NP, 'maxTouchPoints', nv.touch || 0);
        value(NP, 'webdriver', false);
        if (nv.engine === 'chromium') value(NP, 'deviceMemory', nv.memory || 8);
        else drop(NP, 'deviceMemory');
        if (nv.engine === 'gecko') {
          value(NP, 'oscpu', nv.oscpu);
          value(NP, 'buildID', '20181001000000');
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
          if (!W.chrome) W.chrome = { app: {}, runtime: {} };
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
        if (nv.touch && !('ontouchstart' in W)) W.ontouchstart = null;
      });
    }
    if (page.dnt)
      safe(function () {
        value(NP, 'doNotTrack', '1');
        value(NP, 'globalPrivacyControl', true);
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
          v = Math.round((ND.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000) / 60000);
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
            Object.defineProperty(W, k, {
              get: mask(function () {
                return v;
              }, 'get ' + k),
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
    if (page.devices === 'spoof') {
      safe(function () {
        var dev = function (kind) {
          var o = { deviceId: '', kind: kind, label: '', groupId: '' };
          o.toJSON = function () {
            return { deviceId: '', kind: kind, label: '', groupId: '' };
          };
          return o;
        };
        wrap(W.MediaDevices.prototype, 'enumerateDevices', function () {
          return function () {
            return W.Promise.resolve([dev('audioinput'), dev('videoinput'), dev('audiooutput')]);
          };
        });
      });
      safe(function () {
        if (!NP.getBattery) return;
        var battery = {
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1,
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
        wrap(NP, 'getBattery', function () {
          return function () {
            return W.Promise.resolve(battery);
          };
        });
      });
      safe(function () {
        wrap(W.StorageManager.prototype, 'estimate', function (o) {
          return function () {
            return o.call(this).then(function (e) {
              return { quota: 10737418240, usage: e.usage || 0, usageDetails: e.usageDetails };
            });
          };
        });
      });
    }
  }

  install(window);
})();
