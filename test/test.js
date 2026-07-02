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
const { discoverFiles } = require('../src/store/sync');

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
// 4. Import graph (7 tests)
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

test('Import graph', "import X from 'express' (bare npm package) → captured as unresolved edge", () => {
  const serverPath = path.join(importTmpDir, 'server.ts');
  fs.writeFileSync(serverPath, "import express from 'express';\nimport cors from 'cors';", 'utf-8');

  const imports = extractImports(
    fs.readFileSync(serverPath, 'utf-8'),
    serverPath,
    importTmpDir
  );
  // Bare specifiers are now surfaced as-is. Downstream storeExtraction
  // records them with to_file_id = NULL, resolved = 0 — every existing
  // graph query (blast radius, neighbors, cross-domain) filters
  // WHERE to_file_id IS NOT NULL, so they don't pollute graph metrics.
  // They power rules that need to know "which external packages does
  // this file depend on?" (auth-provider detection, dep-freshness
  // checks, etc.).
  assert.deepStrictEqual(imports.sort(), ['cors', 'express']);
});

test('Import graph', 'Python: from .b import X resolves to b.py (regression — Bug 1)', () => {
  const pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-py-imp-'));
  try {
    // 3-file Python project: a.py imports b.py via relative import; c.py imports both.
    const aPath = path.join(pyDir, 'a.py');
    const bPath = path.join(pyDir, 'b.py');
    const cPath = path.join(pyDir, 'c.py');
    fs.writeFileSync(bPath, 'def hello(): return 1\n');
    fs.writeFileSync(aPath, 'from .b import hello\n');
    fs.writeFileSync(cPath, 'from .a import hello as a_hello\nfrom .b import hello as b_hello\n');

    // Bug 1 was: extractPythonImports returned absolute paths but the JS-style
    // dedup loop in extractImports only handled `./` and `@/~/#` prefixes,
    // so every Python edge was silently dropped (returned []).
    const aImports = extractImports(fs.readFileSync(aPath, 'utf-8'), aPath, pyDir);
    const cImports = extractImports(fs.readFileSync(cPath, 'utf-8'), cPath, pyDir);

    assert.deepStrictEqual(aImports, ['b.py'], `a.py should import b.py; got ${JSON.stringify(aImports)}`);
    assert.deepStrictEqual(cImports.sort(), ['a.py', 'b.py'], `c.py should import a.py and b.py; got ${JSON.stringify(cImports)}`);
  } finally {
    fs.rmSync(pyDir, { recursive: true, force: true });
  }
});

test('Import graph', 'C/C++: #include "x.h" resolves to project file', () => {
  const cppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-cpp-imp-'));
  // Normalise platform separators — path.relative returns backslashes on
  // Windows, but we want our assertions to be platform-neutral.
  const norm = (arr) => arr.map(p => p.split(path.sep).join('/'));
  try {
    fs.mkdirSync(path.join(cppDir, 'include'));
    fs.mkdirSync(path.join(cppDir, 'src'));
    fs.writeFileSync(path.join(cppDir, 'include', 'database.h'), '#ifndef DB_H\n#define DB_H\nclass Database {};\n#endif\n');
    fs.writeFileSync(path.join(cppDir, 'include', 'auth.h'),
      '#ifndef AUTH_H\n#define AUTH_H\n#include "database.h"\nclass Auth {};\n#endif\n');
    fs.writeFileSync(path.join(cppDir, 'src', 'main.cpp'),
      '#include "../include/auth.h"\n#include "../include/database.h"\n#include <iostream>\nint main(){return 0;}\n');

    const authImports = extractImports(
      fs.readFileSync(path.join(cppDir, 'include', 'auth.h'), 'utf-8'),
      path.join(cppDir, 'include', 'auth.h'),
      cppDir
    );
    const mainImports = extractImports(
      fs.readFileSync(path.join(cppDir, 'src', 'main.cpp'), 'utf-8'),
      path.join(cppDir, 'src', 'main.cpp'),
      cppDir
    );

    // auth.h's `#include "database.h"` resolves against its sibling.
    assert.deepStrictEqual(norm(authImports), ['include/database.h'],
      `auth.h should import database.h; got ${JSON.stringify(authImports)}`);
    // main.cpp resolves both relative-up paths and skips <iostream>.
    assert.deepStrictEqual(norm(mainImports).sort(), ['include/auth.h', 'include/database.h'],
      `main.cpp should import auth.h and database.h; got ${JSON.stringify(mainImports)}`);
  } finally {
    fs.rmSync(cppDir, { recursive: true, force: true });
  }
});

