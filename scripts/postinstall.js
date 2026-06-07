#!/usr/bin/env node
'use strict';

// scripts/postinstall.js
//
// Three-step resilience flow:
//   1. Probe each tree-sitter grammar via require(). All ok → exit silent.
//   2. For each failure, try to fetch a prebuilt tarball from carto-md's
//      GitHub Release and extract into node_modules/<pkg>/. Re-probe.
//   3. Anything still broken → print OS-specific build guidance.
//
// Always exits 0 — install must never fail because of this script.
//
// Env opt-outs:
//   CARTO_NO_POSTINSTALL=1   skip the entire script
//   CARTO_NO_PREBUILD=1      skip step 2 (go straight from probe to guidance)

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

// ---- Static metadata ----

const GRAMMARS = [
  { pkg: 'tree-sitter-javascript', langs: 'JavaScript' },
  { pkg: 'tree-sitter-typescript', langs: 'TypeScript' },
  { pkg: 'tree-sitter-python', langs: 'Python' },
  { pkg: 'tree-sitter-go', langs: 'Go' },
  { pkg: 'tree-sitter-rust', langs: 'Rust' },
  { pkg: 'tree-sitter-java', langs: 'Java' },
  { pkg: 'tree-sitter-cpp', langs: 'C/C++' },
  { pkg: 'tree-sitter-c-sharp', langs: 'C#' },
];

// tree-sitter core lives in dependencies (not optionalDependencies). If its
// compile fails the whole `npm install` fails before this script runs, so
// we don't probe it — but the prebuilds workflow tarballs it too, in case
// future logic wants to recover from a corrupted node_modules.
const CORE_PKG = 'tree-sitter';

const DEFAULT_RELEASE_BASE_URL =
  'https://github.com/theanshsonkar/carto/releases/download';

// ---- Pure helpers (testable) ----

/**
 * detectLibc() → 'glibc' | 'musl' | null
 * Linux only. macOS / Windows return null because libc is part of the OS.
 */
function detectLibc() {
  if (process.platform !== 'linux') return null;
  try {
    if (fs.existsSync('/etc/alpine-release')) return 'musl';
  } catch { /* ignore */ }
  try {
    const report =
      process.report && typeof process.report.getReport === 'function'
        ? process.report.getReport()
        : null;
    const glibc = report && report.header && report.header.glibcVersionRuntime;
    if (glibc) return 'glibc';
    // process.report exists but no glibc field → musl runtime.
    if (report && report.header) return 'musl';
  } catch { /* ignore */ }
  // Conservative default: assume glibc. If wrong, fetch will 404 and the
  // caller falls through to build-toolchain guidance.
  return 'glibc';
}

/**
 * getPlatformInfo() → { platform, arch, libc, key }
 * key examples:
 *   'linux-x64-glibc'  'linux-x64-musl'
 *   'darwin-arm64'     'darwin-x64'
 *   'win32-x64'
 */
function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;
  const libc = detectLibc();
  const key =
    platform === 'linux'
      ? `linux-${arch}${libc ? '-' + libc : ''}`
      : `${platform}-${arch}`;
  return { platform, arch, libc, key };
}

/**
 * assetName({ pkg, pkgVersion, platformKey }) → string
 *   tree-sitter-typescript-v0.23.2-linux-x64-glibc.tar.gz
 *   tree-sitter-v0.25.0-darwin-arm64.tar.gz
 */
function assetName({ pkg, pkgVersion, platformKey }) {
  return `${pkg}-v${pkgVersion}-${platformKey}.tar.gz`;
}

/**
 * assetUrl({ cartoVersion, name, baseUrl? }) → string
 */
function assetUrl({ cartoVersion, name, baseUrl }) {
  const base = (baseUrl || DEFAULT_RELEASE_BASE_URL).replace(/\/+$/, '');
  return `${base}/v${cartoVersion}/${name}`;
}

/**
 * probeGrammars(requireFn?) → Array<{ pkg, langs, ok }>
 * Tests pass a fake require function; production passes nothing.
 */
function probeGrammars(requireFn) {
  const r = requireFn || require;
  return GRAMMARS.map((g) => {
    let ok = true;
    try { r(g.pkg); } catch { ok = false; }
    return { pkg: g.pkg, langs: g.langs, ok };
  });
}

/**
 * selectFailures(probeResults) → Array<{ pkg, langs }>
 */
function selectFailures(probeResults) {
  return probeResults.filter((r) => !r.ok).map((r) => ({ pkg: r.pkg, langs: r.langs }));
}

