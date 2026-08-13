/*
  FILE: docs/tools/shared.js

  LAYMAN (Tropang Ex): Walang import sa Apps Script, kaya ang mga shared helper (error
  contract, cache, owner gate) ay LITERAL na kinokopya sa tatlong backend. Ang CLAUDE.md
  ang nagsasabi ng "edit all three together", pero walang nagchecheck. Ganyan nangyari yung
  design-token drift: tatlong kopya, tatlong bersyon, walang nakapansin. Ito yung
  nagkukumpara ng mga kopya at sumisigaw kapag nag-iba na sila.

  TECHNICAL: Cross-backend divergence checker for helpers documented as "keep the copies
  identical" (CLAUDE.md 8b/8c). For each entry it extracts the named function (or const
  block) from every backend that must carry it, strips comments, collapses whitespace, and
  compares the normalized code. Two divergences are deliberately forgiven:
    - comments (each file's doc blocks localize differently), and
    - declaration keywords (`var` vs `const` vs `let`): Admin is var-styled throughout
      while Phase 1/2 use const; for these tiny straight-line helpers that is style, not
      behavior, and forcing a rewrite of one file's style would be churn without safety.
  Everything else in the CODE must be byte-equal.

  🚩 SCOPE, deliberately narrow, same philosophy as calls.js and escapers.js. This does not
  discover which functions SHOULD match; the MUST_MATCH list below is curated by hand from
  the documented contract. A general "find all similar functions" tool would drown in
  legitimate variation (getStyledHtmlWrapper_ differs per app on purpose; the two
  sendEmailWithRetry_ copies have per-app notification hooks). Add an entry here at the
  same moment CLAUDE.md declares a helper shared; that is the whole workflow.

  The extractor and stripper are one character walker that understands strings, template
  literals, comments, and regex literals (a `/` opens a regex only when the previous
  meaningful character cannot end an expression). The first version skipped regex handling
  in the extractor and promptly lost escapeHtml_'s body to `/"/g` swallowing a fake string.
  That class of walker failed before on whole 13k-line files (calls.js header explains
  why); it is reliable HERE because it only runs on short, simple, known helpers. If an
  entry ever gains a nested template literal, prefer simplifying the helper.

  USAGE:  node docs/tools/shared.js         exits 1 if any MUST_MATCH copy diverged
*/
const fs = require('fs');

const P1 = 'Phase 1/Code.js';
const P2 = 'Phase 2/pia_code.js';
const P3 = 'Admin/admin_code.js';

/* Helpers whose CODE must be equal after normalization, and where each must exist.
   kind: 'function' extracts `function <name>(...) {...}`;
   kind: 'const' extracts `const|var|let <name> = {...}`. */
const MUST_MATCH = [
  { name: 'ERR',                   kind: 'const',    files: [P1, P2, P3] },
  { name: 'ERR_MESSAGES',          kind: 'const',    files: [P1, P2, P3] },
  { name: 'fail_',                 kind: 'function', files: [P1, P2, P3] },
  { name: 'safeError_',            kind: 'function', files: [P1, P2, P3] },
  { name: 'isOwnerContext_',       kind: 'function', files: [P1, P2, P3] },
  { name: 'readSheetValues_',      kind: 'function', files: [P1, P2, P3] },
  { name: 'withSheetCache_',       kind: 'function', files: [P1, P2, P3] },
  { name: 'invalidateSheetCache_', kind: 'function', files: [P1, P2, P3] },
  { name: 'escapeHtml_',           kind: 'function', files: [P2, P3] },
];

const srcOf = {};
for (const f of [P1, P2, P3]) srcOf[f] = fs.readFileSync(f, 'utf8');

/* ── the one walker ─────────────────────────────────────────────────────────────
   tokens(code) yields the code with comments dropped, strings/regexes verbatim.
   findClose(code, openIdx) returns the index of the brace matching code[openIdx].
   Both share skip logic so they can never disagree about what is a string. */
const REGEX_OK = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '<', '>', undefined]);

function skipString(s, i) {           // s[i] is the opening quote; returns closing index
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q) return j;
  }
  return s.length - 1;
}
function skipRegex(s, i) {            // s[i] is the opening '/'; returns closing index
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') inClass = true;
    else if (s[j] === ']') inClass = false;
    else if (s[j] === '/' && !inClass) return j;
  }
  return s.length - 1;
}

/* Walk code from `from`; call visit(char, index) for every character that is real code or
   part of a string/regex literal (comments are skipped, never visited). */
function walk(code, from, to, visit) {
  let prevMeaning; // last non-whitespace code char seen (strings report their quote)
  for (let i = from; i < to; i++) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? to : nl; // skip to newline (the \n itself is visited next loop)
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i);
      i = end === -1 ? to : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(code, i);
      for (let k = i; k <= end; k++) visit(code[k], k, true);
      prevMeaning = c;
      i = end;
      continue;
    }
    if (c === '/' && (REGEX_OK.has(prevMeaning) || /(\breturn|\bcase|\btypeof)$/.test(code.slice(Math.max(0, i - 7), i).trim() + ''))) {
      const end = skipRegex(code, i);
      for (let k = i; k <= end; k++) visit(code[k], k, true);
      prevMeaning = '/';
      i = end;
      continue;
    }
    visit(c, i, false);
    if (!/\s/.test(c)) prevMeaning = c;
  }
}

function findClose(code, openIdx) {
  let depth = 0, close = -1;
  walk(code, openIdx, code.length, (c, i, inLiteral) => {
    if (close !== -1 || inLiteral) return;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) close = i;
  });
  return close;
}

function extract(src, name, kind) {
  const re = kind === 'const'
    ? new RegExp('\\b(?:const|var|let)\\s+' + name + '\\s*=\\s*\\{')
    : new RegExp('\\bfunction\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length - 1);
  const close = findClose(src, open);
  if (close === -1) return null;
  return src.slice(m.index, close + 1);
}

function normalize(code) {
  let out = '';
  walk(code, 0, code.length, (c) => { out += c; });
  return out
    .replace(/\b(?:var|let)\b/g, 'const')   // forgiven style divergence, see header
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── compare ── */
let failures = 0;
for (const entry of MUST_MATCH) {
  const versions = entry.files.map(f => {
    const raw = extract(srcOf[f], entry.name, entry.kind);
    return { file: f, norm: raw === null ? null : normalize(raw) };
  });

  const missing = versions.filter(v => v.norm === null);
  if (missing.length) {
    failures++;
    console.log('FAIL ' + entry.name + '  missing from: ' + missing.map(v => v.file).join(', '));
    continue;
  }

  const base = versions[0];
  const diverged = versions.slice(1).filter(v => v.norm !== base.norm);
  if (diverged.length === 0) {
    console.log('OK   ' + entry.name.padEnd(24) + ' identical across ' + versions.length + ' backends');
    continue;
  }

  failures++;
  console.log('FAIL ' + entry.name + '  copies have diverged:');
  for (const v of diverged) {
    let k = 0;
    while (k < base.norm.length && base.norm[k] === v.norm[k]) k++;
    const from = Math.max(0, k - 30);
    console.log('       ' + base.file.padEnd(22) + ' …' + base.norm.slice(from, k + 60) + '…');
    console.log('       ' + v.file.padEnd(22) + ' …' + v.norm.slice(from, k + 60) + '…');
  }
}

console.log(failures
  ? '\n' + failures + ' shared helper(s) diverged. Edit all copies together (CLAUDE.md 8c).'
  : '\nAll shared helpers are identical across their backends.');
process.exit(failures ? 1 : 0);