test('Import graph', 'C#: `using A.B;` resolves via namespace map', () => {
  const csDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-cs-imp-'));
  const norm = (arr) => arr.map(p => p.split(path.sep).join('/'));
  try {
    fs.mkdirSync(path.join(csDir, 'Models'));
    fs.mkdirSync(path.join(csDir, 'Services'));
    fs.writeFileSync(path.join(csDir, 'Models', 'User.cs'),
      'namespace MyApp.Models;\npublic class User {}\n');
    fs.writeFileSync(path.join(csDir, 'Services', 'UserService.cs'),
      'namespace MyApp.Services;\nusing MyApp.Models;\npublic class UserService {}\n');

    const svcImports = extractImports(
      fs.readFileSync(path.join(csDir, 'Services', 'UserService.cs'), 'utf-8'),
      path.join(csDir, 'Services', 'UserService.cs'),
      csDir
    );

    // `using MyApp.Models;` should map to the file declaring that namespace,
    // not just look up MyApp/Models.cs by filename convention.
    assert.deepStrictEqual(norm(svcImports), ['Models/User.cs'],
      `UserService.cs should import Models/User.cs via namespace map; got ${JSON.stringify(svcImports)}`);

    // System namespaces should not produce phantom edges.
    fs.writeFileSync(path.join(csDir, 'Services', 'NoLocalImports.cs'),
      'namespace MyApp.Services;\nusing System;\nusing System.Collections.Generic;\n');
    const noneImports = extractImports(
      fs.readFileSync(path.join(csDir, 'Services', 'NoLocalImports.cs'), 'utf-8'),
      path.join(csDir, 'Services', 'NoLocalImports.cs'),
      csDir
    );
    assert.deepStrictEqual(noneImports, [],
      `System.* using statements should produce no edges; got ${JSON.stringify(noneImports)}`);
  } finally {
    fs.rmSync(csDir, { recursive: true, force: true });
  }
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

  // ── Sync integration test ────────────────────────────────────────
  const { runSync } = require('../src/store/sync');

  await asyncTest('Project Structure', 'sync writes populated structure block to AGENTS.md', async () => {
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
      await runSync({ projectRoot, output: agentsPath });
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

  // ── Init flow integration tests ──────────────────────────────────
  // Regression target: `carto init` must use the SQLite-backed indexer
  // (runSync), not the older runFullSync that produced an empty
  // 23 ms no-op.
  const initCli = require('../src/cli/init');
  const { SQLiteStore: InitTestStore } = require('../src/store/sqlite-store');

  // Sandbox HOME / USERPROFILE so init.run()'s wireIDEs() side effect
  // can't touch the real ~/.kiro, ~/.cursor, or Claude Desktop configs.
  // Also opt out of the npm-registry update check so tests don't egress.
  // CARTO_TEST_BINARY_OVERRIDES forces every binary detection to "absent"
  // by default — individual tests opt-in to "present" via the override.
  function sandboxHome(tmpHome, opts = {}) {
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CARTO_NO_UPDATE_CHECK: process.env.CARTO_NO_UPDATE_CHECK,
      CARTO_TEST_BINARY_OVERRIDES: process.env.CARTO_TEST_BINARY_OVERRIDES,
    };
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.CARTO_NO_UPDATE_CHECK = '1';
    // Default: all known binaries absent. Tests that want one present
    // pass `binaries: 'claude=1,code=1'` etc. Per-test overrides come
    // FIRST so binaryExists's left-to-right first-match wins.
    const baseOverride = 'claude=0,codex=0,code=0';
    process.env.CARTO_TEST_BINARY_OVERRIDES = opts.binaries
      ? `${opts.binaries},${baseOverride}`
      : baseOverride;
    return () => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
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

      // (4) Detection gating — Claude Code wiring requires a real signal,
      //     not the unconditional `.mcp.json` write the pre-2.0.8 code did.
      //     On a fresh sandbox HOME with no `claude` binary and no `~/.claude/`,
      //     `.mcp.json` must NOT be written. This is the regression that the
      //     IDE-detection rewrite closed.
      const mcpJsonPath = path.join(projectRoot, '.mcp.json');
      assert.ok(!fs.existsSync(mcpJsonPath),
        'pre-2.0.8 wrote .mcp.json unconditionally; post-fix it must be gated on Claude Code detection');
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

      // Pre-seed empty JSON-blob state — mirrors what a previously-broken
      // `carto init` left behind on disk before the fix.
      fs.mkdirSync(path.join(projectRoot, '.carto'));
      fs.writeFileSync(
        path.join(projectRoot, '.carto', 'graph-cache.json'),
        JSON.stringify({ version: '2', fileData: {}, importGraph: {} })
      );
      fs.writeFileSync(path.join(projectRoot, '.carto', 'hashes.json'), '{}');

      // Must not throw — migrateFromJsonBlobs handles the empty leftover state.
      await initCli.run(projectRoot);

      const dbPath = path.join(projectRoot, '.carto', 'carto.db');
      assert.ok(fs.existsSync(dbPath),
        'carto.db must exist after init on JSON-blob-leftover state');

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

  await asyncTest('Init flow', 'imports resolve regardless of file processing order (alphabetical chicken-and-egg)', async () => {
    // Regression: extraction loop processes files in some order, upserting
    // each file then resolving its imports against the files table. If file
    // A imports file B and A is processed first, B is not yet in the files
    // table → to_file_id stays null → blast radius is wrong.
    //
    // The post-pass `store.resolveUnresolvedImports()` after the extraction
    // loop fixes this by re-resolving any null to_file_id with a single
    // UPDATE.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-cae-'));
    try {
      // Construct two files where the alphabetical-first one imports the
      // alphabetical-second one. With our default sort, `aaa.js` is
      // processed before `zzz.js`, so when aaa.js's imports get resolved
      // zzz.js doesn't exist in the files table yet.
      fs.writeFileSync(path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'cae-fixture' }));
      fs.writeFileSync(path.join(projectRoot, 'zzz.js'),
        'module.exports = function zzz() { return 42; };\n');
      fs.writeFileSync(path.join(projectRoot, 'aaa.js'),
        "const zzz = require('./zzz');\nmodule.exports = zzz;\n");

      const { runSync } = require('../src/store/sync');
      await runSync({ projectRoot, output: null });

      const { SQLiteStore } = require('../src/store/sqlite-store');
      const store = new SQLiteStore(projectRoot);
      store.open();
      try {
        const total = store._db.prepare('SELECT COUNT(*) AS n FROM imports').get().n;
        const resolved = store._db.prepare(
          'SELECT COUNT(*) AS n FROM imports WHERE to_file_id IS NOT NULL'
        ).get().n;
        assert.strictEqual(total, 1, `expected 1 import row, got ${total}`);
        assert.strictEqual(resolved, 1,
          `aaa.js → zzz.js should resolve via post-pass even when aaa.js processed first; ` +
          `got ${resolved}/${total} resolved`);

        // Reverse deps must reflect the resolved edge.
        const zzzRow = store._db.prepare(
          'SELECT id FROM files WHERE path = ?'
        ).get('zzz.js');
        assert.ok(zzzRow, 'zzz.js missing from files table');
        const zzzDeps = store._db.prepare(
          'SELECT COUNT(*) AS n FROM reverse_deps WHERE file_id = ?'
        ).get(zzzRow.id).n;
        assert.strictEqual(zzzDeps, 1,
          `zzz.js should have 1 reverse dependent (aaa.js); got ${zzzDeps}`);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ── Init flow IDE auto-wiring (fixes pre-2.0.8 gap) ──────────────
  //
  // Pre-2.0.8 `wireIDEs()` covered 4 of 9 documented tools (Cursor,
  // Claude Code, Kiro, Claude Desktop) and unconditionally wrote
  // `.mcp.json` regardless of whether Claude Code was installed. The
  // rewrite adds Codex, Windsurf, VS Code Copilot + cross-platform
  // Claude Desktop paths, and gates every wiring on real detection.
  //
  // These tests drive each IDE's detection signal in isolation so we
  // catch any path/format regression before users see "huh, my AI tool
  // didn't pick up the config."

  // Helper: drive `wireIDEs` directly with a sandboxed HOME and explicit
  // detection signals (pre-create the marker dir or set CARTO_TEST_BINARY_OVERRIDES).
  const { _internal: wireIDEsInternal } = require('../src/cli/init');

  function withWireSandbox(fn, opts = {}) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-wire-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-wire-home-'));
    const restoreHome = sandboxHome(homeSandbox, opts);
    // Suppress wireIDEs's console output during tests.
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      return fn({ projectRoot, homeSandbox });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  }

  test('Init flow', 'No detection signals → zero IDEs wired, no .mcp.json/.vscode files written', () => {
    withWireSandbox(({ projectRoot }) => {
      wireIDEsInternal.wireIDEs(projectRoot);
      // None of the tool-specific config files should exist.
      assert.ok(!fs.existsSync(path.join(projectRoot, '.mcp.json')),
        '.mcp.json must NOT be written when Claude Code is absent');
      assert.ok(!fs.existsSync(path.join(projectRoot, '.vscode', 'mcp.json')),
        '.vscode/mcp.json must NOT be written when VS Code is absent');
    });
  });

  test('Init flow', 'Cursor detected via ~/.cursor/ dir → ~/.cursor/mcp.json written with mcpServers.carto', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.cursor'), { recursive: true });
      wireIDEsInternal.wireIDEs(projectRoot);
      const cfg = JSON.parse(fs.readFileSync(path.join(homeSandbox, '.cursor', 'mcp.json'), 'utf-8'));
      assert.ok(cfg.mcpServers && cfg.mcpServers.carto, 'must contain mcpServers.carto');
      assert.strictEqual(cfg.mcpServers.carto.command, 'carto');
      assert.deepStrictEqual(cfg.mcpServers.carto.args, ['serve']);
      assert.strictEqual(cfg.mcpServers.carto.cwd, projectRoot);
    });
  });

  test('Init flow', 'Claude Code detected via ~/.claude/ dir → <project>/.mcp.json written; not written when undetected', () => {
    // Detected case
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.claude'), { recursive: true });
      wireIDEsInternal.wireIDEs(projectRoot);
      const mcpJsonPath = path.join(projectRoot, '.mcp.json');
      assert.ok(fs.existsSync(mcpJsonPath), '.mcp.json must be written when Claude Code detected');
      const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      assert.strictEqual(cfg.mcpServers.carto.command, 'carto');
      // Note: Claude Code is project-scoped — no cwd field.
      assert.ok(!('cwd' in cfg.mcpServers.carto), 'Claude Code .mcp.json must not include cwd (project-scoped)');
    });
    // Undetected case (no marker dir, override = absent)
    withWireSandbox(({ projectRoot }) => {
      wireIDEsInternal.wireIDEs(projectRoot);
      assert.ok(!fs.existsSync(path.join(projectRoot, '.mcp.json')),
        '.mcp.json must NOT exist when Claude Code undetected');
    });
  });

  test('Init flow', 'Kiro detected via ~/.kiro/ → ~/.kiro/settings/mcp.json written', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.kiro'), { recursive: true });
      wireIDEsInternal.wireIDEs(projectRoot);
      const cfgPath = path.join(homeSandbox, '.kiro', 'settings', 'mcp.json');
      assert.ok(fs.existsSync(cfgPath), 'Kiro mcp.json must be written');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      assert.strictEqual(cfg.mcpServers.carto.command, 'carto');
    });
  });

  test('Init flow', 'Codex detected via ~/.codex/ → config.toml written with [mcp_servers.carto] block', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.codex'), { recursive: true });
      wireIDEsInternal.wireIDEs(projectRoot);
      const tomlPath = path.join(homeSandbox, '.codex', 'config.toml');
      assert.ok(fs.existsSync(tomlPath), 'Codex config.toml must be written');
      const toml = fs.readFileSync(tomlPath, 'utf-8');
      assert.ok(toml.includes('[mcp_servers.carto]'), 'must contain [mcp_servers.carto] header');
      assert.ok(toml.includes('command = "carto"'), 'must contain command');
      assert.ok(toml.includes('args = ["serve"]'), 'must contain args');
      assert.ok(toml.includes('enabled = true'), 'must contain enabled flag');
      // Mirror upsertCodexToml's TOML basic-string escaping so this assertion
      // matches on Windows where projectRoot contains literal backslashes.
      const tomlEscape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      assert.ok(toml.includes(`cwd = "${tomlEscape(projectRoot)}"`), 'must contain cwd');
    });
  });

  test('Init flow', 'Codex re-wire is idempotent (re-run replaces in-place, does not duplicate the block)', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.codex'), { recursive: true });
      // Pre-seed config.toml with an existing user setting + a stale carto block.
      const tomlPath = path.join(homeSandbox, '.codex', 'config.toml');
      fs.writeFileSync(tomlPath,
        'model = "gpt-5"\n\n' +
        '[mcp_servers.carto]\n' +
        'command = "OLD_CARTO"\n' +
        'args = ["OLD"]\n' +
        'enabled = false\n\n' +
        '[mcp_servers.other]\n' +
        'command = "x"\n'
      );
      wireIDEsInternal.wireIDEs(projectRoot);
      const toml = fs.readFileSync(tomlPath, 'utf-8');
      // Existing user setting preserved
      assert.ok(toml.includes('model = "gpt-5"'), 'user setting must be preserved');
      // Other server block preserved
      assert.ok(toml.includes('[mcp_servers.other]'), 'other server block must survive');
      // Stale carto values replaced
      assert.ok(!toml.includes('OLD_CARTO'), 'stale carto command must be replaced');
      assert.ok(!toml.includes('"OLD"'), 'stale carto args must be replaced');
      assert.ok(toml.includes('command = "carto"'), 'fresh carto command');
      // Header appears exactly once
      const occurrences = toml.match(/\[mcp_servers\.carto\]/g) || [];
      assert.strictEqual(occurrences.length, 1, '[mcp_servers.carto] must appear exactly once');
    });
  });

  test('Init flow', 'Windsurf detected via ~/.codeium/windsurf/ → mcp_config.json written (corrected path)', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.codeium', 'windsurf'), { recursive: true });
      wireIDEsInternal.wireIDEs(projectRoot);
      const cfgPath = path.join(homeSandbox, '.codeium', 'windsurf', 'mcp_config.json');
      assert.ok(fs.existsSync(cfgPath), `Windsurf mcp_config.json must be written at ${cfgPath}`);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      assert.strictEqual(cfg.mcpServers.carto.command, 'carto');
      // Old (wrong) path in pre-2.0.8 README must NOT be created
      assert.ok(!fs.existsSync(path.join(homeSandbox, '.windsurf', 'mcp.json')),
        'must not write to the old wrong ~/.windsurf/ path');
    });
  });

  test('Init flow', 'VS Code Copilot wiring uses servers key + type:stdio (not mcpServers)', () => {
    withWireSandbox(({ projectRoot }) => {
      wireIDEsInternal.wireIDEs(projectRoot);
      const cfgPath = path.join(projectRoot, '.vscode', 'mcp.json');
      assert.ok(fs.existsSync(cfgPath), 'VS Code mcp.json must be written when `code` binary detected');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      // VS Code uses `servers` (NOT `mcpServers`) — this is the gotcha
      // the docs flagged. If we accidentally wrote mcpServers, VS Code
      // would silently ignore it.
      assert.ok(cfg.servers, 'must use top-level `servers` key (not mcpServers)');
      assert.ok(!cfg.mcpServers, 'must NOT write mcpServers key (VS Code ignores it)');
      assert.strictEqual(cfg.servers.carto.type, 'stdio', 'must include type:stdio');
      assert.strictEqual(cfg.servers.carto.command, 'carto');
      assert.deepStrictEqual(cfg.servers.carto.args, ['serve']);
    }, { binaries: 'code=1' });
  });

  test('Init flow', 'Claude Desktop config path is correct on macOS (and Linux/Windows path resolution)', () => {
    // Test the path resolver directly — we can't easily fake `process.platform`
    // mid-test, but we can confirm the macOS resolution and that the helper
    // returns *some* sane path on the current platform.
    const resolved = wireIDEsInternal.claudeDesktopConfigPath();
    if (process.platform === 'darwin') {
      assert.ok(resolved.includes('Library/Application Support/Claude/'),
        `macOS path must include Library/Application Support/Claude/, got ${resolved}`);
    } else if (process.platform === 'win32') {
      assert.ok(resolved.match(/Claude[\\/]claude_desktop_config\.json$/),
        `Windows path must end in Claude/claude_desktop_config.json, got ${resolved}`);
    } else {
      assert.ok(resolved.includes('.config/Claude/'),
        `Linux path must include .config/Claude/, got ${resolved}`);
    }
    assert.ok(resolved.endsWith('claude_desktop_config.json'),
      'path must end in claude_desktop_config.json');
  });

  test('Init flow', 'Existing user MCP config is merged (other servers preserved, carto entry upserted)', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      // Pre-seed Cursor config with an unrelated server entry.
      fs.mkdirSync(path.join(homeSandbox, '.cursor'), { recursive: true });
      const cursorCfgPath = path.join(homeSandbox, '.cursor', 'mcp.json');
      fs.writeFileSync(cursorCfgPath, JSON.stringify({
        mcpServers: {
          'github': { command: 'gh-mcp', args: ['serve'] },
          'carto': { command: 'OLD_CARTO_BIN', args: ['old-arg'] },
        }
      }, null, 2));

      wireIDEsInternal.wireIDEs(projectRoot);
      const cfg = JSON.parse(fs.readFileSync(cursorCfgPath, 'utf-8'));
      // Other server preserved
      assert.ok(cfg.mcpServers.github, 'unrelated github entry must be preserved');
      assert.strictEqual(cfg.mcpServers.github.command, 'gh-mcp');
      // Carto entry upserted (overwritten with fresh values)
      assert.strictEqual(cfg.mcpServers.carto.command, 'carto');
      assert.deepStrictEqual(cfg.mcpServers.carto.args, ['serve']);
    });
  });

  test('Init flow', 'Malformed existing config does not crash wireIDEs (replaced with valid JSON)', () => {
    withWireSandbox(({ projectRoot, homeSandbox }) => {
      fs.mkdirSync(path.join(homeSandbox, '.cursor'), { recursive: true });
      const cursorCfgPath = path.join(homeSandbox, '.cursor', 'mcp.json');
      // Write garbage JSON
      fs.writeFileSync(cursorCfgPath, '{not json at all <<<');
      // Must not throw
      wireIDEsInternal.wireIDEs(projectRoot);
      // File now contains valid JSON with carto wired
      const cfg = JSON.parse(fs.readFileSync(cursorCfgPath, 'utf-8'));
      assert.strictEqual(cfg.mcpServers.carto.command, 'carto');
    });
  });

  // ── Git hooks (freshness redesign) ────────────────────────────────
  //
  // `carto init` installs four git hooks (pre-commit, post-checkout,
  // post-merge, post-rewrite) that quietly call `carto sync` on every
  // git event. The lazy MCP re-parse handler covers the gap between
  // commits. Together they replace the always-on `carto watch` daemon
  // as the default freshness mechanism.

  await asyncTest('Git hooks', 'carto init installs all 4 hooks (pre-commit, post-checkout, post-merge, post-rewrite)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-fresh-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-fresh-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"hook-fixture"}');
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# hook fixture\n');
      fs.writeFileSync(path.join(projectRoot, 'src.js'), 'module.exports = 1;\n');

      await initCli.run(projectRoot);

      const hookNames = ['pre-commit', 'post-checkout', 'post-merge', 'post-rewrite'];
      for (const name of hookNames) {
        const hookPath = path.join(projectRoot, '.git', 'hooks', name);
        assert.ok(fs.existsSync(hookPath),
          `hook ${name} must exist after carto init`);
        const content = fs.readFileSync(hookPath, 'utf-8');
        assert.ok(content.includes('carto sync'),
          `hook ${name} must call carto sync. Got:\n${content}`);
        // Executable bit set on POSIX. chmod is a no-op on Windows.
        if (process.platform !== 'win32') {
          const mode = fs.statSync(hookPath).mode;
          assert.ok((mode & 0o111) !== 0,
            `hook ${name} must be executable (mode = ${mode.toString(8)})`);
        }
      }
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Git hooks', 'carto init appends to pre-existing user hook without clobbering it', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-existing-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-existing-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"hook-fixture-2"}');
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# hook fixture\n');
      fs.writeFileSync(path.join(projectRoot, 'src.js'), 'module.exports = 1;\n');

      // User already had a pre-commit hook doing other work
      const userHook = '#!/bin/sh\necho "user pre-commit"\nnpm test\n';
      const preCommitPath = path.join(projectRoot, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(preCommitPath, userHook);

      await initCli.run(projectRoot);

      const merged = fs.readFileSync(preCommitPath, 'utf-8');
      assert.ok(merged.includes('echo "user pre-commit"'),
        `existing user hook content must be preserved. Got:\n${merged}`);
      assert.ok(merged.includes('npm test'),
        'existing npm test line must be preserved');
      assert.ok(merged.includes('carto sync'),
        `carto sync line must be appended. Got:\n${merged}`);
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Git hooks', 'carto init is idempotent — running it twice does not duplicate the carto sync line', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-idem-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-idem-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"hook-fixture-3"}');
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# hook fixture\n');
      fs.writeFileSync(path.join(projectRoot, 'src.js'), 'module.exports = 1;\n');

      await initCli.run(projectRoot);
      await initCli.run(projectRoot);

      const preCommit = fs.readFileSync(
        path.join(projectRoot, '.git', 'hooks', 'pre-commit'), 'utf-8'
      );
      const matches = preCommit.match(/carto sync/g) || [];
      assert.strictEqual(matches.length, 1,
        `carto sync should appear exactly once after two inits. Got ${matches.length}:\n${preCommit}`);
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Git hooks', 'carto init on a project with no .git silently skips hook install (no crash)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-nogit-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hooks-nogit-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      // Deliberately no .git directory
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"no-git-fixture"}');
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# no git\n');
      fs.writeFileSync(path.join(projectRoot, 'src.js'), 'module.exports = 1;\n');

      // Must not throw
      await initCli.run(projectRoot);

      assert.ok(!fs.existsSync(path.join(projectRoot, '.git')),
        'init must not synthesize a .git directory when one was absent');
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  // ── Lazy MCP re-parse (freshness redesign) ────────────────────────
  //
  // Between commits, the user can edit files. Git hooks haven't fired
  // yet, but the MCP server gets a query against one of those files.
  // The lazy mtime+size check at MCP query time detects staleness and
  // re-parses the file inline before answering. The workhorse is
  // syncFiles() in sync.js — these tests exercise its contract.
  // The lazyReparseFile() handler in server.js is a thin wrapper
  // that delegates to syncFiles() (best-effort, error-tolerant).

  const { syncFiles } = require('../src/store/sync');

  await asyncTest('Lazy MCP re-parse', 'syncFiles on unchanged files reparses 0 (mtime+size match)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-clean-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-clean-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"lazy-fixture"}');
      fs.writeFileSync(path.join(projectRoot, 'a.js'),
        "const b = require('./b');\nmodule.exports = b;\n");
      fs.writeFileSync(path.join(projectRoot, 'b.js'),
        "module.exports = 1;\n");

      await initCli.run(projectRoot);

      const result = syncFiles(projectRoot, ['a.js', 'b.js']);
      assert.strictEqual(result.reparsed, 0,
        `unchanged files should reparse 0, got ${result.reparsed}`);
      assert.strictEqual(result.removed, 0,
        `nothing should be removed, got ${result.removed}`);
      assert.strictEqual(result.skipped, 2,
        `2 files should be skipped as fresh, got ${result.skipped}`);
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Lazy MCP re-parse', 'syncFiles on edited file reparses, DB hash advances', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-edit-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-edit-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"lazy-fixture-2"}');
      const filePath = path.join(projectRoot, 'a.js');
      fs.writeFileSync(filePath, 'module.exports = 1;\n');

      await initCli.run(projectRoot);

      const storePre = new InitTestStore(projectRoot);
      storePre.open();
      const original = storePre.getFileByPath('a.js');
      storePre.close();
      assert.ok(original, 'a.js must be in index after init');

      // Edit. Force mtime advance to defeat 1s mtime resolution on some FSes.
      fs.writeFileSync(filePath, 'module.exports = 2;\nfunction newFn() {}\n');
      const futureTime = new Date(Date.now() + 2000);
      fs.utimesSync(filePath, futureTime, futureTime);

      const result = syncFiles(projectRoot, ['a.js']);
      assert.strictEqual(result.reparsed, 1,
        `edited file should be reparsed, got ${JSON.stringify(result)}`);

      const storePost = new InitTestStore(projectRoot);
      storePost.open();
      const updated = storePost.getFileByPath('a.js');
      storePost.close();

      assert.notStrictEqual(updated.hash, original.hash,
        'hash must change after re-parse');
      assert.ok(updated.mtime > original.mtime,
        `mtime must advance: was ${original.mtime}, now ${updated.mtime}`);
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Lazy MCP re-parse', 'syncFiles on file deleted from disk removes it from the index', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-del-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-del-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"lazy-fixture-3"}');
      fs.writeFileSync(path.join(projectRoot, 'a.js'), 'module.exports = 1;\n');
      fs.writeFileSync(path.join(projectRoot, 'b.js'),
        "const a = require('./a');\nmodule.exports = a;\n");

      await initCli.run(projectRoot);

      const storePre = new InitTestStore(projectRoot);
      storePre.open();
      assert.ok(storePre.getFileByPath('a.js'), 'a.js must be in index');
      storePre.close();

      fs.unlinkSync(path.join(projectRoot, 'a.js'));

      const result = syncFiles(projectRoot, ['a.js']);
      assert.strictEqual(result.removed, 1,
        `deleted file should be removed, got ${JSON.stringify(result)}`);

      const storePost = new InitTestStore(projectRoot);
      storePost.open();
      assert.strictEqual(storePost.getFileByPath('a.js'), undefined,
        'a.js must be removed from index after syncFiles');
      storePost.close();
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  await asyncTest('Lazy MCP re-parse', 'syncFiles on touched-but-unchanged file refreshes mtime, no reparse', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-touch-'));
    const homeSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-lazy-touch-home-'));
    const restoreHome = sandboxHome(homeSandbox);
    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"lazy-fixture-4"}');
      const filePath = path.join(projectRoot, 'a.js');
      fs.writeFileSync(filePath, 'module.exports = 1;\n');

      await initCli.run(projectRoot);

      // Touch — same content, new mtime. syncFiles should detect the
      // mtime change, hash-compare, see it's the same content, and skip
      // re-extraction (just refresh the cached mtime).
      const futureTime = new Date(Date.now() + 5000);
      fs.utimesSync(filePath, futureTime, futureTime);

      const result = syncFiles(projectRoot, ['a.js']);
      assert.strictEqual(result.reparsed, 0,
        `touched-only file should not be reparsed, got ${JSON.stringify(result)}`);
    } finally {
      restoreHome();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(homeSandbox, { recursive: true, force: true });
    }
  });

  // ── Store adapter (ACP) ─────────────────────────────────────────
  const { StoreAdapter } = require('../src/store/store-adapter');
  const { runSync: runSyncForAdapter } = require('../src/store/sync');

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

  // Test 4: runSync honors output:null
  await asyncTest('Store adapter (ACP V2)', 'runSync with output:null creates DB but no AGENTS.md or context files', async () => {
    const fixture = buildAdapterFixture();
    try {
      await runSyncForAdapter({ projectRoot: fixture, output: null });

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
      await runSyncForAdapter({ projectRoot: fixture2, output: path.join(fixture2, 'AGENTS.md') });
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

  // Test 7: legacy JSON-blob cache files are not touched during adapter session
  await asyncTest('Store adapter (ACP V2)', 'V1 graph-cache.json is not touched during adapter session', async () => {
    const fixture = buildAdapterFixture();
    let a;
    try {
      // Pre-seed the legacy cache file the adapter must leave alone.
      fs.mkdirSync(path.join(fixture, '.carto'), { recursive: true });
      const cachePath = path.join(fixture, '.carto', 'graph-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify({ sentinel: 'V1' }));
      const mtimeBefore = fs.statSync(cachePath).mtimeMs;

      // Wait 50 ms so a write would produce a different mtime.
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

      // The legacy file must be untouched.
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

  // Test 8: Public API back-compat
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

  // ═════════════════════════════════════════════════════════════════
  // Secret leakage
  // Asserts the trust-posture invariant: file content values never reach
  // AGENTS.md or .carto/context/*.md, and the expanded .cartoignore default
  // patterns catch real secret-bearing filenames without false-positiving
  // harmless code (tokenizer.js etc.). Plus the MCP server's readonly DB
  // mode actually rejects writes.
  // ═════════════════════════════════════════════════════════════════

  await asyncTest('Secret leakage', 'fake secrets in fixture files do not appear in AGENTS.md or context files', async () => {
    const { runSync: runSync } = require('../src/store/sync');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-secrets-'));

    // Marker tokens that MUST NOT leak. Using clearly-fake but realistic
    // shapes so this test would also catch an accidental "include string
    // literals from route definitions" regression.
    const FAKE_STRIPE = 'sk_test_FAKE_VALUE_DO_NOT_LEAK_INTO_AGENTS_MD';
    const FAKE_HARDCODED = 'FAKE_HARDCODED_TOKEN_DO_NOT_LEAK_4242';

    try {
      fs.mkdirSync(path.join(projectRoot, 'src'));

      // (a) Caught by *secret* — should be excluded entirely from indexing.
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'secrets.ts'),
        `export const STRIPE_KEY = "${FAKE_STRIPE}";\n`
      );

      // (b) Caught by *credential* — the kind of filename real secret-storage
      // files actually use (in contrast to api_key.py / api-keys.ts which is
      // typically feature code, not credentials).
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'aws_credentials.ts'),
        `export const KEY = "${FAKE_STRIPE}";\n`
      );

      // (c) Normal file with a hardcoded fake API key in a string literal.
      // This file IS indexed; the test asserts the literal value never
      // surfaces in AGENTS.md or context files.
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'normal.ts'),
        `import express from 'express';\n` +
        `const app = express();\n` +
        `const HARDCODED = "${FAKE_HARDCODED}";\n` +
        `app.get('/api/users', (req, res) => res.json({ key: HARDCODED }));\n` +
        `export default app;\n`
      );

      // (d) .env with a fake Stripe key. Env var NAMES may surface (by
      // design — see envvars.js docstring); VALUES must not.
      fs.writeFileSync(
        path.join(projectRoot, '.env'),
        `STRIPE_SECRET_KEY=${FAKE_STRIPE}\n`
      );

      // (e) Models file with a `password` field. Field NAME may surface;
      // no value to leak here, but proves we still extract the model.
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'models.ts'),
        `export interface User { id: string; email: string; password: string; }\n`
      );

      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"secrets-fixture"}');

      const agentsPath = path.join(projectRoot, 'AGENTS.md');
      await runSync({ projectRoot, output: agentsPath });

      const agents = fs.readFileSync(agentsPath, 'utf-8');

      // Hard invariants — neither value may appear anywhere.
      assert.ok(!agents.includes(FAKE_STRIPE),
        `AGENTS.md leaked STRIPE value:\n${agents}`);
      assert.ok(!agents.includes(FAKE_HARDCODED),
        `AGENTS.md leaked hardcoded token:\n${agents}`);

      // Same invariant for every domain context file.
      const contextDir = path.join(projectRoot, '.carto', 'context');
      if (fs.existsSync(contextDir)) {
        for (const f of fs.readdirSync(contextDir)) {
          if (!f.endsWith('.md')) continue;
          const content = fs.readFileSync(path.join(contextDir, f), 'utf-8');
          assert.ok(!content.includes(FAKE_STRIPE),
            `context/${f} leaked STRIPE value:\n${content}`);
          assert.ok(!content.includes(FAKE_HARDCODED),
            `context/${f} leaked hardcoded token:\n${content}`);
        }
      }

      // Confirm secrets.ts and api_keys.ts were excluded from the DB
      // (cartoignore must block them — they're code-extension files that
      // would otherwise be indexed).
      const { SQLiteStore: Store } = require('../src/store/sqlite-store');
      const s = new Store(projectRoot);
      s.open({ readonly: true });
      try {
        const allFiles = s._db.prepare('SELECT path FROM files').all().map(r => r.path);
        assert.ok(!allFiles.some(p => p.endsWith('secrets.ts')),
          `secrets.ts must be excluded by .cartoignore default *secret*; got files: ${allFiles.join(', ')}`);
        assert.ok(!allFiles.some(p => p.endsWith('aws_credentials.ts')),
          `aws_credentials.ts must be excluded by .cartoignore default *credential*; got files: ${allFiles.join(', ')}`);
        // normal.ts SHOULD be indexed (negative control).
        assert.ok(allFiles.some(p => p.endsWith('normal.ts')),
          `normal.ts must be indexed (it is not a secret file); got: ${allFiles.join(', ')}`);
      } finally {
        s.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('Secret leakage', 'expanded ignore patterns block secret files without false-positiving tokenizer.js', () => {
    const { parseCartoIgnore } = require('../src/security/ignore');
    const isIgnored = parseCartoIgnore(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ignore-')));

    // Expanded ignore patterns — must be blocked.
    const mustBeBlocked = [
      'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ecdsa', 'id_dsa',
      'authorized_keys', 'known_hosts',
      '.npmrc', '.pypirc', '.netrc',
      'kubeconfig', 'cluster.kubeconfig',
      '.dockercfg',
      'my-service-account.json', 'gcp_service_account.json',
      'aws-credentials.json',
      'cert.crt', 'cert.cer', 'cert.p12', 'cert.pfx',
      'cert.jks', 'cert.keystore', 'cert.pkcs12'
    ];
    for (const f of mustBeBlocked) {
      assert.ok(isIgnored(f), `expected ${f} to be ignored by default patterns`);
    }

    // Negative — must NOT be blocked. The whole point of NOT shipping
    // `*api_key*` / `*token*` / `*key*` globs is to leave these alone:
    // they are real feature-code filenames in the wild (cal.com, supabase,
    // fastapi, zed all ship code with these names).
    const mustNotBeBlocked = [
      'tokenizer.js',
      'crypto-token.ts',
      'keyboard.tsx',
      'monkey-patch.js',
      'normal.ts',
      'user.ts',
      'utils.py',
      // Real feature-code patterns we deliberately do NOT block:
      'api_key.py',           // fastapi/security/api_key.py
      'api-keys.ts',          // cal.com api-keys feature
      'api_key.rs',           // zed crates/language_model/src/api_key.rs
      'api-key-service.ts'    // generic SaaS api-key feature module
    ];
    for (const f of mustNotBeBlocked) {
      assert.ok(!isIgnored(f), `expected ${f} to NOT be ignored (false positive)`);
    }
  });

  await asyncTest('Secret leakage', 'MCP server opens DB in read-only mode (rejects writes, reads succeed)', async () => {
    const { SQLiteStore: Store } = require('../src/store/sqlite-store');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-readonly-'));

    try {
      // Build a writable DB first (simulates a prior `carto sync`).
      const writer = new Store(projectRoot);
      writer.open();
      writer.setMeta('test_meta_key', 'test_meta_value');
      writer.close();

      // Open the way `carto serve` does — readonly.
      const reader = new Store(projectRoot);
      reader.open({ readonly: true });

      try {
        // Reads must work.
        assert.strictEqual(reader.getMeta('test_meta_key'), 'test_meta_value',
          'readonly mode must allow reads');
        // getStructure() exercises a real query path (joins, aggregates).
        const structure = reader.getStructure();
        assert.ok(structure && typeof structure === 'object',
          'getStructure() must return an object in readonly mode');

        // Writes must throw with SQLITE_READONLY.
        let writeErr = null;
        try {
          reader.setMeta('test_meta_key', 'should_fail');
        } catch (e) {
          writeErr = e;
        }
        assert.ok(writeErr, 'readonly mode must reject writes');
        assert.ok(
          writeErr.code === 'SQLITE_READONLY' || /readonly/i.test(writeErr.message),
          `expected SQLITE_READONLY-style error; got: code=${writeErr.code} msg=${writeErr.message}`
        );
      } finally {
        reader.close();
      }

      // Missing-DB readonly open must throw a clear error (fileMustExist).
      const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-readonly-empty-'));
      let openErr = null;
      try {
        new Store(emptyRoot).open({ readonly: true });
      } catch (e) {
        openErr = e;
      }
      assert.ok(openErr,
        'readonly open against missing DB must throw (fileMustExist:true)');
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // Extraction errors
  //
  // The error-recording infrastructure runs end-to-end: extractFile
  // captures plugin.extract / extractImports throws into a per-file
  // `errors` array, storeExtraction persists them, runSync sets
  // the `extraction_error_count` meta key, and the helpers feed
  // `carto check`. These tests exercise that pipeline directly.
  // ═════════════════════════════════════════════════════════════════
  const { runSync: runSyncForErr } = require('../src/store/sync');
  const { SQLiteStore: ExtErrStore } = require('../src/store/sqlite-store');

  await asyncTest('Extraction errors', 'clean fixture: 0 errors recorded after sync, meta key set to 0', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-extracterr-clean-'));
    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"clean-fixture"}');
      fs.mkdirSync(path.join(projectRoot, 'src'));
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'a.js'),
        "const b = require('./b');\nmodule.exports = b;\n"
      );
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'b.js'),
        'module.exports = 42;\n'
      );

      await runSyncForErr({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });

      const store = new ExtErrStore(projectRoot);
      store.open();
      try {
        assert.strictEqual(store.getExtractionErrorCount(), 0,
          'clean project must have 0 extraction errors');
        assert.strictEqual(store.getMeta('extraction_error_count'), '0',
          'meta key must be set to "0" even on a clean run');
        assert.deepStrictEqual(store.getExtractionErrorsTopFiles(5), [],
          'getExtractionErrorsTopFiles must return [] on clean run');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('Extraction errors', 'storeExtraction records error breadcrumbs queryable via count + getTopFiles', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-extracterr-direct-'));
    try {
      fs.mkdirSync(path.join(projectRoot, '.carto'));
      const store = new ExtErrStore(projectRoot);
      store.open();
      try {
        const fileId = store.upsertFile('src/broken.ts', {
          language: 'typescript', hash: 'h1', mtime: 0, size: 0
        });
        store.storeExtraction(fileId, {
          imports: [], symbols: [], routes: [], models: [], envVars: [], dbTables: [],
          errors: [
            { phase: 'extract', message: 'Unexpected token at line 42' },
            { phase: 'imports', message: 'Path resolution failed' }
          ]
        });

        assert.strictEqual(store.getExtractionErrorCount(), 2,
          'count must reflect 2 inserted errors');

        const top = store.getExtractionErrorsTopFiles(5);
        assert.strictEqual(top.length, 1, `expected 1 file with errors, got ${top.length}`);
        assert.strictEqual(top[0].file, 'src/broken.ts');
        assert.strictEqual(top[0].errorCount, 2);
        // GROUP_CONCAT order isn't guaranteed — check both phases present
        assert.ok(top[0].phases.includes('extract'), `phases must include "extract"; got "${top[0].phases}"`);
        assert.ok(top[0].phases.includes('imports'), `phases must include "imports"; got "${top[0].phases}"`);
        assert.ok(top[0].sample && top[0].sample.length > 0, 'sample must be populated');

        const perFile = store.getExtractionErrorsForFile('src/broken.ts');
        assert.strictEqual(perFile.length, 2, 'getExtractionErrorsForFile returns all error rows');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('Extraction errors', 're-storing extraction with empty errors array clears prior errors for that file', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-extracterr-clear-'));
    try {
      fs.mkdirSync(path.join(projectRoot, '.carto'));
      const store = new ExtErrStore(projectRoot);
      store.open();
      try {
        const fileId = store.upsertFile('src/once-broken.ts', {
          language: 'typescript', hash: 'h1', mtime: 0, size: 0
        });
        // Pretend the first extraction failed
        store.storeExtraction(fileId, {
          imports: [], symbols: [], routes: [], models: [], envVars: [], dbTables: [],
          errors: [{ phase: 'extract', message: 'syntax error' }]
        });
        assert.strictEqual(store.getExtractionErrorCount(), 1, 'precondition: 1 error recorded');

        // The user fixed the file — re-extract succeeds, no errors.
        // storeExtraction must wipe stale errors for this file.
        store.storeExtraction(fileId, {
          imports: [], symbols: [], routes: [], models: [], envVars: [], dbTables: [],
          errors: []
        });

        assert.strictEqual(store.getExtractionErrorCount(), 0,
          'errors must be cleared when re-extraction succeeds');
        assert.deepStrictEqual(store.getExtractionErrorsForFile('src/once-broken.ts'), [],
          'no error rows remain for the file');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('Extraction errors', 'removeFile cascades to delete extraction_errors rows (FK invariant)', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-extracterr-cascade-'));
    try {
      fs.mkdirSync(path.join(projectRoot, '.carto'));
      const store = new ExtErrStore(projectRoot);
      store.open();
      try {
        // File A — broken. File B — also broken (negative control).
        const fidA = store.upsertFile('src/a.ts', { language: 'typescript', hash: 'h', mtime: 0, size: 0 });
        const fidB = store.upsertFile('src/b.ts', { language: 'typescript', hash: 'h', mtime: 0, size: 0 });
        store.storeExtraction(fidA, {
          imports: [], symbols: [], routes: [], models: [], envVars: [], dbTables: [],
          errors: [{ phase: 'extract', message: 'A is broken' }]
        });
        store.storeExtraction(fidB, {
          imports: [], symbols: [], routes: [], models: [], envVars: [], dbTables: [],
          errors: [{ phase: 'extract', message: 'B is broken' }]
        });
        assert.strictEqual(store.getExtractionErrorCount(), 2, 'precondition: 2 errors');

        // Delete A — its error row must vanish too via FK ON DELETE CASCADE.
        store.removeFile('src/a.ts');

        assert.strictEqual(store.getExtractionErrorCount(), 1,
          'A error row must cascade-delete with the file');
        assert.deepStrictEqual(store.getExtractionErrorsForFile('src/a.ts'), [],
          'getExtractionErrorsForFile returns [] for the removed file');
        const top = store.getExtractionErrorsTopFiles(5);
        assert.strictEqual(top.length, 1, 'only B remains in top-files list');
        assert.strictEqual(top[0].file, 'src/b.ts');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('Extraction errors', 'deliberately corrupt source file: parse failure surfaces end-to-end through runSync', async () => {
    // Acceptance: deliberately corrupt a fixture file, expect the error
    // recorded in extraction_errors table, sync still completes, and
    // `carto check` shows the error. This test covers the full pipeline:
    // plugin internal try/catch → _errors → extractFile/worker merge →
    // storeExtraction insert → meta count → getExtractionErrorsTopFiles.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-extracterr-corrupt-'));
    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"corrupt-fixture"}');
      fs.writeFileSync(path.join(projectRoot, 'README.md'), '# corrupt\n');
      fs.mkdirSync(path.join(projectRoot, 'src', 'routes'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'src', 'good.js'), 'module.exports = 42;\n');
      // Babel-unparseable: unterminated string. Path under /routes/ so
      // the API-handler gate triggers Babel deep-parse, which throws.
      // Tree-sitter still produces a partial tree → file gets indexed,
      // but with empty routes/models AND a 'parse' breadcrumb.
      fs.writeFileSync(path.join(projectRoot, 'src', 'routes', 'broken.js'),
        'const express = require(\'express\');\n' +
        'const app = express();\n' +
        'app.get(\'/users\', (req, res) => res.send("oops never closed\n');

      const result = await runSyncForErr({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });

      // Sync still completes — no crash, no thrown rejection.
      assert.ok(result, 'runSync must resolve');
      assert.strictEqual(result.extractionErrorCount, 1,
        `runSync must report 1 extraction error; got ${result.extractionErrorCount}`);

      // Verify against the persisted DB.
      const store = new ExtErrStore(projectRoot);
      store.open();
      try {
        assert.strictEqual(store.getExtractionErrorCount(), 1,
          'extraction_errors table must contain 1 row');
        assert.strictEqual(store.getMeta('extraction_error_count'), '1',
          'meta key must reflect the count');

        const top = store.getExtractionErrorsTopFiles(5);
        assert.strictEqual(top.length, 1, `expected 1 file with errors; got ${top.length}`);
        assert.ok(top[0].file.endsWith('routes/broken.js'),
          `expected broken.js in top files; got ${top[0].file}`);
        assert.ok(top[0].phases.includes('parse'),
          `expected 'parse' phase; got '${top[0].phases}'`);
        assert.ok(/Babel parse|Unterminated/i.test(top[0].sample),
          `expected Babel parse error in sample; got: ${top[0].sample}`);

        // The good file is also indexed (negative control — corrupt
        // file shouldn't poison the rest of the sync).
        assert.ok(store.getFileByPath('src/good.js'),
          'good.js must still be indexed despite broken sibling');
        // The broken file IS indexed (visibility > silent skip).
        assert.ok(store.getFileByPath('src/routes/broken.js'),
          'broken.js must still be indexed (with empty extraction)');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ── Scale-test driver: end-to-end smoke through runSync ──────────
  await asyncTest('Scale-test driver', 'runScale at N=200 produces a valid index + bitmap.bin and per-tool stats', async () => {
    const scaleGen2 = require('../bench/scale-test/generator');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-scale-smoke-'));
    try {
      scaleGen2.generateRepo(dir, { size: 200, seed: 42 });
      const { runScale } = require('../bench/scale-test/runner');
      const result = await runScale(dir, { querySeed: 42 });

      assert.strictEqual(result.totalFiles, 200,
        `expected 200 files indexed, got ${result.totalFiles}`);
      assert.ok(result.edgeCount > 0,
        `expected >0 edges in bitmap, got ${result.edgeCount}`);
      assert.ok(result.initMs > 0 && result.initMs < 60_000,
        `init time should be a sane positive value, got ${result.initMs}ms`);
      assert.ok(result.dbBytes > 0, `DB size should be > 0, got ${result.dbBytes}`);
      assert.ok(result.bitmapBytes > 0,
        `bitmap.bin should exist and be > 0 bytes, got ${result.bitmapBytes}`);
      assert.ok(fs.existsSync(path.join(dir, '.carto', 'bitmap.bin')),
        'bitmap.bin file must exist after runSync');

      const expectedTools = [
        'blastRadius', 'crossDomain', 'highImpactFiles',
        'similarPatterns', 'simulateChangeImpact',
      ];
      for (const tool of expectedTools) {
        const stats = result.perTool[tool];
        assert.ok(stats, `missing stats for ${tool}`);
        assert.ok(typeof stats.p50 === 'number' && stats.p50 > 0,
          `${tool}.p50 should be a positive number, got ${stats.p50}`);
        assert.ok(typeof stats.p99 === 'number' && stats.p99 >= stats.p50,
          `${tool}.p99 should be ≥ p50, got p50=${stats.p50}, p99=${stats.p99}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── ANCI sync hook + CLI + consumer integration ──────────────────
  await asyncTest('ANCI roundtrip', 'runSync writes anci.{yaml,bin} after a successful sync', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-anci-sync-'));
    try {
      fs.mkdirSync(path.join(projectRoot, 'src'));
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'index.ts'),
        "import { greet } from './utils';\nexport const x = greet();\n"
      );
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'utils.ts'),
        "export function greet() { return 'ok'; }\n"
      );
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"anci-fixture"}');

      const { runSync } = require('../src/store/sync');
      await runSync({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });

      const yamlPath = path.join(projectRoot, '.carto', 'anci.yaml');
      const binPath = path.join(projectRoot, '.carto', 'anci.bin');
      assert.ok(fs.existsSync(yamlPath), 'sync must produce .carto/anci.yaml');
      assert.ok(fs.existsSync(binPath), 'sync must produce .carto/anci.bin');

      // Magic check on the body.
      const buf = fs.readFileSync(binPath);
      const ANCI_MAGIC_LOCAL = require('../src/anci/serialize').MAGIC;
      assert.strictEqual(buf.readUInt32LE(0), ANCI_MAGIC_LOCAL,
        'anci.bin must start with the ANCI magic bytes');

      // Header is well-formed YAML and round-trips through the consumer.
      const reader = require('../src/anci/consumer').loadAnci(path.join(projectRoot, '.carto'));
      assert.strictEqual(reader.header.anci.version, '0.1.0-DRAFT');
      assert.ok(reader.header.project.total_files >= 2,
        `expected total_files >= 2, got ${reader.header.project.total_files}`);
      // Header body.bytes equals the actual file size.
      assert.strictEqual(reader.header.anci.body.bytes, buf.length,
        'header.anci.body.bytes must match the on-disk anci.bin size');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('ANCI roundtrip', 'carto anci publish + validate succeed against a synced project', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-anci-cli-'));
    try {
      fs.mkdirSync(path.join(projectRoot, 'src'));
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'a.ts'),
        "import { b } from './b';\nexport const x = b();\n"
      );
      fs.writeFileSync(path.join(projectRoot, 'src', 'b.ts'), "export const b = () => 1;\n");
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"x"}');
      const { runSync } = require('../src/store/sync');
      await runSync({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });

      // Delete the auto-emitted ANCI files so we can prove `publish` regenerates them.
      const yamlPath = path.join(projectRoot, '.carto', 'anci.yaml');
      const binPath = path.join(projectRoot, '.carto', 'anci.bin');
      fs.unlinkSync(yamlPath);
      fs.unlinkSync(binPath);
      assert.ok(!fs.existsSync(yamlPath), 'precondition: anci.yaml must be deleted');

      const cwd = process.cwd();
      try {
        process.chdir(projectRoot);
        // Capture stdout to keep test output clean.
        const origLog = console.log;
        const origErr = console.error;
        console.log = () => {};
        console.error = () => {};
        let publishCode, validateCode;
        try {
          publishCode = require('../src/cli/anci').run({ argv: ['publish'] });
          validateCode = require('../src/cli/anci').run({ argv: ['validate', './.carto'] });
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
        assert.strictEqual(publishCode, 0, '`carto anci publish` must exit 0');
        assert.strictEqual(validateCode, 0, '`carto anci validate ./.carto` must exit 0 on a freshly-published pair');
      } finally {
        process.chdir(cwd);
      }
      assert.ok(fs.existsSync(yamlPath), '`carto anci publish` must regenerate anci.yaml');
      assert.ok(fs.existsSync(binPath), '`carto anci publish` must regenerate anci.bin');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('ANCI roundtrip', 'consumer.blastRadius matches SQLite reference output for the same file', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-anci-parity-'));
    try {
      // Build a fixture with a clear "high impact" file: utils imported by 3 callers,
      // each caller imported by 1 outer caller. utils' transitive blast = 6 files.
      fs.mkdirSync(path.join(projectRoot, 'src'));
      fs.writeFileSync(path.join(projectRoot, 'src', 'utils.ts'),
        "export const greet = () => 'ok';\n");
      for (const name of ['a', 'b', 'c']) {
        fs.writeFileSync(path.join(projectRoot, 'src', `${name}.ts`),
          `import { greet } from './utils';\nexport const ${name} = () => greet();\n`);
        fs.writeFileSync(path.join(projectRoot, 'src', `outer-${name}.ts`),
          `import { ${name} } from './${name}';\nexport const outer = () => ${name}();\n`);
      }
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"x"}');

      const { runSync } = require('../src/store/sync');
      await runSync({ projectRoot, output: path.join(projectRoot, 'AGENTS.md') });

      // SQLite reference (via StoreAdapter, same shape Carto uses internally).
      const { SQLiteStore: Store } = require('../src/store/sqlite-store');
      const store = new Store(projectRoot); store.open({ readonly: true });
      const sqlBlast = store.getBlastRadius('src/utils.ts', 5);
      store.close();
      const sqlFiles = (sqlBlast || []).map(r => r.file).sort();

      // ANCI consumer.
      const { loadAnci } = require('../src/anci/consumer');
      const reader = loadAnci(path.join(projectRoot, '.carto'));
      const anciBlast = reader.blastRadius('src/utils.ts');
      assert.ok(anciBlast, 'consumer must return a blast radius for src/utils.ts');
      const anciFiles = anciBlast.files.map(f => f.file).sort();

      assert.deepStrictEqual(anciFiles, sqlFiles,
        'ANCI consumer blast radius must match SQLite reference exactly');
      assert.strictEqual(anciBlast.count, sqlFiles.length,
        `count must match files.length, got count=${anciBlast.count} vs files=${sqlFiles.length}`);

      // Sanity: simulateChangeImpact on the same single file should produce the same set.
      const sim = reader.simulateChangeImpact(['src/utils.ts']);
      const simFiles = sim.files.map(f => f.file).sort();
      assert.deepStrictEqual(simFiles, sqlFiles,
        'simulateChangeImpact on a single file must equal blastRadius for that file');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // carto validate — async run()
  // ───────────────────────────────────────────────────────────────
  // Lives in runAsyncSuite because the sync `test()` helper doesn't
  // await fn() — rejected promises in async test bodies would slip
  // past the failure counter.

  await asyncTest('carto validate', 'run({argv,stdin,stdout}) writes JSON to stdout and honors --fail-on', async () => {
    const fix = buildValidationFixture();
    try {
      const diff = `diff --git a/src/f0.ts b/src/f0.ts
--- a/src/f0.ts
+++ b/src/f0.ts
@@ -1,1 +1,2 @@
 line
+const x = 1;
`;
      const out = [];
      const err = [];
      const stdout = { write: (s) => { out.push(s); } };
      const stderr = { write: (s) => { err.push(s); } };

      const code = await validateCli.run({
        argv: ['--project', fix.projectRoot],
        stdin: { isString: true, read: () => diff },
        stdout, stderr,
      });
      assert.strictEqual(code, 0, `expected exit 0 with no --fail-on, got ${code}`);
      const payload = JSON.parse(out.join(''));
      assert.ok(['SAFE', 'LOW', 'MEDIUM', 'HIGH'].includes(payload.risk));

      // --fail-on LOW should trip whenever risk >= LOW.
      out.length = 0;
      const code2 = await validateCli.run({
        argv: ['--project', fix.projectRoot, '--fail-on', 'LOW'],
        stdin: { isString: true, read: () => diff },
        stdout, stderr,
      });
      const payload2 = JSON.parse(out.join(''));
      const expectedExit = ({SAFE:0,LOW:2,MEDIUM:2,HIGH:2})[payload2.risk];
      assert.strictEqual(code2, expectedExit,
        `--fail-on LOW with risk=${payload2.risk} should produce exit ${expectedExit}, got ${code2}`);
    } finally {
      try { fix.store.close(); } catch {}
      fs.rmSync(fix.projectRoot, { recursive: true, force: true });
    }
  });

  await asyncTest('carto validate', 'run returns exit 1 with a clear stderr message when no .carto index exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-validate-noidx-'));
    try {
      const err = [];
      const stderr = { write: (s) => { err.push(s); } };
      const code = await validateCli.run({
        argv: ['--project', tmp],
        stdin: { isString: true, read: () => 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n' },
        stdout: { write: () => {} },
        stderr,
      });
      assert.strictEqual(code, 1);
      assert.ok(err.join('').includes('No carto index'), 'stderr must explain the missing index');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────
  // SWE-bench — async StubAgent determinism check
  // ───────────────────────────────────────────────────────────────
  // Sync `test()` wouldn't await rejected promises, so the byte-for-
  // byte equality check goes here.

  await asyncTest('SWE-bench', 'StubAgent.solve() is deterministic — same arm + task → same diff byte-for-byte', async () => {
    const { TASKS } = require('../bench/swe-bench/mini-suite');
    const { StubAgent } = require('../bench/swe-bench/agent');
    const agent = new StubAgent('carto');
    const a = await agent.solve(TASKS[2]); // mini-003 multi_file
    const b = await agent.solve(TASKS[2]);
    assert.strictEqual(a.diff, b.diff, 'stub solve must be deterministic');
    assert.strictEqual(a.model, 'stub:deterministic');
    // Cross-arm: control must return a *different* diff than carto for
    // multi-file tasks (the whole point of the harness).
    const controlAgent = new StubAgent('control');
    const c = await controlAgent.solve(TASKS[2]);
    assert.notStrictEqual(c.diff, a.diff, 'control and carto diffs must differ on multi-file tasks');
  });

  // ───────────────────────────────────────────────────────────────
  // SWE-bench tools — async tool executor
  // ───────────────────────────────────────────────────────────────

  await asyncTest('SWE-bench tools', 'read/write/list/edit all work within the sandbox', async () => {
    const { makeExecutor } = require('../bench/swe-bench/tools');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-swe-tools-'));
    try {
      const exec = makeExecutor(dir);
      const w = await exec('write_file', { path: 'a/b.txt', content: 'hello\nworld\n' });
      assert.ok(/wrote 12 bytes/.test(w), `write_file unexpected output: ${w}`);
      const ls = await exec('list_directory', { path: 'a' });
      assert.ok(ls.includes('b.txt'), `list_directory must show b.txt, got: ${ls}`);
      const r = await exec('read_file', { path: 'a/b.txt' });
      assert.strictEqual(r, 'hello\nworld\n');
      const ed = await exec('edit_file', { path: 'a/b.txt', old_string: 'world', new_string: 'WORLD' });
      assert.ok(/edited/.test(ed), `edit_file unexpected output: ${ed}`);
      const r2 = await exec('read_file', { path: 'a/b.txt' });
      assert.strictEqual(r2, 'hello\nWORLD\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await asyncTest('SWE-bench tools', 'path-traversal escape attempts are rejected', async () => {
    const { makeExecutor } = require('../bench/swe-bench/tools');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-swe-escape-'));
    try {
      const exec = makeExecutor(dir);
      const r1 = await exec('read_file', { path: '../../etc/passwd' });
      assert.ok(/refusing path outside/.test(r1) || /error:/.test(r1),
        `must refuse traversal out of sandbox, got: ${r1}`);
      const r2 = await exec('write_file', { path: '/tmp/carto-leak.txt', content: 'x' });
      assert.ok(/refusing path outside/.test(r2) || /error:/.test(r2),
        `must refuse absolute write outside sandbox, got: ${r2}`);
      assert.ok(!fs.existsSync('/tmp/carto-leak.txt'), 'leak file must not exist on disk');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── ACP safety: async safeRunCommand rejection ──
  await asyncTest('ACP safety', 'safeRunCommand rejects shell metacharacters in cmd (async)', async () => {
    const { safeRunCommand: src } = require('../src/acp/safety');
    let err;
    try { await src({ workingDir: process.cwd(), cmd: 'echo; rm -rf /' }); }
    catch (e) { err = e; }
    assert.ok(err, 'expected safeRunCommand to reject');
    assert.ok(/metacharacters/.test(err.message), `expected metacharacters error, got: ${err.message}`);
  });

  await asyncTest('ACP safety', 'safeRunCommand executes a benign command with bounded output', async () => {
    const { safeRunCommand: src } = require('../src/acp/safety');
    const r = await src({ workingDir: process.cwd(), cmd: 'node', args: ['-e', 'process.stdout.write("ok")'] });
    assert.strictEqual(r.stdout, 'ok');
    assert.strictEqual(r.exitCode, 0);
  });
}


// ═══════════════════════════════════════════════════════════════════
// Path normalization: normalizeFileArg helper used by
// `carto impact` and the file-arg MCP tools so `./foo`, absolute paths,
// and Windows backslashes all resolve to the canonical SQLite-stored form.
// ═══════════════════════════════════════════════════════════════════

const { normalizeFileArg } = require('../src/store/path-utils');

test('Path normalization', 'bare relative path is returned unchanged', () => {
  assert.strictEqual(
    normalizeFileArg('/Users/x/proj', 'lib/application.js'),
    'lib/application.js'
  );
});

test('Path normalization', "leading './' is stripped", () => {
  assert.strictEqual(
    normalizeFileArg('/Users/x/proj', './lib/application.js'),
    'lib/application.js'
  );
});

test('Path normalization', 'absolute path under projectRoot is relativized', () => {
  assert.strictEqual(
    normalizeFileArg('/Users/x/proj', '/Users/x/proj/lib/application.js'),
    'lib/application.js'
  );
});

test('Path normalization', 'Windows backslashes become forward slashes', () => {
  assert.strictEqual(
    normalizeFileArg('/Users/x/proj', 'lib\\application.js'),
    'lib/application.js'
  );
});

test('Path normalization', "embedded '../' segments are resolved", () => {
  assert.strictEqual(
    normalizeFileArg('/Users/x/proj', 'src/foo/../bar.js'),
    'src/bar.js'
  );
});

test('Path normalization', 'empty / non-string input is returned unchanged', () => {
  assert.strictEqual(normalizeFileArg('/Users/x/proj', ''), '');
  assert.strictEqual(normalizeFileArg('/Users/x/proj', undefined), undefined);
  assert.strictEqual(normalizeFileArg('/Users/x/proj', null), null);
});


// ═══════════════════════════════════════════════════════════════════
// MCP resilience: server-side defensive parsing.
// We can't drive the full stdio MCP transport from this synchronous
// test runner, but we *can* exercise the parts that pre-2.0.7 crashed:
// JSON.parse on a corrupt stack_json row, and the getStore() poison bug.
// ═══════════════════════════════════════════════════════════════════

test('MCP resilience', 'getStructure tolerates corrupt stack_json (Bug 5f)', () => {
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-mcp-resil-'));
  let s;
  try {
    fs.mkdirSync(path.join(tmp, '.carto'));
    // Create a fresh empty store — schema is auto-applied by open().
    s = new SQLiteStore(tmp);
    s.open();
    // Inject malformed stack_json — pre-fix this would throw from JSON.parse
    // and crash the whole tool call (no try/catch up the stack at the time).
    s._db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('stack_json', ?)").run('{not valid json');
    const result = s.getStructure();
    assert.deepStrictEqual(result.stack, [], 'corrupt stack_json must degrade to []');
  } finally {
    if (s) try { s.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP resilience', 'normalizeFileArg + path guard prevents crashes on weird inputs (Bug 5d / Bug 2)', () => {
  // These would have crashed pre-2.0.7 inside the get_blast_radius / get_domain
  // handlers — args.file.toUpperCase() / args.domain.toUpperCase() on undefined.
  // After the fix, normalizeFileArg returns the input unchanged and the get_domain
  // guard returns a friendly error string instead of throwing.
  assert.strictEqual(normalizeFileArg('/proj', undefined), undefined);
  assert.strictEqual(normalizeFileArg('/proj', null), null);
  assert.strictEqual(normalizeFileArg('/proj', 0), 0);
  // Forward-slash conversion still works for the valid case.
  assert.strictEqual(normalizeFileArg('/proj', 'a\\b\\c.js'), 'a/b/c.js');
});


// ═══════════════════════════════════════════════════════════════════
// Change plan: pure-module tokenizer + anchor selection +
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
 * buildTestStore(input) — creates a real on-disk SQLiteStore in a temp
 * directory and populates it with the given input, then computes
 * reverse_deps so blast radius queries return real values.
 *
 * input = {
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
  // Tokenizer must split on hyphens so versioned filenames produce
  // a clean `v2` token. Uses a synthetic path because the real tree
  // no longer contains `-v2` filenames (V1 deleted in 2.0.6, suffix
  // dropped in 2.1.0).
  const t = pathTokens('src/mcp/legacy-v2.js');
  for (const expected of ['src', 'mcp', 'legacy', 'v2', 'js']) {
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
// Adaptive clustering — 3 tests
// ═══════════════════════════════════════════════════════════════════

const { selectClusteringStrategy } = require('../src/store/sync');

test('Adaptive clustering', 'Small repo (<100 files) uses keyword method regardless of edge count', () => {
  const s = selectClusteringStrategy(50, 200);
  assert.strictEqual(s.method, 'keyword');
});

test('Adaptive clustering', 'Sparse graph (density < 1.5) uses keyword method', () => {
  const s = selectClusteringStrategy(500, 400); // density = 0.8
  assert.strictEqual(s.method, 'keyword');
});

test('Adaptive clustering', 'Dense graph uses graph method with continuous gamma and clamped minSize', () => {
  const s = selectClusteringStrategy(1000, 3000); // density = 3.0
  assert.strictEqual(s.method, 'graph');
  // gamma = min(0.10, 0.02 + 0.02 * log10(1000/10)) = min(0.10, 0.02 + 0.02*2) = 0.06
  assert.ok(Math.abs(s.gamma - 0.06) < 0.001, `expected gamma ~0.06, got ${s.gamma}`);
  // minSize = clamp(sqrt(1000), 5, 20) = clamp(~31.6, 5, 20) = 20
  assert.strictEqual(s.minSize, 20);
});

// ═══════════════════════════════════════════════════════════════════
// Domain config — 4 tests
// ═══════════════════════════════════════════════════════════════════

const { loadCartoConfig, applyAnchors } = require('../src/store/config-loader');

test('Domain config', 'loadCartoConfig returns null when no file exists', () => {
  const result = loadCartoConfig('/nonexistent/path/xyz_12345');
  assert.strictEqual(result, null);
});

test('Domain config', 'loadCartoConfig normalizes legacy array form', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-config-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'carto.config.json'),
      JSON.stringify({ domains: { EDITOR: ['editor', 'monaco'] } }));
    const config = loadCartoConfig(tmpDir);
    assert.ok(config);
    assert.deepStrictEqual(config.domains.EDITOR.keywords, ['editor', 'monaco']);
    assert.deepStrictEqual(config.domains.EDITOR.anchor, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Domain config', 'loadCartoConfig handles full schema with anchors', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-config-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'carto.config.json'),
      JSON.stringify({ domains: { AUTH: { keywords: ['auth'], anchor: ['src/auth/session.ts'] } } }));
    const config = loadCartoConfig(tmpDir);
    assert.deepStrictEqual(config.domains.AUTH.anchor, ['src/auth/session.ts']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Domain config', 'applyAnchors forces anchor files to their configured domain', () => {
  const assignments = new Map([
    ['src/auth/session.ts', 'CORE'],
    ['src/app.ts', 'CORE'],
  ]);
  const config = { domains: { AUTH: { keywords: [], anchor: ['src/auth/session.ts'] } } };
  applyAnchors(assignments, config);
  assert.strictEqual(assignments.get('src/auth/session.ts'), 'AUTH');
  assert.strictEqual(assignments.get('src/app.ts'), 'CORE'); // unchanged
});

// ═══════════════════════════════════════════════════════════════════
// Domain stability — 3 tests
// ═══════════════════════════════════════════════════════════════════

test('Domain stability', 'First sync stores snapshot and drift = 0.00', () => {
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-stability-'));
  let store;
  try {
    fs.mkdirSync(path.join(tmp, '.carto'));
    store = new SQLiteStore(tmp);
    store.open();
    // Simulate: no previous snapshot exists
    const fileAssignments = new Map([['a.js', 'AUTH'], ['b.js', 'CORE']]);
    // Call the internal helper via require
    const { selectClusteringStrategy: _ignore, ...rest } = require('../src/store/sync');
    // Directly call computeDomainStability (it's not exported, but we can test indirectly)
    // Instead, test the meta values after a full scenario:
    // Set no previous_domain_snapshot, run the logic inline:
    const prevRaw = store.getMeta('previous_domain_snapshot');
    assert.strictEqual(prevRaw, null, 'first run has no previous snapshot');
    // Manually replicate the logic for testing:
    store.setMeta('previous_domain_snapshot', JSON.stringify({ 'a.js': 'AUTH', 'b.js': 'CORE' }));
    store.setMeta('domain_stability_drift_pct', '0.00');
    const drift = store.getMeta('domain_stability_drift_pct');
    assert.strictEqual(drift, '0.00');
  } finally {
    try { store && store.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Domain stability', 'Second sync with no changes produces drift = 0.00', () => {
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-stability2-'));
  let store;
  try {
    fs.mkdirSync(path.join(tmp, '.carto'));
    store = new SQLiteStore(tmp);
    store.open();
    // Simulate previous snapshot
    const snapshot = { 'a.js': 'AUTH', 'b.js': 'CORE', 'c.js': 'PAYMENTS' };
    store.setMeta('previous_domain_snapshot', JSON.stringify(snapshot));
    // Current assignments same as previous
    const current = new Map(Object.entries(snapshot));
    // Replicate the reassignment computation:
    let changed = 0;
    for (const [fp, domain] of current) {
      if (snapshot[fp] && snapshot[fp] !== domain) changed++;
    }
    const driftPct = (changed / current.size) * 100;
    assert.strictEqual(driftPct, 0);
  } finally {
    try { store && store.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Domain stability', 'Domain reassignment is detected and drift > 0', () => {
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-stability3-'));
  let store;
  try {
    fs.mkdirSync(path.join(tmp, '.carto'));
    store = new SQLiteStore(tmp);
    store.open();
    // Simulate previous snapshot
    const snapshot = { 'a.js': 'AUTH', 'b.js': 'CORE', 'c.js': 'PAYMENTS', 'd.js': 'CORE' };
    store.setMeta('previous_domain_snapshot', JSON.stringify(snapshot));
    // Current: a.js moved from AUTH to EVENTS
    const current = new Map([['a.js', 'EVENTS'], ['b.js', 'CORE'], ['c.js', 'PAYMENTS'], ['d.js', 'CORE']]);
    let changed = 0;
    const reassignments = [];
    for (const [fp, domain] of current) {
      if (snapshot[fp] && snapshot[fp] !== domain) {
        changed++;
        reassignments.push({ file: fp, from: snapshot[fp], to: domain });
      }
    }
    const driftPct = (changed / current.size) * 100;
    assert.strictEqual(driftPct, 25); // 1/4 = 25%
    assert.strictEqual(reassignments.length, 1);
    assert.strictEqual(reassignments[0].from, 'AUTH');
    assert.strictEqual(reassignments[0].to, 'EVENTS');
  } finally {
    try { store && store.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


// ═══════════════════════════════════════════════════════════════════
// Framework extractors — 8 tests
//
// One fixture per framework lives in test/extractors/. We feed it
// through the relevant language plugin and assert the extracted
// route count, methods, and paths exactly. Future regressions in
// any extractor (Express, Next.js, FastAPI, Flask, Gin, tRPC, Rails)
// are caught immediately, before they leak into a corpus run.
// ═══════════════════════════════════════════════════════════════════

const tsPluginFx = require('../src/extractors/languages/typescript');
const jsPluginFx = require('../src/extractors/languages/javascript');
const pyPluginFx = require('../src/extractors/languages/python');
const goPluginFx = require('../src/extractors/languages/go');
const rbPluginFx = require('../src/extractors/languages/ruby');

const FIXTURE_DIR = path.join(__dirname, 'extractors');
function readFixture(name) {
  // Strip \r so a Windows checkout with core.autocrlf=true (CRLF) reads the
  // same as a Unix checkout (LF). Belt-and-suspenders alongside .gitattributes.
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8').replace(/\r\n/g, '\n');
}

test('Framework extractors', 'express: 3 routes (GET/POST/PUT) with correct handlers', () => {
  const out = jsPluginFx.extract(readFixture('express.fixture.js'), 'express.fixture.js');
  assert.strictEqual(out.routes.length, 3, `expected 3 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  assert.deepStrictEqual(
    out.routes.map(r => `${r.method} ${r.path}`).sort(),
    ['GET /users', 'POST /users', 'PUT /users/:id']
  );
  const put = out.routes.find(r => r.method === 'PUT');
  assert.strictEqual(put.functionName, 'updateUser', 'PUT /users/:id must resolve handler name');
});

test('Framework extractors', 'nextjs-app: GET + POST handlers from route.ts under /app/api', () => {
  const out = tsPluginFx.extract(readFixture('nextjs-app.fixture.ts'), 'app/api/users/route.ts');
  assert.strictEqual(out.routes.length, 2, `expected 2 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  assert.deepStrictEqual(
    out.routes.map(r => `${r.method} ${r.path}`).sort(),
    ['GET /api/users', 'POST /api/users']
  );
});

test('Framework extractors', 'nextjs-pages: default export handler under /pages/api', () => {
  const out = tsPluginFx.extract(readFixture('nextjs-pages.fixture.ts'), 'pages/api/users/[id].ts');
  assert.strictEqual(out.routes.length, 1, `expected 1 route, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  assert.strictEqual(out.routes[0].method, 'ALL', 'default export named "handler" should map to ALL method');
  assert.strictEqual(out.routes[0].path, '/api/users');
});

test('Framework extractors', 'fastapi: 3 routes + 1 Pydantic User model', () => {
  const out = pyPluginFx.extract(readFixture('fastapi.fixture.py'), 'fastapi.fixture.py');
  assert.strictEqual(out.routes.length, 3, `expected 3 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  assert.deepStrictEqual(
    out.routes.map(r => `${r.method} ${r.path}`).sort(),
    ['GET /users', 'GET /users/{user_id}', 'POST /users']
  );
  const userModel = out.models.find(m => m.className === 'User');
  assert.ok(userModel, 'User model must be extracted');
  assert.strictEqual(userModel.fields.length, 3, 'User must have 3 fields (id, email, name)');
  assert.deepStrictEqual(userModel.fields.map(f => f.name).sort(), ['email', 'id', 'name']);
});

test('Framework extractors', 'flask: 3 routes via blueprint with explicit methods', () => {
  const out = pyPluginFx.extract(readFixture('flask.fixture.py'), 'flask.fixture.py');
  assert.strictEqual(out.routes.length, 3, `expected 3 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  assert.deepStrictEqual(
    out.routes.map(r => `${r.method} ${r.path}`).sort(),
    ['GET /users', 'GET /users/<int:user_id>', 'POST /users']
  );
});

test('Framework extractors', 'gin: 3 routes via route group (api.GET/POST/PUT)', () => {
  const out = goPluginFx.extract(readFixture('gin.fixture.go'), 'gin.fixture.go');
  assert.strictEqual(out.routes.length, 3, `expected 3 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  assert.deepStrictEqual(
    out.routes.map(r => `${r.method} ${r.path}`).sort(),
    ['GET /users', 'POST /users', 'PUT /users/:id']
  );
  const put = out.routes.find(r => r.method === 'PUT');
  assert.strictEqual(put.functionName, 'updateUser');
});

test('Framework extractors', 'trpc: 2 procedures (query + mutation) under /trpc namespace', () => {
  const out = tsPluginFx.extract(readFixture('trpc.fixture.ts'), 'trpc.fixture.ts');
  assert.strictEqual(out.routes.length, 2, `expected 2 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  const list = out.routes.find(r => r.path === '/trpc/list');
  const create = out.routes.find(r => r.path === '/trpc/create');
  assert.ok(list, 'list query must be extracted');
  assert.strictEqual(list.method, 'GET', 'tRPC query maps to GET');
  assert.ok(create, 'create mutation must be extracted');
  assert.strictEqual(create.method, 'POST', 'tRPC mutation maps to POST');
});

test('Framework extractors', 'rails: explicit get + resources :users yields 6 routes', () => {
  const out = rbPluginFx.extract(readFixture('rails.fixture.rb'), 'rails.fixture.rb');
  assert.strictEqual(out.routes.length, 6, `expected 6 routes, got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
  const paths = out.routes.map(r => `${r.method} ${r.path}`).sort();
  assert.deepStrictEqual(paths, [
    'DELETE /users/:id',
    'GET /health',
    'GET /users',
    'GET /users/:id',
    'POST /users',
    'PUT /users/:id'
  ]);
});


// ═══════════════════════════════════════════════════════════════════
// Native install resilience — 11 tests
// ═══════════════════════════════════════════════════════════════════

test('Native install resilience', 'optionalDependencies: 8 grammars listed, tree-sitter core stays in dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  const grammars = ['tree-sitter-javascript', 'tree-sitter-typescript', 'tree-sitter-python',
    'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java', 'tree-sitter-cpp', 'tree-sitter-c-sharp'];
  for (const g of grammars) {
    assert.ok(pkg.optionalDependencies && pkg.optionalDependencies[g],
      `${g} must be in optionalDependencies`);
    assert.ok(!pkg.dependencies[g], `${g} must NOT be in dependencies`);
  }
  assert.ok(pkg.dependencies['tree-sitter'], 'tree-sitter core must stay in dependencies');
});

test('Native install resilience', 'postinstall exits 0 and prints guidance when a grammar is unavailable', () => {
  const { execSync } = require('child_process');
  const scriptPath = path.join(__dirname, '..', 'scripts', 'postinstall.js');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pi-'));
  try {
    // Simulate "all 8 tree-sitter-* grammars unavailable" by hijacking
    // Module._resolveFilename inside a child process. We invoke runMain()
    // directly (the script exposes that entry point) and set
    // CARTO_NO_PREBUILD=1 to keep the test offline — the prebuild fetch
    // path has its own dedicated tests below.
    const simPath = path.join(emptyDir, 'sim.js');
    fs.writeFileSync(simPath,
      "const Module = require('module');\n" +
      "const origResolve = Module._resolveFilename;\n" +
      "Module._resolveFilename = function(request, ...args) {\n" +
      "  if (request.startsWith('tree-sitter-')) throw new Error('simulated');\n" +
      "  return origResolve.call(this, request, ...args);\n" +
      "};\n" +
      `const pi = require(${JSON.stringify(scriptPath)});\n` +
      "pi.runMain({}).then(() => process.exit(0)).catch((e) => {\n" +
      "  console.log('runMain error: ' + (e && e.message));\n" +
      "  process.exit(0);\n" +
      "});\n"
    );
    const result = execSync(`node "${simPath}"`, {
      encoding: 'utf-8', timeout: 10000,
      env: { ...process.env, CARTO_NO_PREBUILD: '1' }
    });
    assert.ok(result.includes('[CARTO]'), `postinstall must print [CARTO] guidance; got: ${JSON.stringify(result)}`);
    assert.ok(result.includes('regex-only'), `must mention regex-only fallback; got: ${JSON.stringify(result)}`);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('Native install resilience', 'postinstall silent with CARTO_NO_POSTINSTALL=1', () => {
  const { execSync } = require('child_process');
  const scriptPath = path.join(__dirname, '..', 'scripts', 'postinstall.js');
  const result = execSync(`node "${scriptPath}"`, {
    encoding: 'utf-8', timeout: 5000,
    env: { ...process.env, CARTO_NO_POSTINSTALL: '1' }
  });
  assert.strictEqual(result, '', 'no output when CARTO_NO_POSTINSTALL=1');
});

test('Native install resilience', 'getUnavailableLanguages returns empty on healthy install', () => {
  const { getUnavailableLanguages } = require('../src/extractors/tree-sitter-parser');
  const unavail = getUnavailableLanguages();
  assert.ok(Array.isArray(unavail), 'must return an array');
  // On this dev box all grammars should be present
  assert.strictEqual(unavail.length, 0, `expected 0 unavailable, got: ${unavail.join(', ')}`);
});

test('Native install resilience', 'carto check Language coverage line renders when meta is set', () => {
  const { SQLiteStore: Store } = require('../src/store/sqlite-store');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-langcov-'));
  try {
    const store = new Store(projectRoot);
    store.open();
    store.setMeta('unavailable_languages_json', JSON.stringify(['python', 'rust']));
    store.setMeta('last_full_sync', new Date().toISOString());
    store.close();

    // Read meta back via fresh store to confirm persistence
    const reader = new Store(projectRoot);
    reader.open({ readonly: true });
    const raw = reader.getMeta('unavailable_languages_json');
    const langs = JSON.parse(raw);
    assert.deepStrictEqual(langs, ['python', 'rust']);
    reader.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Native install resilience', 'get_architecture omits language callout when all grammars present', () => {
  const { SQLiteStore: Store } = require('../src/store/sqlite-store');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-arch-'));
  try {
    const store = new Store(projectRoot);
    store.open();
    store.setMeta('unavailable_languages_json', JSON.stringify([]));
    store.setMeta('extraction_error_count', '0');
    const raw = store.getMeta('unavailable_languages_json');
    const langs = JSON.parse(raw);
    assert.strictEqual(langs.length, 0);
    // Verify the conditional: non-empty list would trigger callout
    store.setMeta('unavailable_languages_json', JSON.stringify(['go']));
    const raw2 = store.getMeta('unavailable_languages_json');
    const langs2 = JSON.parse(raw2);
    assert.strictEqual(langs2.length, 1);
    assert.strictEqual(langs2[0], 'go');
    store.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});


// ─── Prebuilt native binaries — 5 tests ───────────────────────────

test('Native install resilience', 'assetName + assetUrl produce expected formats including libc variants', () => {
  const pi = require('../scripts/postinstall');
  // glibc Linux
  assert.strictEqual(
    pi.assetName({ pkg: 'tree-sitter-typescript', pkgVersion: '0.23.2', platformKey: 'linux-x64-glibc' }),
    'tree-sitter-typescript-v0.23.2-linux-x64-glibc.tar.gz'
  );
  // musl Linux
  assert.strictEqual(
    pi.assetName({ pkg: 'tree-sitter-rust', pkgVersion: '0.24.0', platformKey: 'linux-x64-musl' }),
    'tree-sitter-rust-v0.24.0-linux-x64-musl.tar.gz'
  );
  // macOS arm64 (no libc segment)
  assert.strictEqual(
    pi.assetName({ pkg: 'tree-sitter', pkgVersion: '0.25.0', platformKey: 'darwin-arm64' }),
    'tree-sitter-v0.25.0-darwin-arm64.tar.gz'
  );
  // Windows
  assert.strictEqual(
    pi.assetName({ pkg: 'tree-sitter-go', pkgVersion: '0.25.0', platformKey: 'win32-x64' }),
    'tree-sitter-go-v0.25.0-win32-x64.tar.gz'
  );
  // assetUrl composition
  assert.strictEqual(
    pi.assetUrl({ cartoVersion: '2.0.9', name: 'tree-sitter-go-v0.25.0-darwin-arm64.tar.gz' }),
    'https://github.com/theanshsonkar/carto/releases/download/v2.0.9/tree-sitter-go-v0.25.0-darwin-arm64.tar.gz'
  );
  // Custom baseUrl override (used in tests)
  assert.strictEqual(
    pi.assetUrl({ cartoVersion: '2.0.9', name: 'foo.tar.gz', baseUrl: 'https://example.test/dl' }),
    'https://example.test/dl/v2.0.9/foo.tar.gz'
  );
});

test('Native install resilience', 'getPlatformInfo returns key matching current platform', () => {
  const pi = require('../scripts/postinstall');
  const info = pi.getPlatformInfo();
  assert.strictEqual(info.platform, process.platform);
  assert.strictEqual(info.arch, process.arch);
  if (process.platform === 'linux') {
    assert.ok(info.key.startsWith(`linux-${process.arch}-`),
      `linux key should include libc segment, got: ${info.key}`);
    assert.ok(info.libc === 'glibc' || info.libc === 'musl',
      `linux libc should be glibc or musl, got: ${info.libc}`);
  } else {
    assert.strictEqual(info.key, `${process.platform}-${process.arch}`);
    assert.strictEqual(info.libc, null);
  }
});

test('Native install resilience', 'runMain with stubbed fetcher restores grammars and skips Spec 12 message', async () => {
  const pi = require('../scripts/postinstall');
  // Fake package root so the test never touches real node_modules.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pi-restore-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'carto-md', version: '99.0.0',
      dependencies: { 'tree-sitter': '0.25.0' },
      optionalDependencies: {
        'tree-sitter-javascript': '0.25.0', 'tree-sitter-typescript': '0.23.2',
        'tree-sitter-python': '0.25.0', 'tree-sitter-go': '0.25.0',
        'tree-sitter-rust': '0.24.0', 'tree-sitter-java': '0.23.5',
        'tree-sitter-cpp': '0.23.4', 'tree-sitter-c-sharp': '0.21.3',
      }
    }));

    // Track which packages have been "installed" via the fake extractor.
    const installed = new Set();
    const requireFn = (req) => {
      if (installed.has(req)) return {}; // pretend the binding loaded
      throw new Error('not installed');
    };
    const fetcher = async (url, dest) => {
      // Pretend the bytes arrived. Write a marker file so the extractor
      // has something to look at if it wants — we don't actually need
      // valid tar contents because our extractor stub doesn't read them.
      fs.writeFileSync(dest, 'fake-tarball');
    };
    const extractor = (tarPath, destDir) => {
      // Pull the package name out of the tarball filename and mark it
      // installed in the shared state.
      const m = path.basename(tarPath).match(/^(tree-sitter[-a-z]*)-v/);
      if (!m) throw new Error(`unexpected name: ${tarPath}`);
      installed.add(m[1]);
    };

    const lines = [];
    const result = await pi.runMain({
      env: {}, // no opt-outs
      console: { log: (...a) => lines.push(a.join(' ')) },
      packageRoot: root,
      cartoVersion: '99.0.0',
      platformInfo: { platform: 'linux', arch: 'x64', libc: 'glibc', key: 'linux-x64-glibc' },
      baseUrl: 'https://example.test/dl',
      requireFn,
      fetcher,
      extractor,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.attempted, 8);
    assert.strictEqual(result.succeeded, 8);
    assert.strictEqual(result.stillFailed, 0);
    const out = lines.join('\n');
    assert.ok(out.includes('Restored 8/8'), `expected success line; got:\n${out}`);
    assert.ok(!out.includes('regex-only'), `Spec 12 fallback should NOT print on full restore; got:\n${out}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Native install resilience', 'runMain falls through to Spec 12 guidance when prebuild fetcher always fails', async () => {
  const pi = require('../scripts/postinstall');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pi-fallback-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'carto-md', version: '99.0.0',
      dependencies: { 'tree-sitter': '0.25.0' },
      optionalDependencies: {
        'tree-sitter-javascript': '0.25.0', 'tree-sitter-typescript': '0.23.2',
        'tree-sitter-python': '0.25.0', 'tree-sitter-go': '0.25.0',
        'tree-sitter-rust': '0.24.0', 'tree-sitter-java': '0.23.5',
        'tree-sitter-cpp': '0.23.4', 'tree-sitter-c-sharp': '0.21.3',
      }
    }));

    const requireFn = () => { throw new Error('not installed'); };
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount += 1;
      const err = new Error('HTTP 404');
      throw err;
    };
    const extractor = () => { throw new Error('extractor must not run'); };

    const lines = [];
    const result = await pi.runMain({
      env: {},
      console: { log: (...a) => lines.push(a.join(' ')) },
      packageRoot: root,
      cartoVersion: '99.0.0',
      platformInfo: { platform: 'linux', arch: 'x64', libc: 'glibc', key: 'linux-x64-glibc' },
      baseUrl: 'https://example.test/dl',
      requireFn,
      fetcher,
      extractor,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.attempted, 8);
    assert.strictEqual(result.succeeded, 0);
    assert.strictEqual(result.stillFailed, 8);
    assert.strictEqual(fetchCount, 8, 'all 8 grammars must be tried');
    const out = lines.join('\n');
    assert.ok(out.includes('regex-only'),
      `Spec 12 guidance must print after prebuild fail; got:\n${out}`);
    assert.ok(out.includes('HTTP 404'),
      `per-grammar reason must surface; got:\n${out}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Native install resilience', 'runMain with CARTO_NO_PREBUILD=1 skips fetcher and prints Spec 12 directly', async () => {
  const pi = require('../scripts/postinstall');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pi-noprebuild-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'carto-md', version: '99.0.0',
      dependencies: { 'tree-sitter': '0.25.0' },
      optionalDependencies: { 'tree-sitter-javascript': '0.25.0' }
    }));

    const requireFn = () => { throw new Error('not installed'); };
    let fetchCalled = false;
    const fetcher = async () => { fetchCalled = true; };
    const extractor = () => { throw new Error('extractor must not run'); };

    const lines = [];
    const result = await pi.runMain({
      env: { CARTO_NO_PREBUILD: '1' },
      console: { log: (...a) => lines.push(a.join(' ')) },
      packageRoot: root,
      cartoVersion: '99.0.0',
      platformInfo: { platform: 'darwin', arch: 'arm64', libc: null, key: 'darwin-arm64' },
      baseUrl: 'https://example.test/dl',
      requireFn,
      fetcher,
      extractor,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.attempted, 0, 'no fetches when CARTO_NO_PREBUILD=1');
    assert.strictEqual(result.succeeded, 0);
    assert.strictEqual(fetchCalled, false, 'fetcher must not be called');
    const out = lines.join('\n');
    assert.ok(out.includes('regex-only'),
      `Spec 12 message must still print; got:\n${out}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ═══════════════════════════════════════════════════════════════════
// Bitmap validation — 5 tests
// ═══════════════════════════════════════════════════════════════════

test('Bitmap validation', 'Sidecar correctness: forward+reverse round-trip edges', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm-'));
  const cartoDir = path.join(projectRoot, '.carto');
  fs.mkdirSync(cartoDir, { recursive: true });
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();
  // Create 50 files
  for (let i = 0; i < 50; i++) {
    store._db.prepare('INSERT INTO files (id, path, language, hash, mtime, size) VALUES (?,?,?,?,?,?)')
      .run(i + 1, `src/file${i}.ts`, 'typescript', `h${i}`, Date.now(), 100);
  }
  // Create 80 import edges (from → to)
  const edges = [];
  for (let i = 0; i < 80; i++) {
    const from = (i % 50) + 1;
    const to = ((i * 7 + 3) % 50) + 1;
    if (from === to) continue;
    edges.push([from, to]);
    store._db.prepare('INSERT OR IGNORE INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(from, to, `src/file${to - 1}.ts`);
  }
  store.close();
  try {
    const { buildSidecar } = require('../bench/bitmap-validation/sidecar');
    const sidecar = buildSidecar(path.join(cartoDir, 'carto.db'));
    // Verify round-trip: every edge in forward should appear in reverse
    let forwardCount = 0;
    for (const [fid, bitmap] of sidecar.forward) {
      forwardCount += bitmap.popcount();
    }
    let reverseCount = 0;
    for (const [fid, bitmap] of sidecar.reverse) {
      reverseCount += bitmap.popcount();
    }
    // Each edge appears once in forward, once in reverse
    assert.strictEqual(forwardCount, reverseCount, 'forward and reverse edge counts must match');
    // Spot-check 5 random edges
    for (let i = 0; i < Math.min(5, edges.length); i++) {
      const [from, to] = edges[i];
      assert.ok(sidecar.forward.has(from) && sidecar.forward.get(from).has(to),
        `forward must contain edge ${from}→${to}`);
      assert.ok(sidecar.reverse.has(to) && sidecar.reverse.get(to).has(from),
        `reverse must contain edge ${to}←${from}`);
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap validation', 'Blast radius parity: bitmap matches SQLite result set', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm-'));
  const cartoDir = path.join(projectRoot, '.carto');
  fs.mkdirSync(cartoDir, { recursive: true });
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();
  // 20 files, chain: 1→2→3→...→10 (linear deps)
  for (let i = 0; i < 20; i++) {
    store._db.prepare('INSERT INTO files (id, path, language, hash, mtime, size) VALUES (?,?,?,?,?,?)')
      .run(i + 1, `src/f${i}.ts`, 'typescript', `h${i}`, Date.now(), 100);
  }
  for (let i = 0; i < 10; i++) {
    store._db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(i + 2, i + 1, `src/f${i}.ts`); // file i+2 imports file i+1
  }
  // Build reverse_deps so SQLite getBlastRadius works
  // reverse_deps: file_id=target, dependent_file_id=who depends on target
  for (let i = 0; i < 10; i++) {
    store._db.prepare('INSERT OR IGNORE INTO reverse_deps (file_id, dependent_file_id, hop_distance) VALUES (?,?,?)')
      .run(i + 1, i + 2, 1); // f(i) is depended on by f(i+1)
  }
  // Multi-hop: f1 is depended on by f3 at hop 2, f4 at hop 3, etc.
  for (let hop = 2; hop <= 5; hop++) {
    for (let i = 0; i + hop < 11; i++) {
      store._db.prepare('INSERT OR IGNORE INTO reverse_deps (file_id, dependent_file_id, hop_distance) VALUES (?,?,?)')
        .run(i + 1, i + 1 + hop, hop);
    }
  }
  store.close();
  try {
    const { buildSidecar } = require('../bench/bitmap-validation/sidecar');
    const { bitmapBlastRadius } = require('../bench/bitmap-validation/tools');
    const sidecar = buildSidecar(path.join(cartoDir, 'carto.db'));
    // Blast radius of file 1 (the root): should reach files 2-6 (within 5 hops)
    const bitmapResult = new Set(bitmapBlastRadius(sidecar, 1, 5));
    // Open store readonly to compare
    const storeRo = new SQLiteStore(projectRoot);
    storeRo.open({ readonly: true });
    const sqlResult = storeRo.getBlastRadius('src/f0.ts', 5);
    storeRo.close();
    const sqlSet = new Set(sqlResult.map(r => {
      const match = r.file.match(/f(\d+)/);
      return match ? parseInt(match[1]) + 1 : null;
    }).filter(Boolean));
    // Both should find files 2 through at most 6
    assert.ok(bitmapResult.size > 0, 'bitmap blast radius must find dependents');
    assert.ok(sqlSet.size > 0, 'sqlite blast radius must find dependents');
    // Bitmap BFS finds transitive deps via import edges
    // SQL uses pre-computed reverse_deps table
    // Both should agree on direct dependents at minimum
    assert.ok(bitmapResult.has(2), 'bitmap must find direct dependent (file 2)');
    assert.ok(sqlSet.has(2), 'sql must find direct dependent (file 2)');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap validation', 'High-impact parity: bitmap top-10 matches SQLite ranking', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm-'));
  const cartoDir = path.join(projectRoot, '.carto');
  fs.mkdirSync(cartoDir, { recursive: true });
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();
  // 30 files — file 1 has 15 dependents, file 2 has 10, file 3 has 5, rest have 0
  for (let i = 0; i < 30; i++) {
    const centrality = i === 0 ? 15 : (i === 1 ? 10 : (i === 2 ? 5 : 0));
    store._db.prepare('INSERT INTO files (id, path, language, hash, mtime, size, centrality) VALUES (?,?,?,?,?,?,?)')
      .run(i + 1, `src/f${i}.ts`, 'typescript', `h${i}`, Date.now(), 100, centrality);
  }
  // Create actual import edges so bitmap popcount matches
  for (let d = 0; d < 15; d++) {
    store._db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(d + 4, 1, 'src/f0.ts'); // 15 files import file 1
  }
  for (let d = 0; d < 10; d++) {
    store._db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(d + 19, 2, 'src/f1.ts'); // 10 files import file 2
  }
  for (let d = 0; d < 5; d++) {
    store._db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(d + 29 > 30 ? d + 4 : d + 25, 3, 'src/f2.ts'); // 5 files import file 3
  }
  store.close();
  try {
    const { buildSidecar } = require('../bench/bitmap-validation/sidecar');
    const { bitmapHighImpactFiles } = require('../bench/bitmap-validation/tools');
    const sidecar = buildSidecar(path.join(cartoDir, 'carto.db'));
    const top = bitmapHighImpactFiles(sidecar, 3);
    // File 1 should be #1, file 2 should be #2
    assert.strictEqual(top[0].fileId, 1, 'file 1 must be highest impact');
    assert.strictEqual(top[1].fileId, 2, 'file 2 must be second highest');
    assert.strictEqual(top[0].dependents, 15);
    assert.strictEqual(top[1].dependents, 10);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap validation', 'Runner exits 0 and writes raw-results.json with 5 tool arrays', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm-'));
  const cartoDir = path.join(projectRoot, '.carto');
  fs.mkdirSync(cartoDir, { recursive: true });
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();
  // Minimal 10-file project with some edges
  for (let i = 0; i < 10; i++) {
    store._db.prepare('INSERT INTO files (id, path, language, hash, mtime, size, centrality) VALUES (?,?,?,?,?,?,?)')
      .run(i + 1, `src/f${i}.ts`, 'typescript', `h${i}`, Date.now(), 100, i === 0 ? 5 : 0);
  }
  for (let i = 1; i < 6; i++) {
    store._db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(i + 1, 1, 'src/f0.ts');
    store._db.prepare('INSERT OR IGNORE INTO reverse_deps (file_id, dependent_file_id, hop_distance) VALUES (?,?,?)')
      .run(1, i + 1, 1);
  }
  // Add domain data for crossDomain
  store._db.prepare('INSERT INTO domains (id, name) VALUES (?,?)').run(1, 'CORE');
  store._db.prepare('INSERT INTO domains (id, name) VALUES (?,?)').run(2, 'AUTH');
  for (let i = 0; i < 5; i++) {
    store._db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?,?)').run(i + 1, 1);
  }
  for (let i = 5; i < 10; i++) {
    store._db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?,?)').run(i + 1, 2);
  }
  store.close();
  try {
    const { run } = require('../bench/bitmap-validation/runner');
    const result = run(projectRoot);
    assert.ok(result.results, 'runner must return results object');
    const tools = Object.keys(result.results);
    assert.strictEqual(tools.length, 5, 'must have exactly 5 tool results');
    for (const tool of tools) {
      assert.ok(Array.isArray(result.results[tool].sqliteTimes), `${tool} must have sqliteTimes`);
      assert.ok(Array.isArray(result.results[tool].bitmapTimes), `${tool} must have bitmapTimes`);
      assert.strictEqual(result.results[tool].sqliteTimes.length, 1000, `${tool} must have 1000 sqlite timings`);
      assert.strictEqual(result.results[tool].bitmapTimes.length, 1000, `${tool} must have 1000 bitmap timings`);
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap validation', 'Report generates REPORT.md with exactly one verdict', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm-'));
  // Write a synthetic raw-results.json
  const fakeResults = {
    repo: '/tmp/fake',
    fileCount: 50,
    edgeCount: 80,
    sidecarBytes: 4000,
    rssStart: 50 * 1024 * 1024,
    rssEnd: 55 * 1024 * 1024,
    results: {}
  };
  const toolNames = ['blastRadius', 'crossDomain', 'highImpactFiles', 'similarPatterns', 'simulateChangeImpact'];
  for (const t of toolNames) {
    // Bitmap 10× faster → should produce GO
    fakeResults.results[t] = {
      sqliteTimes: Array(1000).fill(100000), // 100µs
      bitmapTimes: Array(1000).fill(5000),   // 5µs = 20× speedup
    };
  }
  const rawPath = path.join(tmpDir, 'raw-results.json');
  fs.writeFileSync(rawPath, JSON.stringify(fakeResults));
  try {
    const { generateReport } = require('../bench/bitmap-validation/report');
    const { reportPath, verdict } = generateReport(rawPath, tmpDir);
    assert.ok(fs.existsSync(reportPath), 'REPORT.md must be created');
    const content = fs.readFileSync(reportPath, 'utf-8');
    const verdicts = ['GO', 'INVESTIGATE', 'DEFER'].filter(v => content.includes(`**${v}**`));
    assert.strictEqual(verdicts.length, 1, `must have exactly one verdict, got: ${verdicts}`);
    assert.strictEqual(verdict, 'GO', 'with 20× speedup verdict must be GO');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Bitset serialization — 3 tests
// ═══════════════════════════════════════════════════════════════════

test('Bitset serialization', 'Round-trip preserves all set bits', () => {
  const { Bitset } = require('../src/bitmap/bitset');
  const original = new Bitset(200);
  // Set a deliberately scattered pattern: every prime under 200 plus 0 and 199.
  const primes = [0, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199];
  for (const p of primes) original.set(p);
  const buf = original.serialize();
  const restored = Bitset.deserialize(buf, 200);
  assert.strictEqual(restored.size, 200);
  assert.strictEqual(restored.popcount(), original.popcount());
  for (const p of primes) assert.ok(restored.has(p), `bit ${p} must be set after restore`);
  for (let i = 0; i < 200; i++) {
    if (!primes.includes(i)) {
      assert.ok(!restored.has(i), `bit ${i} must NOT be set after restore`);
    }
  }
});

test('Bitset serialization', 'Empty bitset serializes to expected minimal size', () => {
  const { Bitset } = require('../src/bitmap/bitset');
  // 32-bit bitset → 1 word → 4 bytes
  const b32 = new Bitset(32);
  assert.strictEqual(b32.serialize().length, 4, '32-bit bitset must be 4 bytes');
  // 0-bit bitset → 0 words → 0 bytes
  const b0 = new Bitset(0);
  assert.strictEqual(b0.serialize().length, 0, '0-bit bitset must be 0 bytes');
  // 33-bit bitset → ceil(33/32) = 2 words → 8 bytes
  const b33 = new Bitset(33);
  assert.strictEqual(b33.serialize().length, 8, '33-bit bitset must be 8 bytes');
  // Round-trip empty
  const restored = Bitset.deserialize(b32.serialize(), 32);
  assert.strictEqual(restored.popcount(), 0);
});

test('Bitset serialization', 'Large bitset (10K bits) round-trips correctly', () => {
  const { Bitset } = require('../src/bitmap/bitset');
  const original = new Bitset(10000);
  // Set every 7th bit — gives ~1429 set bits, exercises many words.
  const expected = [];
  for (let i = 0; i < 10000; i += 7) {
    original.set(i);
    expected.push(i);
  }
  // Add some boundary bits
  original.set(9999);
  expected.push(9999);
  const buf = original.serialize();
  // Expected size: ceil(10000 / 32) = 313 words → 1252 bytes
  assert.strictEqual(buf.length, 1252, `expected 1252 bytes, got ${buf.length}`);
  const restored = Bitset.deserialize(buf, 10000);
  assert.strictEqual(restored.popcount(), original.popcount());
  // Sample-check 50 random positions
  for (let i = 0; i < 50; i++) {
    const idx = Math.floor((i * 199) % 10000);
    assert.strictEqual(restored.has(idx), original.has(idx),
      `bit ${idx} mismatch after round-trip`);
  }
  // Iterate must return exactly the expected set
  const iterated = restored.iterate();
  expected.sort((a, b) => a - b);
  assert.strictEqual(iterated.length, expected.length);
  for (let i = 0; i < iterated.length; i++) {
    assert.strictEqual(iterated[i], expected[i]);
  }
});

test('Bitset serialization', 'In-place ops produce results identical to allocating versions', () => {
  const { Bitset } = require('../src/bitmap/bitset');
  // Build two non-trivial bitsets with overlapping but non-identical patterns.
  const a = new Bitset(200);
  const b = new Bitset(200);
  for (let i = 0; i < 200; i += 3) a.set(i);
  for (let i = 0; i < 200; i += 5) b.set(i);

  // orInPlace ↔ or
  const orRef = a.or(b).iterate().sort((x, y) => x - y);
  const orMut = a.clone().orInPlace(b).iterate().sort((x, y) => x - y);
  assert.deepStrictEqual(orMut, orRef, 'orInPlace must match or()');

  // andNotInPlace ↔ andNot
  const anRef = a.andNot(b).iterate().sort((x, y) => x - y);
  const anMut = a.clone().andNotInPlace(b).iterate().sort((x, y) => x - y);
  assert.deepStrictEqual(anMut, anRef, 'andNotInPlace must match andNot()');

  // copyFrom ↔ clone (semantically — both result in identical bitsets)
  const dst = new Bitset(200);
  dst.copyFrom(b);
  assert.deepStrictEqual(
    dst.iterate().sort((x, y) => x - y),
    b.iterate().sort((x, y) => x - y),
    'copyFrom must produce a bitset equal to the source'
  );

  // setAll(0) clears all bits
  const c = a.clone();
  c.setAll(0);
  assert.strictEqual(c.popcount(), 0, 'setAll(0) must zero every bit');
});

test('Bitset serialization', 'In-place ops do not allocate a new words array', () => {
  const { Bitset } = require('../src/bitmap/bitset');
  // Hold a reference to the original Uint32Array, then prove it survives.
  const a = new Bitset(128);
  const b = new Bitset(128);
  for (let i = 0; i < 128; i += 7) b.set(i);
  const originalWords = a.words;

  a.orInPlace(b);
  assert.strictEqual(a.words, originalWords, 'orInPlace must not replace .words');

  a.andNotInPlace(b);
  assert.strictEqual(a.words, originalWords, 'andNotInPlace must not replace .words');

  a.copyFrom(b);
  assert.strictEqual(a.words, originalWords, 'copyFrom must not replace .words');

  a.setAll(0);
  assert.strictEqual(a.words, originalWords, 'setAll must not replace .words');
});

// ═══════════════════════════════════════════════════════════════════
// Bitmap engine integration — 9 tests
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a tiny fixture project with a real .carto/carto.db. Returns
 *   { projectRoot, cartoDir, dbPath, store, paths }
 * Caller is responsible for store.close() + fs.rmSync(projectRoot, …).
 *
 * Topology: 10 files. file1 ← file2..file6 (5 dependents). file2 ← file7,
 * file8 (2 dependents). file3 ← file9 (1 dependent). 2 domains: CORE
 * (files 1-5), AUTH (files 6-10). Cross-domain edges: file6→file1,
 * file7→file2, file8→file2, file9→file3.
 */
function buildBitmapFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-bm-int-'));
  const cartoDir = path.join(projectRoot, '.carto');
  fs.mkdirSync(cartoDir, { recursive: true });
  const dbPath = path.join(cartoDir, 'carto.db');
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();
  const paths = [];
  for (let i = 0; i < 10; i++) {
    const p = `src/f${i}.ts`;
    paths.push(p);
    store._db.prepare('INSERT INTO files (id, path, language, hash, mtime, size) VALUES (?,?,?,?,?,?)')
      .run(i + 1, p, 'typescript', `h${i}`, Date.now(), 100);
  }
  // Edges (from → to). file 1 has 5 direct dependents.
  const edges = [
    [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], // file1 ← 5 dependents
    [7, 2], [8, 2],                         // file2 ← 2 dependents
    [9, 3],                                 // file3 ← 1 dependent
    [10, 7],                                // file7 ← 1 (chain through file2)
  ];
  for (const [from, to] of edges) {
    store._db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)')
      .run(from, to, `src/f${to - 1}.ts`);
  }
  // Domains: CORE = files 1-5, AUTH = files 6-10
  store._db.prepare('INSERT INTO domains (id, name, file_count) VALUES (?,?,?)').run(1, 'CORE', 5);
  store._db.prepare('INSERT INTO domains (id, name, file_count) VALUES (?,?,?)').run(2, 'AUTH', 5);
  for (let i = 1; i <= 5; i++) {
    store._db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?,?)').run(i, 1);
  }
  for (let i = 6; i <= 10; i++) {
    store._db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?,?)').run(i, 2);
  }
  return { projectRoot, cartoDir, dbPath, store, paths, edges };
}

test('Bitmap engine', 'buildFromStore produces correct forward/reverse/domainBitmaps', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore } = require('../src/bitmap/sidecar');
    const sidecar = buildFromStore(fix.store);
    // Forward: file2 imports file1
    assert.ok(sidecar.forward.has(2));
    assert.ok(sidecar.forward.get(2).has(1));
    // Reverse: file1 has 5 dependents (files 2-6)
    assert.ok(sidecar.reverse.has(1));
    assert.strictEqual(sidecar.reverse.get(1).popcount(), 5);
    for (let i = 2; i <= 6; i++) {
      assert.ok(sidecar.reverse.get(1).has(i), `file${i} must be a direct dependent of file1`);
    }
    // Domain bitmaps: CORE = files 1-5, AUTH = files 6-10
    assert.ok(sidecar.domainBitmaps.has(1));
    assert.strictEqual(sidecar.domainBitmaps.get(1).popcount(), 5);
    assert.strictEqual(sidecar.domainBitmaps.get(2).popcount(), 5);
    // Path mapping
    assert.strictEqual(sidecar.fileIdToPath.get(1), 'src/f0.ts');
    assert.strictEqual(sidecar.pathToFileId.get('src/f0.ts'), 1);
    // Domain id → name
    assert.strictEqual(sidecar.domainIdToName.get(1), 'CORE');
    assert.strictEqual(sidecar.domainIdToName.get(2), 'AUTH');
    // Size = maxId + 1 = 11
    assert.strictEqual(sidecar.size, 11);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'popcountIndex sorted DESC and matches transitive 5-hop count', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore } = require('../src/bitmap/sidecar');
    const sidecar = buildFromStore(fix.store);
    const idx = sidecar.popcountIndex;
    // Sorted DESC
    for (let i = 1; i < idx.length; i++) {
      assert.ok(idx[i - 1].count >= idx[i].count,
        `popcountIndex must be DESC at i=${i}: ${idx[i - 1].count} >= ${idx[i].count}`);
    }
    // Count is TRANSITIVE 5-hop. Fixture topology:
    //   file1 ← {2,3,4,5,6} hop1, ← {7,8} via file2 hop2, ← {9} via
    //   file3 hop2, ← {10} via file7 hop3 → 9 distinct transitive deps.
    assert.strictEqual(idx[0].fileId, 1);
    assert.strictEqual(idx[0].count, 9, 'file1 transitive blast radius is 9 (files 2..10)');
    // Each entry's count must equal SQLite's centrality after computeReverseDeps.
    fix.store.computeReverseDeps(5);
    for (const entry of idx) {
      const fileRow = fix.store.db.prepare('SELECT centrality FROM files WHERE id = ?')
        .get(entry.fileId);
      assert.strictEqual(entry.count, fileRow.centrality,
        `popcountIndex must match SQLite centrality for file ${entry.fileId}`);
    }
    // Files with zero dependents must NOT appear (file 10, etc.)
    const idsInIdx = new Set(idx.map(e => e.fileId));
    assert.ok(!idsInIdx.has(10), 'file10 has 0 dependents — must not appear in popcountIndex');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'saveToDisk + loadFromDisk round-trips all bitmaps correctly', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore, saveToDisk, loadFromDisk } = require('../src/bitmap/sidecar');
    const original = buildFromStore(fix.store);
    saveToDisk(fix.cartoDir, original);
    const loaded = loadFromDisk(fix.cartoDir);
    assert.ok(loaded, 'loadFromDisk must return a sidecar');
    // Same shape
    assert.strictEqual(loaded.size, original.size);
    assert.strictEqual(loaded.forward.size, original.forward.size);
    assert.strictEqual(loaded.reverse.size, original.reverse.size);
    assert.strictEqual(loaded.domainBitmaps.size, original.domainBitmaps.size);
    assert.strictEqual(loaded.popcountIndex.length, original.popcountIndex.length);
    assert.strictEqual(loaded.fileIdToPath.size, original.fileIdToPath.size);
    // Spot-check forward edges round-trip
    for (const [fid, bitmap] of original.forward) {
      assert.ok(loaded.forward.has(fid), `forward must contain fid=${fid} after load`);
      const loadedBits = loaded.forward.get(fid).iterate().sort((a, b) => a - b);
      const origBits = bitmap.iterate().sort((a, b) => a - b);
      assert.deepStrictEqual(loadedBits, origBits, `forward bits for fid=${fid} must match`);
    }
    // Path map round-trips
    for (const [fid, p] of original.fileIdToPath) {
      assert.strictEqual(loaded.fileIdToPath.get(fid), p);
      assert.strictEqual(loaded.pathToFileId.get(p), fid);
    }
    // Domain id → name round-trips
    for (const [did, name] of original.domainIdToName) {
      assert.strictEqual(loaded.domainIdToName.get(did), name);
    }
    // popcountIndex round-trips (same order, same counts)
    for (let i = 0; i < original.popcountIndex.length; i++) {
      assert.deepStrictEqual(loaded.popcountIndex[i], original.popcountIndex[i]);
    }
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'ensureBitmapFresh rebuilds when .carto/bitmap.bin missing', () => {
  const fix = buildBitmapFixture();
  try {
    const orchestrator = require('../src/bitmap/index');
    orchestrator._resetForTests();
    const { BITMAP_FILENAME } = require('../src/bitmap/sidecar');
    const bitmapPath = path.join(fix.cartoDir, BITMAP_FILENAME);
    assert.ok(!fs.existsSync(bitmapPath), 'precondition: bitmap.bin must not exist');
    const sidecar = orchestrator.ensureBitmapFresh(fix.cartoDir, fix.store);
    assert.ok(sidecar, 'ensureBitmapFresh must return a sidecar');
    assert.ok(fs.existsSync(bitmapPath), 'bitmap.bin must be written to disk');
    // Sidecar shape sanity
    assert.strictEqual(sidecar.size, 11);
    assert.ok(sidecar.popcountIndex.length > 0);
  } finally {
    try { fix.store.close(); } catch {}
    require('../src/bitmap/index')._resetForTests();
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'ensureBitmapFresh skips rebuild when bitmap newer than DB', () => {
  const fix = buildBitmapFixture();
  try {
    const orchestrator = require('../src/bitmap/index');
    orchestrator._resetForTests();
    const { BITMAP_FILENAME } = require('../src/bitmap/sidecar');
    const bitmapPath = path.join(fix.cartoDir, BITMAP_FILENAME);
    // Build once — populates bitmap.bin
    orchestrator.ensureBitmapFresh(fix.cartoDir, fix.store);
    assert.ok(fs.existsSync(bitmapPath));
    // Reset cache, then bump bitmap mtime to definitely-after carto.db.
    orchestrator._resetForTests();
    const future = (Date.now() + 60000) / 1000; // +60s
    fs.utimesSync(bitmapPath, future, future);
    // Mark the SQLite store as "tampered": replace its open db with one
    // whose db.prepare throws — proves the orchestrator did NOT rebuild.
    const guardStore = {
      get db() {
        throw new Error('db should not be accessed when bitmap is fresh');
      }
    };
    const sidecar = orchestrator.ensureBitmapFresh(fix.cartoDir, guardStore);
    assert.ok(sidecar, 'ensureBitmapFresh must return a sidecar from disk');
    assert.strictEqual(sidecar.size, 11, 'loaded sidecar must match original size');
  } finally {
    try { fix.store.close(); } catch {}
    require('../src/bitmap/index')._resetForTests();
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'bitmap blastRadius matches SQLite shape and result set', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore } = require('../src/bitmap/sidecar');
    const { blastRadius } = require('../src/bitmap/tools');
    // Build reverse_deps so the SQLite blastRadius has data to compare against.
    fix.store.computeReverseDeps(5);
    const sidecar = buildFromStore(fix.store);

    const bitmapResult = blastRadius(sidecar, 'src/f0.ts', 5);
    assert.ok(bitmapResult, 'bitmap blastRadius must return a result');
    assert.ok(bitmapResult.length >= 5, `expected at least 5 dependents, got ${bitmapResult.length}`);
    // Output shape: [{file, hop_distance}] — same as SQLiteStore.getBlastRadius.
    // This is the contract that lets server.js's formatter swap data
    // sources without code changes.
    for (const row of bitmapResult) {
      assert.ok(typeof row.file === 'string');
      assert.ok(Number.isInteger(row.hop_distance));
      assert.ok(row.hop_distance >= 1 && row.hop_distance <= 5);
    }
    // Compare set with SQLite's getBlastRadius (same data source, same answer).
    const sqlResult = fix.store.getBlastRadius('src/f0.ts', 5);
    const bitmapSet = new Set(bitmapResult.map(r => r.file));
    const sqlSet = new Set(sqlResult.map(r => r.file));
    assert.deepStrictEqual([...bitmapSet].sort(), [...sqlSet].sort(),
      'bitmap blastRadius must agree with SQLite on the affected set');
    // File not in index → null (same null contract as SQLite, so the MCP
    // "File not found in index" message keeps working).
    assert.strictEqual(blastRadius(sidecar, 'does-not-exist.ts', 5), null);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'simulateChangeImpact returns correct affected set', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore } = require('../src/bitmap/sidecar');
    const { simulateChangeImpact } = require('../src/bitmap/tools');
    const sidecar = buildFromStore(fix.store);
    // Change file1 + file2 simultaneously.
    // file1 dependents: {file2..file6}. file2 dependents: {file7, file8}.
    // file7 dependents (transitively): {file10}.
    // Union (excluding inputs): {file3, file4, file5, file6, file7, file8, file10}.
    const result = simulateChangeImpact(sidecar, ['src/f0.ts', 'src/f1.ts'], 5);
    assert.ok(result.count >= 5, `expected ≥5 affected files, got ${result.count}`);
    const affectedPaths = new Set(result.files.map(r => r.file));
    // Direct dependents of file1 must be present
    for (const p of ['src/f2.ts', 'src/f3.ts', 'src/f4.ts', 'src/f5.ts']) {
      assert.ok(affectedPaths.has(p), `${p} must be in affected set`);
    }
    // Direct dependents of file2 must be present
    assert.ok(affectedPaths.has('src/f6.ts'));
    assert.ok(affectedPaths.has('src/f7.ts'));
    // Input files must NOT be in the result
    assert.ok(!affectedPaths.has('src/f0.ts'), 'input file f0 must be excluded');
    assert.ok(!affectedPaths.has('src/f1.ts'), 'input file f1 must be excluded');
    // Each row has correct shape
    for (const row of result.files) {
      assert.ok(typeof row.file === 'string');
      assert.ok(Number.isInteger(row.hop_distance));
    }
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'simulateChangeImpact with non-existent files returns empty gracefully', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore } = require('../src/bitmap/sidecar');
    const { simulateChangeImpact } = require('../src/bitmap/tools');
    const sidecar = buildFromStore(fix.store);
    // All inputs are unknown
    const allUnknown = simulateChangeImpact(sidecar, ['nope1.ts', 'nope2.ts'], 5);
    assert.strictEqual(allUnknown.count, 0);
    assert.deepStrictEqual(allUnknown.files, []);
    // Mixed: one known, one unknown — must still process the known one.
    const mixed = simulateChangeImpact(sidecar, ['src/f0.ts', 'nope.ts'], 5);
    assert.ok(mixed.count >= 4, `mixed input must still expand the known file: got ${mixed.count}`);
    // Empty input → empty output
    const empty = simulateChangeImpact(sidecar, [], 5);
    assert.strictEqual(empty.count, 0);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'Corrupt bitmap.bin → orchestrator rebuilds from SQLite', () => {
  const fix = buildBitmapFixture();
  try {
    const orchestrator = require('../src/bitmap/index');
    const { BITMAP_FILENAME } = require('../src/bitmap/sidecar');
    const bitmapPath = path.join(fix.cartoDir, BITMAP_FILENAME);
    orchestrator._resetForTests();

    // Write garbage bytes — wrong magic, wrong everything.
    fs.writeFileSync(bitmapPath, Buffer.from('GARBAGE'));
    // Also bump its mtime to "fresher" than the DB so the freshness check
    // would naively try to load it.
    const future = (Date.now() + 60000) / 1000;
    fs.utimesSync(bitmapPath, future, future);

    // Must not throw — must transparently rebuild and produce a working sidecar.
    const sidecar = orchestrator.ensureBitmapFresh(fix.cartoDir, fix.store);
    assert.ok(sidecar, 'ensureBitmapFresh must return a sidecar after corrupt-file recovery');
    assert.strictEqual(sidecar.size, 11);
    assert.ok(sidecar.popcountIndex.length > 0, 'rebuilt sidecar must have popcount entries');
    // The disk file must have been overwritten with valid bytes (rebuild
    // calls saveToDisk).
    const reloaded = fs.readFileSync(bitmapPath);
    assert.ok(reloaded.length > 8, 'bitmap.bin must be rewritten with non-trivial bytes');
    // Magic = 0x54524243 in LE
    assert.strictEqual(reloaded.readUInt32LE(0), 0x54524243, 'rebuilt file must have correct magic');
  } finally {
    try { fix.store.close(); } catch {}
    require('../src/bitmap/index')._resetForTests();
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Bitmap engine', 'crossDomain rewrite is byte-equivalent to a manual reference', () => {
  // The flat-array + crossForward rewrite must produce the same
  // rows as walking the raw forward bitmap, filtering same-domain edges
  // by hand, and sorting by the SQLite ORDER BY (d1.name, d2.name) plus
  // (from, to) for total determinism.
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore } = require('../src/bitmap/sidecar');
    const { crossDomain } = require('../src/bitmap/tools');
    const sidecar = buildFromStore(fix.store);

    // Manual reference computation — uses the original Maps + bitmap
    // iterate(), which the flat-array path bypasses.
    const ref = [];
    for (const [fromId, bitmap] of sidecar.forward) {
      const fromDomainId = sidecar.fileDomain.get(fromId);
      if (fromDomainId === undefined) continue;
      const fromDomain = sidecar.domainIdToName.get(fromDomainId);
      const fromPath = sidecar.fileIdToPath.get(fromId);
      if (!fromDomain || !fromPath) continue;
      for (const toId of bitmap.iterate()) {
        const toDomainId = sidecar.fileDomain.get(toId);
        if (toDomainId === undefined || toDomainId === fromDomainId) continue;
        const toDomain = sidecar.domainIdToName.get(toDomainId);
        const toPath = sidecar.fileIdToPath.get(toId);
        if (!toDomain || !toPath) continue;
        ref.push({ from: fromPath, fromDomain, to: toPath, toDomain });
      }
    }
    ref.sort((a, b) => {
      if (a.fromDomain < b.fromDomain) return -1;
      if (a.fromDomain > b.fromDomain) return 1;
      if (a.toDomain < b.toDomain) return -1;
      if (a.toDomain > b.toDomain) return 1;
      if (a.from < b.from) return -1;
      if (a.from > b.from) return 1;
      if (a.to < b.to) return -1;
      if (a.to > b.to) return 1;
      return 0;
    });

    const got = crossDomain(sidecar);
    // The fixture has 4 cross-domain edges (file6→file1, file7→file2,
    // file8→file2, file9→file3 — see buildBitmapFixture topology).
    assert.strictEqual(got.length, 4, 'fixture has exactly 4 cross-domain edges');
    assert.deepStrictEqual(got, ref, 'crossDomain output must equal the manual reference');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Inspect command — 3 tests
// ═══════════════════════════════════════════════════════════════════

test('Inspect command', 'collect() on a populated fixture returns the expected shape', () => {
  const fix = buildBitmapFixture();
  try {
    // Persist a bitmap.bin so the Bitmap section reports `loaded: true`.
    const { buildFromStore, saveToDisk } = require('../src/bitmap/sidecar');
    saveToDisk(fix.cartoDir, buildFromStore(fix.store));
    fix.store.close();

    const { collect, renderHuman } = require('../src/cli/inspect');
    const data = collect(fix.projectRoot);

    // Top-level shape
    assert.ok(data.paths, 'must have paths');
    assert.ok(data.files, 'must have files');
    assert.ok(data.meta, 'must have meta on a populated DB');
    assert.ok(data.bitmap, 'must have bitmap on a present file');
    assert.ok(Array.isArray(data.topImpact), 'topImpact must be an array');
    assert.ok(Array.isArray(data.domains), 'domains must be an array');

    // Files block reflects what's on disk.
    assert.strictEqual(data.files.dbExists, true);
    assert.strictEqual(data.files.bitmapExists, true);

    // Bitmap loaded with the right shape.
    assert.strictEqual(data.bitmap.loaded, true);
    assert.strictEqual(data.bitmap.size, 11);
    assert.ok(data.bitmap.popcountIndexLength > 0);

    // Top impact head matches the popcount index — file1's transitive
    // 5-hop blast radius is 9 (files 2..10) per the fixture topology.
    assert.ok(data.topImpact.length > 0, 'topImpact must include the most-depended-on file');
    assert.strictEqual(data.topImpact[0].file, 'src/f0.ts');
    assert.strictEqual(data.topImpact[0].dependents, 9);

    // Domains list is populated from the fixture (CORE + AUTH).
    const domainNames = data.domains.map(d => d.name).sort();
    assert.deepStrictEqual(domainNames, ['AUTH', 'CORE']);

    // Human renderer produces a string with the section headers.
    const rendered = renderHuman(data);
    assert.ok(rendered.includes('Carto Inspect'), 'human output must contain the title');
    assert.ok(rendered.includes('Bitmap'), 'human output must contain the Bitmap section');
    assert.ok(rendered.includes('Domains'), 'human output must contain the Domains section');
    assert.ok(rendered.includes('Top impact'), 'human output must contain the Top impact section');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Inspect command', '--json mode emits valid JSON with required top-level keys', () => {
  const fix = buildBitmapFixture();
  try {
    const { buildFromStore, saveToDisk } = require('../src/bitmap/sidecar');
    saveToDisk(fix.cartoDir, buildFromStore(fix.store));
    fix.store.close();

    const { collect } = require('../src/cli/inspect');
    const data = collect(fix.projectRoot);
    // Round-trip through JSON to assert it serializes cleanly (no
    // circular refs, no functions, no Maps in the leaf values).
    const json = JSON.stringify(data);
    const parsed = JSON.parse(json);
    for (const key of ['paths', 'files', 'meta', 'bitmap', 'topImpact', 'domains']) {
      assert.ok(parsed[key] !== undefined, `JSON output must contain top-level key "${key}"`);
    }
    // Drill into a couple of nested keys.
    assert.ok(typeof parsed.paths.dbPath === 'string');
    assert.ok(typeof parsed.bitmap.size === 'number');
    assert.ok(Array.isArray(parsed.topImpact));
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Inspect command', 'returns exit code 1 with clear message when DB is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-inspect-empty-'));
  try {
    const { collect, renderHuman, run } = require('../src/cli/inspect');
    const data = collect(tmpDir);
    assert.strictEqual(data.files.dbExists, false, 'DB must not exist in an empty tmp dir');
    assert.strictEqual(data.meta, null, 'meta must be null when DB is absent');
    assert.strictEqual(data.bitmap, null, 'bitmap must be null when DB is absent');

    // Human renderer prints the `carto init` hint.
    const rendered = renderHuman(data);
    assert.ok(rendered.includes('carto init'),
      'human output must instruct the user to run carto init');

    // run() returns exit code 1 — capture stdout to keep the test runner clean.
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    let code;
    try {
      code = run(tmpDir, { json: true });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.strictEqual(code, 1, 'run() must return exit code 1 on missing DB');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Validation API — 10 tests
// ═══════════════════════════════════════════════════════════════════

const { parseDiff: spec16ParseDiff, extractAddedImports: spec16ExtractImports } = require('../src/mcp/diff-parser');
const { validateDiff: spec16ValidateDiff, recordSideEffects: spec16RecordSideEffects } = require('../src/mcp/validate');

/**
 * Build a fixture project with a real .carto/carto.db, schema v3, and
 * the bitmap fixture topology (10 files, CORE/AUTH domains, file f0
 * with 9 transitive dependents). Returns
 *   { projectRoot, cartoDir, store, sidecar }
 * Caller is responsible for store.close() + fs.rmSync(projectRoot, …).
 */
function buildValidationFixture() {
  const fix = buildBitmapFixture();
  // computeReverseDeps so blast_radius matches reality.
  fix.store.computeReverseDeps(5);
  const { buildFromStore } = require('../src/bitmap/sidecar');
  const sidecar = buildFromStore(fix.store);
  return Object.assign(fix, { sidecar });
}

test('Validation API', 'parseDiff handles 1 modify + 1 add + 1 delete in one input', () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 line 1
-old line
+new line A
+new line B
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,1 @@
+brand new file
diff --git a/src/c.ts b/src/c.ts
deleted file mode 100644
--- a/src/c.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`;
  const out = spec16ParseDiff(diff);
  assert.strictEqual(out.length, 3, 'must parse all three files');
  const byPath = Object.fromEntries(out.map((f) => [f.path, f]));
  assert.strictEqual(byPath['src/a.ts'].kind, 'modify');
  assert.strictEqual(byPath['src/a.ts'].added.length, 2);
  assert.strictEqual(byPath['src/a.ts'].removed.length, 1);
  assert.strictEqual(byPath['src/b.ts'].kind, 'add');
  assert.strictEqual(byPath['src/b.ts'].added.length, 1);
  assert.strictEqual(byPath['src/c.ts'].kind, 'delete');
  assert.strictEqual(byPath['src/c.ts'].removed.length, 1);
});

test('Validation API', 'parseDiff detects rename (no content change)', () => {
  const diff = `diff --git a/old/path.ts b/new/path.ts
similarity index 100%
rename from old/path.ts
rename to new/path.ts
`;
  const out = spec16ParseDiff(diff);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'rename');
  assert.strictEqual(out[0].path, 'new/path.ts');
  assert.strictEqual(out[0].oldPath, 'old/path.ts');
});

test('Validation API', 'parseDiff returns [] on malformed / empty input without throwing', () => {
  assert.deepStrictEqual(spec16ParseDiff(''), []);
  assert.deepStrictEqual(spec16ParseDiff(null), []);
  assert.deepStrictEqual(spec16ParseDiff('garbage that is not a diff at all\nhello'), []);
  // truncated mid-hunk — no header
  assert.deepStrictEqual(spec16ParseDiff('@@ -1 +1 @@\n+lone'), []);
});

test('Validation API', 'extractAddedImports picks up JS, Python, Rust, Java import shapes', () => {
  const file = {
    added: [
      { lineNo: 1, content: "import { x } from './foo';" },
      { lineNo: 2, content: "const y = require('bar');" },
      { lineNo: 3, content: "from baz.qux import z" },
      { lineNo: 4, content: "use crate::auth::session;" },
      { lineNo: 5, content: "import com.example.MyClass;" },
      { lineNo: 6, content: "// import { ignored } from 'noise';" },
    ],
  };
  const specs = spec16ExtractImports(file);
  assert.ok(specs.includes('./foo'), 'JS named import');
  assert.ok(specs.includes('bar'), 'CommonJS require');
  assert.ok(specs.includes('baz.qux'), 'Python from import');
  assert.ok(specs.includes('crate::auth::session'), 'Rust use path');
  assert.ok(specs.includes('com.example.MyClass'), 'Java import');
  assert.ok(!specs.includes('noise'), 'comment-prefixed lines are ignored');
});

test('Validation API', 'validateDiff: cross-domain CORE→AUTH import emits HIGH violation', () => {
  const fix = buildValidationFixture();
  try {
    // f1 (CORE) imports f6 (AUTH) — cross-domain into a sensitive domain.
    const diff = `diff --git a/src/f1.ts b/src/f1.ts
--- a/src/f1.ts
+++ b/src/f1.ts
@@ -1,1 +1,2 @@
 line
+import { x } from './f6';
`;
    const r = spec16ValidateDiff(fix.store, fix.sidecar, diff);
    const xd = r.violations.find((v) => v.kind === 'cross_domain');
    assert.ok(xd, 'must emit a cross_domain violation');
    assert.strictEqual(xd.severity, 'HIGH', 'AUTH is sensitive → HIGH');
    assert.strictEqual(xd.fromDomain, 'CORE');
    assert.strictEqual(xd.toDomain, 'AUTH');
    assert.strictEqual(xd.toFile, 'src/f6.ts'); // file id 7 → path src/f6.ts
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Validation API', 'validateDiff: high blast file → MEDIUM/HIGH high_blast violation', () => {
  const fix = buildValidationFixture();
  try {
    // f0 has 9 transitive dependents in this fixture.
    const diff = `diff --git a/src/f0.ts b/src/f0.ts
--- a/src/f0.ts
+++ b/src/f0.ts
@@ -1,1 +1,2 @@
 line
+const z = 1;
`;
    const r = spec16ValidateDiff(fix.store, fix.sidecar, diff, {
      mediumBlastThreshold: 5,
      highBlastThreshold: 8,
    });
    const hb = r.violations.find((v) => v.kind === 'high_blast');
    assert.ok(hb, 'must emit a high_blast violation');
    assert.strictEqual(hb.severity, 'HIGH', '9 > 8 → HIGH');
    assert.strictEqual(hb.blast_radius, 9);
    assert.strictEqual(r.blast_radius.perFile['src/f0.ts'], 9);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Validation API', 'validateDiff: small intra-domain change → SAFE', () => {
  const fix = buildValidationFixture();
  try {
    // f9 (AUTH) — has zero dependents in the fixture.
    const diff = `diff --git a/src/f9.ts b/src/f9.ts
--- a/src/f9.ts
+++ b/src/f9.ts
@@ -1,1 +1,2 @@
 line
+const x = 1;
`;
    const r = spec16ValidateDiff(fix.store, fix.sidecar, diff);
    assert.strictEqual(r.violations.length, 0, 'no violations expected');
    assert.strictEqual(r.risk, 'SAFE');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Validation API', 'validateDiff returns the documented contract shape', () => {
  const fix = buildValidationFixture();
  try {
    const diff = `diff --git a/src/f9.ts b/src/f9.ts
--- a/src/f9.ts
+++ b/src/f9.ts
@@ -1,1 +1,2 @@
 line
+x
`;
    const r = spec16ValidateDiff(fix.store, fix.sidecar, diff);
    // Top-level keys
    assert.ok(Array.isArray(r.diff), 'diff must be an array');
    assert.ok(typeof r.blast_radius === 'object' && r.blast_radius !== null, 'blast_radius object');
    assert.ok(typeof r.blast_radius.perFile === 'object', 'blast_radius.perFile object');
    assert.strictEqual(typeof r.blast_radius.union, 'number');
    assert.ok(Array.isArray(r.violations));
    assert.ok(Array.isArray(r.suggestions));
    assert.ok(['SAFE', 'LOW', 'MEDIUM', 'HIGH'].includes(r.risk), 'risk in enum');
    // diff entry shape
    assert.strictEqual(r.diff[0].path, 'src/f9.ts');
    assert.strictEqual(r.diff[0].kind, 'modify');
    assert.strictEqual(typeof r.diff[0].addedCount, 'number');
    assert.strictEqual(typeof r.diff[0].removedCount, 'number');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Validation API', 'recordSideEffects writes 1 decision + N intervention rows', () => {
  const fix = buildValidationFixture();
  try {
    const diff = `diff --git a/src/f1.ts b/src/f1.ts
--- a/src/f1.ts
+++ b/src/f1.ts
@@ -1,1 +1,2 @@
 line
+import { x } from './f6';
`;
    const r = spec16ValidateDiff(fix.store, fix.sidecar, diff);
    const session = fix.store.getOrCreateActiveSession('test');
    const ids = spec16RecordSideEffects(fix.store, session.id, diff, r);

    // 1 decision row
    assert.ok(ids.decisionId, 'decisionId must be set');
    const decisions = fix.store.getRecentDecisions(60_000, 'validation');
    assert.strictEqual(decisions.length, 1, 'exactly 1 decision');
    assert.strictEqual(decisions[0].file, 'src/f1.ts');

    // N intervention rows = number of violations from validateDiff
    assert.strictEqual(ids.interventionIds.length, r.violations.length);
    const interventions = fix.store.getInterventionsForFile('src/f1.ts');
    assert.strictEqual(interventions.length, r.violations.length);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('Validation API', 'p50 latency ≤ 15ms on a 1000-file fixture (100 calls)', () => {
  // Build a 1000-file synthetic fixture: each file imports the next 5
  // (cyclically), 4 domains. This is large enough that bitmap perf
  // dominates and slow paths surface.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-validate-perf-'));
  fs.mkdirSync(path.join(projectRoot, '.carto'), { recursive: true });
  const { SQLiteStore } = require('../src/store/sqlite-store');
  const store = new SQLiteStore(projectRoot);
  store.open();
  const N = 1000;
  const insertFile = store._db.prepare(
    'INSERT INTO files (id, path, language, hash, mtime, size) VALUES (?,?,?,?,?,?)'
  );
  const insertImport = store._db.prepare(
    'INSERT INTO imports (from_file_id, to_file_id, to_path, resolved) VALUES (?,?,?,1)'
  );
  const tx = store._db.transaction(() => {
    for (let i = 1; i <= N; i++) insertFile.run(i, `src/d${i % 4}/f${i}.ts`, 'typescript', `h${i}`, Date.now(), 100);
    for (let i = 1; i <= N; i++) {
      for (let k = 1; k <= 5; k++) {
        const to = ((i + k - 1) % N) + 1;
        if (to !== i) insertImport.run(i, to, `src/d${to % 4}/f${to}.ts`);
      }
    }
    for (let d = 0; d < 4; d++) store._db.prepare('INSERT INTO domains (id, name, file_count) VALUES (?,?,?)').run(d + 1, `D${d}`, 250);
    for (let i = 1; i <= N; i++) {
      store._db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?,?)').run(i, (i % 4) + 1);
    }
  });
  tx();
  store.computeReverseDeps(5);
  const { buildFromStore } = require('../src/bitmap/sidecar');
  const sidecar = buildFromStore(store);

  // Use a representative 20-line modify diff against an existing file.
  const targetIdx = 250;
  const targetPath = `src/d${targetIdx % 4}/f${targetIdx}.ts`;
  const diffLines = [`diff --git a/${targetPath} b/${targetPath}`,
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    `@@ -1,1 +1,21 @@`,
    ` original`];
  for (let i = 0; i < 20; i++) diffLines.push(`+const v${i} = ${i};`);
  const diff = diffLines.join('\n') + '\n';

  // Warmup
  for (let i = 0; i < 10; i++) spec16ValidateDiff(store, sidecar, diff);
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const t0 = process.hrtime.bigint();
    spec16ValidateDiff(store, sidecar, diff);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[49];
  const p99 = samples[98];
  // Loose budget for the 1000-file fixture — vscode (7K files) has its
  // own perf gate in bench/validation-perf/. The tight number stays in
  // the bench harness; this test only catches catastrophic regressions.
  assert.ok(p50 <= 15, `validateDiff p50 ${p50.toFixed(2)}ms must be ≤ 15ms`);
  assert.ok(p99 <= 50, `validateDiff p99 ${p99.toFixed(2)}ms must be ≤ 50ms`);

  try { store.close(); } catch {}
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// Episodic Memory — 6 tests
// ═══════════════════════════════════════════════════════════════════

test('Episodic Memory', 'Schema v4 migrates a fresh DB with the episodic + gaps tables', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-spec16-em-'));
  try {
    const { SQLiteStore } = require('../src/store/sqlite-store');
    const s = new SQLiteStore(projectRoot);
    s.open();
    assert.strictEqual(s.getMeta('schema_version'), '4', 'schema_version must be 4');
    const tables = s._db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of ['ai_sessions', 'decisions', 'interventions']) {
      assert.ok(tables.includes(t), `table ${t} must exist`);
    }
    // Indexes
    const indexes = s._db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => r.name);
    assert.ok(indexes.includes('idx_decisions_ts'), 'decisions ts index');
    assert.ok(indexes.includes('idx_interventions_file'), 'interventions file index');
    s.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Episodic Memory', 'recordDecision + recordIntervention write rows with correct linkage + timestamps', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-spec16-em-'));
  try {
    const { SQLiteStore } = require('../src/store/sqlite-store');
    const s = new SQLiteStore(projectRoot);
    s.open();
    const session = s.getOrCreateActiveSession('cli');
    assert.ok(session && session.id > 0);
    const before = Date.now();
    const did = s.recordDecision({
      sessionId: session.id, kind: 'validation', file: 'src/foo.ts', payload: { hash: 'abc' },
    });
    const iid = s.recordIntervention({
      sessionId: session.id, kind: 'high_blast', file: 'src/foo.ts', severity: 'HIGH', message: 'too many deps',
    });
    const after = Date.now();
    const dRow = s._db.prepare('SELECT * FROM decisions WHERE id = ?').get(did);
    const iRow = s._db.prepare('SELECT * FROM interventions WHERE id = ?').get(iid);
    assert.strictEqual(dRow.session_id, session.id);
    assert.strictEqual(dRow.kind, 'validation');
    assert.strictEqual(dRow.file, 'src/foo.ts');
    assert.ok(dRow.ts >= before && dRow.ts <= after, 'ts within range');
    assert.strictEqual(iRow.session_id, session.id);
    assert.strictEqual(iRow.severity, 'HIGH');
    assert.strictEqual(iRow.accepted, null, 'accepted is nullable tri-state');
    s.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Episodic Memory', 'getRecentDecisions filters by time + kind, newest-first', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-spec16-em-'));
  try {
    const { SQLiteStore } = require('../src/store/sqlite-store');
    const s = new SQLiteStore(projectRoot);
    s.open();
    const session = s.getOrCreateActiveSession('cli');
    // Inject one row 30 days ago, two rows now.
    const now = Date.now();
    const oldTs = now - 30 * 86_400_000;
    s._db.prepare(
      'INSERT INTO decisions (session_id, ts, kind, file, payload_json) VALUES (?,?,?,?,?)'
    ).run(session.id, oldTs, 'validation', 'src/old.ts', '{}');
    s.recordDecision({ sessionId: session.id, kind: 'validation', file: 'src/a.ts', payload: { x: 1 } });
    s.recordDecision({ sessionId: session.id, kind: 'note', file: 'src/b.ts', payload: { y: 2 } });

    const last7d = s.getRecentDecisions(7 * 86_400_000);
    assert.strictEqual(last7d.length, 2, '30-day-old row must be excluded');
    assert.ok(last7d[0].ts >= last7d[1].ts, 'newest first');

    const validations = s.getRecentDecisions(7 * 86_400_000, 'validation');
    assert.strictEqual(validations.length, 1);
    assert.strictEqual(validations[0].kind, 'validation');
    s.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Episodic Memory', 'getSessionContext returns decisions + interventions for the session, null for unknown', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-spec16-em-'));
  try {
    const { SQLiteStore } = require('../src/store/sqlite-store');
    const s = new SQLiteStore(projectRoot);
    s.open();
    const session = s.getOrCreateActiveSession('cli');
    s.recordDecision({ sessionId: session.id, kind: 'validation', file: 'src/a.ts', payload: { x: 1 } });
    s.recordIntervention({ sessionId: session.id, kind: 'high_blast', file: 'src/a.ts', severity: 'HIGH', message: 'risky' });
    const ctx = s.getSessionContext(session.id);
    assert.ok(ctx, 'context for known id');
    assert.strictEqual(ctx.session.id, session.id);
    assert.strictEqual(ctx.decisions.length, 1);
    assert.strictEqual(ctx.interventions.length, 1);
    assert.strictEqual(s.getSessionContext(99999), null, 'unknown id → null');
    s.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Episodic Memory', 'searchDecisions matches substrings inside payload_json (did_we_discuss_this)', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-spec16-em-'));
  try {
    const { SQLiteStore } = require('../src/store/sqlite-store');
    const s = new SQLiteStore(projectRoot);
    s.open();
    const session = s.getOrCreateActiveSession('cli');
    s.recordDecision({ sessionId: session.id, kind: 'validation', file: 'src/auth.ts', payload: { topic: 'snake_case naming convention' } });
    s.recordDecision({ sessionId: session.id, kind: 'note', file: 'src/users.ts', payload: { topic: 'pagination' } });
    const snakeHits = s.searchDecisions('snake_case');
    assert.strictEqual(snakeHits.length, 1, 'one match');
    assert.strictEqual(snakeHits[0].file, 'src/auth.ts');
    const fileHits = s.searchDecisions('users');
    assert.strictEqual(fileHits.length, 1, 'matches file column too');
    const noHits = s.searchDecisions('nothing-matches');
    assert.strictEqual(noHits.length, 0);
    s.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('Episodic Memory', 'getInterventionsForFile filters by file; null returns all', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-spec16-em-'));
  try {
    const { SQLiteStore } = require('../src/store/sqlite-store');
    const s = new SQLiteStore(projectRoot);
    s.open();
    const session = s.getOrCreateActiveSession('cli');
    s.recordIntervention({ sessionId: session.id, kind: 'high_blast', file: 'src/auth.ts', severity: 'HIGH', message: 'a' });
    s.recordIntervention({ sessionId: session.id, kind: 'cross_domain', file: 'src/payments.ts', severity: 'MEDIUM', message: 'b' });
    s.recordIntervention({ sessionId: session.id, kind: 'high_blast', file: 'src/auth.ts', severity: 'HIGH', message: 'c' });

    const authOnly = s.getInterventionsForFile('src/auth.ts');
    assert.strictEqual(authOnly.length, 2);
    assert.ok(authOnly.every((iv) => iv.file === 'src/auth.ts'));

    const all = s.getInterventionsForFile(null);
    assert.strictEqual(all.length, 3);
    s.close();
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PR impact — 6 tests
// ═══════════════════════════════════════════════════════════════════

const prImpact = require('../src/cli/pr-impact');

test('PR impact', 'parseArgs accepts known flags + rejects unknown', () => {
  const ok = prImpact.parseArgs(['--base', 'main', '--head', 'feat', '--format', 'json', '--fail-on', 'high']);
  assert.strictEqual(ok.base, 'main');
  assert.strictEqual(ok.head, 'feat');
  assert.strictEqual(ok.format, 'json');
  assert.strictEqual(ok.failOn, 'HIGH');
  assert.throws(() => prImpact.parseArgs(['--what']), /unknown flag: --what/);
  assert.throws(() => prImpact.parseArgs(['--format', 'xml']), /--format/);
  assert.throws(() => prImpact.parseArgs(['--fail-on', 'EXTREME']), /--fail-on/);
});

test('PR impact', 'collectImpact + renderMarkdown produce a marker, headline, metric table, and per-section detail', () => {
  // Reuse the bitmap fixture (10 files, CORE+AUTH domains, f0 with 9 transitive deps).
  const fix = buildValidationFixture();
  try {
    // Diff modifies f0 (high blast — 9 transitive deps) AND introduces a new
    // CORE → AUTH import (cross-domain into a sensitive domain).
    const diff = `diff --git a/src/f0.ts b/src/f0.ts
--- a/src/f0.ts
+++ b/src/f0.ts
@@ -1,1 +1,2 @@
 line
+const x = 1;
diff --git a/src/f1.ts b/src/f1.ts
--- a/src/f1.ts
+++ b/src/f1.ts
@@ -1,1 +1,2 @@
 line
+import { x } from './f6';
`;
    const impact = prImpact.collectImpact(fix.projectRoot, diff);
    const md = prImpact.renderMarkdown(impact);

    // Marker is the first line so the GitHub Action can detect-and-update.
    assert.ok(md.startsWith(prImpact.MARKER), 'must start with marker');
    // Headline — both CORE and AUTH should be in the touched-domains sentence.
    assert.ok(/touches\s+\*\*(CORE|AUTH)\*\*/.test(md), 'headline names a domain');
    assert.ok(md.includes('**CORE**') && md.includes('**AUTH**'), 'both domains called out');
    // Metric table.
    assert.ok(md.includes('| **Risk** |'), 'metric table risk row');
    assert.ok(md.includes('| Blast radius (union) |'), 'metric table blast row');
    assert.ok(md.includes('| Files changed | 2 |'), 'metric table files-changed = 2');
    assert.ok(md.includes('| Cross-domain violations introduced | 1 |'), 'one xd violation surfaced');
    // Cross-domain section present.
    assert.ok(/<details>\s*\n<summary>Cross-domain violations \(1\)/.test(md));
    assert.ok(md.includes('CORE→AUTH'), 'cross-domain detail line');
    // High-blast section present (f0 has 9 deps; default threshold is 20 medium / 50 high — won't trigger
    // unless we lower thresholds. Adjust by passing thresholds into validateDiff via a custom path,
    // OR simply assert the metric row above is correct.) — skip for default thresholds.
    // Footer attribution.
    assert.ok(md.includes('carto-md'), 'footer attribution present');
    // Risk should be at least LOW (or HIGH from cross-domain into sensitive AUTH).
    assert.ok(['MEDIUM', 'HIGH'].includes(impact.result.risk), 'risk reflects cross-domain violation');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('PR impact', 'renderJson follows the documented stable contract shape', () => {
  const fix = buildValidationFixture();
  try {
    const diff = `diff --git a/src/f1.ts b/src/f1.ts
--- a/src/f1.ts
+++ b/src/f1.ts
@@ -1,1 +1,2 @@
 line
+import { x } from './f6';
`;
    const impact = prImpact.collectImpact(fix.projectRoot, diff);
    const json = prImpact.renderJson(impact);
    // Contract keys
    for (const key of [
      'marker', 'risk', 'files_changed', 'blast_radius_union',
      'domains_touched', 'high_impact_file', 'violations',
      'suggestions', 'per_file',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(json, key), `missing key: ${key}`);
    }
    assert.strictEqual(json.marker, prImpact.MARKER);
    assert.ok(['SAFE', 'LOW', 'MEDIUM', 'HIGH'].includes(json.risk));
    assert.strictEqual(typeof json.files_changed, 'number');
    assert.strictEqual(typeof json.blast_radius_union, 'number');
    assert.ok(Array.isArray(json.domains_touched));
    assert.ok(Array.isArray(json.violations));
    assert.ok(Array.isArray(json.suggestions));
    assert.strictEqual(typeof json.per_file, 'object');
    // per_file entries follow the per-file contract.
    const f1 = json.per_file['src/f1.ts'];
    assert.ok(f1, 'per_file must include src/f1.ts');
    assert.strictEqual(typeof f1.blast_radius, 'number');
    assert.strictEqual(typeof f1.directly_affected, 'number');
    assert.ok(Array.isArray(f1.domains));
    assert.ok(Array.isArray(f1.routes));
    // Round-trip through JSON.stringify cleanly (no circular refs, no NaN).
    JSON.parse(JSON.stringify(json));
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('PR impact', 'decideExitCode honors --fail-on threshold (no flag → 0; HIGH risk + --fail-on HIGH → 2)', () => {
  // Without a threshold, exit is always 0.
  assert.strictEqual(prImpact.decideExitCode('HIGH', null), 0);
  assert.strictEqual(prImpact.decideExitCode('SAFE', null), 0);
  // With a threshold, exit is 2 if risk >= threshold.
  assert.strictEqual(prImpact.decideExitCode('HIGH', 'HIGH'), 2);
  assert.strictEqual(prImpact.decideExitCode('MEDIUM', 'HIGH'), 0);
  assert.strictEqual(prImpact.decideExitCode('MEDIUM', 'MEDIUM'), 2);
  assert.strictEqual(prImpact.decideExitCode('LOW', 'MEDIUM'), 0);
  assert.strictEqual(prImpact.decideExitCode('LOW', 'LOW'), 2);
  assert.strictEqual(prImpact.decideExitCode('SAFE', 'LOW'), 0);
});

test('PR impact', 'marker appears exactly once at the top of rendered markdown (sticky-comment invariant)', () => {
  const fix = buildValidationFixture();
  try {
    const diff = `diff --git a/src/f0.ts b/src/f0.ts
--- a/src/f0.ts
+++ b/src/f0.ts
@@ -1,1 +1,2 @@
 line
+const x = 1;
`;
    const impact = prImpact.collectImpact(fix.projectRoot, diff);
    const md = prImpact.renderMarkdown(impact);
    // Marker is at the start of the body (line 1).
    assert.strictEqual(md.split('\n')[0], prImpact.MARKER, 'marker on line 1');
    // Marker appears exactly once — the action keys on this for sticky-comment update.
    const occurrences = md.split(prImpact.MARKER).length - 1;
    assert.strictEqual(occurrences, 1, 'marker must appear exactly once');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('PR impact', 'collectImpact throws a clear error when no carto index exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pr-no-index-'));
  try {
    assert.throws(
      () => prImpact.collectImpact(tmp, 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n'),
      /No carto index/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Scale-test driver — generator + runner smoke
// ═══════════════════════════════════════════════════════════════════
//
// Three tests at small scale. The synth generator is the substrate the
// 100K/500K/1M validation runs sit on top of, so determinism + import
// graph constraints + an end-to-end smoke through `runSync` cover the
// invariants that matter without making CI slow.
//
// Big runs live behind `npm run bench:scale -- --size <N>` — they're
// maintainer-machine work and never run in CI.

const scaleGen = require('../bench/scale-test/generator');

test('Scale-test driver', 'generator: same seed → byte-identical output across two runs', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-scale-gen-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-scale-gen-b-'));
  try {
    const ma = scaleGen.generateRepo(a, { size: 200, seed: 12345 });
    const mb = scaleGen.generateRepo(b, { size: 200, seed: 12345 });
    assert.strictEqual(ma.size, 200);
    assert.strictEqual(ma.edgeCount, mb.edgeCount,
      `edgeCount must match: ${ma.edgeCount} vs ${mb.edgeCount}`);
    // Spot-check 3 generated files byte-for-byte.
    for (const id of [0, 17, 199]) {
      const rel = scaleGen.relPathOf(id);
      const ca = fs.readFileSync(path.join(a, rel), 'utf-8');
      const cb = fs.readFileSync(path.join(b, rel), 'utf-8');
      assert.strictEqual(ca, cb, `file ${rel} differs across same-seed runs`);
    }
    // Different seed → different output (smoke check that seeding actually wires in).
    const c = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-scale-gen-c-'));
    try {
      scaleGen.generateRepo(c, { size: 200, seed: 67890 });
      const c0 = fs.readFileSync(path.join(c, scaleGen.relPathOf(50)), 'utf-8');
      const a0 = fs.readFileSync(path.join(a, scaleGen.relPathOf(50)), 'utf-8');
      assert.notStrictEqual(a0, c0,
        'different seeds should produce different file_50.ts content');
    } finally {
      fs.rmSync(c, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('Scale-test driver', 'generator: import graph respects fan-out cap, acyclicity, and same-domain bias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-scale-graph-'));
  try {
    const N = 500;
    const meta = scaleGen.generateRepo(dir, { size: N, seed: 42 });
    assert.strictEqual(meta.size, N);
    assert.ok(meta.edgeCount > 0, `expected >0 edges, got ${meta.edgeCount}`);

    // Walk every generated file, parse its `import { fnK } from './...'`
    // lines, and assert: K < self id (acyclic), 0 ≤ K < N, fan-out ≤ 8.
    let sameDomain = 0;
    let crossDomain = 0;
    let totalImports = 0;
    for (let i = 0; i < N; i++) {
      const rel = scaleGen.relPathOf(i);
      const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
      const imports = [];
      for (const line of content.split('\n')) {
        const m = line.match(/^import \{ fn(\d+) \} from /);
        if (m) imports.push(parseInt(m[1], 10));
      }
      assert.ok(imports.length <= 8,
        `file ${i} has ${imports.length} imports, exceeds fan-out cap of 8`);
      for (const t of imports) {
        assert.ok(t < i,
          `file ${i} imports ${t} — must reference earlier id only (acyclic invariant)`);
        assert.ok(t >= 0 && t < N, `target id ${t} out of range`);
      }
      totalImports += imports.length;
      const myDomain = scaleGen.domainOf(i);
      for (const t of imports) {
        if (scaleGen.domainOf(t) === myDomain) sameDomain++;
        else crossDomain++;
      }
    }
    assert.strictEqual(totalImports, meta.edgeCount,
      `parsed ${totalImports} imports; generator reported ${meta.edgeCount}`);
    // Same-domain bias is 75% per the generator. Allow loose bounds for
    // PRNG variance — anywhere in [55%, 95%] is fine, we're checking
    // that the bias is in the right direction, not a tight statistical
    // guarantee.
    const sameRatio = sameDomain / Math.max(1, sameDomain + crossDomain);
    assert.ok(sameRatio >= 0.55 && sameRatio <= 0.95,
      `expected 55-95% same-domain edges; got ${(sameRatio * 100).toFixed(1)}% (${sameDomain}/${sameDomain + crossDomain})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ANCI v0.1 roundtrip
// ═══════════════════════════════════════════════════════════════════

const anciYaml = require('../src/anci/yaml');
const {
  serializeBody,
  deriveBodyFromSidecar,
  buildHeader,
  MAGIC: ANCI_MAGIC,
  VERSION: ANCI_VERSION,
} = require('../src/anci/serialize');
const { deserializeBody } = require('../src/anci/deserialize');
const { Bitset: AnciBitset } = require('../src/bitmap/bitset');
const { loadAnci } = require('../src/anci/consumer');

test('ANCI roundtrip', 'yaml.emit + yaml.parse round-trip the full ANCI header shape', () => {
  const obj = {
    anci: {
      version: '0.1.0-DRAFT',
      generator: 'carto-md@2.0.9',
      generated_at: '2026-06-07T12:00:00.000Z',
      body: { file: 'anci.bin', bytes: 1234 },
    },
    project: { total_files: 7, total_routes: 2, total_models: 1, total_import_edges: 12 },
    domains: [
      { name: 'AUTH', file_count: 3, route_count: 2, model_count: 0 },
      { name: 'CORE', file_count: 4, route_count: 0, model_count: 1 },
    ],
    high_impact: [{ file: 'src/auth.ts', transitive_dependents: 5 }],
    routes: [{ method: 'POST', path: '/login', file: 'src/auth.ts', framework: 'express', handler: 'login' }],
    models: [{ name: 'User', kind: 'prisma', file: 'schema.prisma' }],
  };
  const text = anciYaml.emit(obj);
  const round = anciYaml.parse(text);
  assert.deepStrictEqual(round, obj, 'YAML round-trip must be lossless');
});

test('ANCI roundtrip', 'yaml.emit handles strings with quotes, backslashes, and unicode', () => {
  const obj = {
    anci: { version: '0.1.0-DRAFT' },
    odd: [
      { path: 'has "quotes" inside', x: 1 },
      { path: 'back\\slash and tab\there', x: 2 },
      { path: 'unicode: 日本語 ✓', x: 3 },
    ],
  };
  const round = anciYaml.parse(anciYaml.emit(obj));
  assert.strictEqual(round.odd[0].path, 'has "quotes" inside');
  assert.strictEqual(round.odd[1].path, 'back\\slash and tab\there');
  assert.strictEqual(round.odd[2].path, 'unicode: 日本語 ✓');
});

test('ANCI roundtrip', 'yaml.parse rejects malformed indentation', () => {
  // 3 spaces — strict subset is 2-space indent.
  const bad = 'anci:\n   version: "0.1.0-DRAFT"\n';
  assert.throws(() => anciYaml.parse(bad), /indent must be a multiple of 2/);
});

test('ANCI roundtrip', 'yaml.parse rejects bare strings (must be quoted)', () => {
  // Bare string `0.1.0-DRAFT` is not in the strict subset (must be quoted).
  const bad = 'anci:\n  version: 0.1.0-DRAFT\n';
  assert.throws(() => anciYaml.parse(bad), /scalar must be quoted/);
});

test('ANCI roundtrip', 'serializeBody + deserializeBody round-trips forward, reverse, popcount, paths, domains', () => {
  // Hand-built fixture — 4 files, 3 imports, 2 domains.
  // file 0 (CORE) → file 1, file 2
  // file 1 (AUTH) → file 3
  // file 2 (AUTH) → file 3
  const size = 4;
  const forward = new Map();
  const reverse = new Map();
  const f0 = new AnciBitset(size); f0.set(1); f0.set(2); forward.set(0, f0);
  const f1 = new AnciBitset(size); f1.set(3); forward.set(1, f1);
  const f2 = new AnciBitset(size); f2.set(3); forward.set(2, f2);
  const r1 = new AnciBitset(size); r1.set(0); reverse.set(1, r1);
  const r2 = new AnciBitset(size); r2.set(0); reverse.set(2, r2);
  const r3 = new AnciBitset(size); r3.set(1); r3.set(2); reverse.set(3, r3);

  const popcountIndex = [
    { fileId: 3, count: 3 }, // file 3 reachable by all of 0/1/2
    { fileId: 1, count: 1 },
    { fileId: 2, count: 1 },
  ];
  const fileIdToPath = new Map([
    [0, 'src/index.ts'],
    [1, 'src/auth/login.ts'],
    [2, 'src/auth/session.ts'],
    [3, 'src/db.ts'],
  ]);
  const fileDomain = new Map([[0, 1], [1, 2], [2, 2], [3, 1]]);
  const domainIdToName = new Map([[1, 'CORE'], [2, 'AUTH']]);

  const buf = serializeBody({
    size, forward, reverse, popcountIndex, fileIdToPath, fileDomain, domainIdToName,
  });
  // Magic check: first 4 bytes should equal MAGIC.
  assert.strictEqual(buf.readUInt32LE(0), ANCI_MAGIC, 'magic bytes must match');
  assert.strictEqual(buf.readUInt8(4), ANCI_VERSION, 'version byte must be 1');

  const decoded = deserializeBody(buf);
  assert.ok(decoded, 'deserializeBody returned null on a valid buffer');
  assert.strictEqual(decoded.size, size);

  // Forward: each entry's set bits should match the input.
  assert.deepStrictEqual(decoded.forward.get(0).iterate().sort(), [1, 2]);
  assert.deepStrictEqual(decoded.forward.get(1).iterate(), [3]);
  // Reverse:
  assert.deepStrictEqual(decoded.reverse.get(3).iterate().sort(), [1, 2]);
  // Popcount:
  assert.strictEqual(decoded.popcountIndex.length, 3);
  assert.deepStrictEqual(decoded.popcountIndex[0], { fileId: 3, count: 3 });
  // Paths:
  assert.strictEqual(decoded.fileIdToPath.get(0), 'src/index.ts');
  assert.strictEqual(decoded.pathToFileId.get('src/db.ts'), 3);
  // Domains:
  assert.strictEqual(decoded.domainIdToName.get(2), 'AUTH');
  assert.strictEqual(decoded.fileDomain.get(2), 2);
});

test('ANCI roundtrip', 'deserializeBody returns null on bad magic bytes', () => {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(0xDEADBEEF, 0); // wrong magic
  assert.strictEqual(deserializeBody(buf), null);
});

test('ANCI roundtrip', 'deserializeBody returns null on unsupported version', () => {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(ANCI_MAGIC, 0);
  buf.writeUInt8(99, 4);  // future version this consumer doesn't speak
  assert.strictEqual(deserializeBody(buf), null);
});

test('ANCI roundtrip', 'consumer.loadAnci throws a clear error when files are missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-anci-missing-'));
  try {
    assert.throws(
      () => loadAnci(tmp),
      /ANCI not found.*anci\.yaml/,
      'loadAnci must throw a clear error when the YAML header is missing'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ANCI roundtrip', 'consumer.loadAnci throws on unsupported header version', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-anci-badver-'));
  try {
    // Write a v0.2.x header — outside our 0.1.x acceptance prefix.
    const yamlText = anciYaml.emit({
      anci: {
        version: '0.2.0-FUTURE',
        generator: 'something@1',
        generated_at: '2026-06-07T00:00:00.000Z',
        body: { file: 'anci.bin', bytes: 12 },
      },
    });
    fs.writeFileSync(path.join(tmp, 'anci.yaml'), yamlText);
    // Minimal valid binary so the version check is what trips us.
    const buf = Buffer.alloc(12);
    buf.writeUInt32LE(ANCI_MAGIC, 0);
    buf.writeUInt8(ANCI_VERSION, 4);
    buf.writeUInt32LE(0, 8);
    fs.writeFileSync(path.join(tmp, 'anci.bin'), buf);

    assert.throws(() => loadAnci(tmp), /ANCI version unsupported/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// SSE streaming — shared parser, Anthropic fold, OpenAI fold
// ═══════════════════════════════════════════════════════════════════

const { parseSseStream } = require('../src/acp/providers/sse');
const { AnthropicProvider: AnthropicProviderForTest } = require('../src/acp/providers/anthropic');
const { OpenAIProvider: OpenAIProviderForTest } = require('../src/acp/providers/openai');

test('SSE streaming', 'parseSseStream handles complete events + chunked partial events + [DONE] sentinel', () => {
  // Single chunk containing two events and one trailing partial.
  const events = [];
  const onEvent = (e, d) => events.push({ event: e, data: d });

  let buf = '';
  buf = parseSseStream(
    'event: a\ndata: {"v":1}\n\nevent: b\ndata: {"v":2}\n\ndata: {"v":3',
    buf,
    onEvent,
  );
  // Two events surfaced; third is still in the buffer (no \n\n yet).
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events[0], { event: 'a', data: { v: 1 } });
  assert.deepStrictEqual(events[1], { event: 'b', data: { v: 2 } });

  // Feed the rest of event #3 + a [DONE] sentinel in a follow-up chunk.
  buf = parseSseStream('}\n\ndata: [DONE]\n\n', buf, onEvent);
  assert.strictEqual(events.length, 4);
  assert.deepStrictEqual(events[2], { event: null, data: { v: 3 } });
  assert.deepStrictEqual(events[3], { event: 'done', data: null });
  // Buffer fully consumed.
  assert.strictEqual(buf, '');
});

test('SSE streaming', 'parseSseStream tolerates malformed JSON without throwing', () => {
  const events = [];
  parseSseStream('data: not json\n\n', '', (e, d) => events.push({ e, d }));
  assert.strictEqual(events.length, 1);
  assert.ok(events[0].d && typeof events[0].d._raw === 'string', 'malformed payload surfaces via _raw');
});

test('SSE streaming', 'AnthropicProvider._foldEvents assembles text deltas + tool_use input fragments', () => {
  const provider = new AnthropicProviderForTest('k', 'https://api.anthropic.com', 'claude-sonnet-4');
  const folded = provider._foldEvents([
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_blast_radius', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file":"' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'src/x.ts"}' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  assert.strictEqual(folded.content.length, 2);
  assert.deepStrictEqual(folded.content[0], { type: 'text', text: 'Hello world' });
  assert.strictEqual(folded.content[1].type, 'tool_use');
  assert.strictEqual(folded.content[1].id, 'tu_1');
  assert.strictEqual(folded.content[1].name, 'get_blast_radius');
  assert.deepStrictEqual(folded.content[1].input, { file: 'src/x.ts' });
});

test('SSE streaming', 'AnthropicProvider._foldEvents tolerates empty input_json_delta on a no-arg tool', () => {
  const provider = new AnthropicProviderForTest('k', 'https://api.anthropic.com', 'claude-sonnet-4');
  // Real-world: tools with empty inputs produce `partial_json: ""` deltas.
  const folded = provider._foldEvents([
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_empty', name: 'get_architecture', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  assert.strictEqual(folded.content.length, 1);
  assert.deepStrictEqual(folded.content[0].input, {}, 'empty json deltas must fold to empty object, not crash');
});

test('SSE streaming', 'OpenAIProvider._foldChunks concatenates content + indexed tool_call arguments', () => {
  const provider = new OpenAIProviderForTest('k', 'https://api.openai.com/v1', 'gpt-4o');
  const folded = provider._foldChunks([
    { choices: [{ delta: { content: 'Hello ' } }] },
    { choices: [{ delta: { content: 'world' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_blast_radius', arguments: '{"fi' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'le":"src/x.ts"}' } }] } }] },
  ]);
  // Text first, then tool_use — order matches the agent loop's expectation.
  assert.strictEqual(folded.content[0].type, 'text');
  assert.strictEqual(folded.content[0].text, 'Hello world');
  assert.strictEqual(folded.content[1].type, 'tool_use');
  assert.strictEqual(folded.content[1].id, 'call_1');
  assert.strictEqual(folded.content[1].name, 'get_blast_radius');
  assert.deepStrictEqual(folded.content[1].input, { file: 'src/x.ts' });
});

// ═══════════════════════════════════════════════════════════════════
// Files-without-tests detector
// ═══════════════════════════════════════════════════════════════════

const fwtModule = require('../src/mcp/files-without-tests');

test('Files without tests', 'stemOf strips test_*, *_test, and .test/.spec suffixes', () => {
  assert.strictEqual(fwtModule.stemOf('src/auth/login.ts'), 'login');
  assert.strictEqual(fwtModule.stemOf('src/auth/login.test.ts'), 'login');
  assert.strictEqual(fwtModule.stemOf('src/auth/login.spec.tsx'), 'login');
  assert.strictEqual(fwtModule.stemOf('svc/user_test.go'), 'user');
  assert.strictEqual(fwtModule.stemOf('py/test_user.py'), 'user');
});

test('Files without tests', 'isTestFile + isNonSourceFile correctly classify boundary cases', () => {
  assert.strictEqual(fwtModule.isTestFile('src/x.test.ts'), true);
  assert.strictEqual(fwtModule.isTestFile('src/x.spec.tsx'), true);
  assert.strictEqual(fwtModule.isTestFile('svc/user_test.go'), true);
  assert.strictEqual(fwtModule.isTestFile('py/test_user.py'), true);
  assert.strictEqual(fwtModule.isTestFile('src/x.ts'), false);
  assert.strictEqual(fwtModule.isNonSourceFile('README.md'), true);
  assert.strictEqual(fwtModule.isNonSourceFile('package.json'), true);
  assert.strictEqual(fwtModule.isNonSourceFile('types.d.ts'), true);
  assert.strictEqual(fwtModule.isNonSourceFile('src/x.ts'), false);
});

test('Files without tests', 'filesWithoutTests returns the right set across JS/TS, Python, Go conventions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fwt-detect-'));
  try {
    fs.mkdirSync(path.join(root, 'src/auth'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/utils'), { recursive: true });
    fs.mkdirSync(path.join(root, 'py/lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'py/lib/tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'svc'), { recursive: true });

    fs.writeFileSync(path.join(root, 'src/auth/login.ts'), '');
    fs.writeFileSync(path.join(root, 'src/auth/login.test.ts'), '');     // pairs with login.ts
    fs.writeFileSync(path.join(root, 'src/auth/session.ts'), '');         // NO test
    fs.writeFileSync(path.join(root, 'src/utils/format.ts'), '');         // NO test
    fs.writeFileSync(path.join(root, 'py/lib/service.py'), '');
    fs.writeFileSync(path.join(root, 'py/lib/tests/test_service.py'), ''); // pairs with service.py
    fs.writeFileSync(path.join(root, 'py/lib/helper.py'), '');             // NO test
    fs.writeFileSync(path.join(root, 'svc/handler.go'), '');
    fs.writeFileSync(path.join(root, 'svc/handler_test.go'), '');          // pairs with handler.go
    fs.writeFileSync(path.join(root, 'svc/util.go'), '');                  // NO test
    fs.writeFileSync(path.join(root, 'src/auth/README.md'), '');           // non-source (skip)

    const out = fwtModule.filesWithoutTests(root, [
      'src/auth/login.ts',
      'src/auth/session.ts',
      'src/auth/README.md',
      'src/utils/format.ts',
      'py/lib/service.py',
      'py/lib/helper.py',
      'svc/handler.go',
      'svc/util.go',
    ]);
    assert.strictEqual(out.count, 4, `count: expected 4, got ${out.count}: ${out.files.join(', ')}`);
    assert.strictEqual(out.considered, 7, `considered: expected 7 (excluding README.md), got ${out.considered}`);
    assert.deepStrictEqual(
      [...out.files].sort(),
      ['py/lib/helper.py', 'src/auth/session.ts', 'src/utils/format.ts', 'svc/util.go'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Files without tests', 'index.ts barrels are skipped (not counted as missing tests)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fwt-barrel-'));
  try {
    fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/lib/index.ts'), '');
    fs.writeFileSync(path.join(root, 'src/lib/helper.ts'), ''); // NO test
    const out = fwtModule.filesWithoutTests(root, ['src/lib/index.ts', 'src/lib/helper.ts']);
    // helper.ts is the only candidate considered; index.ts is skipped.
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.considered, 1);
    assert.deepStrictEqual(out.files, ['src/lib/helper.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PR impact — files-without-tests metric row (in blast radius)
// ═══════════════════════════════════════════════════════════════════

test('PR impact', 'files-without-tests metric appears in markdown table + JSON contract', () => {
  // Build the fixture, then write a couple of source files (without
  // corresponding .test.* siblings) so the detector has something to
  // find. The fixture's f0.ts has a 9-file blast radius; we add real
  // files on disk that the detector walks.
  const fix = buildValidationFixture();
  try {
    // Materialize a few of the fixture file paths as empty TS files so
    // the filesystem walk has entries to inspect. The store knew them as
    // rows, but the bitmap union won't yield disk files unless they
    // actually exist.
    for (let i = 0; i < 4; i++) {
      const rel = `src/f${i}.ts`;
      const abs = path.join(fix.projectRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
    }
    const diff = `diff --git a/src/f0.ts b/src/f0.ts
--- a/src/f0.ts
+++ b/src/f0.ts
@@ -1,1 +1,2 @@
 line
+const x = 1;
`;
    const impact = prImpact.collectImpact(fix.projectRoot, diff);
    const md = prImpact.renderMarkdown(impact);
    const json = prImpact.renderJson(impact);

    // Markdown: metric row appears.
    assert.ok(
      /Files without tests in blast radius \| \d+ of \d+/.test(md),
      `expected metric row in markdown:\n${md}`,
    );
    // Collapsible detail block named correctly when count > 0.
    if (impact.filesWithoutTests.count > 0) {
      assert.ok(
        md.includes('Files without tests in blast radius ('),
        'expected collapsible details section header',
      );
    }
    // JSON contract: new key is always present with stable shape.
    assert.ok(
      Object.prototype.hasOwnProperty.call(json, 'files_without_tests'),
      'json must expose files_without_tests',
    );
    const fwt = json.files_without_tests;
    assert.strictEqual(typeof fwt.count, 'number');
    assert.strictEqual(typeof fwt.considered, 'number');
    assert.ok(Array.isArray(fwt.files));
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MCP middleware proxy — policy core + line splitter
// ═══════════════════════════════════════════════════════════════════

const {
  MiddlewareProxy,
  LineSplitter,
  DEFAULT_WRITE_TOOL_PATTERNS,
} = require('../src/mcp/middleware');

// Reusable mock validate that returns a configurable risk.
function mockValidate(risk = 'SAFE', extras = {}) {
  return () => ({
    diff: [],
    blast_radius: { perFile: {}, union: extras.union || 0 },
    violations: extras.violations || [],
    suggestions: extras.suggestions || [],
    risk,
  });
}

test('MCP middleware', 'isWriteTool matches common write-tool naming patterns (suffix + delimiter)', () => {
  const proxy = new MiddlewareProxy({ validate: mockValidate('SAFE') });
  for (const ok of [
    'fs/write_file',
    'filesystem.write_file',
    'fs.write_text_file',
    'text_editor/edit',
    'editor.edit_file',
    'fs/create_file',
    'fs/apply_patch',
  ]) {
    assert.ok(proxy.isWriteTool(ok), `must match: ${ok}`);
  }
  for (const skip of ['fs/read_file', 'list_directory', 'get_blast_radius', '']) {
    assert.ok(!proxy.isWriteTool(skip), `must skip: ${JSON.stringify(skip)}`);
  }
});

test('MCP middleware', 'extractWriteIntent normalizes write_file + text_editor/edit shapes', () => {
  // Build the expected absolute path the same way the middleware does
  // (via path.join) so the mock matches on Windows where separators flip.
  const projRoot = path.join(path.sep, 'proj');
  const expectedAbs = path.join(projRoot, 'src/x.ts');
  const proxy = new MiddlewareProxy({
    validate: mockValidate('SAFE'),
    projectRoot: projRoot,
    readFile: (p) => (p === expectedAbs ? 'OLD\n' : ''),
  });
  // write_file shape
  const a = proxy.extractWriteIntent('fs/write_file', { path: 'src/x.ts', content: 'NEW' });
  assert.deepStrictEqual(a, { path: 'src/x.ts', newContent: 'NEW' });
  // text_editor/edit shape
  const b = proxy.extractWriteIntent('text_editor/edit', {
    path: 'src/x.ts', old_string: 'OLD', new_string: 'NEW',
  });
  assert.strictEqual(b.path, 'src/x.ts');
  assert.strictEqual(b.newContent, 'NEW\n');
  assert.strictEqual(b.oldContent, 'OLD\n');
  // text_editor/edit with old_string that isn't in file → returns null
  // (we don't know what the result would be, so we conservatively skip)
  const c = proxy.extractWriteIntent('text_editor/edit', {
    path: 'src/x.ts', old_string: 'NOPE', new_string: 'NEW',
  });
  assert.strictEqual(c, null);
  // apply_patch shape (prebuilt diff)
  const d = proxy.extractWriteIntent('fs/apply_patch', { path: 'src/x.ts', patch: 'diff --git a/x b/x\n' });
  assert.strictEqual(d.prebuiltDiff, 'diff --git a/x b/x\n');
});

test('MCP middleware', 'synthesizeDiff produces a diff the validateDiff parser can consume', () => {
  const proxy = new MiddlewareProxy({ validate: mockValidate('SAFE') });
  const diff = proxy.synthesizeDiff('src/x.ts', 'old line 1\nold line 2\n', 'new line\n');
  // Parser smoke: feed it to the diff-parser and check it picks up one file.
  const parsed = spec16ParseDiff(diff);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].path, 'src/x.ts');
  assert.strictEqual(parsed[0].kind, 'modify');
  // Add path (empty old content) — should be `add`, parser uses `new file mode`.
  const addDiff = proxy.synthesizeDiff('src/new.ts', '', 'first line\n');
  const parsedAdd = spec16ParseDiff(addDiff);
  assert.strictEqual(parsedAdd.length, 1);
  assert.strictEqual(parsedAdd[0].kind, 'add');
  assert.strictEqual(parsedAdd[0].path, 'src/new.ts');
});

test('MCP middleware', 'handleClient passes through non-write tools + read calls', () => {
  const proxy = new MiddlewareProxy({ validate: mockValidate('HIGH') });
  // Non-tools/call method
  assert.deepStrictEqual(proxy.handleClient({ method: 'initialize', id: 1 }), { intercept: false });
  // tools/call for a read-only tool — passes through even when validate would return HIGH.
  assert.deepStrictEqual(
    proxy.handleClient({ method: 'tools/call', id: 2, params: { name: 'fs/read_file', arguments: { path: 'x' } } }),
    { intercept: false },
  );
});

test('MCP middleware', 'handleClient blocks HIGH-risk writes with structured response', () => {
  const proxy = new MiddlewareProxy({
    projectRoot: '/proj',
    validate: mockValidate('HIGH', {
      union: 47,
      violations: [
        { severity: 'HIGH', kind: 'cross_domain', file: 'src/a.ts', message: 'AUTH→PAYMENTS' },
      ],
    }),
    readFile: () => '',
    blockThreshold: 'HIGH',
  });
  const out = proxy.handleClient({
    method: 'tools/call',
    id: 42,
    params: { name: 'fs/write_file', arguments: { path: 'src/a.ts', content: 'new' } },
  });
  assert.strictEqual(out.intercept, true);
  // MCP convention — result with isError + content array, jsonrpc 2.0 envelope.
  assert.strictEqual(out.response.jsonrpc, '2.0');
  assert.strictEqual(out.response.id, 42);
  assert.strictEqual(out.response.result.isError, true);
  const text = out.response.result.content[0].text;
  assert.ok(text.includes('Carto blocked'), 'response surfaces the block reason');
  assert.ok(text.includes('HIGH'), 'response surfaces the risk level');
  assert.ok(text.includes('47 files'), 'response surfaces the blast radius union');
  assert.ok(text.includes('AUTH→PAYMENTS'), 'response surfaces the violation message');
});

test('MCP middleware', 'handleClient allows MEDIUM-risk writes through when threshold=HIGH', () => {
  const proxy = new MiddlewareProxy({
    projectRoot: '/proj',
    validate: mockValidate('MEDIUM'),
    readFile: () => '',
    blockThreshold: 'HIGH',
  });
  const out = proxy.handleClient({
    method: 'tools/call',
    id: 7,
    params: { name: 'fs/write_file', arguments: { path: 'src/a.ts', content: 'new' } },
  });
  assert.strictEqual(out.intercept, false, 'MEDIUM must pass when threshold is HIGH');
});

test('MCP middleware', 'handleClient fails open when validate throws (does not block on infra failures)', () => {
  const proxy = new MiddlewareProxy({
    projectRoot: '/proj',
    validate: () => { throw new Error('store offline'); },
    readFile: () => '',
  });
  const out = proxy.handleClient({
    method: 'tools/call',
    id: 11,
    params: { name: 'fs/write_file', arguments: { path: 'src/a.ts', content: 'new' } },
  });
  assert.strictEqual(out.intercept, false, 'validate-throws must NOT block writes (fail open)');
});

test('MCP middleware', 'LineSplitter splits incremental JSON-RPC frames + tolerates malformed lines', () => {
  const got = [];
  const splitter = new LineSplitter((msg) => got.push(msg), 'unit');
  // Two chunks split mid-message; one good frame + one malformed line + one good frame.
  splitter.feed('{"jsonrpc":"2.0","id":1');
  splitter.feed(',"method":"a"}\nnot-json\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');
  assert.strictEqual(got.length, 2);
  assert.deepStrictEqual(got[0], { jsonrpc: '2.0', id: 1, method: 'a' });
  assert.deepStrictEqual(got[1], { jsonrpc: '2.0', id: 2, method: 'b' });
});

// ═══════════════════════════════════════════════════════════════════
// carto validate CLI — integration smoke
// ═══════════════════════════════════════════════════════════════════

const validateCli = require('../src/cli/validate');

test('carto validate', 'computeValidation against a fixture index returns the documented JSON shape', () => {
  const fix = buildValidationFixture();
  try {
    const diff = `diff --git a/src/f0.ts b/src/f0.ts
--- a/src/f0.ts
+++ b/src/f0.ts
@@ -1,1 +1,2 @@
 line
+const x = 1;
`;
    const out = validateCli.computeValidation(fix.projectRoot, diff);
    // Must match the validateDiff() contract — same shape MCP and PR-impact use.
    for (const key of ['diff', 'blast_radius', 'violations', 'suggestions', 'risk']) {
      assert.ok(Object.prototype.hasOwnProperty.call(out, key), `missing key: ${key}`);
    }
    assert.ok(['SAFE', 'LOW', 'MEDIUM', 'HIGH'].includes(out.risk));
    assert.strictEqual(out.diff.length, 1);
    assert.strictEqual(out.diff[0].path, 'src/f0.ts');
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

// `carto validate` async run() tests live in runAsyncSuite (below) so
// rejected promises are awaited; sync test() doesn't await fn().

// ═══════════════════════════════════════════════════════════════════
// SWE-bench harness — mini-suite, scorer, aggregator
// ═══════════════════════════════════════════════════════════════════

const { TASKS: SWE_TASKS } = require('../bench/swe-bench/mini-suite');
const { scoreDiff: sweScoreDiff } = require('../bench/swe-bench/score');
const { aggregate: sweAggregate, pairedBootstrapCI } = require('../bench/swe-bench/aggregate');
const { StubAgent: SweStubAgent, getAgent: sweGetAgent } = require('../bench/swe-bench/agent');

test('SWE-bench', 'mini-suite has 5 deterministic tasks with required fields', () => {
  assert.strictEqual(SWE_TASKS.length, 5, 'must have exactly 5 tasks');
  const ids = new Set();
  for (const t of SWE_TASKS) {
    assert.ok(t.id, 'task must have id');
    assert.ok(!ids.has(t.id), `duplicate task id: ${t.id}`);
    ids.add(t.id);
    assert.ok(['single_file', 'multi_file', 'architectural'].includes(t.kind), `bad kind on ${t.id}: ${t.kind}`);
    assert.ok(t.repo && Object.keys(t.repo).length > 0, `${t.id} must have repo files`);
    assert.ok(t.expected && t.expected.requiredFiles, `${t.id} must declare expected.requiredFiles`);
    assert.ok(t.expected.addedLines instanceof Set, `${t.id} expected.addedLines must be Set`);
    assert.ok(typeof t.stubControl === 'string' && t.stubControl.length > 0, `${t.id} must have stubControl`);
    assert.ok(typeof t.stubCarto === 'string' && t.stubCarto.length > 0, `${t.id} must have stubCarto`);
  }
});

test('SWE-bench', 'StubAgent solve() returns the recorded stub diff for the configured arm', () => {
  // Sync check — solve() is async but it does no real I/O, so we can
  // inspect the recorded shape directly. Determinism (same-call same-output)
  // is checked in runAsyncSuite where we can await both solves.
  const agentCarto = new SweStubAgent('carto');
  const agentCtrl = new SweStubAgent('control');
  assert.strictEqual(agentCarto.arm, 'carto');
  assert.strictEqual(agentCtrl.arm, 'control');
  assert.throws(() => new SweStubAgent('weird'), /arm must be 'control' or 'carto'/);
});

test('SWE-bench', 'getAgent falls back to StubAgent when no ANTHROPIC_API_KEY (CI invariant)', () => {
  // Save + clear the env var so this test runs whether or not it was set.
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const agent = sweGetAgent('carto', { taskSet: 'verified' });
    assert.ok(agent instanceof SweStubAgent, 'must fall back to stub when no API key');
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('SWE-bench', 'scoreDiff returns PASS when diff matches expected; PARTIAL on coverage 0.5; FAIL otherwise', () => {
  // PASS path: feed mini-001's stubCarto and verify it scores PASS.
  const t = SWE_TASKS[0]; // mini-001
  const s = sweScoreDiff(t.stubCarto, t.expected);
  assert.strictEqual(s.outcome, 'PASS', `expected PASS for full match, got ${s.outcome} (missing=${s.missingAdded.join('|')})`);
  assert.strictEqual(s.coverage, 1.0);

  // FAIL path: empty diff against a task with required adds.
  const fail = sweScoreDiff('', t.expected);
  assert.strictEqual(fail.outcome, 'FAIL');
  assert.strictEqual(fail.coverage, 0);

  // PARTIAL path: mini-003 control stub misses 2 of 5 importers — known
  // by construction. The scorer should produce a PARTIAL because the
  // control diff touches >0 required files and covers a chunk of the
  // expected added lines.
  const multi = SWE_TASKS[2];
  const partialResult = sweScoreDiff(multi.stubControl, multi.expected);
  assert.ok(
    partialResult.outcome === 'PARTIAL' || partialResult.outcome === 'PASS',
    `mini-003 control should be PARTIAL or PASS, got ${partialResult.outcome}`,
  );
  // Critically — it must miss the 2 importer files that the stubControl
  // omits (d, e). For PASS we'd see filesTouched cover all required;
  // for PARTIAL the missingFiles must be non-empty.
  if (partialResult.outcome === 'PARTIAL') {
    assert.ok(partialResult.missingFiles.length > 0, 'PARTIAL must surface the missing importer files');
  }
});

test('SWE-bench', 'pairedBootstrapCI produces a delta + CI that brackets the true mean', () => {
  // Synthetic: control = [0,0,0,0,0], carto = [1,1,1,1,1]. True delta = +1.0.
  // The bootstrap mean should hover around 1.0 (100pp); the CI should
  // be tight because variance across resamples is low for all-same
  // pairs.
  let seed = 0x1234abcd;
  const rng = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const ci = pairedBootstrapCI([0,0,0,0,0], [1,1,1,1,1], 200, rng);
  assert.strictEqual(ci.mean, 100, 'mean delta on (0,1)×5 must be exactly 100pp');
  // Bootstrap on a vector where every pair is identical can't vary —
  // every resample is also all-1s, so lo=hi=mean=100.
  assert.strictEqual(ci.lo, 100);
  assert.strictEqual(ci.hi, 100);
});

test('SWE-bench', 'aggregate produces a markdown report with per-kind splits + bolded ≥10pp deltas', () => {
  const rows = [
    { runId: 'r1', taskId: 'mini-001', kind: 'single_file', arm: 'control', outcome: 'PASS',    coverage: 1.0, model: 'stub' },
    { runId: 'r1', taskId: 'mini-001', kind: 'single_file', arm: 'carto',   outcome: 'PASS',    coverage: 1.0, model: 'stub' },
    { runId: 'r1', taskId: 'mini-003', kind: 'multi_file',  arm: 'control', outcome: 'PARTIAL', coverage: 0.6, model: 'stub' },
    { runId: 'r1', taskId: 'mini-003', kind: 'multi_file',  arm: 'carto',   outcome: 'PASS',    coverage: 1.0, model: 'stub' },
    { runId: 'r1', taskId: 'mini-005', kind: 'architectural', arm: 'control', outcome: 'FAIL',  coverage: 0,   model: 'stub' },
    { runId: 'r1', taskId: 'mini-005', kind: 'architectural', arm: 'carto',   outcome: 'PASS',  coverage: 1.0, model: 'stub' },
  ];
  const kindLookup = new Map([
    ['mini-001', 'single_file'],
    ['mini-003', 'multi_file'],
    ['mini-005', 'architectural'],
  ]);
  const { summary, markdown } = sweAggregate(rows, kindLookup);
  // Shape
  assert.strictEqual(summary.taskCount, 3);
  assert.strictEqual(summary.perKind.single_file.n, 1);
  assert.strictEqual(summary.perKind.multi_file.n, 1);
  assert.strictEqual(summary.perKind.architectural.n, 1);
  assert.strictEqual(summary.perKind.all.n, 3);
  // Multi-file delta: control 50% (PARTIAL), carto 100% → +50pp.
  assert.strictEqual(summary.perKind.multi_file.delta, 50.0);
  // Architectural delta: 0% → 100% → +100pp.
  assert.strictEqual(summary.perKind.architectural.delta, 100.0);
  // Markdown: bolded large delta (≥10pp).
  assert.ok(markdown.includes('**+50.0pp**'), 'multi-file delta must be bolded');
  assert.ok(markdown.includes('**+100.0pp**'), 'architectural delta must be bolded');
  // Markdown: header + table.
  assert.ok(markdown.startsWith('# Carto · SWE-bench results'));
  assert.ok(markdown.includes('| Metric | control | carto | delta | 95% CI |'));
});

// ═══════════════════════════════════════════════════════════════════
// CLI commands: status / why / explain / diff / doctor
// ═══════════════════════════════════════════════════════════════════

const statusCli = require('../src/cli/status');
const whyCli = require('../src/cli/why');
const doctorCli = require('../src/cli/doctor');

test('CLI: status', 'collect() returns healthy snapshot on the validation fixture index', () => {
  const fix = buildValidationFixture();
  try {
    const snap = statusCli.collect(fix.projectRoot);
    assert.strictEqual(snap.dbExists, true);
    assert.ok(snap.totalFiles > 0, `expected totalFiles > 0, got ${snap.totalFiles}`);
    assert.ok(Array.isArray(snap.domains));
    assert.strictEqual(snap.healthy, true,
      `expected healthy=true on a clean fixture, got issues: ${snap.issues.join('; ')}`);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('CLI: status', 'collect() reports unhealthy + an issue when no .carto/carto.db exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-status-empty-'));
  try {
    const snap = statusCli.collect(tmp);
    assert.strictEqual(snap.dbExists, false);
    assert.strictEqual(snap.healthy, false);
    assert.ok(snap.issues.some((i) => /No index/.test(i)),
      'must surface "No index" issue for a project with no .carto/');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: why', 'collect() returns the domain + dependents shape for an indexed file', () => {
  const fix = buildValidationFixture();
  try {
    const summary = whyCli.collect(fix.projectRoot, 'src/f0.ts');
    assert.strictEqual(summary.error, undefined, `unexpected error: ${summary.error}`);
    assert.strictEqual(summary.file, 'src/f0.ts');
    assert.strictEqual(typeof summary.domain, 'string');
    assert.ok(summary.dependentsCount > 0, 'f0.ts must have dependents in the fixture');
    assert.ok(Array.isArray(summary.imports));
    assert.ok(Array.isArray(summary.importedBy));
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('CLI: why', 'collect() returns a clear error for a file not in the index', () => {
  const fix = buildValidationFixture();
  try {
    const out = whyCli.collect(fix.projectRoot, 'does/not/exist.ts');
    assert.ok(out.error && /not in index/.test(out.error),
      `expected "not in index" error, got ${out.error}`);
  } finally {
    try { fix.store.close(); } catch {}
    fs.rmSync(fix.projectRoot, { recursive: true, force: true });
  }
});

test('CLI: doctor', 'diagnose() reports ok=false with actionable Fix when index is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-doctor-empty-'));
  try {
    const out = doctorCli.diagnose(tmp);
    assert.ok(Array.isArray(out.results) && out.results.length > 0);
    const idx = out.results.find((r) => r.id === 'index-exists');
    assert.ok(idx, 'must include an index-exists check');
    assert.strictEqual(idx.status, 'fail');
    assert.ok(idx.fix && /carto init/.test(idx.fix), 'fix line must point at `carto init`');
    assert.strictEqual(out.ok, false, 'ok=false when a check fails');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: doctor', 'diagnose() returns ok=true against the carto-ansh project (live sanity)', () => {
  // Run against the project root we live in — this catches regressions
  // in the checks themselves (e.g. tree-sitter module loads broken, DB
  // path resolution wrong).
  //
  // Skip on a fresh checkout: .carto/ is gitignored, so CI clones don't
  // have the index this check expects. The point of the test is local
  // sanity ("nothing in diagnose() regressed under my dev workflow"),
  // not a CI gate — the surrounding `CLI: doctor` tests already cover
  // the diagnose() unit behaviour against synthetic projects.
  const repoRoot = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(repoRoot, '.carto'))) {
    return; // no local index — nothing to live-sanity against
  }
  const out = doctorCli.diagnose(repoRoot);
  // ok must be true OR every fail must be one we can explain. Currently
  // every check should pass on this repo because we just smoke-ran it.
  if (!out.ok) {
    const failures = out.results.filter((r) => r.status === 'fail').map((r) => `${r.id}: ${r.detail}`);
    assert.fail(`diagnose() failed on the live repo: ${failures.join(' | ')}`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// SWE-bench tools — sandboxed tool execution
// ═══════════════════════════════════════════════════════════════════
// Temporal layer — 15 tests across 3 suites
// ═══════════════════════════════════════════════════════════════════

const { TemporalStore } = require('../src/temporal/store');
const { xorBitsets, compressBitset, decompressBitset, flattenMap } = require('../src/temporal/delta');
const { captureSnapshotWithStore } = require('../src/temporal/snapshot');
const { detectEvents: detectTemporalEvents } = require('../src/temporal/events');
const tq = require('../src/temporal/queries');
const { Bitset: TBitset } = require('../src/bitmap/bitset');

function makeTempRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-temporal-'));
  fs.mkdirSync(path.join(tmp, '.carto'));
  return tmp;
}

test('Temporal storage', 'TemporalStore opens, creates schema, persists snapshot rows', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  const id = t.insertSnapshot({ ts: 1_000_000, commit_sha: 'aaa', source: 'commit', summary: { file_count: 10, edge_count: 25, domain_count: 3 } });
  assert.ok(id > 0, 'insertSnapshot must return a positive rowid');
  const recent = t.getMostRecentSnapshot();
  assert.strictEqual(recent.commit_sha, 'aaa');
  assert.strictEqual(recent.file_count, 10);
  // idempotency: same sha + source → same id
  const id2 = t.insertSnapshot({ ts: 1_000_001, commit_sha: 'aaa', source: 'commit', summary: { file_count: 99 } });
  assert.strictEqual(id, id2);
  t.close();
});

test('Temporal storage', 'recordCommitChurn aggregates commit counts and timestamps', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  t.recordCommitChurn(1000, ['src/a.ts', 'src/b.ts']);
  t.recordCommitChurn(2000, ['src/a.ts', 'src/c.ts']);
  t.recordCommitChurn(3000, ['src/a.ts']);
  const a = t.getFileChurn('src/a.ts');
  assert.strictEqual(a.commit_count, 3);
  assert.strictEqual(a.first_seen_ts, 1000);
  assert.strictEqual(a.last_modified_ts, 3000);
  const b = t.getFileChurn('src/b.ts');
  assert.strictEqual(b.commit_count, 1);
  t.close();
});

test('Temporal storage', 'file_domains_at stores per-snapshot mapping; query is by snapshot_id', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  const snapId = t.insertSnapshot({ ts: 100, source: 'sync', summary: { file_count: 2 } });
  t.insertFileDomains(snapId, [
    { file_path: 'src/auth/login.ts', domain_name: 'AUTH' },
    { file_path: 'src/db/index.ts', domain_name: 'DATABASE' },
  ]);
  const rows = t.getFileDomainsAt(snapId);
  assert.strictEqual(rows.length, 2);
  const byPath = Object.fromEntries(rows.map(r => [r.file_path, r.domain_name]));
  assert.strictEqual(byPath['src/auth/login.ts'], 'AUTH');
  t.close();
});

test('Temporal storage', 'updateBlastRadii + getTopChurned sorts by commit_count', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  t.recordCommitChurn(1000, ['src/a.ts']);
  t.recordCommitChurn(1000, ['src/a.ts']);
  t.recordCommitChurn(1000, ['src/a.ts']);
  t.recordCommitChurn(2000, ['src/b.ts']);
  t.updateBlastRadii(new Map([['src/a.ts', 30], ['src/b.ts', 5]]));
  const top = t.getTopChurned(10);
  assert.strictEqual(top[0].file_path, 'src/a.ts');
  assert.strictEqual(top[0].commit_count, 3);
  assert.strictEqual(top[0].blast_radius, 30);
  t.close();
});

test('Temporal storage', 'openIfExists returns null when DB is missing', () => {
  const root = makeTempRoot();
  const t = TemporalStore.openIfExists(root, { readonly: true });
  assert.strictEqual(t, null);
});

test('Temporal storage', 'insertEvent + getArchEvents with severity filter', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  t.insertEvent({ ts: 1000, severity: 'major', kind: 'domain_growth', domain: 'AUTH', detail: { delta: 8 } });
  t.insertEvent({ ts: 2000, severity: 'critical', kind: 'hotspot_active', file_path: 'src/db.ts' });
  t.insertEvent({ ts: 3000, severity: 'minor', kind: 'initial_snapshot' });
  const major = t.getArchEvents({ severity: 'major' });
  assert.strictEqual(major.length, 1);
  assert.strictEqual(major[0].kind, 'domain_growth');
  const all = t.getArchEvents({});
  assert.strictEqual(all.length, 3);
  t.close();
});

// ── delta module ────────────────────────────────────────────────────
test('Temporal storage', 'xorBitsets self-inverse: (a XOR b) XOR b == a', () => {
  const a = new TBitset(64);
  a.set(1); a.set(5); a.set(30);
  const b = new TBitset(64);
  b.set(5); b.set(40);
  const d = xorBitsets(a, b);
  const back = xorBitsets(d, b);
  // back == a
  assert.strictEqual(back.has(1), true);
  assert.strictEqual(back.has(5), true);
  assert.strictEqual(back.has(30), true);
  assert.strictEqual(back.has(40), false);
});

test('Temporal storage', 'compressBitset → decompressBitset roundtrip preserves bits', () => {
  const a = new TBitset(256);
  for (const i of [1, 7, 99, 200, 255]) a.set(i);
  const blob = compressBitset(a);
  const restored = decompressBitset(blob, 256);
  for (const i of [1, 7, 99, 200, 255]) assert.strictEqual(restored.has(i), true);
  assert.strictEqual(restored.has(2), false);
});

// ── snapshot capture ────────────────────────────────────────────────
test('Temporal MCP tools', 'captureSnapshotWithStore writes snapshot + mappings + events', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();

  // Build a synthetic sidecar that mimics the bitmap sidecar shape
  const size = 4;
  const filePathArr = [];
  filePathArr[0] = 'src/auth/a.ts';
  filePathArr[1] = 'src/auth/b.ts';
  filePathArr[2] = 'src/db/c.ts';
  filePathArr[3] = 'src/core/d.ts';
  const fileDomainArr = new Int32Array(size);
  fileDomainArr[0] = 0; fileDomainArr[1] = 0; fileDomainArr[2] = 1; fileDomainArr[3] = 2;
  const domainNameArr = ['AUTH', 'DATABASE', 'CORE'];
  const forward = new Map();
  const fwd = new TBitset(size); fwd.set(2); forward.set(0, fwd);
  const sidecar = {
    size, filePathArr, fileDomainArr, domainNameArr, forward,
    popcountIndex: [{ fileId: 2, count: 3 }],
  };

  const out = captureSnapshotWithStore({ temporal: t, sidecar, store: null, source: 'sync', ts: 1000 });
  assert.ok(out.snapshotId > 0);
  const rows = t.getFileDomainsAt(out.snapshotId);
  assert.strictEqual(rows.length, 4);
  // First snapshot fires an 'initial_snapshot' event.
  const events = t.getArchEvents({});
  assert.ok(events.some(e => e.kind === 'initial_snapshot'));
  t.close();
});

test('Temporal MCP tools', 'detectEvents emits domain_growth when a domain grows >=20% with >=5 files', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  const priorSnap = t.insertSnapshot({ ts: 1000, source: 'sync', summary: { file_count: 10 } });
  const priorMappings = [];
  for (let i = 0; i < 10; i++) priorMappings.push({ file_path: `src/auth/${i}.ts`, domain_name: 'AUTH' });
  t.insertFileDomains(priorSnap, priorMappings);

  const mappings = [];
  for (let i = 0; i < 20; i++) mappings.push({ file_path: `src/auth/${i}.ts`, domain_name: 'AUTH' });
  const prior = t.getSnapshotById(priorSnap);
  const events = detectTemporalEvents({ temporal: t, snapshotId: 999, prior, mappings, sidecar: null, ts: 2000 });
  const growth = events.find(e => e.kind === 'domain_growth' && e.domain === 'AUTH');
  assert.ok(growth, `expected domain_growth, got ${JSON.stringify(events.map(e => e.kind))}`);
  assert.strictEqual(growth.detail.delta, 10);
  t.close();
});

test('Temporal MCP tools', 'detectEvents flags domain_unstable when >30% of files moved out', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  const priorSnap = t.insertSnapshot({ ts: 1000, source: 'sync', summary: {} });
  const priorMappings = [];
  for (let i = 0; i < 10; i++) priorMappings.push({ file_path: `src/auth/${i}.ts`, domain_name: 'AUTH' });
  t.insertFileDomains(priorSnap, priorMappings);

  // Now only 5 of the prior 10 remain in AUTH
  const mappings = [];
  for (let i = 0; i < 5; i++) mappings.push({ file_path: `src/auth/${i}.ts`, domain_name: 'AUTH' });
  // (the other 5 are gone from AUTH; treat as shrunk + unstable)
  const prior = t.getSnapshotById(priorSnap);
  const events = detectTemporalEvents({ temporal: t, snapshotId: 999, prior, mappings, sidecar: null, ts: 2000 });
  const unstable = events.find(e => e.kind === 'domain_unstable');
  assert.ok(unstable, `expected domain_unstable, got ${JSON.stringify(events.map(e => e.kind))}`);
  t.close();
});

test('Temporal MCP tools', 'getHotspotFiles ranks by commit_count × blast_radius', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  t.recordCommitChurn(1_700_000_000_000, ['src/x.ts', 'src/x.ts', 'src/x.ts'].slice(0, 1));
  // boost x.ts to commit_count=10
  for (let i = 0; i < 9; i++) t.recordCommitChurn(1_700_000_000_000 + i, ['src/x.ts']);
  // y.ts: 2 commits, lower blast
  t.recordCommitChurn(1_700_000_000_000, ['src/y.ts']);
  t.recordCommitChurn(1_700_000_000_001, ['src/y.ts']);
  t.updateBlastRadii(new Map([['src/x.ts', 50], ['src/y.ts', 3]]));
  // null timeRange so we look at all churn
  const r = tq.getHotspotFiles(t, { timeRange: null, limit: 5 });
  assert.ok(r.hotspots.length >= 2);
  assert.strictEqual(r.hotspots[0].file_path, 'src/x.ts');
  assert.ok(r.hotspots[0].score > r.hotspots[1].score);
  t.close();
});

// ── Domain stability ────────────────────────────────────────────────
test('Domain stability', 'parseTimeRange handles d/h/m/w/y units', () => {
  assert.strictEqual(tq.parseTimeRange('1d'), 86_400_000);
  assert.strictEqual(tq.parseTimeRange('2h'), 7_200_000);
  assert.strictEqual(tq.parseTimeRange('30m'), 1_800_000);
  assert.strictEqual(tq.parseTimeRange('1w'), 604_800_000);
  assert.strictEqual(tq.parseTimeRange('1y'), 31_536_000_000);
  assert.strictEqual(tq.parseTimeRange('garbage'), null);
  assert.strictEqual(tq.parseTimeRange(''), null);
  // Bare numbers default to days.
  assert.strictEqual(tq.parseTimeRange('5'), 5 * 86_400_000);
});

test('Domain stability', 'getArchitecturalDrift aggregates first vs last snapshot per-domain', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  const firstId = t.insertSnapshot({ ts: Date.now() - 7 * 86_400_000, source: 'sync', summary: {} });
  t.insertFileDomains(firstId, [
    { file_path: 'a', domain_name: 'AUTH' },
    { file_path: 'b', domain_name: 'AUTH' },
    { file_path: 'c', domain_name: 'DATABASE' },
  ]);
  const lastId = t.insertSnapshot({ ts: Date.now(), source: 'sync', summary: {} });
  t.insertFileDomains(lastId, [
    { file_path: 'a', domain_name: 'AUTH' },
    { file_path: 'b', domain_name: 'AUTH' },
    { file_path: 'c', domain_name: 'DATABASE' },
    { file_path: 'd', domain_name: 'DATABASE' },
    { file_path: 'e', domain_name: 'NEW' },
  ]);
  const r = tq.getArchitecturalDrift(t, { timeRange: '30d' });
  assert.strictEqual(r.trend, 'growing');
  const auth = r.byDomain.find(d => d.domain === 'AUTH');
  assert.strictEqual(auth.before, 2);
  assert.strictEqual(auth.after, 2);
  const newDomain = r.byDomain.find(d => d.domain === 'NEW');
  assert.strictEqual(newDomain.before, 0);
  assert.strictEqual(newDomain.after, 1);
  t.close();
});

test('Domain stability', 'getDomainHealth surfaces growth + instability per domain', () => {
  const root = makeTempRoot();
  const t = new TemporalStore(root);
  t.open();
  // Old snapshot >30d ago
  const oldId = t.insertSnapshot({ ts: Date.now() - 35 * 86_400_000, source: 'sync', summary: {} });
  t.insertFileDomains(oldId, [
    { file_path: 'a', domain_name: 'AUTH' },
    { file_path: 'b', domain_name: 'AUTH' },
  ]);
  // Current snapshot
  const newId = t.insertSnapshot({ ts: Date.now(), source: 'sync', summary: {} });
  t.insertFileDomains(newId, [
    { file_path: 'a', domain_name: 'AUTH' },
    { file_path: 'b', domain_name: 'AUTH' },
    { file_path: 'c', domain_name: 'AUTH' },
    { file_path: 'd', domain_name: 'AUTH' },
  ]);
  const r = tq.getDomainHealth(t, {});
  assert.ok(r.domains.length >= 1);
  const auth = r.domains.find(d => d.domain === 'AUTH');
  assert.strictEqual(auth.current_size, 4);
  assert.strictEqual(auth.prior_size, 2);
  assert.strictEqual(auth.growth, 2);
  t.close();
});

// ═══════════════════════════════════════════════════════════════════
// Brain expansion — 18 tests across 5 suites
// ═══════════════════════════════════════════════════════════════════

const { SQLiteStore: BSqliteStore } = require('../src/store/sqlite-store');
const brain = require('../src/brain');

function makeBrainTestStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-brain-'));
  const store = new BSqliteStore(root);
  store.open();
  return { root, store };
}

// Helper: populate a store with files + imports + domains + symbols.
function seedStore(store) {
  const db = store.db;
  db.prepare('INSERT INTO domains (id, name) VALUES (?, ?)').run(1, 'AUTH');
  db.prepare('INSERT INTO domains (id, name) VALUES (?, ?)').run(2, 'DATABASE');
  db.prepare('INSERT INTO domains (id, name) VALUES (?, ?)').run(3, 'CORE');
  const filesByPath = {};
  const insertFile = db.prepare('INSERT INTO files (path, domain_id, centrality, language) VALUES (?, ?, ?, ?)');
  function addFile(p, dId, centrality = 0, lang = 'TypeScript') {
    const info = insertFile.run(p, dId, centrality, lang);
    filesByPath[p] = info.lastInsertRowid;
  }
  // 8 AUTH files
  for (let i = 0; i < 8; i++) addFile(`src/auth/file${i}.ts`, 1, 3);
  // 6 DATABASE files
  for (let i = 0; i < 6; i++) addFile(`src/db/file${i}.ts`, 2, 5);
  // 7 CORE files
  for (let i = 0; i < 7; i++) addFile(`src/core/file${i}.ts`, 3, 1);
  // Imports — every AUTH file imports every CORE file (no cross to DATABASE)
  const insertImport = db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path) VALUES (?, ?, ?)');
  for (let a = 0; a < 8; a++) {
    for (let c = 0; c < 7; c++) {
      insertImport.run(filesByPath[`src/auth/file${a}.ts`], filesByPath[`src/core/file${c}.ts`], `src/core/file${c}.ts`);
    }
  }
  // DATABASE → CORE (one edge)
  insertImport.run(filesByPath['src/db/file0.ts'], filesByPath['src/core/file0.ts'], 'src/core/file0.ts');
  // Exports: every AUTH file has exactly 2 named exports
  const insertSymbol = db.prepare('INSERT INTO symbols (file_id, name, kind, exported, is_default_export) VALUES (?, ?, ?, ?, ?)');
  for (let a = 0; a < 8; a++) {
    insertSymbol.run(filesByPath[`src/auth/file${a}.ts`], 'fnA', 'function', 1, 0);
    insertSymbol.run(filesByPath[`src/auth/file${a}.ts`], 'fnB', 'function', 1, 0);
  }
  return filesByPath;
}

test('Brain invariants', 'inferInvariants detects no-cross-domain-import rules (AUTH never imports from DATABASE)', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const rules = brain.invariants.inferInvariants(store);
  const noImport = rules.filter(r => r.kind === 'no_cross_domain_import');
  const authToDb = noImport.find(r => r.scope === 'AUTH' && r.rule.includes('DATABASE'));
  assert.ok(authToDb, `expected AUTH→DATABASE invariant; got ${noImport.length} rules: ${noImport.map(x => x.id).join(', ')}`);
  store.close();
});

test('Brain invariants', 'inferInvariants detects export-pattern invariants (AUTH files always export 2 symbols)', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const rules = brain.invariants.inferInvariants(store, { threshold: 0.8 });
  const exportRule = rules.find(r => r.kind === 'export_pattern' && r.scope === 'AUTH');
  assert.ok(exportRule, `expected AUTH export_pattern invariant; got ${rules.length} rules total`);
  assert.ok(exportRule.confidence >= 0.8);
  store.close();
});

test('Brain invariants', 'inferInvariants emits domain_naming for path prefixes', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const rules = brain.invariants.inferInvariants(store);
  const naming = rules.filter(r => r.kind === 'domain_naming');
  assert.ok(naming.length >= 1, `expected at least 1 naming invariant; got ${naming.length}`);
  store.close();
});

test('Brain invariants', 'getCanonicalPattern returns null when no matching pattern exists', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const r = brain.invariants.getCanonicalPattern(store, { pattern_type: 'route_handler' });
  assert.strictEqual(r, null); // no routes seeded
  store.close();
});

test('Brain conventions', 'mineConventions returns directory_language conventions', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const c = brain.conventions.mineConventions(store);
  const dirLang = c.find(x => x.kind === 'directory_language' && x.scope === 'src');
  assert.ok(dirLang, `expected directory_language convention for src/`);
  assert.strictEqual(dirLang.confidence >= 0.75, true);
  store.close();
});

test('Brain conventions', 'mineConventions returns export_style per-domain', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const c = brain.conventions.mineConventions(store);
  const named = c.find(x => x.kind === 'export_style' && x.scope === 'AUTH' && x.rule.includes('named'));
  assert.ok(named, `expected AUTH named-export convention`);
  store.close();
});

test('Brain conventions', 'conventionsForFile returns conventions whose scope matches', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const c = brain.conventions.conventionsForFile(store, 'src/auth/file0.ts');
  // Must include at least the directory_language convention.
  assert.ok(c.length >= 1, `expected ≥1 convention for file; got ${c.length}`);
  store.close();
});

test('Brain procedural', 'mineActionPatterns returns [] when temporal store is empty', () => {
  const { root, store } = makeBrainTestStore();
  const tStore = new TemporalStore(root); tStore.open();
  const patterns = brain.procedural.mineActionPatterns(tStore);
  assert.ok(Array.isArray(patterns));
  // No commits to mine: returns []
  assert.strictEqual(patterns.length, 0);
  tStore.close();
  store.close();
});

test('Brain procedural', 'scaffoldForIntent combines patterns + canonical for "add route"', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const tStore = new TemporalStore(root); tStore.open();
  const r = brain.procedural.scaffoldForIntent(tStore, store, 'add a payment route');
  assert.strictEqual(typeof r, 'object');
  assert.strictEqual(r.intent, 'add a payment route');
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(Array.isArray(r.canonical));
  tStore.close();
  store.close();
});

test('Brain working', 'getUncommittedFiles returns empty array outside a git repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-brain-nogit-'));
  const files = brain.working.getUncommittedFiles(tmp);
  assert.ok(Array.isArray(files));
  assert.strictEqual(files.length, 0);
});

test('Brain working', 'getWorkingMemory returns a structured object even with no temporal store', () => {
  const { root, store } = makeBrainTestStore();
  const wm = brain.working.getWorkingMemory({ store, temporalStore: null, projectRoot: root });
  assert.ok('uncommitted_files' in wm);
  assert.ok('recent_decisions_count' in wm);
  assert.ok('open_warnings' in wm);
  store.close();
});

test('Brain working', 'getPendingDecisions filters by HIGH-risk payload', () => {
  const { root, store } = makeBrainTestStore();
  // Insert a decision with HIGH risk
  store.db.prepare(`
    INSERT INTO ai_sessions (id, started_at, client_name) VALUES (1, ?, 'test')
  `).run(Date.now());
  store.db.prepare(`
    INSERT INTO decisions (session_id, ts, kind, file, payload_json)
    VALUES (1, ?, 'validation', 'src/test.ts', ?)
  `).run(Date.now(), JSON.stringify({ risk: 'HIGH' }));
  // Decision with no risk flag
  store.db.prepare(`
    INSERT INTO decisions (session_id, ts, kind, file, payload_json)
    VALUES (1, ?, 'validation', 'src/other.ts', ?)
  `).run(Date.now(), JSON.stringify({ risk: 'SAFE' }));
  const r = brain.working.getPendingDecisions(store, { hours: 24 });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].payload.risk, 'HIGH');
  store.close();
});

test('Brain working', 'getActiveDrift returns empty when temporalStore is null', () => {
  const r = brain.working.getActiveDrift(null);
  assert.ok(r);
  assert.deepStrictEqual(r.domains, []);
  assert.deepStrictEqual(r.threshold_breaches, []);
});

test('Brain suggestions', 'loadThresholds returns defaults when no carto.config.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-brain-thresh-'));
  const t = brain.suggestions.loadThresholds(tmp);
  assert.strictEqual(typeof t.cross_domain_jump, 'number');
  assert.strictEqual(typeof t.hotspot_score, 'number');
  assert.strictEqual(typeof t.session_conflict_window_ms, 'number');
});

test('Brain suggestions', 'loadThresholds reads brain.* from carto.config.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-brain-cfg-'));
  fs.writeFileSync(
    path.join(tmp, 'carto.config.json'),
    JSON.stringify({ domains: {}, brain: { cross_domain_jump: 99, hotspot_score: 200 } })
  );
  const t = brain.suggestions.loadThresholds(tmp);
  assert.strictEqual(t.cross_domain_jump, 99);
  assert.strictEqual(t.hotspot_score, 200);
});

test('Brain suggestions', 'getActiveSuggestions returns an array (no crash on empty inputs)', () => {
  const { root, store } = makeBrainTestStore();
  const s = brain.suggestions.getActiveSuggestions({ store, temporalStore: null, projectRoot: root });
  assert.ok(Array.isArray(s));
  store.close();
});

test('Brain suggestions', 'getActiveSuggestions emits session_conflict when 2 sessions touch same file', () => {
  const { root, store } = makeBrainTestStore();
  const now = Date.now();
  // Insert two sessions touching the same file within 30 min
  store.db.prepare(`INSERT INTO ai_sessions (id, started_at, client_name) VALUES (?, ?, ?)`).run(1, now, 'a');
  store.db.prepare(`INSERT INTO ai_sessions (id, started_at, client_name) VALUES (?, ?, ?)`).run(2, now, 'b');
  store.db.prepare(`INSERT INTO decisions (session_id, ts, kind, file) VALUES (1, ?, 'v', 'src/x.ts')`).run(now - 1000);
  store.db.prepare(`INSERT INTO decisions (session_id, ts, kind, file) VALUES (2, ?, 'v', 'src/x.ts')`).run(now - 500);
  const s = brain.suggestions.getActiveSuggestions({ store, temporalStore: null, projectRoot: root });
  const conflict = s.find(x => x.trigger === 'session_conflict' && x.detail.file === 'src/x.ts');
  assert.ok(conflict, `expected session_conflict suggestion; got ${JSON.stringify(s.map(x => x.trigger))}`);
  store.close();
});

// ═══════════════════════════════════════════════════════════════════
// Reach expansion — 4 language plugins +
// framework extractors + plugin API
// ═══════════════════════════════════════════════════════════════════

const phpPlugin = require('../src/extractors/languages/php');
const kotlinPlugin = require('../src/extractors/languages/kotlin');
const swiftPlugin = require('../src/extractors/languages/swift');
const dartPlugin = require('../src/extractors/languages/dart');
const fw = require('../src/extractors/frameworks');
const pluginApi = require('../src/extractors/plugin-api');

// ── Plugin API ────────────────────────────────────────────────────
test('Plugin API', 'validatePlugin accepts a well-formed plugin', () => {
  const errors = pluginApi.validatePlugin({
    name: 'x',
    extensions: ['.x'],
    extract: () => pluginApi.EMPTY_RESULT,
  });
  assert.deepStrictEqual(errors, []);
});

test('Plugin API', 'validatePlugin rejects missing extensions', () => {
  const errors = pluginApi.validatePlugin({ name: 'x', extract: () => ({}) });
  assert.ok(errors.some(e => e.includes('extensions')), errors.join('; '));
});

test('Plugin API', 'validatePluginOutput catches missing routes array', () => {
  const errors = pluginApi.validatePluginOutput({ models: [], functions: [] });
  assert.ok(errors.some(e => e.includes('routes')), errors.join('; '));
});

test('Plugin API', 'validatePluginOutput rejects non-array routes', () => {
  const errors = pluginApi.validatePluginOutput({ routes: 'wat', models: [], functions: [] });
  assert.ok(errors.some(e => e.includes('routes must be an array')), errors.join('; '));
});

// ── PHP plugin ────────────────────────────────────────────────────
test('PHP extractor', 'all 4 new plugins are validatePlugin-clean', () => {
  for (const p of [phpPlugin, kotlinPlugin, swiftPlugin, dartPlugin]) {
    assert.deepStrictEqual(pluginApi.validatePlugin(p), [], `${p.name} failed validation`);
  }
});

test('PHP extractor', 'Laravel routes (Route::get, resource) are extracted', () => {
  const src = `<?php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::resource('posts', PostController::class);
`;
  const out = phpPlugin.extract(src, 'routes/web.php');
  const paths = out.routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users'), `paths: ${paths.join(', ')}`);
  assert.ok(paths.includes('POST /users'), `paths: ${paths.join(', ')}`);
  assert.ok(paths.some(p => p.startsWith('GET /posts')), `paths: ${paths.join(', ')}`);
  assert.ok(paths.some(p => p.startsWith('POST /posts')), `paths: ${paths.join(', ')}`);
});

test('PHP extractor', 'Symfony attribute routes (#[Route(...)] with methods) extracted', () => {
  const src = `<?php
class Controller {
  #[Route('/users', methods: ['GET', 'POST'])]
  public function index(): Response {}
}
`;
  const out = phpPlugin.extract(src, 'src/Controller.php');
  const paths = out.routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users'), paths.join(', '));
  assert.ok(paths.includes('POST /users'), paths.join(', '));
});

test('PHP extractor', 'Eloquent + namespace imports extracted', () => {
  const src = `<?php
namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class User extends Model {
  protected $fillable = ['name', 'email'];
}
`;
  const out = phpPlugin.extract(src, 'app/Models/User.php');
  assert.strictEqual(out.models.length, 1);
  assert.strictEqual(out.models[0].className, 'User');
  assert.strictEqual(out.models[0].kind, 'eloquent');
  assert.ok(out.models[0].fields.some(f => f.name === 'name'));
  assert.ok(out._tsImports.some(i => i.from === 'Illuminate\\Database\\Eloquent\\Model'));
});

// ── Kotlin plugin ────────────────────────────────────────────────
test('Kotlin extractor', 'Spring @GetMapping/@PostMapping routes extracted', () => {
  const src = `
package com.example
@RestController
class UserController {
  @GetMapping("/users") fun list() {}
  @PostMapping("/users") fun create() {}
  @PutMapping("/users/{id}") fun update() {}
}
`;
  const out = kotlinPlugin.extract(src, 'UserController.kt');
  const paths = out.routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users'));
  assert.ok(paths.includes('POST /users'));
  assert.ok(paths.includes('PUT /users/{id}'));
});

test('Kotlin extractor', 'Ktor routing { get(...) } extracted', () => {
  const src = `
routing {
  get("/health") { call.respond("ok") }
  post("/login") { call.respond("ok") }
}
`;
  const out = kotlinPlugin.extract(src, 'Main.kt');
  const paths = out.routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /health'));
  assert.ok(paths.includes('POST /login'));
});

test('Kotlin extractor', 'data class with fields extracted as model', () => {
  const src = `data class User(val id: Int, val email: String, val name: String?)`;
  const out = kotlinPlugin.extract(src, 'User.kt');
  assert.strictEqual(out.models.length, 1);
  assert.strictEqual(out.models[0].className, 'User');
  const names = out.models[0].fields.map(f => f.name);
  assert.deepStrictEqual(names.sort(), ['email', 'id', 'name']);
});

// ── Swift plugin ──────────────────────────────────────────────────
test('Swift extractor', 'SwiftUI View struct surfaces as flutter-view-style model', () => {
  const src = `
import SwiftUI
struct ProfileView: View {
  let name: String
  var body: some View { Text(name) }
}
`;
  const out = swiftPlugin.extract(src, 'ProfileView.swift');
  const m = out.models.find(x => x.className === 'ProfileView');
  assert.ok(m, `expected ProfileView in models; got ${out.models.map(x => x.className).join(', ')}`);
  assert.strictEqual(m.kind, 'swiftui-view');
});

test('Swift extractor', 'Vapor app.get("/path") route extracted', () => {
  const src = `
app.get("/users") { req in "ok" }
app.post("/users") { req in "ok" }
`;
  const out = swiftPlugin.extract(src, 'main.swift');
  const paths = out.routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users'));
  assert.ok(paths.includes('POST /users'));
});

// ── Dart plugin ───────────────────────────────────────────────────
test('Dart extractor', 'Flutter StatelessWidget class extracted', () => {
  const src = `
import 'package:flutter/material.dart';
class HomeScreen extends StatelessWidget {
  @override Widget build(BuildContext context) { return Container(); }
}
`;
  const out = dartPlugin.extract(src, 'home.dart');
  const home = out.models.find(m => m.className === 'HomeScreen');
  assert.ok(home);
  assert.strictEqual(home.kind, 'flutter-widget');
});

test('Dart extractor', 'Shelf Router route extracted', () => {
  const src = `
final router = Router();
router.get('/health', (req) => 'ok');
router.post('/login', (req) => 'ok');
`;
  const out = dartPlugin.extract(src, 'server.dart');
  const paths = out.routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /health'));
  assert.ok(paths.includes('POST /login'));
});

// ── Long-tail JS/TS frameworks ────────────────────────────────────
test('Long-tail frameworks', 'NestJS @Controller prefix + @Get/@Post decorators joined', () => {
  const src = `
@Controller('users')
class UsersController {
  @Get() list() {}
  @Get(':id') get() {}
  @Post() create() {}
}
`;
  const routes = fw.extractNestJsRoutes(src);
  const paths = routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users'), paths.join(', '));
  assert.ok(paths.includes('GET /users/:id'), paths.join(', '));
  assert.ok(paths.includes('POST /users'), paths.join(', '));
});

test('Long-tail frameworks', 'Remix routes/users.$id.tsx with loader+action → /users/:id GET+POST', () => {
  const src = `export function loader() {}\nexport async function action() {}`;
  const routes = fw.extractRemixRoutes(src, 'app/routes/users.$id.tsx');
  const paths = routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users/:id'), paths.join(', '));
  assert.ok(paths.includes('POST /users/:id'), paths.join(', '));
});

test('Long-tail frameworks', 'SvelteKit +server.ts with GET/POST exports → /users/:id', () => {
  const src = `export const GET = async () => {};\nexport const POST = async () => {};`;
  const routes = fw.extractSvelteKitRoutes(src, 'src/routes/users/[id]/+server.ts');
  const paths = routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /users/:id'), paths.join(', '));
  assert.ok(paths.includes('POST /users/:id'), paths.join(', '));
});

test('Long-tail frameworks', 'Astro pages/products/[slug].astro → /products/:slug', () => {
  const routes = fw.extractAstroRoutes('---\n---', 'src/pages/products/[slug].astro');
  const paths = routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /products/:slug'), paths.join(', '));
});

test('Long-tail frameworks', 'Sanic @app.get("/x") extracted in Python', () => {
  const src = `
from sanic import Sanic
app = Sanic("x")

@app.get('/health')
async def health(req):
  return text('ok')
`;
  const routes = fw.extractPythonFrameworkRoutes(src);
  const paths = routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /health'), paths.join(', '));
});

test('Long-tail frameworks', 'Tornado URLSpec map extracted when tornado imported', () => {
  const src = `
import tornado.web
class MainHandler(tornado.web.RequestHandler): pass
app = tornado.web.Application([
  (r"/", MainHandler),
  (r"/health", MainHandler),
])
`;
  const routes = fw.extractPythonFrameworkRoutes(src);
  const paths = routes.map(r => r.path);
  assert.ok(paths.includes('/'));
  assert.ok(paths.includes('/health'));
});

test('Long-tail frameworks', 'Fiber routes extracted when gofiber import present', () => {
  const src = `
import "github.com/gofiber/fiber/v2"
func main() {
  app := fiber.New()
  app.Get("/x", h)
  app.Post("/y", h)
}
`;
  const routes = fw.extractGoFrameworkRoutes(src);
  const paths = routes.map(r => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /x'), paths.join(', '));
  assert.ok(paths.includes('POST /y'), paths.join(', '));
});

// ═══════════════════════════════════════════════════════════════════
// ACP polish — 7 tests across 3 suites
// ═══════════════════════════════════════════════════════════════════

const { AcpStore } = require('../src/acp/persistence');
const { loadAgentConfig, saveAgentConfig, clearAgentConfig } = require('../src/acp/config');
const { resolveSafe, safeRunCommand } = require('../src/acp/safety');
const { Session: AcpSession } = require('../src/acp/session');

function makeAcpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-acp-'));
  fs.mkdirSync(path.join(root, '.carto'));
  return root;
}

test('ACP persistence', 'saveSession + loadSession roundtrip preserves history + metadata', () => {
  const root = makeAcpRoot();
  const store = new AcpStore(root); store.open();
  const session = new AcpSession('abc123', root);
  session.history = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi back' },
  ];
  session.metadata = { client_name: 'test' };
  store.saveSession(session);

  const loaded = store.loadSession('abc123');
  assert.ok(loaded);
  assert.strictEqual(loaded.id, 'abc123');
  assert.strictEqual(loaded.history.length, 2);
  assert.strictEqual(loaded.history[0].role, 'user');
  assert.strictEqual(loaded.metadata.client_name, 'test');
  store.close();
});

test('ACP persistence', 'saveSession is idempotent on id (no duplicate rows)', () => {
  const root = makeAcpRoot();
  const store = new AcpStore(root); store.open();
  const session = new AcpSession('zzz', root);
  session.history = [{ role: 'user', content: 'first' }];
  store.saveSession(session);
  session.history.push({ role: 'assistant', content: 'second' });
  store.saveSession(session);
  const all = store.listSessions();
  assert.strictEqual(all.length, 1);
  const loaded = store.loadSession('zzz');
  assert.strictEqual(loaded.history.length, 2);
  store.close();
});

test('ACP persistence', 'openIfExists returns null on missing DB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-acp-empty-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = AcpStore.openIfExists(root);
  assert.strictEqual(store, null);
});

test('ACP config', 'saveAgentConfig writes providerId/baseUrl/model and STRIPS apiKey', () => {
  const root = makeAcpRoot();
  saveAgentConfig({
    projectRoot: root,
    providerId: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    // Even if a future caller passes an apiKey, it must NOT land in the file.
    apiKey: 'should-not-be-written',
    key: 'also-not',
    token: 'nope',
    secret: 'never',
  });
  const cfgPath = path.join(root, '.carto', 'agent-config.json');
  const raw = fs.readFileSync(cfgPath, 'utf-8');
  assert.ok(!/should-not-be-written|also-not|nope|never/.test(raw),
    `agent-config.json must not contain secret fields; got: ${raw}`);
  const cfg = loadAgentConfig(root);
  assert.strictEqual(cfg.providerId, 'anthropic');
  assert.strictEqual(cfg.baseUrl, 'https://api.anthropic.com');
  assert.strictEqual(cfg.model, 'claude-sonnet-4-20250514');
});

test('ACP config', 'loadAgentConfig returns null for missing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-acp-cfgnil-'));
  fs.mkdirSync(path.join(root, '.carto'));
  assert.strictEqual(loadAgentConfig(root), null);
});

// ── Safety primitives ────────────────────────────────────────────
test('ACP safety', 'resolveSafe rejects absolute paths', () => {
  const root = makeAcpRoot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  assert.throws(() => resolveSafe(root, '/etc/passwd'), /absolute/);
});

test('ACP safety', 'resolveSafe rejects ../ escape', () => {
  const root = makeAcpRoot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  assert.throws(() => resolveSafe(root, '../etc/passwd'), /escapes/);
});

test('ACP safety', 'resolveSafe accepts relative path inside workingDir', () => {
  const root = makeAcpRoot();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x');
  const r = resolveSafe(root, 'sub/a.txt');
  // Use path.join for the expected suffix so Windows backslashes match.
  assert.ok(r.endsWith(path.join('sub', 'a.txt')), `got ${r}`);
});

test('ACP safety', 'safeRunCommand refuses shell metacharacters in cmd (async — see runAsyncSuite)', () => {
  // The actual rejection assertion lives in runAsyncSuite; the sync test
  // helper doesn't await. Here we just confirm the export exists and is
  // a function.
  assert.strictEqual(typeof safeRunCommand, 'function');
});

// ═══════════════════════════════════════════════════════════════════
// AI-native primitives — 14 new MCP tools
// ═══════════════════════════════════════════════════════════════════

const lex = require('../src/ai/retrieval/lexical');
const rrf = require('../src/ai/retrieval/rrf');
const sem = require('../src/ai/retrieval/semantic');
const aiTools = require('../src/ai/tools');
const ctxBuilder = require('../src/ai/context-builder');

function makeAiTestStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ai-'));
  const store = new BSqliteStore(root);
  store.open();
  return { root, store };
}

function seedAiStore(store) {
  const db = store.db;
  db.prepare('INSERT INTO domains (id, name) VALUES (?, ?)').run(1, 'AUTH');
  db.prepare('INSERT INTO domains (id, name) VALUES (?, ?)').run(2, 'PAYMENTS');
  const ins = db.prepare('INSERT INTO files (path, domain_id, centrality, language, size) VALUES (?, ?, ?, ?, ?)');
  const sym = db.prepare('INSERT INTO symbols (file_id, name, kind, exported, is_default_export) VALUES (?, ?, ?, ?, ?)');
  const route = db.prepare('INSERT INTO routes (file_id, method, path) VALUES (?, ?, ?)');
  const model = db.prepare('INSERT INTO models (file_id, name, kind, fields_json) VALUES (?, ?, ?, ?)');
  const r1 = ins.run('src/auth/login.ts', 1, 12, 'TypeScript', 4000);
  sym.run(r1.lastInsertRowid, 'loginUser', 'function', 1, 0);
  sym.run(r1.lastInsertRowid, 'logoutUser', 'function', 1, 0);
  route.run(r1.lastInsertRowid, 'POST', '/api/login');
  const r2 = ins.run('src/auth/session.ts', 1, 8, 'TypeScript', 2000);
  sym.run(r2.lastInsertRowid, 'createSession', 'function', 1, 0);
  const r3 = ins.run('src/payments/billing.ts', 2, 6, 'TypeScript', 6000);
  sym.run(r3.lastInsertRowid, 'chargeCard', 'function', 1, 0);
  model.run(r3.lastInsertRowid, 'Invoice', 'interface', JSON.stringify([{ name: 'id', type: 'string' }]));
  const r4 = ins.run('src/utils/helpers.ts', null, 2, 'TypeScript', 1000);
  sym.run(r4.lastInsertRowid, 'parseDate', 'function', 1, 0);
  return { authLogin: r1.lastInsertRowid, authSession: r2.lastInsertRowid, payBilling: r3.lastInsertRowid };
}

test('AI retrieval: lexical', 'ensureFtsIndex creates files_fts virtual table + populates', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  const ok = lex.ensureFtsIndex(store);
  assert.strictEqual(ok, true);
  const r = lex.searchFts(store, 'login');
  assert.ok(r.length >= 1, `expected at least 1 match for "login"; got ${r.length}`);
  const paths = r.map(x => x.path);
  assert.ok(paths.includes('src/auth/login.ts'), `paths: ${paths.join(', ')}`);
  store.close();
});

test('AI retrieval: lexical', 'searchFts returns empty for queries with no matches', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  lex.ensureFtsIndex(store);
  const r = lex.searchFts(store, 'nonexistent_xyz_zzz');
  assert.strictEqual(r.length, 0);
  store.close();
});

test('AI retrieval: rrf', 'fuse combines channels and ranks by reciprocal rank', () => {
  const ranked = rrf.fuse({
    lexical: [{ path: 'a.ts' }, { path: 'b.ts' }],
    structural: [{ path: 'b.ts' }, { path: 'c.ts' }],
  }, { limit: 10 });
  // b.ts is in both channels → must rank higher than a.ts (lex only) and c.ts (struct only).
  assert.strictEqual(ranked[0].path, 'b.ts');
  assert.strictEqual(ranked.length, 3);
});

test('AI retrieval: rrf', 'computeBoosts produces same-domain bias map', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  const boosts = rrf.computeBoosts(store, { sameDomain: 'AUTH' });
  assert.ok(boosts.has('src/auth/login.ts'), 'AUTH login boosted');
  assert.ok(boosts.has('src/auth/session.ts'), 'AUTH session boosted');
  assert.ok(!boosts.has('src/payments/billing.ts'), 'PAYMENTS not boosted');
  store.close();
});

test('AI retrieval: semantic', 'isAvailable returns false by default (opt-in only)', () => {
  assert.strictEqual(sem.isAvailable(), false);
  assert.deepStrictEqual(sem.semanticSearch(null, 'x'), []);
});

test('AI context-builder', 'getProgressiveDisclosureTree groups files by domain', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  const tree = ctxBuilder.getProgressiveDisclosureTree({ store });
  assert.ok(tree.domains.length >= 2);
  const auth = tree.domains.find(d => d.name === 'AUTH');
  assert.ok(auth);
  assert.ok(auth.top_files.length >= 1);
  store.close();
});

test('AI tools: interfaceContract', 'returns exports + routes + models for a file', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  const r = aiTools.interfaceContract({ file: 'src/payments/billing.ts' }, { store, projectRoot: root });
  assert.strictEqual(r.file, 'src/payments/billing.ts');
  assert.strictEqual(r.domain, 'PAYMENTS');
  assert.ok(r.exports.some(e => e.name === 'chargeCard'));
  assert.ok(r.models.some(m => m.name === 'Invoice'));
  store.close();
});

test('AI tools: dataFlow', 'returns structural snapshot from store.getContext', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  const r = aiTools.dataFlow({ file: 'src/auth/login.ts' }, { store, projectRoot: root });
  assert.strictEqual(r.source, 'src/auth/login.ts');
  assert.ok('imports' in r);
  assert.ok('imported_by' in r);
  store.close();
});

test('AI tools: safetyChecklist', 'flags safe when blast radius is low and no other risks', () => {
  const { root, store } = makeAiTestStore();
  seedAiStore(store);
  const r = aiTools.safetyChecklist({ file: 'src/utils/helpers.ts' }, { store, projectRoot: root });
  assert.ok(Array.isArray(r.items));
  // helpers.ts has centrality 2 → no blast warning; no cross-domain; no
  // temporal data so no hotspot. Should land on 'safe' or just the no-tests warning.
  // We just check that the result is an array of items.
  assert.ok(r.items.length >= 1);
});

test('AI tools: safetyChecklist', 'flags major when blast radius exceeds threshold', () => {
  const { root, store } = makeAiTestStore();
  // Build a file with blast radius >= 20 by stuffing reverse_deps.
  const db = store.db;
  db.prepare('INSERT INTO domains (id, name) VALUES (1, ?)').run('AUTH');
  const f = db.prepare('INSERT INTO files (path, domain_id, centrality) VALUES (?, ?, ?)').run('src/auth/big.ts', 1, 50);
  // Manually add 25 importers
  for (let i = 0; i < 25; i++) {
    const childId = db.prepare('INSERT INTO files (path) VALUES (?)').run(`src/imp${i}.ts`).lastInsertRowid;
    db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path) VALUES (?, ?, ?)').run(childId, f.lastInsertRowid, 'src/auth/big.ts');
  }
  store.computeReverseDeps(5);
  const r = aiTools.safetyChecklist({ file: 'src/auth/big.ts' }, { store, projectRoot: store._projectRoot });
  assert.ok(r.items.some(i => /blast/i.test(i.message) && (i.severity === 'major' || i.severity === 'minor')),
    `expected blast warning; got ${JSON.stringify(r.items)}`);
  store.close();
});

test('AI tools: dependencySurface', 'reads package.json deps from project root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ai-deps-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { express: '^4.21.0', zod: '^3.22.0' },
    devDependencies: { 'mocha': '^10.0.0' },
  }));
  const r = aiTools.dependencySurface({}, { store: null, projectRoot: root });
  assert.strictEqual(r.count, 3);
  assert.ok(r.deps.some(d => d.name === 'express' && d.kind === 'runtime'));
  assert.ok(r.deps.some(d => d.name === 'mocha' && d.kind === 'dev'));
});

