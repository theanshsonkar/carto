'use strict';

/**
 * Bitmap sidecar — derives bitmap-shaped indexes from the durable SQLite layer.
 *
 * Builds forward + reverse adjacency bitmaps, per-domain membership
 * bitmaps, and a sorted popcount index (matches SQLite's pre-computed
 * `centrality` column so `highImpactFiles` is O(1) at query time).
 *
 * Architecture: the bitmap layer is **derived + disposable**.
 * SQLite stays as the durable write log + source of truth. Bitmap rebuild
 * from the store takes <100ms even on 7K-file repos, so a missing or stale
 * `.carto/bitmap.bin` is never a durability concern — the orchestrator
 * (`src/bitmap/index.js`) regenerates it transparently.
 */

const fs = require('fs');
const path = require('path');
const { Bitset } = require('./bitset');

const MAGIC = 0x54524243;       // "CBRT" little-endian: 'C','B','R','T'
const VERSION = 2;              // popcountIndex tracks transitive 5-hop
                                // count (matches SQLite's `centrality`).
                                // v1 files are rebuilt on next load.
const HEADER_BYTES = 12;        // magic(4) + version(1) + reserved(3) + size(4)
const BITMAP_FILENAME = 'bitmap.bin';

/**
 * buildFromStore(store) → sidecar object
 *
 * Reads files, imports, and domain assignments from an open SQLiteStore and
 * materialises:
 *   - `forward`         Map<fileId, Bitset> — files this file imports
 *   - `reverse`         Map<fileId, Bitset> — direct dependents of this file
 *   - `crossForward`    Map<fileId, Bitset> — like `forward`, but with same-
 *                       domain bits masked out. Pre-filtered at build time
 *                       so `crossDomain` skips the ~95% of import
 *                       edges that are intra-domain on real repos.
 *                       Files with no domain assignment, and files whose
 *                       forward bitmap is entirely intra-domain, are absent.
 *   - `domainBitmaps`   Map<domainId, Bitset> — files in each domain
 *   - `popcountIndex`   Array<{fileId, count}> sorted DESC by count.
 *                       Lets `highImpactFiles` answer in O(1) — the
 *                       sort happens at build time, the query is an
 *                       array slice.
 *   - `fileIdToPath`    Map<fileId, path> — for hydrating bitmap results
 *                       back to the path strings the MCP layer returns.
 *   - `pathToFileId`    Inverse of above.
 *   - `fileDomain`      Map<fileId, domainId>.
 *   - `domainIdToName`  Map<domainId, name>.
 *   - `filePathArr`     Array<string> indexed by fileId — flat-array
 *                       projection of `fileIdToPath` for O(1) hot-loop
 *                       indexing without hash overhead.
 *   - `fileDomainArr`   Int32Array(size) — value at index `fileId` is the
 *                       assigned domainId, or `-1` if unassigned.
 *   - `domainNameArr`   Array<string> indexed by domainId — flat-array
 *                       projection of `domainIdToName`.
 *   - `size`            Max file id + 1 (the bitmap dimension).
 *
 * The store may be opened readonly or read-write — only `.db.prepare(...).all()`
 * is used. Caller owns the store's lifecycle.
 */
