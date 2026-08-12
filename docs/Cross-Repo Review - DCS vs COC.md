# Cross-Repository Architectural Review: RARS (DCS/PIA/Admin) ↔ COC E-Certificate Portal

**Reviewer position:** inside the DCS repo (`megaworld-DCS-automation`), reviewing against the
supplied COC System Profile (`megaworld-COC-automation` @ `bf20b31`).
**Review date:** 2026-08-11
**DCS state reviewed:** `main` @ `b24bfd6` **plus uncommitted working-tree changes**
(`CLAUDE.md`, `Phase 1/Code.js`, `Phase 2/pia_code.js`, two manual files).
**Scale:** DCS = 35,764 lines across 3 GAS projects. COC = ~14,000 lines in 1 GAS project.

> This document follows the code, not the docs, on both sides. Where DCS's own `CLAUDE.md` or
> `docs/Security - Review Findings.md` disagrees with what the source actually does, the source wins
> and the disagreement is called out.

---

## 0. Verdict first

**These are not two versions of the same system. They are two different bets, and each one won a
different half of the problem.**

- **DCS bet on operational depth.** It has the durable email queue, the reminder cadence engine, the
  per-field return flagging, server-side drafts, magic-byte upload validation, a real admin control
  tower, and an editor-run integration test harness. Operationally it is years ahead.
- **COC bet on structural discipline.** It has the append-only event log, the single accessor seam,
  the closed callable surface, admin-owned approver registries, and private-by-default files.
  Architecturally it is years ahead.

The uncomfortable summary: **DCS built more, COC built cleaner.** DCS is at the point where its
missing structure is now producing real bugs (the `getPIARecordByDCSId_` `'B:B'` column bug shipped
in `7590b7c` is exactly the class of bug an accessor seam prevents). COC is at the point where its
missing operations will produce real outages (a Gmail quota hit silently disables every notification
in the system, with no queue, no retry, and no alert).

**Single highest-severity finding in this review:** DCS exposes **178 of its 229 top-level functions**
to any authenticated domain user via `google.script.run`, and **22 of those in the PIA project have no
authorization check at all**, including one that returns the HMAC signing secret verbatim. COC solved
this exact problem in `bf20b31` and got it right. This is the one thing DCS should take from COC
before anything else on this list.

---

## Part I. DCS as-built

Written so a COC-side reviewer can use this document symmetrically.

### I.1 What it is

**RARS** (Risk Assessment & Routing System) is Megaworld's pipeline for requesting access to company
data. Three **independent Google Apps Script web apps**, each its own GAS project, deployment, and
manifest:

| Phase | App | Frontend | Backend | Role |
|---|---|---|---|---|
| 1 | **DCS** (Data Collection System) | `Phase 1/index.html` (6,897 L) | `Phase 1/Code.js` (3,308 L) | The request form. Profile, approvers, NDA/DPA/DSA uploads. |
| 2 | **PIA** (Privacy Impact Assessment) | `Phase 2/pia_index.html` (4,145 L) | `Phase 2/pia_code.js` (10,881 L) | The privacy questionnaire and **the entire approval ladder**. |
| 3 | **Admin** | `Admin/adminView.html` (6,525 L) | `Admin/admin_code.js` (4,008 L) | ISM control tower: dashboard, email queue ops, routing, analytics, config. |

The three apps **never call each other**. Their only integration point is **one shared Google
Spreadsheet**. Cross-app navigation is wired through deployment URLs stored in Script Properties
(`PIA_APP_URL`, `WEB_APP_URL`, `DCS_WEB_APP_URL`).

This is a genuinely different topology from COC's single container-bound project, and it is the root
of DCS's biggest structural liabilities (see §II.2, §II.11).

### I.2 Database (11 tabs, one spreadsheet)

| Tab | Owner | Holds |
|---|---|---|
| `Data_Collection` | DCS | One row per DCS request. 11 cols, `Metadata_JSON` + `Metadata_Agency` are JSON blobs. |
| `Applications` | PIA | One row per PIA. `PIA_1_Data` … `PIA_5_Data` are JSON blobs. `Linked_ReqID` is the cross-phase FK. |
| `Approval_Workflow` | PIA | Stage A: Immediate Head, Dept Head. |
| `ISM_Approval_Workflow` | PIA | Stage B: two InfoSec members, sequential. |
| `DivisionHead_Approval_Workflow` | PIA | Stage D: escalation only. |
| `Revision_History` | PIA | Append-only snapshot of wiped rounds. **Best-effort.** |
| `Email_Queue` | PIA | Durable outbound mail queue. |
| `Risk_Audit` | DCS + PIA + Admin | Action log + auto risk flags. Genuinely append-only. |
| `Drafts` | DCS + PIA | Server-side autosave, 7-day TTL. |
| `System_Configuration` | Admin | Key/value settings, template download links. |
| `InfoSec_Email_Config` | Admin | ISM reviewers + DCOPS/TechServe destinations, per-site. |
| `Admin_Notification_Config` | Admin | Admin alert routing. |

**No accessor layer.** Column maps (`DC_COL`, `APPLICATIONS_COLS`, `APPROVAL_COLS`, …) are declared
per project, and every read is a raw `getDataRange().getValues()` or `createTextFinder()` at the call
site. `pia_code.js` alone contains **132 full-sheet reads**.

### I.3 The approval ladder (all of it lives in PIA)

```
DCS submit → status COMPLETE immediately (no gate in Phase 1 at all)
   │
PIA submit
   ├─ STAGE A  Approval_Workflow          Step 1 Immediate Head → Step 2 Dept Head
   │           (both emails typed by the APPLICANT in PIA1; fallback PRIVACY_OFFICER_EMAIL)
   ├─ STAGE B  ISM_Approval_Workflow      InfoSec Person 1 → Person 2, sequential
   │           each can: Approve · Deny · Return · EscalateToDivisionHead
   ├─ STAGE C  routing choice             DCOPS · TECHSERVE · BOTH (not a gate)
   └─ STAGE D  DivisionHead_…             only on escalation; approve resumes the ISM chain
Final: all ISM approve → 'Approved by ISM' → certificate emailed to DCOPS/TechServe,
       applicant notified, DCS row flipped to COMPLETE
```

**Return = full restart.** A return from any approver bounces to the applicant. On resubmit,
`submitApplication` **deletes every row** in all three workflow sheets for that session and rebuilds
from Stage A Step 1. See §III.1, this is the biggest architectural gap.

### I.4 Security model as implemented

| Control | Implementation | Assessment |
|---|---|---|
| Deployment | `executeAs: USER_DEPLOYING`, `access: DOMAIN` on all 3 manifests | Correct |
| Mail scope | `gmail.send` + `script.send_mail` | **Better than COC's full `mail.google.com`** |
| Drive scope | full `drive` on all 3 | Same as COC, both too broad |
| Domain gate | `isAuthorizedDomain()` + `const ENABLED_DOMAIN_CHECK = true` kill-switch in code | Fail-secure, kill-switch is version-controlled |
| Identity | `Session.getActiveUser().getEmail()`, never a parameter | Correct, 67 call sites across 3 files |
| Email compare | `getNormalizedEmail()` strips `+alias`, lowercases | Correct |
| Decision authz | F-02 guard on all 3 decision mutators | Correct |
| Read authz | F-04 owner guard on `apiGetRequestData`; `isAuthorizedForApplication_` on 2 PIA readers | **Guards the wrapper, not the primitive.** See §III.3 |
| Email action links | HMAC-SHA256 over `sessionId+email+ts+action`, 14-day TTL, **AND** `Session.getActiveUser() === target` | **Excellent.** Token is not a bearer credential |
| Concurrency | `LockService.getScriptLock()` at 12 sites, TOCTOU re-read inside the lock | Correct |
| Uploads | MIME allowlist + extension allowlist + **magic-byte signature check** + 10 MB cap | **Better than COC (no MIME allowlist at all)** |
| File confidentiality | `setSharing(ANYONE_WITH_LINK)` on every uploaded NDA/DPA/DSA | **Serious defect.** See §III.6 |
| Callable surface | 178 of 229 functions public; 22 unguarded in PIA | **Critical.** See §III.3 |

---

## Part II. What DCS does better, and COC should adopt

Ordered by value to COC.

---

### II.1 Durable email queue with retry, failure escalation, and rate control

**Adopt by: COC.** Effort: medium. Impact: high.

**Why it matters (layman).** In COC today, if Gmail hiccups or you hit the daily quota, the email is
just gone. `sendBrandedEmail_` logs the error and swallows it. Nobody is told. The approver never
learns they have something to review, the requestor never learns their request moved, and the only
trace is a line in an execution log nobody reads. The system looks fine and is quietly broken.

DCS separates *deciding to send* from *actually sending*.

**How DCS does it** (`Phase 2/pia_code.js:4855` `queueEmail`, `:4932` `processEmailQueue`):

1. Every workflow email is written as a row into the `Email_Queue` sheet: recipient, subject, plain
   body, HTML body, type, status, attempt count, last error, timestamps.
2. A **1-minute time trigger** drains the queue: max 15 sends per cycle, **10-second spacing** between
   sends, and it checks `MailApp.getRemainingDailyQuota()` before each send and stops the cycle below 2.
3. On failure it increments `Attempts` and leaves status `Pending`. After **9 attempts** it flips to
   `Failed` and runs a failsafe: stamps `EmailStatus`/`EmailError` onto the corresponding workflow row,
   emails the admin (once, guarded by a `NOTIFIED_ADMIN` column so it never spams), and optionally
   emails the requestor a "we're on it" notice, per `Admin_Notification_Config`.
4. The admin console lists the queue, its health summary, and offers retry-one / retry-all-for-session
   / cancel.

**Expected benefits for COC.** Notification delivery stops being a silent single point of failure.
The 10-second spacing alone removes the burst pattern that trips Gmail rate limits. The admin gets a
signal instead of a mystery. And because the body is already rendered when it is queued, a retry sends
the *original* content, not a re-render against changed state.

