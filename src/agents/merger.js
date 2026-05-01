const fs = require('fs');

const START_MARKER = '<!-- CARTO:AUTO:START -->';
const END_MARKER = '<!-- CARTO:AUTO:END -->';

/**
 * Safely writes auto-generated content into AGENTS.md between markers.
 * Never touches anything outside the markers.
 * Uses atomic write (write to .tmp, then rename) to prevent corruption.
 *
 * Cases:
 *   1. File does not exist → create with markers + content
 *   2. File exists, no markers → append markers + content at end
 *   3. File exists, markers reversed (END before START) → treat as corrupted, append
 *   4. File exists, valid markers → replace ONLY between markers
 */
function mergeIntoAgentsMd(agentsPath, autoContent) {
  const markerBlock = `${START_MARKER}\n${autoContent}\n${END_MARKER}`;

  // Case 1: File does not exist
  if (!fs.existsSync(agentsPath)) {
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, markerBlock + '\n', 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
    return;
  }

  let existing;
  try {
    existing = fs.readFileSync(agentsPath, 'utf-8');
  } catch (err) {
    console.error(`[CARTO] Error reading AGENTS.md: ${err.message}`);
    return;
  }

  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  // Case 2: No markers found
  if (startIdx === -1 || endIdx === -1) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, existing + separator + markerBlock + '\n', 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
    return;
  }

  // Case 3: Markers reversed or overlapping — treat as corrupted
  if (startIdx >= endIdx) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, existing + separator + markerBlock + '\n', 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
    console.warn('[CARTO] Warning: markers were reversed/corrupted — appended fresh marker block');
    return;
  }

  // Case 4: Valid markers — replace between them
  const before = existing.substring(0, startIdx);
  const after = existing.substring(endIdx + END_MARKER.length);
  try {
    const tmpPath = agentsPath + '.tmp';
    fs.writeFileSync(tmpPath, before + markerBlock + after, 'utf-8');
    fs.renameSync(tmpPath, agentsPath);
  } catch (err) {
    console.error(`[CARTO] Error writing AGENTS.md: ${err.message}`);
  }
}

module.exports = { mergeIntoAgentsMd, START_MARKER, END_MARKER };
