const https = require('https');
const pkg = require('../../package.json');

/**
 * Fire-and-forget version check against the npm registry.
 * Prints a one-liner to stderr if a newer version exists.
 * Never throws, never blocks — safe to call without await.
 */
function checkForUpdate() {
  const req = https.get('https://registry.npmjs.org/carto-md/latest', {
    timeout: 3000,
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        const latest = data.version;
        if (latest && latest !== pkg.version && isNewer(latest, pkg.version)) {
          process.stderr.write(
            `[CARTO] Update available: ${pkg.version} → ${latest}  |  npm install -g carto-md\n`
          );
        }
      } catch (_) {
        // malformed JSON — ignore
      }
    });
  });

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

module.exports = { checkForUpdate };
