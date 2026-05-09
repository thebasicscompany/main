#!/usr/bin/env node
/**
 * One-shot import rewriter for the vendored gateway tree.
 *
 * Upstream uses bundler-resolved imports without file extensions. Node's
 * strict ESM mode won't follow `./middlewares/requestValidator` — it needs
 * either `./middlewares/requestValidator/index.js` or
 * `./middlewares/requestValidator.js`.
 *
 * This script walks `src/gateway/**\/*.ts`, detects relative imports
 * without extensions, resolves them to a sibling `.ts` or `.../index.ts`,
 * and rewrites the source with the corresponding `.js` (so tsc keeps the
 * `.js` in the emitted output, which Node ESM accepts).
 *
 * Run after vendoring upstream changes:
 *   node api/scripts/fix-gateway-imports.mjs
 */
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gateway');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      yield full;
    }
  }
}

// Match:  from '<path>'  |  from "<path>"  |  import '<path>'  |  import "<path>"
// Captures relative paths starting with `./`, `../`, or bare `.` / `..`.
const importRe = /(\bfrom\s+|\bimport\s+(?:type\s+)?)(['"])(\.\.?(?:\/[^'"]*)?)\2/g;

let totalEdits = 0;
let totalFiles = 0;

for (const file of walk(ROOT)) {
  const original = readFileSync(file, 'utf8');
  const fileDir = dirname(file);
  let edits = 0;
  const next = original.replace(importRe, (match, prefix, quote, spec) => {
    if (spec.endsWith('.js') || spec.endsWith('.json') || spec.endsWith('.cjs') || spec.endsWith('.mjs')) {
      return match;
    }
    const tsCandidate = resolve(fileDir, `${spec}.ts`);
    const indexCandidate = resolve(fileDir, spec, 'index.ts');
    let resolved;
    if (existsSync(tsCandidate)) {
      resolved = `${spec}.js`;
    } else if (existsSync(indexCandidate)) {
      resolved = `${spec}/index.js`;
    } else {
      return match;
    }
    edits++;
    return `${prefix}${quote}${resolved}${quote}`;
  });
  if (edits > 0) {
    writeFileSync(file, next);
    totalEdits += edits;
    totalFiles++;
    process.stdout.write(`${relative(ROOT, file)}: ${edits}\n`);
  }
}

process.stdout.write(`done — ${totalEdits} imports across ${totalFiles} files\n`);
