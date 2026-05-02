const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Modules under test ──────────────────────────────────────────────
const pythonPlugin = require('../src/extractors/languages/python');
const prismaPlugin = require('../src/extractors/languages/prisma');
const { mergeIntoAgentsMd, START_MARKER, END_MARKER } = require('../src/agents/merger');
const { extractImports } = require('../src/extractors/imports');

// ── Helpers ─────────────────────────────────────────────────────────
const results = { passed: 0, failed: 0, failures: [] };
const suiteTotals = {};

function test(suite, name, fn) {
  try {
    fn();
    results.passed++;
    suiteTotals[suite] = (suiteTotals[suite] || { pass: 0, fail: 0, total: 0 });
    suiteTotals[suite].pass++;
    suiteTotals[suite].total++;
  } catch (err) {
    results.failed++;
    suiteTotals[suite] = (suiteTotals[suite] || { pass: 0, fail: 0, total: 0 });
    suiteTotals[suite].fail++;
    suiteTotals[suite].total++;
    results.failures.push({ suite, name, message: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. Python extractor (5 tests)
// ═══════════════════════════════════════════════════════════════════

const pythonCode = `
@app.get("/health")
def health(): pass

@app.post("/analyze")
async def analyze(): pass

@app.patch("/user/{id}")
def update_user(): pass

class User(BaseModel):
    id: int
    email: str
    name: str
`;

test('Python extractor', 'Extracts 3 routes: GET /health, POST /analyze, PATCH /user/{id}', () => {
  const out = pythonPlugin.extract(pythonCode, 'app.py');
  assert.strictEqual(out.routes.length, 3);
  assert.deepStrictEqual(out.routes.map(r => `${r.method} ${r.path}`).sort(), [
    'GET /health',
    'PATCH /user/{id}',
    'POST /analyze',
  ]);
});

test('Python extractor', 'Extracts model User with fields id, email, name', () => {
  const out = pythonPlugin.extract(pythonCode, 'app.py');
  assert.strictEqual(out.models.length, 1);
  assert.strictEqual(out.models[0].className, 'User');
  assert.deepStrictEqual(out.models[0].fields.map(f => f.name), ['id', 'email', 'name']);
});

test('Python extractor', '@app.patch is not dropped', () => {
  const out = pythonPlugin.extract(pythonCode, 'app.py');
  const patchRoute = out.routes.find(r => r.method === 'PATCH');
  assert.ok(patchRoute, 'PATCH route must be present');
  assert.strictEqual(patchRoute.path, '/user/{id}');
  assert.strictEqual(patchRoute.functionName, 'update_user');
});

test('Python extractor', 'Field types are correct (id = int, email = str)', () => {
  const out = pythonPlugin.extract(pythonCode, 'app.py');
  const fields = out.models[0].fields;
  const idField = fields.find(f => f.name === 'id');
  const emailField = fields.find(f => f.name === 'email');
  assert.strictEqual(idField.type, 'int');
  assert.strictEqual(emailField.type, 'str');
});

test('Python extractor', 'Inline # comments do not leak into field types', () => {
  const codeWithComment = `
class Item(BaseModel):
    id: int # primary key
    label: str
`;
  const out = pythonPlugin.extract(codeWithComment, 'models.py');
  const idField = out.models[0].fields.find(f => f.name === 'id');
  assert.strictEqual(idField.type, 'int', `Expected "int" but got "${idField.type}"`);
});

// ═══════════════════════════════════════════════════════════════════
// 2. Prisma extractor (5 tests)
// ═══════════════════════════════════════════════════════════════════

const prismaCode = `
model Post {
  id        Int     @id @default(autoincrement())
  /// @zod.string.min(1)
  title     String
  /// @zod.import(["import { slug } from '../../utils'"]).custom.use(slug)
  slug      String
  published Boolean @default(false)
}

model Author {
  id   Int
  name String
}
`;

test('Prisma extractor', 'Extracts model Post', () => {
  const out = prismaPlugin.extract(prismaCode, 'schema.prisma');
  const post = out.models.find(m => m.className === 'Post');
  assert.ok(post, 'Model Post must be present');
});

test('Prisma extractor', 'Extracts all 4 fields of Post: id, title, slug, published', () => {
  const out = prismaPlugin.extract(prismaCode, 'schema.prisma');
  const post = out.models.find(m => m.className === 'Post');
  assert.deepStrictEqual(post.fields.map(f => f.name), ['id', 'title', 'slug', 'published']);
});

test('Prisma extractor', '} inside /// Zod annotations does NOT truncate the model', () => {
  // The Zod annotation line contains } inside the string — the model must still have 4 fields
  const out = prismaPlugin.extract(prismaCode, 'schema.prisma');
  const post = out.models.find(m => m.className === 'Post');
  assert.strictEqual(post.fields.length, 4,
    `Expected 4 fields but got ${post.fields.length}: ${JSON.stringify(post.fields)}`);
});

test('Prisma extractor', 'Field types are correct (id = Int, published = Boolean)', () => {
  const out = prismaPlugin.extract(prismaCode, 'schema.prisma');
  const post = out.models.find(m => m.className === 'Post');
  const idField = post.fields.find(f => f.name === 'id');
  const pubField = post.fields.find(f => f.name === 'published');
  assert.strictEqual(idField.type, 'Int');
  assert.strictEqual(pubField.type, 'Boolean');
});

test('Prisma extractor', 'A second model in the same file is also extracted', () => {
  const out = prismaPlugin.extract(prismaCode, 'schema.prisma');
  assert.strictEqual(out.models.length, 2, `Expected 2 models but got ${out.models.length}`);
  const author = out.models.find(m => m.className === 'Author');
  assert.ok(author, 'Model Author must be present');
  assert.deepStrictEqual(author.fields.map(f => f.name), ['id', 'name']);
});

// ═══════════════════════════════════════════════════════════════════
// 3. Merger (5 tests)
// ═══════════════════════════════════════════════════════════════════

const mergerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-merger-'));

function mergerPath(name) {
  return path.join(mergerTmpDir, name);
}

test('Merger', 'No markers → inserts markers + new content at top, preserves rest', () => {
  const p = mergerPath('no-markers.md');
  fs.writeFileSync(p, '# My Manual Notes\nSome content\n', 'utf-8');
  mergeIntoAgentsMd(p, 'AUTO CONTENT');
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(result.includes(START_MARKER), 'Must contain start marker');
  assert.ok(result.includes(END_MARKER), 'Must contain end marker');
  assert.ok(result.includes('AUTO CONTENT'), 'Must contain auto content');
  assert.ok(result.includes('# My Manual Notes'), 'Must preserve manual notes');
  assert.ok(result.includes('Some content'), 'Must preserve existing content');
});

test('Merger', 'Valid markers → replaces only between markers, manual content below untouched', () => {
  const p = mergerPath('valid-markers.md');
  const initial = `${START_MARKER}\nOLD CONTENT\n${END_MARKER}\n\n# Manual Section\nKeep this.\n`;
  fs.writeFileSync(p, initial, 'utf-8');
  mergeIntoAgentsMd(p, 'NEW CONTENT');
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(!result.includes('OLD CONTENT'), 'Old content must be replaced');
  assert.ok(result.includes('NEW CONTENT'), 'New content must be present');
  assert.ok(result.includes('# Manual Section'), 'Manual section must be preserved');
  assert.ok(result.includes('Keep this.'), 'Manual text must be preserved');
});

test('Merger', 'Manual content above the markers is also untouched', () => {
  const p = mergerPath('above-markers.md');
  const initial = `# Header Above\nAbove text\n\n${START_MARKER}\nOLD\n${END_MARKER}\n\nBelow text\n`;
  fs.writeFileSync(p, initial, 'utf-8');
  mergeIntoAgentsMd(p, 'REPLACED');
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(result.includes('# Header Above'), 'Header above must be preserved');
  assert.ok(result.includes('Above text'), 'Text above must be preserved');
  assert.ok(result.includes('REPLACED'), 'New content must be present');
  assert.ok(result.includes('Below text'), 'Text below must be preserved');
});

test('Merger', 'Corrupted/partial markers → treats as no markers (safe fallback)', () => {
  const p = mergerPath('corrupted.md');
  // Only start marker, no end marker
  fs.writeFileSync(p, `${START_MARKER}\nOrphan content\n`, 'utf-8');
  mergeIntoAgentsMd(p, 'SAFE CONTENT');
  const result = fs.readFileSync(p, 'utf-8');
  // Should append a fresh marker block (since end marker is missing)
  const lastStart = result.lastIndexOf(START_MARKER);
  const lastEnd = result.lastIndexOf(END_MARKER);
  assert.ok(lastEnd > lastStart, 'Must have a valid marker pair');
  assert.ok(result.includes('SAFE CONTENT'), 'Must contain the new content');
});

test('Merger', 'Empty string input → produces valid AGENTS.md with markers', () => {
  const p = mergerPath('empty-input.md');
  // File does not exist
  mergeIntoAgentsMd(p, '');
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(result.includes(START_MARKER), 'Must contain start marker');
  assert.ok(result.includes(END_MARKER), 'Must contain end marker');
  const startIdx = result.indexOf(START_MARKER);
  const endIdx = result.indexOf(END_MARKER);
  assert.ok(endIdx > startIdx, 'End marker must come after start marker');
});

// Clean up merger temp files
fs.rmSync(mergerTmpDir, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════
// 4. Import graph (5 tests)
// ═══════════════════════════════════════════════════════════════════

const importTmpDir = '/tmp/carto-test';

// Set up temp directory
if (fs.existsSync(importTmpDir)) {
  fs.rmSync(importTmpDir, { recursive: true, force: true });
}
fs.mkdirSync(importTmpDir, { recursive: true });

test('Import graph', "import X from './utils' resolves to utils.ts if it exists", () => {
  const utilsPath = path.join(importTmpDir, 'utils.ts');
  const mainPath = path.join(importTmpDir, 'main.ts');
  fs.writeFileSync(utilsPath, 'export const helper = 1;', 'utf-8');
  fs.writeFileSync(mainPath, "import { helper } from './utils';", 'utf-8');

  const imports = extractImports(
    fs.readFileSync(mainPath, 'utf-8'),
    mainPath,
    importTmpDir
  );
  assert.ok(imports.includes('utils.ts'), `Expected 'utils.ts' in ${JSON.stringify(imports)}`);
});

test('Import graph', "import X from './utils' with no file → not included (no phantom links)", () => {
  const mainPath = path.join(importTmpDir, 'phantom.ts');
  fs.writeFileSync(mainPath, "import { foo } from './nonexistent';", 'utf-8');

  const imports = extractImports(
    fs.readFileSync(mainPath, 'utf-8'),
    mainPath,
    importTmpDir
  );
  assert.strictEqual(imports.length, 0, `Expected no imports but got ${JSON.stringify(imports)}`);
});

test('Import graph', "require('./config') resolves correctly", () => {
  const configPath = path.join(importTmpDir, 'config.js');
  const appPath = path.join(importTmpDir, 'app.js');
  fs.writeFileSync(configPath, 'module.exports = {};', 'utf-8');
  fs.writeFileSync(appPath, "const cfg = require('./config');", 'utf-8');

  const imports = extractImports(
    fs.readFileSync(appPath, 'utf-8'),
    appPath,
    importTmpDir
  );
  assert.ok(imports.includes('config.js'), `Expected 'config.js' in ${JSON.stringify(imports)}`);
});

test('Import graph', 'A file with no imports returns []', () => {
  const emptyPath = path.join(importTmpDir, 'empty.js');
  fs.writeFileSync(emptyPath, 'const x = 42;\nconsole.log(x);', 'utf-8');

  const imports = extractImports(
    fs.readFileSync(emptyPath, 'utf-8'),
    emptyPath,
    importTmpDir
  );
  assert.deepStrictEqual(imports, []);
});

test('Import graph', "import X from 'express' (package, not relative) → not included", () => {
  const serverPath = path.join(importTmpDir, 'server.ts');
  fs.writeFileSync(serverPath, "import express from 'express';\nimport cors from 'cors';", 'utf-8');

  const imports = extractImports(
    fs.readFileSync(serverPath, 'utf-8'),
    serverPath,
    importTmpDir
  );
  assert.strictEqual(imports.length, 0, `Expected no imports but got ${JSON.stringify(imports)}`);
});

// Clean up import temp files
fs.rmSync(importTmpDir, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log('');
const suiteNames = ['Python extractor', 'Prisma extractor', 'Merger', 'Import graph'];
for (const suite of suiteNames) {
  const s = suiteTotals[suite] || { pass: 0, total: 0 };
  const icon = s.pass === s.total ? '✓' : '✗';
  console.log(`${icon} ${suite} — ${s.pass}/${s.total}`);
}
console.log('');

if (results.failed > 0) {
  console.log(`${results.failed} test(s) FAILED:\n`);
  for (const f of results.failures) {
    console.log(`  ✗ [${f.suite}] ${f.name}`);
    console.log(`    ${f.message}\n`);
  }
  process.exit(1);
} else {
  console.log(`All ${results.passed} tests passed.`);
}