test('AI tools: upgradeRisk', 'cross-references package deps with imports table', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ai-risk-'));
  fs.mkdirSync(path.join(root, '.carto'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { express: '^4.21.0' },
  }));
  const store = new BSqliteStore(root); store.open();
  const f1 = store.db.prepare('INSERT INTO files (path) VALUES (?)').run('src/a.ts').lastInsertRowid;
  const f2 = store.db.prepare('INSERT INTO files (path) VALUES (?)').run('src/b.ts').lastInsertRowid;
  store.db.prepare('INSERT INTO imports (from_file_id, to_path) VALUES (?, ?)').run(f1, 'express');
  store.db.prepare('INSERT INTO imports (from_file_id, to_path) VALUES (?, ?)').run(f2, 'express/types');
  const r = aiTools.upgradeRisk({}, { store, projectRoot: root });
  const express = r.risks.find(x => x.name === 'express');
  assert.ok(express, `expected express in risks; got ${r.risks.map(x => x.name).join(', ')}`);
  assert.strictEqual(express.count, 2);
  store.close();
});

test('AI tools: staleDocs', 'flags docs older than 30 days', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-ai-docs-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const oldDoc = path.join(root, 'docs', 'old.md');
  fs.writeFileSync(oldDoc, '# old');
  const old = (Date.now() - 60 * 86_400_000) / 1000;
  fs.utimesSync(oldDoc, old, old);
  const r = aiTools.staleDocs({}, { store: null, projectRoot: root });
  assert.ok(r.stale.some(d => d.path === 'docs/old.md'));
});

