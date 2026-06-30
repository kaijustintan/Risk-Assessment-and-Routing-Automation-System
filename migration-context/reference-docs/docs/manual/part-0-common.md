# Part 0 — Common Reference (RARS)

> **Read this first.** Everything that is true across all three apps lives here and
> **only** here. The per-phase Parts (1 = DCS, 2 = PIA, 3 = Admin) link back to these
> sections instead of repeating them. If a fact appears in two places and they disagree,
> **this file wins.**
>
> Legend: 🧑 end-user · 🛠 admin · 👨‍💻 developer · 🚩 = do not break this / hard-won lesson.

---

## §0.1 — RARS overview

**Layman:** RARS (Risk Assessment & Routing System) is Megaworld's online pipeline for
requesting access to company data. You apply, the right people approve it up a ladder, and
if it clears all the way, you get a Certificate of Approval. It looks like one website to
the user, but it is actually **three small apps that hand off to each other**.

**Technical:** RARS is three **independent Google Apps Script (GAS) web apps**, each its own
GAS project, deployment, and `appsscript.json` manifest. They never call each other's code.
They coordinate **only through one shared Google Spreadsheet** (the database) plus a few
stored deployment URLs (see §0.4).

| Phase | App | What it does | Source folder |
|-------|-----|--------------|---------------|
| **Phase 1** | **DCS** (Data Collection System) | The request form. Apply, attach NDA/DPA/DSA, track status. | `Phase 1/` |
| **Phase 2** | **PIA** (Privacy Impact Assessment) | The privacy questionnaire after DCS clears; runs the whole approval ladder. | `Phase 2/` |
| **Phase 3** | **Admin** | ISM control tower — dashboard, analytics, certificate routing, settings, email failover. Restricted to INFOSEC-001/002. | `Admin/` |

**The end-to-end flow (one product, three apps):**

```
  Applicant ─► DCS request ─► (cleared) ─► PIA assessment ─► approval ladder ─► Certificate
   Phase 1 ────────────────┘   handoff    └──────────── Phase 2 ───────────────┘
                                                              │
                                Phase 3 (Admin) oversees everything: dashboard,
                                routing, config, email resend — read/writes the whole DB.
```

**Why three apps instead of one?** Each phase was built and is deployed independently, so a
change to one ships without redeploying the others. The price of that independence is the
**cross-app contract** (§0.2, §0.4) — the shared sheet and the stored URLs — which is the
single most fragile part of the system.

### V2 vs V1 (what improved)
*(Full detail: `docs/V2 - Difference from V1 (Old System).md`.)* In short, V2 replaced the
manual, paper/email-driven PIA process with a structured, trackable, approval-driven web
flow: server-side drafts, automatic risk flagging, HMAC-secured email links, a 5-stage
progress timeline, and an admin dashboard with certificate routing.

---

## §0.2 — Architecture & data model

### The three layers
1. **Application layer (GAS):** each app = a frontend HTML file (CSS + screens + client JS,
   rendered by JavaScript at runtime) + a backend `.js`/`.gs` file (`doGet`/`doPost`, business
   logic, DB access), talking over `google.script.run`.
2. **Database layer (Google Sheets):** **one** spreadsheet, many tabs. This is the only
   integration point between the three apps.
3. **File storage layer (Google Drive):** uploaded documents (NDA/DPA/DSA/CU/Endorsement)
   live in an admin Drive folder (`ADMIN_FOLDER_ID`).

### The integration point: one shared spreadsheet
All three apps read/write the **same** spreadsheet. DCS owns `Data_Collection`; PIA owns
`Applications` + the `*_Approval_Workflow` sheets; Admin reads/writes everything. The join
between a DCS request and its PIA application is:

> **`Data_Collection.ReqID`  →  `Applications.Linked_ReqID`**

🚩 **Never rename or repurpose a shared column, the `ReqID`/`Linked_ReqID` join, or a stored
URL.** A change in one app silently breaks another that reads the same sheet.

### Canonical sheet reference
*(This replaces the three drifting copies in the old manuals. Sheet names verified against
`SHEET_NAMES` in `Admin/admin_code.js`.)*

