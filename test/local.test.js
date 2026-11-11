'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function libraryInMemory() {
  const values = new Map();
  const storage = {
    failKey: '',
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (key === this.failKey) throw new Error('quota exceeded');
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
  const window = { localStorage: storage, crypto: { randomUUID: () => 'test-id' } };
  const source = fs.readFileSync(path.join(__dirname, '../public/local.js'), 'utf8');
  vm.runInNewContext(source, { window, URL, Date, Math }, { filename: 'public/local.js' });
  return { local: window.WaddleLocal, storage };
}

test('browser-local data exports, sanitizes and restores as a portable snapshot', () => {
  const { local, storage } = libraryInMemory();
  local.bookmark('https://example.com/guide', 'Guide', 'Reading');
  local.saveForLater('https://example.net/later', 'Later');
  local.visit('https://example.org/story', 'Story');
  local.savePreferences({ accent: 'blue', density: 'compact', textSize: 'large', externalSuggestions: true });
  storage.setItem('waddle.theme', 'dark');

  const snapshot = local.exportState();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    library: {
      folders: ['Unsorted', 'Reading'],
      bookmarks: [
        { id: 'test-id', url: 'https://example.com/guide', title: 'Guide', folder: 'Reading', at: snapshot.library.bookmarks[0].at },
      ],
      saved: [{ id: 'test-id', url: 'https://example.net/later', title: 'Later', folder: 'Unsorted', at: snapshot.library.saved[0].at }],
      history: [
        { id: 'test-id', url: 'https://example.org/story', title: 'Story', folder: 'Unsorted', at: snapshot.library.history[0].at },
      ],
    },
    preferences: {
      accent: 'blue',
      density: 'compact',
      textSize: 'large',
      tabPosition: 'top',
      showLinks: true,
      showRecommendations: true,
      showStatus: true,
      externalSuggestions: true,
    },
    theme: 'dark',
  });

  storage.setItem(local.keys.library, '{"bookmarks":[]}');
  storage.setItem(local.keys.preferences, '{"accent":"rose"}');
  storage.setItem('waddle.theme', 'light');
  assert.equal(local.importState(snapshot), true);
  const restored = local.exportState();
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(snapshot)));
});

test('browser-local imports discard unsafe URLs and invalid preferences', () => {
  const { local } = libraryInMemory();
  assert.equal(
    local.importState({
      library: {
        folders: ['Saved'],
        bookmarks: [
          { url: 'javascript:alert(1)', title: 'bad', folder: 'Saved' },
          { url: 'https://good.example/path', title: 'Good', folder: 'Saved' },
        ],
      },
      preferences: { accent: 'ultraviolet', density: 'weird', textSize: 'tiny', showLinks: false },
      theme: 'automatic',
    }),
    true
  );
  const snapshot = local.exportState();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.library.bookmarks.map((x) => x.url))), ['https://good.example/path']);
  assert.equal(snapshot.preferences.accent, 'orange');
  assert.equal(snapshot.preferences.density, 'comfortable');
  assert.equal(snapshot.preferences.textSize, 'normal');
  assert.equal(snapshot.preferences.showLinks, false);
  assert.equal(snapshot.theme, '');
});

test('browser-local import rolls back if storage fills halfway through', () => {
  const { local, storage } = libraryInMemory();
  local.bookmark('https://before.example/', 'Before');
  const before = local.exportState();
  storage.failKey = local.keys.preferences;
  assert.equal(
    local.importState({
      library: { bookmarks: [{ url: 'https://after.example/', title: 'After' }] },
      preferences: { accent: 'teal' },
    }),
    false
  );
  storage.failKey = '';
  assert.deepEqual(JSON.parse(JSON.stringify(local.exportState())), JSON.parse(JSON.stringify(before)));
});