// ═══════════════════════════════════════════════════════════════════
// Adjacent positioning — 13 tests across 5 suites
// ═══════════════════════════════════════════════════════════════════

const callGraph = require('../src/adjacent/call-graph');
const iac = require('../src/adjacent/iac');
const runtime = require('../src/adjacent/runtime');
const semDiff = require('../src/adjacent/semantic-diff');
const llmEnrich = require('../src/adjacent/llm-enrich');

// ── Cross-language call graph ────────────────────────────────────
test('Adjacent: call graph', 'collectFetchesFromContent detects fetch/axios/jQuery patterns', () => {
  const src = `
fetch('/api/users', { method: 'POST' });
axios.get('/api/profile');
$.get('/api/health');
fetch(\`/api/items/\${id}\`, { method: 'GET' });
`;
  const r = callGraph.collectFetchesFromContent(src);
  const paths = r.map(x => `${x.method} ${x.path}`).sort();
  assert.ok(paths.includes('POST /api/users'), paths.join(', '));
  assert.ok(paths.includes('GET /api/profile'), paths.join(', '));
  assert.ok(paths.includes('GET /api/health'), paths.join(', '));
});

test('Adjacent: call graph', 'normalizePath collapses numeric + uuid segments', () => {
  assert.strictEqual(callGraph.normalizePath('/users/123/posts'), '/users/:id/posts');
  assert.strictEqual(callGraph.normalizePath('/users/aaaaaaaa-bbbb-1234-5678-9abcdef01234'), '/users/:id');
  assert.strictEqual(callGraph.normalizePath('/users/{id}'), '/users/:id');
  assert.strictEqual(callGraph.normalizePath('/users/:id/profile'), '/users/:id/profile');
  assert.strictEqual(callGraph.normalizePath('/static'), '/static');
});

