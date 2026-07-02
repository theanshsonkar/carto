'use strict';

/**
 * Intent — user-stated project context.
 *
 * Rules in the rule engine gate on `product_type` (e.g. "saas-with-auth")
 * so a rule crafted for Next.js + Supabase doesn't fire on an Express
 * API server. This module owns reading, writing, and auto-detecting the
 * intent file that carries that gate.
 *
 * File location:
 *   .carto/intent.json
 *
 * Shape:
 *   {
 *     version: '0.1',
 *     product_type: 'saas-with-auth' | 'unsupported',
 *     stack: ['Next.js', 'Supabase', ...],
 *     notes: [{ ts: 1234567890, text: 'single-user for now' }],
 *     updated_at: <unix ms>
 *   }
 *
 * The file is safe to edit by hand. Every write bumps `updated_at`.
 * Notes accumulate — set_intent appends, never overwrites.
 *
 * Auto-detection (autoDetect) reads package.json and infers a product
 * type from installed packages. Called from `carto init` when
 * `.carto/intent.json` doesn't already exist, and can be re-run
 * manually to refresh.
 */

const fs = require('fs');
const path = require('path');

const INTENT_VERSION = '0.1';

function intentPath(projectRoot) {
  return path.join(projectRoot, '.carto', 'intent.json');
}

/**
 * loadIntent(projectRoot) → intent | null
 *
 * Returns the intent object, or null if the file doesn't exist / is
 * unreadable / is malformed. Never throws.
 */
function loadIntent(projectRoot) {
  const p = intentPath(projectRoot);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * saveIntent(projectRoot, intent) → intent
 *
 * Writes the intent atomically (tmp file + rename). Stamps `updated_at`.
 * Creates `.carto/` if needed. Returns the object as written (with
 * defaults filled in).
 */
function saveIntent(projectRoot, intent) {
  const cartoDir = path.join(projectRoot, '.carto');
  if (!fs.existsSync(cartoDir)) fs.mkdirSync(cartoDir, { recursive: true });

  const out = {
    version: INTENT_VERSION,
    product_type: (intent && intent.product_type) || 'unsupported',
    stack: Array.isArray(intent && intent.stack) ? intent.stack : [],
    notes: Array.isArray(intent && intent.notes) ? intent.notes : [],
    updated_at: Date.now(),
  };

  const tmp = intentPath(projectRoot) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, intentPath(projectRoot));
  return out;
}

/**
 * setIntent(projectRoot, patch) → intent
 *
 * Merge helper — the shape the MCP `set_intent` tool uses. `patch` can
 * carry any subset of { product_type, stack, note } where `note` is a
 * single string that gets appended (with a timestamp) to the notes
 * array. `stack` fully replaces the previous array (rare — usually set
 * once by autoDetect).
 */
function setIntent(projectRoot, patch) {
  const current = loadIntent(projectRoot) || {
    version: INTENT_VERSION,
    product_type: 'unsupported',
    stack: [],
    notes: [],
  };
  if (patch && typeof patch.product_type === 'string') {
    current.product_type = patch.product_type;
  }
  if (patch && Array.isArray(patch.stack)) {
    current.stack = patch.stack.slice();
  }
  if (patch && typeof patch.note === 'string' && patch.note.trim().length > 0) {
    current.notes = Array.isArray(current.notes) ? current.notes : [];
    current.notes.push({ ts: Date.now(), text: patch.note.trim().slice(0, 2000) });
  }
  return saveIntent(projectRoot, current);
}

/**
 * autoDetect(projectRoot) → intent
 *
 * Reads package.json and infers a product type. Conservative: only
 * emits 'saas-with-auth' when we see BOTH a Next.js-style framework
 * AND a Supabase (or Clerk / NextAuth) auth dependency. Anything else
 * → 'unsupported'.
 *
 * The zero-false-positive gate on the rule engine means we'd rather
 * mis-classify a real SaaS repo as unsupported than fire rules on the
 * wrong stack.
 *
 * If .carto/intent.json already exists, this preserves manually-added
 * notes and only refreshes the auto-detected fields.
 */
function autoDetect(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  let pkg = {};
  try {
    if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch { /* fall through — unsupported */ }

  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

  const stack = [];
  const hasNext = has('next');
  if (hasNext) stack.push('Next.js');

  const supabase = has('@supabase/supabase-js') || has('supabase');
  if (supabase) stack.push('Supabase');

  const clerk = has('@clerk/nextjs') || has('@clerk/clerk-sdk-node') || has('clerk');
  if (clerk) stack.push('Clerk');

  const nextauth = has('next-auth') || has('nextauth');
  if (nextauth) stack.push('NextAuth');

  const prisma = has('@prisma/client') || has('prisma');
  if (prisma) stack.push('Prisma');

  // Conservative gate: SaaS-with-auth requires (Next.js) AND (a
  // recognized auth surface). Any other combination is unsupported
  // for now.
  const hasAuthSurface = supabase || clerk || nextauth;
  const product_type = hasNext && hasAuthSurface ? 'saas-with-auth' : 'unsupported';

  const prior = loadIntent(projectRoot);
  const merged = {
    version: INTENT_VERSION,
    product_type,
    stack,
    notes: (prior && Array.isArray(prior.notes)) ? prior.notes : [],
  };
  return saveIntent(projectRoot, merged);
}

module.exports = {
  INTENT_VERSION,
  intentPath,
  loadIntent,
  saveIntent,
  setIntent,
  autoDetect,
};
