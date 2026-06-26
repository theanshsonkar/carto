'use strict';

/**
 * Temporal delta — XOR-based bitset compression for architectural history.
 *
 * Each commit stores `delta_t = G_t XOR G_{t-1}`. XOR is self-inverse, so
 * reconstruction at any point is
 *   `G_now XOR delta_now XOR delta_{n-1} ... XOR delta_t`.
 *
 * For typical repos, most consecutive commits touch a handful of files out
 * of thousands. The XOR'd bitset is mostly zeros and gzips ~10×. A year of
 * forward adjacency on a 7K-file repo fits in 12–40 MB.
 *
 * This module is the bit-level primitive only. Callers in `snapshot.js`
 * decide which bitset to delta against and how often to store full
 * snapshots vs deltas.
 */

const zlib = require('zlib');
const { Bitset } = require('../bitmap/bitset');

/**
 * xorBitsets(a, b) → new Bitset
 *
 * Bitwise XOR of two Bitsets. Result is sized to the larger of the two.
 * Out-of-range bits in the smaller bitset are treated as zero.
 */
function xorBitsets(a, b) {
  const size = Math.max(a.size, b.size);
  const r = new Bitset(size);
  const aw = a.words, bw = b.words, rw = r.words;
  for (let i = 0; i < rw.length; i++) {
    const ai = i < aw.length ? aw[i] : 0;
    const bi = i < bw.length ? bw[i] : 0;
    rw[i] = ai ^ bi;
  }
  return r;
}

/**
 * Serialize a Bitset + gzip-compress. Returns a Buffer.
 *
 * The bitset's raw word bytes are runs of zero on small deltas, so deflate
 * finds high compressibility quickly. Memlevel 9 + max compression — the
 * encode cost is paid once per snapshot (irrelevant) and the decode cost is
 * negligible on the rare temporal-tool call.
 */
function compressBitset(bs) {
  const raw = bs.serialize();
  return zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_COMPRESSION });
}

/** Reverse of compressBitset(). */
function decompressBitset(compressed, size) {
  const raw = zlib.gunzipSync(compressed);
  return Bitset.deserialize(raw, size);
}

/**
 * orMaps(map1, map2) → Map<fileId, Bitset>
 *
 * Flatten Map<fileId, Bitset> into a single Bitset that represents the union
 * of all set bits across all rows. Used to compress a forward-adjacency map
 * into a single XOR-able bitset for delta storage.
 */
function flattenMap(adjMap, size) {
  const flat = new Bitset(size);
  for (const [fid, bs] of adjMap) {
    for (let w = 0; w < bs.words.length && w < flat.words.length; w++) {
      flat.words[w] |= bs.words[w];
    }
    // Set the source bit too, so the flat bitset captures both "this file
    // is in the graph" and "this file's outgoing edges" — i.e. the union
    // of all node and edge information for XOR-delta detection.
    if (fid < size) flat.set(fid);
  }
  return flat;
}

module.exports = {
  xorBitsets,
  compressBitset,
  decompressBitset,
  flattenMap,
};
