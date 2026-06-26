'use strict';

/**
 * ACP safety primitives — sandboxed path resolution + command exec.
 *
 * Any future ACP tool that reads or writes files, or runs commands, must
 * funnel through these helpers. The pattern mirrors the sandbox in
 * `bench/swe-bench/tools.js`.
 *
 *   - `resolveSafe(workingDir, relPath)` — refuses `..`-escapes, absolute
 *     paths, and symlink escapes; returns the canonical absolute path.
 *   - `safeRunCommand({ workingDir, cmd, args, timeoutMs, maxOutputBytes })`
 *     — executes a child process scoped to `workingDir`, with bounded
 *     output and a wall-clock cap. Never executes shell metacharacters.
 *
 * Both throw on safety violation. Callers wrap and report errors back
 * to the LLM as a tool error.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

/**
 * resolveSafe(workingDir, relPath) → absolute path
 *
 * Throws if `relPath` is absolute, contains `..` that escapes workingDir,
 * or resolves outside workingDir via symlink. The returned path is
 * normalized, exists-checked (when `mustExist: true`), and ready to pass
 * to fs APIs.
 */
function resolveSafe(workingDir, relPath, { mustExist = false } = {}) {
  if (typeof workingDir !== 'string' || workingDir.length === 0) {
    throw new Error('resolveSafe: workingDir required');
  }
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('resolveSafe: relPath required');
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`resolveSafe: absolute paths are not allowed: ${relPath}`);
  }

  const baseAbs = path.resolve(workingDir);
  const candidate = path.resolve(baseAbs, relPath);

  // 1. Path-component containment check (catches ../../../etc/passwd).
  const rel = path.relative(baseAbs, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`resolveSafe: path escapes workingDir: ${relPath}`);
  }

  // 2. Symlink containment check — realpath of the target (if it exists)
  //    must still be under baseAbs.
  if (fs.existsSync(candidate)) {
    let real;
    try { real = fs.realpathSync(candidate); } catch (err) {
      throw new Error(`resolveSafe: cannot realpath ${candidate}: ${err.message}`);
    }
    const baseReal = fs.realpathSync(baseAbs);
    const relReal = path.relative(baseReal, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new Error(`resolveSafe: symlink escapes workingDir: ${relPath}`);
    }
  } else if (mustExist) {
    throw new Error(`resolveSafe: file does not exist: ${relPath}`);
  }

  return candidate;
}

/**
 * safeRunCommand({ workingDir, cmd, args, timeoutMs, maxOutputBytes })
 * → Promise<{ stdout, stderr, exitCode }>
 *
 * Uses execFile (not exec) so the shell never interprets the command;
 * `args` are passed verbatim to the OS, so injection via metacharacters
 * is impossible. Working directory pinned to workingDir; stdin closed.
 *
 * Output is capped at `maxOutputBytes` (default 1 MB) and killed at
 * `timeoutMs` (default 30s) — same caps as the SWE-bench sandbox.
 */
function safeRunCommand({
  workingDir, cmd, args = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return Promise.reject(new Error('safeRunCommand: cmd required'));
  }
  if (!Array.isArray(args)) {
    return Promise.reject(new Error('safeRunCommand: args must be an array'));
  }
  // Refuse shell metacharacters in cmd itself.
  if (/[\s;&|`$<>]/.test(cmd)) {
    return Promise.reject(new Error(`safeRunCommand: cmd contains shell metacharacters: ${cmd}`));
  }
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: path.resolve(workingDir),
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      shell: false,
    }, (err, stdout, stderr) => {
      if (err && err.killed && err.signal === 'SIGTERM') {
        return reject(new Error(`safeRunCommand: timed out after ${timeoutMs}ms`));
      }
      if (err && err.code === 'ENOBUFS') {
        return reject(new Error(`safeRunCommand: output exceeded ${maxOutputBytes} bytes`));
      }
      resolve({
        stdout: typeof stdout === 'string' ? stdout : (stdout ? stdout.toString() : ''),
        stderr: typeof stderr === 'string' ? stderr : (stderr ? stderr.toString() : ''),
        exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
      });
    });
  });
}

module.exports = {
  resolveSafe,
  safeRunCommand,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
};
