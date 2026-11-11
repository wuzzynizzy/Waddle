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
  var tab = 'route'; // active settings drawer tab
  var local = window.WaddleLocal;
  var frontend = local ? local.preferences() : {};
  var browserTabs = restoreBrowserTabs();
  var activeBrowserTabId = storedActiveTab();
  var libraryTab = 'bookmarks';
  var librarySearch = '';
  var libraryFolder = 'All';
  var inspectorView = 'requests';
  var inspectData = { requests: [], cookies: [] };
  var inspectRequestId = '';
  var suppressNextLocalVisit = false;
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

  // Browser tabs and their URL history are private to this browser. Site history, bookmarks and saved pages
  // live separately in WaddleLocal so New identity can erase history without erasing the library.
  var TAB_KEY = 'waddle.tabs.v1';
  var ACTIVE_TAB_KEY = 'waddle.active-tab.v1';
  function newTabRecord() {
    return { id: makeId(), url: '', title: 'New tab', history: [], index: -1, route: null };
  }
  function makeId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {
      /* unavailable */
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function restoreBrowserTabs() {
    var list = [];
    try {
      list = JSON.parse(localStorage.getItem(TAB_KEY) || '[]');
    } catch (e) {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    list = list.slice(0, 16).map(function (x) {
      var history = Array.isArray(x.history)
        ? x.history
            .slice(-100)
            .map(function (h) {
              var url = local ? local.cleanUrl(h && h.url) : '';
              return url ? { url: url, title: String((h && h.title) || url).slice(0, 200), at: Number((h && h.at) || Date.now()) } : null;
            })
            .filter(Boolean)
        : [];
      var url = local ? local.cleanUrl(x.url || '') : '';
      var index = Math.max(-1, Math.min(history.length - 1, Number(x.index)));
      return {
        id: String(x.id || makeId()),
        url: url,
        title: String(x.title || (url ? url.replace(/^https?:\/\//, '') : 'New tab')).slice(0, 200),
        history: history,
        index: index,
        route: x.route && typeof x.route === 'object' ? x.route : null,
      };
    });
    return list.length ? list : [newTabRecord()];
  }
  function storedActiveTab() {
    var id = '';
    try {
      id = localStorage.getItem(ACTIVE_TAB_KEY) || '';
    } catch (e) {
      /* storage unavailable */
    }
    return browserTabs.some(function (x) {
      return x.id === id;
    })
      ? id
      : browserTabs[0].id;
  }
  function activeBrowserTab() {
    return (
      browserTabs.filter(function (x) {
        return x.id === activeBrowserTabId;
      })[0] || browserTabs[0]
    );
  }
  function persistBrowserTabs() {
    try {
      localStorage.setItem(TAB_KEY, JSON.stringify(browserTabs));
      localStorage.setItem(ACTIVE_TAB_KEY, activeBrowserTabId);
    } catch (e) {
      /* storage unavailable */
    }
  }
  function tabRoute(tabInfo) {
    if (!tabInfo || !tabInfo.route) return null;
    return tabInfo.route;
  }
  function renderBrowserTabs() {
    var host = $('#tabbar');
    if (!host) return;
    host.textContent = '';
    browserTabs.forEach(function (t) {
      var group = el('div', { class: 'tabgroup' + (t.id === activeBrowserTabId ? ' active' : '') });
      var route = tabRoute(t);
      var tabButton = el(
        'button',
        {
          class: 'browser-tab',
          role: 'tab',
          'aria-selected': String(t.id === activeBrowserTabId),
          'aria-label': t.title || 'New tab',
          title: t.url || 'New tab',
          onclick: function () {
            switchBrowserTab(t.id);
          },
        },
        [el('i', { class: 'dot ' + (route ? (route.ok ? 'ok' : 'bad') : '') }), el('span', { text: t.title || 'New tab' })]
      );
      group.appendChild(tabButton);
      group.appendChild(
        el('button', {
          class: 'tab-close',
          title: 'Close tab',
          'aria-label': 'Close ' + (t.title || 'New tab'),
          text: '×',
          onclick: function (e) {
            e.stopPropagation();
            closeBrowserTab(t.id);
          },
        })
      );
      host.appendChild(group);
    });
    var active = activeBrowserTab();
    $('#back').disabled = !active || active.index < 0 || (active.url && active.index <= 0);
    $('#fwd').disabled = !active || active.index < 0 || active.index >= active.history.length - 1;
    host.appendChild(
      el('button', {
        id: 'newTab',
        class: 'new-tab',
        title: 'New tab (Ctrl+T)',
        'aria-label': 'New tab',
        text: '+',
        onclick: function () {
          createBrowserTab();
        },
      })
    );
  }
  function rememberTabUrl(url, title, mode) {
    var t = activeBrowserTab();
    if (!t) return;
    if (!url) {
      t.url = '';
      t.title = 'New tab';
      persistBrowserTabs();
      renderBrowserTabs();
      updateBookmarkButton();
      return;
    }
    url = local ? local.cleanUrl(url) : url;
    if (!url) return;
    mode = mode || 'push';
    var found = -1;
    if (mode === 'pop') {
      for (var i = t.history.length - 1; i >= 0; i--) {
        if (t.history[i].url === url) {
          found = i;
          break;
        }
      }
    }
    if (mode === 'pop' && found >= 0) t.index = found;
    else if (mode === 'replace' && t.index >= 0) {
      t.history[t.index] = { url: url, title: title || t.title || url, at: Date.now() };
    } else if (t.history[t.index] && t.history[t.index].url === url) {
      if (title) t.history[t.index].title = title;
    } else {
      t.history = t.history.slice(0, t.index + 1);
      t.history.push({ url: url, title: title || url, at: Date.now() });
      if (t.history.length > 100) t.history.shift();
      t.index = t.history.length - 1;
      if (local && mode !== 'pop') local.visit(url, title || url);
    }
    t.url = url;
    if (title) t.title = String(title).slice(0, 200);
    else if (!t.title || t.title === 'New tab') {
      try {
        t.title = new URL(url).hostname;
      } catch (e) {
        t.title = url;
      }
    }
    persistBrowserTabs();
    renderBrowserTabs();
    updateBookmarkButton();
    renderHomePicks();
  }
  function updateCurrentTitle(title) {
    var t = activeBrowserTab();
    if (!t || !current || !title) return;
    t.title = String(title).slice(0, 200);
    if (t.index >= 0 && t.history[t.index] && t.history[t.index].url === current) t.history[t.index].title = t.title;
    persistBrowserTabs();
    renderBrowserTabs();
    if (local) {
      if (suppressNextLocalVisit) suppressNextLocalVisit = false;
      else local.visit(current, t.title);
    }
    renderHomePicks();
  }
  function loadUrl(url) {
    loading(true);
    frame.src =
      url.indexOf(CHECK) === 0
        ? P + CHECK + '?' + Date.now().toString(36) + '#' + encodeURIComponent(JSON.stringify(realValues()))
        : P + url;
    addr.blur();
  }
  function createBrowserTab(url) {
    if (browserTabs.length >= 16) {
      toast('You can have up to 16 tabs open');
      return;
    }
    var t = newTabRecord();
    browserTabs.push(t);
    activeBrowserTabId = t.id;
    persistBrowserTabs();
    renderBrowserTabs();
    current = '';
    show('');
    frame.removeAttribute('src');
    try {
      frame.contentWindow.location.replace('about:blank');
    } catch (e) {
      /* gone */
    }
    loading(false);
    if ($('#drawer')) $('#drawer').hidden = true;
    if ($('#libraryPanel')) $('#libraryPanel').hidden = true;
    if (url) go(url);
    else {
      $('#q').value = '';
      $('#q').focus();
    }
    return t;
  }
  function switchBrowserTab(id) {
    if (id === activeBrowserTabId) return;
    var next = browserTabs.filter(function (x) {
      return x.id === id;
    })[0];
    if (!next) return;
    if (current) rememberTabUrl(current, activeBrowserTab().title, 'replace');
    activeBrowserTabId = id;
    persistBrowserTabs();
    renderBrowserTabs();
    current = next.url || '';
    show(current);
    setTitle(next.title === 'New tab' ? '' : next.title);
    if (current) loadUrl(current);
    else {
      frame.removeAttribute('src');
      try {
        frame.contentWindow.location.replace('about:blank');
      } catch (e) {
        /* gone */
      }
      loading(false);
      $('#q').focus();
    }
    updateBookmarkButton();
    if (!$('#libraryPanel').hidden && libraryTab === 'inspect') refreshInspector();
  }
  function closeBrowserTab(id) {
    var i = browserTabs.findIndex(function (x) {
      return x.id === id;
    });
    if (i < 0) return;
    var wasActive = id === activeBrowserTabId;
    browserTabs.splice(i, 1);
    if (!browserTabs.length) browserTabs.push(newTabRecord());
    if (wasActive) {
      var next = browserTabs[Math.min(i, browserTabs.length - 1)];
      activeBrowserTabId = next.id;
      persistBrowserTabs();
      current = next.url || '';
      renderBrowserTabs();
      show(current);
      setTitle(next.title === 'New tab' ? '' : next.title);
      if (current) loadUrl(current);
      else {
        frame.removeAttribute('src');
        try {
          frame.contentWindow.location.replace('about:blank');
        } catch (e) {
          /* gone */
        }
        loading(false);
      }
    } else {
      persistBrowserTabs();
      renderBrowserTabs();
    }
    updateBookmarkButton();
  }
  function tabBack() {
    var t = activeBrowserTab();
    if (!t) return;
    var i = t.index;
    if (i < 0) return;
    if (current && i > 0) i--;
    t.index = i;
    var item = t.history[i];
    if (!item) return;
    t.url = item.url;
    t.title = item.title;
    persistBrowserTabs();
    show(item.url);
    setTitle(item.title);
    loadUrl(item.url);
  }
  function tabForward() {
    var t = activeBrowserTab();
    if (!t || t.index < 0 || t.index >= t.history.length - 1) return;
    t.index++;
    var item = t.history[t.index];
    t.url = item.url;
    t.title = item.title;
    persistBrowserTabs();
    show(item.url);
    setTitle(item.title);
    loadUrl(item.url);
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
  function go(text, options) {
    options = options || {};
    var url = resolve(text);
    if (!url) return;
    if (options.newTab) createBrowserTab();
    var mode = options.mode || 'push';
    rememberTabUrl(url, '', mode);
    show(url);
    setTitle('');
    loadUrl(url);
    if ($('#libraryPanel') && !$('#libraryPanel').hidden && libraryTab === 'inspect') refreshInspector();
  }
  function home() {
    current = '';
    rememberTabUrl('', '', 'replace');
    show('');
    setTitle('');
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
      if (current.indexOf(CHECK) === 0) go(CHECK_NAME, { mode: 'replace' });
      else frame.contentWindow.location.reload();
    } catch (e) {
      loadUrl(current);
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
    closeSuggestions();
    go(addr.value);
  });
  $('#start').addEventListener('submit', function (e) {
    e.preventDefault();
    closeSuggestions();
    go($('#q').value);
  });
  addr.addEventListener('focus', function () {
    addr.select();
    showSuggestions(addr.value, 'address');
  });
  $('#home').addEventListener('click', home);
  $('#back').addEventListener('click', tabBack);
  $('#fwd').addEventListener('click', tabForward);
  $('#reload').addEventListener('click', reload);
  $('#rotate').addEventListener('click', function () {
    rotate().catch(function () {});
  });
  $('#bookmark').addEventListener('click', toggleCurrentBookmark);
  $('#library').addEventListener('click', function () {
    openLibrary('bookmarks');
  });
  $('#libraryClose').addEventListener('click', function () {
    $('#libraryPanel').hidden = true;
  });
  frame.addEventListener('load', function () {
    loading(false);
    refresh();
    try {
      var w = frame.contentWindow;
      w.addEventListener('keydown', onKey, true); // panic and browser shortcuts work while a page has focus too
      // pages without the page script (errors, downloads) still report where they are
      var href = w.location.href;
      var at = href.indexOf(P);
      if (at >= 0 && href.indexOf(location.origin) === 0) {
        var real = href.slice(at + P.length).replace(/^f\/(?=https?:\/)/i, '');
        current = real.indexOf(CHECK) === 0 ? CHECK : real;
        rememberTabUrl(current, w.document.title || '', 'push');
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
    if (m.kind === 'open') {
      createBrowserTab(m.url || '');
      return;
    }
    if (m.kind === 'leave') {
      loading(true);
      return;
    }
    if (m.url) {
      current = m.url.indexOf(CHECK) === 0 ? CHECK : m.url;
      var historyMode = m.kind === 'replace' ? 'replace' : m.kind === 'pop' ? 'pop' : 'push';
      rememberTabUrl(current, m.title || '', historyMode);
      if (document.activeElement !== addr) addr.value = shown(current);
      setLock(current);
      try {
        history.replaceState(null, '', '#' + shown(current));
      } catch (err) {
        /* sandboxed */
      }
      if (!$('#libraryPanel').hidden && libraryTab === 'inspect') refreshInspector();
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
    if (pageTitle) updateCurrentTitle(pageTitle);
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
  function handleBrowserShortcut(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      tabBack();
      return true;
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      tabForward();
      return true;
    }
    if (!mod || e.altKey) return false;
    var key = String(e.key || '').toLowerCase();
    if (key === 't') createBrowserTab();
    else if (key === 'w') closeBrowserTab(activeBrowserTabId);
    else if (key === 'l') {
      if (!document.body.classList.contains('browsing')) show('');
      addr.focus();
      addr.select();
    } else if (key === 'd') toggleCurrentBookmark();
    else if (key === 'i' && e.shiftKey) openLibrary('inspect');
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
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
      return;
    }
    handleBrowserShortcut(e);
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
      var keep = ['waddle.theme', local && local.keys.library, local && local.keys.preferences].filter(Boolean);
      var saved = {};
      keep.forEach(function (key) {
        var value = localStorage.getItem(key);
        if (value != null) saved[key] = value;
      });
      localStorage.clear();
      Object.keys(saved).forEach(function (key) {
        localStorage.setItem(key, saved[key]);
      });
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
      if (local) local.clearHistory();
      var active = activeBrowserTab();
      browserTabs = [active || newTabRecord()];
      activeBrowserTabId = browserTabs[0].id;
      browserTabs[0].history = current ? [{ url: current, title: pageTitle || current, at: Date.now() }] : [];
      browserTabs[0].index = current ? 0 : -1;
      browserTabs[0].url = current;
      browserTabs[0].title = current ? pageTitle || current : 'New tab';
      browserTabs[0].route = null;
      persistBrowserTabs();
      renderBrowserTabs();
      extra = {};
      suppressNextLocalVisit = !!current;
      apply(s, true);
      renderHomePicks();
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
    var tabInfo = activeBrowserTab();
    if (browsing && last && tabInfo && new URL(current).host === last.host) {
      tabInfo.route = { ok: !last.error, label: hops(last), host: last.host, at: last.at, detail: last.detail || last.error || '' };
      persistBrowserTabs();
      renderBrowserTabs();
    }
    var routeInfo = browsing && tabInfo && tabInfo.route ? tabInfo.route : null;
    var matchingLast =
      browsing &&
      last &&
      (function () {
        try {
          return new URL(current).host === last.host;
        } catch (e) {
          return false;
        }
      })()
        ? last
        : null;
    $('#route i').className =
      'dot ' + (routeInfo ? (routeInfo.ok ? 'ok' : 'bad') : matchingLast ? (matchingLast.error ? 'bad' : 'ok') : health[0]);
    $('#route span').textContent =
      browsing && routeInfo
        ? routeInfo.label
        : browsing && matchingLast
          ? hops(matchingLast)
          : p.alive
            ? p.alive + (p.alive === 1 ? ' proxy' : ' proxies')
            : health[1];
    $('#route').title =
      routeInfo && routeInfo.detail
        ? routeInfo.detail
        : matchingLast && matchingLast.error && matchingLast.detail
          ? matchingLast.detail
          : 'Route';

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
    links.hidden = !links.firstChild || !frontend.showLinks;
    links.style.setProperty('--n', String(Math.min(4, links.childNodes.length || 1)));
    $('#chips').hidden = !frontend.showStatus;

    setTheme(c.ui.theme);
    applyFrontendPrefs();
    renderHomePicks();
    dress();
    if (!$('#drawer').hidden) render(force);
  }
  function applyFrontendPrefs() {
    if (!local) return;
    frontend = local.preferences();
    var root = document.documentElement;
    root.setAttribute('data-accent', frontend.accent);
    root.setAttribute('data-density', frontend.density);
    root.setAttribute('data-text-size', frontend.textSize);
    document.body.setAttribute('data-tab-position', frontend.tabPosition);
    var color = local.accentColors[frontend.accent] || local.accentColors.orange;
    root.style.setProperty('--accent', color);
    $('#links').hidden = !frontend.showLinks || !$('#links').firstChild;
    $('#chips').hidden = !frontend.showStatus;
    renderBrowserTabs();
  }
  function renderHomePicks() {
    var section = $('#homePicks');
    var host = $('#homePickList');
    if (!section || !host || !local) return;
    var items = local.suggestions('', browserTabs).filter(function (x) {
      return x.url !== current;
    });
    host.textContent = '';
    if (!frontend.showRecommendations || !items.length) {
      section.hidden = true;
      return;
    }
    items.slice(0, 4).forEach(function (item) {
      host.appendChild(
        el(
          'button',
          {
            class: 'pick',
            title: item.url,
            onclick: function () {
              go(item.url);
            },
          },
          [
            el('span', { class: 'pick-kind', text: item.kind }),
            el('b', { text: item.title || item.url }),
            el('small', { text: item.url.replace(/^https?:\/\//, '') }),
          ]
        )
      );
    });
    section.hidden = !host.firstChild;
  }
  var externalTimer = 0;
  var externalAbort = null;
  function closeSuggestions() {
    $('#suggestions').hidden = true;
    $('#addressSuggestions').hidden = true;
    clearTimeout(externalTimer);
    if (externalAbort) externalAbort.abort();
    externalAbort = null;
  }
  function fillSuggestions(panel, query, external) {
    panel.textContent = '';
    var localItems = local ? local.suggestions(query, browserTabs) : [];
    if (localItems.length) {
      panel.appendChild(el('div', { class: 'suggest-heading', text: query ? 'From this browser' : 'Suggestions from this browser' }));
      localItems.slice(0, 6).forEach(function (item) {
        var u = item.url;
        panel.appendChild(
          el(
            'button',
            {
              class: 'suggest-item',
              role: 'option',
              onclick: function () {
                closeSuggestions();
                go(u);
              },
            },
            [
              el('span', { class: 'suggest-title', text: item.title || u }),
              el('small', { text: item.kind + ' · ' + u.replace(/^https?:\/\//, '') }),
            ]
          )
        );
      });
    }
    if (external && external.length) {
      panel.appendChild(el('div', { class: 'suggest-heading', text: 'Web suggestions · DuckDuckGo' }));
      external.slice(0, 5).forEach(function (item) {
        panel.appendChild(
          el(
            'button',
            {
              class: 'suggest-item',
              role: 'option',
              onclick: function () {
                closeSuggestions();
                go(item);
              },
            },
            [el('span', { class: 'suggest-title', text: item }), el('small', { text: 'Search through your selected search engine' })]
          )
        );
      });
    }
    panel.hidden = panel.childNodes.length === 0;
  }
  function showSuggestions(query, where) {
    if (!local) return;
    var panel = where === 'address' ? $('#addressSuggestions') : $('#suggestions');
    var other = where === 'address' ? $('#suggestions') : $('#addressSuggestions');
    other.hidden = true;
    var text = String(query || '').trim();
    fillSuggestions(panel, text, []);
    if (!frontend.externalSuggestions || text.length < 3) return;
    clearTimeout(externalTimer);
    if (externalAbort) externalAbort.abort();
    externalTimer = setTimeout(function () {
      try {
        externalAbort = new AbortController();
        var endpoint = P + 'https://duckduckgo.com/ac/?q=' + encodeURIComponent(text) + '&type=list';
        fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: externalAbort.signal })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var input = where === 'address' ? addr : $('#q');
            if (input.value.trim() !== text) return;
            var terms = Array.isArray(data)
              ? data
                  .map(function (x) {
                    return String(x.phrase || '');
                  })
                  .filter(Boolean)
              : [];
            fillSuggestions(panel, text, terms);
          })
          .catch(function () {});
      } catch (e) {
        /* suggestions are optional */
      }
    }, 450);
  }
  $('#q').addEventListener('focus', function () {
    showSuggestions($('#q').value, 'home');
  });
  $('#q').addEventListener('input', function () {
    showSuggestions($('#q').value, 'home');
  });
  addr.addEventListener('input', function () {
    showSuggestions(addr.value, 'address');
  });
  document.addEventListener('pointerdown', function (e) {
    if (!$('#searchBox').contains(e.target) && !$('#nav').contains(e.target)) closeSuggestions();
  });

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
          if (!$('#libraryPanel').hidden && libraryTab === 'inspect') refreshInspector();
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
        min: o && o.min != null ? o.min : undefined,
        max: o && o.max != null ? o.max : undefined,
        step: o && o.step != null ? o.step : undefined,
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
  function setFrontendPreference(key, value) {
    if (!local) return;
    var patch = {};
    patch[key] = value;
    frontend = local.savePreferences(patch);
    applyFrontendPrefs();
    renderHomePicks();
    if (!$('#drawer').hidden) render(true);
  }
  function localSel(label, key, opts) {
    return row(
      label,
      dropdown({
        options: opts,
        value: frontend[key],
        key: 'local.' + key,
        label: label,
        onpick: function (value) {
          setFrontendPreference(key, value);
        },
      })
    );
  }
  function localToggle(label, key, hint) {
    var on = !!frontend[key];
    return row(
      label,
      el('button', {
        class: 'sw' + (on ? ' on' : ''),
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': label,
        'data-k': 'local.' + key,
        onclick: function () {
          setFrontendPreference(key, !on);
        },
      }),
      { hint: hint }
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
          num('Proxy hops', 'route.hops', 1, {
            min: 1,
            max: state.options.maxHops,
            hint: 'Up to ' + state.options.maxHops + ' chained exits; longer routes are slower and less reliable.',
          }),
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
            placeholder: 'socks5://203.0.113.9:1080\n198.51.100.7:8080',
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
          num('Keep live', 'pool.target', 1, {
            min: 1,
            max: state.options.profile === 'small' ? 80 : 2000,
            hint: 'Pool size budget for the ' + state.options.profile + ' server profile.',
          }),
          num('Every (min)', 'pool.harvestMinutes', 1, { min: 5, max: 1440 }),
          num('Recheck (min)', 'pool.recheckMinutes', 1, { min: 1, max: 120 }),
          num('Test timeout (s)', 'pool.checkTimeout', 1000, { min: 1.5, max: 30, step: 0.5 }),
          num('Tests at once', 'pool.concurrency', 1, {
            min: 1,
            max: state.options.profile === 'small' ? 32 : 400,
          }),
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
            c.dns.strategy === 'race' || c.dns.strategy === 'check' ? num('Ask at once', 'dns.parallel', 1, { min: 2, max: 16 }) : null,
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
          c.dns.auto ? num('Keep', 'dns.keep', 1, { min: 0, max: 128 }) : null,
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
                // Before a page has been opened there is no exit yet, so nothing to take a language or a time zone from.
                [
                  s.languages === 'exit' && !id.cc
                    ? s.timezone === 'exit'
                      ? 'Language and time zone of the exit'
                      : 'Language of the exit'
                    : (id.languages || [])[0],
                  s.timezone === 'exit' && !id.cc ? (s.languages === 'exit' ? '' : 'Time zone of the exit') : id.tz,
                  id.screen,
                  id.cores ? id.cores + ' cores' : '',
                  id.gpu,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'As your browser reports it',
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
        var backupInput = el('input', {
          type: 'file',
          accept: '.json,application/json',
          class: 'visually-hidden',
          'aria-label': 'Restore a Waddle backup',
          onchange: function (e) {
            importMigrationBackup(e.target.files && e.target.files[0]);
            e.target.value = '';
          },
        });
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
          h2('Appearance'),
          localSel('Accent colour', 'accent', [
            ['orange', 'Orange'],
            ['blue', 'Blue'],
            ['violet', 'Violet'],
            ['teal', 'Teal'],
            ['rose', 'Rose'],
          ]),
          localSel('Interface density', 'density', [
            ['comfortable', 'Comfortable'],
            ['compact', 'Compact'],
            ['spacious', 'Spacious'],
          ]),
          localSel('Text size', 'textSize', [
            ['small', 'Small'],
            ['normal', 'Normal'],
            ['large', 'Large'],
          ]),
          localSel('Tab strip position', 'tabPosition', [
            ['top', 'Below the toolbar'],
            ['bottom', 'Below the page'],
          ]),
          h2('Start page'),
          localToggle('Show quick links', 'showLinks'),
          localToggle('Show local recommendations', 'showRecommendations'),
          localToggle('Show status chips', 'showStatus'),
          localToggle(
            'DuckDuckGo web suggestions',
            'externalSuggestions',
            'Off by default. When on, typed searches go through your current proxy exit.'
          ),
          h2('Your pages'),
          el('div', { class: 'btns' }, [
            btn('Bookmark page', toggleCurrentBookmark),
            btn('Open library', function () {
              openLibrary('bookmarks');
            }),
            btn('Inspect page', function () {
              openLibrary('inspect');
            }),
            btn('Reset frontend settings', function () {
              frontend = local.savePreferences({
                accent: 'orange',
                density: 'comfortable',
                textSize: 'normal',
                tabPosition: 'top',
                showLinks: true,
                showRecommendations: true,
                showStatus: true,
                externalSuggestions: false,
              });
              applyFrontendPrefs();
              renderHomePicks();
            }),
          ]),
          h2('Backup & migration'),
          el('div', {
            class: 'hint',
            text: 'One versioned file moves server settings and sources plus this browser’s bookmarks, saved pages, history, tabs and appearance. Session cookies, request logs and the live proxy cache are not included. Treat the backup as private.',
          }),
          el('div', { class: 'btns' }, [
            btn('Export full backup', exportMigrationBackup),
            btn('Restore backup', function () {
              backupInput.click();
            }),
          ]),
          backupInput,
          h2('Keyboard shortcuts'),
          el('div', {
            class: 'hint',
            text: 'Ctrl+T new tab · Ctrl+W close tab · Ctrl+L address · Ctrl+Shift+I inspect · Ctrl+D bookmark · Alt+←/→ back or forward.',
          }),
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

  function updateBookmarkButton() {
    var button = $('#bookmark');
    if (!button || !local) return;
    var yes =
      !!current &&
      local.get().bookmarks.some(function (x) {
        return x.url === local.cleanUrl(current);
      });
    button.classList.toggle('saved', yes);
    button.setAttribute('aria-pressed', String(yes));
    button.title = yes ? 'Remove bookmark' : 'Bookmark this page';
    button.setAttribute('aria-label', button.title);
  }
  function toggleCurrentBookmark() {
    if (!current || !local) {
      toast('Open a page to bookmark it');
      return;
    }
    var result = local.toggleBookmark(current, pageTitle || current);
    updateBookmarkButton();
    renderHomePicks();
    if (!$('#libraryPanel').hidden && libraryTab === 'bookmarks') renderLibrary();
    toast(result.added ? 'Bookmark added' : 'Bookmark removed');
  }
  var LIBRARY_TABS = { bookmarks: 'Bookmarks', saved: 'Saved', history: 'History', inspect: 'Inspect' };
  function openLibrary(which) {
    if (which && LIBRARY_TABS[which]) libraryTab = which;
    $('#drawer').hidden = true;
    $('#libraryPanel').hidden = false;
    renderLibrary();
    if (libraryTab === 'inspect') refreshInspector();
  }
  function renderLibrary() {
    var tabs = $('#libraryTabs');
    tabs.textContent = '';
    Object.keys(LIBRARY_TABS).forEach(function (key) {
      tabs.appendChild(
        el('button', {
          role: 'tab',
          class: libraryTab === key ? 'on' : '',
          'aria-selected': String(libraryTab === key),
          text: LIBRARY_TABS[key],
          onclick: function () {
            libraryTab = key;
            librarySearch = '';
            inspectorView = 'requests';
            renderLibrary();
            if (key === 'inspect') refreshInspector();
          },
        })
      );
    });
    var content = $('#libraryContent');
    content.textContent = '';
    if (libraryTab === 'bookmarks') renderBookmarks(content);
    else if (libraryTab === 'saved') renderSaved(content);
    else if (libraryTab === 'history') renderHistory(content);
    else renderInspector(content);
  }
  function libraryToolbar(currentButton) {
    var buttons = [];
    if (current) {
      buttons.push(el('button', { class: 'btn pri', text: 'Bookmark page', onclick: toggleCurrentBookmark }));
      buttons.push(
        el('button', {
          class: 'btn',
          text: 'Save for later',
          onclick: function () {
            var item = local.saveForLater(current, pageTitle || current);
            if (!item) return toast('This address cannot be saved');
            renderHomePicks();
            renderLibrary();
            toast('Saved for later');
          },
        })
      );
    }
    if (currentButton) buttons.push(currentButton);
    return el('div', { class: 'library-actions' }, buttons);
  }
  function downloadLocal(name, text, type) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: type }));
      var a = el('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      toast('Download is unavailable in this browser');
    }
  }
  function importBookmarkFile(file) {
    if (!file || !local) return;
    file
      .text()
      .then(function (text) {
        var incoming;
        try {
          incoming = JSON.parse(text);
          if (Array.isArray(incoming)) incoming = { bookmarks: incoming };
        } catch (e) {
          var parsed = new DOMParser().parseFromString(text, 'text/html');
          var bookmarks = [].map.call(parsed.querySelectorAll('a[href]'), function (a) {
            return { url: a.href, title: a.textContent.trim() || a.href, folder: 'Imported' };
          });
          incoming = { folders: ['Imported'], bookmarks: bookmarks };
        }
        var count = local.importBookmarks(incoming);
        librarySearch = '';
        libraryFolder = 'All';
        renderLibrary();
        renderHomePicks();
        toast(count + ' bookmark' + (count === 1 ? '' : 's') + ' imported');
      })
      .catch(function () {
        toast('Could not read that bookmarks file');
      });
  }
  function portableTabs(value) {
    if (!Array.isArray(value)) return [newTabRecord()];
    var tabs = value.slice(0, 16).map(function (item) {
      item = item && typeof item === 'object' ? item : {};
      var history = (Array.isArray(item.history) ? item.history : [])
        .slice(-100)
        .map(function (entry) {
          var url = local.cleanUrl(entry && entry.url);
          return url ? { url: url, title: String((entry && entry.title) || url).slice(0, 200), at: Number(entry.at) || Date.now() } : null;
        })
        .filter(Boolean);
      var url = local.cleanUrl(item.url || '');
      var index = Number(item.index);
      return {
        id: String(item.id || makeId()).slice(0, 80),
        url: url,
        title: String(item.title || (url ? url.replace(/^https?:\/\//, '') : 'New tab')).slice(0, 200),
        history: history,
        index: Number.isFinite(index) ? Math.max(-1, Math.min(history.length - 1, index)) : -1,
        route: null,
      };
    });
    return tabs.length ? tabs : [newTabRecord()];
  }
  function exportMigrationBackup() {
    return api('backup')
      .then(function (backup) {
        backup.browser = local.exportState();
        backup.tabs = browserTabs.map(function (item) {
          return {
            id: item.id,
            url: item.url,
            title: item.title,
            history: item.history,
            index: item.index,
          };
        });
        backup.activeTabId = activeBrowserTabId;
        var date = new Date().toISOString().slice(0, 10);
        downloadLocal('waddle-backup-' + date + '.json', JSON.stringify(backup, null, 2), 'application/json');
        toast('Full backup downloaded — keep it somewhere private');
      })
      .catch(function () {
        toast('Could not create a backup');
      });
  }
  function importMigrationBackup(file) {
    if (!file || !local) return;
    file
      .text()
      .then(function (text) {
        var incoming;
        try {
          incoming = JSON.parse(text);
        } catch (error) {
          throw new Error('That file is not valid JSON');
        }
        if (
          !incoming ||
          incoming.format !== 'waddle-backup' ||
          incoming.version !== 1 ||
          !incoming.config ||
          typeof incoming.config !== 'object' ||
          Array.isArray(incoming.config)
        )
          throw new Error('This is not a supported Waddle backup');
        if (
          !window.confirm(
            'Restore this Waddle backup? It replaces server settings and this browser’s library, tabs and appearance preferences. The file can include private browsing history.'
          )
        )
          return;
        var beforeLocal = local.exportState();
        var beforeTabs = localStorage.getItem(TAB_KEY);
        var beforeActive = localStorage.getItem(ACTIVE_TAB_KEY);
        var restoreTabs = Array.isArray(incoming.tabs);
        var tabs = restoreTabs ? portableTabs(incoming.tabs) : null;
        var nextActive = tabs
          ? tabs.some(function (item) {
              return item.id === incoming.activeTabId;
            })
            ? incoming.activeTabId
            : tabs[0].id
          : activeBrowserTabId;
        var rollback = function () {
          if (incoming.browser) local.importState(beforeLocal);
          try {
            if (beforeTabs == null) localStorage.removeItem(TAB_KEY);
            else localStorage.setItem(TAB_KEY, beforeTabs);
            if (beforeActive == null) localStorage.removeItem(ACTIVE_TAB_KEY);
            else localStorage.setItem(ACTIVE_TAB_KEY, beforeActive);
          } catch (error) {
            /* best effort rollback */
          }
        };
        try {
          if (incoming.browser && !local.importState(incoming.browser)) throw new Error('Browser storage is full; nothing was changed.');
          if (tabs) {
            localStorage.setItem(TAB_KEY, JSON.stringify(tabs));
            localStorage.setItem(ACTIVE_TAB_KEY, nextActive);
          }
        } catch (error) {
          rollback();
          throw error;
        }
        api('backup', { format: incoming.format, version: incoming.version, config: incoming.config })
          .then(function (s) {
            activeBrowserTabId = nextActive;
            apply(s, true);
            toast('Backup restored — reopening Waddle…');
            setTimeout(function () {
              location.reload();
            }, 450);
          })
          .catch(function () {
            rollback();
            toast('Restore failed — your existing browser data was kept');
          });
      })
      .catch(function (error) {
        toast(error && error.message ? error.message : 'Could not read that backup');
      });
  }
  function librarySearchInput(label) {
    var input = el('input', {
      class: 'library-search',
      type: 'search',
      placeholder: 'Search ' + label.toLowerCase(),
      'aria-label': 'Search ' + label.toLowerCase(),
      value: librarySearch,
      oninput: function (e) {
        librarySearch = e.target.value;
        fillLibraryItems();
      },
    });
    return input;
  }
  function renderBookmarks(content) {
    var data = local.get();
    var importInput = el('input', {
      type: 'file',
      accept: '.json,.html,.htm,application/json,text/html',
      class: 'visually-hidden',
      'aria-label': 'Import bookmarks',
      onchange: function (e) {
        importBookmarkFile(e.target.files && e.target.files[0]);
      },
    });
    var toolbar = libraryToolbar(
      el('div', { class: 'btns' }, [
        el('button', {
          class: 'btn',
          text: 'Export JSON',
          onclick: function () {
            downloadLocal('waddle-bookmarks.json', JSON.stringify(local.exportBookmarks(), null, 2), 'application/json');
          },
        }),
        el('button', {
          class: 'btn',
          text: 'Import',
          onclick: function () {
            importInput.click();
          },
        }),
      ])
    );
    content.appendChild(toolbar);
    content.appendChild(importInput);
    content.appendChild(
      el('div', {
        class: 'hint',
        text: 'Bookmarks are kept only in this browser. Import accepts Waddle JSON or a browser bookmarks HTML file.',
      })
    );
    var folderRow = el('div', { class: 'folder-tools' });
    folderRow.appendChild(
      el('input', { id: 'newFolder', type: 'text', maxlength: 48, placeholder: 'New folder', 'aria-label': 'New folder' })
    );
    folderRow.appendChild(
      el('button', {
        class: 'btn',
        text: 'Add folder',
        onclick: function () {
          var input = $('#newFolder');
          if (!local.addFolder(input.value)) return toast('Enter a new folder name');
          libraryFolder = input.value.trim();
          renderLibrary();
        },
      })
    );
    content.appendChild(folderRow);
    var filter = el('div', { class: 'library-filters' }, [librarySearchInput('Bookmarks')]);
    var folder = el(
      'select',
      {
        class: 'library-select',
        'aria-label': 'Filter bookmarks by folder',
        onchange: function (e) {
          libraryFolder = e.target.value;
          fillLibraryItems();
        },
      },
      [el('option', { value: 'All', text: 'All folders' })]
    );
    data.folders.forEach(function (name) {
      folder.appendChild(el('option', { value: name, text: name }));
    });
    folder.value = data.folders.indexOf(libraryFolder) >= 0 ? libraryFolder : 'All';
    filter.appendChild(folder);
    content.appendChild(filter);
    content.appendChild(el('div', { id: 'libraryItems', class: 'library-items' }));
    fillLibraryItems();
  }
  function libraryCard(item, type) {
    var card = el('div', { class: 'library-entry' });
    card.appendChild(
      el('div', { class: 'library-entry-main' }, [
        el('strong', { text: item.title || item.url }),
        el('small', { class: 'mono', text: item.url }),
        type === 'history' ? el('small', { class: 'dim', text: ago(item.at) }) : null,
      ])
    );
    var actions = el('div', { class: 'library-entry-actions' });
    actions.appendChild(
      el('button', {
        class: 'btn',
        text: 'Open',
        onclick: function () {
          $('#libraryPanel').hidden = true;
          go(item.url);
        },
      })
    );
    if (type === 'bookmark') {
      var data = local.get();
      var move = el(
        'select',
        {
          class: 'library-select folder-select',
          'aria-label': 'Move to folder',
          onchange: function (e) {
            local.moveBookmark(item.id, e.target.value);
            fillLibraryItems();
          },
        },
        data.folders.map(function (name) {
          return el('option', { value: name, text: name });
        })
      );
      move.value = item.folder || 'Unsorted';
      actions.appendChild(move);
    }
    if (type !== 'recommendation')
      actions.appendChild(
        el('button', {
          class: 'x',
          title: 'Remove',
          'aria-label': 'Remove ' + item.title,
          text: '×',
          onclick: function () {
            local.remove(type === 'bookmark' ? 'bookmarks' : type === 'saved' ? 'saved' : 'history', item.id);
            renderLibrary();
            renderHomePicks();
            updateBookmarkButton();
          },
        })
      );
    card.appendChild(actions);
    return card;
  }
  function fillLibraryItems() {
    var host = $('#libraryItems');
    if (!host || !local) return;
    host.textContent = '';
    var data = local.get();
    var q = String(librarySearch || '')
      .trim()
      .toLowerCase();
    var items = libraryTab === 'bookmarks' ? data.bookmarks : libraryTab === 'saved' ? data.saved : data.history;
    items = items.filter(function (x) {
      return (
        (!q || (x.title + ' ' + x.url + ' ' + (x.folder || '')).toLowerCase().indexOf(q) >= 0) &&
        (libraryTab !== 'bookmarks' || libraryFolder === 'All' || x.folder === libraryFolder)
      );
    });
    if (!items.length) {
      host.appendChild(
        el('div', {
          class: 'empty-note',
          text: librarySearch
            ? 'No matches.'
            : libraryTab === 'bookmarks'
              ? 'No bookmarks yet. Open a page and click the star.'
              : libraryTab === 'saved'
                ? 'Nothing saved for later yet.'
                : 'Visited pages will appear here.',
        })
      );
      return;
    }
    if (libraryTab === 'bookmarks' && libraryFolder === 'All') {
      data.folders.forEach(function (folder) {
        var group = items.filter(function (x) {
          return (x.folder || 'Unsorted') === folder;
        });
        if (!group.length) return;
        host.appendChild(el('h3', { class: 'library-folder-title', text: folder }));
        group.forEach(function (item) {
          host.appendChild(libraryCard(item, 'bookmark'));
        });
      });
    } else
      items.forEach(function (item) {
        host.appendChild(libraryCard(item, libraryTab === 'bookmarks' ? 'bookmark' : libraryTab));
      });
  }
  function renderSaved(content) {
    content.appendChild(libraryToolbar());
    content.appendChild(
      el('div', { class: 'hint', text: 'Read-later addresses are saved in this browser; pages are not downloaded for offline reading.' })
    );
    content.appendChild(librarySearchInput('Saved pages'));
    content.appendChild(el('div', { id: 'libraryItems', class: 'library-items' }));
    fillLibraryItems();
  }
  function renderHistory(content) {
    content.appendChild(
      el('div', { class: 'library-actions' }, [
        el('button', {
          class: 'btn',
          text: 'Clear history',
          onclick: function () {
            local.clearHistory();
            librarySearch = '';
            renderLibrary();
            renderHomePicks();
            toast('History cleared');
          },
        }),
      ])
    );
    content.appendChild(el('div', { class: 'hint', text: 'Searches and visits stay in this browser. New identity clears this history.' }));
    content.appendChild(librarySearchInput('History'));
    content.appendChild(el('div', { id: 'libraryItems', class: 'library-items' }));
    fillLibraryItems();
  }
  function humanBytes(value) {
    var n = Number(value || 0);
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function inspectorEntry(request) {
    var route = (request.route || [])
      .map(function (h) {
        return (h.cc || h.proto) + ' · ' + h.addr;
      })
      .join(' › ');
    var stateText = request.blocked ? request.blocked : request.status == null ? '—' : String(request.status);
    if (request.waddleStatus != null && request.waddleStatus !== request.status) stateText += ' → ' + request.waddleStatus + ' in Waddle';
    return el(
      'button',
      {
        class: 'inspect-request' + (request.id === inspectRequestId ? ' selected' : ''),
        onclick: function () {
          inspectRequestId = request.id;
          renderInspectorPanel();
        },
      },
      [
        el('span', { class: 'inspect-status' + (request.blocked ? ' bad' : request.status >= 400 ? ' warn' : ''), text: stateText }),
        el('span', { class: 'inspect-address' }, [
          el('b', { text: request.method + ' · ' + request.type }),
          el('small', { text: request.url }),
        ]),
        el('span', { class: 'inspect-meta', text: humanBytes(request.bytes) + ' · ' + (request.ms || 0) + ' ms' }),
        el('small', { class: 'inspect-route', text: route || request.error || 'No proxy route' }),
      ]
    );
  }
  function inspectorDetails(request) {
    if (!request) return el('div', { class: 'empty-note', text: 'Open a page to inspect its requests.' });
    var details = el('div', { class: 'inspect-details' });
    [
      ['Address', request.url],
      ['Method', request.method],
      ['Type', request.type],
      ['Site status', request.status == null ? 'Not reached' : String(request.status)],
      ['Waddle status', request.waddleStatus == null ? '—' : String(request.waddleStatus)],
      ['Transferred', humanBytes(request.bytes)],
      ['Shown to browser', humanBytes(request.servedBytes)],
      ['Time', (request.ms || 0) + ' ms'],
      [
        'Route',
        (request.route || [])
          .map(function (h) {
            return (h.cc || h.proto) + ' · ' + h.addr;
          })
          .join(' › ') || 'No proxy route',
      ],
      ['Result', request.blocked || request.error || 'OK'],
    ].forEach(function (pair) {
      details.appendChild(el('div', { class: 'inspect-detail' }, [el('span', { text: pair[0] }), el('b', { text: pair[1] || '—' })]));
    });
    return details;
  }
  function inspectorHeaders(request) {
    if (!request || !request.headers || !Object.keys(request.headers).length)
      return el('div', { class: 'empty-note', text: 'No response headers were captured for this request.' });
    var list = el('div', { class: 'inspect-headers' });
    Object.keys(request.headers).forEach(function (name) {
      list.appendChild(el('div', { class: 'inspect-header' }, [el('code', { text: name }), el('span', { text: request.headers[name] })]));
    });
    return list;
  }
  function renderInspector(content) {
    var tabs = el('div', { class: 'inspect-tabs', role: 'tablist' });
    [
      ['requests', 'Requests'],
      ['headers', 'Headers'],
      ['cookies', 'Cookies'],
      ['source', 'Source'],
    ].forEach(function (pair) {
      tabs.appendChild(
        el('button', {
          role: 'tab',
          class: inspectorView === pair[0] ? 'on' : '',
          'aria-selected': String(inspectorView === pair[0]),
          text: pair[1],
          onclick: function () {
            inspectorView = pair[0];
            renderInspectorPanel();
          },
        })
      );
    });
    content.appendChild(
      el('div', { class: 'library-actions' }, [
        el('span', { class: 'hint', text: current ? current : 'No page is open' }),
        el('button', { class: 'btn', text: 'Refresh', onclick: refreshInspector }),
      ])
    );
    content.appendChild(tabs);
    content.appendChild(
      el('div', {
        class: 'inspect-warning',
        text: 'Recent request details stay in this Waddle session. Cookie values for HttpOnly cookies are hidden.',
      })
    );
    content.appendChild(el('div', { id: 'inspectorBody', class: 'inspector-body' }));
    renderInspectorPanel();
  }
  function renderInspectorPanel() {
    var host = $('#inspectorBody');
    if (!host) return;
    var views = ['requests', 'headers', 'cookies', 'source'];
    [].forEach.call(document.querySelectorAll('#libraryContent .inspect-tabs button'), function (button, index) {
      var selectedView = views[index] === inspectorView;
      button.classList.toggle('on', selectedView);
      button.setAttribute('aria-selected', String(selectedView));
    });
    host.textContent = '';
    var requests = inspectData.requests || [];
    var selected =
      requests.filter(function (x) {
        return x.id === inspectRequestId;
      })[0] ||
      requests[0] ||
      null;
    if (selected && !inspectRequestId) inspectRequestId = selected.id;
    if (inspectorView === 'requests') {
      if (!requests.length)
        host.appendChild(
          el('div', {
            class: 'empty-note',
            text: current ? 'No requests recorded yet. Refresh after the page loads.' : 'Open a page to inspect requests.',
          })
        );
      else {
        var list = el('div', { class: 'inspect-list' });
        requests.forEach(function (x) {
          list.appendChild(inspectorEntry(x));
        });
        host.appendChild(list);
        host.appendChild(inspectorDetails(selected));
      }
    } else if (inspectorView === 'headers') {
      host.appendChild(inspectorHeaders(selected));
      if (selected) host.appendChild(inspectorDetails(selected));
    } else if (inspectorView === 'cookies') {
      var cookies = inspectData.cookies || [];
      if (!cookies.length) host.appendChild(el('div', { class: 'empty-note', text: 'No cookies match this page.' }));
      cookies.forEach(function (c) {
        host.appendChild(
          el('div', { class: 'inspect-cookie' }, [
            el('b', { text: c.name }),
            el('code', { text: c.httpOnly ? 'value hidden · HttpOnly' : c.value || '(empty value)' }),
            el('small', { text: c.domain + c.path + (c.secure ? ' · Secure' : '') + (c.httpOnly ? ' · HttpOnly' : '') }),
          ])
        );
      });
    } else {
      var source = '';
      try {
        source = frame.contentDocument.documentElement.outerHTML;
        source = source.replace(/<script[^>]*src="\/-\/client\.js[^>]*><\/script>/gi, '<!-- Waddle bootstrap omitted -->');
        if (!/Waddle bootstrap omitted/.test(source)) source = '<!-- Waddle bootstrap omitted from the live document -->\n' + source;
      } catch (e) {
        source = 'The page source is not available until a page has loaded in this tab.';
      }
      host.appendChild(
        el('div', { class: 'library-actions' }, [
          el('button', {
            class: 'btn',
            text: 'Copy source',
            onclick: function () {
              if (navigator.clipboard && navigator.clipboard.writeText)
                navigator.clipboard.writeText(source).then(
                  function () {
                    toast('Source copied');
                  },
                  function () {
                    toast('Could not copy source');
                  }
                );
              else toast('Clipboard is unavailable');
            },
          }),
        ])
      );
      host.appendChild(el('pre', { class: 'source-view', text: source || 'No source is available.' }));
    }
  }
  function refreshInspector() {
    if ($('#libraryPanel').hidden || libraryTab !== 'inspect') return;
    var url = current ? '?url=' + encodeURIComponent(current) : '';
    api('inspect' + url)
      .then(function (data) {
        inspectData = data || { requests: [], cookies: [] };
        if (
          !inspectRequestId ||
          !(inspectData.requests || []).some(function (x) {
            return x.id === inspectRequestId;
          })
        )
          inspectRequestId = '';
        if (!$('#libraryPanel').hidden && libraryTab === 'inspect') {
          if ($('#inspectorBody')) renderInspectorPanel();
          else renderLibrary();
        }
      })
      .catch(function () {});
  }

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
  $('#checkpoint').addEventListener('click', exportMigrationBackup);
  $('#route').addEventListener('click', function () {
    open(document.body.classList.contains('browsing') ? 'route' : 'proxies');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (openDD) openDD.close();
    else if (!$('#libraryPanel').hidden) $('#libraryPanel').hidden = true;
    else if (!$('#drawer').hidden) $('#drawer').hidden = true;
    closeSuggestions();
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
  renderBrowserTabs();
  applyFrontendPrefs();
  updateBookmarkButton();
  renderHomePicks();
  Promise.all([api('state').then(apply, function () {}), ready()]).then(function () {
    var h = fromHash() || (activeBrowserTab() && activeBrowserTab().url) || '';
    if (h) go(h, { mode: 'replace' });
    else show('');
    renderBrowserTabs();
    updateBookmarkButton();
    renderHomePicks();
  });
  window.addEventListener('hashchange', function () {
    var h = fromHash();
    if (h && h !== shown(current)) go(h);
    else if (!h && current) home();
  });
})();
