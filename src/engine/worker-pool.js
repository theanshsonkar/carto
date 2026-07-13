'use strict';

const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const WORKER_SCRIPT = path.join(__dirname, 'worker.js');
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length - 1, 8));

// Per-file safety valve. A single pathological file (native tree-sitter hang,
// runaway backtracking) must never be able to stall the entire parse. When a
// task exceeds this budget the wedged worker is killed + respawned and the
// file is skipped. Configurable via env for very large files / slow machines.
const TASK_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.CARTO_PARSE_TIMEOUT_MS || '30000', 10) || 30000
);

/**
 * WorkerPool — manages N persistent worker threads for parallel file parsing.
 *
 * Usage:
 *   const pool = new WorkerPool();
 *   const results = await pool.processFiles(filePaths, projectRoot, onProgress);
 *   pool.terminate();
 *
 * Robustness guarantees (why this file was rewritten):
 *   1. SINGLE source of truth for a worker's busy state. The previous version
 *      juggled `busy` across three overlapping callbacks (`_send`'s wrapped
 *      resolver, `_drain`'s one-shot `once('message')`, and the persistent
 *      `on('message')`). With POOL_SIZE === 1 (e.g. a 2-vCPU Lambda) they
 *      raced: after the 2nd task the persistent handler called `_drain()`
 *      while `busy` was still true, then the one-shot cleared `busy` with no
 *      re-drain — leaving the queue stranded and the whole parse hung until
 *      the process was killed. Now exactly one path (`_complete`) frees a slot
 *      and drains.
 *   2. A dead worker can never strand its queue. `on('exit')` removes the slot,
 *      respawns a replacement, skips the in-flight file, and re-drains.
 *   3. A hung file can never hang the parse. `TASK_TIMEOUT_MS` kills + respawns
 *      the wedged worker and resolves that file as skipped.
 *
 * The public API (constructor(size), processFiles, terminate) is unchanged.
 */
class WorkerPool {
  constructor(size = POOL_SIZE) {
    this._size = size;
    this._workers = [];        // slots: { worker, busy, currentId }
    this._queue = [];          // pending tasks: { id, filePath, projectRoot }
    this._pending = new Map(); // id → { resolve, timer, slot }
    this._idCounter = 0;
    this._ready = false;
  }

  _spawn() {
    for (let i = 0; i < this._size; i++) this._addWorker();
    this._ready = true;
  }

  _addWorker() {
    const slot = { worker: null, busy: false, currentId: null };
    const worker = new Worker(WORKER_SCRIPT);

    worker.on('message', (msg) => {
      // A worker message can carry a per-file `error` (I/O failure, etc.); the
      // caller treats a null result as "skip this file".
      const result = msg && msg.error ? null : (msg ? msg.result : null);
      this._complete(slot, msg ? msg.id : slot.currentId, result);
    });

    worker.on('error', (err) => {
      // Uncaught throw inside the worker. Node emits 'error' and then 'exit',
      // so we only log here and let 'exit' do the slot recovery (avoids
      // dispatching a new task onto a worker that's about to die).
      console.warn(`[CARTO] Worker error: ${err && err.message ? err.message : err}`);
    });

    worker.on('exit', () => {
      // Worker stopped (crash, uncaught throw, or our own terminate()). Retire
      // the slot, and — unless we're shutting the pool down — respawn so the
      // queue keeps flowing. Skip whatever file it was on so nothing hangs.
      const inflightId = slot.currentId;
      const idx = this._workers.indexOf(slot);
      if (idx !== -1) this._workers.splice(idx, 1);
      if (this._ready && this._workers.length < this._size) this._addWorker();
      if (inflightId != null) this._complete(null, inflightId, null);
      else this._drain();
    });

    slot.worker = worker;
    this._workers.push(slot);
  }

  /** The ONLY place a slot is freed and the queue is advanced. */
  _complete(slot, id, result) {
    if (slot) { slot.busy = false; slot.currentId = null; }
    const pending = (id != null) ? this._pending.get(id) : undefined;
    if (pending) {
      this._pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this._drain();
  }

  /** Assign queued tasks to free workers. Idempotent and race-free. */
  _drain() {
    while (this._queue.length > 0) {
      const slot = this._workers.find((w) => !w.busy);
      if (!slot) return; // no capacity right now
      const task = this._queue.shift();
      const pending = this._pending.get(task.id);
      if (!pending) continue; // already resolved (timed out) → drop it
      slot.busy = true;
      slot.currentId = task.id;
      pending.slot = slot;
      slot.worker.postMessage(task);
    }
  }

  /**
   * processFiles(filePaths, projectRoot, onProgress)
   * Returns an array of extracted results (nulls / skipped files filtered out).
   * Resolves even if individual files crash or hang — it never blocks forever.
   */
  async processFiles(filePaths, projectRoot, onProgress) {
    if (!this._ready) this._spawn();

    let completed = 0;
    const total = filePaths.length;

    const tasks = filePaths.map((filePath) => {
      const id = ++this._idCounter;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const pending = this._pending.get(id);
          if (!pending) return; // already completed
          this._pending.delete(id);
          console.warn(`[CARTO] Parse timeout after ${TASK_TIMEOUT_MS}ms, skipping: ${filePath}`);
          const slot = pending.slot;
          if (slot) {
            // Worker is wedged on this file. Detach it from the task and kill
            // it; the 'exit' handler respawns a fresh worker and re-drains.
            slot.currentId = null;
            try { slot.worker.terminate(); } catch { /* ignore */ }
          }
          resolve(null);
        }, TASK_TIMEOUT_MS);

        this._pending.set(id, { resolve, timer, slot: null });
        this._queue.push({ id, filePath, projectRoot });
      }).then((result) => {
        completed++;
        if (onProgress) onProgress(Math.round((completed / total) * 100));
        return result;
      });
    });

    this._drain();
    const results = await Promise.all(tasks);
    return results.filter(Boolean);
  }

  terminate() {
    // Flip _ready first so the 'exit' handlers don't respawn workers as we
    // tear them down.
    this._ready = false;
    for (const slot of this._workers) {
      try { slot.worker.terminate(); } catch { /* ignore */ }
    }
    this._workers = [];
    this._queue = [];
    // Release any still-pending promises so callers can't hang on terminate().
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      try { pending.resolve(null); } catch { /* ignore */ }
    }
    this._pending.clear();
  }
}

module.exports = { WorkerPool, POOL_SIZE };
