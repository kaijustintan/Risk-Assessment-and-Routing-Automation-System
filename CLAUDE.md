# CLAUDE.md — Megaworld RARS (DCS / PIA / Admin)

> Project-specific instructions for this repo. My global preferences (tone, doc style,
> Q&A teaching format, git rules) load separately from `~/.claude/CLAUDE.md` — this file
> only adds facts that are true *here*.

---

## 1. What this project is (Layman → Technical)

**LAYMAN (Tropang Ex):** This is Megaworld's **RARS** (Risk Assessment & Routing System) —
the online pipeline for requesting access to company data. It has **3 separate apps that
work as one flow**, all sharing **one Google Sheet** as their database:
- **Phase 1 — DCS** (Data Collection System): the request form. You apply, attach NDA/DPA/DSA.
- **Phase 2 — PIA** (Privacy Impact Assessment): the privacy questionnaire you fill after
  your DCS is cleared ("Proceed to Phase 2").
- **Phase 3 — Admin**: the ISM control tower — dashboard, email routing, settings
  (download links, reminders), oversight. Restricted to INFOSEC-001/002.

A request climbs an approval ladder (Immediate Head → Dept Head → maybe Division Head → ISM)
until "Fully Certified." See [docs/](docs/) for handoff specs.

**TECHNICAL:** Three **independent Google Apps Script web apps**, each its own GAS project +
deployment + `appsscript.json`. They never call each other directly — they coordinate
**only through the shared Google Spreadsheet** (DCS reads/writes `Data_Collection`; PIA
reads the DCS row via a `parentID`/`Linked_ReqID` and writes `Applications` + the
`*_Approval_Workflow` sheets; Admin reads/writes everything). DCS hands off to PIA via the
`PIA_APP_URL` stored in Script Properties. The real DB schema is in `DPS_DB*.xlsx` (gitignored).

---

## 2. 🚨 Architecture facts — read before editing

**All three phases' full source (frontend HTML + backend `*_code.js` + manifests) now live
in this repo, organized by folder (see §4). The live source of truth is each phase's GAS
cloud project; this repo is where we edit, then Kai copy-pastes into the right project.**

```
   Phase 1 DCS            Phase 2 PIA              Phase 3 Admin
   ┌─────────────┐        ┌─────────────┐         ┌─────────────┐
   │ index.html  │        │ pia_index   │         │ adminView   │  ← frontends
   │ Code.js     │        │ pia_code.js │         │ admin_code  │  ← backends (doGet, email, DB)
   └──────┬──────┘        └──────┬──────┘         └──────┬──────┘
          └───────────── ONE shared Google Spreadsheet ──┘   ← the only integration point
                    (Data_Collection · Applications · *_Approval_Workflow ·
                     Drafts · Risk_Audit · System_Configuration · Email_Queue · …)
```

**Implications — enforce these:**
- ✅ **Frontend/design changes are the common, low-risk work** (CSS, render functions, copy,
  client validation). Phase 1 is the original supervisor scope.
- ⚠️ **Backend (`*_code.js`) edits are higher-risk** — they send real emails to real people
  and write the shared DB. When a task genuinely needs one (e.g. an email resend/notifier),
  do it, but: reuse existing helpers, never weaken domain/auth checks, isolate sends in
  try/catch, and cap blast radius. Flag it clearly.
- ⛔ **Never break the cross-app contract:** don't rename/repurpose shared sheet columns, the
  `parentID`/`Linked_ReqID` link, or stored URLs (`PIA_APP_URL`, `DCS_WEB_APP_URL`). A change
  in one phase can silently break another that reads the same sheet.
- **Manifest scopes** (`*_appsscript.json`): only add a scope when code genuinely needs it
  (e.g. `script.scriptapp` for triggers, `script.send_mail` for `MailApp`). Flag it.

---

## 3. Our workflow & responsibility boundary

- **What we do:** edit files in this repo (primarily Phase 1 frontend; other phases as the
  task requires).
- **How it ships — per phase, manual:** Kai **copy-pastes** the edited file into the
  **matching** GAS project, then **redeploys that project** (Deploy → Manage deployments →
  edit → New version → keeps the same `/exec` URL). Each phase deploys **independently** — a
  change to PIA does nothing until the PIA project is redeployed.
