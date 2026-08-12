# 🔍 RARS — Security Review Findings (B1/B3/B4 verification)

> **Scope:** Read-only authorization/IDOR/error-handling review across all 3 apps (DCS, PIA, Admin).
> **Mode:** **Find-only** — no code changed. This documents *what is in the code today*.
> **Purpose:** (c) both real hardening backlog **and** CAP documentation evidence.
> **Method:** 3 parallel read-only enumerators (one per app) mapped every server-callable function;
> the **Critical/High findings below were then personally verified** by reading the actual function bodies.
>
> Scoring per the team checklist: `PASS` / `FAIL` / `NEEDS-EVIDENCE`. Severity per `Reference.md#04-severity-risk-scoring`.

Reviewed: 2026-06-23.

---

## 0. The root cause you must understand first — the GAS threat model

**In Google Apps Script web apps, EVERY global `function` in a project is directly invocable by the
client via `google.script.run.functionName(args)` — from any HtmlService page that project serves.**

Consequences (this is why most findings below exist):
- The `doGet` / `doPost` gates only protect *page loads* and the *form-POST path*. They do **NOT**
  protect a direct `google.script.run` call to a global function.
- A function that "is only called internally" or "is gated by the token in `doPost`" is **still
  directly callable** with attacker-chosen arguments. The gate is on the *entry point*, not the *function*.
- **DCS / PIA:** any **authenticated domain user** (passed the `doGet` domain gate) can open the browser
  console and call any global function — e.g. `google.script.run.apiGetRequestData('DCS-000028')`.
- **Admin:** even a **non-INFOSEC** domain user who hits the Admin `/exec` gets the "Access Denied"
  HtmlService page — which **still carries the `google.script.run` bridge** — so they can call
  `google.script.run.deleteEntry(...)` directly. The INFOSEC member gate lives only in `doGet`.

**Threat model:** these are **insider** vulnerabilities — the attacker must be an authenticated
`@megaworldcorp.com` user (not anonymous internet). That bounds the risk, but the entire point of
authorization is that *not every employee* may read others' PII, forge approvals, or delete records.
IDs are sequential (`DCS-000028`, `PIA-000010`) and trivially enumerable.

**The fix direction (for the later hardening pass — NOT done now):** every sensitive function must
**re-derive identity server-side** (`Session.getActiveUser().getEmail()`) and enforce authorization
*inside the function* — never trust an `email`/`role`/`id` passed as a parameter. This is "never trust
the client" + "complete mediation" from `Foundations.md`. The legitimate UI paths already work; the gap
is the unguarded direct-call surface.

---

## 0b. Remediation status (updated 2026-06-23 — code applied locally, pending deploy)

| ID | Severity | Status | Fix |
|---|---|---|---|
| F-01 | 🔴 Critical | ✅ Fixed | Admin: `checkAccess_` on `deleteEntry`/`batchDeleteEntries`/`saveConfigData`/`getConfigData` + all frontend-reachable `adminApi_*`/`apiAdmin_*` (17 guards total) |
| F-02 | 🔴 Critical | ✅ Fixed | PIA: identity guard (`activeUser == approverEmail`) on `apiPhase3_ProcessISMDecision`/`processApprovalDecision`/`processDivHeadDecision` |
| F-03 | 🔴 Critical | ✅ Fixed | Covered by the `saveConfigData` + `adminApi_setNotificationConfig` guards |
| F-04 | 🟠 High | ✅ Fixed | DCS: owner guard on `apiGetRequestData` (returns `{found:false}` for non-owner) |
| F-05 | 🟠 High | ⚠️ **Was only half-fixed → ✅ Closed 2026-08-11** | The 2026-06-23 fix guarded `apiPhase3_FetchPIAData`/`FetchDCSData` and `apiGetApplicationData` — the **wrappers**. `getApplicationData` itself stayed a public global, so `google.script.run.getApplicationData('PIA-000123')` still returned the full record for any guessable session id. **The primitive is now `getApplicationData_`.** See §F-05 note below. |
| F-07 | 🟡 Medium | ✅ Verified PASS | `submitApplication_` already re-checks ownership in-lock + server-computes status; no change needed |
| F-08 | 🟢 Low | ✅ Fixed | DCS: `getGatewayRecord_` bound to `Session.getActiveUser()` (override ignored) |
| F-06 | 🟡 Medium | ✅ Fixed 2026-08-12 | Error-message sweep done. The real count was **89**, not 58 — the original estimate missed the multi-line object literals and the non-`success` envelopes (`{found:false, …, error: err.message}`) in `Phase 1/Code.js`. All now route through `safeError_(e, ERR.INTERNAL)`, one identical copy per project. See the F-06 section below. |
| — | 🟡 Medium | ✅ Closed 2026-08-12 | **Sheets formula injection in `exportToSheet`** — never had an F-number; it came from the cross-repo review (§IV.10). Applicant free text was written into a NEW spreadsheet an admin then OPENS, so a leading `=` executed as a formula under the admin's identity. Now apostrophe-guarded at both `appendRow` boundaries via `sanitizeCellValue_`, plus a plain-text number format. Deliberately **not** applied to live-DB writes — those cells are `JSON.parse`d. |
| — | 🟡 Medium | ✅ Closed 2026-08-11 | `adminApi_resendToStage` / `adminApi_resendEmail` / `getFailedEmails` / `getEmailLog` — resolved by **privatization** rather than by a guard, which sidesteps the original concern entirely: they are dispatched only from `handleAdminApi_`'s `switch`, so a trailing underscore breaks no caller and no `checkAccess_` is needed on a possibly-no-active-user external path. |

