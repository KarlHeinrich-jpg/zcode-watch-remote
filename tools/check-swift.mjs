#!/usr/bin/env node
/**
 * Cheap structural sanity check for the Swift sources — balanced braces,
 * brackets and parens, and unterminated string literals. Catches the class of
 * typo that would otherwise only show up on a Mac with Xcode.
 *
 *   node tools/check-swift.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'watch', 'ZCodeRemote');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.swift')) out.push(p);
  }
  return out;
}

let errors = 0;
const files = walk(SRC);

for (const file of files) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const stack = [];
  let inBlockComment = 0;
  let inString = false;
  let multilineString = false;
  let problems = [];

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    let s = '';
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      const next = line[j + 1];
      const prev = line[j - 1];

      if (inBlockComment > 0) {
        if (c === '/' && next === '*') { inBlockComment++; j++; }
        else if (c === '*' && next === '/') { inBlockComment--; j++; }
        continue;
      }
      if (multilineString) {
        if (c === '"' && line.slice(j, j + 3) === '"""' && prev !== '\\') { multilineString = false; j += 2; }
        continue;
      }
      if (inString) {
        if (c === '"' && prev !== '\\') inString = false;
        continue;
      }
      // not in comment/string
      if (c === '/' && next === '/') break;                  // line comment
      if (c === '/' && next === '*') { inBlockComment++; j++; continue; }
      if (c === '"' && line.slice(j, j + 3) === '"""') { multilineString = true; j += 2; continue; }
      if (c === '"') { inString = true; continue; }
      if (c === '{' || c === '(' || c === '[') stack.push({ c, lineNo });
      else if (c === '}' || c === ')' || c === ']') {
        const open = stack.pop();
        const pairs = { '}': '{', ')': '(', ']': '[' };
        if (!open || open.c !== pairs[c]) {
          problems.push(`line ${lineNo}: unexpected '${c}'${open ? ` (opened '${open.c}' at line ${open.lineNo})` : ''}`);
        }
      }
      s += c;
    }
    if (inString) problems.push(`line ${lineNo}: unterminated string literal`);
    inString = false;
  });

  if (stack.length) problems.push(`unclosed: ${stack.map((s) => `'${s.c}' at line ${s.lineNo}`).join(', ')}`);
  if (inBlockComment > 0) problems.push('unterminated block comment');
  if (multilineString) problems.push('unterminated multi-line string');

  if (problems.length) {
    errors += problems.length;
    console.log(`  ✗ ${rel}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`  ✓ ${rel}`);
  }
}

console.log(errors ? `\n${errors} problem(s) in ${files.length} Swift files` : `\n${files.length} Swift files look structurally sound`);
process.exit(errors ? 1 : 0);