| Sheet | Owner (writer) | Holds | Key columns |
|-------|----------------|-------|-------------|
| `Data_Collection` | DCS | One row per DCS request | LogID, **ReqID**, UserEmail, **Status**, ImmediateHeadEmail, DeptHeadEmail, DivHeadEmail, FileID, Metadata_JSON, Timestamp, Metadata_Agency, Remarks |
| `Applications` | PIA | One row per PIA submission | **SessionID**, ApplicantEmail, Status, PIA_1_Data … PIA_5_Data (JSON), **Linked_ReqID**, ApproverFlags |
| `Approval_Workflow` | PIA | Stage A head decisions | ApprovalID, SessionID, CurrentStep, ApproverName, ApproverEmail, Decision, Comments, DecisionDate, Status |
| `ISM_Approval_Workflow` | PIA | Stage B InfoSec decisions | ISM_Approval_ID, SessionID, CurrentStep, ISM_Member_Name, ISM_Member_Email, Decision, Comments, DecisionDate, Status, Requires_DivHead, Routing_Destination |
| `DivisionHead_Approval_Workflow` | PIA | Stage D escalation decisions | Escalation_ID, SessionID, DivHead_Email, Decision, Comments, DecisionDate, Status |
| `Risk_Audit` | all | Audit trail / anomaly flags | LogID, SessionID, Action, UserEmail, Timestamp, (internal flags) |
| `InfoSec_Email_Config` | Admin | ISM members + DCOPS/TechServe routing emails | Member_ID, Member_Name, Member_Email, Role, IsActive, JobPos |
| `System_Configuration` | Admin/DCS | Key-value settings (template links, etc.) | Configuration_Key, Value, Description |
| `Drafts` | DCS + PIA (shared) | Auto-saved form state, 7-day TTL | DraftID, UserEmail, SessionID, Type, StateJSON, SavedAt/SavedTimestamp, ExpiresAt |

> **Note on `Risk_Audit`:** the old PIA manual called this the "Paranormal event log." That
> is a typo/hallucination — it is the **anomalous event** audit trail (normal actions are
> `Logger.log`-ged; the sheet records genuinely anomalous events + key actions like deletes).

### Secrets & config (never in code)
Stored in each project's **Script Properties** (see §0.4 for the URL ones). Notably:
`DB_ID`/`SPREADSHEET_ID`/`PIA_DB_SPREADSHEET_ID` (the spreadsheet), `ADMIN_FOLDER_ID` (Drive),
`DOMAIN`/`ALLOWED_DOMAIN`, and `SYSTEM_SECRET` (token signing — **PIA project only**, see §0.6).

---

## §0.3 — The approval ladder & progress timeline

DCS itself has **no** approval gate — a DCS request is effectively complete on submit and
hands off to PIA. **The entire approval ladder lives in PIA.**

### The ladder (top to bottom)
```
Applicant submits PIA
 ├─ STAGE A — Main heads            (Approval_Workflow)
 │     Step 1: Immediate Head   ← named by the applicant in PIA1 (per-request)
 │     Step 2: Department Head  ← named in PIA1. Fallback: PRIVACY_OFFICER_EMAIL.
 ├─ STAGE B — InfoSec / ISM         (ISM_Approval_Workflow)
 │     Member 1 → Member 2      ← from InfoSec_Email_Config (IsActive=YES); sequential.
 │     Each can: Approve · Deny · Return · EscalateToDivisionHead.
 ├─ STAGE C — Routing               (chosen by the ISM reviewer on Approve/Escalate)
 │     DCOPS · TECHSERVE · BOTH ← where access gets provisioned after final approval.
 └─ STAGE D — Division Head         (DivisionHead_Approval_Workflow) — ONLY if escalated.
Final: all ISM approve → 'Approved by ISM' → applicant notified, DCS marked COMPLETE,
       Certificate routed to DCOPS/TechServe/Both.
```

**Who fills each role (hybrid by design):** fixed org-wide roles (the two InfoSec reviewers,
DCOPS/TechServe) are **admin-configured** in `InfoSec_Email_Config`; per-applicant roles
(Immediate / Dept / Division Head) are **filled by the applicant in PIA1** because they are
that person's own reporting line. Integrity is *mitigated* (not prevented) by risk flagging
(e.g. drafter email == head email gets flagged).

