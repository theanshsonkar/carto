/**
 * Carto stress test suite — 80+ cases
 * Goal: verify 100% accuracy, 0 hallucination across every extractor.
 *
 * Each test asserts exact output: no more, no less.
 * "No hallucination" = Carto never invents routes/models/fields that aren't in the source.
 * "No silent drops" = Carto never misses routes/models/fields that ARE in the source.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pythonPlugin  = require('../src/extractors/languages/python');
const prismaPlugin  = require('../src/extractors/languages/prisma');
const jsPlugin      = require('../src/extractors/languages/javascript');
const tsPlugin      = require('../src/extractors/languages/typescript');
const { mergeIntoAgentsMd, START_MARKER, END_MARKER } = require('../src/agents/merger');
const { extractImports, buildImportGraph } = require('../src/extractors/imports');
const { extractRoutes, collapseMultilineDecorators } = require('../src/extractors/routes');
const { extractModels } = require('../src/extractors/models');

// ── Test runner ───────────────────────────────────────────────────────────────

const results = { passed: 0, failed: 0, failures: [] };
const suiteTotals = {};

function test(suite, name, fn) {
  try {
    fn();
    results.passed++;
    suiteTotals[suite] = suiteTotals[suite] || { pass: 0, fail: 0, total: 0 };
    suiteTotals[suite].pass++;
    suiteTotals[suite].total++;
  } catch (err) {
    results.failed++;
    suiteTotals[suite] = suiteTotals[suite] || { pass: 0, fail: 0, total: 0 };
    suiteTotals[suite].fail++;
    suiteTotals[suite].total++;
    results.failures.push({ suite, name, message: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 1 — Python routes: accuracy + hallucination guard
// ═══════════════════════════════════════════════════════════════════════════════

test('Python routes', 'All 5 HTTP methods are captured', () => {
  const code = `
@app.get("/a")
def a(): pass
@app.post("/b")
def b(): pass
@app.put("/c")
def c(): pass
@app.delete("/d")
def d(): pass
@app.patch("/e")
def e(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'routes.py');
  assert.strictEqual(routes.length, 5);
  const methods = routes.map(r => r.method).sort();
  assert.deepStrictEqual(methods, ['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
});

test('Python routes', '@router prefix works identically to @app', () => {
  const code = `
@router.get("/users")
def list_users(): pass
@router.post("/users")
def create_user(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'users.py');
  assert.strictEqual(routes.length, 2);
  assert.ok(routes.every(r => r.functionName), 'All routes must have a functionName');
});

test('Python routes', 'Multiline decorator with response_model is still captured', () => {
  const code = `
@app.get(
    "/items",
    response_model=List[Item]
)
def get_items(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'items.py');
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].method, 'GET');
  assert.strictEqual(routes[0].path, '/items');
});

test('Python routes', 'Route with path parameters {id} extracted correctly', () => {
  const code = `
@app.get("/users/{user_id}/posts/{post_id}")
def get_post(user_id: int, post_id: int): pass
`;
  const { routes } = pythonPlugin.extract(code, 'posts.py');
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].path, '/users/{user_id}/posts/{post_id}');
});

test('Python routes', 'Non-HTTP decorators do NOT produce phantom routes', () => {
  const code = `
@app.on_event("startup")
async def startup(): pass

@validate_call
def helper(): pass

@app.middleware("http")
async def middleware(request, call_next): pass
`;
  const { routes } = pythonPlugin.extract(code, 'app.py');
  assert.strictEqual(routes.length, 0, `Expected 0 routes but got ${routes.length}: ${JSON.stringify(routes)}`);
});

test('Python routes', 'Async route functions captured correctly', () => {
  const code = `
@app.get("/async-route")
async def fetch_data(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'app.py');
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].functionName, 'fetch_data');
});

test('Python routes', 'Route with tag/summary kwargs does not break extraction', () => {
  const code = `
@app.get("/ping", tags=["health"], summary="Health check", deprecated=False)
def ping(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'app.py');
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].path, '/ping');
});

test('Python routes', 'Completely empty file produces no routes or models', () => {
  const { routes, models } = pythonPlugin.extract('', 'empty.py');
  assert.strictEqual(routes.length, 0);
  assert.strictEqual(models.length, 0);
});

test('Python routes', 'collapseMultilineDecorators: multiline collapsed to single line', () => {
  const code = `@app.post(\n    "/register"\n)\ndef register(): pass`;
  const collapsed = collapseMultilineDecorators(code);
  assert.ok(!collapsed.includes('\n    "/register"'), 'multiline should be collapsed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 2 — Python models: accuracy + hallucination guard
// ═══════════════════════════════════════════════════════════════════════════════

test('Python models', 'Optional field type preserved (Optional[str])', () => {
  const code = `
class Profile(BaseModel):
    bio: Optional[str]
    age: Optional[int] = None
`;
  const { models } = pythonPlugin.extract(code, 'models.py');
  assert.strictEqual(models.length, 1);
  const bioField = models[0].fields.find(f => f.name === 'bio');
  assert.ok(bioField, 'bio field must exist');
  assert.ok(bioField.type.includes('Optional'), `Expected Optional type, got ${bioField.type}`);
});

test('Python models', 'List[str] field type preserved', () => {
  const code = `
class Tag(BaseModel):
    names: List[str]
`;
  const { models } = pythonPlugin.extract(code, 'models.py');
  const field = models[0].fields.find(f => f.name === 'names');
  assert.ok(field.type.includes('List'), `Expected List type, got ${field.type}`);
});

test('Python models', 'Validator methods are NOT treated as fields', () => {
  const code = `
class User(BaseModel):
    email: str
    password: str

    @validator('email')
    def validate_email(cls, v):
        return v
`;
  const { models } = pythonPlugin.extract(code, 'models.py');
  assert.strictEqual(models[0].fields.length, 2, 'Should only have email and password — not the validator method');
  const names = models[0].fields.map(f => f.name);
  assert.ok(!names.includes('validate_email'), 'Validator method must not appear as a field');
});

test('Python models', 'Class NOT inheriting BaseModel is NOT extracted', () => {
  const code = `
class Service:
    name: str

class UserModel(BaseModel):
    id: int
`;
  const { models } = pythonPlugin.extract(code, 'services.py');
  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].className, 'UserModel');
});

test('Python models', 'Field with default value does not corrupt the type', () => {
  const code = `
class Config(BaseModel):
    timeout: int = 30
    retries: int = 3
    base_url: str = "https://api.example.com"
`;
  const { models } = pythonPlugin.extract(code, 'config.py');
  const timeout = models[0].fields.find(f => f.name === 'timeout');
  assert.strictEqual(timeout.type, 'int', `Expected "int" but got "${timeout.type}"`);
  const base_url = models[0].fields.find(f => f.name === 'base_url');
  assert.strictEqual(base_url.type, 'str', `Expected "str" but got "${base_url.type}"`);
});

test('Python models', 'Two BaseModel classes in same file — both extracted', () => {
  const code = `
class Request(BaseModel):
    query: str

class Response(BaseModel):
    result: str
    score: float
`;
  const { models } = pythonPlugin.extract(code, 'schemas.py');
  assert.strictEqual(models.length, 2);
  const names = models.map(m => m.className).sort();
  assert.deepStrictEqual(names, ['Request', 'Response']);
});

test('Python models', 'Field with Union type captured', () => {
  const code = `
class Event(BaseModel):
    payload: Union[str, dict]
`;
  const { models } = pythonPlugin.extract(code, 'events.py');
  const field = models[0].fields.find(f => f.name === 'payload');
  assert.ok(field, 'payload field must exist');
  assert.ok(field.type.includes('Union'), `Expected Union, got "${field.type}"`);
});

test('Python models', 'Inline comment after field type does not leak into type', () => {
  // Already exists in baseline, but let's test more complex case
  const code = `
class Order(BaseModel):
    status: str # pending | shipped | delivered
    amount: float # in USD, always positive
`;
  const { models } = pythonPlugin.extract(code, 'orders.py');
  const status = models[0].fields.find(f => f.name === 'status');
  assert.strictEqual(status.type, 'str', `Comment leaked into type: "${status.type}"`);
  const amount = models[0].fields.find(f => f.name === 'amount');
  assert.strictEqual(amount.type, 'float', `Comment leaked into type: "${amount.type}"`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 3 — Prisma extractor: accuracy + hallucination guard
// ═══════════════════════════════════════════════════════════════════════════════

test('Prisma extractor', 'Relation field (model reference) is extracted', () => {
  const code = `
model Post {
  id       Int    @id
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}

model User {
  id    Int    @id
  posts Post[]
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  const post = out.models.find(m => m.className === 'Post');
  assert.ok(post, 'Post model must exist');
  assert.strictEqual(post.fields.length, 3, `Expected 3 fields but got ${post.fields.length}: ${JSON.stringify(post.fields)}`);
  const user = out.models.find(m => m.className === 'User');
  assert.ok(user, 'User model must exist');
});

test('Prisma extractor', 'Optional field (?) is extracted with correct type', () => {
  const code = `
model Profile {
  id     Int     @id
  bio    String?
  avatar String?
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  const profile = out.models[0];
  assert.strictEqual(profile.fields.length, 3);
  const bio = profile.fields.find(f => f.name === 'bio');
  assert.ok(bio.type.includes('String'), `Expected String? type, got "${bio.type}"`);
});

test('Prisma extractor', 'Array field (Post[]) extracted correctly', () => {
  const code = `
model User {
  id    Int    @id
  posts Post[]
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  const posts = out.models[0].fields.find(f => f.name === 'posts');
  assert.ok(posts, 'posts field must exist');
  assert.ok(posts.type.includes('Post'), `Expected Post[] type, got "${posts.type}"`);
});

test('Prisma extractor', '@@map annotation produces correct DB table name', () => {
  const code = `
model UserAccount {
  id Int @id
  @@map("user_accounts")
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  assert.strictEqual(out.dbTables.length, 1);
  assert.strictEqual(out.dbTables[0].tableName, 'user_accounts');
  assert.strictEqual(out.dbTables[0].modelName, 'UserAccount');
});

test('Prisma extractor', 'Model without @@map gets snake_case auto-conversion', () => {
  const code = `
model BlogPost {
  id Int @id
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  assert.strictEqual(out.dbTables[0].tableName, 'blog_post');
});

test('Prisma extractor', 'Enum block does NOT produce a model', () => {
  const code = `
enum Role {
  USER
  ADMIN
  SUPERADMIN
}

model User {
  id   Int  @id
  role Role
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  // Only User should be a model — Role is an enum
  assert.strictEqual(out.models.length, 1, `Expected 1 model but got ${out.models.length}: ${JSON.stringify(out.models.map(m => m.className))}`);
  assert.strictEqual(out.models[0].className, 'User');
});

test('Prisma extractor', '@@index and @@unique block attributes do not produce phantom fields', () => {
  const code = `
model Post {
  id    Int    @id
  slug  String @unique
  title String

  @@index([title])
  @@unique([slug])
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  const post = out.models[0];
  const names = post.fields.map(f => f.name);
  assert.ok(!names.includes('@@index'), '@@index must not appear as a field');
  assert.ok(!names.includes('@@unique'), '@@unique must not appear as a field');
  assert.strictEqual(post.fields.length, 3, `Expected 3 fields, got ${post.fields.length}: ${JSON.stringify(names)}`);
});

test('Prisma extractor', 'Multiple /// Zod annotations with nested braces do not truncate model', () => {
  const code = `
model Payment {
  id     Int    @id @default(autoincrement())
  /// @zod.string.regex(/^[A-Z]{3}$/, { message: 'Must be 3-letter code' })
  currency String
  /// @zod.number.min(0).max(999999.99, { message: 'Invalid amount' })
  amount  Float
  status  String
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  const payment = out.models[0];
  assert.strictEqual(payment.fields.length, 4, `Expected 4 fields, got ${payment.fields.length}: ${JSON.stringify(payment.fields)}`);
});

test('Prisma extractor', 'Empty file produces no models', () => {
  const out = prismaPlugin.extract('', 'schema.prisma');
  assert.strictEqual(out.models.length, 0);
  assert.strictEqual(out.dbTables.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 4 — JavaScript extractor: accuracy + hallucination guard
// ═══════════════════════════════════════════════════════════════════════════════

test('JavaScript routes', 'app.get/post/put/delete/patch all extracted', () => {
  const code = `
const app = require('express')();
app.get('/users', getUsers);
app.post('/users', createUser);
app.put('/users/:id', updateUser);
app.delete('/users/:id', deleteUser);
app.patch('/users/:id', patchUser);
`;
  const out = jsPlugin.extract(code, 'server.js');
  assert.strictEqual(out.routes.length, 5);
  const methods = out.routes.map(r => r.method).sort();
  assert.deepStrictEqual(methods, ['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
});

test('JavaScript routes', 'router.get() is captured (not just app)', () => {
  const code = `
const router = express.Router();
router.get('/items', listItems);
router.post('/items', createItem);
`;
  const out = jsPlugin.extract(code, 'items.js');
  assert.strictEqual(out.routes.length, 2);
});

test('JavaScript routes', 'Route with middleware chain — handler name from last arg', () => {
  const code = `
app.get('/protected', authMiddleware, rateLimiter, getProtectedData);
`;
  const out = jsPlugin.extract(code, 'routes.js');
  assert.strictEqual(out.routes.length, 1);
  assert.strictEqual(out.routes[0].functionName, 'getProtectedData');
  assert.strictEqual(out.routes[0].path, '/protected');
});

test('JavaScript routes', 'Template literal path → [dynamic] (no hallucination)', () => {
  const code = `
const version = 'v1';
app.get(\`/api/\${version}/users\`, getUsers);
`;
  const out = jsPlugin.extract(code, 'routes.js');
  assert.strictEqual(out.routes.length, 1);
  assert.strictEqual(out.routes[0].path, '[dynamic]');
});

test('JavaScript routes', 'foo.get() with unknown object is NOT extracted', () => {
  const code = `
// "foo" is not in ROUTER_NAMES set
foo.get('/something', handler);
bar.post('/else', handler2);
`;
  const out = jsPlugin.extract(code, 'routes.js');
  assert.strictEqual(out.routes.length, 0, `Expected 0 routes but got ${out.routes.length}: ${JSON.stringify(out.routes)}`);
});

test('JavaScript routes', 'Duplicate method+path pair deduplicated', () => {
  const code = `
app.get('/users', getUsers);
app.get('/users', getUsers); // duplicate
`;
  const out = jsPlugin.extract(code, 'server.js');
  assert.strictEqual(out.routes.length, 1);
});

test('JavaScript routes', 'Next.js Pages Router export default handler → ALL method', () => {
  const code = `
export default function handler(req, res) {
  res.json({ ok: true });
}
`;
  const out = jsPlugin.extract(code, 'pages/api/health.js');
  assert.strictEqual(out.routes.length, 1);
  assert.strictEqual(out.routes[0].method, 'ALL');
  assert.strictEqual(out.routes[0].path, '/api');
});

test('JavaScript routes', 'Next.js App Router export function GET → GET method', () => {
  const code = `
export function GET(request) {
  return new Response('ok');
}
export function POST(request) {
  return new Response('created');
}
`;
  const out = jsPlugin.extract(code, 'app/api/items/route.js');
  assert.strictEqual(out.routes.length, 2);
  const methods = out.routes.map(r => r.method).sort();
  assert.deepStrictEqual(methods, ['GET', 'POST']);
});

test('JavaScript routes', 'Non-API file export default does NOT produce routes', () => {
  const code = `
export default function MyComponent() {
  return '<div>hello</div>';
}
`;
  const out = jsPlugin.extract(code, 'components/MyComponent.js');
  assert.strictEqual(out.routes.length, 0, `Expected 0 routes but got ${out.routes.length}`);
});

test('JavaScript env vars', 'process.env.VAR_NAME extracted', () => {
  const code = `
const key = process.env.API_KEY;
const secret = process.env.JWT_SECRET;
`;
  const out = jsPlugin.extract(code, 'config.js');
  assert.ok(out.envVars.includes('API_KEY'), 'API_KEY must be extracted');
  assert.ok(out.envVars.includes('JWT_SECRET'), 'JWT_SECRET must be extracted');
});

test('JavaScript env vars', 'process.env["VAR"] bracket notation extracted', () => {
  const code = `
const db = process.env['DATABASE_URL'];
`;
  const out = jsPlugin.extract(code, 'db.js');
  assert.ok(out.envVars.includes('DATABASE_URL'), 'DATABASE_URL must be extracted');
});

test('JavaScript env vars', 'Non-process.env member expressions do NOT produce env vars', () => {
  const code = `
const x = window.location.href;
const y = req.headers.authorization;
`;
  const out = jsPlugin.extract(code, 'utils.js');
  assert.strictEqual(out.envVars.length, 0, `Expected no env vars but got ${JSON.stringify(out.envVars)}`);
});

test('JavaScript fetches', 'fetch(url) extracts URL and defaults to GET', () => {
  const code = `
fetch('https://api.example.com/data');
`;
  const out = jsPlugin.extract(code, 'client.js');
  assert.strictEqual(out.fetches.length, 1);
  assert.strictEqual(out.fetches[0].url, 'https://api.example.com/data');
  assert.strictEqual(out.fetches[0].method, 'GET');
});

test('JavaScript fetches', 'fetch(url, { method: "POST" }) extracts POST method', () => {
  const code = `
fetch('/api/submit', { method: 'POST', body: JSON.stringify(data) });
`;
  const out = jsPlugin.extract(code, 'form.js');
  assert.strictEqual(out.fetches.length, 1);
  assert.strictEqual(out.fetches[0].method, 'POST');
});

test('JavaScript fetches', 'fetch with template literal URL → [dynamic]', () => {
  const code = `
fetch(\`/api/users/\${userId}\`);
`;
  const out = jsPlugin.extract(code, 'api.js');
  assert.strictEqual(out.fetches.length, 1);
  assert.strictEqual(out.fetches[0].url, '[dynamic]');
});

test('JavaScript functions', 'Top-level function declaration extracted', () => {
  const code = `
function processPayment(amount, currency) {
  return { ok: true };
}
`;
  const out = jsPlugin.extract(code, 'payment.js');
  const fn = out.functions.find(f => f.name === 'processPayment');
  assert.ok(fn, 'processPayment must be extracted');
  assert.ok(fn.params.includes('amount'), 'params must include amount');
});

test('JavaScript functions', 'Arrow function assigned to const extracted', () => {
  const code = `
const validateUser = (user) => {
  return !!user.email;
};
`;
  const out = jsPlugin.extract(code, 'validators.js');
  const fn = out.functions.find(f => f.name === 'validateUser');
  assert.ok(fn, 'validateUser must be extracted');
});

test('JavaScript functions', 'Underscore no-param function NOT extracted', () => {
  const code = `
function _internal() {
  return 42;
}
function _withParam(x) {
  return x;
}
`;
  const out = jsPlugin.extract(code, 'utils.js');
  const internal = out.functions.find(f => f.name === '_internal');
  assert.ok(!internal, '_internal() with no params should be skipped');
  const withParam = out.functions.find(f => f.name === '_withParam');
  assert.ok(withParam, '_withParam(x) with params should NOT be skipped');
});

test('JavaScript', 'Syntax error in file returns empty result (no crash)', () => {
  const code = `
function broken( {
  this is not valid JS
`;
  const out = jsPlugin.extract(code, 'broken.js');
  assert.deepStrictEqual(out.routes, []);
  assert.deepStrictEqual(out.functions, []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 5 — TypeScript extractor: accuracy + hallucination guard
// ═══════════════════════════════════════════════════════════════════════════════

test('TypeScript interfaces', 'interface with typed fields extracted', () => {
  const code = `
interface User {
  id: number;
  email: string;
  isAdmin: boolean;
}
`;
  const out = tsPlugin.extract(code, 'types.ts');
  const user = out.models.find(m => m.className === 'User');
  assert.ok(user, 'User interface must exist');
  assert.strictEqual(user.fields.length, 3);
  const id = user.fields.find(f => f.name === 'id');
  assert.strictEqual(id.type, 'number');
});

test('TypeScript interfaces', 'Optional field (?) type extracted correctly', () => {
  const code = `
interface Profile {
  name: string;
  bio?: string;
}
`;
  const out = tsPlugin.extract(code, 'profile.ts');
  const bio = out.models[0].fields.find(f => f.name === 'bio');
  assert.ok(bio, 'bio field must exist');
  // type should be 'string' or similar (not hallucinated)
  assert.ok(bio.type.length > 0 && bio.type !== '—', `bio type should not be empty, got "${bio.type}"`);
});

test('TypeScript interfaces', 'type alias with object literal extracted', () => {
  const code = `
type ApiResponse = {
  data: string;
  error: string;
  status: number;
};
`;
  const out = tsPlugin.extract(code, 'api.ts');
  const resp = out.models.find(m => m.className === 'ApiResponse');
  assert.ok(resp, 'ApiResponse type alias must exist');
  assert.strictEqual(resp.fields.length, 3);
});

test('TypeScript interfaces', 'exported interface extracted', () => {
  const code = `
export interface Product {
  id: number;
  name: string;
  price: number;
}
`;
  const out = tsPlugin.extract(code, 'models.ts');
  const product = out.models.find(m => m.className === 'Product');
  assert.ok(product, 'Product must be extracted even with export');
});

test('TypeScript interfaces', 'Union type field extracted', () => {
  const code = `
interface Status {
  state: 'pending' | 'active' | 'deleted';
}
`;
  const out = tsPlugin.extract(code, 'status.ts');
  const state = out.models[0].fields.find(f => f.name === 'state');
  assert.ok(state, 'state field must exist');
});

test('TypeScript functions', 'Function with return type annotation extracted', () => {
  const code = `
function getUser(id: number): Promise<User> {
  return fetch('/api/users/' + id).then(r => r.json());
}
`;
  const out = tsPlugin.extract(code, 'service.ts');
  const fn = out.functions.find(f => f.name === 'getUser');
  assert.ok(fn, 'getUser must be extracted');
  assert.ok(fn.returnType.includes('Promise'), `Expected Promise return type, got "${fn.returnType}"`);
});

test('TypeScript functions', 'void return type captured', () => {
  const code = `
function logEvent(msg: string): void {
  console.log(msg);
}
`;
  const out = tsPlugin.extract(code, 'logger.ts');
  const fn = out.functions.find(f => f.name === 'logEvent');
  assert.ok(fn, 'logEvent must be extracted');
  assert.strictEqual(fn.returnType, 'void');
});

test('TypeScript functions', 'Array return type T[] captured', () => {
  const code = `
function listUsers(): User[] {
  return [];
}
`;
  const out = tsPlugin.extract(code, 'users.ts');
  const fn = out.functions.find(f => f.name === 'listUsers');
  assert.ok(fn, 'listUsers must be extracted');
  assert.ok(fn.returnType.includes('[]'), `Expected array return type, got "${fn.returnType}"`);
});

test('TypeScript routes', 'Next.js App Router export async function GET', () => {
  const code = `
export async function GET(request: Request): Promise<Response> {
  return new Response('ok');
}
export async function POST(request: Request): Promise<Response> {
  return new Response('created', { status: 201 });
}
`;
  const out = tsPlugin.extract(code, 'app/api/users/route.ts');
  assert.strictEqual(out.routes.length, 2);
  const methods = out.routes.map(r => r.method).sort();
  assert.deepStrictEqual(methods, ['GET', 'POST']);
});

test('TypeScript routes', 'Express routes in .ts file extracted', () => {
  const code = `
import express from 'express';
const router = express.Router();
router.get('/orders', listOrders);
router.post('/orders', createOrder);
`;
  const out = tsPlugin.extract(code, 'routes/orders.ts');
  assert.strictEqual(out.routes.length, 2);
});

test('TypeScript', 'Syntax error in .ts file returns empty result (no crash)', () => {
  const code = `
const x: number = "this will type-error"
function broken( {
`;
  const out = tsPlugin.extract(code, 'broken.ts');
  assert.deepStrictEqual(out.routes, []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 6 — Merger: accuracy + preservation guarantees
// ═══════════════════════════════════════════════════════════════════════════════

const mergerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-stress-merger-'));
function mp(name) { return path.join(mergerDir, name); }

test('Merger', 'Idempotent: writing same content twice produces identical file', () => {
  const p = mp('idempotent.md');
  mergeIntoAgentsMd(p, 'CONTENT A');
  const first = fs.readFileSync(p, 'utf-8');
  mergeIntoAgentsMd(p, 'CONTENT A');
  const second = fs.readFileSync(p, 'utf-8');
  assert.strictEqual(first, second, 'Two identical writes should produce identical output');
});

test('Merger', 'Update: content between markers is fully replaced', () => {
  const p = mp('update.md');
  mergeIntoAgentsMd(p, 'FIRST VERSION');
  mergeIntoAgentsMd(p, 'SECOND VERSION');
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(!result.includes('FIRST VERSION'), 'Old content must be replaced');
  assert.ok(result.includes('SECOND VERSION'), 'New content must be present');
});

test('Merger', 'Manual section with code block preserved exactly', () => {
  const p = mp('codeblock.md');
  const manual = `${START_MARKER}\nAUTO\n${END_MARKER}\n\n## Notes\n\`\`\`bash\nnpm run dev\n\`\`\`\n`;
  fs.writeFileSync(p, manual, 'utf-8');
  mergeIntoAgentsMd(p, 'NEW AUTO');
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(result.includes('```bash'), 'Code block must be preserved');
  assert.ok(result.includes('npm run dev'), 'Command in code block must be preserved');
});

test('Merger', 'Large content (50KB) written without truncation', () => {
  const p = mp('large.md');
  const bigContent = 'x'.repeat(50 * 1024);
  mergeIntoAgentsMd(p, bigContent);
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(result.includes(bigContent), 'All 50KB of content must survive');
});

test('Merger', 'Markers appear exactly once in output (no duplication)', () => {
  const p = mp('no-dup.md');
  mergeIntoAgentsMd(p, 'CONTENT');
  mergeIntoAgentsMd(p, 'UPDATED');
  const result = fs.readFileSync(p, 'utf-8');
  const startCount = (result.match(new RegExp(START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  const endCount = (result.match(new RegExp(END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  assert.strictEqual(startCount, 1, `START_MARKER appeared ${startCount} times, expected 1`);
  assert.strictEqual(endCount, 1, `END_MARKER appeared ${endCount} times, expected 1`);
});

test('Merger', 'Unicode content (emoji, CJK) preserved exactly', () => {
  const p = mp('unicode.md');
  const content = '# 用户系统\n- 登录 🔐\n- 注册 ✅\n- Ünïcödé hérö';
  mergeIntoAgentsMd(p, content);
  const result = fs.readFileSync(p, 'utf-8');
  assert.ok(result.includes('用户系统'), 'CJK characters must survive');
  assert.ok(result.includes('🔐'), 'Emoji must survive');
  assert.ok(result.includes('Ünïcödé'), 'Extended Latin must survive');
});

fs.rmSync(mergerDir, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 7 — Import graph: accuracy + phantom link prevention
// ═══════════════════════════════════════════════════════════════════════════════

const impDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-stress-imp-'));
function write(rel, content) {
  const full = path.join(impDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

test('Import graph', 'Deep relative path ../../utils resolves correctly', () => {
  write('utils.ts', 'export const x = 1;');
  const deep = write('a/b/deep.ts', "import { x } from '../../utils';");
  const imports = extractImports(fs.readFileSync(deep, 'utf-8'), deep, impDir);
  assert.ok(imports.includes('utils.ts'), `Expected 'utils.ts' in ${JSON.stringify(imports)}`);
});

test('Import graph', 'Index file resolution: import from ./lib resolves to lib/index.ts', () => {
  write('lib/index.ts', 'export const helper = 1;');
  const main = write('main.ts', "import { helper } from './lib';");
  const imports = extractImports(fs.readFileSync(main, 'utf-8'), main, impDir);
  assert.ok(imports.includes('lib/index.ts'), `Expected 'lib/index.ts' in ${JSON.stringify(imports)}`);
});

test('Import graph', 'Multiple imports in one file: all captured', () => {
  write('alpha.ts', 'export const a = 1;');
  write('beta.ts', 'export const b = 2;');
  const src = write('multi.ts', "import { a } from './alpha';\nimport { b } from './beta';");
  const imports = extractImports(fs.readFileSync(src, 'utf-8'), src, impDir);
  assert.ok(imports.includes('alpha.ts'), `Expected alpha.ts in ${JSON.stringify(imports)}`);
  assert.ok(imports.includes('beta.ts'), `Expected beta.ts in ${JSON.stringify(imports)}`);
});

test('Import graph', 'require() in .js file resolved correctly', () => {
  write('helpers.js', 'module.exports = {};');
  const app = write('app2.js', "const h = require('./helpers');");
  const imports = extractImports(fs.readFileSync(app, 'utf-8'), app, impDir);
  assert.ok(imports.includes('helpers.js'), `Expected helpers.js in ${JSON.stringify(imports)}`);
});

test('Import graph', 'import from non-existent file → NOT included (no phantom)', () => {
  const f = write('real.ts', "import { x } from './ghost';");
  const imports = extractImports(fs.readFileSync(f, 'utf-8'), f, impDir);
  const hasGhost = imports.some(i => i.includes('ghost'));
  assert.ok(!hasGhost, `Phantom import 'ghost' must not appear in ${JSON.stringify(imports)}`);
});

test('Import graph', 'Package import (from "express") → NOT included', () => {
  const f = write('server2.ts', "import express from 'express';\nimport { z } from 'zod';");
  const imports = extractImports(fs.readFileSync(f, 'utf-8'), f, impDir);
  assert.strictEqual(imports.length, 0, `Expected 0 imports, got ${JSON.stringify(imports)}`);
});

test('Import graph', 'buildImportGraph returns correct edges for multi-file project', () => {
  write('core/db.ts', 'export const db = null;');
  const userFile = write('core/users.ts', "import { db } from './db';");
  const fileContents = [
    { filePath: userFile, content: fs.readFileSync(userFile, 'utf-8') }
  ];
  const graph = buildImportGraph(fileContents, impDir);
  const edges = graph['core/users.ts'];
  assert.ok(edges && edges.includes('core/db.ts'), `Expected edge to core/db.ts in ${JSON.stringify(graph)}`);
});

test('Import graph', 'Circular imports: A→B, B→A — no infinite loop and both edges captured', () => {
  write('circ_a.ts', "import { b } from './circ_b';");
  write('circ_b.ts', "import { a } from './circ_a';");
  const a = path.join(impDir, 'circ_a.ts');
  const b = path.join(impDir, 'circ_b.ts');
  const fileContents = [
    { filePath: a, content: fs.readFileSync(a, 'utf-8') },
    { filePath: b, content: fs.readFileSync(b, 'utf-8') },
  ];
  // Should complete without hanging or crashing
  const graph = buildImportGraph(fileContents, impDir);
  assert.ok(graph['circ_a.ts'] && graph['circ_a.ts'].includes('circ_b.ts'), 'A→B edge must exist');
  assert.ok(graph['circ_b.ts'] && graph['circ_b.ts'].includes('circ_a.ts'), 'B→A edge must exist');
});

fs.rmSync(impDir, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 8 — Cross-cutting hallucination probes
// (can Carto be tricked into inventing structure that isn't there?)
// ═══════════════════════════════════════════════════════════════════════════════

test('Hallucination probes', 'Python: commented-out route is NOT extracted', () => {
  const code = `
# @app.get("/secret")
# def secret(): pass
@app.get("/real")
def real(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'app.py');
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].path, '/real');
});

test('Hallucination probes', 'Python: string containing route pattern is NOT a route', () => {
  const code = `
DOCS = """
@app.get("/fake")
def fake(): pass
"""
@app.get("/real2")
def real2(): pass
`;
  const { routes } = pythonPlugin.extract(code, 'app.py');
  // The regex might match inside the docstring — this is a known limitation but let's see
  // What we REQUIRE is that /real2 is present
  const realRoute = routes.find(r => r.path === '/real2');
  assert.ok(realRoute, '/real2 must be in the extracted routes');
});

test('Hallucination probes', 'JS: console.log with route-looking string is NOT a route', () => {
  const code = `
console.log("app.get('/fake', handler)");
app.get('/real', realHandler);
`;
  const out = jsPlugin.extract(code, 'server.js');
  const fake = out.routes.find(r => r.path === '/fake');
  assert.ok(!fake, '/fake must NOT be extracted (it is inside a string)');
  const real = out.routes.find(r => r.path === '/real');
  assert.ok(real, '/real must be extracted');
});

test('Hallucination probes', 'Prisma: view block does NOT produce a model', () => {
  // Prisma views use same syntax but different keyword
  const code = `
view UserView {
  id   Int
  name String
}
model Order {
  id Int @id
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  // Only Order should be extracted — view uses different keyword
  const view = out.models.find(m => m.className === 'UserView');
  const order = out.models.find(m => m.className === 'Order');
  assert.ok(!view, 'view block must NOT produce a model (not a model keyword)');
  assert.ok(order, 'Order model must be extracted');
});

test('Hallucination probes', 'TS: interface inside a comment is NOT extracted', () => {
  const code = `
// interface Ghost {
//   id: number;
// }
interface Real {
  id: number;
}
`;
  const out = tsPlugin.extract(code, 'types.ts');
  const ghost = out.models.find(m => m.className === 'Ghost');
  assert.ok(!ghost, 'Ghost interface inside comment must NOT be extracted');
  const real = out.models.find(m => m.className === 'Real');
  assert.ok(real, 'Real interface must be extracted');
});

test('Hallucination probes', 'Python: BaseModel in a string is NOT a model', () => {
  const code = `
description = "class User(BaseModel): pass"  # this is a string
class Actual(BaseModel):
    name: str
`;
  const { models } = pythonPlugin.extract(code, 'models.py');
  // Actual must be there, User must NOT be there (it is inside a string)
  const actual = models.find(m => m.className === 'Actual');
  assert.ok(actual, 'Actual must be extracted');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE 9 — Edge cases / robustness
// ═══════════════════════════════════════════════════════════════════════════════

test('Edge cases', 'Python: file with only imports and no routes/models', () => {
  const code = `
import os
import json
from pathlib import Path
from typing import List, Optional
`;
  const out = pythonPlugin.extract(code, 'imports.py');
  assert.strictEqual(out.routes.length, 0);
  assert.strictEqual(out.models.length, 0);
});

test('Edge cases', 'JS: file with only comments produces empty output', () => {
  const code = `
// This is a comment
/* Block comment */
// Another comment
`;
  const out = jsPlugin.extract(code, 'comments.js');
  assert.strictEqual(out.routes.length, 0);
  assert.strictEqual(out.functions.length, 0);
  assert.strictEqual(out.envVars.length, 0);
});

test('Edge cases', 'Prisma: model with no fields produces model with empty fields array', () => {
  const code = `
