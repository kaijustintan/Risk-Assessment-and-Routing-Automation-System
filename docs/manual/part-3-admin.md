# Part 3 — Admin (Phase 3, ISM Control Tower)

> The ISM dashboard — oversight, analytics, certificate routing, email failover, settings.
> Shared concepts live in **[Part 0 — Common Reference](part-0-common.md)**; this file covers
> only Admin specifics. **Access is restricted to INFOSEC-001 / INFOSEC-002**
> ([§0.6](part-0-common.md#06--security-model)).
>
> Source files: `Admin/adminView.html` (frontend), `Admin/admin_code.js` (backend),
> `Admin/*_appsscript.json` (manifest).

---

## §3.1 — End-user guide 🧑 (for ISM admins)

### Accessing the system
Open the Admin web-app URL signed in with an authorized account. Two-step gate:
**Layer 1** = corporate domain check; **Layer 2** = `checkAccess_` allows **only**
`INFOSEC-001`/`INFOSEC-002` (matched against `InfoSec_Email_Config`). Anyone else sees
"Access Denied." *(The old manual's "INFOSEC member **or** domain match" fallback was removed
during this session's hardening — it is now a strict INFOSEC allowlist;
[§0.6](part-0-common.md#06--security-model).)*

### The interface
- **Sidebar:** Dashboard · Analytics · Certificate Routing · Email Failover · Settings (with a
  collapse toggle).
- **Header:** breadcrumb + a connection status badge (green dot = connected).
- **Main content:** the active page.

### Dashboard
The default page. **Stats cards** (Total Entries, PIA Complete, Pending Approval, Denied), a
**search bar** (name / location / dept / DCS ID / email), an expandable **filter panel** (PIA
status, email-approval status, date range, DCS status, location) with removable filter chips,
and the **admin table** — DCS entries joined with PIA status and email-approval status.

Table columns: Select · Name · Location · Dept · Access Type · DCS (LogID) · DCS Status ·
PIA (X/5 submitted) · PIA Status · Email Approval · Date · Actions (View Details, Audit Logs,
Delete). Click any header to sort (toggles asc/desc).

### Viewing entry details
Open the detail modal to see DCS data (from `Metadata_JSON` / `Metadata_Agency`) and PIA
sections: **PIA 1** Program Info · **PIA 2** PII Inventory (risk meter, threshold 18) ·
**PIA 3** Stakeholders · **PIA 4** Data Lifecycle · **PIA 5** Compliance Survey · plus any
**Approver Flags**.

### Audit logs
The clipboard icon opens a modal with four tabs: **Risk Audit** (CREATE/UPDATE/DELETE/
APPROVE/REJECT events), **Approval Workflow**, **ISM Approvals**, **DivHead Approvals**.

### Deleting entries
> Deletion removes in-progress, pending, **or** complete entries. Use it only for bug cleanup
> / system maintenance.
- **Single delete:** trash icon → confirm (you may optionally notify the requestor). Removes
  the row from `Data_Collection`, `Applications`, and all three workflow sheets, and logs a
  `DELETE_ENTRY` to `Risk_Audit`.
- **Batch delete:** select rows → **Delete Selected**. Only rows with PIA status **Complete**
  are deleted; others are skipped.

### Export to Google Sheets
Select rows → **Export Selected**. A new Google Sheet (base + DCS + PIA columns) is created in
the **same Drive folder** as the source spreadsheet and opens in a new tab.

### Analytics
Four cards: **PIA Status Breakdown**, **Approval Status Distribution**, **Top Departments**
(bar charts), and **Key Metrics** (Total / Flagged / Completion Rate / Pending Review).

### Certificate routing
Lists ISM-approved applications. Pick one (status contains "Approved" and ISM-approved) →
**Route** → choose destination (**DCOPS / TechServe / Both**) → **Submit Routing** to
regenerate the certificate and send the email. You can also **Download Certificate**.

### Email failover
Entries whose emails failed to send (execution bugs) appear here to **resend** to the rightful
requestor / approver. These are **manual resend** of generic "log in to the system" notices —
**not** the primary tokenized PIA workflow emails and **not** the daily reminder
([§2.2](part-2-pia.md#22--maintenance-)). Backend: `adminResendEmail` re-fires
`notifyApprover` / `notifyApplicant` / `apiPhase3_NotifyISMember` via `sendEmailWithRetry_`.

### Settings
Two cards: **System Configuration** (key-value pairs, editable inline) and **InfoSec Email
Config** (ISM members: Member ID, Name, Email, Role, Active). **Save Changes** persists to the
spreadsheet. Reminder on/off + hour here call **PIA's** cross-app reminder API
([§2.2](part-2-pia.md#the-daily-reminder-engine-lives-here-)).

> ⚠️ **No stray spaces in link values.** When you set a downloadable's URL — in a **System Links**
> field here **or** directly in a `System_Configuration` cell — the value must be the **clean URL
> only**, with **no leading/trailing whitespace** (`https://…`, never `␣https://…`). A stray space
> makes the link invalid: the **Download** button in the DCS app won't open the file, and the value
> can fail to display/save correctly in this Settings form. Editing through this form **auto-trims**
> on Save; pasting straight into the sheet does **not** — so sheet edits are the ones to double-check.

---

## §3.2 — Maintenance 🛠

### Script Properties (Admin project)
*(Deploy via the golden rule — [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls).)*

| Property | Required | Holds |
|----------|----------|-------|
| `SPREADSHEET_ID` | Yes | ID of the shared database spreadsheet |
| `ALLOWED_DOMAIN` | Yes (when domain check on) | Corporate domain |
| `ADMIN_API_KEY` | Yes | Shared email-tracking key — **must match the PIA side** |
| `WEB_APP_URL` | Optional | Live **PIA** `/exec` for resend CTAs (missing → button omitted gracefully) |
| `SHEET_PREFIX` | Optional | Prefix if sheet tabs are namespaced |

**Code constants** (`admin_code.js`): `ENABLED_DOMAIN_CHECK = true` (line ~145 — gate is
**on**), `MAX_ROWS = 500` (cap on `getAdminData`), `SHEET_NAMES` (canonical tab names, ~line
124 — the source of truth used in [§0.2](part-0-common.md#02--architecture--data-model)).

**OAuth scopes:** `spreadsheets`, `drive`, `script.external_request`, `userinfo.email`.
**Web-app settings:** `executeAs = USER_DEPLOYING`, `access = DOMAIN`, `runtimeVersion = V8`.

### Routine tasks
- Update `InfoSec_Email_Config` when ISM members change; update `System_Configuration` for
  system-wide settings.
- Archive old `Risk_Audit` entries if the sheet grows large.
- Review/clean old deployments (but **keep one** — golden rule); check Executions for errors;
  verify spreadsheet cell limits.
- After a Workspace/domain change: update `DOMAIN` / `ALLOWED_DOMAIN`; if the spreadsheet
  moves, update `SPREADSHEET_ID`; if sheets are added, update `SHEET_NAMES`.

### Adding a new downloadable form (Admin side)
A download form touches **both** apps; the DCS-side change and the full end-to-end flow are in
**[Part 1 §1.2](part-1-dcs.md#12--maintenance-)**. On the **Admin** side, so ISM can manage the
link under **Settings → System Links**, edit `Admin/adminView.html`:
1. Add an input field to the **System Links** card (~line 2073), copying the existing pattern —
   `<div class="form-group"><label>Your Label</label><input type="url" id="cfg-LINK_YOURKEY_TEMPLATE" placeholder="https://..."></div>`.
2. Add the **same key** (`LINK_YOURKEY_TEMPLATE`) to the key array inside `saveSettings()`
   (~line 6726). ⚠️ Without this, the field will *display* a value but silently **won't save** edits.
3. Redeploy the Admin project (Edit → New version —
   [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).

---

## §3.3 — Developer handover 👨‍💻

### Backend (`admin_code.js`)
- **Entry points:** `doGet()` (auth + serve `adminView`; handles `?setup=domain`),
  `doPost()` (`action=submitDCS` — currently a domain-validating **stub**, not the real DCS
  submission, which lives in Phase 1).
- **Authorization:** `isAuthorizedDomain()` (Layer 1 domain suffix, fail-secure),
  `checkAccess_()` (Layer 2 — **strict INFOSEC-001/002 allowlist**). 17 `checkAccess_` guards
  were added across API entry points this session ([§0.6](part-0-common.md#06--security-model)).
- **Data fetching:** `getAdminData()` reads 5 sheets, builds lookup maps (by ReqID and
  SessionID), joins rows, serializes all values to strings (avoids V8 serialization crashes),
  capped at `MAX_ROWS = 500`.
- **Audit:** `getAuditLogs(reqId, sessionId)`.
- **Delete:** `deleteEntry(reqId, logId, sessionId)` — cascading delete + `Risk_Audit` log.
- **Export:** `exportToSheet(rows)` — new Sheet in the source folder.
- **Config:** `getConfigData()` / `saveConfigData()`.
- **Certificate routing:** `apiAdmin_*` functions (approved-app listing, cert HTML/PDF, email).
- **Email resend:** `adminResendEmail` ([§3.1](#31--end-user-guide--for-ism-admins)).
- **Helpers/diagnostics:** `sheetToObjects_()`, `computePiaStatus_()`,
  `computeApprovalStatus_()`, `parseMetadata_()`, `debugSheets()`, `getAdminDataDebug()`,
  `ping()`.

### Frontend (`adminView.html`)
Single HTML file (markup + CSS + inline SVG icons + JS), navy DM-Sans design system,
responsive with sidebar collapse. Key fns: `loadData()`, `renderTable()`, `filterRows()`,
`sortTable()`, `openDetailModal()`, `showAuditLogs()`, `deleteEntry()`, `deleteSelected()`,
`exportSelected()`, `showAnalytics()`, `loadApprovedApplications()`, `checkRoutingStatus()`,
`loadConfigData()`, `saveConfigData()`.

### Data flow
Open URL → `doGet` (optional `?setup=domain`) → `isAuthorizedDomain` (Layer 1) →
`checkAccess_` (Layer 2, INFOSEC) → serve `adminView` → frontend calls `getAdminData()` →
backend reads 5 sheets, joins DCS↔Applications (via `Linked_ReqID`/`ReqID`) and workflows (via
`SessionID`), returns string-only objects → table/stats render → user actions trigger more
`google.script.run` calls.

### Key design notes
Single HTML file (no build step); in-memory joins from raw sheet data; `sheetToObjects`
pattern (header row → keyed objects); all row values serialized to strings (prevents V8
crashes from Date/nested objects); two-layer auth; `MAX_ROWS = 500` to stay under execution
limits; export placed in the source folder.

---

## §3.4 — Troubleshooting

### For end users (ISM admins)
| Problem | Solution |
|---------|----------|
| "Access Denied" | Must be `INFOSEC-001`/`INFOSEC-002` with a matching `Member_Email` in `InfoSec_Email_Config`. |
| Blank page / spinning loader | Refresh; if it persists the spreadsheet may be inaccessible — contact the admin. |
| "No data available" | Spreadsheet may be empty or still loading; refresh. |
| Search returns nothing | Broaden the term; clear active filters. |
| Can't delete an entry (batch) | Batch delete only removes PIA-status "Complete" rows. |
| "Export failed" | Could not create the new Sheet — check Drive permissions. |
| Stale data after refresh | Hard refresh (Ctrl/Cmd+Shift+R) — cache may be stale. |
| A downloadable won't open (DCS), or a Settings link field looks blank | The stored link value likely has a **leading/trailing space**. Open the Settings field (or the `System_Configuration` cell) and delete any whitespace around the URL, then Save. |

### For administrators / developers
| Problem | Solution |
|---------|----------|
| `clasp push` fails | *(We don't ship via clasp — see [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls).)* Use the manual copy-paste + Edit→New version flow. |
| Changes don't appear | You likely created a **New deployment** instead of a new version — golden rule, [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls). |
| `getAdminData` returns null | V8 unhandled exception — check Executions/Stackdriver; verify sheet names + headers. |
| "Sheet not found" | Run `debugSheets()`; fix `SHEET_NAMES` or `SHEET_PREFIX`. |
| `SPREADSHEET_ID` not set | Set it in Script Properties. |
| Domain blocks all users | Verify `DOMAIN`/`ALLOWED_DOMAIN`; `?setup=<domain>` reconfigures both. |
| INFOSEC member still denied | Verify their email matches `Member_Email` and `Member_ID` is INFOSEC-001/002. |
| Stats all zero | Run `getAdminDataDebug()` to verify each sheet is readable. |

---

*← [Part 2 — PIA](part-2-pia.md) · Next: [Appendices](appendices.md) →*
