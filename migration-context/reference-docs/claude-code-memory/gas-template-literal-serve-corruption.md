---
name: gas-template-literal-serve-corruption
description: GAS-served HTML can blank with a parse error from a template literal that passes node --check on disk; fix = string concatenation
metadata: 
  node_type: memory
  type: project
  originSessionId: ca7fe53b-1aa9-4c54-bac6-35d76ee23ff7
---

In the Megaworld RARS DCS app (`Phase 1/index.html`, served by GAS `createHtmlOutputFromFile`),
a string-building helper written as a **template literal** (backticks) caused the whole page to
blank with `Uncaught SyntaxError: Unexpected identifier 'style'` at GAS's `document.write(s(g))`
serve step — even though the file passed `node --check` cleanly every time.

**Why:** `node --check` validates the file on disk; it cannot see GAS's serve-time serialization.
GAS's IFRAME pipeline corrupted that specific backtick template (producing `<a … style="…">${…}</a>`),
leaving an unterminated string; the parser then choked on the next `style=` downstream. The `↗`
Unicode char was a red herring — removing it did not help; the template-literal *delimiters* were the
real trigger.

**How to apply:** When a GAS-served HTML file blanks with a parse error (`Unexpected identifier`,
unterminated string) that does NOT reproduce in `node --check`, suspect a template literal in a
string helper and rebuild it with plain ASCII string concatenation (`'a' + x + 'b'`). "Valid JS on
disk" ≠ "GAS serves it intact." Verified empirically: identical content, template form broke,
concat form worked. Confirmed 2026-06-24 fixing the Wave 2 `#2` clickable-document-link helper
`fileLinkHtml` in `renderRequestDetails`.
