# Part 2 — PIA (Phase 2, Privacy Impact Assessment)

> The privacy questionnaire and the **entire approval ladder**. Shared concepts
> (architecture, schema, deployment, security, glossary, the ladder itself) live in
> **[Part 0 — Common Reference](part-0-common.md)** — this file covers only PIA specifics.
>
> Source files: `Phase 2/pia_index.html` (frontend), `Phase 2/pia_code.js` (backend,
> ~9,000 lines), `Phase 2/*_appsscript.json` (manifest).

---

## §2.1 — End-user guide 🧑

### Accessing the system
PIA is reached through a **DCS link that carries a `parentID`** (the DCS Request ID):
`…/exec?parentID=<ReqID>`. Sign in with your corporate account; the system verifies the DCS
link and confirms your identity automatically. A bare URL without `parentID` won't run the
full flow ([§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).

### Starting an application
After DCS-link verification: **Continue to Instructions** → read the compliance agreement →
tick **"I have read and understood"** → **Proceed to Survey**.

### The 7-step form
A sidebar progress tracker follows you through:

| Step | Section | What you do |
|------|---------|-------------|
| 1 | Instructions & Compliance | Read guidelines, consent, proceed |
| 2 | Privacy Compliance Checklist (PIA 5) | 8 questions answered YES / NO / N/A |
| 3 | Program Information (PIA 1) | Program details; many fields **auto-populated read-only from DCS** (department, drafter, head names/emails); you add phone numbers, description, purpose, benefits, scope, end-user |
| 4 | PII Inventory (PIA 2) | For 21 PII types pick YES/NO — **≥3 YES required**; "Others" needs a custom entry |
| 5 | Stakeholders (PIA 3) | Up to 5 internal + 5 external, optional emails/descriptions |
| 6 | Information Flow (PIA 4) | Describe Collect / Use / Retain / Disclose / Dispose |
| 7 | Review Summary | Review all answers + the DCS Request Details card; flagged fields (from a prior revision) show red flag icons; **Confirm & Submit** |

### After submission
You get a confirmation with your **Application ID** (`PIA-XXXXXX`) and an email. The
application then climbs the ladder — Immediate Head → Department Head → ISM Members → (optional
Division Head). You receive email updates at each stage (progressing / returned / denied /
fully approved). Full ladder mechanics:
[§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline).

### Tracking
Track via your email inbox — each status email has a **"View DCS Submission"** or **"Review &
Update PIA"** button. Auto-save runs as you fill the form ("Saved" indicator, bottom-right);
you can close and resume later via the **same DCS link**.

### Revising a returned application
1. Check your email for approver feedback and flagged fields (red flag icons).
2. Click **Review & Update PIA** → the system loads your submission in **Revision Mode**.
3. Update flagged + any other fields; review and resubmit.
4. 🚩 **If DCS fields were flagged, you must fix the DCS request first** — then use the new
   DCS link to revise the PIA. (Return = full restart — see
   [§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline).)

### PIA status indicators
| Status | Meaning |
|--------|---------|
| Pending | Awaiting the first approver's decision |
| Approved | Current approver approved |
| Approved (ISM Pending) | Heads approved; ISM review pending |
| Approved by ISM | All ISM approved; routing to the implementation team |
| Returned | Sent back to requestor for revision |
| Denied / Rejected by ISM | Permanently rejected (locked for audit) |
| Escalated to Division Head | An ISM member escalated; Division Head reviewing |

---

## §2.2 — Maintenance 🛠

### Script Properties (PIA project)
*(Deploy via the golden rule — [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls). Never "New deployment.")*

| Property | Required | Holds |
|----------|----------|-------|
| `WEB_APP_URL` | Yes | Live **PIA** `/exec` (approver review, ISM/approval forms, reminders) |
| `DCS_WEB_APP_URL` | Yes | Live **DCS** `/exec` (applicant "View DCS Submission" link) |
| `SYSTEM_SECRET` | Yes | HMAC token signing secret (64+ char random) — **the real signing secret for all of RARS** ([§0.6](part-0-common.md#06--security-model)) |
| `PIA_DB_SPREADSHEET_ID` | Auto-set | Database spreadsheet ID |
| `ALLOWED_DOMAIN` | Yes | Corporate domain (e.g. `megaworldcorp.com`) |
| `ADMIN_API_KEY` | Yes | Shared key for Admin email-tracking; must match the Admin side |

**Selected code constants** (`pia_code.js`): `ENABLE_DOMAIN_CHECK = true` (line ~185 — domain
gate is **on**), `TOKEN_VALIDITY_MS = 14 days`, `MAX_USER_DRAFTS = 5`, `DRAFT_EXPIRY_DAYS =
7`, `RISK_FLAG_THRESHOLD = 18` (PII count), comment length min/max constants,
`LOCK_TIMEOUT_MS = 30000`.

### The daily reminder engine lives HERE 🚩
The approval **reminder engine is in PIA, not Admin.** `sendDailyReminders()` /
`buildReminderEmail()` / `setupReminderTrigger()` (~`pia_code.js:4671`) run on a daily
`ScriptApp` time-trigger **inside the PIA project** (`atHour().everyDays(1)`, needs the
`script.scriptapp` scope). It scans the 3 workflow sheets for `Pending` rows and emails
**only the next pending approver per request**, stamping `ReminderDate` so each is nagged
**once per day** until they act. Reminder emails carry a valid tokenized review link
(`WEB_APP_URL`).

> The **Admin panel only *configures*** this (on/off + hour) by calling PIA's cross-app API
> (`getReminderConfig` / `setReminderConfig`, dispatched in PIA `doPost`). See
> [§3.1](part-3-admin.md#31--end-user-guide-) / [Part 0 §0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls).

### InfoSec / routing config
The two ISM reviewers and the DCOPS/TechServe routing emails come from the
`InfoSec_Email_Config` sheet (rows with `IsActive = YES`). The ISM workflow requires **exactly
2 active InfoSec members.** `PRIVACY_OFFICER_EMAIL` is the head fallback when a PIA1 head email
is invalid.

### Recovery / utility functions (run from the GAS editor)
- `apiPhase3_RetryISMWorkflow(sessionId)` — for an app stuck in "Approved (ISM Pending)".
- `testPhase3DatabaseInitialization()` — if the ISM workflow sheets are missing.
- `reinitializePhase3Database()` — to reset the Phase-3 schema.
- `cleanupExpiredDrafts()` — purge drafts older than 7 days.
- `seedSessionCounterFromDatabase()` — re-sync the session counter if duplicate IDs appear.

---

## §2.3 — Developer handover 👨‍💻

### Frontend (`pia_index.html`)
Single HTML SPA, vanilla JS, navy DM-Sans design tokens. Global `state` object holds all PIA
sections; `show()` toggles `screen-*` divs; `renderSidebarTracker()` draws progress.
Validation via `validatePIA1`, `syncPIA*State` functions. Submit flow:
`submitApplication()` → `submitToBackend()` → `google.script.run.apiSubmitApplication()`.
Drafts via debounced `apiSaveDraft()`. The DCS-link screen (`renderDCSCheck`) calls
`apiGetDCSContext` for identity verification.

### Backend (`pia_code.js`, ~9,000 lines) — module map
- **Entry points:** `doGet()`, `doPost()` (route to SPA or email-action handler)
- **Security:** `generateAuthToken()`, `isTokenValid()`, `getNormalizedEmail()`,
  `sanitizeInput()`, `escapeHtml()`, `validateApplicationData()`, `isValidEmail()`,
  `getSystemSecret()`
- **Database:** `initializeDatabase()`, `getDatabaseSpreadsheet()`, `getDatabaseSheet()`
- **Session IDs:** `nextBaseSessionId()`, `getNextRevisionSessionId()`, `formatSessionId()`
- **Application lifecycle:** `submitApplication()`, `apiSubmitApplication()`,
  `getApplicationData()`, `getUserSubmissions()`, `buildApproversFromAppData()`
- **Approval workflow (Stage A/D):** `initializeApprovalWorkflow()`,
  `processApprovalDecision()`, `processDivHeadDecision()`, `checkAllApproved()`
- **ISM Phase 3 (Stage B/C):** `apiPhase3_InitializeISMWorkflow()`,
  `apiPhase3_ProcessISMDecision()`, `apiPhase3_NotifyISMember()`,
  `apiPhase3_RouteApprovedRequest()`, `getISMReviewerStep()`, `apiPhase3_RetryISMWorkflow()`
- **Email:** `notifyApprover()`, `notifyApplicant()`, `sendEmailWithRetry()`,
  `getWebAppUrl()`, `getDCSWebAppUrl()`; reminders `sendDailyReminders()` /
  `buildReminderEmail()`
- **Audit:** `logAuditTrail()`, `analyzeApplicationRisk()`
- **DCS bridge:** `apiGetDCSContext()`, `getAndShareDCSFiles()`, `updateDCSStatus()`
- **Drafts:** `apiSaveDraft()`, `apiRestoreDraft()`, `apiDeleteDraft()`, `cleanupExpiredDrafts()`

### Data flow (condensed)
`parentID` link → `doGet` renders SPA → `apiGetDCSContext` verifies & pre-fills →
7-step form (auto-saved) → `apiSubmitApplication` writes `Applications` →
`initializeApprovalWorkflow` → `notifyApprover` (HMAC link) →
`processApprovalDecision` (next approver or done) → ISM init + `apiPhase3_NotifyISMember` →
`apiPhase3_ProcessISMDecision` (Approve/Return/Deny/Escalate) → on full approval,
`apiPhase3_RouteApprovedRequest` generates the Certificate PDF and emails the destination
team; `notifyApplicant` updates the applicant throughout.

### Key design notes
Single `Code.gs` file (GAS has no ES modules); serialized JSON columns for PIA data (flexible
schema); HMAC tokens (no server session needed); debounced auto-save (quota friendly);
sequential two-person ISM review (no single member can unilaterally approve); script locks on
concurrent ops; `Risk_Audit` reserved for **anomalous** events only (normal actions are
`Logger.log`-ged — *not* the "Paranormal" wording from the old manual).

---

## §2.4 — Troubleshooting

### For end users
| Problem | Solution |
|---------|----------|
| "Strictly Access Denied" | Sign in with your corporate account (incognito helps). |
| "Invalid Access" / "Link Required" | You must enter PIA via a valid DCS link with `?parentID=`. |
| "Could not verify context" | The DCS Request ID is invalid/doesn't exist — verify the URL and that the DCS request was submitted. |
| "Not authorized to access this context" | The DCS request belongs to another user; you can only access your own. |
| Data not saving | Wait for the "Saved" indicator; if "Save failed", refresh to restore the last saved state. |
| Can't pass PII Inventory | Need ≥3 YES, and every standard PII field set to YES/NO. |
| "Returned" + DCS was flagged | Fix the DCS request first, then use the new DCS link to revise the PIA. |
| Stuck in "Pending" | The approver may not have seen the email — contact them to check. |
| Email not received | Check spam; confirm the correct corporate inbox. |

### For administrators
| Problem | Solution |
|---------|----------|
| "SYSTEM_SECRET not configured" | Add `SYSTEM_SECRET` (64+ char random) in Script Properties. |
| "WEB_APP_URL not configured" | Set `WEB_APP_URL` to the current PIA deployment ([§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)). |
| ISM workflow not starting | Ensure `InfoSec_Email_Config` has ≥2 active members, then run `apiPhase3_RetryISMWorkflow(sessionId)`. |
| Email quota exceeded | `sendEmailWithRetry` retries with backoff; check the Gmail/Workspace daily limit. |
| Approval link "Access Denied" | Token expired (14-day TTL) or email mismatch — generate fresh links by having the requestor resubmit ([§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)). |
| Drafts accumulating | Run `cleanupExpiredDrafts()`; consider a weekly trigger. |
| Page blank / parse error | Suspect GAS template-literal serve corruption ([§0.5](part-0-common.md#05--known-gotchas--debugging)). |

---

*← [Part 1 — DCS](part-1-dcs.md) · Next: [Part 3 — Admin](part-3-admin.md) →*