function buildFromStore(store) {
  const db = store.db;
  if (!db) throw new Error('buildFromStore: store has no open db');

  const files = db.prepare('SELECT id, path FROM files').all();
  const maxId = files.reduce((m, f) => Math.max(m, f.id), 0);
  const size = maxId + 1;

  const fileIdToPath = new Map();
  const pathToFileId = new Map();
  for (const f of files) {
    fileIdToPath.set(f.id, f.path);
    pathToFileId.set(f.path, f.id);
  }

  const domainRows = db.prepare(
    'SELECT file_id, domain_id FROM domain_assignments'
  ).all();
  const fileDomain = new Map();
  for (const r of domainRows) fileDomain.set(r.file_id, r.domain_id);

  const domainNameRows = db.prepare('SELECT id, name FROM domains').all();
  const domainIdToName = new Map();
  for (const r of domainNameRows) domainIdToName.set(r.id, r.name);

  // Forward / reverse adjacency bitmaps.
  const forward = new Map();
  const reverse = new Map();
  const importRows = db.prepare(
    'SELECT from_file_id, to_file_id FROM imports WHERE to_file_id IS NOT NULL'
  ).all();
  for (const row of importRows) {
    if (!forward.has(row.from_file_id)) forward.set(row.from_file_id, new Bitset(size));
    forward.get(row.from_file_id).set(row.to_file_id);
    if (!reverse.has(row.to_file_id)) reverse.set(row.to_file_id, new Bitset(size));
    reverse.get(row.to_file_id).set(row.from_file_id);
  }

  // Per-domain membership bitmaps.
  const domainBitmaps = new Map();
  for (const r of domainRows) {
    if (!domainBitmaps.has(r.domain_id)) domainBitmaps.set(r.domain_id, new Bitset(size));
    domainBitmaps.get(r.domain_id).set(r.file_id);
  }

  // Pre-built popcount index. For each file with at least
  // one direct dependent, runs a 5-hop BFS over `reverse` and counts the
  // distinct transitive dependents.
  //
  // **Why transitive, not direct popcount.** SQLite's `getHighImpactFiles`
  // queries `files.centrality`, which `computeReverseDeps` populates as
  // `COUNT(DISTINCT dependent_file_id) FROM reverse_deps WHERE file_id = ?`
  // — i.e. the count of files reachable through reverse-import edges up
  // to 5 hops. Pre-fix, the bitmap path stored `popcount(reverse[fid])`
  // (direct dependents only), so `get_high_impact_files` returned
  // different numbers depending on which path the MCP server took.
  // Caught by the corpus accuracy harness — vscode top file: SQL=133
  // dependents, bitmap=54 dependents. After this fix, both paths return
  // identical (file, count) pairs on every corpus repo.
  //
  // Implementation: same BFS shape as `tools.blastRadius`, but the result
  // is just the popcount of `visited` (no need for hydrated paths or
  // hop tracking). All ops in place — three pre-allocated bitsets total
  // for the whole loop.
  const popcountIndex = [];
  const bfsVisited = new Bitset(size);
  const bfsFrontier = new Bitset(size);
  const bfsNext = new Bitset(size);
  const MAX_HOPS = 5;
  for (const [fileId, directReverse] of reverse) {
    bfsVisited.setAll(0);
    bfsFrontier.copyFrom(directReverse);
    bfsVisited.orInPlace(bfsFrontier);
    for (let hop = 2; hop <= MAX_HOPS; hop++) {
      bfsNext.setAll(0);
      const fwords = bfsFrontier.words;
      for (let w = 0; w < fwords.length; w++) {
        let v = fwords[w];
        while (v) {
          const bit = v & -v;
          const fid = (w << 5) + (31 - Math.clz32(bit));
          v ^= bit;
          const deps = reverse.get(fid);
          if (deps) bfsNext.orInPlace(deps);
        }
      }
      bfsNext.andNotInPlace(bfsVisited);
      if (bfsNext.popcount() === 0) break;
      bfsVisited.orInPlace(bfsNext);
      bfsFrontier.copyFrom(bfsNext);
    }
    // Self-loop guard: if a cycle reached `fileId` itself through some
    // dependent's reverse map, drop the seed bit. SQLite explicitly
    // skips `depId === fileId` at every step; this clear matches the
    // semantics in one shot.
    bfsVisited.clear(fileId);
    const cnt = bfsVisited.popcount();
    if (cnt > 0) popcountIndex.push({ fileId, count: cnt });
  }
  popcountIndex.sort((a, b) => b.count - a.count);

  const { filePathArr, fileDomainArr, domainNameArr } = deriveFlatArrays({
    size,
    fileIdToPath,
    fileDomain,
    domainIdToName,
  });

  const crossForward = deriveCrossForward({ forward, domainBitmaps, fileDomain });

  return {
    forward,
    reverse,
    crossForward,
    domainBitmaps,
    popcountIndex,
    fileIdToPath,
    pathToFileId,
    fileDomain,
    domainIdToName,
    filePathArr,
    fileDomainArr,
    domainNameArr,
    size,
  };
}

/**
 * deriveFlatArrays
 *
 * Produces three flat-array projections of the existing Maps:
 *
 *   filePathArr     Array<string>   indexed by fileId. Sparse — slots
 *                                   without a path remain `undefined`.
 *   fileDomainArr   Int32Array      indexed by fileId. Sentinel `-1`
 *                                   for files with no domain assignment.
 *   domainNameArr   Array<string>   indexed by domainId.
 *
 * Used by hot query paths (`crossDomain`, `blastRadius`) where a
 * `Map.get` cost dominates the per-edge work. Maps stay in place for
 * iteration call sites — this is purely an indexing speedup, not a
 * replacement of the Maps.
 *
 * Pure function: derived entirely from inputs, no I/O. Called from
 * `buildFromStore` (after Maps populate) and `loadFromDisk` (after
 * Maps reconstruct from binary).
 */
