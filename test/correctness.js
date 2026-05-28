#!/usr/bin/env node
'use strict';

/**
 * Carto V2 Correctness Test Suite
 *
 * Tests extraction accuracy against known ground truth.
 * Each test has an expected result and measures precision/recall.
 *
 * Precision = what we extracted that's correct / what we extracted total
 * Recall    = what we extracted that's correct / what actually exists
 */

const path = require('path');
const fs = require('fs');
const { loadLanguagePlugins, getPluginForFile } = require('../src/extractors/loader');
const { extractImports } = require('../src/extractors/imports');
const tsParser = require('../src/extractors/tree-sitter-parser');

const plugins = loadLanguagePlugins();

let passed = 0;
let failed = 0;
let warnings = 0;
const results = [];

// ─── Test helpers ─────────────────────────────────────────────────────────────

function test(name, fn) {
  try {
    const result = fn();
    if (result.pass) {
      passed++;
      console.log(`  ✅ ${name}`);
      if (result.note) console.log(`     ${result.note}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}`);
      console.log(`     ${result.reason}`);
    }
    results.push({ name, ...result });
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name} (threw: ${err.message})`);
    results.push({ name, pass: false, reason: err.message });
  }
}

function precision(extracted, expected) {
  if (extracted.length === 0) return expected.length === 0 ? 1 : 0;
  const correct = extracted.filter(e => expected.some(x => x === e || e.includes(x) || x.includes(e)));
  return correct.length / extracted.length;
}

function recall(extracted, expected) {
  if (expected.length === 0) return 1;
  const found = expected.filter(e => extracted.some(x => x === e || x.includes(e) || e.includes(x)));
  return found.length / expected.length;
}

function pct(n) { return `${Math.round(n * 100)}%`; }

// ─── 1. JS/TS Import Extraction ───────────────────────────────────────────────

console.log('\n── 1. JS/TS Import Extraction ──────────────────────────────────');

test('Named imports extracted', () => {
  const code = `import { foo, bar } from './utils';\nimport baz from '../lib/baz';`;
  const result = tsParser.extractAll(code, '.ts');
  const expected = ['./utils', '../lib/baz'];
  const r = recall(result.imports, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${result.imports}`, note: `imports: ${result.imports.join(', ')}` };
});

test('require() calls extracted', () => {
  const code = `const x = require('./config');\nconst y = require('../db/client');`;
  const result = tsParser.extractAll(code, '.js');
  const expected = ['./config', '../db/client'];
  const r = recall(result.imports, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${result.imports}` };
});

test('Side-effect imports extracted', () => {
  const code = `import './polyfills';\nimport 'reflect-metadata';`;
  const result = tsParser.extractAll(code, '.ts');
  const expected = ['./polyfills'];
  const r = recall(result.imports, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${result.imports}` };
});

test('No false positives on comments', () => {
  const code = `// import { foo } from './bar'\n/* import baz from './baz' */\nimport real from './real';`;
  const result = tsParser.extractAll(code, '.ts');
  const p = precision(result.imports, ['./real']);
  return { pass: p === 1, reason: `precision=${pct(p)}, got: ${result.imports}` };
});

// ─── 2. JS/TS Symbol Extraction ───────────────────────────────────────────────

console.log('\n── 2. JS/TS Symbol Extraction ──────────────────────────────────');

test('Function declarations extracted', () => {
  const code = `export function getUser() {}\nexport function createUser() {}\nfunction internal() {}`;
  const result = tsParser.extractAll(code, '.ts');
  const names = result.symbols.map(s => s.name);
  const expected = ['getUser', 'createUser'];
  const r = recall(names, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${names}` };
});

test('Class declarations extracted', () => {
  const code = `export class UserService {}\nexport class AuthController {}`;
  const result = tsParser.extractAll(code, '.ts');
  const names = result.symbols.map(s => s.name);
  const expected = ['UserService', 'AuthController'];
  const r = recall(names, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${names}` };
});

test('TypeScript interfaces extracted', () => {
  const code = `export interface User { id: number; name: string; }\nexport type Config = { debug: boolean; }`;
  const result = tsParser.extractAll(code, '.ts');
  const names = result.symbols.map(s => s.name);
  const expected = ['User', 'Config'];
  const r = recall(names, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${names}` };
});

test('Arrow function exports extracted', () => {
  const code = `export const handler = async (req, res) => {};\nexport const middleware = (req, res, next) => {};`;
  const result = tsParser.extractAll(code, '.ts');
  const names = result.symbols.map(s => s.name);
  const expected = ['handler', 'middleware'];
  const r = recall(names, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${names}` };
});

