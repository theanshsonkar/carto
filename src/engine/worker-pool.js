'use strict';

const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const WORKER_SCRIPT = path.join(__dirname, 'worker.js');
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length - 1, 8));

/**
 * WorkerPool — manages N persistent worker threads for parallel file parsing.
 *
 * Usage:
 *   const pool = new WorkerPool();
 *   const results = await pool.processFiles(filePaths, projectRoot);
 *   pool.terminate();
 */
class WorkerPool {
  constructor(size = POOL_SIZE) {
    this._size = size;
    this._workers = [];
    this._queue = [];
    this._pending = new Map(); // id → { resolve, reject }
    this._idCounter = 0;
    this._ready = false;
  }

  _spawn() {
    for (let i = 0; i < this._size; i++) {
      const worker = new Worker(WORKER_SCRIPT);
      worker.on('message', (msg) => {
        const pending = this._pending.get(msg.id);
        if (!pending) return;
        this._pending.delete(msg.id);
        if (msg.error) {
          pending.resolve(null); // non-fatal — skip bad files
        } else {
          pending.resolve(msg.result);
        }
        this._drain();
      });
      worker.on('error', (err) => {
        // Worker crashed — resolve all pending as null and respawn
        console.warn(`[CARTO] Worker error: ${err.message}`);
        for (const [id, p] of this._pending) {
          p.resolve(null);
        }
        this._pending.clear();
      });
      this._workers.push({ worker, busy: false });
    }
    this._ready = true;
  }

  _drain() {
    if (this._queue.length === 0) return;
    const free = this._workers.find(w => !w.busy);
    if (!free) return;
    const task = this._queue.shift();
    free.busy = true;
    free.worker.once('message', () => { free.busy = false; });
    free.worker.postMessage(task);
  }

  _send(task) {
    return new Promise((resolve) => {
      this._pending.set(task.id, { resolve });
      const free = this._workers.find(w => !w.busy);
      if (free) {
        free.busy = true;
        free.worker.postMessage(task);
        // Mark free when result comes back
        const originalResolve = this._pending.get(task.id).resolve;
        this._pending.set(task.id, {
          resolve: (val) => {
            free.busy = false;
            originalResolve(val);
            this._drain();
          }
        });
      } else {
        this._queue.push(task);
      }
    });
  }

  /**
   * processFiles(filePaths, projectRoot, onProgress)
   * Returns array of extracted results (nulls filtered out).
   */
  async processFiles(filePaths, projectRoot, onProgress) {
    if (!this._ready) this._spawn();

    let completed = 0;
    const total = filePaths.length;

    const tasks = filePaths.map((filePath) => {
      const id = ++this._idCounter;
      return this._send({ id, filePath, projectRoot }).then((result) => {
        completed++;
        if (onProgress) onProgress(Math.round((completed / total) * 100));
        return result;
      });
    });

    const results = await Promise.all(tasks);
    return results.filter(Boolean);
  }

  terminate() {
    for (const { worker } of this._workers) {
      worker.terminate();
    }
    this._workers = [];
    this._ready = false;
  }
}

module.exports = { WorkerPool, POOL_SIZE };