**Trade-offs.** (a) Adds a mandatory trigger; if it is not registered, mail silently stops entirely,
which is a *worse* failure than today. DCS mitigates this: `sendDailyReminders` explicitly checks
whether the `processEmailQueue` trigger exists and logs a loud warning if not. Copy that check.
(b) Adds delay, up to 60 seconds plus spacing. For approval notifications that is fine.
(c) The queue sheet grows unboundedly; needs a purge.

**Implementation for COC.** Add an `Email_Queue` tab and a `queueEmail_()` that writes a row. Change
`sendBrandedEmail_` to enqueue instead of send, keeping the exact same signature so none of the 15
`send*` functions change. Add `processEmailQueue()` + `registerEmailQueueTrigger()` alongside the two
existing trigger registrars, both guarded by `isOwnerContext_()`. This is a genuinely small diff for a
large reliability gain, precisely because COC already funnels everything through one door.

---

### II.2 Per-field flagging on return, instead of one free-text reason

**Adopt by: COC.** Effort: medium-high. Impact: high (this is the biggest UX gap between the two).

**Why it matters (layman).** In COC, an approver returns a request with one comment box: "please fix
the contract dates and re-upload the signed copy." The requestor now has to read prose, guess which
of 14 fields is wrong, and re-upload everything to be safe. Every misread is another round trip.

In DCS, the approver clicks a flag button next to **the specific field or the specific document**.
On the requestor's side, the form opens in revision mode with those exact fields outlined in red,
the approver's note printed inline under each one, and **only the flagged files** required for
re-upload. Everything unflagged stays in Drive untouched.

**How DCS does it.** `Applications.Approver_Flags` is a JSON map of `fieldKey → reason`. The review
forms render a `makeFlagBtn(label)` next to each field and each document (including per-supplementary
document, labelled `'DCS - <Doc>'`). Returning requires at least one flagged item. On the DCS side,
`state.isEditing = true` drives `getFlagMessage()` / `getFlagClass()` / `getContainerFlagHtml()` /
`isFileFlaggedForRevision()`, and `validateFileUploads()` refuses submit until every flagged file is
re-attached. `submitDCS` reads the flags **server-side** from the PIA `Applications` sheet rather than
trusting the client, and archives superseded files instead of trashing them.

**Expected benefits for COC.** Fewer return cycles, which is the single most expensive thing in a
sequential approval workflow. Also a much better audit story: "what specifically was wrong in round 2"
becomes structured data rather than prose.

**Trade-offs.** Real work: it touches the review form, the return handler, the schema, and the
requestor form. It also needs a stable field-key vocabulary, and DCS learned the hard way that
substring matching on those keys breaks (there is now an explicit guard so supplementary filename keys
never substring-match other cards).

**Implementation for COC.** COC's shape actually makes this easier than it was in DCS, because
`Activity_Log` already stores a `remark` per action. Add a `flags` JSON column to the `returned` action
row rather than a new sheet. Render flag buttons in `ReviewDetail.html` next to each field and each
attachment row. On the requestor side, `NewRequest.html` in resubmit mode reads the latest `returned`
action's flags and applies a `.has-flag` class plus an inline note. Keep the free-text remark as well;
DCS keeps both and it is the right call.

---

### II.3 Server-side draft autosave

**Adopt by: COC.** Effort: low-medium. Impact: medium-high.

**Why it matters.** COC's new-request form has 14 short fields, a remark, and up to 10 file uploads
with per-file descriptions. Close the tab and it is all gone. DCS autosaves the entire form state to
the server on a **1.2-second debounce**, keyed by a server-minted session ID.

**How DCS does it.** `Drafts` sheet (`DraftID, UserEmail, SessionID, Type, StateJSON, SavedAt,
ExpiresAt`), `apiSaveDraft` / `apiRestoreDraft` / `apiListUserDrafts` / `apiDeleteDraft`, 7-day TTL, max
5 concurrent drafts per user, purged by a daily trigger. Draft rows are cleaned up inside the submit
lock via a lock-free helper (`cleanupDraftsForUser_`) to avoid lock reentrancy.

Two deliberate constraints worth copying verbatim:
- **`localStorage` is intentionally disabled.** Server-side only, so there is never a client/server
  state mismatch and never a stale draft on a shared machine.
- **Files are not stored in drafts.** Text only. Resuming requires re-attaching. DCS shows an amber
  "please re-attach" notice and a confirm-guard on submit. Do not try to base64 files into a sheet cell.

**Trade-offs.** Adds a sheet, a debounce, and a purge trigger. Adds one write per 1.2s of typing, which
is fine at this volume but is exactly the kind of thing that would need a real backing store at scale.

---

### II.4 Reminder cadence engine with continuation tokens

**Adopt by: COC (partially). DCS should adopt COC's half too.** Effort: low. Impact: medium.

The two systems each solved half of this correctly.

| Dimension | DCS | COC | Winner |
|---|---|---|---|
| Cadence | First nudge **7 days** after `NOTIFIED_DATE`, then every **3 days** from `REMINDER_DATE` | Daily from day 1 | **DCS.** Daily-from-day-1 trains approvers to filter the sender |
| Grouping | One email per pending request | **One digest per approver**, bucketed by normalized email | **COC.** DCS spams an approver holding 5 requests |
| 6-min ceiling | `CacheService` continuation token, `MAX_SCAN_ROWS = 300`, resumes next run | None | **DCS** |
| Pre-filter | Builds a `Set` of session IDs in active states first, skips phantom/completed rows | Full scan | **DCS** |
| Quota awareness | Checks remaining quota, saves a continuation token, stops cleanly | None | **DCS** |
| Sequencing | Only the **lowest pending step per session** is eligible, so it never nags someone not yet reached | Same intent | Tie |
| Date handling | Explicitly normalizes `Date` objects back to `YYYY-MM-DD`, because Sheets silently coerces | Reduces both dates to a Manila calendar day before differencing | Tie, both correct |

**Recommendation.** COC adopts DCS's cadence (7-then-3), the continuation token, the active-status
pre-filter, and the quota check. DCS adopts COC's per-approver digest bucketing.

DCS's date-coercion comment is worth quoting into COC's code, because it is a bug that will bite:

> `CRITICAL: Normalize reminderDate to YYYY-MM-DD string. Sheets auto-converts "2026-06-04" into a
> Date object, so String(dateObj) != "2026-06-04" and breaks the skip check below.`

---

### II.5 Indexed lookup instead of full-sheet reads

