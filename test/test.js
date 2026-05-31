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
const { discoverFiles } = require('../src/detector/files');

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

const rDiscovered = discoverFiles(filterTmpDir, 'r-generic').routeFiles.map(f => path.basename(f));

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
}


// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

(async () => {
  await runAsyncSuite();

  console.log('');
  const suiteNames = ['Python extractor', 'Prisma extractor', 'Merger', 'Import graph', 'R extractor', 'File discovery', 'Project Structure'];
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
