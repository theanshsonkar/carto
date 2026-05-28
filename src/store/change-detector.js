'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * detectChangedFiles(store, filePaths, projectRoot)
 *
 * Uses mtime+size short-circuit before hashing.
 * Returns { changed: string[], newFiles: string[], deleted: string[] }
 *
 * - changed: files whose content hash differs from stored
 * - newFiles: files not previously in the database
 * - deleted: files in DB but no longer on disk
 */
function detectChangedFiles(store, filePaths, projectRoot) {
  const changed = [];
  const newFiles = [];

  for (const relPath of filePaths) {
    const fullPath = require('path').resolve(projectRoot, relPath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      // File disappeared — will be handled by removeStaleFiles
      continue;
    }

    const mtime = Math.floor(stat.mtimeMs);
    const size = stat.size;

    const existing = store.getFileByPath(relPath);

    if (!existing) {
      // New file — must read and hash
      newFiles.push(relPath);
      continue;
    }

    // mtime+size short-circuit
    if (existing.mtime === mtime && existing.size === size) {
      continue; // unchanged
    }

    // mtime or size changed — read content and hash
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      console.warn(`[CARTO] Warning: Could not read ${relPath}: ${err.message}`);
      continue;
    }

    const hash = hashContent(content);

    if (existing.hash === hash) {
      // Content unchanged despite mtime change (e.g., touch command)
      store.updateFileMtime(relPath, mtime, size);
      continue;
    }

    // Content actually changed
    changed.push(relPath);
  }

  return { changed, newFiles };
}

/**
 * hashFile(fullPath) — Read and hash a file. Returns { content, hash } or null.
 */
function hashFile(fullPath) {
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    return { content, hash: hashContent(content) };
  } catch {
    return null;
  }
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = { detectChangedFiles, hashFile, hashContent };
