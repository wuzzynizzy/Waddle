/* Browser-local Waddle library and presentation settings. Nothing in this file calls the server. */
(function (w) {
  'use strict';
  var LIBRARY_KEY = 'waddle.library.v1';
  var PREFS_KEY = 'waddle.frontend.v1';
  var DEFAULTS = {
    accent: 'orange',
    density: 'comfortable',
    textSize: 'normal',
    tabPosition: 'top',
    showLinks: true,
    showRecommendations: true,
    showStatus: true,
    externalSuggestions: false,
  };
  var COLORS = {
    orange: '#ff8a1f',
    blue: '#3578d4',
    violet: '#805ad5',
    teal: '#0f9b8e',
    rose: '#df5478',
  };
  function id() {
    try {
      if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    } catch (e) {
      /* unavailable */
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function cleanUrl(value) {
    try {
      var u = new URL(String(value || '').trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      u.username = '';
      u.password = '';
      return u.href.slice(0, 4096);
    } catch (e) {
      return '';
    }
  }
  function base() {
    var v;
    try {
      v = JSON.parse(w.localStorage.getItem(LIBRARY_KEY) || 'null');
    } catch (e) {
      v = null;
    }
    if (!v || typeof v !== 'object') v = {};
    var folders = Array.isArray(v.folders) ? v.folders : ['Unsorted'];
    var names = [];
    folders.forEach(function (name) {
      name = String(name || '')
        .trim()
        .slice(0, 48);
      if (name && names.indexOf(name) < 0) names.push(name);
    });
    if (!names.length) names.push('Unsorted');
    function items(key, cap) {
      return (Array.isArray(v[key]) ? v[key] : [])
        .slice(0, cap)
        .map(function (x) {
          var url = cleanUrl(x && x.url);
          if (!url) return null;
          return {
            id: String((x && x.id) || id()).slice(0, 80),
            url: url,
            title: String((x && x.title) || url).slice(0, 240),
            folder: names.indexOf(String(x && x.folder)) >= 0 ? String(x.folder) : 'Unsorted',
            at: Number((x && (x.at || x.visited)) || Date.now()),
          };
        })
        .filter(Boolean);
    }
    if (names.indexOf('Unsorted') < 0) names.unshift('Unsorted');
    return {
      folders: names,
      bookmarks: items('bookmarks', 1000),
      saved: items('saved', 500),
      history: items('history', 500),
    };
  }
  function write(data) {
    try {
      w.localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }
  function prefs() {
    var p = {};
    try {
      p = JSON.parse(w.localStorage.getItem(PREFS_KEY) || '{}') || {};
    } catch (e) {
      p = {};
    }
    var out = Object.assign({}, DEFAULTS);
    Object.keys(DEFAULTS).forEach(function (k) {
      if (typeof p[k] === typeof DEFAULTS[k]) out[k] = p[k];
    });
    if (!COLORS[out.accent]) out.accent = DEFAULTS.accent;
    if (['comfortable', 'compact', 'spacious'].indexOf(out.density) < 0) out.density = DEFAULTS.density;
    if (['small', 'normal', 'large'].indexOf(out.textSize) < 0) out.textSize = DEFAULTS.textSize;
    if (out.tabPosition !== 'bottom') out.tabPosition = 'top';
    return out;
  }
  function savePrefs(patch) {
    var next = Object.assign(prefs(), patch || {});
    try {
      w.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (e) {
      /* storage disabled or full */
    }
    return prefs();
  }
  function equalUrl(a, b) {
    return a === b;
  }
  function add(list, url, title, folder) {
    url = cleanUrl(url);
    if (!url) return null;
    var at = list.findIndex(function (x) {
      return equalUrl(x.url, url);
    });
    var item = at >= 0 ? list.splice(at, 1)[0] : { id: id(), url: url, title: '', folder: 'Unsorted', at: Date.now() };
    item.title = String(title || item.title || url).slice(0, 240);
    item.folder = String(folder || item.folder || 'Unsorted').slice(0, 48) || 'Unsorted';
    item.at = Date.now();
    list.unshift(item);
    return item;
  }
  function update(fn) {
    var data = base();
    fn(data);
    write(data);
    return data;
  }
  function toggleBookmark(url, title) {
    var result = { added: false, item: null };
    update(function (data) {
      url = cleanUrl(url);
      var at = data.bookmarks.findIndex(function (x) {
        return x.url === url;
      });
      if (!url) return;
      if (at >= 0) {
        result.item = data.bookmarks.splice(at, 1)[0];
      } else {
        var item = add(data.bookmarks, url, title, data.folders[0]);
        result.added = true;
        result.item = item;
      }
    });
    return result;
  }
  function bookmark(url, title, folder) {
    var result;
    update(function (data) {
      if (data.folders.indexOf(folder) < 0) data.folders.push(folder || 'Unsorted');
      result = add(data.bookmarks, url, title, folder);
    });
    return result;
  }
  function saveForLater(url, title) {
    var result;
    update(function (data) {
      result = add(data.saved, url, title, 'Unsorted');
    });
    return result;
  }
  function remove(listName, key) {
    update(function (data) {
      if (!Array.isArray(data[listName])) return;
      data[listName] = data[listName].filter(function (x) {
        return x.id !== key && x.url !== key;
      });
    });
  }
  function moveBookmark(key, folder) {
    update(function (data) {
      folder = String(folder || 'Unsorted').slice(0, 48);
      if (data.folders.indexOf(folder) < 0) data.folders.push(folder);
      data.bookmarks.forEach(function (x) {
        if (x.id === key) x.folder = folder;
      });
    });
  }
  function addFolder(name) {
    name = String(name || '')
      .trim()
      .slice(0, 48);
    if (!name) return false;
    var result = false;
    update(function (data) {
      if (data.folders.indexOf(name) < 0) {
        data.folders.push(name);
        result = true;
      }
    });
    return result;
  }
  function visit(url, title) {
    update(function (data) {
      url = cleanUrl(url);
      if (!url) return;
      var last = data.history[0];
      if (last && last.url === url && Date.now() - last.at < 30 * 1000) {
        last.title = String(title || last.title || url).slice(0, 240);
        last.at = Date.now();
        return;
      }
      data.history.unshift({ id: id(), url: url, title: String(title || url).slice(0, 240), folder: 'Unsorted', at: Date.now() });
      data.history = data.history.slice(0, 500);
    });
  }
  function clearHistory() {
    update(function (data) {
      data.history = [];
    });
  }
  function suggestions(query, tabs) {
    var data = base();
    var q = String(query || '')
      .trim()
      .toLowerCase();
    var list = [];
    data.bookmarks.forEach(function (x) {
      list.push(Object.assign({ kind: 'Bookmark', weight: 4 }, x));
    });
    data.saved.forEach(function (x) {
      list.push(Object.assign({ kind: 'Saved', weight: 3 }, x));
    });
    data.history.forEach(function (x) {
      list.push(Object.assign({ kind: 'History', weight: 2 }, x));
    });
    (tabs || []).forEach(function (x) {
      if (x && x.url) list.push({ url: x.url, title: x.title || x.url, at: Date.now(), kind: 'Open tab', weight: 5 });
    });
    var seen = Object.create(null);
    return list
      .filter(function (x) {
        if (!x.url || seen[x.url]) return false;
        seen[x.url] = true;
        if (!q) return x.kind === 'Open tab' || x.kind === 'Bookmark' || x.kind === 'Saved' || x.kind === 'History';
        return (x.title + ' ' + x.url + ' ' + (x.folder || '')).toLowerCase().indexOf(q) >= 0;
      })
      .sort(function (a, b) {
        if (q) {
          var ai = (a.title + ' ' + a.url).toLowerCase().indexOf(q);
          var bi = (b.title + ' ' + b.url).toLowerCase().indexOf(q);
          if ((ai === 0) !== (bi === 0)) return ai === 0 ? -1 : 1;
        }
        return b.weight - a.weight || b.at - a.at;
      })
      .slice(0, 8);
  }
  function importBookmarks(value) {
    var incoming = value && typeof value === 'object' ? value : {};
    var count = 0;
    update(function (data) {
      (Array.isArray(incoming.folders) ? incoming.folders : []).forEach(function (name) {
        name = String(name || '')
          .trim()
          .slice(0, 48);
        if (name && data.folders.indexOf(name) < 0) data.folders.push(name);
      });
      (Array.isArray(incoming.bookmarks) ? incoming.bookmarks : []).slice(0, 2000).forEach(function (x) {
        if (x && add(data.bookmarks, x.url, x.title, x.folder)) count++;
      });
      data.bookmarks = data.bookmarks.slice(0, 1000);
    });
    return count;
  }
  function exportBookmarks() {
    var data = base();
    return {
      format: 'waddle-bookmarks',
      version: 1,
      exportedAt: new Date().toISOString(),
      folders: data.folders,
      bookmarks: data.bookmarks,
    };
  }
  w.WaddleLocal = {
    cleanUrl: cleanUrl,
    get: base,
    preferences: prefs,
    savePreferences: savePrefs,
    toggleBookmark: toggleBookmark,
    bookmark: bookmark,
    saveForLater: saveForLater,
    remove: remove,
    moveBookmark: moveBookmark,
    addFolder: addFolder,
    visit: visit,
    clearHistory: clearHistory,
    suggestions: suggestions,
    importBookmarks: importBookmarks,
    exportBookmarks: exportBookmarks,
    keys: { library: LIBRARY_KEY, preferences: PREFS_KEY },
    accentColors: COLORS,
  };
})(window);