- **Re-auth:** adding a manifest scope forces re-authorization on next deploy/run.
- **NOT our responsibility:** `clasp`, domain config, migration. Don't add deploy scripts.
- **Git:** normal commits here (reminder-only per global rules). Pushing to live = the manual
  copy-paste above, unrelated to git. `DPS_DB*.xlsx` is gitignored (real PII).

---

## 3b. 🚨 Deployment golden rule & Script-Property URL map

> Learned the hard way (a multi-hour debug). The cross-app links (the "Proceed to Phase 2"
> button + every email link) are wired through **Script Properties that store deployment URLs**,
> and those URLs only stay valid if you deploy correctly. Read this before touching any
> deployment.

**LAYMAN (Tropang Ex):** A deployment's `/exec` URL is like a phone number. Script Properties
are contacts saving that number. Nothing auto-updates. **Edit an existing deployment → New
version = same number** (contacts stay valid forever). **New deployment = brand-new number**
(every saved contact now calls a dead line, and you must hand-fix each one). All the "links
not working" pain came from making *new deployments* per change instead of versioning one.

**THE GOLDEN RULE — each app keeps exactly ONE web-app deployment.** To ship a change:
`Deploy → Manage deployments → ✏️ Edit the one deployment → Version → "New version" → Deploy`.
**Never** click **"New deployment."** New version keeps the same `/exec` URL → every stored
URL below stays valid → zero property edits needed. One stray "New deployment" silently
orphans the URLs and breaks the button + all email links.