### 🔴 F-09 (new, 2026-08-11) — project-wide callable-surface exposure

Measured before the sweep: **178 of 229** top-level functions were reachable from any authenticated
domain account via `google.script.run`. The highest-impact ones, all now closed:

| Function | Project | Exposure | Fix |
|---|---|---|---|
| `getSystemSecret` | PIA | Returned the **HMAC token-signing key** verbatim as a string | → `getSystemSecret_` |
| `getApplicationData` | PIA | Full PII record for any sequential (guessable) session id — the F-05 primitive | → `getApplicationData_` |
| `getAdminData` | Admin | **Every request in the system with all PII**, to any domain caller. Missed by F-01, which only covered the `adminApi_*`/`apiAdmin_*` families | + `checkAccess_` |
| `getAuditLogs`, `exportToSheet`, `debugSheets`, `ping`, `getAdminDataDebug`, `adminGetEmailLog`, `adminGetFailedEmails` | Admin | Frontend-callable, no authorization check at all | + `checkAccess_` |
| 16 × `admin*` (`adminSetNotificationConfig`, `adminCancelQueuedEmails`, `adminResendToStage`, …) | PIA | Config mutation, email suppression, send amplification | → all private |
| `apiPhase3_InitializeISMWorkflow`, `apiPhase3_RetryISMWorkflow` | PIA | **Unauthenticated ISM workflow mutators** (one has zero callers at all) | → private |
| `notifyApprover`, `notifyApplicant`, `apiPhase3_NotifyISMember` | Admin | Send-amplifiers; previously documented as "deliberately not renamed" on reasoning that did not hold | → all private |
| `processEmailQueue`, `sendDailyReminders`, `purgeExpiredDrafts`, `forceAuthorize`, `test*`, … | all 3 | Trigger/editor entry points; cannot take an underscore (triggers bind by **name string**) | + `isOwnerContext_()` |

**After: 82 public across all three projects, none of them unguarded.** Verify with
`node docs/tools/surface.js` (committed — the sibling COC repo lost its equivalent checker to a
scratchpad directory).

**Generalizable lesson, and the reason F-05 sat half-open for six weeks: guard the primitive, not the
wrapper.** A wrapper guard reads as a fix and passes review, but in Apps Script the function
underneath is its own endpoint. A finding is not closed until the primitive is closed.

### 🟠 F-10 (new, 2026-08-11) — uploaded documents were world-readable

`uploadProxy` ended with `file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, VIEW)`, so every NDA,
DPA, DSA, Confidentiality Undertaking and Endorsement Letter was readable by **anyone on the internet
with the URL** — and the raw `drive.google.com/file/d/<id>/view` URL was rendered into the DCS
request-details screen, the PIA summary and the approver review form.

