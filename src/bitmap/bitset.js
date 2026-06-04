'use strict';

/**
 * Bitset — Uint32Array-backed dense bitmap.
 *
 * 60-line implementation,
 * zero deps. Used by Carto's bitmap engine (`src/bitmap/`) for sub-millisecond
 * forward/reverse adjacency queries on the import graph.
 *
 * Operations are word-level (32-bit lanes) — `or`, `and`, `andNot`, `popcount`,
 * `iterate` all run at one cycle per 32 bits on modern CPUs. For Carto's typical
 * 10K-file repos this is 312 words per bitmap → tens of nanoseconds for a
 * popcount, microseconds for a 1-hop frontier expansion.
 *
 * Layout: bit `i` lives in `words[i >>> 5]` at lane `i & 31`. Out-of-range reads
 * return false; out-of-range writes are caller's responsibility (the bitset
 * does not auto-grow — it's sized at construction to the max file id + 1).
 */
class Bitset {
  /**
   * @param {number} size — Number of bits (i.e. max file id + 1).
   */
  constructor(size) {
    this.size = size;
    this.words = new Uint32Array(Math.ceil(size / 32));
  }

  /** Set bit `i` to 1. */
  set(i) { this.words[i >>> 5] |= (1 << (i & 31)); }

  /** Clear bit `i` (set to 0). */
  clear(i) { this.words[i >>> 5] &= ~(1 << (i & 31)); }

  /** Return true if bit `i` is set. */
  has(i) { return (this.words[i >>> 5] & (1 << (i & 31))) !== 0; }

  /** Bitwise OR. Returns a new Bitset sized to the larger of the two. */
  or(other) {
    const r = new Bitset(Math.max(this.size, other.size));
    for (let i = 0; i < this.words.length; i++) r.words[i] = this.words[i];
    for (let i = 0; i < other.words.length; i++) r.words[i] |= other.words[i];
    return r;
  }

  /** Bitwise AND. Returns a new Bitset sized to `this`. */
  and(other) {
    const r = new Bitset(this.size);
    const len = Math.min(this.words.length, other.words.length);
    for (let i = 0; i < len; i++) r.words[i] = this.words[i] & other.words[i];
    return r;
  }

  /** Bitwise AND-NOT (this & ~other). Returns a new Bitset sized to `this`. */
  andNot(other) {
    const r = new Bitset(this.size);
    for (let i = 0; i < this.words.length; i++) {
      r.words[i] = this.words[i] & ~(other.words[i] || 0);
    }
    return r;
  }

  /**
   * In-place bitwise OR. Mutates `this` to `this | other` and returns `this`.
   *
   * Used by hot BFS loops (`blastRadius`, `simulateChangeImpact`)
   * to avoid the per-hop Uint32Array allocation that `.or()` performs.
   * If `other` is wider than `this`, words beyond `this.size` are dropped —
   * callers that care about size growth should resize before calling.
   */
  orInPlace(other) {
    const n = Math.min(this.words.length, other.words.length);
    for (let i = 0; i < n; i++) this.words[i] |= other.words[i];
    return this;
  }

  /**
   * In-place bitwise AND-NOT. Mutates `this` to `this & ~other` and
   * returns `this`.
   */
  andNotInPlace(other) {
    const n = Math.min(this.words.length, other.words.length);
    for (let i = 0; i < n; i++) this.words[i] &= ~other.words[i];
    // If `other` is shorter than `this`, the trailing words stay as-is —
    // andNot with implicit-zero is a no-op.
    return this;
  }

  /**
   * Copy bits from `other` into `this` (mutates and returns `this`).
   *
   * The receiver's word array is reused — no new allocation.
   * If sizes differ, the overlapping prefix is copied and the suffix of
   * `this` (if any) is zeroed so stale bits don't leak.
   */
  copyFrom(other) {
    if (this.words.length === other.words.length) {
      this.words.set(other.words);
    } else {
      const n = Math.min(this.words.length, other.words.length);
      for (let i = 0; i < n; i++) this.words[i] = other.words[i];
      for (let i = n; i < this.words.length; i++) this.words[i] = 0;
    }
    return this;
  }

  /**
   * Set every word to `value` (defaults to 0). Mutates and returns `this`.
   *
   * The hot use case is `setAll(0)` to clear the transient
   * frontier bitset between BFS hops without reallocating its 32-bit lanes.
   */
  setAll(value = 0) {
    this.words.fill(value >>> 0);
    return this;
  }

  /**
   * Population count (number of set bits).
   * Hamming weight via parallel bit-fold — same kernel as POPCNT but portable
   * across Node runtimes that don't expose hardware popcount.
   */
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

  /**
   * Returns an array of every set bit's index (file id), in ascending order.
   * Uses the `v & -v` LSB trick to skip zero lanes early.
   */
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

  /** Deep copy. */
  clone() {
    const r = new Bitset(this.size);
    r.words.set(this.words);
    return r;
  }

  /**
   * Serialize to a Buffer. Layout: just the raw word bytes (LE on x86/ARM
   * Node hosts; Carto runs Node so endianness matches the running machine —
   * the on-disk file is per-machine just like SQLite's `carto.db`).
   *
   * Size in bytes: `Math.ceil(size / 32) * 4`. Caller persists the `size`
   * separately so deserialize knows how many bits to expect.
   */
  serialize() {
    return Buffer.from(this.words.buffer, this.words.byteOffset, this.words.byteLength);
  }

  /**
   * Reconstruct a Bitset from a Buffer + the original size.
   *
   * @param {Buffer} buf — Bytes produced by `serialize()`.
   * @param {number} size — Bit count (must match the serialized bitset).
   * @returns {Bitset}
   */
  static deserialize(buf, size) {
    const r = new Bitset(size);
    // Copy through a Uint8Array view so we don't alias buf's underlying
    // ArrayBuffer (which may be shared with Node's internal pool).
    const expected = r.words.byteLength;
    if (buf.length < expected) {
      throw new Error(`Bitset.deserialize: buffer too small (got ${buf.length}, need ${expected})`);
    }
    const u8 = new Uint8Array(r.words.buffer, r.words.byteOffset, expected);
    for (let i = 0; i < expected; i++) u8[i] = buf[i];
    return r;
  }
}

module.exports = { Bitset };
