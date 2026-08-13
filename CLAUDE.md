# CLAUDE.md: Megaworld RARS (DCS / PIA / Admin)

> Project-specific instructions for this repo. My global preferences (tone, doc style,
> Q&A teaching format, git rules) load separately from `~/.claude/CLAUDE.md`, this file
> only adds facts that are true *here*.

---

## 1. What this project is (Layman → Technical)

**LAYMAN (Tropang Ex):** This is Megaworld's **RARS** (Risk Assessment & Routing System),
the online pipeline for requesting access to company data. It has **3 separate apps that
work as one flow**, all sharing **one Google Sheet** as their database:
- **Phase 1: DCS** (Data Collection System): the request form. You apply, attach NDA/DPA/DSA.
- **Phase 2: PIA** (Privacy Impact Assessment): the privacy questionnaire you fill after
  your DCS is cleared ("Proceed to Phase 2").
- **Phase 3: Admin**: the ISM control tower, dashboard, email routing, settings
  (download links, reminders), oversight. Restricted to INFOSEC-001/002.

A request climbs an approval ladder (Immediate Head → Dept Head → maybe Division Head → ISM)
until "Fully Certified." See [docs/](docs/) for handoff specs.

**TECHNICAL:** Three **independent Google Apps Script web apps**, each its own GAS project +
deployment + `appsscript.json`. They never call each other directly, they coordinate
**only through the shared Google Spreadsheet** (DCS reads/writes `Data_Collection`; PIA
reads the DCS row via a `parentID`/`Linked_ReqID` and writes `Applications` + the
`*_Approval_Workflow` sheets; Admin reads/writes everything). DCS hands off to PIA via the
`PIA_APP_URL` stored in Script Properties. The real DB schema is in `DPS_DB*.xlsx` (gitignored).

---

## 2. 🚨 Architecture facts: read before editing

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

**Implications, enforce these:**
- ✅ **Frontend/design changes are the common, low-risk work** (CSS, render functions, copy,
  client validation). Phase 1 is the original supervisor scope.
- ⚠️ **Backend (`*_code.js`) edits are higher-risk**, they send real emails to real people
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
- **How it ships, per phase, manual:** Kai **copy-pastes** the edited file into the
  **matching** GAS project, then **redeploys that project** (Deploy → Manage deployments →
  edit → New version → keeps the same `/exec` URL). Each phase deploys **independently**, a
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

**THE GOLDEN RULE: each app keeps exactly ONE web-app deployment.** To ship a change:
`Deploy → Manage deployments → ✏️ Edit the one deployment → Version → "New version" → Deploy`.
**Never** click **"New deployment."** New version keeps the same `/exec` URL → every stored
URL below stays valid → zero property edits needed. One stray "New deployment" silently
orphans the URLs and breaks the button + all email links.

**Why it's manual at all:** the 3 apps are **separate GAS projects** that can't discover each
other's URLs. A project's *own* URL is auto-derivable (`ScriptApp.getService().getUrl()`, used
as the fallback in PIA's `getWebAppUrl()`), but **cross-app URLs must be stored**, that's the
integration glue. "Set once" (one stable deployment) beats "set every deploy."

**Property → URL map (set ONCE if you follow the golden rule).** Each value = that app's live
`/exec`. ⚠️ `DCS_WEB_APP_URL` exists in **both** DCS and PIA projects, the **PIA** copy is the
one the email code reads.

| Project (Script Properties) | Property | Must hold | Feeds / read by |
|---|---|---|---|
| **DCS** | `PIA_APP_URL` | live **PIA** `/exec` | "Proceed to Phase 2" button (`generatePhase2Url_`) |
| **DCS** | `DCS_WEB_APP_URL` | *(nothing, unused)* | ⚠️ **Not read by any DCS code.** Verified zero occurrences in `Phase 1/Code.js` + `Phase 1/index.html`. Previously documented as a "self-reference"; it isn't one. Harmless if set, harmless if absent, don't wire anything to it. The one that matters is **PIA**'s `DCS_WEB_APP_URL` (next row but one). |
| **PIA** | `WEB_APP_URL` | live **PIA** `/exec` | approver "Review Access Request", ISM/approval forms, reminders (`getWebAppUrl`) |
| **PIA** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | applicant "View DCS Submission" link (`getDCSWebAppUrl`) |
| **Admin** | `WEB_APP_URL` | live **PIA** `/exec` | manual-resend email CTAs, via `getOptionalUrl_`, through **Admin's own** `notifyApprover` / `notifyApplicant` / `apiPhase3_NotifyISMember` (`admin_code.js:3350` / `:3421` / `:3483`, separate project, separate copies from PIA's now-private ones). Generic "Open the System" link, **no token, no `parentID`**. Missing prop → button silently omitted (graceful). Admin uses **no** `DCS_WEB_APP_URL` / `PIA_APP_URL`. |

Consistency check: **DCS `PIA_APP_URL` == PIA `WEB_APP_URL`** (both = live PIA). That is the only
pair that must agree. (The old check also paired DCS↔PIA `DCS_WEB_APP_URL`; that was wrong, because
the DCS-side copy is never read, see the table note above.) If the pair disagrees, a link is about
to break.

**Gotchas when links die:**
- **Emails freeze their links at send time.** Updating a property only fixes **future** emails;
  ones already in inboxes stay dead. Re-trigger/resend to test.
- **Review tokens have a 14-day TTL** (`isTokenValid`), judge only with freshly generated links.
- **`?parentID=` only:** PIA's `doGet` evaluates the `index` template **only** on the
  `?parentID=` path, so template bugs surface on "Proceed to Phase 2" but not on a bare URL.
- **Never write literal `<? … ?>` inside comments** in a templated HTML file (`index`): the GAS
  template engine parses scriptlets even in comments → a stray `...` throws
  `Unexpected token '...'` during `template.evaluate()`.

---

## 4. File map (by phase)

| Path | Role | Touch it? |
|------|------|-----------|
| `Phase 1/index.html` | **DCS frontend**: CSS, 9 screens, client JS, validation | ✅ main work |
| `Phase 1/Code.js` | DCS backend (~2,670 lines), `doGet`, drafts, `submitDCS`, risk audit. **One email:** `notifyDcsRequester_` ("Proceed to Phase 2" confirmation). | ⚠️ careful |
| `Phase 2/pia_index.html` | PIA frontend, multi-section assessment wizard | ⚠️ as needed |
| `Phase 2/pia_code.js` | PIA backend (~9,000 lines), approval workflow, ISM, **all email** (`notifyApplicant_`) | ⚠️ careful |
| `Admin/adminView.html` | Admin frontend: dashboard, settings, email routing | ⚠️ as needed |
| `Admin/admin_code.js` | Admin backend: config, manual email resend (`adminResendEmail`), `MailApp` senders | ⚠️ careful |
| `*/…_appsscript.json` | Per-phase GAS manifest (Asia/Manila, scopes, DOMAIN access) | ⚠️ only for a new scope |
| `docs/manual/` | **Unified user & maintenance manual**: Part 0 (common: architecture, ops, security, glossary) is the cross-app source of truth; Parts 1–3 per phase; appendices. Start at `docs/manual/README.md`. | ✅ keep current |
| `docs/` | Cross-team handoff specs, security docs, test guide, T&Cs, V2-vs-V1 write-up | ✅ |
| `DPS_DB*.xlsx` | Real DB export for schema reference, **gitignored (PII)** | 📖 read-only |
| `CLAUDE.md` | This file | Update when facts change |

---

> **§5–§8 below are Phase 1 (DCS) specifics**, `Phase 1/index.html`. PIA and Admin have
> their own structures (see §1/§4); explore those files directly when working in them.

## 5. The 9 screens (all in `Phase 1/index.html`, swapped by `show(name)`)

Screen `<div>`s are **empty in the HTML**: JS fills them via `render*()` at runtime. So
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
*(Line numbers drift as the file changes, treat as hints, not absolutes.)*

---

## 5b. Backend reference (from `Code.js`, the cloud `Code.gs` mirror)

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
workflow sheets, they are NOT stored strings. Don't assume a badge maps 1:1 to a column.