function deriveFlatArrays({ size, fileIdToPath, fileDomain, domainIdToName }) {
  const filePathArr = new Array(size);
  for (const [fid, p] of fileIdToPath) {
    if (fid >= 0 && fid < size) filePathArr[fid] = p;
  }

  const fileDomainArr = new Int32Array(size).fill(-1);
  for (const [fid, did] of fileDomain) {
    if (fid >= 0 && fid < size) fileDomainArr[fid] = did;
  }

  // Size domainNameArr to maxDomainId + 1 so caller can index by domainId
  // directly. Domain ids are dense and small in practice (≤ ~10), so an
  // Array is fine.
  let maxDomainId = -1;
  for (const did of domainIdToName.keys()) {
    if (did > maxDomainId) maxDomainId = did;
  }
  const domainNameArr = new Array(Math.max(0, maxDomainId + 1));
  for (const [did, name] of domainIdToName) domainNameArr[did] = name;

  return { filePathArr, fileDomainArr, domainNameArr };
}

/**
 * deriveCrossForward
 *
 * For each source file, computes the set of forward edges that cross a
 * domain boundary: `forward[fid] & ~domainBitmap[fileDomain[fid]]`.
 *
 * `crossDomain` then iterates only these pre-filtered bitmaps, skipping
 * every intra-domain bit. On real repos (vscode, supabase) ~95% of
 * import edges are intra-domain, so query work drops by ~20× without
 * changing the output.
 *
 * Memory cost is small: each entry is the same byte size as the
 * corresponding `forward` bitmap, but we omit entries whose result is
 * empty (files that only import within their own domain) — typically
 * the majority. Files with no domain assignment are dropped entirely
 * (no cross-domain context to evaluate).
 *
 * Pure function over already-built sidecar Maps. Called from
 * `buildFromStore` and `loadFromDisk` — no SQL access required.
 */
function deriveCrossForward({ forward, domainBitmaps, fileDomain }) {
  const crossForward = new Map();
  for (const [fromId, fbitmap] of forward) {
    const fromDomainId = fileDomain.get(fromId);
    if (fromDomainId === undefined) continue;
    const ownDomain = domainBitmaps.get(fromDomainId);
    if (!ownDomain) {
      // No domain bitmap means no intra-domain bits to mask — store the
      // forward bitmap verbatim. This is the safe fallback; in practice
      // every assigned domain has a bitmap.
      crossForward.set(fromId, fbitmap.clone());
      continue;
    }
    const cross = fbitmap.clone().andNotInPlace(ownDomain);
    if (cross.popcount() > 0) crossForward.set(fromId, cross);
  }
  return crossForward;
}

// ── Binary persistence ─────────────────────────────────────────────────

/**
 * Encode a Bitset as a (fileId|domainId, wordsLen, words…) record.
 * Returns a Buffer.
 */
function encodeBitmap(id, bitmap) {
  const wordBytes = bitmap.words.byteLength;
  const buf = Buffer.allocUnsafe(8 + wordBytes); // id(4) + wordsLen(4) + words
  buf.writeUInt32LE(id, 0);
  buf.writeUInt32LE(bitmap.words.length, 4);
  // Word bytes — copy (same machine endian).
  Buffer.from(bitmap.words.buffer, bitmap.words.byteOffset, wordBytes).copy(buf, 8);
  return buf;
}

/**
 * Decode at offset `off`. Returns { id, bitmap, nextOff }.
 */
function decodeBitmap(buf, off, size) {
  const id = buf.readUInt32LE(off);
  const wordsLen = buf.readUInt32LE(off + 4);
  const wordBytes = wordsLen * 4;
  const bitmap = new Bitset(size);
  // Make sure the destination word array is sized correctly to receive the
  // serialized words. If `size` rounded up to fewer words than the file has
  // (size mismatch / corrupt header), fail loudly rather than silently
  // truncating.
  if (bitmap.words.length !== wordsLen) {
    throw new Error(
      `bitmap word-length mismatch: header size=${size} → ${bitmap.words.length} words, ` +
      `but record claims ${wordsLen} words`
    );
  }
  const u8 = new Uint8Array(bitmap.words.buffer, bitmap.words.byteOffset, wordBytes);
  for (let i = 0; i < wordBytes; i++) u8[i] = buf[off + 8 + i];
  return { id, bitmap, nextOff: off + 8 + wordBytes };
}