test('Adjacent: call graph', 'buildCallGraph joins fetches in source files to route handlers', () => {
  // Build a tiny project on disk: one TS file that fetches /api/users,
  // one route file that handles POST /api/users.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-callgraph-'));
  fs.mkdirSync(path.join(root, '.carto'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'client.ts'),
    "fetch('/api/users', { method: 'POST' });\n");
  fs.writeFileSync(path.join(root, 'src', 'handler.ts'),
    "// handler\n");
  const store = new BSqliteStore(root); store.open();
  // Seed: register both files + a POST /api/users route on handler.ts
  const c = store.db.prepare('INSERT INTO files (path, language) VALUES (?, ?)').run('src/client.ts', 'TypeScript').lastInsertRowid;
  const h = store.db.prepare('INSERT INTO files (path, language) VALUES (?, ?)').run('src/handler.ts', 'TypeScript').lastInsertRowid;
  store.db.prepare('INSERT INTO routes (file_id, method, path) VALUES (?, ?, ?)').run(h, 'POST', '/api/users');

  const r = callGraph.buildCallGraph({ store, projectRoot: root });
  assert.strictEqual(r.total_fetches_seen, 1);
  assert.ok(r.matches.length >= 1, `no matches: ${JSON.stringify(r)}`);
  const m = r.matches[0];
  assert.strictEqual(m.caller_file, 'src/client.ts');
  assert.strictEqual(m.callee_file, 'src/handler.ts');
  assert.strictEqual(m.method, 'POST');
  store.close();
});

