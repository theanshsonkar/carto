const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Modules under test ──────────────────────────────────────────────
const pythonPlugin = require('../src/extractors/languages/python');
const prismaPlugin = require('../src/extractors/languages/prisma');
const { mergeIntoAgentsMd, START_MARKER, END_MARKER } = require('../src/agents/merger');
const { extractImports } = require('../src/extractors/imports');
const rPlugin = require('../src/extractors/languages/r');
const { discoverFiles } = require('../src/store/sync-v2');

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
// 4. Import graph (6 tests)
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

test('Import graph', 'R: library/require records package names, source() resolves local file', () => {
  const rDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-r-imp-'));
  try {
    const utilsPath = path.join(rDir, 'utils.R');
    const mainPath  = path.join(rDir, 'main.R');
    fs.writeFileSync(utilsPath, '# helpers\n');
    fs.writeFileSync(mainPath, 'library(ggplot2)\nrequire(dplyr)\nsource("./utils.R")\n');
    const imports = extractImports(fs.readFileSync(mainPath, 'utf-8'), mainPath, rDir);
    assert.ok(imports.includes('ggplot2'), `ggplot2 missing from ${JSON.stringify(imports)}`);
    assert.ok(imports.includes('dplyr'),   `dplyr missing from ${JSON.stringify(imports)}`);
    assert.ok(imports.includes('utils.R'), `utils.R missing from ${JSON.stringify(imports)}`);
  } finally {
    fs.rmSync(rDir, { recursive: true, force: true });
  }
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
// 5. R extractor (5 tests)
// ═══════════════════════════════════════════════════════════════════

const rCode = `
#* Countries
#* @get /countries
function(continent = "all") { }

#* @post /data
function(req, res) { }

processData <- function(x, y = 10) { }
.internalHelper <- function() { }

computeResult <- function(
  alpha,
  beta,
  gamma = NULL
) { }

setClass("Person", slots = list(name = "character", age = "numeric"))

UserTable <- data.frame(id = integer(), email = character())

Counter <- R6::R6Class("Counter",
  public = list(
    count = 0,
    increment = function() { self$count <- self$count + 1 }
  )
)

key <- Sys.getenv("API_KEY")
url <- Sys.getenv("DATABASE_URL")
db <- Sys.getenv("db_secret")
`;

test('R extractor', 'extractRoutes: methods uppercase, description-derived and path-derived names', () => {
  const out = rPlugin.extract(rCode, 'api.R');
  assert.strictEqual(out.routes.length, 2);
  const get = out.routes.find(r => r.method === 'GET');
  const post = out.routes.find(r => r.method === 'POST');
  assert.ok(get, 'GET route must be present');
  assert.strictEqual(get.functionName, 'Countries');
  assert.ok(post, 'POST route must be present');
  assert.strictEqual(post.functionName, 'data');
});

test('R extractor', 'extractFunctions: named functions extracted, dot-prefix and multiline handled', () => {
  const out = rPlugin.extract(rCode, 'api.R');
  const pd = out.functions.find(f => f.name === 'processData');
  assert.ok(pd, 'processData must be extracted');
  assert.strictEqual(pd.params, 'x, y');
  assert.strictEqual(out.functions.find(f => f.name === '.internalHelper'), undefined);
  const cr = out.functions.find(f => f.name === 'computeResult');
  assert.ok(cr, 'computeResult must be extracted');
  assert.strictEqual(cr.params, 'alpha, beta, gamma');
});

test('R extractor', 'extractModels: S4, data.frame and R6 classes with correct fields', () => {
  const out = rPlugin.extract(rCode, 'api.R');
  const person = out.models.find(m => m.className === 'Person');
  assert.ok(person, 'Person model must be extracted');
  assert.deepStrictEqual(person.fields, [{ name: 'name', type: 'character' }, { name: 'age', type: 'numeric' }]);
  const table = out.models.find(m => m.className === 'UserTable');
  assert.ok(table, 'UserTable model must be extracted');
  assert.ok(table.fields.find(f => f.name === 'id' && f.type === 'integer'), 'id:integer must be present');
  const counter = out.models.find(m => m.className === 'Counter');
  assert.ok(counter, 'Counter model must be extracted');
  assert.ok(counter.fields.find(f => f.name === 'count' && f.type === 'numeric'), 'count:numeric must be present');
  assert.strictEqual(counter.fields.find(f => f.name === 'increment'), undefined, 'methods must not appear as fields');
});

test('R extractor', 'extractEnvVars: uppercase SNAKE_CASE only, sorted, lowercase excluded', () => {
  const out = rPlugin.extract(rCode, 'api.R');
  assert.deepStrictEqual(out.envVars, ['API_KEY', 'DATABASE_URL']);
});

const s7AllCode = `
Dog <- new_class("Dog",
  properties = list(
    name = class_character,
    age  = class_numeric
  )
)
class_scopes <- S7::new_class(
  name = "scopes",
  properties = list(name = class_character)
)
Pet <- S7::new_class("Pet",
  properties = list(
    name = S7::class_character,
    age  = S7::class_numeric
  )
)
`;

test('R extractor', 'S7 new_class(): positional, named name= and S7:: namespace all extracted', () => {
  const out = rPlugin.extract(s7AllCode, 'models.R');
  const dog = out.models.find(m => m.className === 'Dog');
  assert.ok(dog, 'plain new_class() must extract Dog');
  assert.ok(dog.fields.find(f => f.name === 'name' && f.type === 'character'), 'name:character must be present');
  const scopes = out.models.find(m => m.className === 'scopes');
  assert.ok(scopes, 'S7::new_class(name=...) must extract scopes');
  const pet = out.models.find(m => m.className === 'Pet');
  assert.ok(pet, 'S7::new_class("Pet") must extract Pet');
  assert.ok(pet.fields.find(f => f.name === 'name' && f.type === 'character'), 'S7::class_character → character');
});

// ═══════════════════════════════════════════════════════════════════
// 6. File discovery (4 tests)
// ═══════════════════════════════════════════════════════════════════

const filterTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-r-filter-'));

// Use distinct base names to avoid macOS case-insensitive FS collisions
fs.writeFileSync(path.join(filterTmpDir, 'server.r'),       '# normal file\n');
fs.writeFileSync(path.join(filterTmpDir, 'controller_test.R'), '# uppercase suffix — should be excluded\n');
fs.writeFileSync(path.join(filterTmpDir, 'model_test.r'),   '# lowercase suffix — THE BUG\n');
fs.writeFileSync(path.join(filterTmpDir, 'test_utils.r'),   '# test_ prefix — should be excluded\n');

const rDiscovered = discoverFiles(filterTmpDir).map(f => path.basename(f));

test('File discovery','normal .r file is included in discovered files', () => {
  assert.ok(rDiscovered.includes('server.r'), `server.r missing from ${JSON.stringify(rDiscovered)}`);
});

test('File discovery','_test.R (uppercase) is excluded — regression guard', () => {
  assert.ok(!rDiscovered.includes('controller_test.R'), `controller_test.R must be excluded, got ${JSON.stringify(rDiscovered)}`);
});

test('File discovery','_test.r (lowercase) is excluded', () => {
  assert.ok(!rDiscovered.includes('model_test.r'), `model_test.r must be excluded, got ${JSON.stringify(rDiscovered)}`);
});

test('File discovery','test_ prefix with lowercase .r is excluded', () => {
  assert.ok(!rDiscovered.includes('test_utils.r'), `test_utils.r must be excluded, got ${JSON.stringify(rDiscovered)}`);
});

fs.rmSync(filterTmpDir, { recursive: true, force: true });


// ═══════════════════════════════════════════════════════════════════
// 7. Top-level structure scan (4 tests)
// ═══════════════════════════════════════════════════════════════════

const { scanStructure } = require('../src/agents/scan-structure');

async function asyncTest(suite, name, fn) {
  try {
    await fn();
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

async function runAsyncSuite() {
  // ── scanStructure unit tests ─────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-scan-struct-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.mkdirSync(path.join(tmp, '.carto'));
  fs.writeFileSync(path.join(tmp, 'README.md'), '# x\n');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'x');

  await asyncTest('Project Structure', 'returns top-level dirs and files', async () => {
    const out = await scanStructure(tmp);
    const names = out.map(e => e.name);
    assert.ok(names.includes('src'), `expected src in ${JSON.stringify(names)}`);
    assert.ok(names.includes('README.md'), `expected README.md in ${JSON.stringify(names)}`);
    assert.ok(names.includes('package.json'), `expected package.json in ${JSON.stringify(names)}`);
  });

  await asyncTest('Project Structure', 'excludes node_modules, .git, .carto, AGENTS.md', async () => {
    const out = await scanStructure(tmp);
    const names = out.map(e => e.name);
    for (const banned of ['node_modules', '.git', '.carto', 'AGENTS.md']) {
      assert.ok(!names.includes(banned), `${banned} must be excluded, got ${JSON.stringify(names)}`);
    }
  });

  await asyncTest('Project Structure', 'directories sort before files; alphabetical within group', async () => {
    const out = await scanStructure(tmp);
    let sawFile = false;
    for (const e of out) {
      if (e.type === 'file') sawFile = true;
      if (e.type === 'dir' && sawFile) {
        assert.fail(`dir "${e.name}" appeared after a file — sort broken`);
      }
    }
    const dirs = out.filter(e => e.type === 'dir').map(e => e.name);
    const files = out.filter(e => e.type === 'file').map(e => e.name);
    assert.deepStrictEqual(dirs, [...dirs].sort((a, b) => a.localeCompare(b)));
    assert.deepStrictEqual(files, [...files].sort((a, b) => a.localeCompare(b)));
  });

  await asyncTest('Project Structure', 'missing path returns empty array (no throw)', async () => {
    const out = await scanStructure(path.join(tmp, 'does-not-exist'));
    assert.deepStrictEqual(out, []);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  // ── V2 sync integration test ─────────────────────────────────────
  const { runSyncV2 } = require('../src/store/sync-v2');

  await asyncTest('Project Structure', 'V2 sync writes populated structure block to AGENTS.md', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-v2-sync-'));
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.mkdirSync(path.join(projectRoot, 'test'));
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'index.js'),
      "const express = require('express');\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\nmodule.exports = app;\n"
    );
    fs.writeFileSync(path.join(projectRoot, 'test', 'noop.js'), '// placeholder\n');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Fixture\n');
    fs.mkdirSync(path.join(projectRoot, '.carto'));
    fs.writeFileSync(
      path.join(projectRoot, '.carto', 'config.json'),
      JSON.stringify({ framework: 'express' })
    );

    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    try {
      await runSyncV2({ projectRoot, output: agentsPath });
    } catch (err) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      throw err;
    }

    let content;
    try {
      content = fs.readFileSync(agentsPath, 'utf-8');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }

    assert.ok(content.includes('## Project Structure (auto)'),
      'AGENTS.md must contain Project Structure header');
    assert.ok(!content.includes('_No structure data available._'),
      `AGENTS.md must not contain empty fallback. Got:\n${content}`);
    assert.ok(content.includes('📁'),
      `AGENTS.md must list at least one directory. Got:\n${content}`);
    assert.ok(content.includes('📄'),
      `AGENTS.md must list at least one file. Got:\n${content}`);
    assert.ok(/📄 (README\.md|package\.json)/.test(content),
      `AGENTS.md must list README.md or package.json. Got:\n${content}`);
  });

  // ── Init flow integration tests (Spec 4) ─────────────────────────
  // Regression target: `carto init` must use V2 indexer (runSyncV2),
  // not the legacy V1 runFullSync that produced an empty 23ms no-op.
  const initCli = require('../src/cli/init');
  const { SQLiteStore: InitTestStore } = require('../src/store/sqlite-store');

  // Sandbox HOME / USERPROFILE so init.run()'s wireIDEs() side effect
  // can't touch the real ~/.kiro, ~/.cursor, or Claude Desktop configs.
  // Also opt out of the npm-registry update check so tests don't egress.
  function sandboxHome(tmpHome) {
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CARTO_NO_UPDATE_CHECK: process.env.CARTO_NO_UPDATE_CHECK
    };
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.CARTO_NO_UPDATE_CHECK = '1';
    return () => {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.USERPROFILE;
      if (saved.CARTO_NO_UPDATE_CHECK === undefined) delete process.env.CARTO_NO_UPDATE_CHECK;
      else process.env.CARTO_NO_UPDATE_CHECK = saved.CARTO_NO_UPDATE_CHECK;
    };
  }

  await asyncTest('Init flow', 'carto init runs V2 indexer end-to-end (carto.db populated, AGENTS.md non-empty)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-init-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-init-home-'));
    const restoreHome = sandboxHome(homeSandbox);

    try {
      // Minimal fixture: an Express app + a util it imports.
      fs.mkdirSync(path.join(projectRoot, 'src'));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'init-fixture', dependencies: { express: '^4.0.0' } }, null, 2)
      );
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# init fixture\n');
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'server.ts'),
        "import { greet } from './utils';\n" +
        "import express from 'express';\n" +
        "const app = express();\n" +
        "app.get('/health', (req, res) => res.send(greet()));\n" +
        "export default app;\n"
      );
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'utils.ts'),
        "export function greet() { return 'ok'; }\n"
      );

      await initCli.run(projectRoot);

      // (1) .carto/carto.db exists and is populated.
      const dbPath = path.join(projectRoot, '.carto', 'carto.db');
      assert.ok(fs.existsSync(dbPath),
        'carto init must create .carto/carto.db (V2 indexer ran)');

      const store = new InitTestStore(projectRoot);
      store.open();
      const fileCount = store.getFileCount();
      store.close();
      assert.ok(fileCount >= 2,
        `expected >= 2 indexed files in carto.db, got ${fileCount} ` +
        '(this is the regression target — V1 produced 0)');

      // (2) AGENTS.md fully populated (not the empty fallback).
      const agentsPath = path.join(projectRoot, 'AGENTS.md');
      assert.ok(fs.existsSync(agentsPath), 'AGENTS.md must exist after init');
      const agents = fs.readFileSync(agentsPath, 'utf-8');
      assert.ok(agents.includes('## Project Structure (auto)'),
        'AGENTS.md must contain Project Structure header');
      assert.ok(!agents.includes('_No structure data available._'),
        `AGENTS.md must not contain empty fallback. Got:\n${agents}`);
      assert.ok(/📁 src\//.test(agents),
        `AGENTS.md must list 📁 src/. Got:\n${agents}`);

      // (3) .carto/config.json written with version 2.
      const cfg = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.carto', 'config.json'), 'utf-8')
      );
      assert.strictEqual(cfg.version, '2', 'config.json must have version "2"');
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Init flow', 'carto init migrates leftover V1 graph-cache.json cleanly (no errors)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-init-v1-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-init-v1-home-'));
    const restoreHome = sandboxHome(homeSandbox);

    try {
      fs.mkdirSync(path.join(projectRoot, 'src'));
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'v1-leftover-fixture' }, null, 2)
      );
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# v1 leftover\n');
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'index.ts'),
        "export const NAME = 'init-v1-fixture';\n"
      );

      // Pre-seed empty V1 state — mirrors what a previously-broken
      // `carto init` (the bug Spec 4 fixes) left behind on disk.
      fs.mkdirSync(path.join(projectRoot, '.carto'));
      fs.writeFileSync(
        path.join(projectRoot, '.carto', 'graph-cache.json'),
        JSON.stringify({ version: '2', fileData: {}, importGraph: {} })
      );
      fs.writeFileSync(path.join(projectRoot, '.carto', 'hashes.json'), '{}');

      // Must not throw — migrateFromJsonBlobs handles the empty V1 state.
      await initCli.run(projectRoot);

      const dbPath = path.join(projectRoot, '.carto', 'carto.db');
      assert.ok(fs.existsSync(dbPath),
        'carto.db must exist after init on V1-leftover state');

      const store = new InitTestStore(projectRoot);
      store.open();
      const fileCount = store.getFileCount();
      store.close();
      assert.ok(fileCount >= 1,
        'index must include real fixture files (not the empty V1 cache); ' +
        `got ${fileCount}`);
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  // ── Store adapter (ACP V2) — Spec 5 ─────────────────────────────────
  const { StoreAdapter } = require('../src/store/store-adapter');
  const { runSyncV2: runSyncV2ForAdapter } = require('../src/store/sync-v2');

  // Helper: build a minimal Express fixture for adapter tests
  function buildAdapterFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-adapter-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"adapter-fixture"}');
    fs.writeFileSync(
      path.join(root, 'src', 'server.js'),
      "const express = require('express');\nconst { helper } = require('./utils');\nconst app = express();\napp.get('/health', (req, res) => res.send('ok'));\napp.post('/users', (req, res) => res.json({}));\nmodule.exports = app;\n"
    );
    fs.writeFileSync(
      path.join(root, 'src', 'utils.js'),
      "function helper() { return 1; }\nmodule.exports = { helper };\n"
    );
    return root;
  }

  // Test 1: Adapter constructs and indexes against a real fixture
  await asyncTest('Store adapter (ACP V2)', 'Adapter indexes fixture, creates carto.db, skips AGENTS.md when writeOutputs:false', async () => {
    const fixture = buildAdapterFixture();
    let a;
    try {
      a = new StoreAdapter();
      await a.index(fixture, { writeOutputs: false });

      assert.ok(fs.existsSync(path.join(fixture, '.carto', 'carto.db')),
        'carto.db must exist after adapter.index()');
      assert.ok(!fs.existsSync(path.join(fixture, 'AGENTS.md')),
        'AGENTS.md must NOT exist when writeOutputs:false');
    } finally {
      try { a && a.close(); } catch {}
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Test 2: Adapter idempotent open on existing DB
  await asyncTest('Store adapter (ACP V2)', 'Second index() call opens existing DB in <500ms without re-extraction', async () => {
    const fixture = buildAdapterFixture();
    let a1, a2;
    try {
      a1 = new StoreAdapter();
      await a1.index(fixture, { writeOutputs: false });
      const meta1 = a1.getMeta();
      a1.close(); a1 = null;

      a2 = new StoreAdapter();
      const start = Date.now();
      await a2.index(fixture, { writeOutputs: false });
      const elapsed = Date.now() - start;
      const meta2 = a2.getMeta();

      assert.ok(elapsed < 500, `Second index() took ${elapsed}ms, expected <500ms`);
      assert.strictEqual(meta1.totalFiles, meta2.totalFiles,
        'File count must be unchanged between calls');
    } finally {
      try { a1 && a1.close(); } catch {}
      try { a2 && a2.close(); } catch {}
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Test 3: Shape parity — adapter methods return expected top-level keys
  await asyncTest('Store adapter (ACP V2)', 'getBlastRadius returns V1 shape with risk, directlyAffected, dependentFiles', async () => {
    const fixture = buildAdapterFixture();
    let a;
    try {
      a = new StoreAdapter();
      await a.index(fixture, { writeOutputs: false });

      const br = a.getBlastRadius('src/utils.js');
      // utils.js is imported by server.js, so it should have dependents
      assert.ok(br !== null, 'getBlastRadius must return non-null for indexed file');
      assert.ok('risk' in br, 'must have risk field');
      assert.ok('directlyAffected' in br, 'must have directlyAffected field');
      assert.ok('potentiallyAffected' in br, 'must have potentiallyAffected field');
      assert.ok('routesImpacted' in br, 'must have routesImpacted field');
      assert.ok('domainsImpacted' in br, 'must have domainsImpacted field');
      assert.ok('dependentFiles' in br, 'must have dependentFiles field');
      assert.ok(Array.isArray(br.dependentFiles), 'dependentFiles must be array');
    } finally {
      try { a && a.close(); } catch {}
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Test 4: runSyncV2 honors output:null
  await asyncTest('Store adapter (ACP V2)', 'runSyncV2 with output:null creates DB but no AGENTS.md or context files', async () => {
    const fixture = buildAdapterFixture();
    try {
      await runSyncV2ForAdapter({ projectRoot: fixture, output: null });

      assert.ok(fs.existsSync(path.join(fixture, '.carto', 'carto.db')),
        'carto.db must exist');
      assert.ok(!fs.existsSync(path.join(fixture, 'AGENTS.md')),
        'AGENTS.md must NOT exist with output:null');

      const contextDir = path.join(fixture, '.carto', 'context');
      const hasContext = fs.existsSync(contextDir) &&
        fs.readdirSync(contextDir).filter(f => f.endsWith('.md')).length > 0;
      assert.ok(!hasContext, 'Context files must NOT be written with output:null');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }

    // Separate fixture: verify output with a real path DOES write AGENTS.md
    const fixture2 = buildAdapterFixture();
    try {
      await runSyncV2ForAdapter({ projectRoot: fixture2, output: path.join(fixture2, 'AGENTS.md') });
      assert.ok(fs.existsSync(path.join(fixture2, 'AGENTS.md')),
        'AGENTS.md must exist when output is a real path');
    } finally {
      fs.rmSync(fixture2, { recursive: true, force: true });
    }
  });

  // Test 5: Session manager closes adapter on delete
  await asyncTest('Store adapter (ACP V2)', 'SessionManager.delete() closes SQLite handle cleanly', async () => {
    const { SessionManager } = require('../src/acp/session');
    const fixture = buildAdapterFixture();
    try {
      const mgr = new SessionManager();
      const session = mgr.create(fixture);
      await session.ensureIndexed();

      // Verify it works before delete
      assert.ok(session.carto.getMeta().totalFiles >= 1, 'session must be indexed');

      mgr.delete(session.id);

      // After delete, the adapter's store is closed
      assert.strictEqual(session.carto._store, null, 'store must be null after close');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Test 6: getContextForFile returns composed context
  await asyncTest('Store adapter (ACP V2)', 'getContextForFile returns domain, routes, blastRadius, neighbors', async () => {
    const fixture = buildAdapterFixture();
    let a;
    try {
      a = new StoreAdapter();
      await a.index(fixture, { writeOutputs: false });

      const ctx = a.getContextForFile('src/server.js');
      assert.ok(ctx !== null, 'must return context for indexed file');
      assert.ok('domain' in ctx, 'must have domain');
      assert.ok('routes' in ctx, 'must have routes');
      assert.ok('blastRadius' in ctx, 'must have blastRadius');
      assert.ok('neighbors' in ctx, 'must have neighbors');
      assert.ok('crossDomainDeps' in ctx, 'must have crossDomainDeps');
      assert.ok(Array.isArray(ctx.routes), 'routes must be array');

      // server.js has 2 routes
      assert.ok(ctx.routes.length >= 1, `expected routes, got ${ctx.routes.length}`);
    } finally {
      try { a && a.close(); } catch {}
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Test 7: No V1 cache files touched during adapter session
  await asyncTest('Store adapter (ACP V2)', 'V1 graph-cache.json is not touched during adapter session', async () => {
    const fixture = buildAdapterFixture();
    let a;
    try {
      // Pre-seed V1 cache file
      fs.mkdirSync(path.join(fixture, '.carto'), { recursive: true });
      const cachePath = path.join(fixture, '.carto', 'graph-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify({ sentinel: 'V1' }));
      const mtimeBefore = fs.statSync(cachePath).mtimeMs;

      // Wait 50ms to ensure mtime would differ if file is touched
      await new Promise(r => setTimeout(r, 50));

      a = new StoreAdapter();
      await a.index(fixture, { writeOutputs: false });

      // Exercise all query methods
      a.getRoutes();
      a.getStructure();
      a.getDomainsList();
      a.getBlastRadius('src/server.js');
      a.getContextForFile('src/server.js');
      a.getNeighbors('src/server.js', 1);

      // Verify V1 file untouched
      const content = fs.readFileSync(cachePath, 'utf-8');
      const mtimeAfter = fs.statSync(cachePath).mtimeMs;
      assert.strictEqual(JSON.parse(content).sentinel, 'V1',
        'graph-cache.json content must be unchanged');
      assert.strictEqual(mtimeBefore, mtimeAfter,
        'graph-cache.json mtime must be unchanged');
    } finally {
      try { a && a.close(); } catch {}
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Test 8: Public API back-compat — Spec 6
  // The `Carto` named export from index.js is a deprecated alias for
  // StoreAdapter (removed in 3.0.0). Existing programs must keep working:
  //   const { Carto } = require('carto-md');
  //   const c = new Carto(); await c.index(root); ...; c.terminate();
  await asyncTest('Store adapter (ACP V2)', 'Public API: Carto alias + terminate() shim work end-to-end', async () => {
    const publicApi = require('../index.js');
    assert.ok(typeof publicApi.StoreAdapter === 'function',
      'index.js must export StoreAdapter');
    assert.ok(typeof publicApi.Carto === 'function',
      'index.js must export Carto (deprecated alias)');
    assert.strictEqual(publicApi.Carto, publicApi.StoreAdapter,
      'Carto must be the same class as StoreAdapter');

    const fixture = buildAdapterFixture();
    let c;
    try {
      c = new publicApi.Carto();
      assert.strictEqual(typeof c.terminate, 'function',
        'Carto instances must have terminate() (V1 back-compat)');
      assert.strictEqual(typeof c.close, 'function',
        'Carto instances must have close() (canonical name)');

      await c.index(fixture, { writeOutputs: false });
      assert.ok(c.getMeta().totalFiles >= 1,
        'index() via Carto alias must populate the store');

      // terminate() must actually close the underlying store
      c.terminate();
      assert.strictEqual(c._store, null,
        'terminate() must null out _store (delegates to close())');
      c = null;
    } finally {
      try { c && c.close(); } catch {}
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
}


// ═══════════════════════════════════════════════════════════════════
// Change plan (Spec 2): pure-module tokenizer + anchor selection +
// graph expansion + markdown formatter
// ═══════════════════════════════════════════════════════════════════

const {
  planChange,
  formatPlanMarkdown,
  tokenize,
  pathTokens,
  camelTokens,
  computeIdf,
  STOPWORDS
} = require('../src/mcp/change-plan');
const { SQLiteStore } = require('../src/store/sqlite-store');

/**
 * buildTestStore(spec) — creates a real on-disk SQLiteStore in a temp
 * directory and populates it with the given spec, then computes
 * reverse_deps so blast radius queries return real values.
 *
 * spec = {
 *   files: [{ path, language? }],
 *   symbols: [{ file, name, exported? }],
 *   routes:  [{ file, method, path, framework? }],
 *   imports: [{ from, to }],   // by path
 *   domains: { DOMAIN_NAME: ['file/path', ...] }
 * }
 *
 * Returns { store, cleanup() }.
 */
function buildTestStore(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-changeplan-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = new SQLiteStore(root);
  store.open();

  const fileIds = new Map();
  for (const f of spec.files || []) {
    const id = store.upsertFile(f.path, {
      language: f.language || 'javascript',
      hash: 'h', mtime: 0, size: 0
    });
    fileIds.set(f.path, id);
  }

  // Inject extraction data per file (symbols + routes)
  const perFile = new Map();
  for (const fp of fileIds.keys()) {
    perFile.set(fp, { imports: [], symbols: [], routes: [], models: [], envVars: [], dbTables: [] });
  }
  for (const s of spec.symbols || []) {
    const bucket = perFile.get(s.file);
    if (!bucket) continue;
    bucket.symbols.push({
      name: s.name,
      kind: s.kind || 'function',
      line: 1,
      exported: s.exported !== false,
      isDefault: false
    });
  }
  for (const r of spec.routes || []) {
    const bucket = perFile.get(r.file);
    if (!bucket) continue;
    bucket.routes.push({
      method: r.method,
      path: r.path,
      handler: r.handler || null,
      framework: r.framework || 'express'
    });
  }
  for (const imp of spec.imports || []) {
    const bucket = perFile.get(imp.from);
    if (!bucket) continue;
    bucket.imports.push({ path: imp.to, resolvedFileId: fileIds.get(imp.to) || null });
  }
  for (const [fp, data] of perFile) {
    store.storeExtraction(fileIds.get(fp), data);
  }

  // Domains
  if (spec.domains) {
    for (const [name, files] of Object.entries(spec.domains)) {
      const did = store.upsertDomain(name, { fileCount: files.length });
      for (const fp of files) {
        const fid = fileIds.get(fp);
        if (fid) store.assignFileToDomain(fid, did);
      }
    }
  }

  store.computeReverseDeps(5);

  return {
    store,
    cleanup: () => {
      // Close the SQLite handle BEFORE rmSync — on Windows, an open
      // file handle prevents unlinking the .db file (EBUSY). POSIX
      // allows unlinking open files; Windows does not.
      try { store.close(); } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

// ── Tokenization ──────────────────────────────────────────────────

test('Change plan', 'tokenize: rate limiting + /api/users yields path + content tokens', () => {
  const t = tokenize('add rate limiting to /api/users');
  assert.ok(t.content.includes('rate'), `expected "rate" in content; got ${JSON.stringify(t.content)}`);
  assert.ok(t.content.includes('limiting'), `expected "limiting"; got ${JSON.stringify(t.content)}`);
  assert.ok(t.content.includes('api'), `expected "api"; got ${JSON.stringify(t.content)}`);
  assert.ok(t.content.includes('users'), `expected "users"; got ${JSON.stringify(t.content)}`);
  assert.deepStrictEqual(t.paths, ['/api/users']);
  assert.deepStrictEqual(t.verbs, []);
  assert.ok(!t.content.includes('add'), '"add" must be dropped as stopword');
  assert.ok(!t.content.includes('to'), '"to" must be dropped as stopword');
});

test('Change plan', 'tokenize: detects HTTP verb + path + 3-char dev token (jwt)', () => {
  const t = tokenize('POST /api/login should set a JWT');
  assert.deepStrictEqual(t.verbs, ['POST']);
  assert.deepStrictEqual(t.paths, ['/api/login']);
  assert.ok(t.content.includes('jwt'), `"jwt" (3 chars) MUST survive; got ${JSON.stringify(t.content)}`);
  assert.ok(!t.content.includes('should'), '"should" is a stopword');
  assert.ok(!t.content.includes('set'), '"set" is a stopword');
});

test('Change plan', 'tokenize: 3-char dev tokens (log, mcp, sql) survive; "every" filtered', () => {
  const t = tokenize('log every MCP query for debugging');
  assert.ok(t.content.includes('log'), `"log" must survive; got ${JSON.stringify(t.content)}`);
  assert.ok(t.content.includes('mcp'), `"mcp" must survive; got ${JSON.stringify(t.content)}`);
  assert.ok(t.content.includes('query'));
  assert.ok(t.content.includes('debugging'));
  assert.ok(!t.content.includes('every'), '"every" must be a stopword');
  assert.ok(!t.content.includes('for'), '"for" must be a stopword');
});

test('Change plan', 'tokenize: empty / non-string input returns empty arrays (no throw)', () => {
  assert.deepStrictEqual(tokenize(''), { content: [], verbs: [], paths: [] });
  assert.deepStrictEqual(tokenize(null), { content: [], verbs: [], paths: [] });
  assert.deepStrictEqual(tokenize(undefined), { content: [], verbs: [], paths: [] });
});

// ── Path / symbol token extraction ────────────────────────────────

test('Change plan', 'pathTokens: splits on /, -, _, .', () => {
  const t = pathTokens('src/store/sqlite-store.js');
  for (const expected of ['src', 'store', 'sqlite', 'js']) {
    assert.ok(t.includes(expected), `expected "${expected}" in ${JSON.stringify(t)}`);
  }
});

test('Change plan', 'pathTokens: handles version suffix (v2) and mcp', () => {
  const t = pathTokens('src/mcp/server-v2.js');
  for (const expected of ['src', 'mcp', 'server', 'v2', 'js']) {
    assert.ok(t.includes(expected), `expected "${expected}" in ${JSON.stringify(t)}`);
  }
});

test('Change plan', 'pathTokens: deeper nesting (extractors/languages/javascript)', () => {
  const t = pathTokens('src/extractors/languages/javascript.js');
  for (const expected of ['src', 'extractors', 'languages', 'javascript', 'js']) {
    assert.ok(t.includes(expected), `expected "${expected}" in ${JSON.stringify(t)}`);
  }
});

test('Change plan', 'camelTokens: splits camelCase symbol names', () => {
  const t = camelTokens('rateLimitMiddleware');
  for (const expected of ['rate', 'limit', 'middleware']) {
    assert.ok(t.includes(expected), `expected "${expected}" in ${JSON.stringify(t)}`);
  }
});

// ── IDF weighting (regression guard for migrate.js false-positive) ──

test('Change plan', 'IDF: rare token outweighs common token', () => {
  const { store, cleanup } = buildTestStore({
    files: [
      { path: 'src/foo.js' },
      { path: 'src/bar.js' },
      { path: 'src/baz.js' },
      { path: 'src/rate.js' }
    ]
  });
  try {
    const idf = computeIdf(store);
    const idfRate = idf.get('rate') || 0;
    const idfSrc = idf.get('src') || 0;
    assert.ok(idfRate > idfSrc,
      `expected IDF(rate) > IDF(src); got rate=${idfRate.toFixed(3)} src=${idfSrc.toFixed(3)}`);
  } finally { cleanup(); }
});

// ── Anchor selection — README flagship example ────────────────────

test('Change plan', 'planChange: matches /api/users route, NOT migrate.js (regression target)', () => {
  const { store, cleanup } = buildTestStore({
    files: [
      { path: 'src/routes/users.ts' },
      { path: 'src/routes/orders.ts' },
      { path: 'src/utils/helpers.ts' },
      { path: 'src/store/migrate.js' },     // contains "rate" as substring of "migrate"
      { path: 'src/middleware/logger.ts' },
      { path: 'src/index.ts' }
    ],
    routes: [
      { file: 'src/routes/users.ts', method: 'POST', path: '/api/users' },
      { file: 'src/routes/orders.ts', method: 'GET', path: '/api/orders' }
    ]
  });
  try {
    const plan = planChange(store, 'add rate limiting to /api/users');
    const routeAnchors = plan.anchors.filter(a => a.kind === 'route');
    assert.ok(routeAnchors.length >= 1, `expected at least one route anchor; got ${plan.anchors.length} anchors`);
    const usersRoute = routeAnchors.find(a => a.value === 'POST /api/users');
    assert.ok(usersRoute, `expected POST /api/users anchor; got ${JSON.stringify(routeAnchors.map(a => a.value))}`);
    assert.strictEqual(usersRoute.file, 'src/routes/users.ts');
    assert.ok(plan.filesToTouch.includes('src/routes/users.ts'),
      `filesToTouch must include routes/users.ts; got ${JSON.stringify(plan.filesToTouch)}`);
    // The critical regression guard:
    assert.ok(!plan.anchors.some(a => a.file === 'src/store/migrate.js'),
      `migrate.js must NOT appear in anchors (false-positive guard); got ${JSON.stringify(plan.anchors.map(a => a.file))}`);
    assert.ok(!plan.filesToTouch.includes('src/store/migrate.js'),
      'migrate.js must NOT appear in filesToTouch');
  } finally { cleanup(); }
});

// ── Anchor selection — exported symbol match ──────────────────────

test('Change plan', 'planChange: anchors on exported symbol names (rateLimitMiddleware)', () => {
  const { store, cleanup } = buildTestStore({
    files: [
      { path: 'src/middleware/throttle.ts' },   // no "rate" in path
      { path: 'src/index.ts' }
    ],
    symbols: [
      { file: 'src/middleware/throttle.ts', name: 'rateLimitMiddleware', exported: true },
      { file: 'src/index.ts', name: 'createApp', exported: true }
    ]
  });
  try {
    const plan = planChange(store, 'add rate limiting to API endpoints');
    const ratelim = plan.anchors.find(a => a.file === 'src/middleware/throttle.ts');
    assert.ok(ratelim, `expected anchor on throttle.ts via symbol match; got ${JSON.stringify(plan.anchors.map(a => a.file))}`);
    assert.ok(/rateLimitMiddleware/.test(ratelim.reason),
      `anchor reason must cite the matched symbol; got: ${ratelim.reason}`);
    // No path-token "rate" in throttle.ts → the only signal is the symbol.
    assert.ok(/symbol/i.test(ratelim.reason),
      `anchor must be reported as a symbol match; got: ${ratelim.reason}`);
  } finally { cleanup(); }
});

// ── Graph expansion: forward, backward, blast radius ──────────────

test('Change plan', 'planChange: expands graph (forward+backward) + blast radius', () => {
  // alpha.ts imports beta.ts; gamma.ts imports alpha.ts
  const { store, cleanup } = buildTestStore({
    files: [
      { path: 'src/alpha.ts' },
      { path: 'src/beta.ts' },
      { path: 'src/gamma.ts' }
    ],
    imports: [
      { from: 'src/alpha.ts', to: 'src/beta.ts' },
      { from: 'src/gamma.ts', to: 'src/alpha.ts' }
    ]
  });
  try {
    // Anchor on alpha.ts via path-token match
    const plan = planChange(store, 'refactor alpha module');
    const anchorOnAlpha = plan.anchors.find(x => x.file === 'src/alpha.ts');
    assert.ok(anchorOnAlpha, `expected anchor on src/alpha.ts; got ${JSON.stringify(plan.anchors)}`);
    assert.ok(plan.filesToTouch.includes('src/alpha.ts'), 'filesToTouch must include the anchor');
    assert.ok(plan.filesToTouch.includes('src/beta.ts'),
      `filesToTouch must include forward-import beta.ts; got ${JSON.stringify(plan.filesToTouch)}`);
    assert.ok(plan.filesToReview.includes('src/gamma.ts'),
      `filesToReview must include backward-importer gamma.ts; got ${JSON.stringify(plan.filesToReview)}`);
    const blastGamma = plan.blastRadius.find(b => b.file === 'src/gamma.ts');
    assert.ok(blastGamma, `blastRadius must include gamma.ts; got ${JSON.stringify(plan.blastRadius)}`);
    assert.strictEqual(blastGamma.hop, 1, 'gamma.ts is a 1-hop dependent of alpha.ts');
  } finally { cleanup(); }
});

// ── No-anchor fallback ────────────────────────────────────────────

test('Change plan', 'planChange: lorem ipsum returns empty anchors + guidance', () => {
  const { store, cleanup } = buildTestStore({
    files: [
      { path: 'src/index.ts' },
      { path: 'src/utils.ts' }
    ]
  });
  try {
    const plan = planChange(store, 'lorem ipsum dolor');
    assert.strictEqual(plan.anchors.length, 0, `expected 0 anchors; got ${JSON.stringify(plan.anchors)}`);
    assert.ok(plan.guidance && typeof plan.guidance === 'string', 'guidance must be a non-empty string');
    assert.ok(/get_routes/.test(plan.guidance),
      `guidance must mention get_routes; got: ${plan.guidance}`);
    assert.ok(/get_domains_list/.test(plan.guidance),
      `guidance must mention get_domains_list; got: ${plan.guidance}`);
  } finally { cleanup(); }
});

test('Change plan', 'planChange: empty corpus returns guidance to run carto sync', () => {
  const { store, cleanup } = buildTestStore({ files: [] });
  try {
    const plan = planChange(store, 'add rate limiting');
    assert.strictEqual(plan.anchors.length, 0);
    assert.ok(plan.guidance && /carto sync/.test(plan.guidance),
      `expected sync guidance; got: ${plan.guidance}`);
  } finally { cleanup(); }
});

// ── Markdown formatter shape stability ────────────────────────────

test('Change plan', 'formatPlanMarkdown: preserves historical section headers', () => {
  const { store, cleanup } = buildTestStore({
    files: [
      { path: 'src/routes/users.ts' },
      { path: 'src/index.ts' }
    ],
    routes: [
      { file: 'src/routes/users.ts', method: 'POST', path: '/api/users' }
    ],
    imports: [
      { from: 'src/index.ts', to: 'src/routes/users.ts' }
    ],
    domains: { API: ['src/routes/users.ts', 'src/index.ts'] }
  });
  try {
    const plan = planChange(store, 'add rate limiting to /api/users');
    const md = formatPlanMarkdown(plan);
    assert.ok(/^# Change Plan: /m.test(md), 'must start with title');
    assert.ok(/## Relevant Routes/.test(md), 'must contain "## Relevant Routes"');
    assert.ok(/## Files to Touch/.test(md), 'must contain "## Files to Touch"');
    assert.ok(/## Affected Domains/.test(md), 'must contain "## Affected Domains"');
    // "Files to Review (Callers)" only when non-empty — index.ts imports
    // users.ts so should appear as a caller.
    assert.ok(/## Files to Review \(Callers\)/.test(md),
      `expected Files to Review section; got:\n${md}`);
  } finally { cleanup(); }
});

test('Change plan', 'formatPlanMarkdown: omits Files to Review when empty', () => {
  const { store, cleanup } = buildTestStore({
    files: [{ path: 'src/lonely.ts' }]
  });
  try {
    const plan = planChange(store, 'edit lonely module');
    const md = formatPlanMarkdown(plan);
    assert.ok(plan.filesToReview.length === 0, 'precondition: no callers');
    assert.ok(!/## Files to Review/.test(md),
      'Files to Review section must NOT appear when empty');
  } finally { cleanup(); }
});

test('Change plan', 'formatPlanMarkdown: fallback message for no-anchor case', () => {
  const { store, cleanup } = buildTestStore({
    files: [{ path: 'src/index.ts' }]
  });
  try {
    const plan = planChange(store, 'lorem ipsum dolor');
    const md = formatPlanMarkdown(plan);
    assert.ok(/^# Change Plan: /m.test(md));
    assert.ok(/get_routes/.test(md) || /lorem ipsum/.test(md),
      `expected fallback prose with get_routes hint; got:\n${md}`);
  } finally { cleanup(); }
});


// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

(async () => {
  await runAsyncSuite();

  console.log('');
  const suiteNames = ['Python extractor', 'Prisma extractor', 'Merger', 'Import graph', 'R extractor', 'File discovery', 'Project Structure', 'Change plan', 'Init flow', 'Store adapter (ACP V2)'];
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
})().catch(err => {
  console.error('[test runner] async suite crashed:', err);
  process.exit(1);
});
