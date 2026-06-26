'use strict';

/**
 * Cross-repo sync — walk every registered repo, run detection, persist edges.
 *
 * Second pass: target → repo resolution. We resolve `to_repo` for npm/
 * pypi/go-mod/maven edges when the target's name matches a registered
 * repo's package metadata. Edges remain even when unresolved (target is
 * still useful for "find consumers of @scope/foo").
 */

const fs = require('fs');
const path = require('path');
const { OrgStore, defaultOrgDbDir } = require('./store');
const { scanRepo } = require('./detect');

/**
 * orgSync({ orgDir, scopes, dry }) → { repos, edges_inserted }
 *
 * `scopes`: { npm: [...], pypi: [...], go: [...], maven: [...] }
 * `dry`: if true, don't persist; just return what would change.
 */
function orgSync({ orgDir = defaultOrgDbDir(), scopes = {}, dry = false } = {}) {
  const store = new OrgStore(orgDir).open();
  try {
    const repos = store.listRepos();
    let inserted = 0;
    const allEdges = new Map();   // repo.name → edges

    for (const repo of repos) {
      const edges = scanRepo({ repoRoot: repo.root_path, scopes });
      allEdges.set(repo.name, edges);
    }

    // Build target → producer-repo map from each repo's package metadata.
    const targetToRepo = buildTargetToRepoMap(repos);

    // Resolve to_repo + persist.
    for (const [repoName, edges] of allEdges) {
      for (const e of edges) {
        if (!e.to_repo) {
          const target = e.target;
          const producer = targetToRepo.get(`${e.edge_kind}::${target}`);
          if (producer && producer !== repoName) e.to_repo = producer;
        }
      }
      if (!dry) store.insertEdges(repoName, edges);
      inserted += edges.length;
    }

    return {
      repos: repos.length,
      edges_inserted: inserted,
      edges_by_repo: Object.fromEntries(
        Array.from(allEdges.entries()).map(([name, e]) => [name, e.length])
      ),
    };
  } finally {
    store.close();
  }
}

function buildTargetToRepoMap(repos) {
  const map = new Map();
  for (const repo of repos) {
    // npm: package.json `name`
    const pkgPath = path.join(repo.root_path, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg && pkg.name) map.set(`npm::${pkg.name}`, repo.name);
      } catch {}
    }
    // pypi: pyproject.toml or setup.py
    const pyproject = path.join(repo.root_path, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      try {
        const text = fs.readFileSync(pyproject, 'utf-8');
        const m = /\bname\s*=\s*["']([^"']+)["']/.exec(text);
        if (m) map.set(`pypi::${m[1]}`, repo.name);
      } catch {}
    }
    // go: go.mod `module`
    const gomod = path.join(repo.root_path, 'go.mod');
    if (fs.existsSync(gomod)) {
      try {
        const text = fs.readFileSync(gomod, 'utf-8');
        const m = /^module\s+(\S+)/m.exec(text);
        if (m) map.set(`go-mod::${m[1]}`, repo.name);
      } catch {}
    }
    // maven: pom.xml <groupId>:<artifactId>
    const pom = path.join(repo.root_path, 'pom.xml');
    if (fs.existsSync(pom)) {
      try {
        const text = fs.readFileSync(pom, 'utf-8');
        const g = /<groupId>([^<]+)<\/groupId>/.exec(text);
        const a = /<artifactId>([^<]+)<\/artifactId>/.exec(text);
        if (g && a) map.set(`maven::${g[1]}:${a[1]}`, repo.name);
      } catch {}
    }
  }
  return map;
}

module.exports = { orgSync, buildTargetToRepoMap };