/**
 * saveToDisk(cartoDir, sidecar) → absolute path written.
 *
 * Atomic write: bytes go to `bitmap.bin.tmp`, then rename. Crash mid-write
 * leaves the previous file intact (or absent — the orchestrator's
 * mtime-vs-DB check rebuilds either way).
 *
 * Layout (all integers little-endian):
 *   header:        magic u32 = 0x54524243 ("CBRT") · version u8 = 1 ·
 *                  reserved u8×3 · size u32
 *   forward:       count u32 · count×{ fileId u32 · wordsLen u32 · words u32×wordsLen }
 *   reverse:       count u32 · same layout
 *   domainBitmaps: count u32 · count×{ domainId u32 · wordsLen u32 · words u32×wordsLen }
 *   popcount:      count u32 · count×{ fileId u32 · cnt u32 }
 *   filePaths:     count u32 · count×{ fileId u32 · pathLen u32 · path utf8 bytes }
 *   fileDomain:    count u32 · count×{ fileId u32 · domainId u32 }
 *   domainNames:   count u32 · count×{ domainId u32 · nameLen u32 · name utf8 bytes }
 */
function saveToDisk(cartoDir, sidecar) {
  fs.mkdirSync(cartoDir, { recursive: true });
  const target = path.join(cartoDir, BITMAP_FILENAME);
  const tmp = target + '.tmp';

  const chunks = [];

  // Header
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(0, 5); header.writeUInt8(0, 6); header.writeUInt8(0, 7); // reserved
  header.writeUInt32LE(sidecar.size, 8);
  chunks.push(header);

  // Section: forward bitmaps
  const fwdCountBuf = Buffer.allocUnsafe(4);
  fwdCountBuf.writeUInt32LE(sidecar.forward.size, 0);
  chunks.push(fwdCountBuf);
  for (const [fid, bitmap] of sidecar.forward) chunks.push(encodeBitmap(fid, bitmap));

  // Section: reverse bitmaps
  const revCountBuf = Buffer.allocUnsafe(4);
  revCountBuf.writeUInt32LE(sidecar.reverse.size, 0);
  chunks.push(revCountBuf);
  for (const [fid, bitmap] of sidecar.reverse) chunks.push(encodeBitmap(fid, bitmap));

  // Section: domain bitmaps
  const dmCountBuf = Buffer.allocUnsafe(4);
  dmCountBuf.writeUInt32LE(sidecar.domainBitmaps.size, 0);
  chunks.push(dmCountBuf);
  for (const [did, bitmap] of sidecar.domainBitmaps) chunks.push(encodeBitmap(did, bitmap));

  // Section: popcount index
  const popLenBuf = Buffer.allocUnsafe(4);
  popLenBuf.writeUInt32LE(sidecar.popcountIndex.length, 0);
  chunks.push(popLenBuf);
  if (sidecar.popcountIndex.length > 0) {
    const popBuf = Buffer.allocUnsafe(sidecar.popcountIndex.length * 8);
    let off = 0;
    for (const entry of sidecar.popcountIndex) {
      popBuf.writeUInt32LE(entry.fileId, off);
      popBuf.writeUInt32LE(entry.count, off + 4);
      off += 8;
    }
    chunks.push(popBuf);
  }

  // Section: file paths
  const pathCountBuf = Buffer.allocUnsafe(4);
  pathCountBuf.writeUInt32LE(sidecar.fileIdToPath.size, 0);
  chunks.push(pathCountBuf);
  for (const [fid, p] of sidecar.fileIdToPath) {
    const pBytes = Buffer.from(p, 'utf-8');
    const rec = Buffer.allocUnsafe(8 + pBytes.length);
    rec.writeUInt32LE(fid, 0);
    rec.writeUInt32LE(pBytes.length, 4);
    pBytes.copy(rec, 8);
    chunks.push(rec);
  }

  // Section: file → domain
  const fdCountBuf = Buffer.allocUnsafe(4);
  fdCountBuf.writeUInt32LE(sidecar.fileDomain.size, 0);
  chunks.push(fdCountBuf);
  if (sidecar.fileDomain.size > 0) {
    const fdBuf = Buffer.allocUnsafe(sidecar.fileDomain.size * 8);
    let off = 0;
    for (const [fid, did] of sidecar.fileDomain) {
      fdBuf.writeUInt32LE(fid, off);
      fdBuf.writeUInt32LE(did, off + 4);
      off += 8;
    }
    chunks.push(fdBuf);
  }

  // Section: domain id → name
  const dnCountBuf = Buffer.allocUnsafe(4);
  dnCountBuf.writeUInt32LE(sidecar.domainIdToName.size, 0);
  chunks.push(dnCountBuf);
  for (const [did, name] of sidecar.domainIdToName) {
    const nameBytes = Buffer.from(String(name), 'utf-8');
    const rec = Buffer.allocUnsafe(8 + nameBytes.length);
    rec.writeUInt32LE(did, 0);
    rec.writeUInt32LE(nameBytes.length, 4);
    nameBytes.copy(rec, 8);
    chunks.push(rec);
  }

  const finalBuf = Buffer.concat(chunks);
  fs.writeFileSync(tmp, finalBuf);
  fs.renameSync(tmp, target);
  return target;
}

