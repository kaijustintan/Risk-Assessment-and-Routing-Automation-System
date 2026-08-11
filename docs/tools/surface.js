#!/usr/bin/env node
/*
  FILE: docs/tools/surface.js

  LAYMAN (Tropang Ex):
  Sa Google Apps Script, LAHAT ng top-level function ay pwedeng tawagin ng kahit sinong naka-login
  sa domain, diretso mula sa browser console (`google.script.run.anyFunctionName()`). Hindi
  proteksyon ang pagtago ng button. Ang TANGING nagtatago ng function ay ang trailing underscore
  (`myFunc_`). Ang script na ito ang nagbibilang: ilan ang bukas, ilan ang sarado, at alin sa mga
  bukas ang totoong ginagamit ng frontend.

  Patakbuhin ito BAGO mag-deploy tuwing may bagong backend function. Kung may lumabas na
  "CALLED BUT NOT PUBLIC", masisira ang app pagka-deploy. Kung may "public but unreferenced",
  malamang dapat may underscore yun.

  TECHNICAL:
  Static call-graph checker for the three GAS projects. For each (backend, frontend) pair it:
    1. enumerates top-level `function name(...)` declarations and splits them public vs private;
    2. extracts every `google.script.run[.withXHandler(...)]*.name(` target from the frontend;
    3. reports  (a) called-but-not-public  → deploy-breaking, must be fixed;
                (b) public-but-unreferenced → candidates for a trailing underscore.

  Frontend token matching is deliberately OVER-APPROXIMATE on the "referenced" side: a name that
  merely appears anywhere in the frontend text counts as referenced, so the tool never tells you to
  hide something that is actually in use. False negatives here are safe; false positives are not.

  🚩 This file is committed on purpose. The equivalent checker in the sibling COC repo was written
  in a scratchpad directory and lost. Do not move it back out of the repo.

  USAGE:
    node docs/tools/surface.js          # from the repo root
    node docs/tools/surface.js --list   # also print the full public list per project

  EXIT CODE: 1 if any called-but-not-public target exists, else 0 (usable as a pre-deploy gate).
*/

const fs = require('fs');
const path = require('path');

const PAIRS = [
  { name: 'Phase 1 (DCS)',   backend: 'Phase 1/Code.js',        frontend: 'Phase 1/index.html' },
  { name: 'Phase 2 (PIA)',   backend: 'Phase 2/pia_code.js',    frontend: 'Phase 2/pia_index.html' },
  { name: 'Phase 3 (Admin)', backend: 'Admin/admin_code.js',    frontend: 'Admin/adminView.html' }
];

// Structural entry points GAS itself invokes. Never flag these as "should be private".
const STRUCTURAL = new Set(['doGet', 'doPost', 'include', 'onOpen', 'onEdit', 'onInstall']);

const showList = process.argv.includes('--list');
let brokenTotal = 0;

for (const p of PAIRS) {
  if (!fs.existsSync(p.backend) || !fs.existsSync(p.frontend)) {
    console.log(`\n=== ${p.name} === SKIPPED (files not found)`);
    continue;
  }

  const be = fs.readFileSync(p.backend, 'utf8');
  const fe = fs.readFileSync(p.frontend, 'utf8');
  const feFlat = fe.replace(/\s+/g, ' ');

  const all = [...be.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map(m => m[1]);
  const pub = all.filter(n => !n.endsWith('_'));
  const priv = all.filter(n => n.endsWith('_'));

  // Explicit google.script.run targets, tolerating chained withSuccessHandler/withFailureHandler.
  const called = new Set();
  const re = /google\.script\.run((?:\s*\.with[A-Za-z]+\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*)\s*\.([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(feFlat))) called.add(m[2]);
  // Handler names are part of the chain grammar, never RPC targets.
  ['withSuccessHandler', 'withFailureHandler', 'withUserObject'].forEach(h => called.delete(h));

  // Over-approximate "referenced": any bare occurrence of the identifier in the frontend.
  const feTokens = new Set([...fe.matchAll(/[A-Za-z0-9_]+/g)].map(x => x[0]));

  const broken = [...called].filter(n => !pub.includes(n) && all.includes(n));
  const unknown = [...called].filter(n => !all.includes(n));
  const unreferenced = pub.filter(n => !STRUCTURAL.has(n) && !feTokens.has(n));

  const pct = all.length ? Math.round((priv.length / all.length) * 100) : 0;
  console.log(`\n=== ${p.name} ===`);
  console.log(`  total ${all.length}  |  private ${priv.length} (${pct}%)  |  public ${pub.length}  |  RPC targets used ${called.size}`);

  if (broken.length) {
    brokenTotal += broken.length;
    console.log(`  ❌ CALLED BUT NOT PUBLIC (deploy would break): ${broken.join(' ')}`);
  }
  if (unknown.length) {
    console.log(`  ⚠  called but not defined in this backend (check for typos): ${unknown.join(' ')}`);
  }
  if (unreferenced.length) {
    console.log(`  ·  public but unreferenced in the frontend (should these be private or guarded?):`);
    console.log(`     ${unreferenced.join(' ')}`);
  }
  if (showList) {
    console.log(`  public: ${pub.sort().join(' ')}`);
  }
}

console.log(
  brokenTotal
    ? `\n❌ ${brokenTotal} call target(s) would break on deploy.`
    : `\n✅ Every frontend RPC target resolves to a public backend function.`
);
process.exit(brokenTotal ? 1 : 0);
