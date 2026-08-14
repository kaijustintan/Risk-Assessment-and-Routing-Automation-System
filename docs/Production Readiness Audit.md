# Production Readiness Audit: Megaworld RARS (DCS / PIA / Admin)

**Date:** 2026-08-12
**Scope:** all six source files, three manifests, docs, tooling. Reviewed holistically against the architecture in CLAUDE.md, the live DB export (headers only), and the git history.
**Method:** static review + mechanical checks (`surface.js`, `calls.js`, the new `escapers.js`, duplicate-definition scan, guard scan of every public function in all three backends). No live execution at audit time: the test suite runs editor-side and the batch was not yet pasted.

> **Post-audit addendum (2026-08-13):** the batch was subsequently deployed, all five editor test
> suites were run against the live database, and one further Critical defect (S-06, serve-time
> `xmlns` truncation) surfaced *during* that deploy and was fixed. See §12 items 10-11 and §12b.
> The audit's own central claim, that the largest risk was the undeployed batch rather than
> anything in the code, is what that outage confirmed.
>
> **Second addendum (2026-08-14). ⚠️ Two features assessed below no longer exist.** This document
> is a point-in-time assessment and is kept as one; the affected passages are marked inline rather
> than rewritten. Both changes came from live test passes after this audit:
> 1. **Approver delegation was deleted** (write path removed entirely). Every statement below about
>    delegation, delegation exclusivity, or the Admin delegation UI describes a feature that is
>    **gone**. PIA's read-side helpers survive and are inert; `canActAs_` remains the identity guard
>    on all three decision mutators. See CLAUDE.md §8e (D3).
> 2. **The in-page document preview overlay was deleted**, having been proven impossible in the GAS
>    sandbox rather than merely buggy. "View" now opens the Google Drive viewer in a new tab.
>
> A fresh pre-deploy audit was run on 2026-08-14 against the current tree. Results in
> **[Addendum B](#addendum-b-pre-deploy-audit-2026-08-14)** at the end of this document.

---

## 1. Executive Summary

The codebase is in genuinely strong shape. The last three hardening waves (privatization sweep, error contract, schema enforcement, append-only rounds, delegation<sup>†</sup>) closed the classes of defect that matter most in a GAS system: unguarded RPC surface, silent column drift, and leaked internals. The workflow logic (approval ladder, escalation, return-restart, delegation exclusivity<sup>†</sup>) is sound and regression-tested.

> <sup>†</sup> **Superseded 2026-08-14:** delegation has since been removed. The approval ladder, escalation and return-restart assessments stand; the delegation-exclusivity one describes a path that no longer exists.

This audit found **one critical, previously unknown defect**: the HTML escaper in the DCS frontend was a no-op. Four of its five replacements mapped each character to itself, so `escapeHtml()` escaped nothing but apostrophes. It is the sole XSS defense for 71 interpolation sites in `Phase 1/index.html`, including approver comments rendered into `innerHTML` on the applicant's request-details screen. **This defect is in the currently deployed production frontend.** It is fixed in this repo as of today, and a new mechanical check (`docs/tools/escapers.js`) verifies all 8 escapers across the six files and fails the build if any regresses.

Everything else found is low-to-medium: dead code, two unused public endpoints, a redundant sheet-read pattern on decision paths, and thinner responsive coverage in Phase 2/Admin than Phase 1.

**The single biggest production risk is not in the code. It is that none of the recent work is deployed.** The live database is 11 header cells short of what the saved code expects, and the live PIA would (before the `getSystemSecret_` fix) have broken every approval link. The deploy sequence already agreed (paste, editor-test, heal, version-bump all three) is the real remaining work.

## 2. Production Readiness Score: **82 / 100**

| Dimension | Score | Note |
|---|---|---|
| Security | 88 | was 70 before today's XSS fix; remaining items are minor |
| Correctness / workflow | 92 | append-only rounds + schema enforcement + tests |
| Performance | 80 | fine at design load; known redundant reads on decision paths |
| Scalability | 78 | ceilings documented below; adequate for the intended volume |
| Maintainability | 85 | exceptional docs; two giant functions; unavoidable 3x duplication |
| UX / accessibility | 80 | Phase 1 polished; Phase 2/Admin thinner on mobile |
| Ops / deployability | 65 | the undeployed batch and one prod environment drag this down |

## 3. Overall Risk Rating: **MEDIUM** at audit time → **LOW-MEDIUM** now

Medium until the batch was pasted, editor-tested, and deployed, since that removed the live XSS, the live schema drift, and the approval-link ReferenceError in one stroke. All three are now closed and verified, plus S-06.

It is **not yet LOW**, and the reason is honest rather than technical: everything now running in production has passed its automated tests but has not been exercised end to end by a person. Until the hand-off checklist is worked through, the correct rating is **LOW-MEDIUM**. Automated green is evidence, not proof.

---

## 4. Security Findings

### S-01 🔴 CRITICAL (FIXED this session): `escapeHtml` in the DCS frontend escaped nothing

- **File:** `Phase 1/index.html:3235` (now ~3244)
- **Root cause:** the function body read `.replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"').replace(/'/g,'&#39;')`. Four identity no-ops. Most likely an editor, paste step, or entity-decoding pass "simplified" `'&amp;'` to `'&'` at some point; git blame places the broken form as far back as the folder reorganization commit, so it has been live for the system's whole deployed life.
- **Why it matters:** it is the only escaping applied at 71 interpolation sites feeding `innerHTML`. Concretely: an approver's comment (arbitrary text, typed by another user) is rendered into the applicant's request-details screen through this function. A `<img src=x onerror=...>` in a comment executes in the applicant's session. GAS's sandboxed iframe limits cookie theft, but injected script can still call `google.script.run` **as the viewing user**, i.e. act on their requests with their identity. Same exposure in reverse for applicant-supplied strings shown to the requester.
- **Why nothing caught it:** valid JS (passes `node --check`), correct-looking shape (passes review), and both existing tools audit names, not behavior.
- **Fix applied:** correct entities restored, `&` first; doc block now warns against re-simplification. New tool `docs/tools/escapers.js` checks every escaper in all six files for identity replaces and `&`-ordering, exits 1 on failure. Proven by temporarily reintroducing the bug: the tool caught it at the exact line.
- **Residual action for you:** this makes deploying **Phase 1** part of the security-critical deploy, not just PIA.

### S-02 LOW: the pre-cutoff token fallback in `isTokenValid_` is now dead code

- **File:** `Phase 2/pia_code.js:797-805`
- The fallback accepts an action-less token only if `issuedAt < 2026-06-01`. But the TTL check above it already rejects anything older than 14 days. Since 2026-06-15, no token can be both pre-cutoff and within TTL, so the branch can never return true. Zero risk; recommend deleting it (and its comment) in the next touch of that file so nobody reasons about a "fallback" that does not exist. Effort: Low.

### S-03 INFO (accepted): tokens are replayable within their 14-day TTL

- A review link is not single-use. This is bounded structurally: acting requires the logged-in user to match the token subject (`handleEmailAction_` identity check), and re-deciding a resolved row fails because every row lookup requires `Status === 'Pending'`. Replay therefore buys an attacker nothing they could not do from the UI. No change recommended.

### S-04 INFO (accepted): `ADMIN_API_KEY` comparison is not constant-time

- `admin_code.js:580`, `pia_code.js:2530`. A timing side channel over UrlFetch through Google's front end is not practically measurable, and the key is high-entropy. Not worth the code churn.

### S-05 LOW: two guarded but caller-less public endpoints

- `apiGenerateRevisionSessionId` (`pia_code.js:11256`) and `apiGetUserSubmissions` (`pia_code.js:10801`) have zero callers in any frontend (revision IDs are allocated internally at `submitApplication_` ~5516). Both are correctly guarded, so this is surface hygiene, not a hole. Per the §8b rule ("name the frontend line that calls it, or privatize"), either privatize them or record why they stay. Effort: Low.
- `apiGetUserSubmissions` also violates the error contract by re-throwing raw exceptions (see W-01).

### Where security is already excellent (no action)

- **RPC surface:** 115 of 154 PIA functions private; I re-verified every one of the 28 "public but unreferenced" functions across the three projects, and all carry `isOwnerContext_` or `checkAccess_` gates. None unguarded.
- **F-02 convention:** all three decision mutators re-resolve the caller server-side; `canActAs_` delegation exclusivity is correct as documented.
- **Error contract:** no raw exception reaches a user; `ref`-keyed logging works.
- **Files:** owner-only by default, anti-confused-deputy check on both download endpoints, 8 MB cap, the one `DOMAIN_WITH_LINK` elevation documented and justified.
- **Formula injection:** `sanitizeCellValue_` at the only human-opened export boundary.
- **Secrets:** all in Script Properties; the hardcoded-email grep found only doc-comment examples; `SYSTEM_SECRET` fail-closed; domain gate fail-closed with no bypass constant left on.

---

## 5. Performance Findings

### P-01 MEDIUM: decision paths derive the round repeatedly

- `getCurrentRound_` reads all three workflow sheets. `apiPhase3_ProcessISMDecision` computes it at entry (`:9567`) and again inside the escalation branch (`:9790`), and several helpers called within the same locked execution derive it again independently (23 call sites total). Inside one lock the value cannot change.
- **Recommendation:** thread the entry `__round` down as a parameter instead of recomputing. Saves 3-6 full-sheet reads per decision (roughly 0.5-2s of wall time per approver click at current sheet sizes).
- **Caution:** these are mutator paths, which is exactly where the read cache must stay off; the fix is parameter passing, not caching. Do it as its own commit with `testAppendOnlyRounds()` re-run. Effort: Medium.

### P-02 LOW (defer): decision writes are 5-7 individual `setValue` calls

- Each `setValue` is a round trip (~50-150ms). The written columns are non-contiguous, so batching needs `getRangeList` or a read-modify-write of the row. Only worth doing if approvers report the click feeling slow. Effort: Medium, benefit small.

### Where performance is already good (no action)

- The `readSheetValues_` conversion + `withSheetCache_` on the heavy read paths (pipeline view, admin data, aging) was the right 80/20.
- `__SS_HANDLE_CACHE` killed the ~13 re-opens per email-link click.
- The email queue keeps Gmail latency off the web-request path.
- Frontends: no polling loops (the favicon interval is trivial), RPC counts are modest, `escapeHtmlMemo` caching exists where render volume is high.

---

## 6. Scalability Findings

These are ceilings to know about, not defects. At the intended volume (an internal approval pipeline, human-paced, tens of requests per week) none of them bind.

| Ceiling | Where it bites | Verdict |
|---|---|---|
| **One global `ScriptLock` serializes every decision** across all requests (30s wait, then "System busy"). | Sustained more than ~1 concurrent decision per second. | Accept. Humans clicking approval buttons will not reach this. Do not shard the lock; correctness of the append-only model depends on it. |
| **Full-sheet reads** scale linearly with row count. | Noticeable slowdown as workflow sheets pass ~20-50k rows. | Retention (shipped inert) is the designed mitigation. Enable it (dry-run first) once the system has been stable in production for a quarter. |
| **Google Sheets 10M cell / concurrent-editor limits.** | Years away at expected volume. | Accept. If RARS ever becomes org-wide high volume, the DB moves to a real store; that is a rewrite decision, not a tweak. |
| **MailApp quota** (~1,500/day Workspace). | Mass reminder days. | Reminders are once per approver per day and only for the next pending step, so bounded by open requests. Accept. |

**Multi-department growth:** the schema already keys everything by request, not by org structure, and approver chains are per-request. Nothing structural blocks more departments. The one thing to watch is `InfoSec_Email_Config`: it is a single global reviewer pair, so org-wide adoption would eventually want per-division ISM routing. That is a feature decision for later, not debt.

---

## 7. Workflow & Business Logic Findings

### W-01 LOW: two error channels coexist at the API layer

- Most endpoints return the `{ok, code, message, ref}` envelope. But `apiGetUserSubmissions` re-throws raw exceptions, `apiGenerateRevisionSessionId` throws for all its denial cases, and the five draft endpoints throw `'User not authenticated'`. Frontends cope via `withFailureHandler`, so nothing is broken; but a thrown GAS error bypasses `safeError_`, meaning those specific messages skip the ref-keyed logging pattern (they are hand-written strings, so no ID leakage, which is why this is Low not High).
- **Recommendation:** converge on the envelope in a later pass; each conversion must update its frontend consumer in the same commit. Effort: Medium.

### W-02 INFO: escalation dedup derives the round twice

- `apiPhase3_ProcessISMDecision` checks `rowMatches_(…, __round)` and separately `roundOf_(…) === escalationRound` where `escalationRound` is a fresh `getCurrentRound_` call. Under the lock these are always equal, so it is redundant work, not a bug. Folds into P-01.

### Where the workflow is already excellent (no action)

I walked submission → Stage A → Stage B → escalation → DivHead return-path → finalize → certificate → routing, and the return/resubmit loop, against the CLAUDE.md §8b map. Specifically verified: the dedup guard on simultaneous escalation, the "resume the ISM chain at the next step" path after a DivHead approve, the DCS-returned block on PIA resubmit, `Status === 'Pending'` as the structural "still actionable" check, and delegation exclusivity (decide and view). No dead ends, no state that cannot progress, no transition that skips its notification. The append-only round model with `rowMatches_` round scoping is the strongest part of the system.

---

## 8. UI/UX Findings

I could not do a visual pass this session (your mouse; and screens are JS-rendered, so a real browser check is the only honest way). These are code-level observations to verify tomorrow.

### U-01 MEDIUM (verify visually): responsive coverage is uneven

- `Phase 1/index.html`: 7 media-query blocks, 768px + 480px breakpoints, sticky mobile button bar. Polished.
- `Phase 2/pia_index.html`: 2 blocks (767px + reduced-motion). The PIA is applicant-facing; applicants will open approval-status links on phones. Check the multi-section wizard and the summary tables at 480px.
- `Admin/adminView.html`: 2 blocks (900px/768px). Desktop-first is acceptable for an ISM control tower; no action unless ISM asks.

### U-02 LOW: empty-state coverage is thinner in PIA (9 occurrences) than Phase 1 (66)

- Worth one pass over the PIA lists (drafts, prior submissions) to confirm each renders a designed empty state rather than a blank region.

### Accessibility

- Reasonable for an internal tool: aria attributes present in all three (52/81/163), `<label>`s used on forms, reduced-motion honored in PIA, file-preview overlay closes on Esc. Two cheap wins if you want them: an `aria-live` region for toast/status updates, and a focus-trap in the preview overlay. Neither blocks production.

### Error surfacing

- All three frontends route failures through `withFailureHandler` into visible UI (Phase 1 alert components, PIA alert-danger, Admin `onDataError` + `showToast`). Covered; no action.

---

## 9. Code Quality Findings

### C-01 INFO: two giant functions

- `handleEmailAction_` (1,516 lines) and `getStyledHtmlWrapper_` (702). In a moduleless GAS file, splitting them buys readability but multiplies the private surface and churns a file that four other conventions depend on. **Recommendation: leave them until a functional change forces you in**, then extract the piece you touch. Refactoring them now, right before a deploy, is risk with no user-visible benefit.

### C-02 ACCEPTED: 11 helpers duplicated across all three backends

- `safeError_`, `readSheetValues_`, `isOwnerContext_`, etc. Necessary (no imports in GAS), documented ("edit all three together"), and now partially machine-checked. The realistic improvement is a `docs/tools/` check that diffs the shared helpers across the three files and warns on divergence; the design-token drift §8c fixed is exactly this failure mode. Effort: Low. Worth doing eventually, not before deploy.

### C-03 LOW: ~60 silent catch blocks

- Many are deliberate failsafes (email sends, snapshot writes) and documented as such. Some are bare `catch(e){}` with no log line (e.g. the JSON.parse guards). Opportunistic rule going forward: every new catch gets at least a `Logger.log`. No sweep needed.

### C-04 ACCEPTED: ~2,000 lines of test harness live inside `pia_code.js`

- Deliberate: editor-run tests must live in the project. They are owner-gated and self-cleaning. The cost is file size only.

### C-05 TRIVIAL: one stale `TODO` at `admin_code.js:539` ("Implement DCS submission logic here"), inside what appears to be a dead stub. Delete on next touch.

### Dead code inventory

- `isTokenValid_` fallback branch (S-02), the two caller-less endpoints (S-05), the `admin_code.js:539` stub. That is the whole list; previous sweeps already removed the rest (`Revision_History` family, `DCS_AUDIT_COLS`).

---

## 10. Architecture Findings

**The three-app / one-spreadsheet design is right for its constraints** and is now enforced, not just documented: `PIA_SCHEMA` + `assertSheetSchema_` turned the cross-app contract from a comment into a runtime check. The remaining architectural observations:

### A-01 MEDIUM: the spreadsheet is a single point of failure with no independent backup

- Drive version history exists and covers accidental edits, but a deletion or corruption of the file itself takes the whole system's data with it, and version history is not an export.
- **Recommendation (medium-term):** a weekly owner-run or time-triggered job in **Admin** (it already has `drive` + `scriptapp` scopes, so no new re-auth) that copies the spreadsheet to a dated backup in a restricted folder, keeping the last N. ~40 lines. This is the highest-value item on the whole remaining list relative to its cost.

### A-02 LOW: no environment separation

- One production deployment per app; testing happens in the saved-vs-deployed gap (which you are using correctly). A true staging setup is: one copy of the spreadsheet + three test deployments pointing at it via `DB_ID`/`SPREADSHEET_ID` properties. The property-driven design already supports this with zero code changes. Worth doing when a second maintainer arrives; for a single maintainer the editor-test window is a reasonable substitute.

---

## 11. Production Readiness Findings

| Area | State |
|---|---|
| **Deploy state** | 🔴 The blocker. Nothing from the last three batches is live. Live DB headers are 11 cells short; live PIA calls a function that no longer exists under that name (pre-fix); live DCS ships the no-op escaper. The agreed sequence stands: paste PIA → run `testAppendOnlyRounds()` (confirm no `FAILSAFE:` line) → run `repairSheetHeaders()` → paste the other five files → run remaining editor tests → version-bump all three deployments (never "New deployment") → spot checks. |
| Logging & monitoring | Adequate: ref-keyed errors, Executions log, `Risk_Audit` for business events, audit rows for retention runs and snapshot failures. No external monitoring is realistic in GAS; the daily reminder trigger doubles as a heartbeat (its absence in Executions = something is wrong). |
| Configuration | Script Properties, fully mapped in CLAUDE.md §3b, fail-closed on every missing key I checked (`SYSTEM_SECRET`, domain, retention). |
| Documentation | Exceptional. The manual + CLAUDE.md institutional memory is better than most professional teams maintain. |
| Rollback story | Git for code; sheet rows are not revertible (documented); retention/backfill are the two irreversible operations and both are inert/dry-run by default. Correct posture. |

---

## 12. Improvements Implemented

*(Updated same day: Kai directed "do ALL", so R-2 through R-7 and R-9 were implemented immediately after the audit. R-8 and R-10 are deliberately not code, see §13.)*

1. **Fixed S-01:** `escapeHtml` in `Phase 1/index.html` now genuinely escapes `& < > " '`, ampersand first, with a doc block explaining the failure so it cannot be "simplified" back.
2. **Added `docs/tools/escapers.js`:** verifies all 8 escapers across the six files (identity-replace + `&`-ordering checks), exit 1 on failure. Validated by reintroducing the bug: caught at the exact line.
3. **R-3 done:** the dead pre-cutoff token fallback in `isTokenValid_` is deleted; the doc block records why it was unreachable.
4. **R-4 done:** `apiGetUserSubmissions_` and `apiGenerateRevisionSessionId_` privatized (kept, not deleted, with re-publish instructions in their doc blocks). PIA surface: 117 private / 37 public. Bonus find during R-5: `checkAllApproved_` had zero live callers (the check runs inline in `processApprovalDecision_`) and was deleted.
5. **R-5 done:** the round is now threaded through decision executions. `getApplicationData_`, `notifyApprover_`, `notifyISMember_`, `routeApprovedRequest_`, `apiPhase3_InitializeISMWorkflow_`, and `queueEmail_` take an optional trailing `round` param (`round || getCurrentRound_(sessionId) || 1`, so omitting it is always safe); the locked decision functions pass their entry `__round` down (19 call sites). An ISM final-approve drops from up to ~7 round derivations (~21 sheet reads) to 1. Rounds are never threaded across a lock boundary; CLAUDE.md §8b records the convention.
6. **R-6 done:** the five draft endpoints return `fail_(ERR.UNAUTHORIZED)` instead of throwing; `apiSaveDraft`'s frontend handler gained an explicit `ok:false` branch (it would otherwise have shown "Saved" on a refused save); `apiRestoreDraft`'s handler already checked `result.ok`. Two deliberate non-conversions, both documented in-code: `apiGetApplicationData` (bare-object return shape predates the envelope; converting it means changing the success shape and its consumer together, a separate change) and the two privatized endpoints (convert on re-publish).
7. **R-2 done:** `runDatabaseBackup` / `runDatabaseBackup_` / `setupBackupTrigger` in Admin. Weekly Sunday ~3am copy of the DB spreadsheet to an auto-created `RARS Database Backups` folder, keeps the newest 8, trashes older (30-day recovery), audits every run. **Fail-loud:** the catch writes a `Database Backup Failed` audit row and rethrows so the trigger-failure digest emails the owner. No new scopes. Requires one editor run of `setupBackupTrigger()` after deploy.
8. **R-9 done:** `docs/tools/shared.js` compares the nine "identical copy per project" helpers across the three backends (comment- and `var`/`const`-insensitive). All nine currently identical. Validated by injecting a one-character drift into `safeError_`: caught with a pinpoint diff, exit 1. Also fixed its own first version's extractor bug (regex literals containing quotes), the same failure class calls.js documents.
9. **R-7 (code half) done:** PIA gained a 480px block mirroring Phase 1's proven one: tighter type/padding scale, smaller check-table, and a sticky bottom action bar on the five wizard screens + summary. **The visual half still needs eyes** (mouse day): confirm the sticky bar sits right and nothing overflows at 375-480px. On empty states: PIA has no list screens (drafts auto-resume, no "my submissions" view), so the raw count gap vs Phase 1 overstated the issue; no changes forced.
10. **S-06 found and fixed during the deploy itself (2026-08-13), a live outage:** `icon()` in `Phase 1/index.html` and `Admin/adminView.html` carried an inline SVG with an `xmlns` attribute. GAS truncated the served line at the double slash inside that namespace URL, leaving an unterminated string literal, so both apps blanked with `Failed to execute 'write' on 'Document'`. A third hand-duplicated copy sat inline in `renderForm()`'s Revision Mode badge (now calls `icon('warn', 13)` instead). Fixed by deleting the redundant attribute. New checker **`docs/tools/serve.js`** enforces it; validated by reintroducing the bug, which it catches while **all four other checkers pass**. Severity in hindsight: Critical, but only reachable at serve time, which is exactly why nothing offline saw it.
11. **Docs synced:** CLAUDE.md §8 gained the second confirmed serve-time trigger with its counter-examples and the "an undeployed batch is an untested batch" lesson; §8b now carries the **five**-tool pre-deploy ritual (`surface` + `calls` + `escapers` + `shared` + `serve`) and the name-vs-behaviour split that explains why the second group catches every real outage; the Admin manual documents the backup job and `BACKUP_FOLDER_ID`.

## 12b. The pattern behind every defect this session

Six defects surfaced across the audit and the deploy. Five of the six share one shape:

| Defect | Threw? | Caught by |
|---|---|---|
| `escapeHtml` identity no-ops | no | reading it, then `escapers.js` |
| `getSystemSecret_` ReferenceError | no (try/catch swallowed it) | a `FAILSAFE:` line inside a *passing* test |
| 11 missing header cells | no | dumping the live header rows |
| `testHeaderSchema` reporting SKIP as pass | no | reading its own control flow |
| `xmlns` serve-time truncation | yes, but only in production | the served VM bytes |
| `apiSaveDraft` showing "Saved" on refusal | no | tracing the new return path to its consumer |

**Not one was caught by `node --check`, a successful deploy, or code review.** Every one was caught by executing the thing or reading what it actually produced. That is the argument for the whole checker suite, and for deploying in small increments rather than batching a month of work.

## 13. Remaining (not code, or deliberately deferred)

| # | Item | Status |
|---|---|---|
| R-1 | Deploy all three apps | ✅ **Done 2026-08-13.** All three live; DCS and Admin confirmed rendering after the S-06 fix |
| R-8 | Enable retention | **Not flipped, on purpose.** Turning it on deletes data; that is an ISM/compliance decision made in the Admin Settings UI, not a code change. The dry-run preview is the first step |
| R-7b | Visual verify PIA mobile at 480px | Needs a mouse and eyes; CSS is in |
| R-10 | Staging environment | Ops, not code. Recipe: copy the DB spreadsheet, create one new deployment per app pointing at the copy via `SPREADSHEET_ID`/`DB_ID`, set the §3b URL properties to the staging `/exec` URLs. Zero code changes needed. Defer until a second maintainer exists |

## 14-16. Prioritization

Superseded by implementation: everything implementable landed today. What remains is R-1 (deploy), R-7b (visual pass), R-8 (ISM decision), R-10 (deferred ops). Long-term architectural items unchanged: per-division ISM routing if RARS goes org-wide, a real datastore if volume outgrows Sheets. Neither is worth starting now.

---

## Final Game Plan (updated 2026-08-13, post-deploy)

✅ Steps 1 and 2 are **done**: all three apps deployed, all five editor test suites pass
(`testAppendOnlyRounds` 12/12, `testDelegationResolution` 20/20, `testSheetReadCache` 10/10,
`testHeaderSchema` 26/26, `testAdminApi` 17/23 with all 6 failures confirmed as config, not code),
`repairSheetHeaders()` run once and verified against a live export, backup trigger installed and
a first backup written.

Remaining:

1. **Functional verification of everything now live but never exercised by a human.** This is the
   large one, and it is what the separate hand-off checklist covers, feature by feature.
2. **Visual pass** on PIA mobile at 375-480px (R-7b).
3. **Raise R-8 with ISM**: the retention switch, and the RA 10173 storage-limitation question that
   sits behind it. Not a developer decision.
4. **Deploy smaller from here.** The single most expensive thing this session was a month of work
   reaching the serializer all at once. Three of the six defects would have been trivial to locate
   had they shipped alone.
5. Then stop. Further changes should be pulled by real usage, not pushed by review.

---

## Addendum B: Pre-deploy audit (2026-08-14)

**Scope:** the tree at commit `3d1e7e4`, covering the two live test passes (feedback batches 2 and
3) and the delegation removal. **Verdict: no blocking defects.**

**Method note:** this audit deliberately weighted *executing and rendering* over reading, because
§12 established that every defect this project has shipped was invisible to name-level review.

### Mechanical checks

| Check | Result |
|---|---|
| Five checkers (`surface` / `calls` / `escapers` / `shared` / `serve`) | pass |
| `node --check`, all three backends | pass |
| All four inline frontend `<script>` blocks parsed | pass (the one apparent failure is the single legitimate `<?!= parentID ?>` scriptlet) |
| `getStyledHtmlWrapper_` **rendered**, emitted `<script>` parsed | pass, no template-literal corruption, both client functions present |
| 128 derived column indices evaluated as GAS would at load | all resolve, no duplicates, no load-time throw |
| Every inline event handler across all four surfaces | 113 targets, all resolve |
| Em dashes in the diff | none (the three surviving `'—'` are the documented empty-state placeholders) |
| Manifest / scope changes | none, so no forced re-authorisation |

### Invariants re-verified after two batches of edits

| Invariant | Result |
|---|---|
| No `ANYONE_WITH_LINK` anywhere | pass, all matches are comments |
| `DOMAIN_WITH_LINK` elevation sites | 5, all documented (B1 lazy view + the certificate exception) |
| F-06: no raw exception in a user-facing field | pass. The four `QUEUE_CRASH` sites write to `Risk_Audit`, which is explicitly exempt |
| Cross-app headers (`Risk_Audit`, `Data_Collection`) | byte-identical between Phase 1 and PIA |
| Retention still inert | pass (`enabled:false`, `dryRun:true`, fails safe) |
| No schema, sheet-name or `*_COLS` change in either commit | confirmed, so **no migration and no header repair needed** |

### Three findings that needed executing, not reading

1. **Deleting the `Delegations` tab cannot break approvals.** This was the highest-blast-radius
   question, since `canActAs_` guards all three decision mutators and reads that sheet. Verified:
   `resolveDelegate_` returns null on a missing sheet or any exception, so the guard collapses to a
   plain identity check. Also noted: the tab **recreates itself empty** if deleted, which is
   harmless but will otherwise be rediscovered as a bug.
2. **The new Admin "Flagged" column actually populates.** `safeRow_` stringifies every value, so
   `RoundNumber` arrives as `"1"`. Had `rowRound()` compared strictly against a number, every row
   would have counted as a prior round, silently hiding all pending rows and the current-round pill.
   It coerces correctly. This is the same failure shape as the §12 `ApproverFlags` defect.
3. **The client-side validation mirror is genuinely equivalent to the server.** The client copy is
   emitted from inside a template literal, where the backreference must be written `\\1` to survive
   as `\1`. Verified by building the regex from the emitted text and comparing behaviour case by
   case, rather than by reading the source.

### Open items (none blocking)

| # | Item | Status |
|---|---|---|
| B-1 | `InfoSec_Email_Config.Member_Email` still in column 8 from testing | **Do before go-live**, live sheet edit. Otherwise the shipped two-person ISM chain is not the one that was tested |
| B-2 | Megaworld logo hotlinked from `upload.wikimedia.org` in **7 places**, including every workflow email | Pre-existing, predates V2. Likely source of the console error seen in testing. A wiki anyone can edit hosting corporate branding is a poor dependency; fix is an inline image for pages and an attached inline image for emails. The certificate PDF is already immune |
| B-3 | `submitDCS_` (Admin) is a stub reachable via `doPost?action=submitDCS_` returning `{ok:true}` without persisting | Dead surface, not a hole (writes nothing, domain-gated). Worth deleting |
| B-4 | Cosmetic | duplicate line in `.gitignore`; dead `DCS_Risk_Audit` fallback and misleading log text in `Phase 1/Code.js`; `testFullSystemFlow`'s hardcoded identity still disables ~24 assertions |

### Deploy note

Because nothing schema-bearing changed, the three apps are deployed together for **consistency of
the shared approval-history format**, not because a partial deploy would corrupt data. The golden
rule still applies: edit the one deployment, choose **New version**, never "New deployment."

**Explicitly excellent, no action needed:** the approval-ladder logic, the append-only round model, the privatization/guard discipline, the error contract, file privacy, the schema enforcement, the docs. These sections were audited, not skipped.