### Escalation = "up to Division Head, then back down" (not skip-to-final)
When an ISM member picks **EscalateToDivisionHead**: that ISM step pauses, the Division Head
named in PIA1 is emailed a review link.
- **DivHead Approve** → if that completes all ISM rows, finalize; otherwise the ISM chain
  **resumes at the next member** (comes back down).
- **DivHead Deny** → app Denied (terminal). **DivHead Return** → bounces to the applicant.

### Return = full restart (not resume) 🚩
A **Return** from *any* approver (head, ISM, or DivHead) always bounces to the **applicant**,
never to a previous approver. On resubmit, PIA **deletes all** `Approval_Workflow` +
`ISM_Approval_Workflow` + `DivisionHead_Approval_Workflow` rows for that session and
**rebuilds the ladder from Stage A, Step 1.** All prior approvals are wiped; lineage is kept
via a revision id (`-V2`, `-V3`…) but progress resets to zero.
- **Return ≠ Deny.** Return is a fixable loop; Deny/Reject is terminal.
- If the linked **DCS** is `Returned`, PIA resubmission is **blocked** until the DCS is fixed
  first.

### The 5-stage progress timeline
The "Overall Progress Timeline" the requester sees has **5 stages** (verified in
`Phase 1/index.html`; the old DCS manual's "4 stages" is outdated — "Heads Approval" was
split out from "PIA Assessment" in Wave 2):

```
1. DCS Request → 2. PIA Assessment → 3. Heads Approval → 4. ISM Approval → 5. Certification
```
Each stop is colored: done (green) · active/in-progress (blue) · upcoming (gray) · returned ·
denied.

### Stored status vs. displayed badge 🚩
The values written to `Data_Collection.Status` are a **small fixed set**:
`PENDING`, `READY_FOR_PIA`, `COMPLETE`, `REJECTED`, `RETURNED`.
The richer badges the UI shows ("Pending Immediate Head", "Escalated", "Processing", etc.)
are **computed in the frontend** from the workflow sheets — they are **not** stored strings.
**Do not assume a badge maps 1:1 to a column.** (Full vocabulary: §0.7.)

---

## §0.4 — Operations runbook (deployment & cross-app URLs) 🚩

> This section is the #1 source of "everything broke." Read it before touching any
> deployment. (Background: this cost a multi-hour debug once.)

### How shipping actually works
We edit files **in this repo**. Shipping to live is **manual, per phase**: copy-paste the
edited file into the **matching** GAS project, then **redeploy that project**. Each phase
deploys **independently** — a change to PIA does nothing until the PIA project is redeployed.

> ⚠️ The old manuals describe a `clasp` workflow. That is **not** how we ship. `clasp`,
> domain config, and migration are **not** our responsibility. Don't add deploy scripts.

### THE GOLDEN RULE — one deployment per app, forever
A deployment's `/exec` URL is like a phone number; Script Properties are contacts saving that
number. Nothing auto-updates.

- ✅ **Edit the existing deployment → New version → Deploy.** Same URL → every stored link
  stays valid → zero property edits.
- ⛔ **Never click "New deployment."** It mints a brand-new URL → every saved URL below now
  calls a dead line → the "Proceed to Phase 2" button and *all* email links break, and you
  must hand-fix each property.

Path: `Deploy → Manage deployments → ✏️ Edit the one deployment → Version → "New version" → Deploy`.

### The Script-Property URL map (set ONCE if you follow the golden rule)
Each value = that app's live `/exec` URL. ⚠️ `DCS_WEB_APP_URL` exists in **both** DCS and PIA
projects — the **PIA** copy is the one the email code reads.

| Project | Property | Must hold | Used by |
|---------|----------|-----------|---------|
| **DCS** | `PIA_APP_URL` | live **PIA** `/exec` | "Proceed to Phase 2" button |
| **DCS** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | DCS self-reference |
| **PIA** | `WEB_APP_URL` | live **PIA** `/exec` | approver "Review Access Request", ISM/approval forms, reminders |
| **PIA** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | applicant "View DCS Submission" link |
| **Admin** | `WEB_APP_URL` | live **PIA** `/exec` | manual email resend CTAs (generic "open the system", no token) |

