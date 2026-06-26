'use strict';

/**
 * Infrastructure-as-Code (IaC) graph extraction.
 *
 * Surfaces blast radius on infra resources alongside code. Pragmatic
 * regex-based parsers today — full HCL/YAML AST is a follow-up.
 *
 * Supported:
 *   - Terraform / OpenTofu (`.tf` files)                — resource, module, output
 *   - Helm charts (`values.yaml` + `templates/*.yaml`)  — chart name + deps
 *   - Pulumi (`.ts/.py` files importing @pulumi)        — resource detection
 *   - AWS CDK (`.ts` files importing aws-cdk-lib)       — construct detection
 *
 * Output shape per resource: `{ kind, name, file, dependencies }`.
 */

const fs = require('fs');
const path = require('path');

// ── Terraform ────────────────────────────────────────────────────
function parseTerraform(content, filename) {
  const out = [];
  if (typeof content !== 'string' || content.length === 0) return out;
  let m;

  // resource "type" "name" { ... }
  const resourceRe = /\bresource\s+"([^"]+)"\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
  while ((m = resourceRe.exec(content)) !== null) {
    const deps = extractTfRefs(m[3]);
    out.push({ kind: 'resource', tf_type: m[1], name: m[2], file: filename, dependencies: deps });
  }

  // module "name" { source = "..." }
  const moduleRe = /\bmodule\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
  while ((m = moduleRe.exec(content)) !== null) {
    const sourceMatch = /source\s*=\s*"([^"]+)"/.exec(m[2]);
    out.push({
      kind: 'module', name: m[1], file: filename,
      source: sourceMatch ? sourceMatch[1] : null,
      dependencies: extractTfRefs(m[2]),
    });
  }

  // data "type" "name" { ... }
  const dataRe = /\bdata\s+"([^"]+)"\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
  while ((m = dataRe.exec(content)) !== null) {
    out.push({ kind: 'data', tf_type: m[1], name: m[2], file: filename, dependencies: extractTfRefs(m[3]) });
  }

  return out;
}

function extractTfRefs(body) {
  const refs = new Set();
  // ${resource_type.resource_name.attr} OR ${module.name.output}
  const re = /\$\{?\s*((?:resource|module|data|var|local)\.[A-Za-z0-9_.\-]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    // Take first two segments: e.g. "module.vpc.id" → "module.vpc"
    const segs = m[1].split('.');
    if (segs.length >= 2) refs.add(segs[0] + '.' + segs[1]);
  }
  // Bare HCL refs: aws_s3_bucket.mine.id (no ${})
  const bareRe = /\b(aws_[a-z0-9_]+|google_[a-z0-9_]+|azurerm_[a-z0-9_]+|module|data|var|local)\.([A-Za-z0-9_\-]+)/g;
  while ((m = bareRe.exec(body)) !== null) {
    refs.add(m[1] + '.' + m[2]);
  }
  return [...refs];
}

// ── Helm ─────────────────────────────────────────────────────────
function parseHelmChart(content, filename) {
  // Chart.yaml gives us chart name + version + dependencies.
  const out = [];
  if (!filename.endsWith('Chart.yaml') && !filename.endsWith('Chart.yml')) return out;
  let m;
  const nameMatch = /^name\s*:\s*(.+)$/m.exec(content);
  const versionMatch = /^version\s*:\s*(.+)$/m.exec(content);
  if (!nameMatch) return out;
  const deps = [];
  // dependencies:\n  - name: foo\n    version: 1.0\n    repository: ...
  const depRe = /^\s*-\s*name\s*:\s*([\w\-]+)/gm;
  while ((m = depRe.exec(content)) !== null) deps.push({ name: m[1] });
  out.push({
    kind: 'helm-chart',
    name: nameMatch[1].trim(),
    version: versionMatch ? versionMatch[1].trim() : null,
    file: filename,
    dependencies: deps,
  });
  return out;
}

// ── Pulumi / CDK (detect from imports + new ResourceClass()) ────
function parsePulumiOrCdk(content, filename) {
  if (typeof content !== 'string' || content.length === 0) return [];

  const isPulumi = content.includes('@pulumi/') || content.includes('import pulumi');
  const isCdk = content.includes('aws-cdk-lib') || content.includes('@aws-cdk/');
  if (!isPulumi && !isCdk) return [];

  const out = [];
  let m;
  // new aws.s3.Bucket("name", { ... })  (Pulumi)
  // new s3.Bucket(this, "name", { ... })  (CDK)
  // Match `new <namespace.>Class(...)`. Final class segment must start
  // with a capital letter; preceding segments (e.g. `s3.`) may be
  // lowercase namespaces.
  const newRe = /\bnew\s+((?:[A-Za-z_]\w*\.)*[A-Z]\w*)\s*\(\s*(?:this\s*,\s*)?['"]([^'"]+)['"]/g;
  while ((m = newRe.exec(content)) !== null) {
    out.push({
      kind: isCdk ? 'cdk-construct' : 'pulumi-resource',
      tf_type: m[1],
      name: m[2],
      file: filename,
      dependencies: [],
    });
  }
  return out;
}

/**
 * scanIacResources(projectRoot, { maxFiles }) → Array<resource>
 *
 * Walks `projectRoot` for IaC files. Returns all resources found.
 */
function scanIacResources(projectRoot, { maxFiles = 500 } = {}) {
  if (!projectRoot) return [];
  const out = [];
  let count = 0;

  const walk = (dir) => {
    if (count >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= maxFiles) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
        if (rel.endsWith('.tf')) {
          let content; try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          out.push(...parseTerraform(content, rel));
          count++;
        } else if (rel.endsWith('Chart.yaml') || rel.endsWith('Chart.yml')) {
          let content; try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          out.push(...parseHelmChart(content, rel));
          count++;
        } else if (rel.endsWith('.ts') || rel.endsWith('.py')) {
          // Cheap guard: only read first 4 KB to check for pulumi/cdk imports.
          let content;
          try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          if (content.length > 200_000) content = content.slice(0, 200_000);
          out.push(...parsePulumiOrCdk(content, rel));
          count++;
        }
      }
    }
  };
  walk(projectRoot);
  return out;
}

module.exports = { parseTerraform, parseHelmChart, parsePulumiOrCdk, scanIacResources, extractTfRefs };