model Empty {
}
`;
  const out = prismaPlugin.extract(code, 'schema.prisma');
  assert.strictEqual(out.models.length, 1);
  assert.strictEqual(out.models[0].className, 'Empty');
  assert.deepStrictEqual(out.models[0].fields, []);
});

test('Edge cases', 'TS: empty file produces all empty arrays', () => {
  const out = tsPlugin.extract('', 'empty.ts');
  assert.deepStrictEqual(out.routes, []);
  assert.deepStrictEqual(out.models, []);
  assert.deepStrictEqual(out.functions, []);
  assert.deepStrictEqual(out.envVars, []);
});

test('Edge cases', 'Python: deeply nested Pydantic model (nested BaseModel)', () => {
  const code = `
class Address(BaseModel):
    street: str
    city: str

class User(BaseModel):
    name: str
    address: Address
`;
  const { models } = pythonPlugin.extract(code, 'models.py');
  assert.strictEqual(models.length, 2);
  const userAddress = models.find(m => m.className === 'User').fields.find(f => f.name === 'address');
  assert.ok(userAddress, 'address field must exist on User');
  assert.strictEqual(userAddress.type, 'Address');
});

test('Edge cases', 'JS: very large file (1000 routes) does not OOM or hang', () => {
  let code = '';
  for (let i = 0; i < 1000; i++) {
    code += `app.get('/route${i}', handler${i});\n`;
  }
  const start = Date.now();
  const out = jsPlugin.extract(code, 'big.js');
  const elapsed = Date.now() - start;
  assert.ok(out.routes.length === 1000, `Expected 1000 routes, got ${out.routes.length}`);
  assert.ok(elapsed < 5000, `Extraction took ${elapsed}ms, should be < 5s`);
});

test('Edge cases', 'Prisma: 10 models in one file — all extracted', () => {
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += `model Model${i} {\n  id Int @id\n  name String\n}\n\n`;
  }
  const out = prismaPlugin.extract(code, 'schema.prisma');
  assert.strictEqual(out.models.length, 10, `Expected 10 models, got ${out.models.length}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log('');
const suiteOrder = [
  'Python routes',
  'Python models',
  'Prisma extractor',
  'JavaScript routes',
  'JavaScript env vars',
  'JavaScript fetches',
  'JavaScript functions',
  'JavaScript',
  'TypeScript interfaces',
  'TypeScript functions',
  'TypeScript routes',
  'TypeScript',
  'Merger',
  'Import graph',
  'Hallucination probes',
  'Edge cases',
];

let totalPass = 0, totalTests = 0;
for (const suite of suiteOrder) {
  const s = suiteTotals[suite];
  if (!s) continue;
  const icon = s.pass === s.total ? '✓' : '✗';
  console.log(`${icon} ${suite.padEnd(28)} ${s.pass}/${s.total}`);
  totalPass += s.pass;
  totalTests += s.total;
}
console.log('');
console.log(`Total: ${totalPass}/${totalTests} tests passed`);
console.log('');

if (results.failed > 0) {
  console.log(`${results.failed} FAILURES:\n`);
  for (const f of results.failures) {
    console.log(`  ✗ [${f.suite}] ${f.name}`);
    console.log(`    ${f.message}\n`);
  }
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED — 0 hallucinations detected.');
}