**Secrets** live in Script Properties (never in code): `DB_ID`, `ADMIN_FOLDER_ID`,
`PIA_APP_URL`, `DOMAIN`. ⚠️ **The approval-token signing secret is named `SYSTEM_SECRET`
and lives in the PIA project** (read by `getSystemSecret()` → `pia_code.js`), NOT `HMAC_SECRET`.
The old "`HMAC_SECRET`" name in these docs/`Code.js` comments is a misnomer; DCS does not
functionally read it. When verifying token security, check **`SYSTEM_SECRET` in the PIA project**.

**Security (do not weaken):** `doGet` blocks non-domain accounts before serving the HTML;
`submitDCS` re-validates domain + required fields + email formats server-side
(defense-in-depth). Files are uploaded base64 → Drive folder `ADMIN_FOLDER_ID` via
`uploadProxy_`. `analyzeDCSRisk_()` auto-flags conflict-of-interest / duplicate-role /
short-entry / missing-accountable patterns into `Risk_Audit`.

**🚩 Uploaded documents are PRIVATE (2026-08-11). Do not re-add link sharing.** `uploadProxy_`
used to end with `file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, …)`, publishing every NDA / DPA /
DSA / Confidentiality Undertaking / Endorsement Letter to **anyone on the internet holding the URL**,
and the raw `drive.google.com/file/d/<id>/view` URL was rendered straight into the request-details
screen, the PIA summary and the approver review form. One forwarded screenshot leaked a signed
contract publicly. `DriveApp.createFile()` leaves a file owner-only, so the fix is that the function
now sets **no sharing at all**.

Read access is served only by **`apiDownloadDcsFile`** (one copy per project, different signatures:
Phase 1 takes `(reqId, fileId)` and gates on request ownership; PIA takes `(sessionId, fileId)` and
reuses `isAuthorizedForApplication_`). Both then apply the **anti-confused-deputy check**: the
requested `fileId` must actually appear in that request's `FILE_ID` JSON / `supersededFiles` /
agency `endorsementLetter`. *Owning a request is not owning a file*, without that check, a caller
who passes the ownership gate on their own request could hand in any Drive ID in the script owner's
Drive and have it served back under the owner's full `drive` scope. Both cap the response at 8 MB
(base64 inflates ~33%, and `google.script.run` payloads get unreliable past ~10 MB).

**The ONE deliberate exception:** `getAndShareDCSFiles_` and `getDCSSupersededFiles_` in
`pia_code.js` still elevate to `DOMAIN_WITH_LINK`, never `ANYONE_WITH_LINK`, because their only
caller is the Certificate of Approval builder, whose email + PDF go to the DCOPS/TechServe inboxes
and **cannot call `google.script.run`**. It fires only at final-certificate time, for that one
request's files. Both functions carry a comment saying so; if the certificate ever stops linking
documents, delete the elevation with it.

`backfillPrivateDcsFiles(dryRun)` (Phase 1, owner-gated, **`dryRun` defaults to true**) privatizes
files uploaded before the fix. ⚠️ It retroactively kills Drive links in already-sent emails, correct,
but tell ISM first, and it is **not** git-revertible.

**Server API contract** (what each `google.script.run` call returns, read the function in
`Code.js` before relying on a field):
`apiGetSystemConfig` → `{success, config:{DOMAIN, LINK_*_TEMPLATE, ...}}` ·
`apiGenerateNewSessionId` · `apiSaveDraft(sessionId, stateData)` ·
`apiRestoreDraft` / `apiListUserDrafts` / `apiDeleteDraft` ·
`submitDCS(payload, sessionId)` → `{success, reqId, phase2Url?}` ·
`apiListUserRequests` · `apiGetRequestData(reqId)` (form data + approvers + timelines) ·
`apiGetReturnedApplication(reqId)` (revision flags).

---

## 6. Design system (the tokens to reuse, do NOT hardcode new values)

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
- **Responsive breakpoints:** `768px` (tablet, sidebar→static, grid→1col, buttons
  full-width) and `480px` (phone, smaller type, sticky bottom button bar).

**Rule:** new colors/spacing/radius must reuse existing `--vars`. If a value doesn't exist,
ask before inventing one, consistency with the navy system matters to the supervisor.

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

