'use strict';

/**
 * Bitmap sidecar: Uint32Array bitset + SQLite DB loader.
 * Loads .carto/carto.db reverse_deps + imports, builds bitmap adjacency.
 */

// ── Uint32Array Bitset ──────────────────────────────────────────────────────

class Bitset {
  constructor(size) {
    this.size = size;
    this.words = new Uint32Array(Math.ceil(size / 32));
  }
  set(i) { this.words[i >>> 5] |= (1 << (i & 31)); }
  has(i) { return (this.words[i >>> 5] & (1 << (i & 31))) !== 0; }
  or(other) {
    const r = new Bitset(Math.max(this.size, other.size));
    for (let i = 0; i < this.words.length; i++) r.words[i] = this.words[i];
    for (let i = 0; i < other.words.length; i++) r.words[i] |= other.words[i];
    return r;
  }
  and(other) {
    const r = new Bitset(this.size);
    const len = Math.min(this.words.length, other.words.length);
    for (let i = 0; i < len; i++) r.words[i] = this.words[i] & other.words[i];
    return r;
  }
  andNot(other) {
    const r = new Bitset(this.size);
    for (let i = 0; i < this.words.length; i++)
      r.words[i] = this.words[i] & ~(other.words[i] || 0);
    return r;
  }
  popcount() {
    let c = 0;
    for (let i = 0; i < this.words.length; i++) {
      let v = this.words[i];
      v = v - ((v >>> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      c += (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
    }
    return c;
  }
  iterate() {
    const result = [];
    for (let w = 0; w < this.words.length; w++) {
      let v = this.words[w];
      while (v) {
        const bit = v & (-v);
        result.push((w << 5) + (31 - Math.clz32(bit)));
        v ^= bit;
      }
    }
    return result;
  }
  clone() {
    const r = new Bitset(this.size);
    r.words.set(this.words);
    return r;
  }
}

// ── Build sidecar from .carto/carto.db ──────────────────────────────────────

function buildSidecar(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');

  // Load all files → build ID maps
  const files = db.prepare('SELECT id, path FROM files').all();
  const maxId = files.reduce((m, f) => Math.max(m, f.id), 0);
  const size = maxId + 1;

  const fileIdToPath = new Map();
  const pathToFileId = new Map();
  for (const f of files) {
    fileIdToPath.set(f.id, f.path);
    pathToFileId.set(f.path, f.id);
  }

  // Load domain assignments
  const domainRows = db.prepare('SELECT file_id, domain_id FROM domain_assignments').all();
  const fileDomain = new Map();
  for (const r of domainRows) fileDomain.set(r.file_id, r.domain_id);

  // Build forward (file → files it imports) and reverse (file → its dependents)
  const forward = new Map();  // fileId → Bitset of imported fileIds
  const reverse = new Map();  // fileId → Bitset of dependent fileIds

  const imports = db.prepare('SELECT from_file_id, to_file_id FROM imports WHERE to_file_id IS NOT NULL').all();
  for (const row of imports) {
    if (!forward.has(row.from_file_id)) forward.set(row.from_file_id, new Bitset(size));
    forward.get(row.from_file_id).set(row.to_file_id);

    if (!reverse.has(row.to_file_id)) reverse.set(row.to_file_id, new Bitset(size));
    reverse.get(row.to_file_id).set(row.from_file_id);
  }

  // Build per-domain bitmaps
  const domainBitmaps = new Map(); // domainId → Bitset of fileIds in that domain
  for (const r of domainRows) {
    if (!domainBitmaps.has(r.domain_id)) domainBitmaps.set(r.domain_id, new Bitset(size));
    domainBitmaps.get(r.domain_id).set(r.file_id);
  }

  db.close();

  const sidecarBytes = (forward.size + reverse.size) * Math.ceil(size / 32) * 4;

  return { forward, reverse, fileIdToPath, pathToFileId, fileDomain, domainBitmaps, size, sidecarBytes, Bitset };
}

module.exports = { buildSidecar, Bitset };