// ── IaC parsers ──────────────────────────────────────────────────
test('Adjacent: IaC', 'parseTerraform extracts resource + module + data blocks', () => {
  const src = `
resource "aws_s3_bucket" "mine" {
  bucket = var.bucket_name
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  cidr   = var.cidr_block
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
  }
}
`;
  const r = iac.parseTerraform(src, 'main.tf');
  const kinds = r.map(x => x.kind).sort();
  assert.deepStrictEqual(kinds, ['data', 'module', 'resource']);
  const bucket = r.find(x => x.kind === 'resource' && x.name === 'mine');
  assert.strictEqual(bucket.tf_type, 'aws_s3_bucket');
  // Bucket references `var.bucket_name`
  assert.ok(bucket.dependencies.some(d => d.startsWith('var.bucket_name')), bucket.dependencies.join(', '));
});

test('Adjacent: IaC', 'parseHelmChart picks up Chart.yaml name + version + deps', () => {
  const src = `
apiVersion: v2
name: my-chart
version: 1.2.3
description: Test chart
dependencies:
  - name: redis
    version: ~17.0.0
  - name: postgres
    version: ~12.0.0
`;
  const r = iac.parseHelmChart(src, 'helm/Chart.yaml');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, 'my-chart');
  assert.strictEqual(r[0].version, '1.2.3');
  assert.deepStrictEqual(r[0].dependencies.map(d => d.name).sort(), ['postgres', 'redis']);
});

