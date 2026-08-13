/*
  FILE: docs/tools/escapers.js

  LAYMAN (Tropang Ex): Yung mga function na nag-e-escape ng HTML ay ang huling harang
  laban sa XSS. Problema: kapag napalitan ng bare character yung entity sa kanang bahagi
  (`'&amp;'` naging `'&'`), yung function ay tumatakbo pa rin, pumapasa pa rin sa
  `node --check`, at mukhang tama pa rin sa mabilisang basa. Wala lang itong ginagawa.
  Ito yung nagche-check kung totoong nag-e-escape sila.

  TECHNICAL: Identity-replace detector for the HTML escapers. Phase 1/index.html shipped
  with escapeHtml reading

      .replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"')
                                                            .replace(/'/g,'&#39;')

  Four of the five replacements were no-ops, so only the apostrophe was ever escaped. It
  was the sole defence for 71 interpolation sites feeding innerHTML, including approver
  comments. It survived node --check (the code is valid), surface.js and calls.js (both
  ask about names, not behaviour), and every review pass, because at a glance the chain
  looks exactly like a correct escaper.

  Two checks per escaper found:

    1. IDENTITY   a `.replace(/X/g, 'Y')` where Y is the same single character as X.
                  That is the defect above: syntactically fine, semantically nothing.
    2. ORDERING   `&` must be escaped FIRST. Escaping it later re-escapes the ampersands
                  that the other replacements just emitted, turning &lt; into &amp;lt;
                  and rendering literal entity text at the user.

  🚩 SCOPE, deliberately narrow, same reasoning as calls.js. This does not try to prove an
  escaper is complete or that every sink is guarded; that needs real taint analysis. It
  answers the one question that produced a live hole: do the escapers this repo already
  has actually escape?

  Escapers are located by name (esc / escapeHtml / escapeHtml_ / esc_ and friends) and
  their bodies read by brace matching, so nested helpers such as escapeHtmlLocal and the
  copy inside pia_code.js's getStyledHtmlWrapper_ template literal are covered too.

  USAGE:  node docs/tools/escapers.js       exits 1 if any escaper fails a check
*/
const fs = require('fs');

const FILES = [
  'Phase 1/Code.js', 'Phase 2/pia_code.js', 'Admin/admin_code.js',
  'Phase 1/index.html', 'Phase 2/pia_index.html', 'Admin/adminView.html'
];

// Names that are HTML escapers in this repo. Anchored so `describe`, `escalate` and
// `getEscapedX` do not get dragged in.
const IS_ESCAPER = /^(esc|escape)(Html)?(Local|Memo)?_?$/i;

// The five characters an HTML escaper here is expected to handle, and what each must
// NOT map to (itself). Value is informational only; the check is Y !== X.
const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

let failures = 0;
let checked = 0;

/* Return the function body for `function <name>(...) { ... }`, by brace matching from the
   first { after the signature. Good enough here: escaper bodies are a single return
   statement, so no strings or comments containing unbalanced braces occur inside them. */
function bodyOf(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

for (const file of FILES) {
  const src = fs.readFileSync(file, 'utf8');

  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (!IS_ESCAPER.test(name)) continue;

    const body = bodyOf(src, m.index);
    if (body === null) continue;

    /* Pull every .replace(/X/g, 'Y'). A memoizing or delegating wrapper (escapeHtmlMemo)
       has none of its own and is skipped: the escaper it calls is checked on its own. */
    const pairs = [...body.matchAll(/\.replace\(\s*\/(\\?.)\/g\s*,\s*(['"])(.*?)\2\s*\)/g)]
      .map(p => ({ from: p[1].replace(/^\\/, ''), to: p[3] }));
    if (pairs.length === 0) continue;

    checked++;
    const where = file + ':' + lineOf(src, m.index) + '  ' + name + '()';
    const problems = [];

    for (const p of pairs) {
      if (p.to === p.from) {
        problems.push('identity replace: /' + p.from + '/g -> \'' + p.to +
                      '\' does nothing (expected \'' + (ENTITY[p.from] || '&…;') + '\')');
      }
    }

    const ampAt = pairs.findIndex(p => p.from === '&');
    if (ampAt > 0) {
      problems.push('& is escaped at position ' + (ampAt + 1) + ' of ' + pairs.length +
                    '; it must be first, or it double-escapes the entities emitted before it');
    }

    if (problems.length) {
      failures++;
      console.log('FAIL ' + where);
      problems.forEach(p => console.log('       ' + p));
    } else {
      console.log('OK   ' + where + '  (' + pairs.length + ' replacements)');
    }
  }
}

console.log(failures
  ? '\n' + failures + ' of ' + checked + ' escaper(s) do not actually escape'
  : '\nAll ' + checked + ' escapers escape correctly, & first.');
process.exit(failures ? 1 : 0);