**Why it's manual at all:** the 3 apps are **separate GAS projects** that can't discover each
other's URLs. A project's *own* URL is auto-derivable (`ScriptApp.getService().getUrl()`, used
as the fallback in PIA's `getWebAppUrl()`), but **cross-app URLs must be stored** — that's the
integration glue. "Set once" (one stable deployment) beats "set every deploy."

**Property → URL map (set ONCE if you follow the golden rule).** Each value = that app's live
`/exec`. ⚠️ `DCS_WEB_APP_URL` exists in **both** DCS and PIA projects — the **PIA** copy is the
one the email code reads.

| Project (Script Properties) | Property | Must hold | Feeds / read by |
|---|---|---|---|
| **DCS** | `PIA_APP_URL` | live **PIA** `/exec` | "Proceed to Phase 2" button (`generatePhase2Url_`) |
| **DCS** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | DCS self-reference |
| **PIA** | `WEB_APP_URL` | live **PIA** `/exec` | approver "Review Access Request", ISM/approval forms, reminders (`getWebAppUrl`) |
| **PIA** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | applicant "View DCS Submission" link (`getDCSWebAppUrl`) |
| **Admin** | `WEB_APP_URL` | live **PIA** `/exec` | manual-resend email CTAs (`notifyApprover` / `notifyApplicant` / `apiPhase3_NotifyISMember`, via `getOptionalUrl_`). Generic "Open the System" link — **no token, no `parentID`**. Missing prop → button silently omitted (graceful). Admin uses **no** `DCS_WEB_APP_URL` / `PIA_APP_URL`. |

Consistency check: **DCS `PIA_APP_URL` == PIA `WEB_APP_URL`** (both = live PIA), and **DCS
`DCS_WEB_APP_URL` == PIA `DCS_WEB_APP_URL`** (both = live DCS). If a pair disagrees, a link is
about to break.

**Gotchas when links die:**
- **Emails freeze their links at send time.** Updating a property only fixes **future** emails;
  ones already in inboxes stay dead. Re-trigger/resend to test.
- **Review tokens have a 14-day TTL** (`isTokenValid`) — judge only with freshly generated links.
- **`?parentID=` only:** PIA's `doGet` evaluates the `index` template **only** on the
  `?parentID=` path, so template bugs surface on "Proceed to Phase 2" but not on a bare URL.
- **Never write literal `<? … ?>` inside comments** in a templated HTML file (`index`): the GAS
  template engine parses scriptlets even in comments → a stray `...` throws
  `Unexpected token '...'` during `template.evaluate()`.

---

## 4. File map (by phase)

| Path | Role | Touch it? |
|------|------|-----------|
| `Phase 1/index.html` | **DCS frontend** — CSS, 9 screens, client JS, validation | ✅ main work |
| `Phase 1/Code.js` | DCS backend (~2,670 lines) — `doGet`, drafts, `submitDCS`, risk audit. **One email:** `notifyDcsRequester_` ("Proceed to Phase 2" confirmation). | ⚠️ careful |
| `Phase 2/pia_index.html` | PIA frontend — multi-section assessment wizard | ⚠️ as needed |
| `Phase 2/pia_code.js` | PIA backend (~9,000 lines) — approval workflow, ISM, **all email** (`notifyApplicant`) | ⚠️ careful |
| `Admin/adminView.html` | Admin frontend — dashboard, settings, email routing | ⚠️ as needed |
| `Admin/admin_code.js` | Admin backend — config, manual email resend (`adminResendEmail`), `MailApp` senders | ⚠️ careful |
| `*/…_appsscript.json` | Per-phase GAS manifest (Asia/Manila, scopes, DOMAIN access) | ⚠️ only for a new scope |
| `docs/` | Cross-team handoff specs (e.g. category dropdown) | ✅ |
| `DPS_DB*.xlsx` | Real DB export for schema reference — **gitignored (PII)** | 📖 read-only |
| `CLAUDE.md` | This file | Update when facts change |

---

> **§5–§8 below are Phase 1 (DCS) specifics** — `Phase 1/index.html`. PIA and Admin have
> their own structures (see §1/§4); explore those files directly when working in them.

## 5. The 9 screens (all in `Phase 1/index.html`, swapped by `show(name)`)

Screen `<div>`s are **empty in the HTML** — JS fills them via `render*()` at runtime. So
Ctrl+F for on-screen text may miss it; search the matching render function instead.

| Screen | Purpose | Render fn (approx line) |
|--------|---------|-------------------------|
| landing | Home: New Request vs Review Applications | `renderLanding()` ~2791 |
| guide | Step 1: intro, T&Cs, template downloads | `renderGuide()` ~3043 |
| form | Step 2: main input form | `renderForm()` ~3217 |
| agency | Step 2b: extra fields, only if "involves an Agency" | `renderAgency()` ~4019 |
| summary | Step 3: review before submit | `renderSummary()` ~4108 |
| success | Confirmation + DCS ID | `renderSuccess()` ~4375 |
| drafts | Resume / disregard saved drafts | `renderDrafts()` ~2917 |
| requests | "My Applications" list + status legend | `renderRequests()` ~4410 |
| request-details | One request's timelines + approver comments | `renderRequestDetails()` ~4593 |

Other key functions: `show()` ~2676 (router), `validateDCSForm()` ~1843,
`triggerAutoSave()` ~2545, `submitRequest()` ~4250, `editReturnedApplication()` ~4713,
timelines `renderApprovalTracker()` ~2350 / `renderPiaTimeline()` ~2092.
*(Line numbers drift as the file changes — treat as hints, not absolutes.)*

---

## 5b. Backend reference (from `Code.js` — the cloud `Code.gs` mirror)

This is **Phase 1 of RARS** (Risk Assessment & Routing System). DCS = Phase 1; **PIA =
Phase 2** is a separate GAS web app sharing the same database + `Drafts` sheet.

**Database = one Google Spreadsheet** (id in Script Property `DB_ID`). Tabs:

| Sheet | Holds |
|-------|-------|
| `Data_Collection` | One row per DCS request. Cols: LogID, ReqID, UserEmail, **Status**, ImmHead/DeptHead/DivHead emails, FileID, MetadataJSON, Timestamp, MetadataAgency |
| `Drafts` | Auto-saved JSON, 7-day TTL, **shared with PIA**. Cols: DraftID, UserEmail, SessionID, Type, StateJSON, SavedAt, ExpiresAt |
| `Risk_Audit` | Full action log + auto risk flags |
| `Applications`, `Approval_Workflow`, `ISM_Approval_Workflow`, `DivisionHead_Approval_Workflow` | Per-approver decisions; timelines are built from these (shared w/ PIA) |
| `System_Configuration` | Template links + settings (key/value) |

**Stored status values** (`Data_Collection.Status`): `PENDING`, `READY_FOR_PIA`,
`COMPLETE`, `REJECTED`, `RETURNED`. ⚠️ The richer badges shown in the UI
("Pending Immediate Head", "Escalated", etc.) are **computed in the frontend** from the
workflow sheets — they are NOT stored strings. Don't assume a badge maps 1:1 to a column.

**Secrets** live in Script Properties (never in code): `DB_ID`, `ADMIN_FOLDER_ID`,
`PIA_APP_URL`, `DOMAIN`. ⚠️ **The approval-token signing secret is named `SYSTEM_SECRET`
and lives in the PIA project** (read by `getSystemSecret()` → `pia_code.js`), NOT `HMAC_SECRET`
— the old "`HMAC_SECRET`" name in these docs/`Code.js` comments is a misnomer; DCS does not
functionally read it. When verifying token security, check **`SYSTEM_SECRET` in the PIA project**.

**Security (do not weaken):** `doGet` blocks non-domain accounts before serving the HTML;
`submitDCS` re-validates domain + required fields + email formats server-side
(defense-in-depth). Files are uploaded base64 → Drive folder `ADMIN_FOLDER_ID` via
`uploadProxy`. `analyzeDCSRisk()` auto-flags conflict-of-interest / duplicate-role /
short-entry / missing-accountable patterns into `Risk_Audit`.

**Server API contract** (what each `google.script.run` call returns — read the function in
`Code.js` before relying on a field):
`apiGetSystemConfig` → `{success, config:{DOMAIN, LINK_*_TEMPLATE, ...}}` ·
`apiGenerateNewSessionId` · `apiSaveDraft(sessionId, stateData)` ·
`apiRestoreDraft` / `apiListUserDrafts` / `apiDeleteDraft` ·
`submitDCS(payload, sessionId)` → `{success, reqId, phase2Url?}` ·
`apiListUserRequests` · `apiGetRequestData(reqId)` (form data + approvers + timelines) ·
`apiGetReturnedApplication(reqId)` (revision flags).

---

## 6. Design system (the tokens to reuse — do NOT hardcode new values)

All defined in `:root` near the top of the `<style>` block (~line 70).

- **Navy palette:** `--navy: #1e3a5f`, `--navy-mid: #2a5285`, `--navy-bright: #3b76c4`,
  `--navy-tint: #f4f7fb`, `--navy-text: #0f2238`.
- **Semantic:** `--success / --danger / --warn` (+ matching `-text` vars).
- **Type:** `--font` = DM Sans; `--font-mono` = DM Mono. Base body 13px. Headings use
  `clamp()` for fluid scaling.
- **Shape:** `--radius` 4px, `--radius-lg` 9px.
- **Motion:** `--dur-fast` 140ms, `--dur-med` 240ms, `--dur-slow` 400ms, with `--ease-*`.
- **Components:** `.card`, `.btn` / `.btn-primary`, `.status-badge` (+ `.status-approved`,
  `.status-denied`, `.status-returned`, `.status-pending`, `.status-escalated`,
  `.status-processing`, `.status-submitted`, `.status-info`), `.alert-*`, navy sidebars,
  vertical + horizontal timelines.
- **Responsive breakpoints:** `768px` (tablet — sidebar→static, grid→1col, buttons
  full-width) and `480px` (phone — smaller type, sticky bottom button bar).

**Rule:** new colors/spacing/radius must reuse existing `--vars`. If a value doesn't exist,
ask before inventing one — consistency with the navy system matters to the supervisor.

---

## 7. Change-safety checklist (run before declaring a design change done)

- [ ] Did I edit the right `render*()` function (since screens are JS-built, not static)?
- [ ] Reused existing `--design-tokens` instead of hardcoding hex/px?
- [ ] Checked **both** responsive breakpoints (768px and 480px)?
- [ ] If I touched a timeline, did I update **both** the horizontal and vertical variants
      (mobile collapses horizontal → vertical)?
- [ ] If I touched a status badge/legend, do the color, label, and legend still agree?
- [ ] No `google.script.run.api*` call renamed, removed, or invented?
- [ ] No accidental change to validation, autosave debounce, or submit flow?
- [ ] Loading / error / success / revision-mode states still render?
- [ ] Flagged any change that secretly needs backend data I can't provide here.

---

## 8. Known gotchas

- **Screens are rendered by JS**, not present as static HTML — search render functions.
- **Files are NOT stored in drafts** — only text autosaves (server-side, 7-day TTL).
  Resuming a draft requires re-uploading files. Don't "fix" this as a bug; it's intended.
- **`localStorage` is intentionally disabled** to avoid client/server state mismatch.
- **Revision mode** (`state.isEditing = true`) highlights flagged fields and forces
  re-upload of flagged files only — non-flagged files stay in Drive.
- **"Returned" ≠ "Denied":** returned is a fixable loop; denied/rejected is terminal.
- **Favicon override** uses a MutationObserver + setInterval (GAS injects its own icon) —
  don't remove it thinking it's dead code.
- **Downloadable templates** are driven by the `DOWNLOADABLES` array in `renderGuide()`.
  Add/remove a form by editing that array; the link itself is admin-managed via a
  `LINK_*_TEMPLATE` row in the `System_Configuration` sheet (generic config passthrough — no
  backend code change needed). Missing row → link shows "Link not set" (`#`). The Admin app's
  Settings UI can edit these link rows; new keys (e.g. `LINK_OJT_NDA_TEMPLATE`) currently
  need a direct sheet row or an Admin UI addition.
- **Approval reminders live in PIA, not Admin** (corrected — the original "`adminApi_sendDailyReminders()`
  in `Admin/admin_code.js`" was wrong on both the name and the location; verified by grep). The real
  **daily reminder engine** is `sendDailyReminders()` / `buildReminderEmail()` / `setupReminderTrigger()`
  in **`Phase 2/pia_code.js`** (~line 4671). A daily `ScriptApp` time-trigger **running inside the PIA
  project** (`atHour().everyDays(1)`, needs `script.scriptapp`) scans the 3 workflow sheets for `Pending`
  rows and emails **only the next pending approver per request**, stamping `ReminderDate` so each is
  nagged **once per day** until they act. Reminder emails carry a **valid tokenized review link**
  (`WEB_APP_URL`). The **Admin panel only *configures*** it — Settings (on/off, hour) calls PIA's
  cross-app API (`getReminderConfig` / `setReminderConfig`, dispatched in PIA `doPost` ~line 1300).
- **Admin's own emails are manual resend only** (`Admin/admin_code.js`): an ISM clicks "Resend Email" →
  `adminResendEmail` (dispatched ~`admin_code.js:874–912`) re-fires `notifyApprover` / `notifyApplicant` /
  `apiPhase3_NotifyISMember` via `sendEmailWithRetry_`. These are **generic "log in to the system" notices**
  (CTA = `getOptionalUrl_('WEB_APP_URL')`, **no token / no `parentID`**), a fallback nudge — **not** the
  primary tokenized PIA workflow emails, and **not** the daily reminder. Don't duplicate email logic.
- **DCS sends exactly one email** (`Phase 1/Code.js`): `notifyDcsRequester_` (~line 1705), the styled
  *"Request submitted — Proceed to Phase 2"* confirmation, fired auto inside `submitDCS` (~1681, try/catch
  failsafe) with a `?parentID=` deep-link into PIA.

---

## 8b. PIA (Phase 2) reference — approval ladder, returns & email links

> Built from reading `Phase 2/pia_code.js`. The PIA approval workflow is **not** obvious from
> the sheets alone; this is the canonical map. (DCS itself has **no** approval gate — it's
> `COMPLETE` on submit; the whole ladder lives in PIA.)

**The approval ladder (top to bottom):**

```
Applicant submits PIA
  └─ STAGE A — Main heads        (Approval_Workflow sheet)
       Step 1: Immediate Head     ← from the applicant's PIA1 answers (per-request, not fixed)
       Step 2: Department Head     ← from PIA1.  Fallback: PRIVACY_OFFICER_EMAIL if neither valid.
  └─ STAGE B — InfoSec / ISM      (ISM_Approval_Workflow sheet)
       InfoSec Member Step 1 (Person 1) → Step 2 (Person 2)   ← from InfoSec_Email_Config (active=YES)
       both must Approve in sequence.  Each can: Approve · Deny · Return · EscalateToDivisionHead.
  └─ STAGE C — Routing            (chosen by the InfoSec reviewer on Approve/Escalate, NOT a gate)
       DCOPS · TECHSERVE · BOTH    ← where the access gets provisioned after final approval.
  └─ STAGE D — Division Head      (DivisionHead_Approval_Workflow sheet) — ONLY if an InfoSec
       member escalates. Not in the normal path.
Final: all InfoSec approve → 'Approved by ISM' → applicant notified, DCS marked COMPLETE,
       routed to DCOPS/TechServe/Both.
```

Key fns: `buildApproversFromAppData` (seeds Stage A), `initializeApprovalWorkflow`,
`apiPhase3_ProcessISMDecision` (Stage B/C/D), `getISMReviewerStep` (1=Person1, 2=Person2).

**Who fills each approver (hybrid by design):** the **fixed, org-wide** roles are
**admin-configured** — InfoSec reviewers + DCOPS/TechServe live in `InfoSec_Email_Config`
(active=YES), and `PRIVACY_OFFICER_EMAIL` is the head fallback. The **per-applicant** roles
(Immediate / Dept / **Division** Head) are **filled by the applicant in PIA1** — because they're
that person's own reporting line, which varies per request and would be unmaintainable as a
central org chart. Integrity risk (naming yourself/a friend) is mitigated, not prevented, by
`analyzeApplicationRisk` (flags drafter-email == head-email, `pia_code.js` ~3602). Future
hardening = source the head chain from an HR directory / Workspace org unit.

**⬆️ Escalation = "up to Division Head, then back down" (NOT a skip-to-final).** When an InfoSec
member picks `EscalateToDivisionHead` (`apiPhase3_ProcessISMDecision` ~7154):
- That ISM row → `EscalatedToDivisionHead`; app status → `Escalated to Division Head`; the ISM
  chain **pauses** (the *next* ISM member is NOT notified yet).
- A **single** Pending `DivisionHead_Approval_Workflow` row is created (dedup guard ~7197 skips
  if one is already Pending — a safety net for simultaneous escalations), and the **Division
  Head named in PIA1** (`divHeadEmail`) is emailed a review link.
- The Division Head decides (`processDivHeadDecision` ~3910):
  - **Approve** → the escalated ISM step is marked `Approved`. If that makes **all** ISM rows
    Approved → **finalize** (certificate + route + DCS Complete). If not (e.g. the other ISM
    member hasn't acted) → **resume the ISM chain at the next step** (`apiPhase3_NotifyISMember`
    ~3999) — i.e. it comes *back down* to the remaining reviewer.
  - **Deny** → app `Denied` (terminal). **Return** → app `Returned` to applicant (+DCS if DCS
    flags) → full restart on resubmit.
- If **both** InfoSec members escalate (only reachable sequentially — Step 2 escalates after a
  DivHead approve resumes the chain to them), the Division Head is reviewed **once per
  escalation** (the prior DivHead row is already resolved, so a fresh Pending one is created).

**🔁 Return = FULL restart, not resume.** A "Return" from **any** approver (head, InfoSec, or
DivHead) always bounces to the **applicant** — never to a previous approver. On resubmit,
`submitApplication` **deletes all** `Approval_Workflow` + `ISM_Approval_Workflow` +
`DivisionHead_Approval_Workflow` rows for that session and **rebuilds the ladder from Stage A,
Step 1 (Immediate Head)**. All prior approvals are wiped; nothing resumes mid-chain. Lineage is
kept via a revision id (`-V2`, `-V3`…) but approval progress resets to zero. (`pia_code.js`
~3790.) ⚠️ **Return ≠ Deny:** Return is a fixable loop; Deny/Reject is terminal. And if the
linked **DCS** is `Returned`, PIA resubmission is **blocked** until the DCS is fixed first
(`pia_code.js` ~3730).

**📧 Email links — how they're built & why they break.** All workflow emails (approver review,
ISM, reminders, applicant status) build their links **at send time** from Script Properties,
then freeze that link into the sent email:
- Approver "Review Access Request" / ISM / approval forms / reminders → **`WEB_APP_URL`** (PIA)
  via `getWebAppUrl()` (falls back to `ScriptApp.getService().getUrl()`).
- Applicant "View DCS Submission" / "Update DCS Request" → **`DCS_WEB_APP_URL`** (PIA) via
  `getDCSWebAppUrl()`.
- Review/approve/deny links carry an **HMAC token** (`generateAuthToken`) bound to the approver
  email + action, with a **14-day TTL** (`isTokenValid`).

Consequences (see §3b for the full URL-property map + golden rule):
- A link is only as valid as the deployment URL in its property **at the moment the email was
  sent**. Updating a property fixes **future** emails only — ones already in inboxes stay dead.
- Test with a **fresh** transaction (re-trigger), and only with **freshly generated** links
  (tokens expire in 14 days).

---

## 9. Session start ritual for this project

State the goal ("Today's task: [the supervisor's specific design change]"), confirm it's
design-only, then locate the exact `render*()` function or CSS block before editing.
Smallest safe change. Preserve all existing behavior.
