'use strict';

/**
 * tools.js — Built-in filesystem + bash tools the SWE-bench agent uses.
 *
 * Five tools cover ~95% of what an agent needs to solve a SWE-bench
 * task: read, list, write, edit (string replace), and run a bash
 * command. Everything is sandboxed to the scratch dir — absolute paths
 * outside it are rejected.
 *
 * Schemas follow Anthropic's `input_schema` shape so they plug straight
 * into the Messages API as `tools: [...]`. The handler functions return
 * a string (which becomes the tool_result content).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_READ_BYTES = 256 * 1024;       // 256 KB per read — keeps tokens bounded
const MAX_LIST_ENTRIES = 1000;
const MAX_BASH_BUFFER = 1024 * 1024;     // 1 MB per command output
const BASH_TIMEOUT_MS = 30_000;          // 30 s — slow tests get cut

function resolveSafe(scratchDir, rel) {
  if (typeof rel !== 'string') throw new Error('path must be a string');
  const abs = path.isAbsolute(rel) ? rel : path.resolve(scratchDir, rel);
  const resolvedScratch = path.resolve(scratchDir);
  // Path-traversal guard: every path must stay inside scratchDir.
  if (abs !== resolvedScratch && !abs.startsWith(resolvedScratch + path.sep)) {
    throw new Error(`refusing path outside scratch dir: ${rel}`);
  }
  return abs;
}

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file (UTF-8). Truncates at 256 KB. Pass paths relative to the project root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative path to read.' } },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory. Returns entries one per line, suffixed with / for subdirectories.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative directory.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the supplied contents. Use sparingly — prefer edit_file for in-place changes.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Project-relative path to write.' },
        content: { type: 'string', description: 'Full UTF-8 file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace the FIRST occurrence of old_string with new_string in the file. old_string must match exactly.',
    input_schema: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'Project-relative path.' },
        old_string: { type: 'string', description: 'The exact text to find.' },
        new_string: { type: 'string', description: 'The text to substitute in.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_bash',
    description: 'Execute a bash command in the project root. 30 s timeout, 1 MB output cap. Useful for grep, find, running tests.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Bash command to run.' } },
      required: ['command'],
    },
  },
];

function makeExecutor(scratchDir) {
  return async function execute(name, input) {
    try {
      switch (name) {
        case 'read_file': {
          const abs = resolveSafe(scratchDir, input.path);
          const buf = fs.readFileSync(abs);
          const truncated = buf.length > MAX_READ_BYTES;
          const text = buf.slice(0, MAX_READ_BYTES).toString('utf8');
          return truncated ? text + '\n\n…[truncated at 256 KB]' : text;
        }
        case 'list_directory': {
          const abs = resolveSafe(scratchDir, input.path);
          const entries = fs.readdirSync(abs, { withFileTypes: true })
            .slice(0, MAX_LIST_ENTRIES)
            .map((e) => e.isDirectory() ? `${e.name}/` : e.name)
            .sort();
          return entries.join('\n') || '(empty directory)';
        }
        case 'write_file': {
          const abs = resolveSafe(scratchDir, input.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, input.content, 'utf8');
          return `wrote ${input.content.length} bytes to ${input.path}`;
        }
        case 'edit_file': {
          const abs = resolveSafe(scratchDir, input.path);
          if (!fs.existsSync(abs)) return `error: file not found: ${input.path}`;
          const orig = fs.readFileSync(abs, 'utf8');
          if (!orig.includes(input.old_string)) {
            return `error: old_string not found in ${input.path}. Read the file first to see exact contents.`;
          }
          const next = orig.replace(input.old_string, input.new_string);
          fs.writeFileSync(abs, next, 'utf8');
          return `edited ${input.path}: -${input.old_string.length} +${input.new_string.length} chars`;
        }
        case 'run_bash': {
          let out;
          try {
            out = execFileSync('bash', ['-lc', input.command], {
              cwd: scratchDir,
              encoding: 'utf8',
              maxBuffer: MAX_BASH_BUFFER,
              timeout: BASH_TIMEOUT_MS,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (err) {
            const stdout = err.stdout || '';
            const stderr = err.stderr || '';
            return [
              `bash exited with code ${err.status ?? 'unknown'}`,
              stdout && '--- stdout ---\n' + stdout.toString(),
              stderr && '--- stderr ---\n' + stderr.toString(),
            ].filter(Boolean).join('\n');
          }
          return out.toString() || '(no output)';
        }
        default:
          return `error: unknown tool ${name}`;
      }
    } catch (err) {
      return `error: ${err.message || err}`;
    }
  };
}

module.exports = { TOOL_DEFINITIONS, makeExecutor };
