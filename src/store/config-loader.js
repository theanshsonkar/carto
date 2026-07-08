'use strict';

const fs = require('fs');
const path = require('path');

/**
 * loadCartoConfig(projectRoot) → { domains } | null
 *
 * Reads `carto.config.json` from the project root.
 * Schema:
 *   { "domains": { "AUTH": { "keywords": [...], "anchor": ["src/auth/session.ts"] } } }
 *
 * Legacy flat-array form (back-compat with README example):
 *   { "domains": { "AUTH": ["auth", "login"] } }
 *   → normalized to { "AUTH": { "keywords": ["auth", "login"], "anchor": [] } }
 *
 * Returns null if no config file or malformed (with console.warn).
 */
function loadCartoConfig(projectRoot) {
  const configPath = path.join(projectRoot, 'carto.config.json');
  if (!fs.existsSync(configPath)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.warn(`[CARTO] ⚠️  Malformed carto.config.json: ${e.message}. Using defaults.`);
    return null;
  }

  if (!raw || typeof raw !== 'object' || !raw.domains || typeof raw.domains !== 'object') {
    console.warn('[CARTO] ⚠️  carto.config.json missing "domains" object. Using defaults.');
    return null;
  }

  // Normalize domains
  const domains = {};
  for (const [name, value] of Object.entries(raw.domains)) {
    const key = name.toUpperCase();
    if (Array.isArray(value)) {
      // Legacy flat-array form: ["keyword1", "keyword2"]
      domains[key] = { keywords: value.map(String), anchor: [], globs: [] };
    } else if (value && typeof value === 'object') {
      domains[key] = {
        keywords: Array.isArray(value.keywords) ? value.keywords.map(String) : [],
        anchor: Array.isArray(value.anchor) ? value.anchor.map(String) : [],
        // Declared path globs → domain. These are the PRIMARY, deterministic
        // source of truth: any file matching a domain's globs is assigned that
        // domain regardless of what inference would have guessed (CF-3).
        globs: Array.isArray(value.globs) ? value.globs.map(String) : [],
      };
    }
  }

  return { domains };
}

/**
 * globToRegExp(glob) → RegExp
 *
 * Minimal, dependency-free glob → RegExp compiler for path matching.
 * Supports the subset needed for domain declarations:
 *   **  → any number of path segments (including none)
 *   *   → any run of characters except '/'
 *   ?   → a single character except '/'
 * Everything else is matched literally. Paths are compared with '/'
 * separators (callers normalize backslashes first). Anchored full-match.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**' → match across segment boundaries.
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * applyDeclaredGlobs(fileAssignments, config, confidenceByFile?) → fileAssignments
 *
 * Repo-declared globs are the PRIMARY source: any file whose path matches a
 * domain's declared globs is force-assigned to that domain (confidence 1.0),
 * overriding whatever inference produced. When a file matches globs from more
 * than one domain, the first matching domain in declaration order wins (config
 * authors control precedence by ordering). Mutates and returns fileAssignments.
 */
function applyDeclaredGlobs(fileAssignments, config, confidenceByFile = null) {
  if (!config || !config.domains) return fileAssignments;

  // Precompile globs per domain, preserving declaration order.
  const compiled = [];
  for (const [domainName, domainConfig] of Object.entries(config.domains)) {
    const globs = (domainConfig.globs || []).map(globToRegExp);
    if (globs.length > 0) compiled.push([domainName, globs]);
  }
  if (compiled.length === 0) return fileAssignments;

  for (const fp of fileAssignments.keys()) {
    const normalized = fp.replace(/\\/g, '/');
    for (const [domainName, globs] of compiled) {
      if (globs.some(re => re.test(normalized))) {
        fileAssignments.set(fp, domainName);
        if (confidenceByFile instanceof Map) confidenceByFile.set(fp, 1.0);
        break;
      }
    }
  }

  return fileAssignments;
}

/**
 * applyAnchors(fileAssignments, config) → fileAssignments (mutated)
 *
 * Forces anchor files into their configured domain.
 * Then propagates via 2-pass graph expansion from the existing
 * buildFileAssignments logic in domains.js.
 */
function applyAnchors(fileAssignments, config, confidenceByFile = null) {
  if (!config || !config.domains) return fileAssignments;

  for (const [domainName, domainConfig] of Object.entries(config.domains)) {
    for (const anchorPath of domainConfig.anchor || []) {
      // Normalize path separators
      const normalized = anchorPath.replace(/\\/g, '/');
      if (fileAssignments.has(normalized)) {
        fileAssignments.set(normalized, domainName);
        if (confidenceByFile instanceof Map) confidenceByFile.set(normalized, 1.0);
      }
    }
  }

  return fileAssignments;
}

module.exports = { loadCartoConfig, applyAnchors, applyDeclaredGlobs, globToRegExp };
