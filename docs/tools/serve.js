/*
  FILE: docs/tools/serve.js

  LAYMAN (Tropang Ex): May mga bagay na PERPEKTO sa file mo pero sinisira ng Google kapag
  inihahain na niya yung page sa browser. Blangkong page, walang clue, at walang offline
  na tool na makakakita nun kasi tama naman talaga yung nakasulat sa disk. Ito yung
  humahanap ng mga alam nating trigger, bago pa sila makarating sa production.

  TECHNICAL: Serve-time-hazard checker for the three GAS-served frontends. Apps Script
  re-processes an HTML file when it serves it, and that processing can corrupt content that
  is perfectly valid JavaScript on disk. node --check, surface.js, calls.js, escapers.js and
  shared.js ALL pass on such a file; the only symptom is a blank page and a
  document.write SyntaxError in the browser console.

  ━━━ THE CONFIRMED TRIGGER (2026-08-13, cost a production outage) ━━━━━━━━━━━━━━━━━━━

  An inline SVG carrying its namespace attribute, inside a <script> block:

      return '<svg xmlns="http:' + '/' + '/www.w3.org/2000/svg" width="' + s + '"'   <-- on disk

  was served as:

      return '<svg xmlns="http:

  Truncated at the double slash inside the namespace URL, leaving an unterminated string
  literal, so the parser died on the next line and the whole DCS page never rendered. The
  identical defect sat in Admin/adminView.html and would have blanked that app too. Both
  arrived in an undeployed batch, so they were served for the first time months after being
  written, which is exactly when a serve-time-only defect surfaces.

  ━━━ WHY THIS CHECK IS NARROW ON PURPOSE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  It is tempting to flag every `//` inside every string literal. Do not. Two counter-examples
  in this very repo prove that rule wrong:

    Phase 1/index.html   var FAVICON_URL = 'https:'+'//upload.wikimedia.org/...'
    Admin/adminView.html return '<a href="https:'+'//drive.google.com/file/d/' + esc(id) + ...

  Both carry a double slash inside a string inside a <script> block, and both have served
  correctly in production for months. A checker that cried wolf on those would be switched
  off within a week, and then it would not be there for the case that matters. This flags
  the ONE construct proven to break, which also happens to be the one construct that is
  always safe to delete: the xmlns attribute is redundant for inline SVG, because the HTML
  parser places an <svg> element into the SVG namespace on its own.

  The exact mechanism (why xmlns and not href) was never established. That is fine. The
  check is anchored on observed behaviour, not on a theory of the serializer.

  USAGE:  node docs/tools/serve.js         exits 1 if any hazard reaches a <script> block
*/
const fs = require('fs');

const FILES = [
  'Phase 1/index.html',
  'Phase 2/pia_index.html',
  'Admin/adminView.html'
];

/* Line ranges covered by <script> blocks. Markup OUTSIDE a script block is ordinary HTML:
   an <svg xmlns=...> there is normal, correct, and must NOT be flagged. The corruption only
   matters where the text is JavaScript source. */
function scriptRanges(src) {
  const ranges = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const start = src.slice(0, m.index).split('\n').length;
    ranges.push([start, start + m[1].split('\n').length]);
  }
  return ranges;
}

let findings = 0;

for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');
  const ranges = scriptRanges(src);
  const lines = src.split('\n');
  const hits = [];

  lines.forEach((line, i) => {
    const n = i + 1;
    if (!ranges.some(r => n >= r[0] && n <= r[1])) return;   // plain HTML: not our problem

    // A namespace attribute inside JS source. Matches the attribute name only, so it fires
    // whether the value is single-quoted, double-quoted, split, or interpolated.
    if (/\bxmlns\s*=/.test(line)) {
      // A comment explaining the rule is not a violation of it.
      const codePart = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bxmlns\s*=/.test(codePart)) {
        hits.push({ line: n, text: line.trim().slice(0, 100) });
      }
    }
  });

  if (hits.length === 0) { console.log('OK   ' + file); continue; }

  console.log('FAIL ' + file);
  for (const h of hits) {
    console.log('       ' + file + ':' + h.line + '  xmlns inside a <script> block');
    console.log('              ' + h.text);
    console.log('              FIX: delete the attribute. Inline SVG does not need it, and GAS');
    console.log('                   truncates the served line at the slashes in its URL.');
  }
  findings += hits.length;
}

console.log(findings
  ? '\n' + findings + ' serve-time hazard(s). These pass every other checker and blank the page in production.'
  : '\nNo known serve-time hazards in any <script> block.');
process.exit(findings ? 1 : 0);