**Adopt by: COC (and DCS's own PIA project).** Effort: low. Impact: high.

**This directly fixes COC §12.4, the "most serious scalability problem" in that profile, with no schema
change.**

`Phase 1/Code.js` uses `createTextFinder()` **24 times** and `getDataRange().getValues()` only 6 times.
Instead of pulling the whole tab into memory and scanning it in JS, it asks Sheets to find the cell:

```js
const finder = sheet.getRange('B:B')
  .createTextFinder(String(reqId))
  .matchEntireCell(true)
  .findAll();
const row = finder[finder.length - 1].getRow();          // last match = newest revision
const values = sheet.getRange(row, 1, 1, 11).getValues()[0];  // one row, not the tab
```

That is one server-side indexed search plus one 11-cell read, versus COC's `getDataRows_()` full-tab
read. In COC's `getPendingApprovals()`, which calls `getGroupApprovers_()` per row scanned, the
difference is roughly O(rows × tab) versus O(rows).

**Caveat, and it is important.** This pattern is only correct because DCS pairs it with `findAll()` +
"take the last match" and a re-read inside the lock. `createTextFinder().find()` returning the *first*
match is a subtle bug when duplicates exist. Copy the whole pattern, not just the API call.

**Note for DCS.** Phase 1 got this right and PIA did not. `pia_code.js` has 132 full-sheet reads and
6 TextFinders; `admin_code.js` has 15 and 0. The correct pattern already exists in this repo, in the
same codebase, written by the same team. It just was not carried across.

---

### II.6 Magic-byte upload validation

**Adopt by: COC.** Effort: low. Impact: medium-high.

COC §12.13 says it plainly: "No MIME-type allowlist on uploads. Any file type up to 5 MB is accepted,
and the client-supplied `mimeType` is trusted for the blob."

DCS `uploadProxy` (`Phase 1/Code.js:1090`) runs five layers:

1. MIME allowlist (`pdf`, `msword`, `docx`, and `application/octet-stream`, with a comment explaining
   that browsers genuinely misreport valid PDFs).
2. Filename sanitization against `/[/\\<>:"|?*\x00-\x1f]/g`, capped at 255 chars, then **renamed** to
   `${reqId}-${fileType}.${ext}` so the user-supplied name never becomes the Drive name.
3. Extension allowlist.
4. Size bounds: minimum 4 bytes, maximum 10 MB, checked on the **decoded** bytes.
5. **Magic-byte signature check**: first 4 bytes must match the claimed extension
   (`25504446` = `%PDF`, `D0CF11E0` = OLE2 for `.doc`, `504B0304` = ZIP for `.docx`), else it throws
   `"Possible MIME spoofing attempt."`

Layer 5 is the one COC is missing entirely, and it is 15 lines.

**Trade-off.** Magic bytes reject some legitimately weird files. DCS accepts that. Note it does **not**
scan for macros; DCS's own `docs/Security - Recommendations.md` §3 lists that as open backlog, so this
is not a solved problem on either side.

---

### II.7 Mandatory decision comments with a length floor

**Adopt by: COC.** Effort: trivial. Impact: medium.

COC §12.13: "No mandatory decline or return reason. `validateRemark_` caps length but explicitly does
not require non-blank, so a request can be declined with no explanation."

DCS `validateComment(comment, minLength = 50)` enforces a floor, with `COMMENT_MIN_CHARS_STANDARD = 50`,
`COMMENT_MIN_CHARS_DECISION = 100` for Deny and Return, and `COMMENT_MAX_CHARS = 4000`.

A declined request with no reason is a guaranteed support ticket and an audit hole. This is a
one-line change in `validateRemark_` plus a client-side counter. Do it first, it is free.

**Nuance DCS learned:** DCS originally auto-inserted filler comments when approvers left the box empty,
then had to build `isLegacyDefaultComment_()` to filter that junk back out of every history render.
Do not auto-fill. Require, or leave blank.

---

### II.8 In-repo integration test harness

**Adopt by: COC.** Effort: medium. Impact: medium-high.

COC §12.8: "No test directory, no test framework, no fixtures, no CI." DCS is not much better on
*unit* tests, but it has something COC has nothing of: **editor-run integration tests that assert.**

`testUltimateSystem()` (`pia_code.js:10328`) simulates 20 concurrent users across every path, with:
- a `check(label, ok, detail)` assertion helper maintaining `{passed, failed, total, details}`,
- namespaced test IDs (`MEGA-<base36 ts>-<label>-<rand>`) so test rows are identifiable,
- a `cleanAll()` teardown that deletes every generated row across 6 sheets by ID prefix,
- `SpreadsheetApp.flush()` between write and verify so it reads committed state.

Plus `testFullSystemFlow()`, `testReminderEngine()`, `testPhase3DatabaseInitialization()`, and
`testAdminApi()` on the Admin side.

**Why this matters more than it sounds.** COC's profile says the system "has never been executed in
its current form" with two untested commits stacked. A harness like this converts a 21-item manual
runbook into one editor Run.

**Trade-offs.** These tests write to the **live** database and clean up afterward. That is genuinely
risky, and DCS accepts the risk. If COC copies this, use a separate test spreadsheet ID resolved
through `config_()` rather than pointing at production.

**Better than both:** extract the pure functions and unit-test them properly. COC already lists its
pure candidates (`validateRequestFields_`, `daysUntilContractEnd_`, `getApprovalView_`,
`chainDiffDetails_`). DCS's equivalents are `analyzeDCSRisk`, `validateComment`, `getNormalizedEmail`,
`isValidEmail`, `getUnifiedHistory`. See §IV.7.

---

### II.9 Idempotent schema bootstrap

**Adopt by: COC.** Effort: low. Impact: medium.

COC §12.15: "Sheet tabs are created manually and must match `SHEET_NAMES` exactly. Only `Admins_Log`
self-heals; the other seven do not."

DCS `initializeDatabase()` (`pia_code.js:3310`) does the whole schema:
- checked against a `PIA_DB_INIT_DONE` Script Property flag,
- takes a script lock and **re-checks the flag inside the lock** (correct double-checked locking),
- per tab: `if (!sheetExists(name))` → create → `appendRow(headers)` → `formatHeaderRow()`,
- `createPhase3SheetWithValidation()` additionally attaches Sheets **data validation** rules and seed
  rows, so a hand-edited status cell gets rejected at the spreadsheet layer.

`Phase 1/Code.js:3160 setupDataCollectionSheet()` does the same for Phase 1.

That data-validation detail is the good part. It is a second line of defense against exactly the
`Requests.status` typos that COC's frozen `STATUS` enum is trying to prevent in code.

---

### II.10 A real admin control tower

**Adopt by: COC (selectively).** Effort: high. Impact: medium-high.

COC's admin is Tier 2: read-all, group CRUD, chain CRUD. Deliberately no intervention. And it is
**currently unreachable** because of the `isAdmin_` DTO key regression (§12.1).

DCS's Admin app has, verified in `adminView.html` render functions:

| Capability | Function |
|---|---|
| Joined dashboard (DCS + PIA + approvals) with search, status filters, 5/10/25 pagination | `getAdminData`, `renderTable`, `renderPagination` |
| Analytics view | `renderAnalytics` |
| Email queue: list, health stats, retry one, retry all for session, cancel | `adminApi_getEmailQueue`, `getQueueSummary`, `retryQueuedEmail`, `retryAllForSession`, `cancelQueuedEmails` |
| Failover view (failed sends) | `renderFailoverStats`, `renderFailoverTable` |
| Per-session pipeline snapshot | `adminApi_getPipelineView`, `renderPipeline` |
| Re-notify a specific stage/approver | `adminApi_resendToStage` |
| Certificate: view routing status, **re-route**, **download as PDF** | `apiAdmin_GetRoutingStatus`, `RerouteApprovedRequest`, `DownloadCertificate` |
| Audit log viewer per request | `getAuditLogs`, `renderAuditLogs` |
| Export dashboard to a new Spreadsheet | `exportToSheet` |
| Settings: template links, InfoSec config, reminder on/off + hour, notification routing | `getConfigData`, `saveConfigData`, reminder config API |

**What COC should take, in priority order:** (1) the email queue ops view, if it adopts §II.1;
(2) per-request pipeline/audit viewer; (3) certificate re-download from the archive it already has;
(4) export.

**What COC should NOT take.** DCS's Admin is a *separate GAS project with duplicated code*. It has its
own `notifyApprover` / `notifyApplicant` / `apiPhase3_NotifyISMember` copies, its own `escapeHtml_`,
its own `sendEmailWithRetry_`, its own certificate builder (`buildCertificateHtml_`). That duplication
is a maintenance tax DCS pays every time an email template changes. COC's single-project admin page is
the better container; just fill it with more capability.

---

### II.11 The token-plus-identity double gate on email action links

**Adopt by: COC, if it ever adds one-click email actions.** Effort: low. Impact: high (preventative).

COC's deep-links are `?page=review&id=XXX` with no token; authority comes purely from the session. That
is safe *because* the link grants nothing on its own.

DCS's links carry an HMAC. The important design decision is that **the token is not a bearer
credential**. `handleEmailAction` (`pia_code.js:1475`) requires **both**:

```js
const isAuthorized = (normalizedActiveUser === normalizedTargetEmail)
                  && isTokenValid(sessionId, targetEmail, token, ts, action);
```

So forwarding the approval email transfers nothing. The token is bound to the **action** as well
(`sessionId + email + ts + action`), which blocks swapping `Approve` to `Deny` in the URL. TTL is 14
days. The backward-compat path for action-less legacy tokens is gated behind a hard cutoff date rather
than left open forever, which is an unusually disciplined piece of deprecation.

The access-denied page also refuses to disclose the expected recipient, preventing email enumeration,
and tells the user to delete the forwarded email.

If COC ever wants one-click approve from the email (a real UX win for approvers on mobile), this is
the pattern to copy exactly, including the `&&`.

---

### II.12 Smaller wins worth carrying

| # | DCS practice | COC gap | Effort |
|---|---|---|---|
| a | Narrower mail scope: `gmail.send` + `script.send_mail` instead of full `mail.google.com` | COC requests full Gmail access, which is far more than "send" | Trivial |
| b | Superseded files are **archived to a Drive subfolder**, not trashed, because trashed files die in ~30 days and break historical links | COC keeps prior files but has no archive concept | Low |
| c | Per-operation lock timeouts (`LOCK_TIMEOUTS = {DRAFT: 30s, SUBMISSION: 45s, SESSION: 60s, CLEANUP: 30s}`) instead of one global value | COC uses a flat 10s everywhere; a 10 MB upload path deserves more | Trivial |
| d | Per-execution memoization of Script Properties (`initializePropertyCache_`) and opened Spreadsheets (`getCachedSpreadsheet_`) | COC memoizes properties but not the Spreadsheet handle | Trivial |
| e | Automatic risk flagging on submit (`analyzeDCSRisk`: requestor == approver, same person in two approval roles, suspiciously short description, no accountable person, missing dept/access) | COC has no risk heuristics at all | Low |
| f | Render error boundary (`renderWithErrorBoundary(screenId, renderFn)`) so one bad render does not white-screen the app | COC's `navigateTo` awaits a renderer with no catch | Low |
| g | A 5-part user + maintenance manual (`docs/manual/`, 1,207 lines) with Part 0 as the declared source of truth, aimed at end users, admins, and developers separately | COC's `README.md` is 2 lines | Medium |

---

## Part III. What COC does better, and DCS should adopt

**Do not skip this section on the assumption that DCS is ahead because it is bigger.** COC is
structurally cleaner in ways that are currently costing DCS real bugs.

---

### III.1 Append-only event log instead of destructive resubmit

**Adopt by: DCS.** Effort: high. Impact: high. **This is COC's single best idea.**

**What DCS does now** (`pia_code.js:4155–4207`, inside `submitApplication`):

```js
writeRevisionHistorySnapshot_(sessionId, priorFlags);   // best-effort, try/catch, non-blocking
// ...
appSheet.getRange(row, PIA_1_DATA).setValue(pia1Data);  // OVERWRITES the answers in place
// ...
batchDeleteRows(apprSheet,    findRowsToDelete(...));   // DELETES all Stage A rows
batchDeleteRows(ismSheet,     findRowsToDelete(...));   // DELETES all ISM rows
batchDeleteRows(divHeadSheet, findRowsToDelete(...));   // DELETES all DivHead rows
initializeApprovalWorkflow(sessionId, appData);         // rebuild from scratch
```

Three separate losses, and the code comments acknowledge the fragility:

1. **The approval trail is deleted.** It survives only if `writeRevisionHistorySnapshot_` succeeded
   first. That call is wrapped in try/catch at both the call site and inside the function, explicitly
   because "a history-write failure must NEVER block a resubmit." Correct priority, wrong architecture:
   if it throws, **that round is permanently gone** and nothing detects it.
2. **The submitted answers are overwritten in place.** `PIA_1_Data` … `PIA_5_Data` are `setValue`'d
   over. There is **no snapshot of the answers at all**, only of the decisions. So after a resubmit
   you can see *that* the Immediate Head approved round 1, and *what they commented*, but you can no
   longer reconstruct **what they were looking at when they approved it.**
3. **Only non-Pending rows are snapshotted.** A round where nobody acted leaves no trace.

For a system whose entire purpose is Privacy Impact Assessment, item 2 is a compliance gap, not a
code-quality nit. "Prove what the Department Head actually approved in round 1" is currently
unanswerable.

**What COC does.** `Activity_Log` is append-only and is the source of truth. Nothing is ever deleted
or updated. A resubmit increments `resubmit_cycle`; rows from cycle N-1 simply stay, tagged to that
cycle. `Requests.status/current_step/resubmit_count` is an explicitly-labelled denormalized read-cache
maintained only by `setRequestCache_()`. History is *derived* by `getApprovalView_()` in one pass over
the timeline: `byStep`, `previousApprovals`, `priorApprovals`, `approvedCount`, `latestRemark`,
`resubmitHistory`, `currentCycle`. Attachments carry `RA.RESUBMIT_CYCLE` so the detail page groups them
into "Current submission" and "Previous versions."

**Why COC's is better.** No destructive write means no best-effort snapshot, no lost round, and no
possible divergence between "what happened" and "what we recorded." It is also *less* code: DCS needs
`Revision_History` + `writeRevisionHistorySnapshot_` + `getRevisionHistoryRows_` +
`collectCurrentRoundDecisions_` + `getUnifiedHistory` + `buildUnifiedHistoryHtml` precisely because it
destroys the primary record and then has to reconstruct a unified view by unioning the snapshot with
the live sheets. COC needs one function.

**Migration path for DCS (incremental, do not big-bang this).**

- **Step 1 (low risk, high value, do this now).** Stop overwriting the answers. Before the
  `setValue` block, write the prior `PIA_1..5_Data` into `Revision_History` as an extra `STAGE =
  'SUBMISSION'` row. That closes the compliance gap on its own, without touching the workflow model.
- **Step 2.** Stop deleting workflow rows. Add a `RoundNumber` column to the three workflow sheets and
  make `initializeApprovalWorkflow` append a new round rather than `batchDeleteRows` + rebuild. Every
  existing read path filters on `STATUS === 'Pending'` already, so add `AND RoundNumber = current`.
- **Step 3.** Once nothing deletes, `Revision_History` becomes a pure read-model and
  `writeRevisionHistorySnapshot_` can be deleted. `getUnifiedHistory` collapses to one scan.

Note DCS already has the hardest prerequisite: `RoundNumber` derivation exists
(`writeRevisionHistorySnapshot_` derives it as max-prior + 1 inside the submit lock).

---

### III.2 A single accessor seam over the database

**Adopt by: DCS.** Effort: high. Impact: high.

**Evidence this is already costing DCS money.** Commit `7590b7c`, shipped:

> `getPIARecordByDCSId_` was searching a hardcoded `'B:B'` range for the DCS ReqID, but that column
> holds the applicant's email, not `Linked_ReqID`, so the lookup silently failed.

That is a column-index bug that reached production, caused a duplicated-document defect visible on the
certificate, and took a round of user testing to find. **An accessor seam makes that bug impossible.**

**Current state of DCS.** Three projects, three copies of overlapping column maps (`DC_COL` in
`Phase 1/Code.js` vs `DCS_COLS` in `pia_code.js`, describing the *same* sheet), 132 raw full-sheet
reads in PIA alone, and range literals like `'B:B'` inline at call sites.

**COC's model.** `Accessors.js` is the only door to the normalized schema. Feature code never touches
`Activity_Log`, `Groups`, or `Group_Approvers` directly. Write primitives are similarly centralized:
`appendAction_()` and `setRequestCache_()` are the *only* writers of the timeline and the cache. The
seam also preserves a legacy DTO shape, which is why COC could normalize a 35-column monolith into 8
tables **without touching the UI**. That is a hard refactor executed cleanly, and DCS has nothing
comparable.

**Implementation for DCS, adapted to its three-project reality.** DCS cannot literally share a file
across GAS projects. But it can do the next best thing:

1. Create one `Schema.js` per project, containing **only** column maps and sheet names, generated from
   a single source of truth checked into this repo. Make drift detectable by adding a header-row
   assertion at init: read row 1, compare to the expected header array, log loudly on mismatch.
2. Create `Accessors.js` per project wrapping every read/write of a shared sheet:
   `getDcsRowByReqId_()`, `getPiaRowBySessionId_()`, `getWorkflowRows_(sheet, sessionId, round)`,
   `appendAuditRow_()`. No `getRange('B:B')` anywhere outside it.
3. Route the 132 PIA full-sheet reads through it, and use §II.5's TextFinder pattern inside.

That is a multi-week refactor. It is also the single change that would most reduce DCS's future bug
rate, and it can be done sheet-by-sheet with no behavior change.

---

### III.3 🔴 Closing the callable surface

**Adopt by: DCS. This is the highest-severity item in this review.** Effort: medium. Impact: critical.

**The rule, restated.** In Apps Script, *every* top-level function in a project is an HTTP endpoint
callable from any authenticated user's browser console via `google.script.run.fnName(args)`. Hiding a
button, gating a page, or simply never calling a function from the frontend provides **zero** security.
The only thing that removes a function from that surface is a **trailing underscore**.

**The numbers, measured.**

| | Total top-level fns | Hidden (trailing `_`) | **Publicly callable** | Actually used by that frontend |
|---|---|---|---|---|
| **COC** | 148 | 109 | **39** | 16 |
| **DCS `Phase 1/Code.js`** | 46 | 17 | **29** | 11 |
| **DCS `Phase 2/pia_code.js`** | 124 | 17 | **107** | 9 |
| **DCS `Admin/admin_code.js`** | 59 | 17 | **42** | 21 |
| **DCS total** | **229** | **51** | **178** | 41 |

COC hides **74%**. DCS hides **22%**.

**Verified unguarded public functions in `pia_code.js`** (no `Session.getActiveUser()` check, no
`isAuthorizedForApplication_`, no `checkAccess_` anywhere in the body). All 22 are callable by any
authenticated `@megaworld` account:

| Function | What a domain user can do with it | Severity |
|---|---|---|
| `getSystemSecret()` | **Returns the HMAC token-signing key verbatim as a string.** | 🔴 Critical |
| `getApplicationData(sessionId)` | Read any PIA record in full (all 5 sections, PII categories, approver emails) for any session. Session IDs are sequential (`nextBaseSessionId`), so trivially enumerable. | 🔴 Critical |
| `adminSetNotificationConfig(config)` | Redirect all admin failure alerts to an attacker-chosen address | 🔴 Critical |
| `adminCancelQueuedEmails(sid, type)` | Suppress approval emails for any request | 🟠 High |
| `adminResendToStage(sid, stage, email)` | Send-amplifier, arbitrary recipient re-notification | 🟠 High |
| `adminSetReminderConfig(config)` | Disable the reminder engine org-wide, or rewrite the trigger | 🟠 High |
| `adminResendEmail(sid, recipient, type)` | Send-amplifier (already flagged in `CLAUDE.md` as "still open") | 🟠 High |
| `getAndShareDCSFiles(dcsReqId)` | Flip any request's uploaded documents to `DOMAIN_WITH_LINK` | 🟠 High |
| `adminGetPipelineView`, `adminGetEmailQueue`, `adminGetEmailLog`, `adminGetFailedEmails`, `adminGetQueueSummary`, `adminGetReminderConfig`, `adminGetNotificationConfig`, `adminRetryQueuedEmail`, `adminRetryAllForSession` | Read/replay the whole email operations layer | 🟡 Medium |
| `getRevisionHistory(sid)`, `getUnifiedHistory(sid)` | Read any request's full approval history | 🟡 Medium |
| `checkAllApproved(sid)`, `initializeDatabase()` | State/schema pokes | 🟡 Medium |

Plus, still public though lower value: `generateAuthToken`, `queueEmail`, `sendEmailWithRetry`,
`processEmailQueue`, `sendDailyReminders`, `setupReminderTrigger`, `setupEmailQueueTrigger`,
`buildApproversFromAppData`, `initializeApprovalWorkflow`, `logAuditTrail`, `nextBaseSessionId`,
`reinitializePhase3Database`, and four `test*` functions.

**Two mitigating facts, stated honestly so the severity is not overstated:**

1. `generateAuthToken` being public is **not** an approval bypass on its own, because
   `handleEmailAction` requires `Session.getActiveUser() === targetEmail` **in addition to** a valid
   token (§II.11). A forged token still cannot make you someone else. The exposure of
   `getSystemSecret` is nonetheless critical on its own terms: it is a secret, it leaks, and it
   removes a whole layer of defense.
2. The three *decision* mutators (`processApprovalDecision`, `processDivHeadDecision`,
   `apiPhase3_ProcessISMDecision`) **are** correctly guarded by the F-02 convention. The approval
   ladder itself cannot be forged.

**What COC got right that DCS did not.**

COC's profile states the lesson explicitly: *"Guarding only the wrapper is insufficient when the
primitive underneath is itself callable."* COC learned it from its own `setRequestCache` /
`appendAction` hole.

**DCS has the identical hole, right now, and its own security doc records it as fixed.**
`docs/Security - Review Findings.md` marks **F-05 (`getApplicationData` IDOR) as ✅ Fixed**. What was
actually fixed:

```js
function apiGetApplicationData(sessionId) {      // ← guarded: owner ∪ approvers, throws on failure
  const appData = getApplicationData(sessionId);
  ...
}
function getApplicationData(sessionId) {          // ← STILL PUBLIC, STILL UNGUARDED
  // reads and returns the full row for any sessionId
}
```

`google.script.run.getApplicationData('PIA-000123')` still returns everything. **The finding is
recorded as closed and is not closed.** That is worth its own line in the roadmap.

**Remediation plan for DCS.**

1. **Immediate, ~1 hour:** rename `getSystemSecret` → `getSystemSecret_`. It has 1 caller
   (`generateAuthToken`). Same for `getApplicationData` → `getApplicationData_`, which has ~12
   internal callers, all server-side.
2. **This week, ~1 day per project:** rename every function not in the frontend's call list to carry a
   trailing underscore. The lists are short and verifiable: 11 for Phase 1, 9 for PIA, 21 for Admin
   (enumerated in §I / §II.10). Everything else gets an underscore.
3. **For what cannot take an underscore** (`doGet`, `doPost`, trigger handlers `processEmailQueue` /
   `sendDailyReminders` / `purgeExpiredDrafts`, editor-run `test*` and `forceAuthorize`): adopt COC's
   **`isOwnerContext_()`** verbatim. Under `executeAs: USER_DEPLOYING`, `getEffectiveUser()` is always
   the owner while `getActiveUser()` is the visitor; in a trigger or editor Run both resolve to the
   owner, so equality implies owner-or-trigger context, and a blank active user fails closed. DCS's
   `sendDailyReminders` and `processEmailQueue` are currently public **and** are send-amplifiers with
   quota impact. This is exactly the case COC cites as its motivation.
4. **Guard the primitives, not just the wrappers**, for the ~16 `admin*` functions in `pia_code.js`.
   Note that Admin's own `adminApi_*` wrappers *are* guarded (17 guards from F-01); the PIA-side
   copies they mirror are not.
5. **Write down the convention** in `CLAUDE.md` §8b, next to the existing F-02 note, in COC's exact
   three-option form: internal → underscore (default); frontend-called → bare name **and** guard;
   trigger/editor → `isOwnerContext_()`.
6. **Copy COC's call-graph checker.** COC used one to verify its sweep. COC's profile notes it lives
   in a scratchpad and was never committed, which is a mistake worth not repeating: commit it here.

**Trade-off.** Renaming is mechanical but touches every call site, and GAS gives no compile-time
check. Do it project by project, verify with a grep-based call-graph pass, and redeploy one app at a
time. And heed the warning COC's own regression provides (§12.1): its sweep renamed a *DTO property
key* along with the function and broke the admin console. Rename **functions only**, never object keys.

---

### III.4 Admin-owned approver registries instead of applicant-typed emails

**Adopt by: DCS.** Effort: high. Impact: high (integrity).

**The problem, plainly.** In DCS, the applicant types their own Immediate Head and Department Head
email addresses into the PIA1 form. `buildApproversFromAppData` (`pia_code.js:4454`) reads
`pia1.immediateHeadEmail` and `pia1.deptHeadEmail`, validates only the *format*, and seeds the ladder
from them. **Nothing verifies that those people are actually the applicant's heads.**

DCS's own `CLAUDE.md` concedes this: the integrity risk of naming yourself or a friend is "mitigated,
not prevented, by `analyzeApplicationRisk`," which flags `drafterEmail == headEmail` after the fact.
That check is trivially evaded by naming a colleague instead of yourself. And `analyzeDCSRisk` only
writes a flag to `Risk_Audit`; **it does not block anything.**

**COC's model.** `Groups` (surrogate PK `G001`) + `Group_Approvers` (composite key `group_id,
sequence`). The applicant picks a *group*; the chain is admin-configured. Admin CRUD is audited into
`Admins_Log` with a 9-value `ADMIN_ACTION` vocabulary that classifies the edit
(`approver_added` / `_removed` / `_replaced` / `chain_reordered` / `chain_changed`). Chain edits fire
`notifyChainChanges_()`, which is keyed on **current-approver change, not membership**, so a reorder
correctly notifies the person who now holds an in-flight request while a designation-only edit
correctly stays silent. There is an in-flight shrink guard that blocks shortening a chain below the
step a live request sits at, and names the blocking control numbers in the error.

That last set of details is genuinely thoughtful engineering and DCS has no equivalent.

**Why this is the better model.** It converts an integrity control from *detection* into *prevention*.
It also makes the ladder maintainable: today, if a Department Head leaves Megaworld, every in-flight
DCS request still points at their dead mailbox, and the only fix is direct spreadsheet editing.

**Trade-offs, and they are real.** COC's model works because COC has one request type. DCS's heads
genuinely vary per applicant, which is why the form-typed approach was chosen. A full org chart is
unmaintainable by hand.

**Recommended DCS path (does not require an org chart):**
- **Phase A, low effort:** validate the typed head emails against a `Directory` sheet of known
  employees, rejecting unknown addresses. Blocks typos and external addresses immediately.
- **Phase B:** add an `Approver_Registry` sheet mapping `department → {immediate_head, dept_head,
  div_head}`, admin-maintained. Prefill the PIA1 fields from the applicant's department and make them
  **read-only unless an admin-granted override reason is supplied**. Log the override.
- **Phase C, the real answer, already in `docs/Security - Recommendations.md` §2:** source the chain
  from the Google Workspace directory (`AdminDirectory.Users.get(email).relations` gives the manager)
  so it maintains itself.
- **Independent of all three:** adopt COC's `notifyChainChanges_` semantics and the in-flight shrink
  guard once any registry exists.

---

### III.5 The wrapper/primitive split applied to reads, and `null` as a deliberate contract

**Adopt by: DCS.** Effort: low. Impact: medium.

COC's `getRequestDetail()` returns `null` for **both** "not found" and "unauthorized," documented as a
frozen contract. Two benefits: the renderer has one empty-state path, and an unauthorized caller cannot
distinguish "does not exist" from "exists but not yours," which kills ID enumeration as a
reconnaissance tool. List getters return `[]` on authz failure so the UI degrades to an empty list
rather than an error dialog.

DCS partly converged on this independently: `apiGetRequestData` returns `{found:false}` for a
non-owner, which is the same idea. But `apiGetApplicationData` **throws** `"Access Denied: You are not
authorized to view this record."` and logs a `SECURITY ALERT`. That is inconsistent with the sibling
endpoint and it confirms record existence to the caller.

**Recommendation.** Pick one and freeze it. Given DCS already has `{found:false}`, standardize on
"indistinguishable empty result" for reads, keep the server-side `SECURITY ALERT` log (that part is
good and COC lacks it), and reserve thrown errors for genuine system failures.

---

### III.6 🔴 Uploaded documents must not be link-shared

**Adopt by: DCS. Fix immediately.** Effort: medium. Impact: critical.

`Phase 1/Code.js:1188–1206`, in `uploadProxy`:

```js
// ============ SET SHARING ============
try {
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
} catch (sharingErr) {
  try {
    file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (domainSharingErr) { /* continue */ }
}
```

Every uploaded NDA, DPA, DSA, Confidentiality Undertaking, and Endorsement Letter is set to
**public-with-link**, falling back to domain-with-link only if the org blocks external sharing. These
documents contain personal data, signatures, and contract terms. The function's own doc comment
describes the folder as "the admin-only Drive vault," which is not what the code produces.

And the links are surfaced. `Phase 1/index.html:6468`, `pia_code.js:719`, `:1763`, and
`pia_index.html:3558` all build `https://drive.google.com/file/d/<id>/view` into rendered HTML that
goes into the UI and into approval-review pages. Any forwarded screenshot, any copied URL, any browser
history sync leaks the document to anyone on the internet.

**COC's model, which is correct.** Files are created with `DriveApp.createFile()` and **no `setSharing`
call at all**, leaving them owner-only private. No Drive URL is ever sent to the frontend. The UI holds
only an `attachmentId` and fetches bytes through `downloadAttachment()`, which applies the same
authorization gate as `getRequestDetail`. Emails list attachment *filenames* with no links, since a raw
link would 404 for the recipient anyway.

COC also documents a related trap DCS should check for: its removed `addAttachment()` wrote a
**caller-supplied** Drive file ID into the attachments table, which `downloadAttachment()` then trusted,
letting an owner of a request read *any* file in the script owner's Drive. Classic confused deputy.
DCS's `FileID` column is written only by `submitDCS` from `uploadProxy`'s return value, so it does not
have this bug today, but any future "attach an existing file" feature would introduce it.

**Remediation for DCS.**
1. Delete the `setSharing` block from `uploadProxy`. New uploads become private.
2. Add `apiDownloadAttachment(reqId, fileId)`: verify the caller is the owner, a Stage-A approver, an
   ISM member, or a Division Head for that request (`isAuthorizedForApplication_` already computes
   exactly this set and can be reused); verify the requested `fileId` is actually listed in that
   request's `FileID` JSON, which is the anti-confused-deputy check; then return
   `{base64, mimeType, filename}`.
3. Replace the four `drive.google.com/file/d/...` render sites with a button calling that endpoint.
4. **Backfill:** one-time script over `ADMIN_FOLDER_ID` calling
   `setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE)` on every file. Note this will
   retroactively break links in already-sent emails, which is the correct outcome, but tell ISM first.
5. Reconcile with `getAndShareDCSFiles`, which deliberately flips files to `DOMAIN_WITH_LINK` so
   DCOPS/TechServe can open certificate attachments. That flow needs replacing too, most simply by
   attaching the actual file bytes to the routing email rather than sharing them.

**Trade-off.** Approvers currently click straight into Drive's native viewer. A proxied download is a
worse viewing experience for large PDFs. Accept it; the alternative is publishing NDAs.

---

### III.7 Skip-blank routing derived from the next pending status

**Adopt by: DCS.** Effort: medium. Impact: medium.

COC derives the next step from **the next pending status**, not from `step + 1`, so a gapped chain
(slot 2 soft-disabled) routes correctly instead of orphaning the request at an empty step. It then
correctly refuses to use `step` as an "N of M" counter, computing N from `getApprovalView_().approvedCount`
and M from the count of non-null approver slots.

DCS's ladder is hardcoded: exactly two heads at steps 1 and 2, exactly two ISM members. `checkAllApproved`
and `processApprovalDecision` branch on those step numbers. It works, but it means adding a third head
(or making Dept Head optional for low-risk requests) is a code change across the mutators, the workflow
seeder, the reminder engine, and the email templates.

**Recommendation.** When DCS next touches `initializeApprovalWorkflow`, make the "next step" a query
(`the lowest-numbered row with STATUS='Pending' for this session and round`) rather than arithmetic.
The reminder engine already does exactly this ("only the LOWEST pending step per sessionId is
eligible"), so the pattern exists in-repo; it just is not used by the routing path.

---

### III.8 Configuration resolution discipline

**Adopt by: DCS.** Effort: low. Impact: medium.

COC's rules and why each exists:

| COC rule | DCS status |
|---|---|
| `Script Property → source literal → named throw` | Partial. `getProp_` throws with the key name (good), but there is no source-literal fallback tier, so a missing property is always fatal. |
| **No service calls at file-load time** | ❌ **Violated.** `Admin/admin_code.js:490`: `var ADMIN_API_KEY = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY') \|\| '';` at module scope. This fires on **every execution**, and a failure there is an *uncatchable script-load error* that breaks the entire app. It also means the key is a snapshot that never refreshes after rotation. |
| Values are `.trim()`ed, because pasting a Drive ID into the Properties UI picks up whitespace | Not done. `getProp_` returns raw. |
| `configFlag_` fails **soft** toward the safer value | No boolean-flag helper exists. |
| Security controls live in **source**, not properties, so they are diffable and code-reviewed | Split. `ENABLED_DOMAIN_CHECK` is a source const (correct, matches COC's reasoning) but the `DOMAIN` *value* is a Script Property, silently editable with no audit trail. |

**Recommendation for DCS.** Move the `ADMIN_API_KEY` read inside a memoized `getAdminApiKey_()`.
Add `.trim()` to `getProp_`. Add a `configFlag_(key, default)`. Consider moving the allowed domain
string into source next to `ENABLED_DOMAIN_CHECK`, since they are one control split across two places.

---

### III.9 Frontend structure: one bridge, one stylesheet, real components

**Adopt by: DCS.** Effort: medium-high. Impact: medium.

| Concern | COC | DCS | Gap |
|---|---|---|---|
| Server calls | One `callServer(fnName, ...args)` promise bridge; pages never touch `google.script.run`; **all 16 call sites pass a string literal**, which makes the callable surface statically verifiable | 20+ raw `google.script.run` chains with hand-written `withSuccessHandler` / `withFailureHandler` at each site | DCS has no single place to add a timeout, a retry, a spinner, or telemetry, and no way to statically enumerate its own API |
| Design tokens | One `:root` block in one `Stylesheet.html` | **Three separate copies** of the navy palette in three HTML files (`index.html:240`, `pia_index.html:158`, `adminView.html:162`) | Guaranteed drift; a palette change is a 3-file edit across 3 deployments |
| Components | `components/` dir: `StatusBadge`, `EmptyState`, `MigaWidget`, `UI` (`renderIcon`, `renderStatCard`, `renderSearchBar`, `renderPagination` + `paginate`, `friendlyName`, `uiKeyActivate`) | Per-screen `render*()` functions; status-badge and legend logic re-derived per screen and per app | Badge colour/label/legend can and does disagree between apps |
| Icons | Inline Lucide SVG using `currentColor`, zero network requests | Emoji as UI icons (`📄 View Endorsement Letter` at `pia_index.html:3558`, `📬` `⛔` `🚨` throughout logs) | Violates this project's own frontend rule: "No emoji used as interface icons" |
| Accessibility | `:focus-visible` on nav and tabs, keyboard activation for `role="button"` rows, label/id association on all fields, amber token darkened to `#8a5510` for AA contrast, `.table-scroll` so wide tables scroll independently | 88 a11y attributes total across 6,897 lines; **3** `:focus-visible` uses; 1 `prefers-reduced-motion` block; no `.table-scroll` equivalent | DCS is behind on keyboard and contrast |
| Router | `navigateTo()` single entry, `replaceState` (deliberate, app supplies its own Back), `afterRender_<page>` hook | `show(name)` + `renderCurrentScreen()` + `renderWithErrorBoundary` | Roughly equivalent. **DCS's error boundary is better** and COC should take it (§II.12f) |

> ⚠️ **Three claims in the table above were checked against the code on 2026-08-12 and were
> wrong or stale. Corrected here rather than deleted, so the same mistakes are not re-made:**
>
> 1. **"Emoji as UI icons … throughout" — overstated.** The cited `📄 View Endorsement Letter` at
>    `pia_index.html:3558` no longer existed. Actual count across all three frontends was **7**,
>    all `⚠`/`✓`/`✗` semantic glyphs, now inline SVG via `icon()`. The ~127 emoji in `pia_code.js`
>    are inside `Logger.log` — developer-facing, useful as grep anchors, and left alone.
> 2. **"Three separate copies" of the palette — there were SIX.** Each backend also emits its own
>    `:root` in `getStyledHtmlWrapper_`, and those used a *different navy* (`#1a3a5c` vs the
>    canonical `#1e3a5f`). That is the page an approver lands on from an email link, so it was the
>    most visible drift and the one nobody had noticed.
> 3. **"One `:root` block" implies the three were otherwise identical — they were not.** Effective
>    `--radius` was 4px (DCS), 6px (PIA) and 10px (Admin), the last because Admin re-declared it
>    further down its own block, silently overriding the shared token above it.

**Recommendation for DCS, in order:**
1. Add a `callServer(fnName, ...args)` promise bridge and migrate call sites opportunistically. Cheap,
   immediately useful, and it is the prerequisite for uniform loading/error states.
2. ✅ **DONE 2026-08-12** — `docs/design-tokens.css` is now that canonical copy, pasted into **six**
   targets (three frontends + the `getStyledHtmlWrapper_` block in each backend), each marked
   `GENERATED from docs/design-tokens.css`. Runtime sharing is impossible not only across projects
   but even *within* Phase 1: its `doGet` uses `createHtmlOutputFromFile`, which does not process
   scriptlets at all, so an `include()` partial would emit as literal text.
   ~~Extract the `:root` token block into a single canonical copy in this repo and treat the three
   in-file copies as generated.~~
3. ✅ **DONE 2026-08-12** — `icon(name, size)` added to `index.html` and `adminView.html`, Lucide
   paths on `currentColor`, zero network requests, exactly as COC's `renderIcon` does it. Only 7
   glyphs needed replacing (see the correction note above). One constraint worth recording: the
   helper returns HTML, so it works only where the sink is `innerHTML`. Through `textContent` or
   `summaryRow()` (which HTML-escapes its value) it renders as literal markup — in those places the
   glyph was **dropped** rather than substituted, because a tick inside a sentence is punctuation,
   not an icon. Switching those sinks to `innerHTML` would have introduced an XSS surface, since the
   interpolated value is a user-supplied filename.
   ~~Replace emoji icons with inline SVG.~~
4. Do an accessibility pass mirroring COC's: `:focus-visible`, keyboard activation on clickable rows,
   label/id association, and a table-scroll wrapper.

---

### III.10 Smaller COC practices worth taking

| # | COC practice | Why | Effort |
|---|---|---|---|
| a | **Frozen DTO contracts labeled in the code** (status strings, the `[PENDING]` history format, the `getRequestDetail` null contract, the `getApprovers_` 6-field shape) | This is why COC's normalization did not cascade into the UI. DCS has equivalent frozen contracts (`Linked_ReqID`, `PIA_APP_URL`, sheet column order) documented in `CLAUDE.md` but **not marked at the code site**, where the person about to break them is actually looking | Trivial |
| b | **Admin is not a role, it is an additive boolean** | DCS's `checkAccess_` conflates "InfoSec member" with "admin," and derives admin-ness by scanning two config sheets with regex over header names (`/email/i`, `/active\|enabled/i`). That is clever and fragile. COC's explicit `Admins` allowlist, hand-managed so an admin cannot mint admins, is stricter and simpler | Low |
| c | **Two separate append-only logs**, request-scoped and config-scoped, deliberately not merged | DCS puts admin config changes and email events into `Risk_Audit` alongside workflow events, so any history reader has to filter. COC keeps `Admins_Log` separate precisely so it "must not pollute `getApprovalView_()`" | Low |
| d | **Opposite idempotency models, chosen per sweep and written down** (expiry sweep is flag-guarded and idempotent; the daily nudge is *meant* to repeat so the schedule itself is the guard, and it deliberately writes nothing to the log to avoid bloating it) | DCS's reminder writes a `Reminder Sent` audit row per nudge per request per cycle. At scale that is the log bloat COC explicitly avoided | Trivial |
| e | **The expiry flag map fails closed** (a scan failure aborts the sweep, because an empty map reads as "never notified" and would re-notify every contract in the system) | DCS's reminder pre-filter does the opposite: `catch (e) { Logger.log('Pre-filter read failed, will process all pending rows'); }`. A transient read failure on the `Applications` sheet causes a **reminder blast to every pending approver in the system**, including on completed, denied, and returned requests. This is a live latent bug, not a style note | Trivial, high value |

Item (e) is worth pulling out. `pia_code.js:5277`: the pre-filter's failure path is fail-open. Change
it to abort the sweep.

---

## Part IV. Recommendations for both systems

Neither codebase does these. Ordered by value.

### IV.1 A reconciler for derived state

**Both.** COC §12.7 names this as deferred: nothing detects or repairs divergence between
`Requests.status/step` and `Activity_Log`. DCS has the same class of problem in a different shape:
`Data_Collection.Status`, the PIA `Applications.Status`, and the three workflow sheets can disagree,
and the UI's "richer badges" are computed in the frontend from the workflow sheets rather than read
from a column, so a stale status column is invisible until someone notices.

**Recommendation.** A `reconcile()` function, editor-run or on a weekly trigger, that recomputes the
cached status from the authoritative rows and reports (does not auto-fix) every divergence. Report
first. Auto-repair only after you have seen a month of clean reports.

### IV.2 Delegation and out-of-office

✅ **DONE 2026-08-12.** Implemented for DCS/PIA as an **admin-managed** `Delegations` sheet + `ActedBy` on each workflow row. Approvers cannot appoint their own stand-in. Single-hop, no chaining. The hard part was not the table: the review token is HMAC-signed over the approver's email, so the delegate is resolved at **notify** time and the token minted over *their* address — see `recipientFor_` / `canActAs_` in `pia_code.js`.

**Both.** Neither system handles an approver being on leave. COC's only remedy is an admin editing the
chain, which changes it for every in-flight request in that group at once. DCS's is worse: the head
emails are baked into each request at submit time, so there is no chain to edit.

**Recommendation.** A `Delegations` sheet: `(from_email, to_email, start, end, reason)`. At notify
time, resolve the recipient through it. Record the delegation on the decision row so the audit trail
shows "approved by X on behalf of Y." This is a genuine business need in any enterprise approval
system and it is the most commonly requested post-launch feature.

### IV.3 Requestor-initiated cancel/withdraw

**Both.** Neither lets a requestor withdraw a request they no longer need. It sits pending forever,
reminders fire at approvers, and the metrics are polluted. Small feature, real cleanliness win.
Terminal status `Withdrawn`, owner-only, only from a pending state, notifies the current approver.

### IV.4 Error-code vocabulary and no raw exception text to the client

✅ **DONE 2026-08-12.** For DCS. All **89** sites (not the 58 estimated — see the F-06 note) now use `safeError_`, and the `code` vocabulary landed as `ERR.*`. Shipped as a **dual-key** envelope (`{ok, code, message}` + legacy `{success, error}`) for one release, because the three GAS projects deploy independently. COC unchanged.

**Both.** COC §12.11: mutations variously return `{success:false, error}` or `{success:false, message}`,
and there is no error-code vocabulary, so the UI cannot branch on failure *type* without string
matching. DCS has the same inconsistency plus a worse variant, recorded in its own security doc as
**F-06, deferred**: "58 `error: e.toString()/e.message` sites across 3 files." Raw GAS exceptions echo
resource IDs, so a Drive error can leak a folder ID and a Sheets error can leak the spreadsheet ID.

**Recommendation for both.** One shared shape: `{ok: boolean, code: 'UNAUTHORIZED'|'BUSY'|'NOT_FOUND'|
'ALREADY_ACTIONED'|'VALIDATION'|'INTERNAL', message: string, details?: object}`. A `safeError_(e,
code)` helper that logs the real exception server-side and returns a generic message. COC's
`generateCOC_` already does exactly this ("error messages are deliberately generic to the caller while
the real exception is logged server-side, because Drive exceptions echo the offending resource ID").
Generalize that one function's discipline to every handler in both systems.

### IV.5 SLA/aging metrics and bottleneck reporting

✅ **DONE 2026-08-12.** For DCS, in Admin → Analytics: days-waiting buckets plus a most-stuck list. Confirmed the raw material was already there — `NotifiedDate` on all three workflow sheets, **zero new columns**. Round-scoped, since this asks "who acts next". COC unchanged.

**Both.** DCS has an analytics tab; COC has stat cards. Neither answers the question management will
ask within a month of go-live: *where do requests get stuck, and for how long?*

**Recommendation.** Both already have the raw material (DCS: `NotifiedDate` + `DecisionDate` per
workflow row; COC: the `Activity_Log` timestamps). Compute per-stage dwell time, median and p90
time-to-decision, and an "aging" list of requests pending more than N days by approver. Surface as a
dashboard card. In COC this is a pure `getApprovalView_()` extension. In DCS it belongs in Admin's
`renderAnalytics`.

### IV.6 Structured monitoring and a health check

**Both.** Both systems' failure mode is silence. Recommend a daily digest to ISM/admin: emails sent
and failed in the last 24h, queue depth, requests pending over 7 days, trigger liveness (last run
timestamps, which DCS already stamps as `PIA_LAST_REMINDER_RUN`), and remaining Gmail quota. Ten lines
of code, and it converts "we found out three days later" into "we found out at 8am."

DCS is closer: it already checks whether the queue trigger exists and already records the last reminder
run. It just does not report either to a human.

### IV.7 Testing strategy

**Both.** Recommendation, in escalating order of effort:

1. **Extract pure functions and unit-test them locally with Node.** Both codebases have real
   candidates. COC: `validateRequestFields_`, `validateAttachmentPayload_`, `daysUntilContractEnd_`,
   `isContractExpired_`, `getApprovalView_`, `chainDiffDetails_`, `sortRequests`. DCS: `analyzeDCSRisk`,
   `validateComment`, `validateApplicationData`, `getNormalizedEmail`, `isValidEmail`,
   `sanitizeInput`, `getUnifiedHistory`, `formatSessionId`. These have no Sheets dependency and can run
   under `node --test` today with zero infrastructure.
2. **Adopt DCS's integration harness** (§II.8), pointed at a dedicated test spreadsheet.
3. **Commit the call-graph checker** both projects need to verify the underscore convention, and run
   it as the pre-deploy gate. COC built one and lost it in a scratchpad. Do not repeat that here.

### IV.8 Config-driven workflow definition

**Both.** Both hardcode the ladder: COC caps at 3 (`PENDING_1|2|3`, `isChainApprover_` checks slots
1-3, `approve_` branches on 1/2/3), DCS hardcodes 2 heads + 2 ISM + conditional DivHead. Both are
correct for their current business rule and both will hurt on the first request for a fourth approver
or a conditional stage.

**Recommendation.** Do **not** build a general workflow engine. Do make the two specific things that
change configurable: the **number** of steps (query for next pending, per §III.7) and the **condition**
for a stage. Note for COC specifically: lifting its cap requires changing the `STATUS` enum, which is a
frozen DTO compared in filters, email subjects, and frontend badge maps. Decouple those first, by
storing `status` and `step` separately rather than encoding the step into the status string.

### IV.9 Retention, purge, and PII hygiene

✅ **DONE 2026-08-12.** For DCS — **built but shipped inert.** The blocker noted below ("needs a policy decision from ISM") is real, so the engine is complete and switched OFF: it reports what would go and deletes nothing until ISM sets `RETENTION_MONTHS` and turns off dry-run. Lives in Admin because Phase 1 has neither `script.scriptapp` nor a purge path. Also took over the DCS draft purge, which had been written for a trigger that was never installed. COC unchanged.

**Both.** Both store real personal data in Google Sheets indefinitely. DCS additionally logs email
addresses into `Risk_Audit` on every action, and its own recommendations doc flags "PII sa logs" as
open. Neither has a documented retention period or a purge job (DCS purges *drafts* at 7 days, nothing
else).

**Recommendation.** Define a retention period with ISM. Add an archival job that moves rows older than
the period to a cold spreadsheet and redacts the PII columns in the live one. For a system whose Phase
2 is literally a Privacy Impact Assessment, not having a retention policy is an awkward look.

### IV.10 Sheets formula injection

✅ **DONE 2026-08-12.** For DCS. `sanitizeCellValue_` apostrophe-guards both `appendRow` boundaries in `exportToSheet`, plus a plain-text number format. Worse than described: `formatExportCell` **explodes JSON blobs into `key: value` lines**, so PIA answers normally inert behind a leading `{` were being unpacked. Deliberately not applied to live-DB writes (those cells are `JSON.parse`d). COC unchanged.

**Both.** Neither defends against a value beginning with `=`, `+`, `-`, or `@` being written into a
cell. COC notes the exposure is low because data is read back through the API rather than evaluated in
a spreadsheet UI. **That reasoning does not hold for DCS**, because DCS's Admin has
`exportToSheet(rows)` which dumps the dashboard into a **new Spreadsheet that a human then opens**.
A malicious `=IMPORTXML(...)` in a request description would execute in the admin's browser session
with the admin's Sheets identity.

**Recommendation.** Prefix a `'` to any string value starting with `= + - @` at write time, or at
minimum inside `exportToSheet`. Five lines. Do it in DCS first, it is genuinely exploitable there.

### IV.11 Rate limiting on submit

**Both.** Nothing prevents a user from submitting 500 requests in a loop via `google.script.run`, each
triggering emails and Drive writes. A per-user daily cap checked at submit (DCS already tracks
`MAX_USER_DRAFTS = 5`, so the pattern exists) is cheap insurance.

---

## Part V. Prioritized roadmap

Effort is calibrated to this project: **Low** ≈ under a day, **Medium** ≈ 1-5 days, **High** ≈ 1-4 weeks.
"Adopt" indicates which repo the item is for.

---

### 🟢 High impact, low effort — do these first

| # | Item | Adopt | Why it matters | Trade-off | § |
|---|---|---|---|---|---|
| 1 | **Rename `getSystemSecret` → `getSystemSecret_`** | DCS | A public function returns the HMAC signing key to any domain user. One caller. | None | III.3 |
| 2 | **Rename `getApplicationData` → `getApplicationData_`** | DCS | Full PII record read for any sequential session ID. The security doc records this as fixed; only the wrapper was fixed. | ~12 internal call sites to update | III.3 |
| 3 | **Delete the `setSharing(ANYONE_WITH_LINK)` block in `uploadProxy`** | DCS | Stops *new* NDAs/DPAs/DSAs from being published to the internet. Do this now; the backfill and the download proxy can follow. | New uploads become unviewable until the proxy lands, so pair with item 12 or ship in the same release | III.6 |
| 4 | **Fix the `isAdmin_` DTO key regression** | COC | The entire Tier-2 admin console is inaccessible to every user. One line. | None. Rename the *property key* back to `isAdmin`, keep the *function* `isAdmin_` | COC §12.1 |
| 5 | **Require a non-blank decline/return reason with a length floor** | COC | A declined request with no explanation is a guaranteed support ticket and an audit hole. DCS: 50 chars standard, 100 for Deny/Return. | Slight friction for approvers. Do **not** auto-fill a default; DCS had to build a filter to strip its own filler comments back out | II.7 |
| 6 | **Make the reminder pre-filter fail closed** | DCS | `pia_code.js:5277` currently catches a read failure and proceeds to "process all pending rows," which blasts reminders at every approver in the system including on completed/denied requests. | None | III.10e |
| 7 | **Move `ADMIN_API_KEY` out of module scope into a memoized getter** | DCS | A `PropertiesService` call at file-load fires on every execution and a failure there is an uncatchable script-load error that kills the whole app. Also makes key rotation take effect. | None | III.8 |
| 8 | **Add `.trim()` to `getProp_` / config reads** | DCS | Pasting a Drive ID into the Properties UI routinely picks up whitespace; `getFolderById(" 1abc ")` fails opaquely. COC learned this the hard way. | None | III.8 |
| 9 | **[DONE 2026-08-12 (DCS). Worse than described: formatExportCell explodes JSON blobs into "key: value" lines, so PIA answers normally inert behind a leading { were being unpacked into injectable cells.]** **Escape leading `= + - @` before writing cells, especially in `exportToSheet`** | DCS (then COC) | DCS exports the dashboard into a Spreadsheet a human opens, so formula injection is genuinely exploitable, unlike in COC. | None | IV.10 |
| 10 | **Adopt DCS's render error boundary** | COC | One bad renderer currently white-screens the app. | None | II.12f |
| 11 | **Narrow COC's mail scope to `gmail.send`** | COC | `mail.google.com` grants full mailbox read/delete for a system that only sends. | Forces re-auth on next deploy | II.12a |
| 12 | **Copy `isOwnerContext_()` into DCS and guard the trigger handlers** | DCS | `processEmailQueue`, `sendDailyReminders`, `purgeExpiredDrafts`, `setupReminderTrigger` and the `test*` functions are public send-amplifiers. Any user can loop them and burn the daily Gmail quota, which then silently disables all workflow mail. | None | III.3 |
| 13 | **Mark frozen contracts at the code site** | Both | Both repos document frozen contracts in markdown, where the person about to break them is not looking. | None | III.10a |

---

### 🟡 High impact, medium effort

| # | Item | Adopt | Why it matters | Trade-off | § |
|---|---|---|---|---|---|
| 14 | **Full trailing-underscore sweep + call-graph checker committed to the repo** | DCS | 178 of 229 functions are public; 22 in PIA are unguarded, including config mutators, email cancellers, and send amplifiers. This is the highest-severity item in the review; items 1, 2, 12 are just the urgent subset. | Mechanical but touches every call site with no compile-time check. Do it one project at a time. **Rename functions only, never DTO keys** (COC's sweep broke its admin console exactly this way) | III.3 |
| 15 | **Identity-gated `apiDownloadAttachment` + backfill files to private** | DCS | Completes item 3. Reuse `isAuthorizedForApplication_` for the authz set, and verify the requested file ID is actually listed on that request (anti-confused-deputy). | Worse viewing UX than Drive's native viewer. Backfill retroactively breaks links in already-sent emails, which is correct but needs an ISM heads-up | III.6 |
| 16 | **Durable email queue with retry + failure escalation** | COC | Removes the silent-total-failure mode. Small diff because COC already funnels all 15 senders through one door. | Adds a mandatory trigger; if unregistered, mail stops entirely. Copy DCS's trigger-liveness check | II.1 |
| 17 | **Snapshot PIA answers before overwriting them on resubmit** | DCS | Step 1 of III.1, and it closes the compliance gap on its own. Today you can see *that* a head approved round 1 but not *what they were looking at*. | One extra `Revision_History` row per resubmit | III.1 |
| 18 | **Server-side draft autosave** | COC | 14 fields + 10 uploads lost on a tab close. | New sheet + purge trigger. Do not store files; show a re-attach notice like DCS does | II.3 |
| 19 | **Reminder cadence + continuation token + active-status pre-filter** | COC | Daily-from-day-1 trains approvers to filter you. The continuation token is what prevents silent truncation at the 6-minute ceiling as data grows. | None significant | II.4 |
| 20 | **Per-approver digest bucketing for reminders** | DCS | An approver holding 5 requests currently gets 5 emails. | None | II.4 |
| 21 | **Replace full-sheet reads with `createTextFinder` in PIA and Admin** | DCS (then COC) | 132 full-sheet reads in `pia_code.js`, 15 in `admin_code.js`, and the correct pattern already exists in `Phase 1/Code.js` (24 uses). Directly fixes COC §12.4 too. | Must copy the *whole* pattern (`findAll()` + take-last + re-read inside the lock), not just the API call | II.5 |
| 22 | **Magic-byte upload validation** | COC | COC currently accepts any file type and trusts the client-supplied MIME for the blob. 15 lines. | Rejects some legitimately weird files. Does not address macros, which is open on both sides | II.6 |
| 23 | **Unified error shape + `safeError_` helper** | Both | DCS leaks raw GAS exceptions at 58 sites (its own F-06, deferred); those echo Drive/Sheets resource IDs. Neither UI can branch on failure type. | Touches every handler; do it as one mechanical pass | IV.4 |
| 24 | **[PARTIAL 2026-08-12 (DCS). Design tokens unified (six copies, not three) and emoji icons replaced. The callServer() bridge and the a11y pass are still open.]** **`callServer()` bridge + single design-token source + SVG icons + a11y pass** | DCS | Three drifting copies of the palette, 20+ hand-rolled RPC handlers, emoji as UI icons (against this project's own frontend rules), 3 `:focus-visible` uses in 6,897 lines. | Incremental; migrate call sites opportunistically | III.9 |
| 25 | **Approver-chain phase A+B: directory validation, then a department→heads registry with logged overrides** | DCS | Converts the integrity control from detection to prevention. Today an applicant types their own approvers and the only defense is an after-the-fact flag that does not block anything. | Prefilled read-only fields will generate "my head isn't listed" tickets; the override path must exist from day one | III.4 |
| 26 | **Extract pure functions and unit-test them under Node** | Both | Both have real candidates that need zero infrastructure. Converts a manual runbook into `node --test`. | Genuinely does not test the Sheets/Gmail/Session layer, which is where most bugs live | IV.7 |
| 27 | **Weekly reconciler report (report only, no auto-fix)** | Both | Nothing currently detects divergence between cached status and the authoritative rows. | Report first for a month before considering auto-repair | IV.1 |
| 28 | **Daily health digest to ISM** | Both | Both systems' failure mode is silence. DCS already computes most of the inputs and reports none of them. | ~10 lines | IV.6 |
| 29 | **[DONE 2026-08-12 (DCS). Admin -> Analytics. Confirmed the raw material already existed: NotifiedDate on all three workflow sheets, zero new columns.]** **SLA/aging metrics** | Both | Management will ask "where do requests get stuck" within a month of go-live, and neither system can answer. | None; the raw data already exists in both | IV.5 |

---

### 🔴 High impact, high effort — plan, do not rush

| # | Item | Adopt | Why it matters | Trade-off | § |
|---|---|---|---|---|---|
| 30 | **Append-only workflow: stop deleting rows on resubmit** | DCS | Today a resubmit deletes all three workflow sheets' rows for the session, and the trail survives only via an explicitly non-blocking snapshot. If it throws, the round is gone and nothing notices. Steps: add `RoundNumber` → append rounds instead of delete+rebuild → retire the snapshot. | Touches the submit path, every workflow reader, the reminder engine, and the certificate builder. Do it in the three ordered steps in §III.1, each independently shippable | III.1 |
| 31 | **Accessor seam per project + generated column maps + header assertions** | DCS | The `getPIARecordByDCSId_` `'B:B'` bug (`7590b7c`) is exactly what this prevents, and it reached production. Also the prerequisite for item 21 landing cleanly. | Multi-week. Can be done sheet-by-sheet with no behavior change. GAS cannot share files across projects, so this is three parallel seams over one generated schema | III.2 |
| 32 | **[DONE 2026-08-12 (DCS). Admin-managed only, single-hop. The real cost was not the table but the HMAC token, which is signed over the approver email, so the delegate is resolved at notify time.]** **Delegation / out-of-office** | Both | The most commonly requested post-launch feature in any approval system, and neither can do it. DCS is worse off because heads are baked into each request at submit. | Adds a resolution step to every notify path and a new concept to the audit trail | IV.2 |
| 33 | **Config-driven step count and stage conditions** | Both | COC is hard-capped at 3 while its schema and its own comments claim "unlimited"; a hand-added `sequence = 4` row silently locks the request out permanently with no error. DCS hardcodes 2+2. | For COC, lifting the cap means changing the `STATUS` enum, which is a frozen DTO in filters, subjects, and badge maps. **Decouple `status` from `step` first** | IV.8 · III.7 |
| 34 | **Workspace-directory-sourced approver chains** | DCS | Phase C of item 25, and the real answer: the chain maintains itself and cannot be gamed. Already in `docs/Security - Recommendations.md` §2. | New OAuth scope (`admin.directory.user.readonly`), forced re-auth, and a dependency on directory hygiene that may not exist | III.4 |
| 35 | **[BUILT BUT INERT 2026-08-12 (DCS). The "needs a policy decision from ISM" blocker is real, so the sweep ships disabled and dry-run: it reports, it does not delete. PII-in-logs redaction is still open.]** **Retention policy + archival/purge + PII redaction in logs** | Both | Both store real personal data in Sheets forever. For a system whose Phase 2 is a Privacy Impact Assessment, this is an awkward gap. | Needs a policy decision from ISM before any code | IV.9 |
| 36 | **Consolidate DCS's three projects, or extract a shared library** | DCS | Admin duplicates PIA's `notifyApprover` / `notifyApplicant` / `apiPhase3_NotifyISMember`, its own `escapeHtml`, its own retry wrapper, and its own certificate builder. Every email-template change is a 2-project edit. `CLAUDE.md` correctly warns not to "sync the names," which is a symptom, not a solution. | Very high risk. A GAS **Library** is the low-risk middle path (shared code, versioned, no deployment-URL change), at the cost of a per-call performance hit and a version-pinning discipline. **Do not attempt before item 31** | I.1 · II.10 |

---

## Part VI. Two lessons each system should send the other in writing

**DCS → COC:** *Delivery is not a side effect, it is a feature.* COC's `sendBrandedEmail_` failing soft
is the right call for atomicity and the wrong call for operations, and the gap between those two is
exactly the email queue. A workflow system whose entire value proposition is "replace email approvals"
cannot treat email as fire-and-forget.

**COC → DCS:** *The function that gets missed is the one that does not look like an auth decision.*
COC wrote that lesson down after its own sweep missed a formatter/mailer that could email a forged
certificate. DCS's version of that lesson is sitting in this repo right now, in three forms: a
`getSystemSecret` that looks like a config getter, a `getApplicationData` that looks like a data
accessor, and an `F-05 ✅ Fixed` row in the security doc that fixed the wrapper and left the primitive
wide open. **A finding is not closed until the primitive is closed.**