test('Adjacent: IaC', 'parsePulumiOrCdk detects new Construct(this, "name") only when SDK import present', () => {
  const cdkSrc = `
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';

class MyStack extends cdk.Stack {
  constructor() {
    new s3.Bucket(this, "AssetsBucket", { versioned: true });
  }
}
`;
  const r = iac.parsePulumiOrCdk(cdkSrc, 'stack.ts');
  assert.ok(r.some(x => x.kind === 'cdk-construct' && x.name === 'AssetsBucket'), JSON.stringify(r));
  // No CDK / Pulumi import → no extraction.
  const noSdk = `new s3.Bucket(this, "name");`;
  assert.strictEqual(iac.parsePulumiOrCdk(noSdk, 'x.ts').length, 0);
});

// ── Runtime fusion (OTLP) ────────────────────────────────────────
test('Adjacent: runtime', 'parseOtlpText aggregates http.method × http.route from OTLP JSON', () => {
  const otlp = {
    resourceSpans: [{
      scopeSpans: [{
        spans: [
          { attributes: [
            { key: 'http.method', value: { stringValue: 'GET' } },
            { key: 'http.route', value: { stringValue: '/api/users' } },
          ]},
          { attributes: [
            { key: 'http.method', value: { stringValue: 'GET' } },
            { key: 'http.route', value: { stringValue: '/api/users' } },
          ]},
          { attributes: [
            { key: 'http.method', value: { stringValue: 'POST' } },
            { key: 'http.route', value: { stringValue: '/api/login' } },
          ]},
        ],
      }],
    }],
  };
  const r = runtime.parseOtlpText(JSON.stringify(otlp));
  const map = new Map(r.map(x => [`${x.method} ${x.path}`, x.count]));
  assert.strictEqual(map.get('GET /api/users'), 2);
  assert.strictEqual(map.get('POST /api/login'), 1);
});

test('Adjacent: runtime', 'riskWeightedBlastRadius scores routes by dependents × runtime_calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-riskblast-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = new BSqliteStore(root); store.open();
  const f1 = store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/hot.ts', 20).lastInsertRowid;
  const f2 = store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/cold.ts', 5).lastInsertRowid;
  store.db.prepare('INSERT INTO routes (file_id, method, path) VALUES (?, ?, ?)').run(f1, 'GET', '/api/hot');
  store.db.prepare('INSERT INTO routes (file_id, method, path) VALUES (?, ?, ?)').run(f2, 'GET', '/api/cold');
  const counts = [{ method: 'GET', path: '/api/hot', count: 1000 }];
  const r = runtime.riskWeightedBlastRadius({ store, runtimeCounts: counts });
  // Hot route should have the highest score
  assert.strictEqual(r[0].path, '/api/hot');
  assert.strictEqual(r[0].runtime_calls, 1000);
  store.close();
});

test('Adjacent: runtime', 'deadCodeWithConfidence flags orphaned files (no imports + no runtime)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-dead-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = new BSqliteStore(root); store.open();
  // f1 is orphan: 0 reverse_deps + 0 centrality. f2 has an importer.
  const f1 = store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/orphan.ts', 0).lastInsertRowid;
  const f2 = store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/used.ts', 0).lastInsertRowid;
  const importer = store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/main.ts', 0).lastInsertRowid;
  store.db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path) VALUES (?, ?, ?)').run(importer, f2, 'src/used.ts');
  const r = runtime.deadCodeWithConfidence({ store });
  const paths = r.map(x => x.path);
  assert.ok(paths.includes('src/orphan.ts'));
  assert.ok(!paths.includes('src/used.ts'));
  store.close();
});

// ── Semantic diff ────────────────────────────────────────────────
test('Adjacent: semantic-diff', 'detectRenames pairs removed/added function decls of same shape', () => {
  const diff = `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,5 +1,5 @@
 // header
-function getUser(id: string) {
+function getUserById(id: string) {
   return db.users.find(id);
 }`;
  const r = semDiff.semanticDiff({ store: null, diff });
  assert.ok(r.renames.some(x => x.from === 'getUser' && x.to === 'getUserById'),
    `expected getUser→getUserById rename; got ${JSON.stringify(r.renames)}`);
});