/**
 * resolveExpectedVersion(packageRoot, pkg) → string | null
 * Tries the installed copy first, then carto's own pinned constraint.
 * Returns null only if both lookups fail (or carto pins a non-exact range).
 */
function resolveExpectedVersion(packageRoot, pkg) {
  // 1. Installed copy (rare in the failure path, but possible if the binary
  //    is missing despite the JS being present — e.g., a botched rebuild).
  try {
    const installed = path.join(packageRoot, 'node_modules', pkg, 'package.json');
    if (fs.existsSync(installed)) {
      const meta = JSON.parse(fs.readFileSync(installed, 'utf-8'));
      if (meta && meta.version) return meta.version;
    }
  } catch { /* ignore */ }

  // 2. Constraint from carto's own package.json. Carto pins exact versions
  //    (e.g. "0.23.2"), so the raw string IS the version. If a future
  //    maintainer changes the pin to a range, this returns null and we
  //    skip the prebuild path for that package.
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'),
    );
    const constraint =
      (meta.optionalDependencies && meta.optionalDependencies[pkg]) ||
      (meta.dependencies && meta.dependencies[pkg]);
    if (constraint && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(constraint)) {
      return constraint;
    }
  } catch { /* ignore */ }

  return null;
}

// ---- I/O wrappers (stubbable via runMain options) ----

/**
 * fetchToFile(url, destPath, opts?) → Promise<void>
 * Throws on non-2xx (including 404). Follows redirects up to maxRedirects.
 */
