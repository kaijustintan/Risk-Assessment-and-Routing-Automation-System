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
  and write the shared DB. When a task genuinely needs one (e.g. the approval reminder),
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

## 4. File map (by phase)

| Path | Role | Touch it? |
|------|------|-----------|
| `Phase 1/index.html` | **DCS frontend** — CSS, 9 screens, client JS, validation | ✅ main work |
| `Phase 1/Code.js` | DCS backend (~2,670 lines) — `doGet`, drafts, `submitDCS`, risk audit. **No email code.** | ⚠️ careful |
| `Phase 2/pia_index.html` | PIA frontend — multi-section assessment wizard | ⚠️ as needed |
| `Phase 2/pia_code.js` | PIA backend (~9,000 lines) — approval workflow, ISM, **all email** (`notifyApplicant`) | ⚠️ careful |
| `Admin/adminView.html` | Admin frontend — dashboard, settings, email routing | ⚠️ as needed |
| `Admin/admin_code.js` | Admin backend — config, approval reminders, `MailApp` senders | ⚠️ careful |
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
`HMAC_SECRET`, `PIA_APP_URL`, `DOMAIN`.

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
- **Approval reminders** (Phase 3): `adminApi_sendDailyReminders()` in `Admin/admin_code.js`
  nudges the *current pending approver* daily (DCS Immediate Head + PIA head/ISM/DivHead
  chains), driven by a `ScriptApp` time-based trigger at `REMINDER_HOUR`. Configure via Admin
  → Settings (needs the `script.scriptapp` scope + re-auth). It reuses `notifyApprover` /
  `apiPhase3_NotifyISMember` / `sendEmailWithRetry_` — don't duplicate email logic.

---

## 9. Session start ritual for this project

State the goal ("Today's task: [the supervisor's specific design change]"), confirm it's
design-only, then locate the exact `render*()` function or CSS block before editing.
Smallest safe change. Preserve all existing behavior.
