'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getHashPath(projectRoot) {
  return path.join(projectRoot, '.carto', 'hashes.json');
}

function loadHashes(projectRoot) {
  try {
    const raw = fs.readFileSync(getHashPath(projectRoot), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveHashes(projectRoot, hashes) {
  const hashPath = getHashPath(projectRoot);
  const tmp = hashPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(hashes, null, 2), 'utf-8');
    fs.renameSync(tmp, hashPath);
  } catch {}
}

function hashContent(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * computeChangedFiles(filePaths, storedHashes, projectRoot)
 * Returns { changed: string[], unchanged: string[], hashes: object }
 * changed = files whose content hash differs from stored
 * unchanged = files whose hash matches — can skip re-parsing
 */
function computeChangedFiles(filePaths, storedHashes, projectRoot) {
  const changed = [];
  const unchanged = [];
  const newHashes = { ...storedHashes };

  for (const filePath of filePaths) {
    const relPath = path.relative(projectRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const hash = hashContent(content);
    if (storedHashes[relPath] === hash) {
      unchanged.push(filePath);
    } else {
      changed.push(filePath);
      newHashes[relPath] = hash;
    }
  }

  return { changed, unchanged, hashes: newHashes };
}

/**
 * updateFileHash(projectRoot, relPath, content)
 * Updates the hash for a single file after incremental re-index.
 */
function updateFileHash(projectRoot, relPath, content) {
  const hashes = loadHashes(projectRoot);
  hashes[relPath] = hashContent(content);
  saveHashes(projectRoot, hashes);
}

/**
 * removeFileHash(projectRoot, relPath)
 * Removes hash entry when a file is deleted.
 */
function removeFileHash(projectRoot, relPath) {
  const hashes = loadHashes(projectRoot);
  delete hashes[relPath];
  saveHashes(projectRoot, hashes);
}

module.exports = { loadHashes, saveHashes, hashContent, computeChangedFiles, updateFileHash, removeFileHash };