function fetchToFile(url, destPath, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 30_000;
  const maxRedirects = (opts && opts.maxRedirects) != null ? opts.maxRedirects : 5;

  return new Promise((resolve, reject) => {
    const visited = new Set();

    const go = (currentUrl, redirectsLeft) => {
      if (visited.has(currentUrl)) {
        return reject(new Error(`redirect loop at ${currentUrl}`));
      }
      visited.add(currentUrl);

      const req = https.get(currentUrl, { timeout: timeoutMs }, (res) => {
        const sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            res.resume();
            return reject(new Error(`too many redirects from ${url}`));
          }
          const next = new URL(res.headers.location, currentUrl).toString();
          res.resume();
          return go(next, redirectsLeft - 1);
        }
        if (sc < 200 || sc >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${sc} fetching ${currentUrl}`));
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () =>
          out.close((err) => (err ? reject(err) : resolve())),
        );
        out.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          reject(err);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`timeout fetching ${currentUrl}`));
      });
    };

    go(url, maxRedirects);
  });
}

/**
 * extractTarGz(tarPath, destDir) → void
 * Uses the system `tar` command. Available on macOS, Linux, and modern
 * Windows (since Win10 1803 / Win Server 2019). If tar is unavailable the
 * call throws and the caller falls through to the build-toolchain guidance.
 */
function extractTarGz(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], {
    stdio: 'pipe', encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const err = result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`tar extract failed: ${String(err).trim()}`);
  }
}

/**
 * tryFetchPrebuild(opts) → Promise<{ ok: boolean, reason?: string, name?: string }>
 * Single-package prebuild attempt. Best-effort: never throws.
 */
async function tryFetchPrebuild({
  pkg, pkgVersion, cartoVersion, packageRoot, platformInfo,
  baseUrl, fetcher, extractor, log,
}) {
  const _fetch = fetcher || fetchToFile;
  const _extract = extractor || extractTarGz;
  const _log = log || (() => {});

  if (!pkgVersion) return { ok: false, reason: 'no-version' };

  const name = assetName({ pkg, pkgVersion, platformKey: platformInfo.key });
  const url = assetUrl({ cartoVersion, name, baseUrl });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-prebuild-'));
  const tarPath = path.join(tmpDir, name);
  const nodeModules = path.join(packageRoot, 'node_modules');

  try {
    _log(`[CARTO]   fetching ${name}`);
    await _fetch(url, tarPath, {});
    _log(`[CARTO]   extracting ${pkg}`);
    fs.mkdirSync(nodeModules, { recursive: true });
    _extract(tarPath, nodeModules);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, name, reason: err && err.message ? err.message : String(err) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * buildSpec12Message(remainingFailures, platform) → string[]
 * Returns the line array (caller decides how to print). Parameterised over
 * what's still failing.
 */
function buildSpec12Message(remainingFailures, platform) {
  const langs = remainingFailures.map((g) => g.langs).join(', ');
  let fix;
  if (platform === 'win32') {
    fix =
      'Install "Desktop development with C++" from ' +
      'https://aka.ms/vs/17/release/vs_BuildTools.exe then re-run: npm rebuild';
  } else if (platform === 'darwin') {
    fix = 'Run: xcode-select --install && npm rebuild';
  } else {
    fix =
      'Run: sudo apt-get install -y build-essential && npm rebuild   ' +
      '(or equivalent for your distro)';
  }
  return [
    '',
    '[CARTO] ⚠️  Some tree-sitter grammars failed to install.',
    `[CARTO]    Affected languages: ${langs}`,
    '[CARTO]    These languages will use regex-only extraction (less accurate).',
    `[CARTO]    To fix: ${fix}`,
    '',
  ];
}

// ---- Main entry (testable via runMain) ----

/**
 * runMain(options) → Promise<{ exitCode, attempted, succeeded, stillFailed, skipped? }>
 *   options.env, options.console, options.requireFn, options.fetcher,
 *   options.extractor, options.packageRoot, options.cartoVersion,
 *   options.platformInfo, options.baseUrl
 */
async function runMain(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const writer = opts.console || console;
  const log = (...a) => writer.log(...a);

  if (env.CARTO_NO_POSTINSTALL === '1') {
    return { exitCode: 0, attempted: 0, succeeded: 0, stillFailed: 0, skipped: true };
  }

  const initial = probeGrammars(opts.requireFn);
  const failures = selectFailures(initial);
  if (failures.length === 0) {
    return { exitCode: 0, attempted: 0, succeeded: 0, stillFailed: 0 };
  }

  const skipPrebuild = env.CARTO_NO_PREBUILD === '1';
  let attempted = 0;
  let succeeded = 0;
  // Track which failures remain after prebuild fetch — used by the second
  // probe to know which packages to recheck.
  let remaining = failures.slice();

  if (!skipPrebuild) {
    const packageRoot = opts.packageRoot || path.resolve(__dirname, '..');
    const cartoVersion =
      opts.cartoVersion ||
      JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')).version;
    const platformInfo = opts.platformInfo || getPlatformInfo();

    log(
      `[CARTO] ${failures.length} grammar(s) missing — ` +
        `trying prebuilt binaries for ${platformInfo.key}`,
    );

    const stillBroken = [];
    for (const failure of failures) {
      attempted += 1;
      const pkgVersion = resolveExpectedVersion(packageRoot, failure.pkg);
      const result = await tryFetchPrebuild({
        pkg: failure.pkg,
        pkgVersion,
        cartoVersion,
        packageRoot,
        platformInfo,
        baseUrl: opts.baseUrl,
        fetcher: opts.fetcher,
        extractor: opts.extractor,
        log,
      });
      if (result.ok) {
        succeeded += 1;
      } else {
        log(`[CARTO]   ${failure.pkg}: prebuild unavailable (${result.reason || 'unknown'})`);
        stillBroken.push(failure);
      }
    }
    remaining = stillBroken;
  }

  // Re-probe to pick up any freshly extracted packages. Node's module cache
  // doesn't cache failed requires, so a retry will see the new files.
  let stillFailing;
  if (succeeded > 0) {
    const second = probeGrammars(opts.requireFn);
    stillFailing = selectFailures(second);
  } else {
    stillFailing = remaining;
  }

  if (stillFailing.length === 0) {
    log(`[CARTO] ✓ Restored ${succeeded}/${attempted} grammar(s) from prebuilt binaries.`);
    return { exitCode: 0, attempted, succeeded, stillFailed: 0 };
  }

  for (const line of buildSpec12Message(stillFailing, process.platform)) log(line);
  return { exitCode: 0, attempted, succeeded, stillFailed: stillFailing.length };
}

// ---- Exports for tests ----

module.exports = {
  GRAMMARS,
  CORE_PKG,
  DEFAULT_RELEASE_BASE_URL,
  detectLibc,
  getPlatformInfo,
  assetName,
  assetUrl,
  probeGrammars,
  selectFailures,
  resolveExpectedVersion,
  fetchToFile,
  extractTarGz,
  tryFetchPrebuild,
  buildSpec12Message,
  runMain,
};

// ---- Direct invocation ----

if (require.main === module) {
  runMain({}).catch((err) => {
    // runMain is supposed to absorb all errors; this is belt + suspenders.
    try {
      console.log(`[CARTO] postinstall internal error: ${err && err.message}`);
    } catch { /* ignore */ }
    process.exit(0);
  });
}