Closed by: removing the `setSharing` call (files are owner-only by default), and serving reads
through the new identity-gated `apiDownloadDcsFile` with an anti-confused-deputy check that the
requested `fileId` belongs to the request. `getAndShareDCSFiles_` / `getDCSSupersededFiles_` retain a
narrower `DOMAIN_WITH_LINK` elevation as the single documented exception, because the Certificate of
Approval email and PDF cannot call `google.script.run`. Historic files need
`backfillPrivateDcsFiles(false)` (owner-gated, dry-run by default, **not git-revertible**).

All applied changes are backend-only and **pending deploy** (PIA + Admin + DCS, each Edit → New version).

---

## 1. Findings summary (roll-up)

| Severity | Count | IDs |
|---|---|---|
| 🔴 **Critical** | 3 | F-01 (Admin destructive ops), F-02 (PIA approval forgery), F-03 (Admin config tamper) |
| 🟠 **High** | 2 | F-04 (DCS IDOR read), F-05 (PIA IDOR read) |
| 🟡 **Medium** | 2 | F-06 (error leakage), F-07 (mass-assignment of PIA cells) |
| 🟢 **Low** | 1 | F-08 (cross-app gate `getGatewayRecord` identity override) |

> Verified-by-reading: F-01, F-02, F-03, F-04, F-05. F-06/F-07/F-08 from enumeration (same pattern, high confidence — confirm each before fixing).

---

## 2. Critical findings

### 🔴 F-01 — Admin destructive functions have NO server-side authorization
**Checklist:** Z-2 Missing Authorization (CWE-862), function-level authz · **Score: FAIL**

`deleteEntry`, `batchDeleteEntries`, `saveConfigData`, `getConfigData` are global functions called from
the Admin frontend via `google.script.run`, but contain **no `checkAccess_` / `isAuthorizedDomain`
check inside the function body**. Verified:
- `deleteEntry(reqId, logId, sessionId, …)` — [admin_code.js:1760](Admin/admin_code.js:1760): straight to `getSpreadsheet_()` → deletes rows across Data_Collection, Applications, and all 3 workflow sheets. No guard.
- `saveConfigData(sysUpdates, infoUpdates)` — [admin_code.js:2131](Admin/admin_code.js:2131): writes `System_Configuration` + `InfoSec_Email_Config` (incl. adding members / link URLs). No guard.

**Impact:** Any domain user (even non-INFOSEC, via the Access-Denied page's `google.script.run` bridge)
can **delete any request** or **tamper config** (hijack `LINK_*` URLs, add a rogue INFOSEC member,
change the admin-notify email). Destructive + integrity loss.

**Also in this class (enumerated, same pattern — confirm):** `adminApi_resendToStage`,
`apiAdmin_RerouteApprovedRequest`, `adminApi_retryQueuedEmail`, `adminApi_cancelQueuedEmails`,
`adminApi_setNotificationConfig` are gated by **`ADMIN_API_KEY` only** (no member re-check) — so a leaked
key grants full admin-API power.

---

### 🔴 F-02 — PIA approval decisions can be forged (no identity check in the function)
**Checklist:** Z-6 Improper Privilege Mgmt (CWE-269) / Z-3 Incorrect Authorization (CWE-863) · **Score: FAIL**

The decision processors take the approver's email **as a parameter** and look up the workflow row by it,
but **do NOT verify `Session.getActiveUser().getEmail() === thatEmail` inside the function**. Verified:
- `apiPhase3_ProcessISMDecision(sessionId, ismMemberEmail, decision, …)` — [pia_code.js:6921](Phase 2/pia_code.js:6921): validates the decision/routing whitelist and locks, then finds the row by `(sessionId, ismMemberEmail, Pending)` and stamps the decision. **No `activeUser == ismMemberEmail` check.**

The identity+token gate exists **only** in `handleEmailAction` ([pia_code.js:1370](Phase 2/pia_code.js:1370),
the token-gated `doPost` path). Because the function is a global, it's directly callable:
`google.script.run.apiPhase3_ProcessISMDecision('PIA-000010','someone-else@megaworldcorp.com','Approve','ok','BOTH')`.

**Same pattern (enumerated — confirm):** `apiProcessApprovalDecision` (head decisions, ~[8003](Phase 2/pia_code.js:8003)) and `processDivHeadDecision` (~[3849](Phase 2/pia_code.js:3849)).

**Impact:** An insider can **forge approve/deny/return/route decisions as any approver** for any request
that currently has a Pending row — defeating the entire approval ladder's integrity (the HMAC token
system this session documented is bypassed by the direct call).

