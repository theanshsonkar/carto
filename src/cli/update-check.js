'use strict';

const https = require('https');
const pkg = require('../../package.json');

/**
 * Fire-and-forget version check against the npm registry.
 *
 * Prints a visually distinct notice to stderr if a newer version is on npm.
 * Never throws, never blocks (3s socket timeout, ignores all errors) —
 * safe to call without await from any CLI command's entry point.
 *
 * Set `CARTO_NO_UPDATE_CHECK=1` to disable entirely (used in test runs and
 * by users who don't want the egress).
 */
function checkForUpdate() {
  if (process.env.CARTO_NO_UPDATE_CHECK) return;

  const req = https.get('https://registry.npmjs.org/carto-md/latest', {
    timeout: 3000,
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        const latest = data.version;
        if (latest && isNewer(latest, pkg.version)) {
          process.stderr.write(formatNotice(pkg.version, latest));
        }
      } catch (_) {
        // malformed JSON — ignore
      }
    });
  });

  // unref so the pending request never delays process exit on its own —
  // if the main command finishes first, the check is silently dropped.
  if (typeof req.unref === 'function') req.unref();

  req.on('timeout', () => { req.destroy(); });
  req.on('error', () => { /* offline / DNS failure — ignore */ });
}

/**
 * Returns true if `a` is a newer semver than `b`.
 * Only handles numeric major.minor.patch — good enough for this use case.
 */
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * formatNotice(current, latest) → multi-line stderr string.
 *
 * TTY-aware: emits ANSI yellow + bold when stderr is a TTY, plain text
 * otherwise (so piped output and CI logs stay clean).
 *
 * Format (TTY example, ★ in yellow, version + command in bold):
 *
 *     <blank line>
 *     [CARTO] ★ Update available: 2.0.1 → 2.0.5
 *     [CARTO]   Run: npm install -g carto-md
 *     <blank line>
 *
 * Two blank lines (one before, one after) separate the notice from
 * regular [CARTO] log output so the upgrade prompt stands out even when
 * it lands mid-progress (the check is fire-and-forget, so the response
 * arrives whenever the network resolves).
 */
function formatNotice(current, latest) {
  const useColor = !!process.stderr.isTTY && !process.env.NO_COLOR;
  const yellow = (s) => useColor ? `\x1b[33m${s}\x1b[0m` : s;
  const bold   = (s) => useColor ? `\x1b[1m${s}\x1b[0m`  : s;

  return [
    '',
    `${yellow('[CARTO] ★ Update available:')} ${bold(`${current} → ${latest}`)}`,
    `${yellow('[CARTO]   Run:')} ${bold('npm install -g carto-md')}`,
    '',
    ''
  ].join('\n');
}

module.exports = { checkForUpdate, isNewer, formatNotice };
