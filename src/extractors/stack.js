const path = require('path');
const fs = require('fs');

/**
 * Detects the tech stack from file contents and package manifests.
 * Scans only files Carto already watches — no new file scanning.
 * Returns deduplicated array of stack items, max 6.
 */

// Python: import/from patterns → stack name
const PYTHON_STACK = {
  'fastapi': 'FastAPI',
  'django': 'Django',
  'flask': 'Flask',
  'sqlalchemy': 'SQLAlchemy',
  'boto3': 'AWS',
  'openai': 'OpenAI',
  'anthropic': 'Claude API',
  'google.generativeai': 'Gemini',
  'google-generativeai': 'Gemini',
  'redis': 'Redis',
  'celery': 'Celery',
  'pydantic': 'Pydantic',
  'stripe': 'Stripe',
};

// JS/TS: import/require patterns → stack name
const JS_STACK = {
  'next': 'Next.js',
  'express': 'Express',
  'fastify': 'Fastify',
  'react': 'React',
  '@prisma/client': 'Prisma',
  'prisma': 'Prisma',
  'mongoose': 'MongoDB',
  'sequelize': 'Sequelize',
  'drizzle-orm': 'Drizzle',
  'drizzle': 'Drizzle',
  'redis': 'Redis',
  'ioredis': 'Redis',
  'openai': 'OpenAI',
  '@anthropic-ai/sdk': 'Claude API',
  'anthropic': 'Claude API',
  'stripe': 'Stripe',
  'firebase': 'Firebase',
  'firebase-admin': 'Firebase',
  '@supabase/supabase-js': 'Supabase',
  'supabase': 'Supabase',
  '@clerk/nextjs': 'Clerk',
  '@clerk/clerk-sdk-node': 'Clerk',
  'clerk': 'Clerk',
  'next-auth': 'NextAuth',
  'nextauth': 'NextAuth',
};

const MAX_STACK_ITEMS = 6;

/**
 * detectStackFromContent(content, filename) → Array<string>
 * Scans a single file's content for known stack imports.
 */
function detectStackFromContent(content, filename) {
  const ext = path.extname(filename).toLowerCase();
  const detected = new Set();

  if (ext === '.py') {
    // Python imports: import X, from X import Y
    for (const pkg of Object.keys(PYTHON_STACK)) {
      // Match: import fastapi, from fastapi import ..., from fastapi.xxx import ...
      const pattern = new RegExp(`(?:^|\\n)\\s*(?:import\\s+${escapeRegex(pkg)}|from\\s+${escapeRegex(pkg)}(?:\\.|\\s))`, 'm');
      if (pattern.test(content)) {
        detected.add(PYTHON_STACK[pkg]);
      }
    }
  } else if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    // JS/TS imports: import ... from 'pkg', require('pkg')
    for (const pkg of Object.keys(JS_STACK)) {
      const escaped = escapeRegex(pkg);
      // import ... from 'pkg' or import 'pkg'
      const importPattern = new RegExp(`(?:from|import)\\s+['"]${escaped}(?:[/'"])`);
      // require('pkg')
      const requirePattern = new RegExp(`require\\s*\\(\\s*['"]${escaped}(?:[/'"])`);
      if (importPattern.test(content) || requirePattern.test(content)) {
        detected.add(JS_STACK[pkg]);
      }
    }
  }

  return [...detected];
}

/**
 * detectStackFromPackageJson(projectRoot) → Array<string>
 * Reads package.json dependencies for known stack packages.
 */
function detectStackFromPackageJson(projectRoot) {
  const detected = new Set();
  const pkgPath = path.join(projectRoot, 'package.json');

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

    for (const dep of Object.keys(allDeps)) {
      const depLower = dep.toLowerCase();
      if (JS_STACK[depLower]) {
        detected.add(JS_STACK[depLower]);
      }
      // Also check without scope for scoped packages
      if (JS_STACK[dep]) {
        detected.add(JS_STACK[dep]);
      }
    }
  } catch {
    // No package.json or can't read — that's fine
  }

  return [...detected];
}

/**
 * detectStackFromRequirements(projectRoot) → Array<string>
 * Reads requirements.txt for known Python packages.
 */
function detectStackFromRequirements(projectRoot) {
  const detected = new Set();
  const reqPath = path.join(projectRoot, 'requirements.txt');

  try {
    const content = fs.readFileSync(reqPath, 'utf-8').toLowerCase();
    for (const pkg of Object.keys(PYTHON_STACK)) {
      // Match package name at start of line, possibly followed by ==, >=, etc.
      const pattern = new RegExp(`^${escapeRegex(pkg.replace('.', '-'))}\\s*[=><~!\\[]`, 'm');
      const simplePattern = new RegExp(`^${escapeRegex(pkg.replace('.', '-'))}\\s*$`, 'm');
      if (pattern.test(content) || simplePattern.test(content)) {
        detected.add(PYTHON_STACK[pkg]);
      }
    }
  } catch {
    // No requirements.txt — that's fine
  }

  return [...detected];
}

/**
 * buildStackLine(fileContents, projectRoot) → string
 * Aggregates stack detection across all watched files + manifests.
 * Returns a comma-separated string of max 6 items, or empty string.
 */
function buildStackLine(fileContents, projectRoot) {
  const allDetected = new Set();

  // Scan manifests
  for (const item of detectStackFromPackageJson(projectRoot)) allDetected.add(item);
  for (const item of detectStackFromRequirements(projectRoot)) allDetected.add(item);

  // Scan file contents
  for (const { filePath, content } of fileContents) {
    const items = detectStackFromContent(content, filePath);
    for (const item of items) allDetected.add(item);
  }

  const sorted = [...allDetected].sort();
  return sorted.slice(0, MAX_STACK_ITEMS);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { buildStackLine, detectStackFromContent };
