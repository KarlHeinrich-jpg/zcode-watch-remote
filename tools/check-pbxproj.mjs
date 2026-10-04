#!/usr/bin/env node
/**
 * Structural check for the hand-written Xcode project file: every referenced
 * object id must be defined exactly once, and every source file on disk must be
 * built. Runs in CI and via `npm run check` in the repo root.
 *
 *   node tools/check-pbxproj.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROJ = path.join(ROOT, 'watch', 'ZCodeRemote.xcodeproj', 'project.pbxproj');

let errors = 0;
const fail = (msg) => {
  errors++;
  console.error('  ✗ ' + msg);
};
const pass = (msg) => console.log('  ✓ ' + msg);

const text = fs.readFileSync(PROJ, 'utf8');

// --- 1. balanced braces -----------------------------------------------------
let depth = 0;
let inString = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (c === '"' && text[i - 1] !== '\\') inString = !inString;
  if (inString) continue;
  if (c === '{') depth++;
  else if (c === '}') depth--;
  if (depth < 0) break;
}
depth === 0 ? pass('braces balanced') : fail(`unbalanced braces (depth ${depth})`);

// --- 2. object ids ----------------------------------------------------------
// Definitions sit at exactly two tabs (opening) or three tabs (build settings
// blocks); references sit deeper. Long alphanumeric tokens are ids, short ones
// like `en`/`Base` are values.
const ID_RE = /^[A-Za-z0-9_]{16,}$/;
const defRe = /^\t\t([A-Za-z0-9_]+) (?:=|\/\*)/gm;
const defined = new Set();
const lengths = new Set();
const allDefs = [];
let m;
while ((m = defRe.exec(text))) {
  if (!ID_RE.test(m[1])) continue;
  defined.add(m[1]);
  allDefs.push(m[1]);
  lengths.add(m[1].length);
}
defined.size ? pass(`${defined.size} objects defined`) : fail('no objects found');

const dupes = allDefs.filter((id, i) => allDefs.indexOf(id) !== i);
dupes.length ? fail(`duplicate object ids: ${[...new Set(dupes)].join(', ')}`) : pass('no duplicate ids');
lengths.size === 1 ? pass(`all ids ${[...lengths][0]} chars`) : fail(`mixed id lengths: ${[...lengths].join(', ')}`);

// --- 3. every referenced id is defined -------------------------------------
const referenced = new Set();
for (const rm of text.matchAll(/(?:fileRef|productReference|mainGroup|productRefGroup|buildConfigurationList|rootObject) = ([A-Za-z0-9_]+)/g)) {
  if (ID_RE.test(rm[1])) referenced.add(rm[1]);
}
for (const rm of text.matchAll(/^\t\t\t\t([A-Za-z0-9_]+) \/\*[^*]*\*\/,$/gm)) {
  if (ID_RE.test(rm[1])) referenced.add(rm[1]);
}
for (const rm of text.matchAll(/^\t\t\t\t([A-Za-z0-9_]+),$/gm)) {
  if (ID_RE.test(rm[1])) referenced.add(rm[1]);
}

const missing = [...referenced].filter((id) => !defined.has(id));
missing.length ? fail(`referenced but not defined: ${missing.join(', ')}`) : pass(`${referenced.size} references all resolve`);

// --- 4. every Swift file is in the build -----------------------------------
const srcDir = path.join(ROOT, 'watch', 'ZCodeRemote');
const swiftFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.swift')) swiftFiles.push(path.relative(srcDir, p).replace(/\\/g, '/'));
  }
})(srcDir);

const missingFromBuild = swiftFiles.filter((f) => {
  const base = path.basename(f);
  return !new RegExp(`/\\* ${base.replace('.', '\\.')} in Sources \\*/`).test(text);
});
missingFromBuild.length
  ? fail(`Swift files missing from the build: ${missingFromBuild.join(', ')}`)
  : pass(`all ${swiftFiles.length} Swift files are in the Sources phase`);

// --- 5. asset catalog + Info.plist exist -----------------------------------
for (const required of ['Assets.xcassets', 'Info.plist']) {
  fs.existsSync(path.join(srcDir, required)) ? pass(`${required} present`) : fail(`${required} missing`);
}
const icon = path.join(srcDir, 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png');
fs.existsSync(icon) ? pass('app icon generated') : fail('app icon missing — run tools/generate-icon.mjs');

console.log(errors ? `\n${errors} problem(s) in project.pbxproj` : '\nproject.pbxproj looks good');
process.exit(errors ? 1 : 0);