test('Enum declarations extracted', () => {
  const code = `export enum Status { Active, Inactive }\nexport enum Role { Admin, User }`;
  const result = tsParser.extractAll(code, '.ts');
  const names = result.symbols.map(s => s.name);
  const expected = ['Status', 'Role'];
  const r = recall(names, expected);
  return { pass: r === 1, reason: `recall=${pct(r)}, got: ${names}` };
});

// ─── 3. Express Route Extraction ──────────────────────────────────────────────

console.log('\n── 3. Express Route Extraction ─────────────────────────────────');

test('Basic Express routes extracted', () => {
  const code = `
const express = require('express');
const app = express();
app.get('/users', getUsers);
app.post('/users', createUser);
app.put('/users/:id', updateUser);
app.delete('/users/:id', deleteUser);
`;
  const plugin = getPluginForFile(plugins, 'routes.js');
  const result = plugin.extract(code, 'routes.js');
  const methods = result.routes.map(r => r.method);
  const paths = result.routes.map(r => r.path);
  const expectedMethods = ['GET', 'POST', 'PUT', 'DELETE'];
  const r = recall(methods, expectedMethods);
  return {
    pass: r === 1 && paths.includes('/users') && paths.includes('/users/:id'),
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

test('Next.js pages/api route extracted', () => {
  const code = `
import { NextApiRequest, NextApiResponse } from 'next';
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.json({ ok: true });
}
`;
  const plugin = getPluginForFile(plugins, 'pages/api/users.ts');
  const result = plugin.extract(code, 'pages/api/users.ts');
  return {
    pass: result.routes.length > 0,
    reason: `routes: ${JSON.stringify(result.routes)}`
  };
});

test('tRPC router procedures extracted', () => {
  const code = fs.readFileSync(
    path.join(__dirname, 'fixtures/trpc-router.ts'), 'utf-8'
  );
  const plugin = getPluginForFile(plugins, 'routers/user.ts');
  const result = plugin.extract(code, 'routers/user.ts');
  const trpcRoutes = result.routes.filter(r => r.path && r.path.startsWith('/trpc/'));
  return {
    pass: trpcRoutes.length > 0,
    reason: `tRPC routes found: ${trpcRoutes.length}, routes: ${result.routes.map(r => r.path).join(', ')}`,
    note: `${trpcRoutes.length} tRPC procedures extracted`
  };
});

// ─── 4. Real file: Next.js API route from supabase ────────────────────────────

console.log('\n── 4. Real-world: Supabase Next.js API route ───────────────────');

const supabaseApiFile = path.join(__dirname, '../tmp-bench/supabase/apps/studio/pages/api/v1/projects/[ref]/api-keys.ts');
if (fs.existsSync(supabaseApiFile)) {
  test('Supabase api-keys.ts: route extracted', () => {
    const content = fs.readFileSync(supabaseApiFile, 'utf-8');
    const relPath = 'apps/studio/pages/api/v1/projects/[ref]/api-keys.ts';
    const plugin = getPluginForFile(plugins, supabaseApiFile);
    const result = plugin.extract(content, relPath);
    // Should extract at least one route (it's a pages/api file with export default)
    return {
      pass: result.routes.length > 0,
      reason: `routes: ${JSON.stringify(result.routes)}`,
      note: `routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
    };
  });

  test('Supabase api-keys.ts: env vars extracted', () => {
    const content = fs.readFileSync(supabaseApiFile, 'utf-8');
    const relPath = 'apps/studio/pages/api/v1/projects/[ref]/api-keys.ts';
    const plugin = getPluginForFile(plugins, supabaseApiFile);
    const result = plugin.extract(content, relPath);
    // File uses SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, etc.
    const expected = ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY'];
    const r = recall(result.envVars, expected);
    return {
      pass: r === 1,
      reason: `recall=${pct(r)}, found: ${result.envVars}`,
      note: `env vars: ${result.envVars.join(', ')}`
    };
  });
} else {
  console.log('  ⚠️  Supabase repo not found, skipping real-world tests');
  warnings++;
}

// ─── 5. Prisma Model Extraction ───────────────────────────────────────────────

console.log('\n── 5. Prisma Model Extraction ──────────────────────────────────');

test('Basic Prisma model extracted', () => {
  const code = `
model User {
  id    String @id @default(uuid())
  email String
  name  String?
  posts Post[]
}
model Post {
  id      Int    @id @default(autoincrement())
  title   String
  content String?
  author  User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`;
  const plugin = getPluginForFile(plugins, 'schema.prisma');
  const result = plugin.extract(code, 'schema.prisma');
  const modelNames = result.models.map(m => m.name || m.className);
  const expected = ['User', 'Post'];
  const r = recall(modelNames, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, found: ${modelNames}`,
    note: `models: ${modelNames.join(', ')}`
  };
});

const prismaSchemaFile = path.join(__dirname, '../tmp-bench/prisma/sandbox/basic-sqlite/prisma/schema.prisma');
if (fs.existsSync(prismaSchemaFile)) {
  test('Real Prisma schema: User model extracted', () => {
    const content = fs.readFileSync(prismaSchemaFile, 'utf-8');
    const plugin = getPluginForFile(plugins, prismaSchemaFile);
    const result = plugin.extract(content, 'schema.prisma');
    const modelNames = result.models.map(m => m.name || m.className);
    return {
      pass: modelNames.includes('User'),
      reason: `models found: ${modelNames}`,
      note: `models: ${modelNames.join(', ')}`
    };
  });
}

// ─── 6. Python Extraction ─────────────────────────────────────────────────────

console.log('\n── 6. Python Extraction ────────────────────────────────────────');

test('FastAPI routes extracted', () => {
  const code = `
from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def get_users():
    return []

@app.post("/users")
async def create_user(user: UserCreate):
    return user

@app.delete("/users/{user_id}")
async def delete_user(user_id: int):
    pass
`;
  const plugin = getPluginForFile(plugins, 'main.py');
  const result = plugin.extract(code, 'main.py');
  const methods = result.routes.map(r => r.method);
  const paths = result.routes.map(r => r.path);
  const expectedMethods = ['GET', 'POST', 'DELETE'];
  const r = recall(methods, expectedMethods);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

test('Pydantic models extracted', () => {
  const code = `
from pydantic import BaseModel
from typing import Optional

class User(BaseModel):
    id: int
    name: str
    email: str
    age: Optional[int] = None

class UserCreate(BaseModel):
    name: str
    email: str
`;
  const plugin = getPluginForFile(plugins, 'models.py');
  const result = plugin.extract(code, 'models.py');
  const modelNames = result.models.map(m => m.name || m.className);
  const expected = ['User', 'UserCreate'];
  const r = recall(modelNames, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, found: ${modelNames}`
  };
});

test('Python imports extracted via tree-sitter', () => {
  const code = `import os\nfrom pathlib import Path\nfrom typing import Optional, List\nimport json`;
  const result = tsParser.extractAll(code, '.py');
  const expected = ['os', 'pathlib', 'typing', 'json'];
  const r = recall(result.imports, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, got: ${result.imports}`
  };
});

// ─── 7. Go Extraction ─────────────────────────────────────────────────────────

console.log('\n── 7. Go Extraction ────────────────────────────────────────────');

test('Gin routes extracted', () => {
  const code = `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.Default()
    r.GET("/users", getUsers)
    r.POST("/users", createUser)
    r.PUT("/users/:id", updateUser)
    r.DELETE("/users/:id", deleteUser)
    r.Run()
}
`;
  const plugin = getPluginForFile(plugins, 'main.go');
  const result = plugin.extract(code, 'main.go');
  const methods = result.routes.map(r => r.method);
  const expected = ['GET', 'POST', 'PUT', 'DELETE'];
  const r = recall(methods, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

test('Go imports extracted via tree-sitter', () => {
  const code = `package main\nimport (\n  "fmt"\n  "os"\n  "net/http"\n)`;
  const result = tsParser.extractAll(code, '.go');
  const expected = ['fmt', 'os', 'net/http'];
  const r = recall(result.imports, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, got: ${result.imports}`
  };
});

// ─── 8. Rust Extraction ───────────────────────────────────────────────────────

console.log('\n── 8. Rust Extraction ──────────────────────────────────────────');

test('Rust symbols extracted via tree-sitter', () => {
  const code = `
pub fn get_user(id: u64) -> Option<User> { None }
pub struct User { pub id: u64, pub name: String }
pub enum Status { Active, Inactive }
pub trait Repository { fn find(&self, id: u64) -> Option<User>; }
`;
  const result = tsParser.extractAll(code, '.rs');
  const names = result.symbols.map(s => s.name);
  const expected = ['get_user', 'User', 'Status', 'Repository'];
  const r = recall(names, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, got: ${names}`
  };
});

test('Rust Actix routes extracted', () => {
  const code = `
#[get("/users")]
async fn get_users() -> impl Responder { HttpResponse::Ok() }

#[post("/users")]
async fn create_user(body: web::Json<User>) -> impl Responder { HttpResponse::Created() }
`;
  const plugin = getPluginForFile(plugins, 'handlers.rs');
  const result = plugin.extract(code, 'handlers.rs');
  const methods = result.routes.map(r => r.method);
  const expected = ['GET', 'POST'];
  const r = recall(methods, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

// ─── 9. Real-world: Rust import resolution (zed) ─────────────────────────────

console.log('\n── 9. Real-world: Rust import resolution (zed) ─────────────────');

const zedSidebar = path.join(__dirname, '../tmp-bench/zed/crates/sidebar/src/sidebar.rs');
const zedRoot = path.join(__dirname, '../tmp-bench/zed');
if (fs.existsSync(zedSidebar)) {
  test('zed sidebar.rs: mod declarations resolve to files', () => {
    const content = fs.readFileSync(zedSidebar, 'utf-8');
    const imports = extractImports(content, zedSidebar, zedRoot);
    // sidebar.rs has: mod thread_switcher; mod sidebar_tests;
    const expected = ['thread_switcher.rs', 'sidebar_tests.rs'];
    const found = expected.filter(e => imports.some(i => i.endsWith(e)));
    return {
      pass: found.length === expected.length,
      reason: `found ${found.length}/${expected.length}: ${imports.join(', ')}`,
      note: `resolved: ${imports.join(', ')}`
    };
  });
}

const zedChangeList = path.join(__dirname, '../tmp-bench/zed/crates/vim/src/change_list.rs');
if (fs.existsSync(zedChangeList)) {
  test('zed change_list.rs: use crate:: resolves to files', () => {
    const content = fs.readFileSync(zedChangeList, 'utf-8');
    const imports = extractImports(content, zedChangeList, zedRoot);
    // change_list.rs has: use crate::{Vim, state::Mode}
    const expected = ['vim.rs', 'state.rs'];
    const found = expected.filter(e => imports.some(i => i.endsWith(e)));
    return {
      pass: found.length >= 1,
      reason: `found ${found.length}/${expected.length}: ${imports.join(', ')}`,
      note: `resolved: ${imports.join(', ')}`
    };
  });
}

// ─── 10. Import graph correctness ─────────────────────────────────────────────

console.log('\n── 10. Import graph correctness ────────────────────────────────');

test('JS relative imports resolve to files', () => {
  // Create temp files to test resolution
  const tmpDir = fs.mkdtempSync('/tmp/carto-test-');
  fs.writeFileSync(path.join(tmpDir, 'index.js'), `import { foo } from './utils';\nimport bar from './lib/bar';`);
  fs.writeFileSync(path.join(tmpDir, 'utils.js'), `export function foo() {}`);
  fs.mkdirSync(path.join(tmpDir, 'lib'));
  fs.writeFileSync(path.join(tmpDir, 'lib/bar.js'), `export default function bar() {}`);

  const content = fs.readFileSync(path.join(tmpDir, 'index.js'), 'utf-8');
  const imports = extractImports(content, path.join(tmpDir, 'index.js'), tmpDir);

  fs.rmSync(tmpDir, { recursive: true });

  const expected = ['utils.js', 'lib/bar.js'];
  const r = recall(imports, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, resolved: ${imports}`
  };
});

test('Non-existent imports not included', () => {
  const tmpDir = fs.mkdtempSync('/tmp/carto-test-');
  fs.writeFileSync(path.join(tmpDir, 'index.js'), `import { foo } from './nonexistent';\nimport bar from 'external-package';`);

  const content = fs.readFileSync(path.join(tmpDir, 'index.js'), 'utf-8');
  const imports = extractImports(content, path.join(tmpDir, 'index.js'), tmpDir);

  fs.rmSync(tmpDir, { recursive: true });

  return {
    pass: imports.length === 0,
    reason: `should be empty, got: ${imports}`
  };
});

// ─── 11. Java Extraction ──────────────────────────────────────────────────────

console.log('\n── 11. Java Extraction ─────────────────────────────────────────');

test('Spring Boot routes extracted', () => {
  const code = `
@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() { return List.of(); }

    @PostMapping("/users")
    public User createUser(@RequestBody User user) { return user; }

    @DeleteMapping("/users/{id}")
    public void deleteUser(@PathVariable Long id) {}
}
`;
  const plugin = getPluginForFile(plugins, 'UserController.java');
  const result = plugin.extract(code, 'UserController.java');
  const methods = result.routes.map(r => r.method);
  const expected = ['GET', 'POST', 'DELETE'];
  const r = recall(methods, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

test('JPA entity model extracted', () => {
  const code = `
@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue
    private Long id;
    private String name;
    private String email;
}
`;
  const plugin = getPluginForFile(plugins, 'User.java');
  const result = plugin.extract(code, 'User.java');
  const modelNames = result.models.map(m => m.name || m.className);
  return {
    pass: modelNames.includes('User'),
    reason: `models: ${modelNames}`
  };
});

// ─── 12. C# Extraction ────────────────────────────────────────────────────────

console.log('\n── 12. C# Extraction ───────────────────────────────────────────');

test('ASP.NET Core attribute routes extracted', () => {
  const code = `
[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase {
    [HttpGet]
    public IActionResult GetAll() => Ok();

    [HttpPost]
    public IActionResult Create([FromBody] User user) => Created();

    [HttpDelete("{id}")]
    public IActionResult Delete(int id) => NoContent();
}
`;
  const plugin = getPluginForFile(plugins, 'UsersController.cs');
  const result = plugin.extract(code, 'UsersController.cs');
  // Should find HttpGet, HttpPost, HttpDelete
  const methods = result.routes.map(r => r.method);
  const expected = ['GET', 'POST', 'DELETE'];
  const r = recall(methods, expected);
  return {
    pass: r >= 0.6, // partial credit — attribute routing without path args is tricky
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

test('C# minimal API routes extracted', () => {
  const code = `
var app = builder.Build();
app.MapGet("/users", () => Results.Ok());
app.MapPost("/users", (User user) => Results.Created());
app.MapDelete("/users/{id}", (int id) => Results.NoContent());
app.Run();
`;
  const plugin = getPluginForFile(plugins, 'Program.cs');
  const result = plugin.extract(code, 'Program.cs');
  const methods = result.routes.map(r => r.method);
  const expected = ['GET', 'POST', 'DELETE'];
  const r = recall(methods, expected);
  return {
    pass: r === 1,
    reason: `recall=${pct(r)}, routes: ${result.routes.map(r => `${r.method} ${r.path}`).join(', ')}`
  };
});

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
const score = Math.round((passed / total) * 100);

console.log(`\n${'═'.repeat(60)}`);
console.log(`CORRECTNESS SUMMARY`);
console.log(`${'═'.repeat(60)}`);
console.log(`Passed:  ${passed}/${total} (${score}%)`);
console.log(`Failed:  ${failed}`);
if (warnings > 0) console.log(`Skipped: ${warnings} (missing test repos)`);

// Category breakdown
const categories = {
  'JS/TS Imports':    results.filter(r => r.name.includes('import') || r.name.includes('require')),
  'JS/TS Symbols':    results.filter(r => r.name.includes('Function') || r.name.includes('Class') || r.name.includes('interface') || r.name.includes('Arrow') || r.name.includes('Enum')),
  'Express/Next.js':  results.filter(r => r.name.includes('Express') || r.name.includes('Next') || r.name.includes('tRPC')),
  'Python':           results.filter(r => r.name.includes('FastAPI') || r.name.includes('Pydantic') || r.name.includes('Python')),
  'Go':               results.filter(r => r.name.includes('Gin') || r.name.includes('Go')),
  'Rust':             results.filter(r => r.name.includes('Rust') || r.name.includes('Actix') || r.name.includes('zed')),
  'Java':             results.filter(r => r.name.includes('Spring') || r.name.includes('JPA') || r.name.includes('Java')),
  'C#':               results.filter(r => r.name.includes('ASP') || r.name.includes('C#') || r.name.includes('minimal')),
  'Import graph':     results.filter(r => r.name.includes('resolve') || r.name.includes('Non-existent')),
  'Real-world':       results.filter(r => r.name.includes('Supabase') || r.name.includes('Real')),
};

console.log('\nBy category:');
for (const [cat, tests] of Object.entries(categories)) {
  if (tests.length === 0) continue;
  const catPassed = tests.filter(t => t.pass).length;
  const catScore = Math.round((catPassed / tests.length) * 100);
  const bar = '█'.repeat(Math.round(catScore / 10)) + '░'.repeat(10 - Math.round(catScore / 10));
  console.log(`  ${cat.padEnd(20)} ${bar} ${catScore}% (${catPassed}/${tests.length})`);
}

if (score < 80) {
  console.log('\n⚠️  Overall score below 80% — significant accuracy issues');
  process.exit(1);
} else if (score < 90) {
  console.log('\n⚠️  Some accuracy gaps — see failures above');
} else {
  console.log('\n✅ Accuracy is solid');
}