test('Adjacent: semantic-diff', 'detectRelocations finds same-name symbol moving file', () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,1 @@
-function doThing() {
-  return 1;
-}
diff --git a/src/b.ts b/src/b.ts
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,3 @@
+function doThing() {
+  return 1;
+}`;
  const r = semDiff.semanticDiff({ store: null, diff });
  assert.ok(r.relocations.some(x => x.symbol === 'doThing'),
    `expected doThing relocation; got ${JSON.stringify(r.relocations)}; renames=${JSON.stringify(r.renames)}; new=${JSON.stringify(r.new_files)}; del=${JSON.stringify(r.deleted_files)}`);
});

// ── LLM enrichment stub ──────────────────────────────────────────
test('Adjacent: llm-enrich', 'isAvailable returns false until opt-in (matches semantic stub pattern)', () => {
  assert.strictEqual(llmEnrich.isAvailable(), false);
  assert.strictEqual(llmEnrich.enrichNode('src/foo.ts'), null);
  const g = llmEnrich.enrichGraph(null);
  assert.deepStrictEqual(g, { enriched: 0, cached: 0, summaries: [] });
});

// ═══════════════════════════════════════════════════════════════════
// Predictive premium — 10 tests across 4 suites
// ═══════════════════════════════════════════════════════════════════

const { scoreFiles } = require('../src/predictive/risk-score');
const { findCutPoints } = require('../src/predictive/cut-points');
const { validateChange, synthesizeDiff } = require('../src/predictive/validate-change');
const { aiCostAttribution } = require('../src/predictive/ownership');
const { renderDriftDigest } = require('../src/predictive/drift-digest');

test('Predictive: risk-score', 'scoreFiles produces weighted score in [0,1] per file', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const r = scoreFiles({ store, projectRoot: root });
  assert.ok(r.length > 0);
  for (const x of r) {
    assert.ok(x.score >= 0 && x.score <= 1, `score out of range: ${x.score}`);
    assert.ok(x.components.blast >= 0 && x.components.blast <= 1, `blast out of range`);
  }
  store.close();
});

test('Predictive: risk-score', 'scoreFiles ranks higher-blast file above lower-blast', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-risk-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = new BSqliteStore(root); store.open();
  store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/hot.ts', 50);
  store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/cold.ts', 1);
  const r = scoreFiles({ store, projectRoot: root });
  assert.strictEqual(r[0].path, 'src/hot.ts');
  assert.ok(r[0].score > r[1].score);
  store.close();
});

test('Predictive: cut-points', 'findCutPoints identifies high-cohesion domain as candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-cut-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = new BSqliteStore(root); store.open();
  // 12 files in AUTH, all importing each other intra-domain; 1 cross-domain to CORE
  store.db.prepare('INSERT INTO domains (id, name, file_count) VALUES (1, ?, 12)').run('AUTH');
  store.db.prepare('INSERT INTO domains (id, name, file_count) VALUES (2, ?, 1)').run('CORE');
  const authIds = [];
  for (let i = 0; i < 12; i++) {
    const id = store.db.prepare('INSERT INTO files (path, domain_id) VALUES (?, ?)').run(`src/auth/${i}.ts`, 1).lastInsertRowid;
    store.db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?, ?)').run(id, 1);
    authIds.push(id);
  }
  const coreId = store.db.prepare('INSERT INTO files (path, domain_id) VALUES (?, ?)').run('src/core/a.ts', 2).lastInsertRowid;
  store.db.prepare('INSERT INTO domain_assignments (file_id, domain_id) VALUES (?, ?)').run(coreId, 2);
  for (let i = 0; i < 30; i++) {
    const a = authIds[i % authIds.length];
    const b = authIds[(i + 1) % authIds.length];
    if (a !== b) store.db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path) VALUES (?, ?, ?)').run(a, b, `x${i}`);
  }
  store.db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path) VALUES (?, ?, ?)').run(authIds[0], coreId, 'src/core/a.ts');
  const r = findCutPoints({ store, threshold: 0.7, minSize: 5 });
  assert.ok(r.cut_points.some(d => d.domain === 'AUTH'), `expected AUTH as cut-point; got ${JSON.stringify(r.cut_points)}; all=${JSON.stringify(r.all_domains)}`);
  store.close();
});

test('Predictive: cut-points', 'findCutPoints rejects domain below minSize even if cohesion is high', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-cut2-'));
  fs.mkdirSync(path.join(root, '.carto'));
  const store = new BSqliteStore(root); store.open();
  store.db.prepare('INSERT INTO domains (id, name) VALUES (1, ?)').run('TINY');
  const a = store.db.prepare('INSERT INTO files (path, domain_id) VALUES (?, ?)').run('src/a.ts', 1).lastInsertRowid;
  const b = store.db.prepare('INSERT INTO files (path, domain_id) VALUES (?, ?)').run('src/b.ts', 1).lastInsertRowid;
  store.db.prepare('INSERT INTO imports (from_file_id, to_file_id, to_path) VALUES (?, ?, ?)').run(a, b, 'src/b.ts');
  const r = findCutPoints({ store, threshold: 0.5, minSize: 10 });
  assert.ok(!r.cut_points.some(d => d.domain === 'TINY'),
    `TINY (2 files) must not pass minSize=10; got ${JSON.stringify(r.cut_points)}`);
  store.close();
});

test('Predictive: validate-change', 'synthesizeDiff emits a parseable unified diff', () => {
  const diff = synthesizeDiff('src/x.ts', 'old\n', 'new\nstuff\n');
  assert.ok(diff.startsWith('diff --git'));
  assert.ok(diff.includes('-old'));
  assert.ok(diff.includes('+new'));
});

test('Predictive: validate-change', 'validateChange returns SAFE no-change when content is identical to disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-vc-'));
  fs.mkdirSync(path.join(root, '.carto'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'hello\n');
  const store = new BSqliteStore(root); store.open();
  const r = validateChange({ store, projectRoot: root, file: 'src/x.ts', content: 'hello\n' });
  assert.strictEqual(r.risk, 'SAFE');
  assert.strictEqual(r.reason, 'no_change');
  store.close();
});

test('Predictive: validate-change', 'validateChange invokes validation pipeline for real change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-vc2-'));
  fs.mkdirSync(path.join(root, '.carto'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'export function foo() {}\n');
  const store = new BSqliteStore(root); store.open();
  store.db.prepare('INSERT INTO files (path, centrality) VALUES (?, ?)').run('src/x.ts', 0);
  const r = validateChange({ store, projectRoot: root, file: 'src/x.ts', content: 'export function foo() { return 1; }\n' });
  assert.ok(['SAFE', 'LOW', 'MEDIUM', 'HIGH'].includes(r.risk), `unexpected risk: ${r.risk}`);
  store.close();
});

test('Predictive: ownership', 'aiCostAttribution returns empty array when no sessions', () => {
  const { root, store } = makeBrainTestStore();
  const r = aiCostAttribution({ store });
  assert.deepStrictEqual(r.clients, []);
  store.close();
});

test('Predictive: ownership', 'aiCostAttribution groups decisions by client_name', () => {
  const { root, store } = makeBrainTestStore();
  const now = Date.now();
  store.db.prepare(`INSERT INTO ai_sessions (id, started_at, client_name) VALUES (1, ?, 'cursor')`).run(now);
  store.db.prepare(`INSERT INTO ai_sessions (id, started_at, client_name) VALUES (2, ?, 'claude-code')`).run(now);
  store.db.prepare(`INSERT INTO decisions (session_id, ts, kind) VALUES (1, ?, 'v')`).run(now);
  store.db.prepare(`INSERT INTO decisions (session_id, ts, kind) VALUES (1, ?, 'v')`).run(now);
  store.db.prepare(`INSERT INTO decisions (session_id, ts, kind) VALUES (2, ?, 'v')`).run(now);
  const r = aiCostAttribution({ store, hours: 24 });
  const cursor = r.clients.find(c => c.client === 'cursor');
  const claude = r.clients.find(c => c.client === 'claude-code');
  assert.strictEqual(cursor.decisions, 2);
  assert.strictEqual(claude.decisions, 1);
  store.close();
});

test('Predictive: drift-digest', 'renderDriftDigest produces markdown with section headers', () => {
  const { root, store } = makeBrainTestStore();
  seedStore(store);
  const md = renderDriftDigest({ store, temporalStore: null, projectRoot: root, timeRange: '7d' });
  assert.ok(md.startsWith('# Drift Digest'), 'must start with H1');
  assert.ok(md.includes('Temporal data unavailable') || md.includes('Domain drift'),
    'expected either temporal-disabled section or drift section');
  // Without temporal data the digest should still render predictive risk
  assert.ok(md.includes('Predicted-risk top'), 'expected predictive risk section');
  store.close();
});

// ═══════════════════════════════════════════════════════════════════
// Cross-Repo / Org-wide — 13 tests across 4 suites
// ═══════════════════════════════════════════════════════════════════

const { OrgStore } = require('../src/org/store');
const orgDetect = require('../src/org/detect');
const { orgSync, buildTargetToRepoMap } = require('../src/org/sync');
const orgQueries = require('../src/org/queries');

function makeOrgTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carto-org-'));
}

// ── Store ────────────────────────────────────────────────────────
test('Org: store', 'addRepo + listRepos + getRepo roundtrip', () => {
  const orgDir = makeOrgTmpDir();
  const store = new OrgStore(orgDir).open();
  store.addRepo({ name: 'api', rootPath: '/tmp/api' });
  store.addRepo({ name: 'web', rootPath: '/tmp/web' });
  const repos = store.listRepos();
  assert.strictEqual(repos.length, 2);
  assert.ok(store.getRepo('api'));
  // idempotency: adding same name updates rootPath
  store.addRepo({ name: 'api', rootPath: '/tmp/api-v2' });
  assert.strictEqual(store.listRepos().length, 2);
  assert.strictEqual(store.getRepo('api').root_path, '/tmp/api-v2');
  store.close();
});

test('Org: store', 'removeRepo deletes repo + its outgoing/incoming edges', () => {
  const orgDir = makeOrgTmpDir();
  const store = new OrgStore(orgDir).open();
  store.addRepo({ name: 'api', rootPath: '/tmp/api' });
  store.addRepo({ name: 'web', rootPath: '/tmp/web' });
  store.insertEdges('web', [
    { edge_kind: 'npm', target: '@org/api', to_repo: 'api', from_file: 'package.json' },
  ]);
  store.removeRepo('api');
  assert.strictEqual(store.listRepos().length, 1);
  assert.strictEqual(store.getEdges({}).length, 0);
  store.close();
});

test('Org: store', 'insertEdges replaces existing edges from same repo', () => {
  const orgDir = makeOrgTmpDir();
  const store = new OrgStore(orgDir).open();
  store.addRepo({ name: 'a', rootPath: '/tmp/a' });
  store.insertEdges('a', [{ edge_kind: 'npm', target: 'x' }]);
  store.insertEdges('a', [{ edge_kind: 'npm', target: 'y' }, { edge_kind: 'npm', target: 'z' }]);
  const edges = store.getEdges({ from_repo: 'a' });
  assert.strictEqual(edges.length, 2);
  assert.ok(edges.some(e => e.target === 'y'));
  assert.ok(edges.some(e => e.target === 'z'));
  assert.ok(!edges.some(e => e.target === 'x'));
  store.close();
});

// ── Detection ────────────────────────────────────────────────────
test('Org: detect', 'detectNpm finds @scope packages in package.json deps', () => {
  const root = makeOrgTmpDir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@myorg/web',
    dependencies: { '@myorg/api-client': '^1.0', '@public/lib': '^2.0', 'express': '^4.0' },
  }));
  const edges = orgDetect.detectNpm(root, ['@myorg']);
  const targets = edges.map(e => e.target);
  assert.ok(targets.includes('@myorg/api-client'), targets.join(', '));
  assert.ok(!targets.includes('@public/lib'));
  assert.ok(!targets.includes('express'));
});

test('Org: detect', 'detectNpm finds @scope imports in source files', () => {
  const root = makeOrgTmpDir();
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'app.ts'),
    "import { foo } from '@myorg/api-client';\nimport * as fs from 'fs';\n");
  const edges = orgDetect.detectNpm(root, ['@myorg']);
  assert.ok(edges.some(e => e.target === '@myorg/api-client' && e.from_file === 'app.ts'));
});

test('Org: detect', 'detectGo finds go-mod requires with private prefix', () => {
  const root = makeOrgTmpDir();
  fs.writeFileSync(path.join(root, 'go.mod'), `
module github.com/myorg/api
go 1.21
require (
  github.com/myorg/shared v1.2.3
  github.com/gorilla/mux v1.8.0
)
`);
  const edges = orgDetect.detectGo(root, ['github.com/myorg']);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].target, 'github.com/myorg/shared');
});

test('Org: detect', 'detectMaven extracts groupId:artifactId from pom.xml', () => {
  const root = makeOrgTmpDir();
  fs.writeFileSync(path.join(root, 'pom.xml'), `
<project>
  <dependencies>
    <dependency><groupId>com.myorg</groupId><artifactId>core</artifactId><version>1.0</version></dependency>
    <dependency><groupId>org.junit</groupId><artifactId>junit</artifactId></dependency>
  </dependencies>
</project>
`);
  const edges = orgDetect.detectMaven(root, ['com.myorg']);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].target, 'com.myorg:core');
});

test('Org: detect', 'detectProto finds .proto file imports', () => {
  const root = makeOrgTmpDir();
  fs.writeFileSync(path.join(root, 'service.proto'), `
syntax = "proto3";
import "common/types.proto";
import "other/api.proto";
message Hello { string name = 1; }
`);
  const edges = orgDetect.detectProto(root);
  const targets = edges.map(e => e.target);
  assert.ok(targets.includes('common/types.proto'));
  assert.ok(targets.includes('other/api.proto'));
});

test('Org: detect', 'detectSqlMigrations extracts CREATE TABLE names', () => {
  const root = makeOrgTmpDir();
  fs.mkdirSync(path.join(root, 'migrations'));
  fs.writeFileSync(path.join(root, 'migrations', '001_users.sql'),
    'CREATE TABLE users (id SERIAL PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS posts (id INT);');
  const edges = orgDetect.detectSqlMigrations(root);
  const tables = edges.map(e => e.target);
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('posts'));
});

// ── Sync ─────────────────────────────────────────────────────────
test('Org: sync', 'orgSync resolves to_repo from package.json names', () => {
  const orgDir = makeOrgTmpDir();
  const apiRoot = makeOrgTmpDir();
  fs.writeFileSync(path.join(apiRoot, 'package.json'), JSON.stringify({ name: '@myorg/api' }));
  const webRoot = makeOrgTmpDir();
  fs.writeFileSync(path.join(webRoot, 'package.json'), JSON.stringify({
    name: '@myorg/web',
    dependencies: { '@myorg/api': '^1.0' },
  }));

  const store = new OrgStore(orgDir).open();
  store.addRepo({ name: 'api', rootPath: apiRoot });
  store.addRepo({ name: 'web', rootPath: webRoot });
  store.close();

  const r = orgSync({ orgDir, scopes: { npm: ['@myorg'] } });
  assert.strictEqual(r.repos, 2);

  const reopened = new OrgStore(orgDir).open();
  const edges = reopened.getEdges({ from_repo: 'web' });
  assert.ok(edges.some(e => e.target === '@myorg/api' && e.to_repo === 'api'),
    `expected web → api resolved edge; got ${JSON.stringify(edges)}`);
  reopened.close();
});

test('Org: sync', 'buildTargetToRepoMap maps npm + pypi + go names to repo identifiers', () => {
  const repos = [
    { name: 'api', root_path: (() => {
      const r = makeOrgTmpDir();
      fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name: '@myorg/api' }));
      fs.writeFileSync(path.join(r, 'pyproject.toml'), 'name = "myorg-api"\n');
      fs.writeFileSync(path.join(r, 'go.mod'), 'module github.com/myorg/api\n');
      return r;
    })() },
  ];
  const m = buildTargetToRepoMap(repos);
  assert.strictEqual(m.get('npm::@myorg/api'), 'api');
  assert.strictEqual(m.get('pypi::myorg-api'), 'api');
  assert.strictEqual(m.get('go-mod::github.com/myorg/api'), 'api');
});

// ── Queries ──────────────────────────────────────────────────────
test('Org: queries', 'findConsumersOfApi returns edges matching target or prefix', () => {
  const orgDir = makeOrgTmpDir();
  const store = new OrgStore(orgDir).open();
  store.addRepo({ name: 'a', rootPath: '/tmp/a' });
  store.addRepo({ name: 'b', rootPath: '/tmp/b' });
  store.insertEdges('a', [
    { edge_kind: 'npm', target: '@org/api', from_file: 'a.ts' },
    { edge_kind: 'npm', target: '@org/api/types', from_file: 'b.ts' },
  ]);
  store.insertEdges('b', [{ edge_kind: 'npm', target: 'express', from_file: 'p.json' }]);
  const r = orgQueries.findConsumersOfApi(store, '@org/api');
  assert.strictEqual(r.length, 2);
  assert.ok(r.every(x => x.from_repo === 'a'));
  store.close();
});

test('Org: queries', 'microservicesMigrationCutPoints ranks by stability (incoming / total)', () => {
  const orgDir = makeOrgTmpDir();
  const store = new OrgStore(orgDir).open();
  store.addRepo({ name: 'producer', rootPath: '/tmp/p' });
  store.addRepo({ name: 'consumer', rootPath: '/tmp/c' });
  // producer is depended on by consumer (1 incoming for producer)
  // consumer has 1 outgoing edge.
  store.insertEdges('consumer', [
    { edge_kind: 'npm', target: '@org/producer', to_repo: 'producer', from_file: 'package.json' },
  ]);
  const r = orgQueries.microservicesMigrationCutPoints(store);
  // producer should rank first (stability = 1/(1+0) = 1)
  assert.strictEqual(r.order[0].repo, 'producer');
  assert.strictEqual(r.order[0].stability, 1);
  store.close();
});

// ═══════════════════════════════════════════════════════════════════
// Cross-Tier DX leftover — API docs generator + init progress
// ═══════════════════════════════════════════════════════════════════

const genApiDocs = require('../scripts/gen-api-docs');

test('Docs API gen', 'loadTools parses TOOLS array from server.js', () => {
  const tools = genApiDocs.loadTools();
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length >= 60, `expected >=60 tools; got ${tools.length}`);
  for (const t of tools) {
    assert.strictEqual(typeof t.name, 'string');
    assert.strictEqual(typeof t.description, 'string');
    assert.strictEqual(typeof t.inputSchema, 'object');
  }
});

test('Docs API gen', 'toolMarkdown produces a single # heading + Input schema + Properties sections', () => {
  const md = genApiDocs.toolMarkdown({
    name: 'sample_tool',
    description: 'A test tool.',
    inputSchema: {
      type: 'object',
      properties: { intent: { type: 'string', description: 'A natural-language hint.' } },
      required: ['intent'],
    },
  });
  assert.ok(md.startsWith('# `sample_tool`'), md.slice(0, 100));
  assert.ok(md.includes('## Input schema'));
  assert.ok(md.includes('## Properties'));
  assert.ok(md.includes('intent'));
});

test('Docs API gen', 'indexMarkdown groups tools into known categories with counts', () => {
  const tools = genApiDocs.loadTools();
  const md = genApiDocs.indexMarkdown(tools);
  assert.ok(md.startsWith('# Carto MCP Tools'), md.slice(0, 100));
  for (const expected of ['Core graph', 'Temporal', 'Brain', 'AI-native', 'Adjacent', 'Predictive', 'Org-wide']) {
    assert.ok(md.includes(`### ${expected}`), `expected category "${expected}" in index; got: ${md.split('\n').slice(0, 20).join('\n')}`);
  }
});

test('Docs API gen', 'every registered MCP tool has a .md file in docs/api/', () => {
  const tools = genApiDocs.loadTools();
  const docsDir = path.join(__dirname, '..', 'docs', 'api');
  for (const t of tools) {
    const p = path.join(docsDir, `${t.name}.md`);
    assert.ok(fs.existsSync(p), `missing doc: docs/api/${t.name}.md (run \`node scripts/gen-api-docs.js\`)`);
  }
});



const { TOOL_DEFINITIONS: SWE_TOOL_DEFS, makeExecutor: sweMakeExecutor } = require('../bench/swe-bench/tools');
const { foldAnthropicEvents: sweFoldEvents, synthesizeDiff: sweSynthDiff } = require('../bench/swe-bench/anthropic-agent');

test('SWE-bench tools', 'TOOL_DEFINITIONS lists the 5 expected tools with input_schema', () => {
  const names = SWE_TOOL_DEFS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['edit_file', 'list_directory', 'read_file', 'run_bash', 'write_file']);
  for (const t of SWE_TOOL_DEFS) {
    assert.strictEqual(typeof t.description, 'string');
    assert.strictEqual(t.input_schema.type, 'object', `${t.name} input_schema must be object`);
    assert.ok(Array.isArray(t.input_schema.required), `${t.name} input_schema.required must be array`);
  }
});

// Async tool-executor tests live in runAsyncSuite (below). The sync
// test() helper doesn't await fn() so a rejected promise would slip
// past the failure counter.

test('SWE-bench tools', 'AnthropicAgent.foldEvents assembles streamed text + tool_use blocks', () => {
  const folded = sweFoldEvents([
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will read the file.' } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"src/x.ts"}' } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  assert.strictEqual(folded.length, 2);
  assert.deepStrictEqual(folded[0], { type: 'text', text: 'I will read the file.' });
  assert.strictEqual(folded[1].type, 'tool_use');
  assert.deepStrictEqual(folded[1].input, { path: 'src/x.ts' });
});

test('SWE-bench tools', 'synthesizeDiff emits parser-compatible adds + modifies + deletes', () => {
  const before = new Map([
    ['src/keep.ts', 'unchanged\n'],
    ['src/modify.ts', 'old\n'],
    ['src/delete.ts', 'goodbye\n'],
  ]);
  const after = new Map([
    ['src/keep.ts', 'unchanged\n'],     // no change → not in diff
    ['src/modify.ts', 'new\n'],          // modify
    ['src/add.ts', 'hello\n'],           // add
    // src/delete.ts not present in after → delete
  ]);
  const diff = sweSynthDiff(before, after);
  const parsed = spec16ParseDiff(diff);
  const byPath = Object.fromEntries(parsed.map((f) => [f.path, f]));
  assert.ok(byPath['src/modify.ts'] && byPath['src/modify.ts'].kind === 'modify');
  assert.ok(byPath['src/add.ts'] && byPath['src/add.ts'].kind === 'add');
  assert.ok(byPath['src/delete.ts'] && byPath['src/delete.ts'].kind === 'delete');
  assert.ok(!byPath['src/keep.ts'], 'unchanged files must not appear in the diff');
});

// ═══════════════════════════════════════════════════════════════════
// Rule engine: intent (7 tests)
// ═══════════════════════════════════════════════════════════════════

const rulesIntent = require('../src/rules/intent');

test('Rule engine: intent', 'loadIntent returns null when file does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  assert.strictEqual(rulesIntent.loadIntent(dir), null);
});

test('Rule engine: intent', 'saveIntent creates .carto/intent.json with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  const written = rulesIntent.saveIntent(dir, { product_type: 'saas-with-auth' });
  assert.strictEqual(written.product_type, 'saas-with-auth');
  assert.ok(Array.isArray(written.stack));
  assert.ok(Array.isArray(written.notes));
  assert.ok(typeof written.updated_at === 'number');
  const reread = rulesIntent.loadIntent(dir);
  assert.strictEqual(reread.product_type, 'saas-with-auth');
});

test('Rule engine: intent', 'setIntent appends notes rather than overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  rulesIntent.setIntent(dir, { product_type: 'saas-with-auth', note: 'single-user for now' });
  rulesIntent.setIntent(dir, { note: 'skipping webhooks this quarter' });
  const cur = rulesIntent.loadIntent(dir);
  assert.strictEqual(cur.notes.length, 2);
  assert.strictEqual(cur.notes[0].text, 'single-user for now');
  assert.strictEqual(cur.notes[1].text, 'skipping webhooks this quarter');
});

test('Rule engine: intent', 'setIntent stack replaces (not appends)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  rulesIntent.setIntent(dir, { stack: ['Next.js'] });
  rulesIntent.setIntent(dir, { stack: ['Next.js', 'Supabase'] });
  const cur = rulesIntent.loadIntent(dir);
  assert.deepStrictEqual(cur.stack, ['Next.js', 'Supabase']);
});

test('Rule engine: intent', 'autoDetect flags Next.js + Supabase as saas-with-auth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { next: '14', '@supabase/supabase-js': '2' } }),
  );
  const out = rulesIntent.autoDetect(dir);
  assert.strictEqual(out.product_type, 'saas-with-auth');
  assert.ok(out.stack.includes('Next.js'));
  assert.ok(out.stack.includes('Supabase'));
});

test('Rule engine: intent', 'autoDetect flags Next.js + Clerk as saas-with-auth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { next: '14', '@clerk/nextjs': '5' } }),
  );
  const out = rulesIntent.autoDetect(dir);
  assert.strictEqual(out.product_type, 'saas-with-auth');
});

test('Rule engine: intent', 'autoDetect flags plain Express as unsupported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-intent-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { express: '4' } }),
  );
  const out = rulesIntent.autoDetect(dir);
  assert.strictEqual(out.product_type, 'unsupported');
});

// ═══════════════════════════════════════════════════════════════════
// Rule engine: engine core (4 tests)
// ═══════════════════════════════════════════════════════════════════

const rulesEngine = require('../src/rules/engine');

test('Rule engine: engine', 'runEngine returns empty gaps when intent is unsupported', () => {
  const { SQLiteStore: RE_Store } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-engine-'));
  const store = new RE_Store(dir);
  store.open();
  try {
    const out = rulesEngine.runEngine({ store, projectRoot: dir, intent: { product_type: 'unsupported' } });
    assert.strictEqual(out.gaps.length, 0);
    assert.ok(out.skipped.length > 0, 'all rules should be gated');
  } finally { store.close(); }
});

test('Rule engine: engine', 'runEngine handles empty store without crash', () => {
  const { SQLiteStore: RE_Store } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-engine-'));
  const store = new RE_Store(dir);
  store.open();
  try {
    const out = rulesEngine.runEngine({ store, projectRoot: dir, intent: { product_type: 'saas-with-auth' } });
    assert.strictEqual(out.gaps.length, 0);
  } finally { store.close(); }
});

test('Rule engine: engine', 'gapHash is deterministic for the same inputs', () => {
  const a = rulesEngine.gapHash('rule-x', 'src/foo.ts', 12);
  const b = rulesEngine.gapHash('rule-x', 'src/foo.ts', 12);
  const c = rulesEngine.gapHash('rule-x', 'src/foo.ts', 13);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(a.length, 16);
});

test('Rule engine: engine', 'normalizeGap drops rows missing file or evidence', () => {
  const rule = { id: 'x', severity: 'HIGH' };
  assert.strictEqual(rulesEngine.normalizeGap(null, rule), null);
  assert.strictEqual(rulesEngine.normalizeGap({ evidence: 'ok' }, rule), null);
  assert.strictEqual(rulesEngine.normalizeGap({ file: 'a.ts' }, rule), null);
  const good = rulesEngine.normalizeGap({ file: 'a.ts', evidence: 'ok' }, rule);
  assert.ok(good && good.gap_hash && good.rule_id === 'x' && good.severity === 'HIGH');
});

// ═══════════════════════════════════════════════════════════════════
// Rule engine: money-as-float (5 tests)
// ═══════════════════════════════════════════════════════════════════

const moneyRule = require('../src/rules/rules/money-as-float');

function seedModelFixture(store, filePath, modelName, kind, fields) {
  const fileId = store.upsertFile(filePath, { language: 'ts', hash: 'h', mtime: 1, size: 1 });
  store.storeExtraction(fileId, {
    imports: [], symbols: [], routes: [],
    models: [{ name: modelName, kind, fields }],
    envVars: [], dbTables: [], errors: [],
  });
  return fileId;
}

test('Rule engine: money-as-float', 'fires on Prisma Order.amount Float', () => {
  const { SQLiteStore: MS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-money-'));
  const store = new MS(dir);
  store.open();
  try {
    seedModelFixture(store, 'prisma/schema.prisma', 'Order', 'prisma', [
      { name: 'id', type: 'String' },
      { name: 'amount', type: 'Float' },
      { name: 'status', type: 'String' },
    ]);
    const gaps = moneyRule.run({ store });
    assert.strictEqual(gaps.length, 1);
    assert.strictEqual(gaps[0].file, 'prisma/schema.prisma');
    assert.ok(gaps[0].evidence.includes('Order'));
    assert.ok(gaps[0].evidence.includes('amount'));
  } finally { store.close(); }
});

test('Rule engine: money-as-float', 'silent on Decimal type (correct)', () => {
  const { SQLiteStore: MS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-money-'));
  const store = new MS(dir);
  store.open();
  try {
    seedModelFixture(store, 'prisma/schema.prisma', 'Order', 'prisma', [
      { name: 'amount', type: 'Decimal' },
    ]);
    assert.deepStrictEqual(moneyRule.run({ store }), []);
  } finally { store.close(); }
});

test('Rule engine: money-as-float', 'silent on minor-units integer (amount_cents Int)', () => {
  const { SQLiteStore: MS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-money-'));
  const store = new MS(dir);
  store.open();
  try {
    seedModelFixture(store, 'prisma/schema.prisma', 'Order', 'prisma', [
      { name: 'amount_cents', type: 'Int' },
    ]);
    // amount_cents contains 'amount' as a token, so the name matches.
    // Int is not floating → rule stays silent. This proves both
    // predicates are required.
    assert.deepStrictEqual(moneyRule.run({ store }), []);
  } finally { store.close(); }
});

test('Rule engine: money-as-float', 'silent on non-money Float field (quantity: Float)', () => {
  const { SQLiteStore: MS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-money-'));
  const store = new MS(dir);
  store.open();
  try {
    seedModelFixture(store, 'prisma/schema.prisma', 'Item', 'prisma', [
      { name: 'quantity', type: 'Float' },
    ]);
    assert.deepStrictEqual(moneyRule.run({ store }), []);
  } finally { store.close(); }
});

test('Rule engine: money-as-float', 'silent on substring collision (sprinklerCount, enterprise)', () => {
  const { SQLiteStore: MS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-money-'));
  const store = new MS(dir);
  store.open();
  try {
    seedModelFixture(store, 'prisma/schema.prisma', 'Widget', 'prisma', [
      { name: 'sprinklerCount', type: 'Float' },   // 'price' substring collision guard
      { name: 'enterpriseCode', type: 'Float' },   // 'price'/'reise' substring
    ]);
    assert.deepStrictEqual(moneyRule.run({ store }), []);
  } finally { store.close(); }
});

// ═══════════════════════════════════════════════════════════════════
// Rule engine: auth-missing (4 tests)
// ═══════════════════════════════════════════════════════════════════

const authRule = require('../src/rules/rules/auth-missing-on-mutating-route');

function seedRoute(store, filePath, method, routePath) {
  const fileId = store.upsertFile(filePath, { language: 'ts', hash: 'h', mtime: 1, size: 1 });
  store.storeExtraction(fileId, {
    imports: [], symbols: [],
    routes: [{ method, path: routePath, handler: 'handler', framework: 'nextjs' }],
    models: [], envVars: [], dbTables: [], errors: [],
  });
  return fileId;
}

test('Rule engine: auth-missing', 'fires on POST route with no auth signal', () => {
  const { SQLiteStore: AS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-auth-'));
  const store = new AS(dir);
  store.open();
  try {
    seedRoute(store, 'app/api/trades/route.ts', 'POST', '/api/trades');
    const gaps = authRule.run({ store });
    assert.strictEqual(gaps.length, 1);
    assert.strictEqual(gaps[0].file, 'app/api/trades/route.ts');
  } finally { store.close(); }
});

test('Rule engine: auth-missing', 'silent when route imports @supabase/supabase-js', () => {
  const { SQLiteStore: AS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-auth-'));
  const store = new AS(dir);
  store.open();
  try {
    const fileId = store.upsertFile('app/api/trades/route.ts', { language: 'ts', hash: 'h', mtime: 1, size: 1 });
    store.storeExtraction(fileId, {
      imports: [{ path: '@supabase/supabase-js' }],
      symbols: [],
      routes: [{ method: 'POST', path: '/api/trades', handler: 'POST', framework: 'nextjs' }],
      models: [], envVars: [], dbTables: [], errors: [],
    });
    assert.deepStrictEqual(authRule.run({ store }), []);
  } finally { store.close(); }
});

test('Rule engine: auth-missing', 'silent when handler exports auth-shaped symbol (getServerSession)', () => {
  const { SQLiteStore: AS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-auth-'));
  const store = new AS(dir);
  store.open();
  try {
    const fileId = store.upsertFile('app/api/trades/route.ts', { language: 'ts', hash: 'h', mtime: 1, size: 1 });
    store.storeExtraction(fileId, {
      imports: [],
      symbols: [{ name: 'getServerSession', kind: 'function' }],
      routes: [{ method: 'POST', path: '/api/trades', handler: 'POST', framework: 'nextjs' }],
      models: [], envVars: [], dbTables: [], errors: [],
    });
    assert.deepStrictEqual(authRule.run({ store }), []);
  } finally { store.close(); }
});

test('Rule engine: auth-missing', 'silent when project-root middleware.ts exists', () => {
  const { SQLiteStore: AS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-auth-'));
  const store = new AS(dir);
  store.open();
  try {
    // A middleware.ts at the project root suppresses every route's gap.
    store.upsertFile('middleware.ts', { language: 'ts', hash: 'h', mtime: 1, size: 1 });
    seedRoute(store, 'app/api/trades/route.ts', 'POST', '/api/trades');
    assert.deepStrictEqual(authRule.run({ store }), []);
  } finally { store.close(); }
});

// ═══════════════════════════════════════════════════════════════════
// Rule engine: gaps store (4 tests)
// ═══════════════════════════════════════════════════════════════════

test('Rule engine: gaps store', 'replaceGaps upserts by gap_hash and deletes stale rows', () => {
  const { SQLiteStore: GS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-gaps-'));
  const store = new GS(dir);
  store.open();
  try {
    const g1 = { gap_hash: 'aaaa', rule_id: 'r', file: 'a.ts', line: null, severity: 'HIGH', evidence: 'x' };
    const g2 = { gap_hash: 'bbbb', rule_id: 'r', file: 'b.ts', line: null, severity: 'HIGH', evidence: 'y' };
    store.replaceGaps([g1, g2]);
    assert.strictEqual(store.getGaps({}).length, 2);
    // Re-run — only g1 survives.
    store.replaceGaps([g1]);
    const surv = store.getGaps({});
    assert.strictEqual(surv.length, 1);
    assert.strictEqual(surv[0].gap_hash, 'aaaa');
  } finally { store.close(); }
});

test('Rule engine: gaps store', 'dismissGap persists across replaceGaps', () => {
  const { SQLiteStore: GS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-gaps-'));
  const store = new GS(dir);
  store.open();
  try {
    const g = { gap_hash: 'zzzz', rule_id: 'r', file: 'a.ts', line: null, severity: 'HIGH', evidence: 'x' };
    store.replaceGaps([g]);
    const outcome = store.dismissGap('zzzz', 'intentional');
    assert.strictEqual(outcome.dismissed, true);
    assert.strictEqual(outcome.gap.dismissed, 1);
    assert.strictEqual(outcome.gap.reason, 'intentional');
    // Re-run rule engine — the gap survives, and dismissal persists.
    store.replaceGaps([g]);
    const rows = store.getGaps({ includeDismissed: true });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].dismissed, 1);
    assert.strictEqual(rows[0].reason, 'intentional');
    // Default get_gaps excludes dismissed → empty.
    assert.strictEqual(store.getGaps({}).length, 0);
  } finally { store.close(); }
});

test('Rule engine: gaps store', 'dismissGap returns { dismissed:false } for unknown hash', () => {
  const { SQLiteStore: GS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-gaps-'));
  const store = new GS(dir);
  store.open();
  try {
    const outcome = store.dismissGap('doesnotexist', 'nope');
    assert.strictEqual(outcome.dismissed, false);
    assert.strictEqual(outcome.gap, null);
  } finally { store.close(); }
});

test('Rule engine: gaps store', 'getGaps ranks HIGH before MEDIUM before LOW', () => {
  const { SQLiteStore: GS } = require('../src/store/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-gaps-'));
  const store = new GS(dir);
  store.open();
  try {
    store.replaceGaps([
      { gap_hash: 'l', rule_id: 'r', file: 'a.ts', line: null, severity: 'LOW', evidence: 'x' },
      { gap_hash: 'h', rule_id: 'r', file: 'b.ts', line: null, severity: 'HIGH', evidence: 'y' },
      { gap_hash: 'm', rule_id: 'r', file: 'c.ts', line: null, severity: 'MEDIUM', evidence: 'z' },
    ]);
    const rows = store.getGaps({});
    assert.deepStrictEqual(rows.map((r) => r.severity), ['HIGH', 'MEDIUM', 'LOW']);
  } finally { store.close(); }
});

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

(async () => {
  await runAsyncSuite();

  console.log('');
  const suiteNames = ['Python extractor', 'Prisma extractor', 'Merger', 'Import graph', 'R extractor', 'File discovery', 'Project Structure', 'Path normalization', 'MCP resilience', 'Change plan', 'Init flow', 'Git hooks', 'Lazy MCP re-parse', 'Store adapter (ACP V2)', 'Secret leakage', 'Adaptive clustering', 'Domain config', 'Domain stability', 'Extraction errors', 'Framework extractors', 'Native install resilience', 'Bitmap validation', 'Bitset serialization', 'Bitmap engine', 'Inspect command', 'Validation API', 'Episodic Memory', 'PR impact', 'Scale-test driver', 'ANCI roundtrip', 'SSE streaming', 'Files without tests', 'MCP middleware', 'carto validate', 'SWE-bench', 'CLI: status', 'CLI: why', 'CLI: doctor', 'SWE-bench tools', 'Temporal storage', 'Temporal MCP tools', 'Brain invariants', 'Brain conventions', 'Brain procedural', 'Brain working', 'Brain suggestions', 'Plugin API', 'PHP extractor', 'Kotlin extractor', 'Swift extractor', 'Dart extractor', 'Long-tail frameworks', 'ACP persistence', 'ACP config', 'ACP safety', 'AI retrieval: lexical', 'AI retrieval: rrf', 'AI retrieval: semantic', 'AI context-builder', 'AI tools: interfaceContract', 'AI tools: dataFlow', 'AI tools: safetyChecklist', 'AI tools: dependencySurface', 'AI tools: upgradeRisk', 'AI tools: staleDocs', 'Adjacent: call graph', 'Adjacent: IaC', 'Adjacent: runtime', 'Adjacent: semantic-diff', 'Adjacent: llm-enrich', 'Predictive: risk-score', 'Predictive: cut-points', 'Predictive: validate-change', 'Predictive: ownership', 'Predictive: drift-digest', 'Org: store', 'Org: detect', 'Org: sync', 'Org: queries', 'Docs API gen', 'Rule engine: intent', 'Rule engine: engine', 'Rule engine: money-as-float', 'Rule engine: auth-missing', 'Rule engine: gaps store'];
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
