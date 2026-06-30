# 02 · RARS System Overview & Architecture

> The cross-app source of truth. Verbatim deep-dive lives in
> `reference-docs/docs/manual/part-0-common.md`. This file is the portable synthesis.

---

## 1. What RARS is

**RARS = Risk Assessment & Routing System** — Megaworld's online pipeline for **requesting access
to company data** (including personal data protected under the Philippine Data Privacy Act, RA
10173). Three **independent Google Apps Script (GAS) web apps** act as one flow:

- **Phase 1 — DCS (Data Collection System):** the request form. Apply, attach the required
  agreements (NDA / DPA / DSA / Confidentiality Undertaking / Endorsement Letter), submit.
- **Phase 2 — PIA (Privacy Impact Assessment):** the privacy questionnaire you fill after a DCS is
  cleared ("Proceed to Phase 2"), **plus the entire multi-level approval workflow.**
- **Phase 3 — Admin:** the ISM control tower — dashboard, settings (download links, reminder
  config), email resend, oversight. Restricted to INFOSEC-001/002.

> ⚠️ Naming note: the DCS frontend was **rebranded in the UI to "Privacy Impact Assessment"** (title,
> landing, guide, footer "Megaworld Corporation") in a June 15 session. Internally/architecturally
> it's still "DCS / Phase 1." Don't let the UI label confuse the architecture.

## 2. The one hard architecture rule

The three apps are **separate GAS projects** (separate `appsscript.json`, separate deployment,
separate `/exec` URL). **They never call each other directly.** They coordinate **only through one
shared Google Spreadsheet** (the database).

```
   Phase 1 DCS            Phase 2 PIA              Phase 3 Admin
   ┌─────────────┐        ┌─────────────┐         ┌─────────────┐
   │ index.html  │        │ pia_index   │         │ adminView   │  ← frontends (HTML)
   │ Code.js     │        │ pia_code.js │         │ admin_code  │  ← backends (doGet, email, DB)
   └──────┬──────┘        └──────┬──────┘         └──────┬──────┘
          └───────────── ONE shared Google Spreadsheet ──┘   ← the ONLY integration point
```

- DCS hands off to PIA via the `PIA_APP_URL` Script Property (a `?parentID=<DCS ReqID>` deep-link).
- PIA reads the DCS row via `parentID` / `Linked_ReqID`, writes `Applications` + the
  `*_Approval_Workflow` sheets.
- Admin reads/writes everything.
- **Owner of all 3 GAS projects:** `ismaiapps@megaworldcorp.com`.
- **Kai's workflow:** code on personal laptop → push to GitHub → on the work laptop, **manually
  copy-paste** each edited file into the matching GAS project and redeploy. No `clasp`, no automation.

**Enforce these (cross-app contract):** never rename/repurpose shared sheet columns, the
`parentID`/`Linked_ReqID` link, or the stored URLs (`PIA_APP_URL`, `DCS_WEB_APP_URL`,
`WEB_APP_URL`). A change in one phase can silently break another that reads the same sheet.

## 3. The database (one Google Spreadsheet, id in Script Property `DB_ID`)

Reconciled schema (verified against `SHEET_NAMES` in `admin_code.js`). The system uses **~9 sheets**:

| Sheet | Holds |
|-------|-------|
| `Data_Collection` | One row per DCS request. Cols incl: LogID, ReqID, UserEmail, **Status**, ImmHead/DeptHead/DivHead emails, FileID, MetadataJSON, Timestamp, MetadataAgency. |
| `Drafts` | Auto-saved JSON, 7-day TTL, **shared between DCS and PIA**. Cols: DraftID, UserEmail, SessionID, Type, StateJSON, SavedAt, ExpiresAt. |
| `Risk_Audit` | Full action log + automatic risk flags. |
| `Applications` | One row per PIA application (the PIA1 answers live here, e.g. `PIA_1_DATA`). |
| `Approval_Workflow` | Stage A — main heads (Immediate Head, Dept Head) per-approver decisions. |
| `ISM_Approval_Workflow` | Stage B — the two InfoSec/ISM reviewer decisions + routing destination. |
| `DivisionHead_Approval_Workflow` | Stage D — Division Head decision (only if escalated). |
| `System_Configuration` | Key/value settings: template download links + other config. |
| `Email_Queue` | Queued PIA emails (sent by a time-trigger). |
| `InfoSec_Email_Config` | Admin-managed: the InfoSec reviewers + DCOPS/TechServe destination emails (active=YES). |

