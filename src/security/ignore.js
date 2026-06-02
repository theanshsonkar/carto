const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_PATTERNS = [
  // Env files
  '.env',
  '.env.*',

  // Generic secret/credential name globs
  '*secret*',
  '*SECRET*',
  '*password*',
  '*PASSWORD*',
  '*credential*',
  '*CREDENTIAL*',
  '*private_key*',
  '*PRIVATE_KEY*',

  // Generic key/cert extensions
  '*.pem',
  '*.key',

  // SSH keys (no extension, won't be caught by *.key)
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ed25519.pub',
  'id_ecdsa',
  'id_ecdsa.pub',
  'id_dsa',
  'id_dsa.pub',
  'authorized_keys',
  'known_hosts',

  // Package registry credentials
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.pip/pip.conf',
  '.gem/credentials',
  '.cargo/credentials.toml',

  // Cloud / K8s / Docker
  'kubeconfig',
  '*.kubeconfig',
  '.docker/config.json',
  '.dockercfg',
  '*service-account*.json',
  '*service_account*.json',
  '*-credentials.json',
  '.aws/credentials',
  '.aws/config',
  '.gcp/*',
  '.gnupg/*',

  // Cert / keystore formats (defense in depth — already excluded by CODE_EXTS today)
  '*.crt',
  '*.cer',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.pkcs12'

  // NOTE: deliberately NOT including `*api_key*` / `*api-key*` globs.
  // Real SaaS projects (cal.com, supabase, fastapi, zed) ship legitimate
  // feature code under these filenames — `api_key.py`, `api-keys-service.ts`,
  // `language_model/src/api_key.rs` — and a broad glob would silently delete
  // 17+ files per repo from the import graph. Raw-credential files literally
  // named `api_key.txt` are unusual; the realistic threat surface (.env,
  // *credentials.json, .npmrc, id_rsa, kubeconfig, *secret*) is covered above.
];

/**
 * parseCartoIgnore(projectRoot) → isIgnored(filePath) → boolean
 *
 * Reads .cartoignore from the project root (if it exists) and merges with defaults.
 * Returns a function that checks if a file path matches any ignore pattern.
 */
function parseCartoIgnore(projectRoot) {
  let userPatterns = [];

  const ignoreFile = path.join(projectRoot, '.cartoignore');
  try {
    const content = fs.readFileSync(ignoreFile, 'utf-8');
    userPatterns = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    // No .cartoignore file — that's fine, use defaults only
  }

  const allPatterns = [...DEFAULT_IGNORE_PATTERNS, ...userPatterns];

  return function isIgnored(filePath) {
    const basename = path.basename(filePath);
    const relativePath = filePath; // can be absolute or relative

    for (const pattern of allPatterns) {
      if (matchPattern(basename, pattern) || matchPattern(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Simple glob matching supporting * as wildcard.
 */
function matchPattern(str, pattern) {
  // Escape regex special chars except *
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp(`^${regexStr}$`, 'i');
  return regex.test(str);
}

module.exports = { parseCartoIgnore, DEFAULT_IGNORE_PATTERNS };
