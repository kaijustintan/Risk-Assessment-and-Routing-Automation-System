# 09 · Gotchas & Hard-Won Learnings

> The list of things that cost hours. A fresh Claude should skim this before editing anything in a
> GAS-served file. Verbatim source: `CLAUDE.md` §8 + `reference-docs/claude-code-memory/`.

---

## 🚨 GAS serve-time template-literal corruption (cost a multi-hour blank-page debug, 2026-06-24)
A string-building helper written as a **template literal** (backticks) blanked the whole DCS page
with `Uncaught SyntaxError: Unexpected identifier 'style'`, thrown at GAS's `document.write(s(g))`
serve step — **even though the file passed `node --check` cleanly.**
- **Why:** `node --check` validates the file **on disk**; it cannot see GAS's serve-time
  serialization, which corrupted that one backtick template (it produced `<a … style="…">${…}</a>`),
  leaving an unterminated string so the parser choked on the next `style=` downstream.
- **Fix:** rebuild the helper with **plain ASCII string concatenation** (`'a' + x + 'b'`) — identical
  output, no backticks. (A `↗` Unicode char was a red herring; removing it didn't help — the
  template *delimiters* were the trigger.)
- **Rule:** when a GAS-served file blanks with a parse error that does NOT reproduce in `node --check`,
  suspect a template literal in a string helper and switch it to concatenation. "Valid JS on disk"
  ≠ "GAS serves it intact." For ground truth, read the served **VM** file at the console error's
  `VM##:line` — that's the actual served (corrupted) code, not your disk file.

## 🚨 `<?…?>` scriptlets are parsed even inside comments (cost a multi-hour crash debug, 2026-06-19)
The "Proceed to Phase 2" button crashed with `Unexpected token '...' (line 1201, file "Code")`.
- **Why:** GAS's HtmlService template engine scans raw file text for `<?…?>` scriptlet delimiters
  and **does not skip comments.** Two doc comments in `Phase 2/pia_index.html` contained a literal
  example `<?!= parentID ? ... ?>`; the engine compiled them and choked on the `...`.
- It surfaced **only** on the `?parentID=` path because that's the sole `doGet` branch calling
  `createTemplateFromFile('index').evaluate()` (the no-parentID path uses `createHtmlOutput`). The
  error was reported at the `.evaluate()` call site (`Code:1201`), masking the true location.
- **Fix:** removed the `<?…?>` delimiters from the two comments. The one real scriptlet
  (`const parentId = <?!= … ?>`, ~line 4044) is untouched.
- **Rule:** **never write literal `<?…?>` inside comments in a templated GAS HTML file** (`pia_index.html`
  is templated; DCS `index.html` and Admin `adminView.html` are NOT — they use `createHtmlOutputFromFile`).
- **Related:** VS Code shows false-positive "problems" on that real scriptlet — **do not "fix" it**;
  deleting it breaks PIA's parentID handoff. Silence with `.vscode/settings.json`
  `{"html.validate.scripts": false}` if desired.

## Frontend / rendering gotchas
- **Screens are rendered by JS, not static HTML.** The 9 DCS screen `<div>`s are empty in the file;
  `render*()` functions fill them at runtime. Ctrl+F for on-screen text often misses it — search the
  matching render function instead.
- **Drafts do NOT store uploaded files** — only text autosaves (server-side, 7-day TTL). Resuming a
  draft requires re-uploading files. This is **intended**, not a bug.
- **`localStorage` is intentionally disabled** to avoid client/server state mismatch.
- **Revision mode** (`state.isEditing = true`) highlights flagged fields and forces re-upload of
  **flagged files only** — non-flagged files stay in Drive.
- **"Returned" ≠ "Denied":** returned is a fixable loop; denied/rejected is terminal.
- **Favicon override** uses a MutationObserver + setInterval (GAS injects its own icon) — don't
  remove it thinking it's dead code.
- **Downloadables** are driven by the `DOWNLOADABLES` array in `renderGuide()` (labels/icons = code);
  the actual URLs are admin-managed `LINK_*_TEMPLATE` rows in `System_Configuration` (generic config
  passthrough — no backend change to add/edit a link). Missing row → "Link not set" (`#`).
- **The Step-2 upload field is one dynamic field keyed by doc TYPE (NDA/DPA/CU)** — NOT mirrored to
  the 7 download templates. The applicant uploads one signed doc regardless of which template they
  downloaded. Don't try to make uploads 7-way.

## Email / delivery gotchas
- **Two email engines:** DCS sends **directly** (`MailApp.sendEmail` in `notifyDcsRequester_`, silent
  try/catch). PIA **queues** (`queueEmail` → `Email_Queue` sheet → `processEmailQueue` time-trigger,
  every ~1 min). So PIA emails arrive 1–2 min after the action. **"Sent" in `Email_Queue` ≠
  delivered.**
- **"No emails received" was a Gmail filter, not a bug** — a recipient's "Skip the Inbox + Apply
  label" filter auto-archived mail to All Mail. Always test with a clean, monitored inbox.
- **Email links freeze at send time** from Script Properties; updating a property fixes future
  emails only. **HMAC review tokens have a 14-day TTL** — test with fresh transactions + fresh links.

## Secrets / tokens
- **`SYSTEM_SECRET`** (PIA project) signs the HMAC approve/deny tokens. **Rotating it kills every
  link in already-sent emails** — rotate only in a quiet window. `ADMIN_API_KEY` is safe to rotate
  anytime (server-side only, not in the web UI).
- Tokens are **action-bound** (14-day TTL). An attacker editing reject→approve in Burp fails because
  the server re-computes the HMAC with `SYSTEM_SECRET`. The links only *redirect* to the form; they
  don't auto-approve.
- Old docs' name "`HMAC_SECRET`" is a **misnomer** — the real name is `SYSTEM_SECRET` (PIA).

## Behavioral / validation gotchas
- **Server enforces the 50-char remarks minimum only for Deny/Return**, NOT Approve/Escalate — so the
  **client-side gate matters** for Approve/Escalate (and routing is required on Approve/Escalate).
- **Identity guards (security hardening) block dev test functions** that call decision processors
  with synthetic emails (e.g. `testReminderEngine`, `runComprehensiveTests`). Expected side effect —
  don't add a client-reachable bypass.
- **Surname-greeting heuristic** assumes the 2-initial Megaworld email format (`drbisquera@…` → strip
  2 leading initials → "Bisquera"; `ctpaulican.global@…` → "Paulican"). Imperfect for other formats.
- **DSA payload leak (fixed):** picking External → attaching a DSA → switching to Internal used to
  leave the file in the hidden input so it submitted anyway. Guarded with `access === 'External'`.

## Tooling / environment gotchas (Kai's Windows machine)
- **`python`/`python3` are broken Windows Store stubs** — don't rely on them.
- **`jq` may not be installed** on the work machine (it was used by subagents here, but historically
  parsing was done via `unzip` + Node). `pdftotext` IS available (used to read the PDF manuals).
- **GAS error pages are browser-cached** — append `?cb=N` (increment N) or use `…/exec?test=1` to
  bypass when retesting a fix.
- **`/dev` URL is editor-gated** (only the project owner/editor can open — Kai can't, owner is
  `ismaiapps@…` needing 2FA he lacks). **`/exec` is domain-gated.** Test on `/exec` as a domain user.
- **Multi-login:** GAS `authuser=` reads the browser's *active* Google account. Tokenized approver
  links fail if you're signed into a different account — open as the intended approver (Incognito).
- When running browser-console attack-sims, the console context must be switched to the app's
  **sandbox iframe** or `google.script.run` is `undefined`.