- **🚨 GAS serve-time template-literal corruption (learned the hard way, 2026-06-24).** A
  string-building helper written as a **template literal** (backticks) blanked the whole DCS page
  with `Uncaught SyntaxError: Unexpected identifier 'style'` thrown at GAS's `document.write(s(g))`
  serve step, even though the file passed `node --check` cleanly. `node --check` validates the file
  **on disk**; it CANNOT see GAS's serve-time serialization, which corrupted that one backtick
  template (it produced `<a … style="…">${…}</a>`), leaving an unterminated string so the parser
  choked on the next `style=` downstream. The fix: **rebuild the helper with plain ASCII string
  concatenation** (`'a' + x + 'b'`), identical output, no backticks. (A `↗` Unicode char was a red
  herring; removing it didn't help, the template *delimiters* were the trigger.) **Rule:** when a
  GAS-served file blanks with a parse error that does NOT reproduce in `node --check`, suspect a
  template literal in a string helper and switch it to concatenation. "Valid JS on disk" ≠ "GAS
  serves it intact." To get ground truth, read the served **VM** file at the console error's
  `VM##:line`, that's the actual served (corrupted) code, not your disk file.
- **🚨 SECOND CONFIRMED TRIGGER, `xmlns` inside a `<script>` block (2026-08-13, cost an outage).**
  Same failure shape, different cause, and this one was *proven* from the served bytes rather than
  reasoned about. `icon()` in `Phase 1/index.html` contained an inline SVG carrying its namespace
  attribute. On disk it was a normal concatenation; served, it came back **truncated at the double
  slash inside the namespace URL**, leaving an unterminated string literal, so the parser died on
  the next line and the page never rendered (`Failed to execute 'write' on 'Document': Invalid or
  unexpected token`). The identical line sat in `Admin/adminView.html` and a third hand-duplicated
  copy sat inline in `renderForm()`'s "Revision Mode" badge, so Admin would have blanked too.
  - **Fix: delete the `xmlns` attribute.** It is redundant for inline SVG, the HTML parser places
    an `<svg>` element into the SVG namespace on its own. Enforced by **`docs/tools/serve.js`**.
  - ⚠️ **Do NOT generalize this to "no `//` inside any string."** That rule is provably wrong here:
    `FAVICON_URL` in `Phase 1/index.html` and the three `drive.google.com` link builders in
    `Admin/adminView.html` all carry a double slash inside a string inside a `<script>` block and
    have served correctly for months. The exact mechanism (why `xmlns` and not `href`) was never
    established, and the checker is anchored on the observed break, not on a theory.
  - 🔴 **The meta-lesson, and it is the same one twice in one day: an undeployed batch is an
    untested batch.** Both copies were written on 2026-08-12, passed every offline check, sat in
    git for a day, and failed the instant they were first served. Two other defects that same day
    (`getSystemSecret_`, the header drift) had the identical shape. **Deploy small and deploy
    often; a commit that has never been served has not been tested in any meaningful sense.**
- **Screens are rendered by JS**, not present as static HTML, search render functions.
- **Files are NOT stored in drafts**, only text autosaves (server-side, 7-day TTL).
  Resuming a draft requires re-uploading files. Don't "fix" this as a bug; it's intended.
- **`localStorage` is intentionally disabled** to avoid client/server state mismatch.
- **Revision mode** (`state.isEditing = true`) highlights flagged fields and forces
  re-upload of flagged files only, non-flagged files stay in Drive.
- **"Returned" ≠ "Denied":** returned is a fixable loop; denied/rejected is terminal.
- **Favicon override** uses a MutationObserver + setInterval (GAS injects its own icon),
  don't remove it thinking it's dead code.
- **Downloadable templates** are driven by the `DOWNLOADABLES` array in `renderGuide()`.
  Add/remove a form by editing that array; the link itself is admin-managed via a
  `LINK_*_TEMPLATE` row in the `System_Configuration` sheet (generic config passthrough, no
  backend code change needed). Missing row → link shows "Link not set" (`#`). The Admin app's
  Settings UI can edit these link rows; new keys need a direct sheet row or an Admin UI
  addition. ⚠️ There are now **7 forms** with per-entity keys: `LINK_NDA_EMPLOYEE_TEMPLATE`,
  `LINK_DSA_TEMPLATE`, `LINK_DPA_MEGAWORLD_TEMPLATE`, `LINK_DPA_LUXURY_GLOBAL_TEMPLATE`,
  `LINK_DPA_GLOBAL_ONE_TEMPLATE`, `LINK_CU_AGENCY_TEMPLATE`, `LINK_CU_OJT_TEMPLATE` (the old
  `LINK_NDA_TEMPLATE`/`LINK_DPA_TEMPLATE`/`LINK_OJT_NDA_TEMPLATE` names are superseded).
- **Approval reminders live in PIA, not Admin** (corrected, the original "`adminApi_sendDailyReminders()`
  in `Admin/admin_code.js`" was wrong on both the name and the location; verified by grep). The real
  **daily reminder engine** is `sendDailyReminders()` / `buildReminderEmail()` / `setupReminderTrigger()`
  in **`Phase 2/pia_code.js`** (~line 4671). A daily `ScriptApp` time-trigger **running inside the PIA
  project** (`atHour().everyDays(1)`, needs `script.scriptapp`) scans the 3 workflow sheets for `Pending`
  rows and emails **only the next pending approver per request**, stamping `ReminderDate` so each is
  nagged **once per day** until they act. Reminder emails carry a **valid tokenized review link**
  (`WEB_APP_URL`). The **Admin panel only *configures*** it: Settings (on/off, hour) calls PIA's
  cross-app API (`getReminderConfig` / `setReminderConfig`, dispatched in PIA `doPost` ~line 1300).
- **Admin's own emails are manual resend only** (`Admin/admin_code.js`): an ISM clicks "Resend Email" →
  `adminResendEmail` (dispatched ~`admin_code.js:874–912`) re-fires `notifyApprover` / `notifyApplicant` /
  `apiPhase3_NotifyISMember` via `sendEmailWithRetry_`. These are **generic "log in to the system" notices**
  (CTA = `getOptionalUrl_('WEB_APP_URL')`, **no token / no `parentID`**), a fallback nudge, **not** the
  primary tokenized PIA workflow emails, and **not** the daily reminder. Don't duplicate email logic.
- **DCS sends exactly one email** (`Phase 1/Code.js`): `notifyDcsRequester_` (~line 1705), the styled
  *"Request submitted: Proceed to Phase 2"* confirmation, fired auto inside `submitDCS` (~1681, try/catch
  failsafe) with a `?parentID=` deep-link into PIA.
- **🚨 There is NO certificate template file, don't go looking for one.** The Certificate of Approval
  is built as an **HTML string in source** and converted in one line:
  `Utilities.newBlob(html, MimeType.HTML, name).getAs(MimeType.PDF)`
  (`Phase 2/pia_code.js` ~10596 inside `routeApprovedRequest_`; same technique in
  `Admin/admin_code.js` ~4283 resend and ~4707 download, which base64s the blob back to the
  browser; line numbers drift, anchor on the function names). No Google Docs template, no
  `DriveApp.makeCopy`, no `DocumentApp`, no `{{token}}` replacement, data is interpolated inline
  as `${escapeHtml(...)}` across the ~200-line cert body. ⚠️ **The Admin copy
  (`buildCertificateHtml_`) is a genuinely different layout** (3 columns not 4, no comments, no
  history section, different agency fields), not a paste of PIA's; both gatherers are round-scoped
  via `keepCurrentRoundRows_` since 2026-08-13 (they used to flatten every round's Approved rows
  into one roster). **Consequences to respect when editing it:**
  (a) the layout IS the source, so redesigns are normal code edits (good: diffable, no template-ID SPOF);
  (b) the converter is Google's **legacy HTML→PDF engine**, table-based HTML + inline CSS only. No
  flexbox/grid, no page-break control, no headers/footers/page numbers. Don't "modernize" the cert CSS;
  it will silently render wrong in the PDF while looking fine in the email;
  (c) the PDF is built from the *email* HTML with the remote logo `<img>` string-replaced out
  (just above the `newBlob` call) because the converter won't reliably fetch remote images. One body,
  two renderings, edit the shared HTML, not one copy;
  (d) **the PDF is never archived.** It lives in memory, gets attached, and is discarded. Re-issuance works
  by *regenerating from the DB* (`apiAdmin_DownloadCertificate`, `admin_code.js` ~4558). There is no cert
  Drive folder and no issuance-log sheet. A cert therefore reflects the DB *now*, not at signing time.

---

## 8b. PIA (Phase 2) reference, approval ladder, returns & email links

> Built from reading `Phase 2/pia_code.js`. The PIA approval workflow is **not** obvious from
> the sheets alone; this is the canonical map. (DCS itself has **no** approval gate, it's
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
**admin-configured**: InfoSec reviewers + DCOPS/TechServe live in `InfoSec_Email_Config`
(active=YES), and `PRIVACY_OFFICER_EMAIL` is the head fallback. The **per-applicant** roles
(Immediate / Dept / **Division** Head) are **filled by the applicant in PIA1**, because they're
that person's own reporting line, which varies per request and would be unmaintainable as a
central org chart. Integrity risk (naming yourself/a friend) is mitigated, not prevented, by
`analyzeApplicationRisk` (flags drafter-email == head-email, `pia_code.js` ~3602). Future
hardening = source the head chain from an HR directory / Workspace org unit.

**⬆️ Escalation = "up to Division Head, then back down" (NOT a skip-to-final).** When an InfoSec
member picks `EscalateToDivisionHead` (`apiPhase3_ProcessISMDecision` ~7154):
- That ISM row → `EscalatedToDivisionHead`; app status → `Escalated to Division Head`; the ISM
  chain **pauses** (the *next* ISM member is NOT notified yet).
- A **single** Pending `DivisionHead_Approval_Workflow` row is created (dedup guard ~7197 skips
  if one is already Pending: a safety net for simultaneous escalations), and the **Division
  Head named in PIA1** (`divHeadEmail`) is emailed a review link.
- The Division Head decides (`processDivHeadDecision` ~3910):
  - **Approve** → the escalated ISM step is marked `Approved`. If that makes **all** ISM rows
    Approved → **finalize** (certificate + route + DCS Complete). If not (e.g. the other ISM
    member hasn't acted) → **resume the ISM chain at the next step** (`notifyISMember_`
    ~3999), i.e. it comes *back down* to the remaining reviewer.
  - **Deny** → app `Denied` (terminal). **Return** → app `Returned` to applicant (+DCS if DCS
    flags) → full restart on resubmit.
- If **both** InfoSec members escalate (only reachable sequentially: Step 2 escalates after a
  DivHead approve resumes the chain to them), the Division Head is reviewed **once per
  escalation** (the prior DivHead row is already resolved, so a fresh Pending one is created).

**🔁 Return = FULL restart of the ladder, but NOT a deletion of history.** A "Return" from **any**
approver (head, InfoSec, or DivHead) always bounces to the **applicant**, never to a previous
approver. On resubmit, `submitApplication_` **appends a new round** (`RoundNumber = N+1`) starting at
Stage A Step 1, and **the previous round's rows are kept**. Approval *progress* resets to zero;
approval *history* does not. Nothing resumes mid-chain.

⚠️ Until 2026-08-11 this path **deleted** the prior rows and relied on a best-effort photocopy, see
the append-only section further down for why that changed and what replaced it. If you are reading
older notes that say "deletes all rows," they describe the retired behaviour.

⚠️ **Return ≠ Deny:** Return is a fixable loop; Deny/Reject is terminal. And if the linked **DCS** is
`Returned`, PIA resubmission is **blocked** until the DCS is fixed first.

**📧 Email links: how they're built & why they break.** All workflow emails (approver review,
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
  sent**. Updating a property fixes **future** emails only, ones already in inboxes stay dead.
- Test with a **fresh** transaction (re-trigger), and only with **freshly generated** links
  (tokens expire in 14 days).

**🔒 The F-02 guard convention, every state-mutating function guards ITSELF.** In Apps Script,
**every top-level function in a project is callable from the browser via `google.script.run`**,
regardless of what the UI exposes buttons for. So authorization living only in the outer handler the
UI happens to call is not authorization. The convention here: each mutator re-resolves the caller
server-side and compares it to the email it was passed,

```js
// SECURITY (F-02): authorize the actual caller server-side.
const _me = getNormalizedEmail(Session.getActiveUser().getEmail());
if (_me !== getNormalizedEmail(approverEmail)) {
  return { success: false, error: 'Access denied: you may only submit your own decision.' };
}
```

Present in all three decision fns: `processApprovalDecision` (~4544), `processDivHeadDecision`
(~4291), `apiPhase3_ProcessISMDecision` (~7760). The "still actionable?" half of the check is
**structural**, not a separate branch: every row search requires `STATUS === 'Pending'`, so
re-deciding a resolved request returns "record not found." `submitApplication` re-checks ownership
*inside* the lock (~4128, TOCTOU-aware, logs `SECURITY ALERT`). **Never add a mutator without this
guard, and never rely on the caller having gone through a handler.**

**🚩 The flags contract (2026-08-13): flags may ONLY accompany a Return.** A flag is a correction
request for the applicant, and the only decision that ever carries flags back to the applicant is
Return (`Applications.Approver_Flags` is mirrored only on the Return paths). Approve or Escalate
submitted with flags used to record a request nobody was ever shown, a silent workflow failure
found in live data (a Dept Head approved over two flags; the applicant never saw them). Now:
- Server side: all three decision mutators refuse `Approve` (and ISM `EscalateToDivisionHead`)
  when `hasFlags_(approverFlags)` is true. `Deny` + flags stays allowed (terminal, flags inert).
  `Return` still REQUIRES at least one flag (pre-existing client check).
- Client side: both review-form copies disable the `.flag-blocks-this` buttons inside
  `updateFlagsInput()`, and guard `submitWithRouting` (ISM) / the form `submit` event via
  `event.submitter` (standard).
- **Do not relax one side without the other.** The client half is courtesy; the server half is the
  rule (`apiProcessApprovalDecision` is public RPC).

**🚩 Decision text is PLAIN TEXT (2026-08-13), enforced at the mutators.** All three decision
functions strip `<[^>]*>` from `comments` and pass `approverFlags` through `sanitizeFlagsJson_`
(keys AND values stripped; custom PIA-2 field labels are user text) at entry, so the RPC path and
the form path store the same thing. `sanitizeInput_`'s old rich-text allowlist
(`<b|strong|em|...>`) is deleted; it contradicted `handleEmailAction_`'s strip-everything on the
same field, and nobody had ever chosen between the two. Do not re-add an allowlist without
revisiting that decision by name. Related display-only mapping: the stored status `'Approved'`
(meaning: heads done, ISM pending) renders as "Approved by Heads (Awaiting ISM Review)" on the
review pages; **the stored `Applications.Status` strings are frozen cross-app contracts and the
write side is untouched.**

**🔒 The second half of the convention: the trailing underscore is a security boundary.** The
guard above covers functions that *receive* a caller email to compare against. Functions that don't
take one (formatters, mailers, the finalizer) can't use it, so they are made **private instead**,
in Apps Script a trailing-underscore name is unreachable from `google.script.run`.

> **🚩 2026-08-11, the convention is now applied project-wide, not case by case.** Before this
> sweep the repo exposed **178 of its 229** top-level functions, including `getSystemSecret` (which
> returned the HMAC signing key as a string to any domain caller), `getApplicationData` (full PII
> record for any sequential, guessable session id), 16 unguarded `admin*` config mutators/email
> cancellers, and two unauthenticated ISM workflow mutators. After the sweep: **82 public, none of
> them unguarded.** Run `node docs/tools/surface.js` before every deploy.
>
> 🔴 **Also run `node docs/tools/calls.js`, and understand why it exists.** Privatizing a function
> means renaming every caller too, and `c4bb11d` missed one: `generateAuthToken_` kept calling
> `getSystemSecret()` after the definition became `getSystemSecret_()`. That call signs **every
> approver review link**, so the first deploy would have broken the whole approval workflow. It
> survived `node --check` (a call to a missing function is syntactically perfect), `surface.js`
> (which audits *which names are public*, not whether calls resolve), and three review passes. It
> surfaced only when `testAppendOnlyRounds()` was finally run against a live sheet, as a
> `FAILSAFE:` line inside a passing test, because the email send is wrapped in try/catch.
> **In Apps Script a missing function is a runtime ReferenceError on whatever path reaches it,
> so "it parses" and "it deploys" both prove nothing.**
>
> `calls.js` is deliberately narrow: for every `foo_` defined, does anything still call bare `foo`
> (unless `foo` is also defined, which is the legitimate public-wrapper pattern)? A first attempt
> at a general undefined-call detector needed a real JS tokenizer, fell over on regex literals
> containing quotes and on nested template literals, and produced hundreds of false positives. A
> checker nobody trusts gets ignored; this one answers the question that actually caused an outage.
>
> 🔴 **The ritual is now FIVE checkers. Run all of them before every deploy:**
>
> ```
> node docs/tools/surface.js && node docs/tools/calls.js && node docs/tools/escapers.js && node docs/tools/shared.js && node docs/tools/serve.js
> ```
>
> They split cleanly in two, and the split is the point. `surface.js` and `calls.js` audit what
> the code is **named**. `escapers.js`, `shared.js` and `serve.js` audit what the code **does**
> when it actually runs or is actually served. Every outage this project has had was caught by
> the second kind and missed by the first.
>
> - **`escapers.js`** exists because the production DCS frontend shipped for its entire deployed
>   life with an `escapeHtml` whose replacements were **identity no-ops**
>   (`.replace(/&/g,'&').replace(/</g,'<')…`): only the apostrophe was ever escaped, and that
>   function was the sole XSS defense for 71 innerHTML interpolation sites, approver comments
>   included. Valid JS, correct-looking shape, so it passed `node --check` and every review;
>   `surface.js`/`calls.js` audit names, not behavior. The checker verifies every escaper in all
>   six files actually escapes (no identity replaces, `&` first). **The generalizable lesson: a
>   function that LOOKS like its job description proves nothing; the checkers that catch these
>   audit what the code does, not what it is called.**
> - **`shared.js`** compares the "one identical copy per project" helpers (`ERR`, `ERR_MESSAGES`,
>   `fail_`, `safeError_`, `isOwnerContext_`, `readSheetValues_`, `withSheetCache_`,
>   `invalidateSheetCache_`, `escapeHtml_`) across the three backends, comment- and
>   `var`/`const`-insensitive, and fails on real code drift. When a doc says "edit all three
>   together," this is what enforces it. Add an entry to its `MUST_MATCH` list at the same moment
>   a doc declares a helper shared.
> - **`serve.js`** (added 2026-08-13, after the outage in §8) flags an `xmlns` attribute inside a
>   `<script>` block in any of the three frontends. GAS truncates the served line at the double
>   slash in that attribute's URL, leaving an unterminated string that blanks the entire page,
>   and **all four other checkers pass on that file** (verified by reintroducing the bug). The
>   attribute is redundant for inline SVG, so the fix is always "delete it." Deliberately does not
>   flag every `//` inside a string, see §8 for the two proven counter-examples.
>
> **The rule for any NEW backend function, pick exactly one:**
> 1. **Internal helper → give it a trailing underscore.** This is the default. Choose it unless you
>    can name the frontend line that calls the function.
> 2. **Genuinely called by the frontend → keep the bare name AND guard the body.** Not the wrapper:
>    *the body*. See the F-05 lesson below.
> 3. **Trigger handler or editor-run helper → keep the bare name and guard with `isOwnerContext_()`.**
>    These cannot take an underscore: a time-driven trigger binds its handler by **name string**
>    (`ScriptApp.newTrigger('sendDailyReminders')`), so renaming one silently orphans the installed
>    trigger. `isOwnerContext_()` compares `getEffectiveUser()` to `getActiveUser()`, equal only for
>    the owner or a trigger run. It exists in all three projects; keep the copies identical.
>    `sendDailyReminders` and `setupReminderTrigger` use a **thin public guarded wrapper over a
>    private `_` implementation**, because they also have internal callers that must bypass the gate.
>
> **🔴 The F-05 lesson, guard the primitive, not the wrapper.** `docs/Security - Review Findings.md`
> recorded F-05 (`getApplicationData` IDOR) as ✅ Fixed. What was actually fixed was
> `apiGetApplicationData`, the *wrapper*. `getApplicationData` itself stayed public and unguarded, so
> `google.script.run.getApplicationData('PIA-000123')` still returned the whole record. **A finding
> is not closed until the primitive is closed.** The primitive is now `getApplicationData_`.
>
> **⚠️ Rename FUNCTIONS only, never DTO property keys.** The sibling COC repo ran this same sweep and
> renamed `isAdmin` → `isAdmin_` on a *return-value key* as well as the function; `state.user.isAdmin`
> became `undefined` and its entire admin console went dark. A call-graph checker cannot catch that:
> the name still resolves, it is the object property that broke.

Five functions in `pia_code.js` were private for this reason before the sweep and **must stay that
way** (they are now part of a much larger private set, but these are the highest-impact):

| Private fn | Was | Why it must not be public |
|---|---|---|
| `routeApprovedRequest_` | `apiPhase3_RouteApprovedRequest` | Builds the Certificate of Approval and emails it to the live DCOPS/TechServe inboxes (`[CERTIFICATE OF APPROVAL] Implementation Required`); also calls `getAndShareDCSFiles`, flipping uploaded DCS docs to `DOMAIN_WITH_LINK` |
| `updateDCSStatus_` | `updateDCSStatus` | Writes status into any `Data_Collection` row (now also whitelisted to `'Complete'`/`'Returned'`) |
| `notifyISMember_` | `apiPhase3_NotifyISMember` | Send-amplifier |
| `notifyApprover_` | `notifyApprover` | Send-amplifier |
| `notifyApplicant_` | `notifyApplicant` | Send-amplifier |

`routeApprovedRequest_` additionally gates on `appData.status === 'Approved by ISM'` (defense in
depth behind the rename), reusing the `getApplicationData` call already at `~8178`. Both legitimate
callers stamp that status immediately before invoking it (ISM `~7862`→`~7871`, DivHead proxy
`~4372`→`~4379`), so the gate is transparent on the normal paths.

> ⚠️ **Don't "tidy" these names.** Dropping an underscore re-opens a live hole, session IDs are
> sequential (`~3780`) hence guessable, so a public finalizer lets any domain user email a forged
> implementation certificate for any request. The original F-02 sweep missed exactly this function.
> **The generalizable lesson: the function that gets missed is the one that doesn't *look* like an
> auth decision (a formatter/mailer), which is also the highest-impact one.**
>
> ⚠️ **Admin has its own separate copies** of `notifyApprover` / `notifyApplicant` /
> `apiPhase3_NotifyISMember` (`admin_code.js`). These were previously documented here as
> "deliberately not renamed" on the grounds that Admin is a separate GAS project. **That reasoning
> was wrong and has been corrected (2026-08-11): being a separate project explains why PIA's rename
> did not *force* Admin's, not why Admin's copies had to stay public.** They were send-amplifiers
> reachable from any domain browser console. All three are now `notifyApprover_` /
> `notifyApplicant_` / `apiPhase3_NotifyISMember_`, reached only from the checkAccess_-guarded
> `adminResendEmail`. The names still need not match PIA's, only the privacy does.
>
> ✅ **Closed (2026-08-11), same class:** `adminResendEmail` and the 15 sibling `admin*` functions in
> `pia_code.js` are now private. All 16 are dispatched internally by `handleAdminApiRequest_` (itself
> behind `doPost` + `ADMIN_API_KEY`), so nothing lost a caller.
>
> ✅ **Also closed (2026-08-11), found during the sweep and NOT in the original F-01 list:**
> `getAdminData` / `getAuditLogs` / `exportToSheet` / `debugSheets` / `ping` / `getAdminDataDebug` /
> `adminGetEmailLog` / `adminGetFailedEmails` in `admin_code.js` were frontend-callable with **no**
> authorization check at all, `getAdminData` alone returned every request in the system, with all
> PII, to any domain caller. F-01 guarded the `adminApi_*` / `apiAdmin_*` families and missed these.
> They now carry the standard `checkAccess_` guard. Two unauthenticated ISM workflow mutators
> (`apiPhase3_InitializeISMWorkflow`, `apiPhase3_RetryISMWorkflow`) were closed the same day by
> privatization.
>
> ℹ️ **`include` in `admin_code.js` is deliberately left public.** `adminView.html` contains zero
> `<? ?>` scriptlets so it is currently dead code, but `doGet` uses `createTemplateFromFile`, and
> breaking scriptlet resolution would mean no page renders at all. Low severity (it returns project
> HTML, not user data) against a high blast radius. Same call, for the same reason, as COC's.

**🗒 The approval workflow IS append-only (since 2026-08-11). Nothing is deleted on resubmit.**

> **What it used to be, and why it changed.** `submitApplication_` used to **delete every row** for
> the session from all three workflow sheets and rebuild the ladder from Stage A Step 1. That delete
> was never a business requirement, the rule is only "a return restarts the ladder." It existed
> because the sheets had **no round column**, so a `SessionID = X AND Status = 'Pending'` scan could
> not tell a live row from an abandoned one (classic case: ISM member 2 is still `Pending` when ISM
> member 1 returns the request; append round 2 without a discriminator and routing matches both).
>
> Wiping was the cheap way to guarantee one answer, and `Revision_History` existed purely as a
> photocopy taken before the shredding. It cost: a **silent-loss path** (the snapshot was
> try/catch + non-blocking, so a failure lost the round with no signal), a **deliberately lossy**
> record (`status === 'Pending'` rows were dropped, never copied), and **256 lines across two
> projects** whose only job was to stitch the two sources back together.

**How it works now:**
- `APPROVAL_COLS` / `ISM_WORKFLOW_COLS` / `DIV_HEAD_CONFIG_COLS` each gained **`ROUND_NUMBER`** and
  **`FLAGGED_FIELDS`**, appended at the end so no existing index shifted.
- A resubmit **appends round N+1**; earlier rounds stay untouched and are the authoritative history.
- **`getCurrentRound_(sessionId)`** derives the live round as `MAX(RoundNumber)` across the three
  sheets. **`roundOf_(row, cols)`** reads a row's round, treating blank as **1**, which is what
  makes every pre-change row still behave correctly with no migration.
- **`rowMatches_(row, cols, sessionId, round)`** is the one predicate every scan should use, and it
  makes the critical distinction explicit at the call site:
  - `round = <n>` → **routing** read ("who acts next?"). Must be scoped, or a stale row hijacks it.
  - `round = null` → **history / authorization** read ("what happened?" / "were they ever party to
    this?"). Must span all rounds.
- 🚩 **`isAuthorizedForApplication_` is deliberately NOT round-scoped** and scans `Approval_Workflow`
  directly. `appData.approvers` carries only the current ladder, so scoping authorization too would
  silently revoke view access from anyone who approved an earlier round.
- `writeDecisionFlags_` persists what each approver flagged onto **their own decision row**, which is
  what replaced `Revision_History.FlaggedFields`.
- **`Revision_History` is retired.** `writeRevisionHistorySnapshot_`, `getRevisionHistorySheet_`,
  `getRevisionHistory_`, `REVISION_HISTORY_COLS` and DCS's mirrored `getRevisionHistoryRows_` are all
  deleted. `getUnifiedHistory_` is now one scan (`collectAllRoundDecisions_`) instead of a union.
- DCS reads history via **`getApprovalHistoryRounds_`**, which resolves columns **by header name**
  (`getHeaderIndexMap_`) instead of the old mirrored index map, so PIA can add a column without
  breaking Phase 1. Its trackers keep showing the current round only (`keepCurrentRound_`); Admin
  does the same via `keepCurrentRoundRows_`.
- Regression test: **`testAppendOnlyRounds()`** (editor-run, self-cleaning) asserts round retention,
  round increment, flag persistence, and that an abandoned round-1 `Pending` row is never matched at
  round 2.

**Still true:** `Approver_Flags` on the `Applications` row is still cleared on resubmit (it is the
working copy for the current round), and `Applications.PIA_1..5_Data` is still **overwritten**,
which is why `Application_Snapshots` exists and must stay.

**🗒 `Application_Snapshots`, the answers, and why it is NOT the same kind of thing.**

`Applications.PIA_1_Data … PIA_5_Data` are still `setValue`'d over in place on resubmit. The
workflow sheets record the **decisions** of a round ("X approved, here is the comment") but not the
**submission** those decisions were made against, so "what exactly did the Department Head approve
in round 1?" had no answer anywhere. For a Privacy Impact Assessment that is a compliance gap.

`writeApplicationSnapshot_` writes one row to **`Application_Snapshots`** immediately before the
overwrite, inside the same lock, keyed by the same `(SessionID, RoundNumber)` pair the workflow rows
use. **Read the two together.**

> ⚠️ **Do not "simplify" this away along with `Revision_History`.** They are different animals.
> `Revision_History` was a copy-before-**DELETE** of rows that never needed deleting, a workaround,
> correctly retired. This is a copy-before-**UPDATE** of a genuinely single-current-state row that
> every app looks up by `SessionID`; versioning it into multiple rows would break every reader.
> Current-state row + separate history table is the right pattern here.

Its failure path is the point: still non-blocking (a history write must never block a resubmit), but
a failure writes a **`Snapshot Failed` row into `Risk_Audit`** instead of vanishing into a
`Logger.log`. Silent loss was the defect; blocking the user was never the fix.

Respect these properties when editing the resubmit path:
- Round derivation runs **inside `submitApplication_`'s lock**. `getCurrentRound_` is only race-free
  there. Don't move it to an unlocked context.
- The snapshot must run **before** the `setValue` block and **before** `Approver_Flags` is cleared.
  Read the prior row **once**, up front, and pass that same array along.
- Any **new history reader** should call `getUnifiedHistory_` (PIA) or `getApprovalHistoryRounds_`
  (DCS). Do not hand-roll another workflow scan, that is how the old union logic drifted.
- Any **new routing scan** must pass a round to `rowMatches_`. Forgetting it reintroduces the exact
  bug the delete was hiding, and it will not show up until someone resubmits.
- **The round is THREADED through decision executions (PERF, 2026-08-12).** `getCurrentRound_` costs
  a 3-sheet scan, so the helpers on the decision paths (`getApplicationData_`, `notifyApprover_`,
  `notifyISMember_`, `routeApprovedRequest_`, `apiPhase3_InitializeISMWorkflow_`, `queueEmail_`)
  take an optional trailing `round` param with the fallback `round || getCurrentRound_(sessionId) || 1`,
  and the locked decision functions pass their entry `__round` down. Two rules: (a) inside one locked
  execution, pass the round, do not re-derive it; (b) **never thread a round ACROSS a lock boundary**,
  e.g. from `handleEmailAction_` into `processApprovalDecision_`: each locked entry derives its own,
  that derivation is the authoritative one for everything inside its lock. Omitting the param is
  always safe (it derives), so external/test callers need no change.

`Risk_Audit` (`logDCSAuditTrail_`, `Phase 1/Code.js`) *is* genuinely append-only, but it logs
risk/action events, not the approval timeline. Don't confuse the two.

---

## 8c. The 2026-08-12 batch, error contract, read cache, delegation, retention, aging

> Seven items from `docs/Cross-Repo Review - DCS vs COC.md` shipped together. Each one added a
> convention that later code has to respect. Read the four 🚩 rules below before touching the
> affected paths.

### 🚩 The error contract is `{ok, code, message, ref}`. Nothing else.

Every backend response, success or failure, carries exactly one shape:

```js
{ ok:false, code:'NOT_FOUND', message:'That record could not be found. Reference: 7f3a91',
  ref:'7f3a91' }
{ ok:true, config:{…} }        // success: `ok:true` plus whatever the endpoint returns
```

> **History, so nobody re-adds it.** This shipped **dual-key** for exactly one release
> (`bc1d58d`), carrying a legacy `success` / `error` pair alongside, because the three GAS
> projects deploy independently and a frontend lagging a backend is the normal case. The pair
> was removed on **2026-08-12** from all three backends *and* all three frontends in one change,
> readers migrated first (131 sites), writers second (303). Do not reintroduce it.

- **`ERR` / `ERR_MESSAGES` / `fail_(code, msg)` / `safeError_(e, code, publicMsg)`**, one
  identical copy per project. They cannot be shared; **edit all three together.**
- **In a catch block, always `return safeError_(e, ERR.INTERNAL)`.** Never
  `error: e.toString()`, and never `message: 'Failed: ' + e.message` either. GAS exceptions echo
  the spreadsheet ID and Drive folder IDs, that was finding **F-06**, **110 sites**, all closed.
  The real exception goes to `Logger.log` only, keyed by `ref`; the user reads the ref back to you
  and you find it in the Executions log.
- 🔴 **The F-06 lesson: a sweep is not done when its pattern stops matching.** The first pass
  anchored on the value *starting* with the exception (`error: e.message`) and reported 89 sites
  closed. 21 leaks of the form `error: 'Loading failed: ' + e.message` slipped through, and they
  were the highest-traffic ones: all seven `getAdminData` handlers, all three `getAuditLogs`
  handlers, `exportToSheet`, and both cross-app `doPost` handlers. **Re-grep with a second,
  differently-shaped pattern before writing "closed" in a findings doc.** Same failure shape as
  F-05 (guard the primitive, not the wrapper): closed on the strength of what was searched for,
  not of what was wanted.
- ⚠️ **Deliberately NOT written to `Risk_Audit`.** An audit row per error is the log-bloat
  pattern this repo avoids elsewhere, and a sheet write inside an error handler is a second
  failure waiting to happen.
- ⚠️ **`success` / `error` keys that survive are NOT this envelope, leave them alone:**
  `Email_Queue.Last_Error` (`adminView.html`), `flags.error` inside audit JSON, PIA's
  `result.errors` **array** from validation, `{valid:false, error}` from `validateComment_`,
  `sendEmailWithRetry_`'s `detail` (renamed from `error` precisely so a future sweep cannot
  promote a raw Gmail exception into a user-facing `message`), and every `console.error` /
  `Logger.log` label.

### 🚩 The sheet read cache is OFF by default and only ever wrapped around READ-ONLY paths

`readSheetValues_(sheet)` replaced all ~150 `getDataRange().getValues()` call sites across the
three backends. With the cache off it *is* that call, which is what made the conversion a
behaviour-preserving no-op.

- **`withSheetCache_(fn)` enables it for the duration of `fn`.** Nesting composes, the
  outermost wrapper owns the lifetime. Currently wrapped: `apiGetApplicationData`,
  `apiGetApprovalHistory`, `adminGetPipelineView_`, `getAdminData`, `adminApi_getAgingReport`,
  `adminApi_runRetentionDryRun`.
- ⛔ **Never wrap a path that writes.** That makes write-then-stale-read structurally
  impossible instead of depending on someone remembering to invalidate across 151 write sites.
  Extending the cache to mutators needs a write-then-reread audit first (`processApprovalDecision_`
  writes a decision and then `checkAllApproved_` re-reads the same sheet), do it as its own
  change, with its own test.
- **A cache hit returns the SAME array reference.** Never mutate a cached read. Write paths
  therefore still call `sheet.getDataRange().getValues()` directly, that is intentional in
  `deleteRowsWhere_`, `adminApi_setRetentionConfig`, `adminApi_saveDelegation` etc, not an oversight.
- **`readSheetValues_(null)` THROWS**, matching the TypeError the old call produced. Returning
  `[]` would have quietly converted fail-loud paths into fail-silent ones, `sendDailyReminders_`'s
  pre-filter is fail-*closed* precisely because an empty map reads as "nobody has been reminded"
  and would blast every pending approver in the system.
- Separately, **`__SS_HANDLE_CACHE` memoizes the Spreadsheet handle** (PIA + Admin; Phase 1
  already had `getCachedSpreadsheet_`). That one is always safe, a Spreadsheet object is a live
  handle, not a snapshot, and it applies on write paths too. One approver clicking an email link
  used to re-open the file ~13 times.
- Regression test: **`testSheetReadCache()`** (editor-run, self-cleaning).

### 🚩 Delegation exists, is ADMIN-MANAGED, and is single-hop

New **`Delegations`** sheet (`Delegation_ID, From_Email, To_Email, Start_Date, End_Date, Reason,
Is_Active, Created_By, Created_At`) + **`ACTED_BY`** appended to the end of `APPROVAL_COLS` (16),
`ISM_WORKFLOW_COLS` (19), `DIV_HEAD_CONFIG_COLS` (14), same append-at-the-end convention as
`ROUND_NUMBER`, so no existing index shifted.

**Why it was not just a lookup table.** The approver email is denormalized into the workflow row
at submit time, and *three* mechanisms key off it: the F-02 identity guard, **the HMAC review
token which is signed over that email**, and the row lookup. A delegate forwarded the original's
link fails all three, forwarding is not a workaround.

The fix resolves the delegate **at notify time, not at decision time**:

| Piece | File | Rule |
|---|---|---|
| `resolveDelegate_(email)` | `pia_code.js` | forward lookup, one hop. **Fails OPEN to "no delegate"**, a broken table must degrade to normal routing, never to "nobody is notified" |
| `delegatorsFor_(email)` | `pia_code.js` | reverse lookup, used only by authorization. **Fails CLOSED**, it is an auth decision |
| `canActAs_(caller, approver)` | `pia_code.js` | the widened F-02 predicate. **EXCLUSIVE**, delegation is resolved *first*, so while one is active the delegate is the only one who passes and the original is refused too. Empty table → collapses to a plain identity check |
| `recipientFor_(approver)` | `pia_code.js` | the single choke point every notify path uses, so recipient and token subject can never disagree |
| `writeActedBy_` | `pia_code.js` | records who really clicked; blank means they acted personally |
| `adminApi_getDelegations` / `saveDelegation` / `deleteDelegation` | `admin_code.js` | ISM CRUD. Column order **must** stay in step with `DELEGATION_COLS`, that is the cross-app contract |

- 🚩 **A delegation is a HANDOFF, not a second key.** While one is active the original approver
  can neither decide (`canActAs_` refuses them) nor see the handed-off Pending row
  (`isAuthorizedForApplication_` filters it). The first cut was additive and let both act, which
  meant two people could hold a valid link to the same Pending row and both click Approve, the
  loser of that race gets a bare "record not found" and `ACTED_BY` becomes ambiguous. **Do not
  reorder `canActAs_` to check same-person first**; that single change reopens the window.
- **View exclusivity is deliberately NARROWER than decide exclusivity.** Only a row that is both
  *mine* and still *Pending* disappears. Anything already decided, an earlier round of the same
  request, or any other request entirely, stays visible. Blanket-hiding would mean a two-week
  leave silently blanks out months of that approver's own past work, which reads as data loss.
- ⛔ **No self-service.** Approvers cannot appoint their own stand-in; that would let any approver
  quietly route their own approvals to a chosen colleague.
- ⛔ **No chaining.** A→B and B→C means A resolves to B, never C. Loop risk + accountability hole.
  If it is ever needed, add cycle detection first.
- Both addresses are `isAuthorizedDomain_`-checked, so a delegation can never send an approval
  link outside the company.
- **Not retroactive**, links are signed at send time. For a request already in an inbox, use
  Email Routing → Resend after adding the delegation.
- Fixed as a prerequisite: `processDivHeadDecision_`'s row lookup used a raw `.toLowerCase()`
  while the other two used `getNormalizedEmail_`. With delegation that inconsistency would have
  let the guard pass and then the row lookup miss.
- Regression test: **`testDelegationResolution()`** (editor-run, self-cleaning).

### 🚩 Retention ships INERT: two switches must both be thrown

`System_Configuration`: `RETENTION_ENABLED=FALSE`, `RETENTION_MONTHS=24`, `RETENTION_DRY_RUN=TRUE`.
**Both** `ENABLED=TRUE` and `DRY_RUN=FALSE` are required before one row is deleted.

- Lives in **Admin**, not Phase 1, a scheduled job needs `script.scriptapp` and a Drive purge
  needs `drive`. Admin has both; **Phase 1 has neither**, so putting it there would mean a new
  manifest scope and forced re-auth of the DCS app for every user.
- **Terminal-state only**, and both sides must be closed (a Complete PIA against a Returned DCS
  is still live). Age is measured from the request's **last decision**, not its submission.
- `getRetentionConfig_` fails safe in every direction, missing sheet, missing key, or an
  unparseable number all resolve to disabled + dry-run.
- Every run, dry or live, writes a `Risk_Audit` summary row. Drive files are **trashed**
  (30-day recovery), not hard-deleted. Sheet rows are gone for good and **not git-revertible**.
- `adminApi_runRetentionDryRun` passes `forceDryRun:true` unconditionally, so the UI button can
  never delete regardless of the stored config.
- **Folds in the dormant draft purge.** `Phase 1/Code.js:purgeExpiredDrafts()` was written for a
  daily trigger that was never installed (Phase 1 cannot create one). `purgeExpiredDraftsFromAdmin_`
  takes it over, and fixes a real bug: Phase 1's version filtered on `ExpiresAt` only, and DCS
  and PIA **share** the `Drafts` sheet, so it would have deleted PIA drafts too.

### 🚩 The weekly database backup (Admin, 2026-08-12) is FAIL-LOUD; keep it that way

The whole system lives in one spreadsheet with no independent export, so
`runDatabaseBackup` (Admin, weekly Sunday ~3am trigger via `setupBackupTrigger`, owner-gated
wrapper over `runDatabaseBackup_`) copies it to the `BACKUP_FOLDER_ID` folder (auto-created and
stored on first run), keeps the newest **8**, and trashes older ones (30-day recovery). Same
§8b rule-3 shape as `runRetentionSweep`. Two things future edits must not break:
- **Its catch block RETHROWS after writing the `Database Backup Failed` audit row**, the opposite
  of the retention sweep's log-and-continue. A backup job that fails silently is discovered on the
  day you need the backup; the trigger-failure digest email is the alarm. Do not soften it.
- It uses only `drive` + `scriptapp`, both already in Admin's manifest, so it forces no re-auth.
  Do not move it into Phase 1 or PIA (neither has the scopes; that was the retention lesson too).

- **`sanitizeCellValue_` (Admin) guards `exportToSheet` against formula injection.** That export
  is the *only* artifact in the system a human opens in the Sheets UI, so `=IMPORTXML(...)` stops
  being an inert string and runs as the admin. Applied as a `.map()` at both `appendRow`
  boundaries plus `setNumberFormat('@')`. Deliberately **not** applied to live-DB writes, those
  cells are `JSON.parse`d and the marker would be a correctness risk with no security gain.
- **`docs/design-tokens.css` is the canonical token source, pasted into SIX places**, the three
  frontends *and* the `getStyledHtmlWrapper_` block in each backend. The backend three are the
  ones everyone forgets and were the worst drift (navy `#1a3a5c` instead of `#1e3a5f`); that is
  the "Approve / Return" page a Division Head actually lands on. Resolved drift: radius unified
  to 4/9 (PIA was 6/12, Admin 10/14), PIA's hardcoded `--danger-text: #dc2626` back to the
  passthrough. ⚠️ The ~60 inline `#1a3a5c` hexes in email/certificate HTML were left alone on
  purpose, emails can't use CSS variables, and the cert goes through the legacy HTML→PDF engine.
- **Documents PREVIEW inline instead of force-downloading.** `downloadDcsFile` → **`viewDcsFile`**,
  which hands the bytes to `showFilePreview`, an in-page overlay. PDFs render in an `<iframe>`,
  images in an `<img>`, everything else (docx/xlsx) shows a "cannot be displayed" notice; a
  Download button is always present as the escape hatch. The server endpoint keeps the name
  `apiDownloadDcsFile`, it genuinely returns bytes, only the presentation changed.
  - ⛔ **Never `window.open(blobUrl)` here.** The apps are served inside Apps Script's sandboxed
    iframe: popups are blocked and a blob URL minted in that frame is not reliably navigable as a
    top-level document. Rendering into the *current* document is the only thing that works.
  - 🚩 **The blob URL is revoked in `closeFilePreview`, not after creation.** The old download-only
    path could revoke immediately; a preview cannot, because the `<iframe>`/`<img>` reads the URL
    for as long as it is on screen. Every exit route (X, backdrop, Esc, opening another file)
    funnels through `closeFilePreview`, miss one and the blob leaks for the life of the page.
  - The filename goes in via `textContent`, never `innerHTML`: it is user-supplied and the local
    escape helper differs between the three copies, so `textContent` is the portable safe choice.
  - **Three copies** (`Phase 1/index.html`, `Phase 2/pia_index.html`, and `getStyledHtmlWrapper_`
    in `pia_code.js`), edit together. The third sits inside a backtick template literal, so it
    must stay free of backticks and dollar-brace sequences. Verify a change there by *rendering*
    the wrapper and parsing the emitted `<script>`; `node --check` on the file cannot see that
    class of breakage (CLAUDE.md §8).
- **`icon(name, size)` replaced the last 7 emoji UI glyphs** with inline Lucide SVG using
  `currentColor`. It returns HTML, so it only works where the sink is `innerHTML`, through
  `textContent` or `summaryRow()` (which escapes) it renders as literal markup. In those places
  the glyph was dropped instead. **Leave `Logger.log` emoji alone**; they are useful grep anchors.
- **`parseAnyDate_` / `daysSince_` (Admin)** normalize the **four** date encodings that exist in
  this DB: `YYYY-MM-DD` (Notified/Reminder), en-PH locale strings (Decision/Submission), ISO
  (`Risk_Audit`), and epoch ms (drafts). Any new date maths must go through them. They return
  `null` for junk, never epoch-0, "unknown age" must not masquerade as "very old".
- **The aging report is round-scoped** (`keepCurrentRoundRows_`) because it asks "who acts
  next". Retention is **not** round-scoped because it asks "what happened". Same distinction as
  `rowMatches_`.

---

## 8d. The 2026-08-12 integrity pass: one header list per sheet

> §8c was about *who can reach what*. This is about the system **reading the wrong column and not
> complaining**. Six live defects, all the same failure mode. Read the three 🚩 rules before adding
> a column, a sheet, or a positional read anywhere.

### 🚩 `PIA_SCHEMA` is the ONLY place a PIA column order is written down

Before this, every sheet had **two** hand-synced sources of truth: a `*_COLS` index map and a
header array inside `initializeDatabase_` (three sheets had a *third* copy in a self-heal block).
Nothing enforced agreement. That is not hypothetical, it is how the `ActedBy` defect happened:
the §8c delegation work added `ACTED_BY` to three index maps and missed all three header arrays
plus two hardcoded `expectedCols` widths, so delegated decisions wrote under a **blank header**.

```js
const PIA_SCHEMA = { 'Approval_Workflow': ['ApprovalID','SessionID',…,'ActedBy'], … };  // 12 sheets

const APPROVAL_COLS = colsOf_('Approval_Workflow', {   // derived, never hand-numbered
  SESSION_ID: 'SessionID', STATUS: 'Status', ACTED_BY: 'ActedBy', …
});
```

- `colsOf_(sheetName, aliases)` returns **1-based** indices (matching `getRange`) and **throws** if
  an alias names a header that does not exist. The 440 existing `data[i][COLS.X - 1]` reads were
  left alone on purpose: deriving the map fixes the drift at its source without touching every call
  site. The conversion was proven safe by comparing all 129 derived indices against git HEAD, 128
  byte-identical, the 1 delta being the intentional removal of a dead `REMARKS` key.
- **Adding a column: append to the `PIA_SCHEMA` array, add the alias, done.** Creation, validation
  and lookup all follow. Still append at the END, and still never reorder.
- ⚠️ **Rename FUNCTIONS and headers, never DTO property keys.** Unchanged from §8b, and a call-graph
  checker cannot catch a broken property key.

### 🚩 Drift now fails LOUDLY, and live sheets repair themselves once

- `assertSheetSchema_(sheetName, sheet)` compares the live header row to `PIA_SCHEMA` and **throws**
  on mismatch. Wired into `getDatabaseSheet_`, memoized per execution (one header read per sheet).
  It is a **prefix** check: extra trailing columns someone added by hand are tolerated (they cannot
  shift anything the code addresses), a renamed/reordered/missing column is fatal. It is **silent on
  a missing sheet**, creation is `initializeDatabase_`'s job and several callers legitimately probe.
- ⛔ **Never "fix" a drift error by reordering `PIA_SCHEMA` to match a mangled sheet.** The error
  message says so. Reordering makes every historical row read wrong.
- `healSheetHeaders_()` repairs an existing database, run once from `doGet` behind
  `HEADER_HEAL_FLAG_PROP`. It **walks `PIA_SCHEMA`** rather than a hand-listed set, and only writes
  a cell that is **blank** or holds a value listed in its small `RENAMES` map; anything else is
  logged and left alone, so it can never clobber a deliberate rename. It reads through the raw
  spreadsheet handle, never `getDatabaseSheet_`, which would run `assertSheetSchema_` and throw on
  the very drift being repaired. `repairSheetHeaders()` is the owner-gated editor wrapper. Delete
  the script property to force a re-run.
  - 🔴 **The first version was hand-listed and was wrong on the live database.** It repaired
    `ActedBy` but not `RoundNumber` / `FlaggedFields`, because it assumed those had shipped on
    2026-08-11. They had not: that batch was committed but never deployed, so the live workflow
    sheets were **three** columns short, not one. Hand-listing the repair reintroduced the exact
    duplicate-source-of-truth problem this section exists to remove. Deriving it from `PIA_SCHEMA`
    means a column added later is healable with no edit.
- Regression test: **`testHeaderSchema()`** deliberately renames a column, asserts the check throws,
  and restores it in a `finally`.
  - 🔴 **This test also shipped broken, and the failure is worth remembering.** It resolved each
    sheet via `getDatabaseSheet_`, which **throws** on drift; the throw left the handle null and the
    next branch reported `SKIP (absent or empty)` without counting a failure. Against a live
    database missing 11 header cells across 5 sheets it printed **"19 passed, 0 failed."** A test
    for silent drift that itself fails silently is worse than no test. It now resolves through the
    raw spreadsheet handle, so drift is an explicit **FAIL** and `SKIP` means genuinely absent.

### 🚩 The seven defects, and the one thing they had in common

| Defect | Symptom | Origin |
|---|---|---|
| `ACTED_BY` missing from 3 header arrays + 2 `expectedCols` | delegated decisions written under a blank header; Admin cannot report who acted | introduced by §8c |
| `Data_Collection` col 11 named `Remarks` by PIA, `Metadata_Agency` by DCS | whichever app created the sheet won; if PIA did, **agency metadata is invisible in Admin** (it resolves by name) | pre-existing |
| `adminView.html` read `ApproverFlags`, header is `Approver_Flags` | **Flags tab and its count badge always read 0** | pre-existing |
| `Code.js` read `freshData[5]`/`[6]` on a range starting at **column 2** | every revision clobbered `oldMetadata`, resetting `revisionCount` to 1 and **dropping the superseded-document trail** | pre-existing |
| `INFOSEC_CONFIG` `expectedCols` stale | init reports a valid sheet as invalid | pre-existing |
| `Drafts` header is `SavedTimestamp`, documented as `SavedAt` | found while deriving; no map existed in either project | pre-existing |
| `InfoSec_Email_Config` col 6 is `jobPos` live, `JobPos` in the schema | case-only, but `assertSheetSchema_` compares **exactly**, so it throws on a core routing sheet. Found only by reading the live export, not by any test | pre-existing |

**Not one of them threw.** Every single one returned plausible wrong data. That is the argument for
the whole change: converting silent misreads into loud failures is worth more than any individual
fix above.

🚩 **And the meta-lesson, learned twice in one session.** Both the repair (`healSheetHeaders_`) and
the test (`testHeaderSchema`) shipped wrong, in the same direction: each was written against what
the schema *said* rather than what the live database *held*, and each failed quietly. The live
export settled in one read what two rounds of reasoning had guessed at. **Before trusting a schema
migration, dump the live header rows and diff them.** Row 1 of every sheet is enough, and it
carries no personal data.

### Also in this pass

- **Em dashes are gone** from source comments, user-facing copy and docs (house rule, `~/.claude/CLAUDE.md`).
  ⚠️ **Empty-state placeholders are deliberately kept**: a bare `'—'`, `>—<`, `>—%<` means "no value"
  and is not prose. They survive because they have no adjacent whitespace, which is what the sweep
  pattern keyed on. A capital letter after a dash takes a **colon**, not a comma, or you get a comma
  splice in a user-visible string (`Request submitted, Proceed to Phase 2`).
- `migration-context/reference-docs/` is an **archive** of snapshots. Do not rewrite it in a sweep.

---

## 9. Session start ritual for this project

State the goal ("Today's task: [the supervisor's specific design change]"), confirm it's
design-only, then locate the exact `render*()` function or CSS block before editing.
Smallest safe change. Preserve all existing behavior.