/**
 * loadFromDisk(cartoDir) → sidecar object (or null if missing/corrupt).
 *
 * Validates magic + version. On any structural error returns null and lets
 * the orchestrator rebuild from the SQLite source of truth — there's no
 * durability cost to a corrupt sidecar.
 */
function loadFromDisk(cartoDir) {
  const target = path.join(cartoDir, BITMAP_FILENAME);
  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch {
    return null;
  }

  try {
    if (buf.length < HEADER_BYTES) return null;
    if (buf.readUInt32LE(0) !== MAGIC) return null;
    const version = buf.readUInt8(4);
    if (version !== VERSION) return null;
    const size = buf.readUInt32LE(8);

    let off = HEADER_BYTES;

    // Forward
    const forward = new Map();
    const fwdCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < fwdCount; i++) {
      const dec = decodeBitmap(buf, off, size);
      forward.set(dec.id, dec.bitmap);
      off = dec.nextOff;
    }

    // Reverse
    const reverse = new Map();
    const revCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < revCount; i++) {
      const dec = decodeBitmap(buf, off, size);
      reverse.set(dec.id, dec.bitmap);
      off = dec.nextOff;
    }

    // Domain bitmaps
    const domainBitmaps = new Map();
    const dmCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < dmCount; i++) {
      const dec = decodeBitmap(buf, off, size);
      domainBitmaps.set(dec.id, dec.bitmap);
      off = dec.nextOff;
    }

    // Popcount index
    const popLen = buf.readUInt32LE(off); off += 4;
    const popcountIndex = new Array(popLen);
    for (let i = 0; i < popLen; i++) {
      popcountIndex[i] = {
        fileId: buf.readUInt32LE(off),
        count: buf.readUInt32LE(off + 4),
      };
      off += 8;
    }

    // File paths
    const fileIdToPath = new Map();
    const pathToFileId = new Map();
    const pathCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < pathCount; i++) {
      const fid = buf.readUInt32LE(off);
      const pLen = buf.readUInt32LE(off + 4);
      const p = buf.slice(off + 8, off + 8 + pLen).toString('utf-8');
      fileIdToPath.set(fid, p);
      pathToFileId.set(p, fid);
      off += 8 + pLen;
    }

    // File → domain
    const fileDomain = new Map();
    const fdCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < fdCount; i++) {
      fileDomain.set(buf.readUInt32LE(off), buf.readUInt32LE(off + 4));
      off += 8;
    }

    // Domain id → name
    const domainIdToName = new Map();
    const dnCount = buf.readUInt32LE(off); off += 4;
    for (let i = 0; i < dnCount; i++) {
      const did = buf.readUInt32LE(off);
      const nLen = buf.readUInt32LE(off + 4);
      const name = buf.slice(off + 8, off + 8 + nLen).toString('utf-8');
      domainIdToName.set(did, name);
      off += 8 + nLen;
    }

    return {
      forward,
      reverse,
      crossForward: deriveCrossForward({ forward, domainBitmaps, fileDomain }),
      domainBitmaps,
      popcountIndex,
      fileIdToPath,
      pathToFileId,
      fileDomain,
      domainIdToName,
      ...deriveFlatArrays({ size, fileIdToPath, fileDomain, domainIdToName }),
      size,
    };
  } catch {
    return null;
  }
}

module.exports = {
  buildFromStore,
  saveToDisk,
  loadFromDisk,
  BITMAP_FILENAME,
  MAGIC,
  VERSION,
};
