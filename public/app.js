/* Waddle shell: address bar, the page frame, and the settings drawer. */
(function () {
  'use strict';
  var $ = function (s, r) {
    return (r || document).querySelector(s);
  };
  var el = function (tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    [].concat(kids || []).forEach(function (c) {
      if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  };
  var NS = 'http://www.w3.org/2000/svg';
  var icon = function (d, cls) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  };

  var frame = $('#frame');
  var addr = $('#addr');
  var state = null; // last /-/api/state
  var current = ''; // real URL shown in the frame
  var tab = 'route';
  var extra = {}; // transient results (speed test, dns test)
  var drafts = {}; // text typed into the drawer but not yet submitted, by element id
  var writes = 0; // settings changes made here; a state reply that predates one is stale
  var P = '/~/';
  var CHECK = 'https://check.waddle.invalid/'; // the built-in "what sites see" page
  var CHECK_NAME = 'waddle:check';

  // ---- talking to the server --------------------------------------------------------
  var online = true;
  function setOnline(v) {
    if (online === v) return;
    online = v;
    $('#away').hidden = v;
  }
  var api = function (path, body) {
    return fetch('/-/api/' + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'x-waddle': '1', 'content-type': 'application/json' } : { 'x-waddle': '1' },
      body: body ? JSON.stringify(body) : undefined,
    })
      .then(function (r) {
        // An answer without Waddle's mark was put there by something in between while the server was away.
        if (r.headers.get('X-Waddle') !== '1') throw new Error('away');
        return r.json();
      })
      .then(
        function (j) {
          setOnline(true);
          return j;
        },
        function (e) {
          setOnline(false);
          throw e;
        }
      );
  };

  var toastTimer = 0;
  function toast(text) {
    var t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
    }, 2600);
  }

  // ---- navigation -----------------------------------------------------------------
  var shown = function (url) {
    return url.indexOf(CHECK) === 0 ? CHECK_NAME : url;
  };
  function resolve(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (t.toLowerCase() === CHECK_NAME) return CHECK;
    if (/^https?:\/\//i.test(t)) return t;
    if (
      !/\s/.test(t) &&
      (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(t) ||
        /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(t) ||
        /^localhost(?::\d+)?(?:\/.*)?$/i.test(t))
    )
      return 'https://' + t;
    var search = (state && state.config.ui.search) || 'https://duckduckgo.com/html/?q=%s';
    return search.replace('%s', encodeURIComponent(t));
  }
  var LOCKED = 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z';
  var UNLOCKED = 'M7 11V8a5 5 0 0 1 9.600-2M6 11h12v9H6z';
  function setLock(url) {
    var lock = $('#lock');
    var plain = /^http:/i.test(url);
    lock.textContent = '';
    lock.className = plain ? 'open' : '';
    lock.title = plain ? 'Not encrypted' : '';
    if (url && url.indexOf(CHECK) !== 0) lock.appendChild(icon(plain ? UNLOCKED : LOCKED));
  }
  function show(url) {
    current = url || '';
    addr.value = shown(current);
    setLock(current);
    document.body.classList.toggle('browsing', !!current);
    try {
      history.replaceState(null, '', current ? '#' + shown(current) : location.pathname);
    } catch (e) {
      /* sandboxed */
    }
    if (!current) setTitle('');
  }
  function loading(on) {
    document.body.classList.toggle('loading', !!on);
  }
  function go(text) {
    var url = resolve(text);
    if (!url) return;
    show(url);
    loading(true);
    // The check page compares what a site can read with what this browser really is; the real values
    // travel in the fragment, which never leaves the browser.
    frame.src =
      url.indexOf(CHECK) === 0
        ? P + CHECK + '?' + Date.now().toString(36) + '#' + encodeURIComponent(JSON.stringify(realValues()))
        : P + url;
    addr.blur();
  }
  function home() {
    show('');
    loading(false);
    frame.removeAttribute('src');
    try {
      frame.contentWindow.location.replace('about:blank');
    } catch (e) {
      /* gone */
    }
    $('#q').value = '';
    $('#q').focus();
    if (state) apply(state);
  }
  function reload() {
    if (!current) return;
    loading(true);
    try {
      if (current.indexOf(CHECK) === 0) go(CHECK_NAME);
      else frame.contentWindow.location.reload();
    } catch (e) {
      frame.src = P + current;
    }
  }
  function rotate() {
    var host = '';
    try {
      host = new URL(current).hostname;
    } catch (e) {
      /* none */
    }
    return api('pool', { action: 'rotate', site: host }).then(function (s) {
      apply(s);
      reload();
    });
  }
  $('#nav').addEventListener('submit', function (e) {
    e.preventDefault();
    go(addr.value);
  });
  $('#start').addEventListener('submit', function (e) {
    e.preventDefault();
    go($('#q').value);
  });
  addr.addEventListener('focus', function () {
    addr.select();
  });
  $('#home').addEventListener('click', home);
  $('#back').addEventListener('click', function () {
    try {
      frame.contentWindow.history.back();
    } catch (e) {
      /* cross-origin */
    }
  });
  $('#fwd').addEventListener('click', function () {
    try {
      frame.contentWindow.history.forward();
    } catch (e) {
      /* cross-origin */
    }
  });
  $('#reload').addEventListener('click', reload);
  $('#rotate').addEventListener('click', function () {
    rotate().catch(function () {});
  });
  frame.addEventListener('load', function () {
    loading(false);
    refresh();
    try {
      var w = frame.contentWindow;
      w.addEventListener('keydown', onKey, true); // the panic key works while a page has the focus too
      // pages without the page script (errors, downloads) still report where they are
      var href = w.location.href;
      var at = href.indexOf(P);
      if (at >= 0 && href.indexOf(location.origin) === 0) {
        var real = href.slice(at + P.length).replace(/^f\/(?=https?:\/)/i, '');
        current = real.indexOf(CHECK) === 0 ? CHECK : real;
        if (document.activeElement !== addr) addr.value = shown(current);
        setLock(current);
      }
    } catch (e) {
      /* cross-origin */
    }
  });
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.origin !== location.origin || e.source !== frame.contentWindow || !m || m.waddle !== 1) return;
    if (m.kind === 'away') {
      loading(false);
      setOnline(false);
      refresh();
      return;
    }
    if (m.kind === 'action') {
      act(m);
      return;
    }
    if (m.kind === 'leave') {
      loading(true);
      return;
    }
    if (m.url) {
      current = m.url.indexOf(CHECK) === 0 ? CHECK : m.url;
      if (document.activeElement !== addr) addr.value = shown(current);
      setLock(current);
      try {
        history.replaceState(null, '', '#' + shown(current));
      } catch (err) {
        /* sandboxed */
      }
    }
    setTitle(m.title || '');
    if (m.kind === 'start') loading(true);
    if (m.kind === 'ready' || m.kind === 'load') {
      loading(false);
      refresh();
    }
    fit(m.viewport);
    frame.style.colorScheme = m.theme || '';
  });
  /** A button on one of Waddle's own pages (the one shown when a site cannot be loaded). */
  function act(m) {
    if (m.action === 'exit') rotate().catch(function () {});
    else if (m.action === 'proxies') open('proxies');
    else if (m.action === 'plain' && m.host) {
      api('plain', { host: m.host }).then(
        function (s) {
          apply(s);
          go(String(m.url || 'https://' + m.host + '/').replace(/^https:/i, 'http:'));
        },
        function () {}
      );
    }
  }

  // Lock the page to the spoofed screen's shape: lay it out at that size, then scale it down to fit.
  var locked = null;
  function fit(v) {
    if (v !== undefined) locked = v;
    var box = $('#fit');
    if (!locked) {
      frame.style.width = frame.style.height = frame.style.transform = frame.style.left = frame.style.top = '';
      return;
    }
    var w = locked[0];
    var h = locked[1];
    var k = Math.min(1, box.clientWidth / w, box.clientHeight / h);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.transform = 'scale(' + k + ')';
    frame.style.left = Math.max(0, (box.clientWidth - w * k) / 2) + 'px';
    frame.style.top = Math.max(0, (box.clientHeight - h * k) / 2) + 'px';
  }
  window.addEventListener('resize', function () {
    fit();
  });

  // ---- how the tab looks from outside ---------------------------------------------------
  var svgUri = function (body) {
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' + body + '</svg>');
  };
  // Plain, generic icons drawn here: a sheet, a board, a folder, a pad, a calculator.
  var CLOAKS = {
    docs: [
      'Untitled document',
      svgUri(
        '<path d="M8 3h11l6 6v20H8z" fill="#3b82f6"/><path d="M19 3v6h6z" fill="#93c5fd"/><path d="M12 15h9M12 19h9M12 23h6" stroke="#fff" stroke-width="2"/>'
      ),
    ],
    classroom: [
      'Classes',
      svgUri(
        '<rect x="3" y="6" width="26" height="20" rx="3" fill="#16a34a"/><circle cx="16" cy="14" r="3" fill="#fff"/><path d="M10 22c0-3 3-4 6-4s6 1 6 4z" fill="#fff"/>'
      ),
    ],
    drive: ['My Drive', svgUri('<path d="M3 9a2 2 0 0 1 2-2h7l3 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#f59e0b"/>')],
    notes: [
      'Notes',
      svgUri(
        '<rect x="5" y="4" width="22" height="24" rx="3" fill="#facc15"/><path d="M10 11h12M10 16h12M10 21h7" stroke="#854d0e" stroke-width="2"/>'
      ),
    ],
    calculator: [
      'Calculator',
      svgUri(
        '<rect x="6" y="3" width="20" height="26" rx="3" fill="#334155"/><rect x="9" y="6" width="14" height="6" rx="1" fill="#e2e8f0"/><path d="M11 17h2M15 17h2M19 17h2M11 21h2M15 21h2M19 21h2M11 25h2M15 25h2M19 25h2" stroke="#e2e8f0" stroke-width="2"/>'
      ),
    ],
    custom: ['', svgUri('<path d="M8 3h11l6 6v20H8z" fill="#94a3b8"/><path d="M19 3v6h6z" fill="#cbd5e1"/>')],
  };
  /** The document whose title and icon the browser shows: this one, or the blank tab Waddle was opened inside. */
  function outer() {
    try {
      if (window.parent !== window && window.parent.location.href === 'about:blank') return window.parent.document;
    } catch (e) {
      /* embedded by another site: not ours to touch */
    }
    return document;
  }
  var pageTitle = '';
  function setTitle(t) {
    pageTitle = t || '';
    dress();
  }
  function dress() {
    var ui = state ? state.config.ui : { cloak: 'none' };
    var cloak = CLOAKS[ui.cloak];
    var title = cloak ? (ui.cloak === 'custom' ? ui.cloakTitle || 'New Tab' : cloak[0]) : pageTitle ? pageTitle + ' · Waddle' : 'Waddle';
    var href = cloak ? cloak[1] : '/-/icon.svg';
    [document, outer()].forEach(function (doc, i) {
      if (i && doc === document) return;
      if (doc.title !== title) doc.title = title;
      var link = doc.querySelector('link[rel~="icon"]');
      if (!link) {
        link = doc.createElement('link');
        link.rel = 'icon';
        doc.head.appendChild(link);
      }
      var want = href.charAt(0) === '/' ? location.origin + href : href;
      if (link.href !== want) link.href = want;
    });
  }
  function setTheme(t) {
    var root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
    try {
      if (t === 'light' || t === 'dark') localStorage.setItem('waddle.theme', t);
      else localStorage.removeItem('waddle.theme');
    } catch (e) {
      /* storage is off */
    }
  }
  function panic() {
    var to = (state && state.config.ui.panicUrl) || 'about:blank';
    var doc = outer();
    try {
      doc.defaultView.location.replace(to);
    } catch (e) {
      location.replace(to);
    }
  }
  var capturing = null; // set while the settings wait for the key that is to be the panic key
  function onKey(e) {
    if (capturing) {
      e.preventDefault();
      e.stopPropagation();
      var done = capturing;
      capturing = null;
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') done(e.key);
      else capturing = done;
      return;
    }
    var key = state && state.config.ui.panicKey;
    if (key && e.key === key && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      panic();
    }
  }
  document.addEventListener('keydown', onKey, true);
  /** Open Waddle inside a tab whose address reads about:blank. */
  function blankTab() {
    var w = null;
    try {
      w = window.open('about:blank', '_blank');
    } catch (e) {
      /* blocked */
    }
    if (!w || !w.document) {
      toast('The browser blocked the new tab');
      return;
    }
    var d = w.document;
    d.title = document.title;
    var f = d.createElement('iframe');
    f.src = location.origin + '/' + (current ? '#' + shown(current) : '');
    f.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write; encrypted-media; picture-in-picture');
    f.setAttribute('allowfullscreen', '');
    f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
    d.body.style.margin = '0';
    d.body.appendChild(f);
  }

  // ---- identity ---------------------------------------------------------------------
  /** What this browser really is, for the check page to compare against. Stays in the browser. */
  function realValues() {
    var n = navigator;
    var o = {
      ua: n.userAgent,
      platform: n.platform,
      languages: (n.languages || [n.language]).join(', '),
      screen: screen.width + ' × ' + screen.height + ' @' + devicePixelRatio,
      cores: n.hardwareConcurrency,
      memory: n.deviceMemory,
      touch: n.maxTouchPoints,
      plugins: n.plugins ? n.plugins.length : 0,
      clock: new Date().toString().replace(/^\S+ /, ''),
      webrtc: window.RTCPeerConnection ? 'available' : 'not available',
    };
    try {
      o.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      /* old browser */
    }
    try {
      var c = document.createElement('canvas');
      var g = c.getContext('webgl') || c.getContext('experimental-webgl');
      var x = g && g.getExtension('WEBGL_debug_renderer_info');
      o.gl = g ? (x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : 'no WebGL';
    } catch (e) {
      /* no WebGL */
    }
    try {
      // the same drawing the check page makes
      var c2 = document.createElement('canvas');
      c2.width = 220;
      c2.height = 40;
      var k = c2.getContext('2d');
      k.textBaseline = 'top';
      k.font = '16px Arial';
      k.fillStyle = '#f60';
      k.fillRect(100, 2, 80, 24);
      k.fillStyle = '#069';
      k.fillText('Waddle, 1.0 \ud83d\udc27', 2, 8);
      var u = c2.toDataURL();
      var h = 0;
      for (var j = 0; j < u.length; j++) h = (h * 31 + u.charCodeAt(j)) | 0;
      o.canvas = (h >>> 0).toString(16);
    } catch (e) {
      /* no canvas */
    }
    return o;
  }
  /** Everything proxied pages left in this browser. The server forgets its side in the same breath. */
  function wipe() {
    try {
      var theme = localStorage.getItem('waddle.theme');
      localStorage.clear();
      if (theme) localStorage.setItem('waddle.theme', theme);
    } catch (e) {
      /* storage is off */
    }
    try {
      sessionStorage.clear();
    } catch (e) {
      /* storage is off */
    }
    try {
      if (indexedDB.databases)
        indexedDB.databases().then(function (list) {
          list.forEach(function (d) {
            if (d.name) indexedDB.deleteDatabase(d.name);
          });
        });
    } catch (e) {
      /* none */
    }
    try {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) {
          if (k.indexOf('waddle-shell-') !== 0) caches.delete(k);
        });
      });
    } catch (e) {
      /* none */
    }
  }
  function newIdentity() {
    return api('identity', {}).then(function (s) {
      wipe();
      extra = {};
      apply(s, true);
      toast('New identity');
      if (current) reload();
      return s;
    });
  }
  var armed = 0;
  $('#fresh').addEventListener('click', function () {
    // It signs you out everywhere, so it takes two clicks.
    if (Date.now() - armed < 4000) {
      armed = 0;
      newIdentity().catch(function () {});
    } else {
      armed = Date.now();
      toast('Click again for a new identity');
    }
  });

  // ---- state ----------------------------------------------------------------------
  var HEALTH = {
    ok: ['ok', 'Working'],
    starting: ['busy', 'Starting'],
    searching: ['busy', 'Finding proxies'],
    blocked: ['bad', 'This network blocks proxies'],
    nolists: ['bad', 'No proxy lists'],
    empty: ['warn', 'No sources'],
    off: ['', 'Off'],
  };
  function hops(last) {
    if (!last) return '';
    if (last.error) return last.error;
    var chain = (last.hops || [])
      .map(function (h) {
        return h.cc || h.proto;
      })
      .join(' › ');
    return chain + ' · ' + last.ms + ' ms';
  }
  function pill(dot, text, onclick, title) {
    return el(onclick ? 'button' : 'span', { class: 'pill', onclick: onclick, title: title }, [
      dot === null ? null : el('i', { class: 'dot ' + dot }),
      el('span', { text: text }),
    ]);
  }
  function apply(s, force) {
    if (!s || !s.config) return;
    state = s;
    var p = s.pool;
    var c = s.config;
    var last = p.last;
    var health = HEALTH[p.health] || HEALTH.searching;
    var browsing = document.body.classList.contains('browsing');
    $('#route i').className = 'dot ' + (browsing && last ? (last.error ? 'bad' : 'ok') : health[0]);
    $('#route span').textContent = browsing && last ? hops(last) : p.alive ? p.alive + (p.alive === 1 ? ' proxy' : ' proxies') : health[1];
    $('#route').title = browsing && last && last.error && last.detail ? last.detail : 'Route';

    var chips = $('#chips');
    chips.textContent = '';
    var id = s.identity || {};
    [
      [health[0], p.alive ? p.alive + ' live' : health[1], 'proxies'],
      [null, c.route.hops === 1 ? '1 hop' : c.route.hops + ' hops', 'route'],
      [null, 'DNS · ' + { auto: 'auto', stack: 'own', exit: 'exit' }[c.dns.mode], 'dns'],
      [id.detectable ? 'warn' : null, id.on ? id.label : 'Real browser', 'identity'],
      s.blocked ? [null, s.blocked.toLocaleString() + ' blocked', 'privacy'] : null,
    ].forEach(function (x) {
      if (!x) return;
      chips.appendChild(
        pill(x[0], x[1], function () {
          open(x[2]);
        })
      );
    });

    var links = $('#links');
    links.textContent = '';
    c.ui.links.forEach(function (line) {
      var m = /^(.*)\s+(https?:\/\/\S+)$/.exec(line);
      if (!m) return;
      links.appendChild(
        el(
          'button',
          {
            class: 'tile',
            title: m[2],
            onclick: function () {
              go(m[2]);
            },
          },
          [el('b', { text: m[1].trim().charAt(0).toUpperCase() }), el('span', { text: m[1].trim() })]
        )
      );
    });
    links.hidden = !links.firstChild;

    setTheme(c.ui.theme);
    dress();
    if (!$('#drawer').hidden) render(force);
  }
  var busy = false;
  function refresh() {
    if (busy) return;
    busy = true;
    var seen = writes;
    api('state')
      .then(
        function (s) {
          // A reply that was already on its way when a setting changed would undo the change on screen.
          if (seen === writes && !pending) apply(s);
        },
        function () {}
      )
      .then(function () {
        busy = false;
      });
  }
  setInterval(function () {
    if (!document.hidden) refresh();
  }, 4000);

  var pending = null;
  var timer = 0;
  function merge(a, b) {
    for (var k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = merge(a[k] || {}, b[k]);
      else a[k] = b[k];
    }
    return a;
  }
  function save(path, v) {
    var patch = {};
    var keys = path.split('.');
    var at = patch;
    keys.forEach(function (k, i) {
      at = at[k] = i === keys.length - 1 ? v : {};
    });
    merge(state.config, JSON.parse(JSON.stringify(patch)));
    pending = merge(pending || {}, patch);
    writes++;
    clearTimeout(timer);
    timer = setTimeout(function () {
      var p = pending;
      pending = null;
      api('config', p).then(apply, function () {});
    }, 250);
    if (keys[0] === 'ui') {
      setTheme(state.config.ui.theme);
      dress();
    }
  }
  var get = function (path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? o : o[k];
    }, state.config);
  };

  // ---- settings controls ----------------------------------------------------------
  function row(label, control, o) {
    o = o || {};
    return el('div', { class: 'row' + (o.col ? ' col' : '') }, [
      el('label', {}, [label, o.hint ? el('small', { text: o.hint }) : null]),
      control,
    ]);
  }
  function seg(label, path, opts, o) {
    var cur = get(path);
    var box = el(
      'div',
      { class: 'seg', role: 'group', 'aria-label': label },
      opts.map(function (x) {
        var v = Array.isArray(x) ? x[0] : x;
        return el('button', {
          class: String(cur) === String(v) ? 'on' : '',
          'aria-pressed': String(String(cur) === String(v)),
          'data-k': path + '=' + v,
          text: Array.isArray(x) ? x[1] : String(x),
          onclick: function () {
            save(path, v);
            render(true);
          },
        });
      })
    );
    return row(label, box, o);
  }
  function tog(label, path, o) {
    o = o || {};
    var on = o.on === undefined ? !!get(path) : get(path) === o.on;
    return row(
      label,
      el('button', {
        class: 'sw' + (on ? ' on' : ''),
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': label,
        'data-k': path,
        onclick: function () {
          save(path, o.on === undefined ? !on : on ? o.off : o.on);
          render(true);
        },
      }),
      o
    );
  }
  function num(label, path, scale, o) {
    scale = scale || 1;
    return row(
      label,
      el('input', {
        type: 'number',
        value: get(path) / scale,
        'aria-label': label,
        'data-k': path,
        onchange: function (e) {
          save(path, Number(e.target.value) * scale);
        },
      }),
      o
    );
  }
  function txt(label, path, ph, o) {
    return row(
      label,
      el('input', {
        type: 'text',
        value: get(path),
        placeholder: ph || '',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': label,
        'data-k': path,
        onchange: function (e) {
          save(path, e.target.value);
        },
      }),
      o
    );
  }
  /** A list setting edited as text, one entry per line. */
  function area(label, path, rows, ph, hint) {
    return row(
      label,
      el(
        'textarea',
        {
          rows: rows,
          spellcheck: 'false',
          'aria-label': label,
          'data-k': path,
          placeholder: ph || '',
          onchange: function (e) {
            save(
              path,
              e.target.value
                .split('\n')
                .map(function (x) {
                  return x.trim();
                })
                .filter(Boolean)
            );
          },
        },
        [get(path).join('\n')]
      ),
      { col: true, hint: hint }
    );
  }
  function multi(label, path, opts) {
    var cur = get(path);
    return row(
      label,
      el(
        'div',
        { class: 'seg', role: 'group', 'aria-label': label },
        opts.map(function (v) {
          var on = cur.indexOf(v) >= 0;
          return el('button', {
            class: on ? 'on' : '',
            'aria-pressed': String(on),
            'data-k': path + '=' + v,
            text: v,
            onclick: function () {
              save(
                path,
                on
                  ? cur.filter(function (x) {
                      return x !== v;
                    })
                  : cur.concat(v)
              );
              render(true);
            },
          });
        })
      )
    );
  }

  // A dropdown drawn here rather than by the system, so it looks the same everywhere and can be searched.
  var openDD = null;
  var CHEVRON = 'M6 9l6 6 6-6';
  var TICK = 'M5 12.500l4.500 4.500L19 7.500';
  /**
   * @param {object} o
   *   options  [[value, label, note]]
   *   value    the chosen value (single) / values: the chosen ones (many: true)
   *   onpick   called with the new value, or the new list
   *   search   show a filter field
   *   empty    what the button says when nothing is chosen
   *   key      data-k, so focus can come back here after the panel is redrawn
   */
  function dropdown(o) {
    var chosen = o.many ? o.values.slice() : o.value;
    var text = el('span');
    var btn = el(
      'button',
      {
        class: 'dd-btn',
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        'data-k': o.key,
        id: o.id,
        'aria-label': o.label,
      },
      [text, icon(CHEVRON)]
    );
    var wrap = el('div', { class: 'dd' }, [btn]);
    var pop = null;
    var list = null;
    var find = null;
    var rows = []; // [{ value, node }]
    var at = -1;
    var typed = '';
    var typedAt = 0;
    var has = function (v) {
      return o.many ? chosen.indexOf(v) >= 0 : String(chosen) === String(v);
    };
    var caption = function () {
      var picked = o.options.filter(function (x) {
        return has(x[0]);
      });
      if (!picked.length) return o.empty || '';
      if (o.many)
        return picked.length > 3
          ? picked.length + ' chosen'
          : picked
              .map(function (x) {
                return x[3] || x[1];
              })
              .join(', ');
      return picked[0][1];
    };
    text.textContent = caption();
    var move = function (i, quiet) {
      if (!rows.length) {
        at = -1;
        return;
      }
      at = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach(function (r, k) {
        r.node.classList.toggle('at', k === at);
      });
      if (!quiet) rows[at].node.scrollIntoView({ block: 'nearest' });
      list.setAttribute('aria-activedescendant', rows[at].node.id);
    };
    var choose = function (i) {
      var r = rows[i];
      if (!r) return;
      if (o.many) {
        chosen = has(r.value)
          ? chosen.filter(function (v) {
              return v !== r.value;
            })
          : chosen.concat(r.value);
        r.node.setAttribute('aria-selected', String(has(r.value)));
        text.textContent = caption();
        o.onpick(chosen.slice());
        return;
      }
      chosen = r.value;
      close(true);
      o.onpick(r.value);
    };
    var fill = function (filter) {
      filter = String(filter || '')
        .trim()
        .toLowerCase();
      list.textContent = '';
      rows = [];
      o.options.forEach(function (x, i) {
        if (filter && (x[1] + ' ' + x[0] + ' ' + (x[2] || '')).toLowerCase().indexOf(filter) < 0) return;
        var node = el('div', { class: 'dd-opt', role: 'option', id: 'dd-' + i, 'aria-selected': String(has(x[0])) }, [
          el('span', { text: x[1] }),
          x[2] ? el('small', { text: x[2] }) : null,
          icon(TICK, 'tick'),
        ]);
        var k = rows.length;
        node.addEventListener('click', function () {
          choose(k);
        });
        node.addEventListener('pointermove', function () {
          if (at !== k) move(k, true);
        });
        rows.push({ value: x[0], node: node });
        list.appendChild(node);
      });
      if (!rows.length) list.appendChild(el('div', { class: 'dd-none', text: 'Nothing found' }));
      var first = -1;
      rows.forEach(function (r, k) {
        if (first < 0 && has(r.value)) first = k;
      });
      move(first < 0 ? 0 : first, true);
    };
    var keys = function (e) {
      if (e.key === 'ArrowDown') move(at + 1);
      else if (e.key === 'ArrowUp') move(at - 1);
      else if (e.key === 'Home' && !find) move(0);
      else if (e.key === 'End' && !find) move(rows.length - 1);
      else if (e.key === 'PageDown') move(at + 8);
      else if (e.key === 'PageUp') move(at - 8);
      else if (e.key === 'Enter' || (e.key === ' ' && !find)) choose(at);
      else if (e.key === 'Escape') close(true);
      else if (e.key === 'Tab') {
        close();
        return;
      } else if (!find && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // type a few letters to jump
        var now = Date.now();
        typed = (now - typedAt > 700 ? '' : typed) + e.key.toLowerCase();
        typedAt = now;
        for (var i = 0; i < rows.length; i++)
          if (rows[i].node.firstChild.textContent.toLowerCase().indexOf(typed) === 0) {
            move(i);
            break;
          }
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    function open() {
      if (openDD) openDD.close();
      list = el('div', { class: 'dd-list', role: 'listbox', tabindex: '-1', 'aria-multiselectable': o.many ? 'true' : null });
      find = o.search
        ? el('input', {
            class: 'dd-find',
            type: 'text',
            placeholder: 'Search',
            'aria-label': 'Search',
            spellcheck: 'false',
            autocomplete: 'off',
            oninput: function (e) {
              fill(e.target.value);
            },
          })
        : null;
      pop = el('div', { class: 'dd-pop' }, [find, list]);
      pop.addEventListener('keydown', keys);
      wrap.appendChild(pop);
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      fill('');
      // Open upwards when there is more room above.
      var box = btn.getBoundingClientRect();
      var room = window.innerHeight - box.bottom;
      if (room < Math.min(300, pop.offsetHeight) + 16 && box.top > room) pop.classList.add('up');
      if (at >= 0) rows[at].node.scrollIntoView({ block: 'nearest' });
      (find || list).focus();
      openDD = { close: close, wrap: wrap };
    }
    function close(refocus) {
      if (!pop) return;
      wrap.removeChild(pop);
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      pop = list = find = null;
      if (openDD && openDD.wrap === wrap) openDD = null;
      if (refocus) btn.focus();
      if (o.many && o.onclose) o.onclose();
    }
    btn.addEventListener('click', function () {
      if (pop) close(true);
      else open();
    });
    btn.addEventListener('keydown', function (e) {
      if (!pop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        open();
      }
    });
    return wrap;
  }
  document.addEventListener(
    'pointerdown',
    function (e) {
      if (openDD && !openDD.wrap.contains(e.target)) openDD.close();
    },
    true
  );
  function sel(label, path, opts, o) {
    o = o || {};
    return row(
      label,
      dropdown({
        options: opts,
        value: get(path),
        key: path,
        label: label,
        search: o.search,
        onpick: function (v) {
          save(path, v);
          render(true);
        },
      }),
      o
    );
  }
  /** Choose any number from a long list (countries). */
  function pick(label, path, opts, empty) {
    return row(
      label,
      dropdown({
        options: opts,
        values: get(path),
        many: true,
        search: true,
        empty: empty,
        key: path,
        label: label,
        onpick: function (list) {
          save(path, list);
        },
        onclose: function () {
          render(true);
        },
      })
    );
  }
  function btn(text, fn, pri) {
    return el('button', {
      class: 'btn' + (pri ? ' pri' : ''),
      text: text,
      'data-k': 'btn:' + text,
      onclick: function (e) {
        var b = e.currentTarget;
        b.disabled = true;
        Promise.resolve()
          .then(fn)
          .then(
            function (s) {
              if (s && s.config) apply(s, true);
              else render(true);
            },
            function () {}
          )
          .then(function () {
            b.disabled = false;
          });
      },
    });
  }
  var h2 = function (t) {
    return el('h2', { text: t });
  };
  var ms = function (v) {
    return v ? v + ' ms' : '';
  };
  var n = function (v) {
    return Number(v || 0).toLocaleString();
  };
  var ago = function (t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90
      ? 'just now'
      : s < 5400
        ? Math.round(s / 60) + ' min ago'
        : s < 129600
          ? Math.round(s / 3600) + ' h ago'
          : Math.round(s / 86400) + ' d ago';
  };
  /** Countries for a dropdown: the ones with live proxies first, each with its count. */
  function countries() {
    var live = state.pool.countries || {};
    return state.options.countries
      .map(function (x) {
        return [x[0], x[1], live[x[0]] ? live[x[0]] + ' live' : '', x[0]];
      })
      .sort(function (a, b) {
        return (live[b[0]] || 0) - (live[a[0]] || 0) || a[1].localeCompare(b[1]);
      });
  }

  var TABS = {
    route: [
      'Route',
      function (c) {
        var r = c.route;
        var out = [];
        var last = state.pool.last;
        if (last) {
          var list = el('div', { class: 'list' });
          list.appendChild(
            el('div', {}, [
              el('i', { class: 'dot ' + (last.error ? 'bad' : 'ok') }),
              el('span', { class: 'name', text: last.host }),
              el('span', { class: 'dim num', text: last.error || last.status + ' · ' + last.ms + ' ms' }),
            ])
          );
          (last.hops || []).forEach(function (h, i) {
            list.appendChild(
              el('div', {}, [
                el('span', { class: 'tag', text: i === last.hops.length - 1 ? 'exit' : i === 0 ? 'entry' : 'hop ' + (i + 1) }),
                el('span', { class: 'name mono', text: h.proto + '://' + h.addr }),
                el('span', { class: 'dim', text: h.cc }),
              ])
            );
          });
          out.push(h2('Last page'), list);
          if (last.error && last.detail) out.push(el('div', { class: 'hint', text: last.detail }));
          if (last.attempts > 1) out.push(el('div', { class: 'hint', text: 'Took ' + last.attempts + ' tries.' }));
        }
        out.push(
          h2('Exit'),
          seg('New exit', 'route.rotate', [
            ['sticky', 'Per site'],
            ['request', 'Every request'],
            ['timed', 'Timed'],
          ]),
          r.rotate !== 'request' ? num('Keep for (min)', 'route.minutes') : null,
          pick('Exit country', 'route.countries', countries(), 'Any'),
          multi('Protocols', 'route.protocols', ['http', 'socks4', 'socks5']),
          h2('Chain'),
          seg(
            'Hops',
            'route.hops',
            Array.apply(null, Array(state.options.maxHops)).map(function (_, i) {
              return i + 1;
            })
          ),
          r.hops > 1 ? pick('Entry country', 'route.entry', countries(), 'Any') : null,
          r.hops > 1 ? tog('A different country per hop', 'route.spread') : null,
          r.hops > 1 ? tog('Shorter chain when proxies are few', 'route.shorten') : null,
          h2('Connection'),
          tog('HTTPS only', 'route.https'),
          num('Retries', 'route.retries'),
          num('Timeout (s)', 'route.timeout', 1000),
          area('Rules', 'route.rules', 4, 'example.com proxy US,DE hops=2\n*.ads.example block')
        );
        return out;
      },
    ],
    proxies: [
      'Proxies',
      function () {
        var p = state.pool;
        var health = HEALTH[p.health] || HEALTH.searching;
        var doing = { harvesting: 'Downloading lists', checking: 'Testing', paused: 'Paused' }[p.status] || '';
        var detail = [];
        if (doing) detail.push(doing);
        if (p.waiting) detail.push(n(p.waiting) + ' waiting');
        if (p.note) detail.push(p.note);
        if (p.resumeIn) detail.push('again in ' + p.resumeIn + ' s');
        if (!p.alive) {
          var why = Object.keys(p.why || {})
            .filter(function (k) {
              return p.why[k];
            })
            .map(function (k) {
              return n(p.why[k]) + ' ' + k;
            });
          if (why.length) detail.push(why.join(', '));
        }
        var r = [
          el(
            'div',
            { class: 'stats' },
            [
              ['Live', p.alive],
              ['Tested', p.checked],
              ['Found', p.found],
            ].map(function (x) {
              return el('div', {}, [el('b', { text: n(x[1]) }), el('span', { text: x[0] })]);
            })
          ),
          el('div', { class: 'status' }, [pill(health[0], health[1]), detail.length ? el('span', { text: detail.join(' · ') }) : null]),
          el('div', { class: 'btns' }, [
            btn(
              'Harvest',
              function () {
                return api('pool', { action: 'harvest' });
              },
              true
            ),
            btn('Speed test', function () {
              return api('pool', { action: 'speed' }).then(function (s) {
                extra.speed = s.results || [];
                return s;
              });
            }),
            btn('Clear', function () {
              extra.speed = null;
              return api('pool', { action: 'clear' });
            }),
          ]),
        ];
        if (extra.speed) {
          r.push(h2('Response time'));
          r.push(
            extra.speed.length
              ? el(
                  'div',
                  { class: 'list' },
                  extra.speed.map(function (x) {
                    return el('div', {}, [
                      el('span', { class: 'name mono', text: x.via }),
                      el('span', { class: x.error ? 'dim' : 'num', text: x.error || x.ms + ' ms' }),
                    ]);
                  })
                )
              : el('div', { class: 'hint', text: 'No live proxy to test.' })
          );
        }
        if (p.proxies.length) {
          r.push(h2('Live'));
          r.push(
            el(
              'div',
              { class: 'list' },
              p.proxies.map(function (x) {
                return el('div', {}, [
                  el('span', { class: 'tag', text: x.proto }),
                  el('span', { class: 'name mono', text: x.addr }),
                  x.leaks
                    ? el('span', {
                        class: 'tag warn',
                        title: 'Adds headers that give a proxy away. Not used for pages without HTTPS.',
                        text: 'leaks',
                      })
                    : null,
                  el('span', { class: 'dim', text: x.cc || '' }),
                  el('span', { class: 'num', text: ms(x.ms) }),
                ]);
              })
            )
          );
        }
        r.push(h2('Sources'));
        r.push(
          el('div', { class: 'add' }, [
            el('input', {
              id: 'src',
              type: 'text',
              placeholder: 'owner/repo or list address',
              'aria-label': 'Add a source',
              spellcheck: 'false',
            }),
            btn('Add', function () {
              var v = $('#src').value.trim();
              if (!v) return null;
              return api('pool', { action: 'source', text: v }).then(function (s) {
                if (s && s.config) forget('src');
                else toast('Not a repository or a list address');
                return s;
              });
            }),
          ])
        );
        r.push(
          el(
            'div',
            { class: 'list' },
            p.sources.map(function (s) {
              var tip = [s.error || s.name];
              if (s.tried) tip.push(n(s.worked) + ' of ' + n(s.tried) + ' tested worked');
              if (s.bad) tip.push(n(s.bad) + ' changed pages');
              if (s.via) tip.push('fetched ' + (s.via === 'proxy' ? 'through a proxy' : 'directly'));
              return el('div', { title: tip.join('\n') }, [
                el('button', {
                  class: 'sw small' + (s.on ? ' on' : ''),
                  role: 'switch',
                  'aria-checked': String(!!s.on),
                  'aria-label': 'Use ' + s.name,
                  'data-k': 'src:' + s.id,
                  onclick: function () {
                    api('pool', { action: 'toggle', id: s.id, on: !s.on }).then(apply, function () {});
                  },
                }),
                el('span', { class: 'name', text: s.name.replace(/^https?:\/\//, '') }),
                s.found ? el('span', { class: 'tag', text: 'found' }) : null,
                s.resting ? el('span', { class: 'tag warn', text: 'resting' }) : null,
                el('span', {
                  class: 'dim num',
                  text:
                    s.state === 'error'
                      ? s.error
                      : s.state === 'loading'
                        ? '…'
                        : s.count
                          ? n(s.count) + (s.alive ? ' · ' + s.alive + ' live' : '')
                          : s.state === 'pending'
                            ? ''
                            : '0',
                }),
                s.id === 'manual'
                  ? null
                  : el('button', {
                      class: 'x',
                      title: 'Remove',
                      'aria-label': 'Remove ' + s.name,
                      text: '×',
                      onclick: function () {
                        api('pool', { action: 'unsource', id: s.id }).then(apply, function () {});
                      },
                    }),
              ]);
            })
          )
        );
        if (p.discover) r.push(el('div', { class: 'hint', text: p.discover }));
        r.push(h2('Add proxies'));
        r.push(
          el('textarea', {
            id: 'manual',
            rows: 3,
            spellcheck: 'false',
            'aria-label': 'Proxies to add',
            placeholder: 'socks5://1.2.3.4:1080\n5.6.7.8:8080',
          })
        );
        r.push(
          el('div', { class: 'btns' }, [
            btn('Add', function () {
              var v = $('#manual').value;
              return v.trim()
                ? api('pool', { action: 'add', text: v }).then(function (s) {
                    forget('manual');
                    toast(s.added ? n(s.added) + ' added' : 'Nothing new');
                    return s;
                  })
                : null;
            }),
          ])
        );
        r.push(
          h2('Harvest'),
          tog('Harvest', 'pool.on'),
          tog('Adapt the schedule', 'pool.adaptive'),
          tog('Find new sources', 'pool.discover'),
          num('Keep live', 'pool.target'),
          num('Every (min)', 'pool.harvestMinutes'),
          num('Recheck (min)', 'pool.recheckMinutes'),
          num('Test timeout (s)', 'pool.checkTimeout', 1000),
          num('Tests at once', 'pool.concurrency'),
          h2('Tests'),
          txt('Judge', 'pool.judge', '', { col: true }),
          txt('Header echo', 'pool.echo', 'off', { col: true }),
          area('Tamper checks', 'pool.canaries', 3, 'http://address expected text')
        );
        return r;
      },
    ],
    dns: [
      'DNS',
      function (c) {
        var d = state.dns;
        var own = c.dns.mode !== 'exit';
        var r = [
          seg(
            'Lookups',
            'dns.mode',
            [
              ['auto', 'Auto'],
              ['stack', 'Resolvers'],
              ['exit', 'Exit'],
            ],
            {
              hint: {
                auto: 'The exit looks names up. Where it cannot, the resolvers below are asked through it.',
                stack: 'The resolvers below are asked, through the exit.',
                exit: 'The exit looks names up.',
              }[c.dns.mode],
            }
          ),
        ];
        if (own)
          r.push(
            sel('Order', 'dns.strategy', [
              ['fallback', 'In order'],
              ['race', 'Fastest'],
              ['rotate', 'Take turns'],
              ['split', 'Split by name'],
              ['check', 'Cross-check'],
            ]),
            c.dns.strategy === 'race' || c.dns.strategy === 'check' ? num('Ask at once', 'dns.parallel') : null,
            tog('Pad questions', 'dns.pad')
          );
        r.push(h2('Resolvers'));
        var servers = c.dns.servers;
        var move = function (i, by) {
          var list = servers.slice();
          var x = list.splice(i, 1)[0];
          list.splice(i + by, 0, x);
          save('dns.servers', list);
          render(true);
        };
        r.push(
          el(
            'div',
            { class: 'list' },
            d.servers.map(function (s) {
              var i = servers.indexOf(s.url);
              return el('div', { title: s.url + (s.label ? '\n' + s.label : '') }, [
                el('i', { class: 'dot ' + (s.down || s.lies ? 'bad' : s.ok ? 'ok' : s.fail ? 'warn' : '') }),
                el('span', { class: 'name', text: s.name }),
                s.auto ? el('span', { class: 'tag', text: 'listed' }) : null,
                s.lies ? el('span', { class: 'tag bad', text: 'disagrees' }) : null,
                el('span', { class: 'dim num', text: s.down ? s.error || 'down' : ms(s.ms) }),
                i > 0
                  ? el('button', {
                      class: 'x',
                      title: 'Up',
                      'aria-label': 'Move ' + s.name + ' up',
                      text: '↑',
                      onclick: function () {
                        move(i, -1);
                      },
                    })
                  : null,
                i >= 0
                  ? el('button', {
                      class: 'x',
                      title: 'Remove',
                      'aria-label': 'Remove ' + s.name,
                      text: '×',
                      onclick: function () {
                        save(
                          'dns.servers',
                          servers.filter(function (x) {
                            return x !== s.url;
                          })
                        );
                        render(true);
                      },
                    })
                  : null,
              ]);
            })
          )
        );
        var free = state.options.dns.filter(function (x) {
          return servers.indexOf(x.url) < 0;
        });
        r.push(
          el('div', { class: 'add' }, [
            dropdown({
              options: free
                .map(function (x) {
                  return [x.url, x.label];
                })
                .concat([['custom', 'Custom address']]),
              value: extra.dnsPick || '',
              empty: 'Add a resolver',
              label: 'Add a resolver',
              key: 'dnspick',
              onpick: function (v) {
                if (v === 'custom') {
                  extra.dnsPick = 'custom';
                  render(true);
                  var u = $('#dnsurl');
                  if (u) u.focus();
                  return;
                }
                extra.dnsPick = '';
                if (servers.indexOf(v) < 0) save('dns.servers', servers.concat(v));
                render(true);
              },
            }),
            extra.dnsPick === 'custom'
              ? el('input', {
                  id: 'dnsurl',
                  type: 'text',
                  placeholder: 'https://…/dns-query',
                  'aria-label': 'Resolver address',
                  spellcheck: 'false',
                })
              : null,
            extra.dnsPick === 'custom'
              ? btn('Add', function () {
                  var v = $('#dnsurl').value.trim();
                  if (v && servers.indexOf(v) < 0) {
                    forget('dnsurl');
                    extra.dnsPick = '';
                    save('dns.servers', servers.concat(v));
                  }
                  return null;
                })
              : null,
          ])
        );
        var f = d.feed;
        r.push(
          h2('Public list'),
          tog('Add tested public resolvers', 'dns.auto', { hint: 'No logs, no filtering, no client subnet. Tested through a proxy.' }),
          c.dns.auto ? num('Keep', 'dns.keep') : null,
          c.dns.auto ? num('Refresh (h)', 'dns.refreshHours') : null
        );
        if (c.dns.auto)
          r.push(
            el('div', { class: 'status' }, [
              pill(f.busy ? 'busy' : f.error ? 'warn' : f.kept ? 'ok' : '', f.busy ? 'Testing' : f.kept ? f.kept + ' in use' : 'None yet'),
              el('span', {
                text: [f.listed ? n(f.listed) + ' listed' : '', f.at ? ago(f.at) : '', f.error].filter(Boolean).join(' · '),
              }),
            ]),
            el('div', { class: 'btns' }, [
              btn('Refresh list', function () {
                return api('dns', { action: 'refresh' });
              }),
            ])
          );
        r.push(h2('Test'));
        r.push(
          el('div', { class: 'add' }, [
            el('input', {
              id: 'dnshost',
              type: 'text',
              placeholder: 'example.com',
              'aria-label': 'Name to look up',
              spellcheck: 'false',
              value: extra.dnsHost || '',
            }),
            btn('Test', function () {
              var h = $('#dnshost').value.trim() || 'example.com';
              extra.dnsHost = h;
              return api('dns', { action: 'test', host: h }).then(function (s) {
                extra.dns = s.results || [];
                extra.dnsVia = s.via || [];
                return s;
              });
            }),
            btn('Flush', function () {
              extra.dns = null;
              return api('dns', { action: 'flush' });
            }),
          ])
        );
        if (extra.dns) {
          r.push(
            el(
              'div',
              { class: 'list' },
              extra.dns.map(function (x) {
                return el('div', {}, [
                  el('span', { class: 'name', text: x.name }),
                  el('span', { class: 'mono dim', text: x.address || x.error }),
                  el('span', { class: 'num', text: ms(x.ms) }),
                ]);
              })
            )
          );
          if (extra.dnsVia && extra.dnsVia.length)
            r.push(
              el('div', {
                class: 'hint',
                text:
                  'Asked through ' +
                  extra.dnsVia
                    .map(function (h) {
                      return h.cc || h.proto;
                    })
                    .join(' › ') +
                  '.',
              })
            );
        }
        r.push(
          h2('Housekeeping'),
          tog('System resolver as a last resort', 'dns.fallback', { hint: 'For Waddle’s own downloads only. Never for a site you open.' }),
          el('div', {
            class: 'hint',
            text:
              n(d.cached) +
              ' cached' +
              (d.last && d.last.via ? ' · last answer from ' + d.last.via : '') +
              (d.system ? ' · system used ' + d.system + '×' : ''),
          })
        );
        return r;
      },
    ],
    identity: [
      'Identity',
      function (c) {
        var o = state.options;
        var s = c.spoof;
        var id = state.identity || {};
        var r = [tog('Spoofing', 'spoof.on')];
        if (!s.on) return r;
        r.push(
          el('div', { class: 'card' }, [
            el('div', { class: 'top' }, [
              el('span', { text: id.label || 'Real browser' }),
              id.detectable
                ? el(
                    'span',
                    {
                      class: 'pill flat warn',
                      title: 'The claimed browser is not the kind you are really using. A site that tests for it can tell.',
                    },
                    [el('i', { class: 'dot warn' }), el('span', { text: 'Detectable' })]
                  )
                : null,
            ]),
            el('p', {
              text:
                [(id.languages || [])[0], id.tz, id.screen, id.cores ? id.cores + ' cores' : '', id.gpu].filter(Boolean).join(' · ') ||
                'As your browser reports it',
            }),
          ])
        );
        var desktop = o.systems.filter(function (x) {
          return x.kind === 'desktop';
        });
        var phones = o.systems.filter(function (x) {
          return x.kind !== 'desktop';
        });
        var random = s.random !== 'off';
        var sys = o.systems.filter(function (x) {
          return x.id === id.id;
        })[0];
        r.push(
          h2('Browser'),
          sel('Randomise', 'spoof.random', [
            ['off', 'Off'],
            ['session', 'Per session'],
            ['site', 'Per site'],
            ['timer', 'On a timer'],
          ]),
          s.random === 'timer' ? num('Every (min)', 'spoof.randomMinutes') : null,
          random ? tog('Stay the same kind of browser', 'spoof.match', { hint: 'A claim your real browser can back up.' }) : null,
          tog('Phone', 'spoof.mobile'),
          !random && !s.mobile
            ? sel(
                'System',
                'spoof.system',
                desktop
                  .map(function (x) {
                    return [x.id, x.label];
                  })
                  .concat([
                    ['custom', 'Custom'],
                    ['real', 'Real'],
                  ])
              )
            : null,
          !random && s.mobile
            ? sel(
                'Phone model',
                'spoof.phone',
                [['auto', 'Auto']].concat(
                  phones.map(function (x) {
                    return [x.id, x.label];
                  })
                )
              )
            : null,
          !random && !s.mobile && s.system === 'custom' ? txt('User agent', 'spoof.customUa', 'Mozilla/5.0 …', { col: true }) : null,
          !random && !s.mobile && s.system === 'custom' ? txt('Platform', 'spoof.customPlatform', 'Win32') : null
        );
        var follow = function (label, path, real, hint) {
          var v = get(path);
          var mode = v === 'exit' || v === 'real' ? v : 'custom';
          return [
            seg(label, path, [
              ['exit', 'Exit country'],
              ['real', 'Real'],
              [mode === 'custom' ? v : real, 'Custom'],
            ]),
            mode === 'custom' ? txt(hint, path, real, { col: true }) : null,
          ];
        };
        r.push(h2('Place'));
        r = r.concat(
          follow('Language', 'spoof.languages', 'en-US, en', 'Languages, most wanted first'),
          follow('Time zone', 'spoof.timezone', 'Europe/Berlin', 'Zone name')
        );
        r.push(
          seg('Location', 'spoof.geo', [
            ['block', 'Refuse'],
            ['exit', 'Exit country'],
            ['real', 'Real'],
          ]),
          h2('Device'),
          sel(
            'Screen',
            'spoof.screen',
            [
              ['auto', 'Auto'],
              ['real', 'Real'],
            ].concat(
              o.screens.map(function (x) {
                var m = /^(\d+)x(\d+)@([\d.]+)$/.exec(x);
                return [x, m[1] + ' × ' + m[2], m[3] + 'x'];
              })
            )
          ),
          tog('Lock the page to that size', 'spoof.viewport', { on: 'screen', off: 'window' }),
          sys && s.webgl === 'spoof'
            ? sel(
                'Graphics',
                'spoof.gpu',
                [['auto', 'Auto']].concat(
                  sys.gpus.map(function (g, i) {
                    return [String(i), g];
                  })
                )
              )
            : null,
          sel(
            'Processor cores',
            'spoof.cores',
            ['auto', '2', '4', '6', '8', '12', '16'].map(function (x) {
              return [x, x === 'auto' ? 'Auto' : x];
            })
          ),
          sel(
            'Memory',
            'spoof.memory',
            ['auto', '2', '4', '8'].map(function (x) {
              return [x, x === 'auto' ? 'Auto' : x + ' GB'];
            })
          ),
          seg('Touch', 'spoof.touch', [
            ['auto', 'Auto'],
            ['off', 'Off'],
            ['on', 'On'],
          ]),
          seg('Battery', 'spoof.battery', [
            ['generic', 'Full'],
            ['random', 'Random'],
            ['real', 'Real'],
          ]),
          h2('Look'),
          seg('Colour scheme', 'spoof.theme', [
            ['real', 'Real'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]),
          seg('Motion', 'spoof.motion', [
            ['real', 'Real'],
            ['reduce', 'Reduced'],
            ['no-preference', 'Full'],
          ]),
          h2('Network'),
          sel(
            'Connection',
            'spoof.network',
            [['real', 'Real']].concat(
              o.networks.map(function (x) {
                return [x, x === 'wifi' ? 'Wi-Fi' : x.toUpperCase().replace('SLOW-', 'Slow ')];
              })
            )
          ),
          tog('Save-Data', 'spoof.saveData'),
          seg('WebRTC', 'spoof.webrtc', [
            ['block', 'Blocked'],
            ['real', 'Allowed'],
          ]),
          tog('Do Not Track + GPC', 'spoof.dnt'),
          h2('Fingerprint'),
          seg('Canvas', 'spoof.canvas', [
            ['real', 'Real'],
            ['noise', 'Noise'],
            ['block', 'Blank'],
          ]),
          seg('WebGL', 'spoof.webgl', [
            ['real', 'Real'],
            ['spoof', 'Spoofed'],
          ]),
          seg('Audio', 'spoof.audio', [
            ['real', 'Real'],
            ['noise', 'Noise'],
          ]),
          seg('Layout', 'spoof.rects', [
            ['real', 'Real'],
            ['noise', 'Noise'],
          ]),
          seg('Fonts', 'spoof.fonts', [
            ['real', 'Real'],
            ['limit', 'Basic set'],
          ]),
          seg('Plugins', 'spoof.plugins', [
            ['auto', 'Standard'],
            ['none', 'None'],
            ['real', 'Real'],
          ]),
          seg('Voices', 'spoof.voices', [
            ['generic', 'Standard'],
            ['none', 'None'],
            ['real', 'Real'],
          ]),
          seg('Cameras', 'spoof.media', [
            ['generic', 'Generic'],
            ['none', 'None'],
            ['real', 'Real'],
          ])
        );
        return r;
      },
    ],
    privacy: [
      'Privacy',
      function () {
        var r = [
          el('div', { class: 'btns' }, [
            btn('New identity', newIdentity, true),
            btn('What sites see', function () {
              $('#drawer').hidden = true;
              go(CHECK_NAME);
              return null;
            }),
          ]),
          el('div', { class: 'hint', text: 'New identity: new exits, new fingerprint, cookies and site data gone.' }),
          h2('Tracking'),
          seg('Other sites’ cookies', 'privacy.cookies', [
            ['first', 'Block'],
            ['all', 'Allow'],
            ['none', 'Block all'],
          ]),
          tog('Block trackers', 'privacy.trackers', {
            hint: n(state.trackers) + ' hosts listed' + (state.blocked ? ' · ' + n(state.blocked) + ' requests refused' : ''),
          }),
          seg('Referer to other sites', 'spoof.referer', [
            ['full', 'Full'],
            ['origin', 'Site only'],
            ['none', 'None'],
          ]),
          h2('Stored'),
          row(
            'Cookies',
            el('div', { class: 'btns' }, [
              el('span', { class: 'dim', style: 'align-self:center', text: n(state.cookies) }),
              btn('Clear', function () {
                return api('cookies', {});
              }),
            ])
          ),
        ];
        if (state.plain && state.plain.length) {
          r.push(h2('Allowed without HTTPS'));
          r.push(
            el(
              'div',
              { class: 'list' },
              state.plain.map(function (host) {
                return el('div', {}, [
                  el('span', { class: 'name mono', text: host }),
                  el('button', {
                    class: 'x',
                    title: 'Remove',
                    'aria-label': 'Remove ' + host,
                    text: '×',
                    onclick: function () {
                      api('plain', { host: host, on: false }).then(function (s) {
                        apply(s, true);
                      });
                    },
                  }),
                ]);
              })
            )
          );
        }
        return r;
      },
    ],
    general: [
      'General',
      function (c) {
        var ui = c.ui;
        var up = state.uptime;
        var preset = state.options.search.filter(function (x) {
          return x.url === ui.search;
        })[0];
        var custom = !preset || extra.searchCustom;
        var r = [
          seg('Theme', 'ui.theme', [
            ['auto', 'Auto'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]),
          row(
            'Search',
            dropdown({
              options: state.options.search
                .map(function (x) {
                  return [x.url, x.label];
                })
                .concat([['custom', 'Custom']]),
              value: custom ? 'custom' : ui.search,
              key: 'ui.search',
              label: 'Search',
              onpick: function (v) {
                extra.searchCustom = v === 'custom';
                if (v !== 'custom') save('ui.search', v);
                render(true);
              },
            })
          ),
          custom ? txt('Address, with %s for the words', 'ui.search', 'https://…?q=%s', { col: true }) : null,
          area('Quick links', 'ui.links', 4, 'Name https://address'),
          h2('Stealth'),
          sel('Tab disguise', 'ui.cloak', [
            ['none', 'None'],
            ['docs', 'Document'],
            ['classroom', 'Classes'],
            ['drive', 'Files'],
            ['notes', 'Notes'],
            ['calculator', 'Calculator'],
            ['custom', 'Custom'],
          ]),
          ui.cloak === 'custom' ? txt('Title', 'ui.cloakTitle', 'New Tab') : null,
          row(
            'Panic key',
            el('div', { class: 'btns' }, [
              el('button', {
                class: 'btn keycap',
                'data-k': 'ui.panicKey',
                text: capturing ? 'Press a key' : ui.panicKey ? (ui.panicKey === ' ' ? 'Space' : ui.panicKey) : 'Set',
                onclick: function () {
                  if (capturing) {
                    capturing = null;
                    render(true);
                    return;
                  }
                  capturing = function (key) {
                    save('ui.panicKey', key);
                    render(true);
                  };
                  render(true);
                },
              }),
              ui.panicKey
                ? el('button', {
                    class: 'x',
                    title: 'Clear',
                    'aria-label': 'Clear the panic key',
                    text: '×',
                    onclick: function () {
                      save('ui.panicKey', '');
                      render(true);
                    },
                  })
                : null,
            ]),
            { hint: 'One press and the tab goes somewhere else.' }
          ),
          ui.panicKey ? txt('Goes to', 'ui.panicUrl', 'a blank page') : null,
          row('Blank-address tab', btn('Open', blankTab), { hint: 'Waddle in a tab whose address reads about:blank.' }),
          h2('Settings'),
          el('div', { class: 'btns' }, [
            btn('Reset everything', function () {
              extra = {};
              return api('config', { reset: true });
            }),
          ]),
          el('div', {
            class: 'hint',
            text: 'Running for ' + (up > 3600 ? Math.floor(up / 3600) + ' h ' : '') + Math.floor((up % 3600) / 60) + ' min',
          }),
        ];
        return r;
      },
    ],
  };

  function render(force) {
    if (!state) return;
    var tabs = $('#tabs');
    tabs.textContent = '';
    Object.keys(TABS).forEach(function (k) {
      tabs.appendChild(
        el('button', {
          class: k === tab ? 'on' : '',
          'aria-current': k === tab ? 'page' : null,
          text: TABS[k][0],
          onclick: function () {
            tab = k;
            render(true);
            $('#panel').scrollTop = 0;
          },
        })
      );
    });
    var panel = $('#panel');
    var active = document.activeElement;
    var inside = active && panel.contains(active);
    if (!force) {
      // A background refresh never yanks a field someone is typing in, or a list someone has open.
      if (openDD || capturing) return;
      if (inside && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
    }
    if (inside && /^(INPUT|TEXTAREA)$/.test(active.tagName)) active.blur(); // commits an edited setting before its field is replaced
    if (openDD) openDD.close();
    var back = inside ? active.getAttribute('data-k') : null;
    [].forEach.call(panel.querySelectorAll('input[id], textarea[id]'), function (x) {
      drafts[x.id] = x.value;
    });
    var top = panel.scrollTop;
    panel.textContent = '';
    TABS[tab][1](state.config).forEach(function (x) {
      if (x) panel.appendChild(x);
    });
    Object.keys(drafts).forEach(function (id) {
      var x = document.getElementById(id);
      if (x && panel.contains(x)) x.value = drafts[id];
    });
    panel.scrollTop = top;
    if (back) {
      // keep the keyboard where it was
      var again = [].filter.call(panel.querySelectorAll('[data-k]'), function (x) {
        return x.getAttribute('data-k') === back;
      })[0];
      if (!again && back.indexOf('=') > 0)
        again = [].filter.call(panel.querySelectorAll('[data-k]'), function (x) {
          return x.getAttribute('data-k').indexOf(back.slice(0, back.indexOf('=') + 1)) === 0 && x.classList.contains('on');
        })[0];
      if (again) again.focus({ preventScroll: true });
    }
  }
  function forget() {
    [].forEach.call(arguments, function (id) {
      delete drafts[id];
      var x = document.getElementById(id);
      if (x) x.value = '';
    });
  }
  function open(which) {
    if (which && TABS[which]) tab = which;
    $('#drawer').hidden = false;
    render(true);
    refresh();
  }
  $('#gear').addEventListener('click', function () {
    var d = $('#drawer');
    if (d.hidden) open();
    else d.hidden = true;
  });
  $('#route').addEventListener('click', function () {
    open(document.body.classList.contains('browsing') ? 'route' : 'proxies');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (openDD) openDD.close();
    else $('#drawer').hidden = true;
  });
  // Enter in a one-line "add" field presses the button next to it.
  $('#panel').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || !e.target.parentNode.classList.contains('add')) return;
    var b = e.target.parentNode.querySelector('.btn');
    if (b && !b.disabled) {
      e.preventDefault();
      b.click();
    }
  });

  // ---- start ----------------------------------------------------------------------
  function ready() {
    // The service worker keeps strays on the proxy and keeps other hosts' error pages out; Waddle works without it.
    var sw = Promise.resolve();
    try {
      if ('serviceWorker' in navigator) {
        sw = navigator.serviceWorker
          .getRegistrations()
          .then(function (list) {
            // an earlier version registered for /~/ only; one worker for the whole app replaces it
            return Promise.all(
              list.map(function (r) {
                return new URL(r.scope).pathname === P ? r.unregister() : null;
              })
            );
          })
          .catch(function () {})
          .then(function () {
            return navigator.serviceWorker.register('/-/sw.js', { scope: '/' });
          })
          .then(function (reg) {
            var w = reg.installing || reg.waiting;
            if (!w || reg.active) return null;
            return new Promise(function (done) {
              w.addEventListener('statechange', function () {
                if (w.state === 'activated' || w.state === 'redundant') done();
              });
            });
          })
          .catch(function () {});
      }
    } catch (e) {
      /* not allowed here */
    }
    return Promise.race([
      sw,
      new Promise(function (done) {
        setTimeout(done, 1500);
      }),
    ]);
  }
  function fromHash() {
    var raw = location.hash.slice(1);
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  }
  Promise.all([api('state').then(apply, function () {}), ready()]).then(function () {
    var h = fromHash();
    if (h) go(h);
  });
  window.addEventListener('hashchange', function () {
    var h = fromHash();
    if (h && h !== shown(current)) go(h);
    else if (!h && current) home();
  });
})();
