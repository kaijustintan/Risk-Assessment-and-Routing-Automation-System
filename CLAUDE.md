# CLAUDE.md — Megaworld DCS (Data Collection System)

> Project-specific instructions for this repo. My global preferences (tone, doc style,
> Q&A teaching format, git rules) load separately from `~/.claude/CLAUDE.md` — this file
> only adds facts that are true *here*.

---

## 1. What this project is (Layman → Technical)

**LAYMAN (Tropang Ex):** DCS is Megaworld's online "request-and-approval" portal for
data/system access. An employee fills a form, attaches legal docs (NDA/DPA/DSA), and the
request climbs an approval ladder (Immediate Head → Dept Head → maybe Division Head → ISM)
until it's "Fully Certified." This repo is the **face** of that portal — the screens and
styling the user sees. Phase 2 of the whole process is a *separate* app called **PIA**
(Privacy Impact Assessment) that DCS links out to.

**TECHNICAL:** A single-page **Google Apps Script (GAS)** web app. The entire UI — CSS,
all 9 screens, client-side state, and validation — lives in one file: `index.html`
(~4,900 lines). Data persistence (Sheets/Drive), email (Gmail), and the `doGet()` entry
point live **server-side in the GAS cloud project**, NOT in this folder.

---

## 2. 🚨 CRITICAL architecture fact — read before editing

**`Code.js` (the GAS backend, `Code.gs` in the cloud) is mirrored here for REFERENCE ONLY.
We edit the frontend (`index.html`); the backend's live source of truth is the cloud.**

```
   THIS REPO                                  THEIR GAS CLOUD (live, source of truth)
   ┌──────────────────────────┐  google.     ┌──────────────────────────────┐
   │ index.html  ← WE EDIT THIS│  script.run  │ Code.gs  • doGet() serves HTML│
   │   • CSS / design tokens  │  .apiXXX()   │          • apiSaveDraft, etc. │
   │   • 9 render() screens    │ ───────────▶ │          • Sheets / Drive R/W │
   │   • client state + valid. │ ◀─────────── │          • Gmail notifications│
   │ appsscript.json (manifest)│   JSON       │  Google Sheets = the database │
   │ Code.js  ← REFERENCE COPY │              │  Drive folder = file vault    │
   └──────────────────────────┘              └──────────────────────────────┘
```

**Implications — enforce these:**
- ✅ **Design/UI changes are safe and local.** CSS, layout, copy, render functions, client
  validation — all live in `index.html`. This is the supervisor's scope.
- 📖 **`Code.js` is a read-only reference mirror** of the cloud `Code.gs`. Use it to learn
  exactly what shape each `apiXXX()` returns (see §6). **Do NOT change `Code.js` as part of
  design work, and do NOT treat editing it as "shipping a backend change"** — we don't
  deploy the backend (see §3).
- ⛔ **Never invent, rename, or change the signature of an `api*` function** in either file.
  If a design change needs *new* server data the backend doesn't already return, STOP and
  flag it — that's a backend edit, done by the team that owns the cloud project, not us.

---

## 3. Our workflow & responsibility boundary

- **What we do:** make design/UI adjustments to `index.html` here in VS Code.
- **How it ships:** Kai **manually copy-pastes** the edited `index.html` into Megaworld's
  live GAS editor (`appsscript`). The live system is preconfigured (domain-locked to
  megaworld) and mid-migration, so this is deliberate and manual.
- **NOT our responsibility:** deployment, `clasp push/pull`, domain config, migration. Do
  not add deploy scripts, do not suggest `clasp`, do not touch `appsscript.json` unless a
  design change genuinely requires a new OAuth scope (it almost never will).
- **Git:** normal commits in this repo (reminder-only per global rules). Pushing to the
  live system is a separate manual copy-paste, unrelated to git.

---

## 4. File map

| File | Role | Touch it? |
|------|------|-----------|
| `index.html` | **Everything frontend** — CSS, 9 screens, client JS, validation | ✅ Yes — this is the work |
| `Code.js` | Reference mirror of the cloud `Code.gs` backend (~2,670 lines) | 📖 Read to understand contracts; ⛔ don't edit for design work |
| `appsscript.json` | GAS manifest (timezone Asia/Manila, scopes, domain access) | ⚠️ Rarely — only for a new scope |
| `CLAUDE.md` | This file | Update when facts change |

---

## 5. The 9 screens (all in `index.html`, swapped by `show(name)`)

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

---

## 9. Session start ritual for this project

State the goal ("Today's task: [the supervisor's specific design change]"), confirm it's
design-only, then locate the exact `render*()` function or CSS block before editing.
Smallest safe change. Preserve all existing behavior.
