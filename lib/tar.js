'use strict';
// Minimal streaming tar reader (ustar + pax + GNU long names). No dependencies.
// Feed it decompressed bytes; it hands back the files you ask for.

class TarScanner {
  /**
   * @param {object} o
   * @param {(path:string,size:number)=>boolean} o.want   decide whether to buffer a file
   * @param {(path:string,data:Buffer)=>void}    o.onFile receives each wanted file
   */
  constructor({ want, onFile }) {
    this.want = want;
    this.onFile = onFile;
    this.header = Buffer.alloc(512);
    this.hlen = 0;
    this.pad = 0; // padding bytes left to skip after a body
    this.cur = null; // entry whose body is being read
    this.nextPath = null; // path override from a pax / GNU long-name record
    this.done = false;
    this.files = 0;
  }

  write(chunk) {
    let off = 0;
    while (off < chunk.length && !this.done) {
      if (this.cur) {
        const n = Math.min(this.cur.left, chunk.length - off);
        if (this.cur.parts) this.cur.parts.push(chunk.subarray(off, off + n));
        this.cur.left -= n;
        off += n;
        if (this.cur.left === 0) this._endBody();
        continue;
      }
      if (this.pad) {
        const n = Math.min(this.pad, chunk.length - off);
        this.pad -= n;
        off += n;
        continue;
      }
      const n = Math.min(512 - this.hlen, chunk.length - off);
      chunk.copy(this.header, this.hlen, off, off + n);
      this.hlen += n;
      off += n;
      if (this.hlen === 512) {
        this.hlen = 0;
        this._header(this.header);
      }
    }
  }

  _header(h) {
    if (h.every((b) => b === 0)) {
      this.done = true;
      return;
    } // end-of-archive marker
    const str = (a, b) => {
      const z = h.indexOf(0, a);
      return h.toString('utf8', a, z < 0 || z > b ? b : z);
    };
    let size;
    if (h[124] & 0x80) {
      // base-256 size (files > 8 GiB)
      size = 0;
      for (let i = 125; i < 136; i++) size = size * 256 + h[i];
    } else {
      size = parseInt(str(124, 136).trim() || '0', 8) || 0;
    }
    const type = String.fromCharCode(h[156] || 48);
    let path = str(0, 100);
    const prefix = str(345, 500);
    if (str(257, 262) === 'ustar' && prefix) path = prefix + '/' + path;
    if (this.nextPath && type !== 'x' && type !== 'g' && type !== 'L') {
      path = this.nextPath;
      this.nextPath = null;
    }
    const meta = type === 'x' || type === 'L';
    const keep = meta || ((type === '0' || type === '7') && this.want(path, size));
    this.cur = { path, type, size, left: size, parts: keep ? [] : null };
    if (size === 0) this._endBody();
  }

  _endBody() {
    const c = this.cur;
    this.cur = null;
    this.pad = (512 - (c.size % 512)) % 512;
    if (!c.parts) return;
    const data = c.parts.length === 1 ? c.parts[0] : Buffer.concat(c.parts);
    if (c.type === 'L') {
      this.nextPath = data.toString('utf8').replace(/\0+$/, '');
    } else if (c.type === 'x') {
      // pax records: "<len> key=value\n"
      let i = 0;
      while (i < data.length) {
        const sp = data.indexOf(32, i);
        if (sp < 0) break;
        const len = parseInt(data.toString('ascii', i, sp), 10);
        if (!len) break;
        const rec = data.toString('utf8', sp + 1, i + len - 1);
        const eq = rec.indexOf('=');
        if (eq > 0 && rec.slice(0, eq) === 'path') this.nextPath = rec.slice(eq + 1);
        i += len;
      }
    } else {
      this.files++;
      this.onFile(c.path, data);
    }
  }
}

module.exports = { TarScanner };
