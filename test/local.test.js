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

test('bookmarks, saved addresses and history remain browser-local', () => {
  const { local, storage } = libraryInMemory();
  const bookmark = local.bookmark('https://example.com/guide', 'Guide', 'Reading');
  const saved = local.saveForLater('https://example.net/later', 'Later');
  local.visit('https://example.org/story', 'Story');

  assert.deepEqual(JSON.parse(JSON.stringify(local.get())), {
    folders: ['Unsorted', 'Reading'],
    bookmarks: [{ id: 'test-id', url: 'https://example.com/guide', title: 'Guide', folder: 'Reading', at: bookmark.at }],
    saved: [{ id: 'test-id', url: 'https://example.net/later', title: 'Later', folder: 'Unsorted', at: saved.at }],
    history: [
      {
        id: 'test-id',
        url: 'https://example.org/story',
        title: 'Story',
        folder: 'Unsorted',
        at: local.get().history[0].at,
      },
    ],
  });
  assert.ok(storage.getItem(local.keys.library), 'the library is stored in this browser');
  assert.equal(local.exportState, undefined);
  assert.equal(local.exportBookmarks, undefined);
  assert.equal(local.importState, undefined, 'there is no Waddle backup/restore surface');
});

test('bookmark imports and URL/preferences sanitization stay one-way and local', () => {
  const { local, storage } = libraryInMemory();
  const count = local.importBookmarks({
    folders: ['Reading', 'Reading'],
    bookmarks: [
      { url: 'javascript:alert(1)', title: 'bad', folder: 'Reading' },
      { url: 'https://user:secret@good.example/path', title: 'Good', folder: 'Reading' },
    ],
  });
  assert.equal(count, 1);
  assert.equal(local.get().bookmarks[0].url, 'https://good.example/path');
  assert.deepEqual(JSON.parse(JSON.stringify(local.get().folders)), ['Unsorted', 'Reading']);

  local.savePreferences({
    theme: 'ultraviolet',
    accent: 'ultraviolet',
    density: 'weird',
    textSize: 'tiny',
    tabPosition: 'sideways',
    externalSuggestions: true,
    staleStartPageOption: 'ignored',
  });
  const preferences = local.preferences();
  assert.equal(preferences.theme, 'auto');
  assert.equal(preferences.accent, 'orange');
  assert.equal(preferences.density, 'comfortable');
  assert.equal(preferences.textSize, 'normal');
  assert.equal(preferences.tabPosition, 'top');
  assert.equal(preferences.externalSuggestions, true);
  assert.equal('staleStartPageOption' in preferences, false);
  assert.ok(storage.getItem(local.keys.preferences), 'appearance choices are browser-local');

  const older = JSON.parse(storage.getItem(local.keys.preferences));
  delete older.theme;
  storage.setItem(local.keys.preferences, JSON.stringify(older));
  storage.setItem('waddle.theme', 'dark');
  assert.equal(local.preferences().theme, 'dark', 'older browser-local themes still migrate');
});

test('unsafe bookmarks are discarded and local updates stay safe if storage is full', () => {
  const { local, storage } = libraryInMemory();
  local.bookmark('https://before.example/', 'Before', 'Unsorted');
  storage.failKey = local.keys.library;
  local.bookmark('javascript:alert(1)', 'Unsafe', 'Unsorted');
  local.bookmark('https://after.example/', 'After', 'Unsorted');
  storage.failKey = '';
  assert.deepEqual(
    Array.from(local.get().bookmarks, (item) => item.url),
    ['https://before.example/']
  );
  assert.equal(local.cleanUrl('file:///etc/passwd'), '');
  assert.equal(local.cleanUrl('https://user:pass@example.com/'), 'https://example.com/');
});
