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
      domains[key] = { keywords: value.map(String), anchor: [] };
    } else if (value && typeof value === 'object') {
      domains[key] = {
        keywords: Array.isArray(value.keywords) ? value.keywords.map(String) : [],
        anchor: Array.isArray(value.anchor) ? value.anchor.map(String) : [],
      };
    }
  }

  return { domains };
}

/**
 * applyAnchors(fileAssignments, config) → fileAssignments (mutated)
 *
 * Forces anchor files into their configured domain.
 * Then propagates via 2-pass graph expansion from the existing
 * buildFileAssignments logic in domains.js.
 */
function applyAnchors(fileAssignments, config) {
  if (!config || !config.domains) return fileAssignments;

  for (const [domainName, domainConfig] of Object.entries(config.domains)) {
    for (const anchorPath of domainConfig.anchor || []) {
      // Normalize path separators
      const normalized = anchorPath.replace(/\\/g, '/');
      if (fileAssignments.has(normalized)) {
        fileAssignments.set(normalized, domainName);
      }
    }
  }

  return fileAssignments;
}

module.exports = { loadCartoConfig, applyAnchors };