**Stored DCS status values** (`Data_Collection.Status`): `PENDING`, `READY_FOR_PIA`, `COMPLETE`,
`REJECTED`, `RETURNED`. ⚠️ The richer badges in the UI ("Pending Immediate Head", "Escalated",
"PIA Heads Approved — Awaiting ISM", etc.) are **computed in the frontend** from the workflow
sheets — they are NOT stored strings. Don't assume a badge maps 1:1 to a column.

> The real DB schema export is `DPS_DB*.xlsx` — **gitignored (contains real `@megaworldcorp.com`
> PII)**. Read-only reference; **never attach it to any web upload.**

## 4. Secrets (Script Properties — never in code)

| Property | In project | Holds |
|----------|-----------|-------|
| `DB_ID` | all | the shared Spreadsheet id |
| `ADMIN_FOLDER_ID` | DCS | Drive folder for uploaded files |
| `DOMAIN` | all | the allowed email domain (`megaworldcorp.com`) |
| `PIA_APP_URL` | DCS | live PIA `/exec` (the "Proceed to Phase 2" target) |
| `DCS_WEB_APP_URL` | DCS **and** PIA | live DCS `/exec` (PIA's copy feeds "View DCS Submission") |
| `WEB_APP_URL` | PIA, Admin | live PIA `/exec` (approver/ISM/reminder links) |
| `SYSTEM_SECRET` | **PIA** | the HMAC token-signing secret (read by `getSystemSecret()`) |

> ⚠️ The token-signing secret is **`SYSTEM_SECRET` in the PIA project** — NOT "`HMAC_SECRET`"
> (that name in old docs/comments is a **misnomer**; DCS does not functionally read it). When
> auditing token security, check `SYSTEM_SECRET` in PIA.

## 5. File map (by phase)

| Path | Role |
|------|------|
| `Phase 1/index.html` | DCS frontend — CSS, 9 screens, client JS, validation (~6,400 lines) |
| `Phase 1/Code.js` | DCS backend (~2,670 lines) — `doGet`, drafts, `submitDCS`, risk audit; one email `notifyDcsRequester_` |
| `Phase 2/pia_index.html` | PIA frontend — multi-section assessment wizard |
| `Phase 2/pia_code.js` | PIA backend (~9,000 lines) — approval workflow, ISM, **all PIA email** |
| `Admin/adminView.html` | Admin frontend — dashboard, settings, email routing |
| `Admin/admin_code.js` | Admin backend — config, manual email resend, `MailApp` senders |
| `*/*_appsscript.json` | Per-phase GAS manifest (Asia/Manila, scopes, DOMAIN access) |
| `docs/` | Specs, manual, security docs, T&C, test guide, V2-vs-V1 |
| `DPS_DB*.xlsx` | Real DB export — **gitignored (PII)**, read-only |

## 6. Server API contract (DCS — what each `google.script.run` call returns)

`apiGetSystemConfig` → `{success, config:{DOMAIN, LINK_*_TEMPLATE, ...}}` · `apiGenerateNewSessionId`
· `apiSaveDraft(sessionId, stateData)` · `apiRestoreDraft` / `apiListUserDrafts` / `apiDeleteDraft`
· `submitDCS(payload, sessionId)` → `{success, reqId, phase2Url?}` · `apiListUserRequests` ·
`apiGetRequestData(reqId)` (form data + approvers + timelines) · `apiGetReturnedApplication(reqId)`.

> ⚠️ Critical GAS security fact: **every global function is directly callable from the browser via
> `google.script.run`,** bypassing `doGet`/`doPost` gates. This is the root of the security findings
> (see `07-security-hardening.md`) — server functions must re-check the caller's identity, not trust
> arguments.
