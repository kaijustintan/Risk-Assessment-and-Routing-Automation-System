/*
  FILE: docs/tools/calls.js

  LAYMAN (Tropang Ex): Kapag ginawa nating private ang isang function (dinagdagan ng
  underscore sa dulo), kailangang ma-update LAHAT ng tumatawag dito. Kung may nakalimutan,
  walang magrereklamo: tama pa rin ang syntax, kaya pumapasa ang `node --check`, at hindi
  naman ito tinitingnan ng `surface.js`. Lalabas lang siya kapag may totoong user na
  tumama sa linyang iyon. Ito yung humahanap ng mga nalimutan.

  TECHNICAL: Rename-mismatch detector for the trailing-underscore privatization convention
  (CLAUDE.md 8b). Apps Script has no module system: the whole project is one flat global
  scope, so calling a name nothing defines is a ReferenceError at RUNTIME, on whatever path
  reaches it, not at load.

  This is exactly how generateAuthToken_ shipped calling getSystemSecret() after the
  2026-08-11 sweep renamed it to getSystemSecret_(). That call signs every approver review
  link, so the first deploy would have broken the entire approval workflow. It survived
  node --check (syntactically fine), surface.js (which audits which names are public, not
  whether calls resolve), and three rounds of review.

  🚩 SCOPE, deliberately narrow. An earlier version tried to flag every call to an undefined
  name, which needs a real JS tokenizer: masking comments and strings by hand fell over on
  regex literals containing quotes and on nested template literals, blanking real code and
  producing hundreds of false positives. A checker nobody trusts gets ignored, so this only
  answers the one question that caused a real outage: for every `foo_` this project defines,
  does anything still call bare `foo`?

  Output lists every hit with its line so a human can confirm; doc-comment mentions are
  labelled rather than filtered, since guessing at comment boundaries is what broke the
  general version.

  USAGE:  node docs/tools/calls.js         exits 1 if any bare-name call survives
*/
const fs = require('fs');

const FILES = ['Phase 1/Code.js', 'Phase 2/pia_code.js', 'Admin/admin_code.js'];

let findings = 0;

for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);

  // Names this file defines WITH a trailing underscore.
  const privates = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)_\s*\(/g)) privates.add(m[1]);
  if (privates.size === 0) { console.log('OK   ' + file + '  (no private functions)'); continue; }

  // A bare-name call is only a problem when the bare name is NOT itself defined. Several
  // functions legitimately exist in both forms (a public guarded wrapper over a private
  // implementation, e.g. sendDailyReminders / sendDailyReminders_), and those are correct.
  const defined = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);

  const hits = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (!privates.has(name) || defined.has(name)) continue;
      const looksLikeDoc = /^\s*(\*|\/\/|-\s|[A-Z]+:)/.test(line) || /^\s{2,}-\s/.test(line);
      hits.push({ line: i + 1, name, doc: looksLikeDoc, text: line.trim().slice(0, 100) });
    }
  });

  if (hits.length === 0) { console.log('OK   ' + file); continue; }

  const real = hits.filter(h => !h.doc);
  console.log((real.length ? 'FAIL ' : 'WARN ') + file);
  for (const h of hits) {
    console.log('       ' + (h.doc ? '[doc] ' : '[CALL]') + ' ' + file + ':' + h.line +
                '  ' + h.name + '()  ->  should be ' + h.name + '_()');
    console.log('              ' + h.text);
  }
  findings += real.length;
}

console.log(findings
  ? '\n' + findings + ' live call(s) to a name that is only defined with a trailing underscore'
  : '\nNo stale bare-name calls. Every privatized function is called by its real name.');
process.exit(findings ? 1 : 0);