---

### 🔴 F-03 — Admin config write enables privilege escalation
(Sub-case of F-01, called out separately for severity.) `saveConfigData` can add a row to
`InfoSec_Email_Config` (e.g. `INFOSEC-003`, active=YES). Combined with no authz, **any domain user can
make themselves an INFOSEC member**, then pass the `checkAccess_` gate legitimately. Self-bootstrapping
privilege escalation. **Score: FAIL.**

---

## 3. High findings

### 🟠 F-04 — DCS `apiGetRequestData` IDOR (read any request)
**Checklist:** Z-3 BOLA/IDOR (CWE-639/862) · **Score: FAIL**

[Code.js:2521](Phase 1/Code.js:2521): `apiGetRequestData(reqId)` finds the row by `reqId` via TextFinder
and returns the full record — **no `Session.getActiveUser()` ownership check** (verified). Returns
sensitive data: applicant email, Immediate/Dept/Div Head emails, metadata (incl. accountable persons),
Drive file IDs, agency data, PIA status, approver flags & comments.

**Impact:** Any domain user can read **any** request's full data + approver chain by enumerating
`DCS-0000NN`. PII / sensitive disclosure. *(Note: the sibling `apiGetReturnedApplication` DOES check
ownership at [2715](Phase 1/Code.js:2715) — but `apiGetRequestData` itself is the unguarded primitive.)*

---

### 🟠 F-05 — PIA `getApplicationData` IDOR (read any PIA submission)
**Checklist:** Z-3 BOLA/IDOR · **Score: FAIL**

[pia_code.js:5297](Phase 2/pia_code.js:5297): `getApplicationData(sessionId)` returns the full
application with **no authorization** (verified). It's reached by client-callable
`apiPhase3_FetchPIAData` (~[6517](Phase 2/pia_code.js:6517)) and `apiPhase3_FetchDCSData`
(~[6552](Phase 2/pia_code.js:6552)).

**Impact:** Any domain user can read **any** PIA submission (full PIA1–5 answers, PII inventory, business
purpose, applicant, approval timeline) by sessionId. *(Note: `apiGetApplicationData` at ~[8489](Phase 2/pia_code.js:8489) DOES gate by owner-or-approver — but the `getApplicationData` core + the two `Fetch*` wrappers do not.)*

---

## 4. Medium / Low findings

### 🟡 F-06 — Raw error text returned to the client — ✅ FIXED 2026-08-12
**Checklist:** E-3 Sensitive Info Exposure (CWE-200) · **Original score: FAIL (Medium)**

**What it was.** Endpoints returned `{ success:false, error: e.toString()/e.message }` straight to
the browser. GAS exceptions quote the offending resource, so a Drive failure leaked the folder ID
and a Sheets failure leaked the spreadsheet ID.

**Actual scope: 89 sites, not the 58 originally estimated** (Phase 1: 14, PIA: 32, Admin: 43). The
undercount came from two shapes the first pass did not look for: multi-line object literals, and
the non-`success` envelopes in `Phase 1/Code.js` (`{found:false, state:null, error: err.message}`).
Two of the line references in the original finding were also stale, and `deleteEntry` no longer
exists anywhere in the repo.

**The fix.** `safeError_(e, code, publicMessage)` — one identical copy per project, since the three
GAS projects cannot share code. It logs `[ref] CODE :: stack` and returns a generic message plus a
short **reference code**; the user quotes the ref, the admin finds it in the Executions log. The
real exception is deliberately **not** written to `Risk_Audit` (log bloat, and a sheet write inside
an error handler is a second failure waiting to happen).