**Consistency check:** DCS `PIA_APP_URL` **==** PIA `WEB_APP_URL` (both = live PIA), and
DCS `DCS_WEB_APP_URL` **==** PIA `DCS_WEB_APP_URL` (both = live DCS). If a pair disagrees, a
link is about to break.

### Why it's manual at all
The three apps are separate GAS projects that can't discover each other's URLs. An app's
*own* URL is auto-derivable (`ScriptApp.getService().getUrl()`), but **cross-app URLs must be
stored** — that's the glue. "Set once" (one stable deployment) beats "set every deploy."

### Email-link gotchas
- **Emails freeze their links at send time.** Updating a property fixes **future** emails
  only; links already in inboxes stay dead. Re-trigger/resend to test.
- **Review tokens have a 14-day TTL.** Judge link behavior only with freshly generated links.
- **`?parentID=` path only:** PIA's `doGet` evaluates the `index` template only on the
  `?parentID=` path, so template bugs surface on "Proceed to Phase 2" but not on a bare URL.

### Manifest scopes
Only add an OAuth scope (`*_appsscript.json`) when the code genuinely needs it (e.g.
`script.scriptapp` for triggers, `script.send_mail`/Gmail for email). Adding a scope forces
**re-authorization** on the next deploy/run. Flag it.

---

## §0.5 — Known gotchas & debugging 🚩

| Gotcha | What happens / what to do |
|--------|---------------------------|
| **GAS serve-time template-literal corruption** | A string-building helper written as a **template literal** (backticks) can blank the whole page with a parse error (`Unexpected identifier 'style'` at `document.write(s(g))`) — **even though `node --check` passes**, because `node --check` validates the file on disk, not GAS's serve-time serialization. **Fix:** rebuild the helper with plain ASCII string concatenation (`'a' + x + 'b'`). To get ground truth, read the served **VM** file at the console error's `VM##:line` — that's the actual served (corrupted) code, not your disk file. |
| **Screens are rendered by JS** | Screen `<div>`s are empty in the HTML; JS fills them via `render*()` at runtime. Ctrl+F for on-screen text will miss it — search the matching render function. |
| **Drafts don't store files** | Only text autosaves (server-side, 7-day TTL). Resuming a draft requires re-uploading files. This is **intended**, not a bug. |
| **`localStorage` is intentionally disabled** | Avoids client/server state mismatch. Don't "re-enable" it. |
| **Favicon override** | A MutationObserver + setInterval re-applies the favicon (GAS injects its own). Not dead code — don't remove. |
| **`<? … ?>` inside comments in a templated HTML file** | The GAS template engine parses scriptlets even inside comments → a stray one throws during `template.evaluate()`. Never write literal scriptlet tags in comments in `index`. |
| **"Returned" ≠ "Denied"** | Returned is a fixable loop; denied/rejected is terminal. |

**General debugging:** frontend → browser DevTools Console/Network (watch `google.script.run`
calls). Backend → GAS editor **Executions** + `Logger.log` / Stackdriver. Audit → the
`Risk_Audit` sheet.

---

## §0.6 — Security model

### Access control
- **Domain gate (all three apps):** `doGet` blocks non-corporate accounts before serving any
  HTML. The master switch is **on in all three** — `ENABLED_DOMAIN_CHECK = true` (DCS
  `Code.js:268`, Admin `admin_code.js:145`) / `ENABLE_DOMAIN_CHECK = true` (PIA
  `pia_code.js:185`). *(The old PIA manual said this defaulted to `false` — that is no longer
  true.)*
- **Admin is INFOSEC-only:** Admin's `checkAccess_` allows **only** accounts whose
  `InfoSec_Email_Config` row has `Member_ID` = `INFOSEC-001` or `INFOSEC-002` **and** a
  matching email. *(The old Admin manual described "Layer 2 = INFOSEC member **or** domain
  match"; the domain-match fallback was removed during this session's hardening — it is now a
  strict INFOSEC allowlist.)*
