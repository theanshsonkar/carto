#!/usr/bin/env node
'use strict';

// Postinstall script — checks tree-sitter grammar availability and prints
// actionable guidance if any failed to install. Always exits 0.

if (process.env.CARTO_NO_POSTINSTALL === '1') process.exit(0);

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

const failed = [];
for (const g of GRAMMARS) {
  try { require(g.pkg); } catch { failed.push(g); }
}

if (failed.length === 0) process.exit(0);

// Print guidance
const langs = failed.map(g => g.langs).join(', ');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let fix;
if (isWin) {
  fix = 'Install "Desktop development with C++" from https://aka.ms/vs/17/release/vs_BuildTools.exe then re-run: npm rebuild';
} else if (isMac) {
  fix = 'Run: xcode-select --install && npm rebuild';
} else {
  fix = 'Run: sudo apt-get install -y build-essential && npm rebuild   (or equivalent for your distro)';
}

console.log('');
console.log('[CARTO] ⚠️  Some tree-sitter grammars failed to install.');
console.log(`[CARTO]    Affected languages: ${langs}`);
console.log('[CARTO]    These languages will use regex-only extraction (less accurate).');
console.log(`[CARTO]    To fix: ${fix}`);
console.log('');