Responses also gained a machine-readable `code` from a fixed vocabulary (`UNAUTHORIZED`,
`FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `ALREADY_ACTIONED`, `BUSY`, `INTERNAL`), so the
UI can branch on failure *type* instead of string-matching.

🚩 **The envelope is dual-key for one release** — `{ok, code, message}` alongside the legacy
`{success, error}` — because the three projects deploy independently and a frontend lagging a
backend is the normal case. Drop the legacy pair from all three backends **and** the three
frontends in the same change. Verification: the `ok:` count must equal the `success:` count in
each backend.

### 🟡 F-07 — Mass-assignment of raw PIA cells in `submitApplication`
**Checklist:** Z-6 / CWE-915 · **Score: NEEDS-EVIDENCE (Medium)**
`submitApplication` serializes client-supplied `pia1..pia5` JSON directly (~[3626](Phase 2/pia_code.js:3626)).
Ownership is re-checked ([3704](Phase 2/pia_code.js:3704)) and status is server-computed, so the blast
radius is limited to the applicant's own record — but the raw JSON is trusted. Confirm no
control-field (e.g. `isEditing`, `baseSessionId`) is honored from the payload.

### 🟢 F-08 — DCS cross-app gate `getGatewayRecord(userEmail)` accepts an identity override
**Checklist:** Z-3 · **Score: NEEDS-EVIDENCE (Low)**
[Code.js:2836](Phase 1/Code.js:2836): optional `userEmail` param defaults to the active user but can be
overridden by the caller, returning another user's gating decision + reqId + fileId. Intended for PIA
backend use, but the contract is undefended. Low (limited data), but should bind to the active user.

---

## 5. What's already correct (confirmed PASS — keep)

| Control | Evidence |
|---|---|
| Domain gate on all `doGet`/`doPost` (fail-closed) | DCS 514/552, PIA 1161/1223, Admin 231/242 |
| Admin 2-layer entry gate (domain + INFOSEC member) | `checkAccess_` [admin_code.js:242](Admin/admin_code.js:242) |
| Draft ownership checks (all draft fns filter by active user) | DCS 984/1031/1048, PIA 8130/8256/8302 |
| Submit ownership re-check inside lock (TOCTOU-safe) | DCS [1510](Phase 1/Code.js:1510), PIA [3704](Phase 2/pia_code.js:3704) |
| Owner-or-approver gate where present | `apiGetApplicationData` [pia_code.js:8489](Phase 2/pia_code.js:8489), `apiGetReturnedApplication` DCS 2715 |
| HMAC action-bound token + identity match (email-link path) | `handleEmailAction` [pia_code.js:1370](Phase 2/pia_code.js:1370) |
| Admin JSON API key check before dispatch | [admin_code.js:481](Admin/admin_code.js:481) |
| Decision / routing value whitelists | pia_code.js 6925/6931 |
| File upload magic-byte validation | DCS `uploadProxy` |
| LockService on all sensitive writes | DCS/PIA |

---

## 6. Roll-up & next steps (per checklist 03.01)

- **Critical FAILs:** 3 (F-01, F-02, F-03) — *block "production-ready" sign-off until remediated or written risk-accept.*
- **High FAILs:** 2 (F-04, F-05).
- **Medium:** 2 (F-06, F-07). **Low:** 1 (F-08).
- **NEEDS-EVIDENCE:** F-07, F-08 (confirm exact behavior before fixing).

**Remediation pattern (one fix shape covers most):** add a server-side authorization guard at the top of
each sensitive function —
- **Reads (F-04/F-05):** derive `me = Session.getActiveUser().getEmail()`, then require `me` owns the
  record *or* is a listed approver before returning.
- **Decisions (F-02):** require `me === thatApproverEmail` (and keep the token check for the email path).
- **Admin ops (F-01/F-03):** call `checkAccess_(me)` at the top of every privileged function, not just `doGet`.
- **Errors (F-06):** return a generic message; log detail server-side.

> ⚠️ All remediations are **backend `*_code.js` edits** (higher-risk per CLAUDE.md §2) + redeploy + re-test.
> Per the agreed scope, these are **NOT applied now** — batch them into a dedicated hardening pass **after**
> functional testing of the email flow is complete. Sequence Critical → High → Medium.