- **Ownership:** only the owner of a PIA application can view/revise it; approvers can view
  only while reviewing.

### Token security
- Approval/review/decision email links carry an **HMAC-SHA256 token** bound to the approver
  email + specific action (Approve, Deny, Return, Review, ISMReview), with a **14-day TTL**.
- The signing secret is **`SYSTEM_SECRET`, and it lives in the PIA project** (read by
  `getSystemSecret()`).
  🚩 **The name "HMAC_SECRET" in the old DCS manual/comments is a misnomer** — there is no
  functional `HMAC_SECRET`; DCS does not sign tokens. When auditing token security, check
  **`SYSTEM_SECRET` in the PIA project.**
- Email normalization strips `+aliases` to prevent alias-bypass of authorization.

### Input & integrity
- `submitDCS` (DCS) and `apiSubmitApplication` (PIA) **re-validate domain + required fields +
  email formats server-side** (defense-in-depth; never trust the client).
- Input sanitization removes XSS vectors (`javascript:`, `on*=`, `data:` URIs) on both sides.
- `LockService` prevents race conditions on session-ID generation, approval decisions, and
  draft writes.
- Decision records can't be modified once processed (duplicate-action detection).
- File uploads are validated client- and server-side (extension, size ≤10MB, MIME).

### This session's hardening (summary)
- **DCS (`Code.js`):** findings F-04 / F-08 addressed.
- **PIA (`pia_code.js`):** F-05 + identity guards on ISM / approval / DivHead decisions.
- **Admin (`admin_code.js`):** 17 `checkAccess_` guards added across API entry points.
- Full detail: `docs/Security - Review Findings.md` and `docs/Security - Recommendations.md`
  (reproduced in Appendix, see `appendices.md`).

---

## §0.7 — Glossary & conventions

| Term | Meaning |
|------|---------|
| **RARS** | Risk Assessment & Routing System — the whole 3-app product. |
| **DCS / PIA / Admin** | Phase 1 / Phase 2 / Phase 3 apps. |
| **ReqID** | DCS request identifier (e.g. `DCS-000042`). Lives in `Data_Collection`. |
| **SessionID** | PIA application identifier (e.g. `PIA-000042`, with `-V2` etc. on revisions). Lives in `Applications`. |
| **Linked_ReqID** | The `Applications` column that stores the parent DCS `ReqID` — the cross-app join key. |
| **parentID** | URL parameter (`?parentID=<ReqID>`) that deep-links DCS → PIA for a specific request. |
| **Stage A / B / C / D** | Heads / ISM / Routing / Division-Head escalation (see §0.3). |
| **Return** | Bounce to applicant; full ladder restart on resubmit (≠ Deny). |
| **Escalate** | ISM kicks the decision up to the Division Head, then comes back down. |
| **Stored status** | One of `PENDING`, `READY_FOR_PIA`, `COMPLETE`, `REJECTED`, `RETURNED` (in `Data_Collection.Status`). |
| **Computed badge** | The richer label shown in the UI, derived from the workflow sheets — not a stored value. |
| **ISM / InfoSec** | The two-person information-security review team (`INFOSEC-001`, `INFOSEC-002`). |
| **DCOPS / TechServe** | Implementation teams that receive the final certificate, per the routing decision. |

### Status reference

**Stored (`Data_Collection.Status`):** `PENDING` · `READY_FOR_PIA` · `COMPLETE` · `REJECTED` · `RETURNED`

**Computed UI badges (examples — see per-phase parts for the full lists):**

| Badge | Color | Meaning |
|-------|-------|---------|
| Pending | Blue | Awaiting initial Immediate-Head review |
| Approved | Green | Approved at the current step |
| Returned | Yellow/Orange | Needs revision — edit & resubmit |
| Denied / Rejected | Red | Terminal rejection |
| Escalated | Light blue | Sent to Division Head |
| Processing / Ready for Phase 2 | Purple | DCS cleared; proceed to PIA |
| Fully Certified | Green | All phases complete |

---

*Part 0 ends here. Continue to Part 1 (DCS), Part 2 (PIA), or Part 3 (Admin) — each links
back to these sections rather than repeating them.*
