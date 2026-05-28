'use strict';

/**
 * Ruby extractor — tree-sitter for imports + symbols.
 * Regex for Rails route extraction and ActiveRecord model detection.
 */
const tsParser = require('../tree-sitter-parser');

// tree-sitter-ruby may not be installed — load lazily and fall back gracefully
let _rubyGrammarLoaded = false;
let _rubyGrammarError = null;

function _ensureRubyGrammar() {
  if (_rubyGrammarLoaded || _rubyGrammarError) return;
  try {
    require('tree-sitter-ruby');
    _rubyGrammarLoaded = true;
  } catch (err) {
    _rubyGrammarError = err.message;
    // Not fatal — we fall back to regex-only extraction
  }
}

module.exports = {
  name: 'ruby',
  extensions: ['.rb'],
  extract(content, filename) {
    _ensureRubyGrammar();

    // Try tree-sitter if grammar is available
    let tsImports = [];
    let tsSymbols = [];
    if (_rubyGrammarLoaded && tsParser.isAvailable() && tsParser.supportsExtension('.rb')) {
      const result = tsParser.extractAll(content, '.rb');
      tsImports = result.imports;
      tsSymbols = result.symbols;
    }

    return {
      routes:     extractRailsRoutes(content),
      models:     extractActiveRecordModels(content),
      functions:  tsSymbols.filter(s => s.kind === 'function' || s.kind === 'method')
                           .map(s => ({ name: s.name, params: '—', returnType: '—' })),
      envVars:    extractRubyEnvVars(content),
      dbTables:   [],
      fetches:    [],
      storageKeys: [],
      _tsImports: tsImports,
      _tsSymbols: tsSymbols,
    };
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

function extractRailsRoutes(content) {
  const routes = [];

  // Rails routes.rb: get '/path', to: 'controller#action'
  const resourcePattern = /\b(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = resourcePattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[handler]' });
  }

  // resources :users → generates standard CRUD routes
  const resourcesPattern = /\bresources\s+:(\w+)/g;
  while ((m = resourcesPattern.exec(content)) !== null) {
    const resource = m[1];
    const base = `/${resource}`;
    routes.push(
      { method: 'GET',    path: base,           functionName: `${resource}#index` },
      { method: 'POST',   path: base,           functionName: `${resource}#create` },
      { method: 'GET',    path: `${base}/:id`,  functionName: `${resource}#show` },
      { method: 'PUT',    path: `${base}/:id`,  functionName: `${resource}#update` },
      { method: 'DELETE', path: `${base}/:id`,  functionName: `${resource}#destroy` },
    );
  }

  // resource :profile → singular resource
  const resourcePattern2 = /\bresource\s+:(\w+)/g;
  while ((m = resourcePattern2.exec(content)) !== null) {
    const resource = m[1];
    routes.push(
      { method: 'GET',    path: `/${resource}`,      functionName: `${resource}#show` },
      { method: 'POST',   path: `/${resource}`,      functionName: `${resource}#create` },
      { method: 'PUT',    path: `/${resource}`,      functionName: `${resource}#update` },
      { method: 'DELETE', path: `/${resource}`,      functionName: `${resource}#destroy` },
    );
  }

  // Sinatra: get '/path' do ... end
  const sinatraPattern = /^(get|post|put|delete|patch)\s+['"]([^'"]+)['"]\s+do/gm;
  while ((m = sinatraPattern.exec(content)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], functionName: '[block]' });
  }

  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.method}::${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Models ───────────────────────────────────────────────────────────────────

function extractActiveRecordModels(content) {
  const models = [];

  // class User < ApplicationRecord / ActiveRecord::Base
  const modelPattern = /^class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base|ActiveModel::Model)/gm;
  let m;
  while ((m = modelPattern.exec(content)) !== null) {
    const className = m[1];
    const fields = [];

    // attr_accessor :name, :email
    const attrPattern = /attr_(?:accessor|reader|writer)\s+((?::\w+(?:,\s*)?)+)/g;
    let am;
    while ((am = attrPattern.exec(content)) !== null) {
      const attrs = am[1].split(',').map(a => a.trim().replace(/^:/, ''));
      for (const attr of attrs) {
        if (attr) fields.push({ name: attr, type: 'attr' });
      }
    }

    models.push({ className, fields, kind: 'activerecord' });
  }

  // Struct-like: MyStruct = Struct.new(:name, :age)
  const structPattern = /(\w+)\s*=\s*Struct\.new\s*\(([^)]+)\)/g;
  while ((m = structPattern.exec(content)) !== null) {
    const className = m[1];
    const fields = m[2].split(',')
      .map(s => s.trim().replace(/^:/, ''))
      .filter(Boolean)
      .map(name => ({ name, type: 'attr' }));
    models.push({ className, fields, kind: 'ruby-struct' });
  }

  return models;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function extractRubyEnvVars(content) {
  const vars = new Set();
  // ENV['VAR'] / ENV["VAR"] / ENV.fetch('VAR')
  const pattern = /ENV\s*(?:\[['"]([^'"]+)['"]\]|\.fetch\s*\(\s*['"]([^'"]+)['"]\))/g;
  let m;
  while ((m = pattern.exec(content)) !== null) {
    vars.add(m[1] || m[2]);
  }
  return [...vars];
}
