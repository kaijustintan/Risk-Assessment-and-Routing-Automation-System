# Part 1: DCS (Phase 1, Data Collection System)

> The request form. For anything shared across apps (architecture, schema, deployment,
> security, glossary) see **[Part 0: Common Reference](part-0-common.md)**. This file
> covers only what is specific to DCS.
>
> Source files: `Phase 1/index.html` (frontend), `Phase 1/Code.js` (backend),
> `Phase 1/*_appsscript.json` (manifest).

---

## §1.1: End-user guide 🧑

### Accessing the system
1. Open the DCS web-app link (from email or the company portal).
2. Sign in with your **corporate Google Workspace account**. Personal accounts (Gmail,
   Yahoo, etc.) are blocked, see the domain gate in [§0.6](part-0-common.md#06--security-model).
3. The landing page offers two choices: **New DCS Request** or **Review Applications**.

### Starting a new request
The form is a guided flow across several screens (each rendered by JavaScript at runtime,
see [§0.5](part-0-common.md#05--known-gotchas--debugging)):

1. **Step 1: Guidelines:** review purpose & Terms and Conditions (a countdown pop-up), then
   download any required templates from the **7 available forms** (see the list in
   [§1.2](#12--maintenance-)). Tick the agreement box and **Proceed to Form**. If you have
   saved drafts, you'll be prompted to resume or start fresh.
2. **Step 2: Details:** Full Name, **Office/Site** (required, one of **AGT / GDP / EGP / TWS**),
   Department, **Access Type** (Internal / External), **iHelp Reference** (required, numbers only);
   a **"This request involves a(n)"** dropdown, **None / Agency / OJT**. Choosing **OJT**
   auto-sets Access Type to **External** and locks it. Add up to 5 **Accountable Persons**; enter
   approver emails (Immediate Head, Department Head, optional Division Head). *(Required fields are
   marked with a red asterisk.)*
3. **Upload documents**, the required upload changes with your selections:
   - **Internal** → Data Protection Agreement (DPA)
   - **External** → NDA + DSA
   - **Agency** → Confidentiality Undertaking + **Agency** Endorsement Letter
   - **OJT** → Confidentiality Undertaking + **School** Endorsement Letter
   - Accepted: PDF/DOC/DOCX, ≤10 MB each. *(The endorsement-letter label changes to "School"
     or "Agency" live, based on the dropdown.)*
4. **Agency Details** (only when the dropdown = **Agency**): **Request Type: New or Replacement**
   (a *Replacement* also asks for the replaced person's full name + email, for DCOPS); agency name,
   personnel, contract start date, **Network Drive to access (required)**, and optional recovery
   contact. *(OJT skips this screen: straight to the summary.)*
5. **Step 3: Review:** check the summary cards; **Edit Details** to fix anything; **Submit
   Request**.
6. **Success:** confirmation with your **Application ID** (e.g. `DCS-000042`) and, if
   available, a direct **Proceed to Phase 2** link into PIA.

### Tracking your application
**Review Applications** lists your requests with name, Application ID, a color-coded status
badge, submission date, and any approver remarks. Click a request for full details.

### Viewing request details
A request's detail screen shows:
- **Summary card**, everything you submitted.
- **Uploaded documents**, one per row, each with a **"View"** button that opens the file in the
  **Google Drive viewer in a new tab** *(Wave 4 update, 2026-08-14; was plain filenames in V1,
  then briefly an in-page preview overlay, which had to be abandoned)*.
  > ℹ️ **If nothing opens, your browser blocked the pop-up.** The button falls back to
  > downloading the file instead, so you still get the document either way.
  >
  > 🚩 **Why not preview it on the page?** It was tried and it cannot work here. Chrome refuses
  > to render document bytes inside the sandboxed frame Apps Script serves the app in, both in an
  > `<iframe>` and in an `<object>`. Files stay private at upload and are shared with the company
  > **only** at the moment an authorised person opens one.
  >
  > ⚠️ **Before you submit**, the Section 3 review screen shows document **names only**, not links.
  > That is not a bug: the files have not been uploaded yet, so there is nothing to link to. They
  > become clickable on this screen after submission.
- **Approval Workflow tracker** and **ISM / DivHead tracker** (Phase 2 progress).
- **Overall Progress Timeline**, the **5 stages**: DCS Request → PIA Assessment → Heads
  Approval → ISM Approval → Certification (see [§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline)).

### Editing a returned application
If an approver **returns** your request: open it from Review Applications (yellow "Returned"
badge + a note), click **Edit and Resubmit**, update the flagged fields (look for red flag
icons with tooltips), **re-upload** documents (files are not kept in drafts), then
**Resubmit**. *Return ≠ Deny: see [§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline).*

### Saving drafts
Progress auto-saves (a "Saving…" indicator shows bottom-right). Drafts expire after **7
days**; up to **5** at a time. Files are **not** saved in drafts (re-upload on resume, this
is intended, [§0.5](part-0-common.md#05--known-gotchas--debugging)).

### DCS status badges
| Badge | Meaning |
|-------|---------|
| Pending | Awaiting initial review by Immediate Head |
| Approved | Approved at the current step |
| Returned | Needs revision: edit & resubmit |
| Denied | Rejected (terminal) |
| Escalated | Sent to Division Head |
| Ready for Phase 2 / Processing | DCS cleared, proceed to PIA |
| Fully Certified | All phases complete |

*(Reminder from [§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline): these
badges are computed in the frontend, not stored strings.)*

---

## §1.2: Maintenance 🛠

### Script Properties (DCS project)
*(Deployment itself: follow the golden rule in [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls), never "New deployment.")*

| Property | Required | Holds |
|----------|----------|-------|
| `DB_ID` | Yes | Spreadsheet ID of the shared database |
| `ADMIN_FOLDER_ID` | Yes | Drive folder for uploaded NDA/DPA/DSA/CU files |
| `PIA_APP_URL` | Yes | Live **PIA** `/exec` URL ("Proceed to Phase 2" button) |
| `DCS_WEB_APP_URL` | **No, not read by code** | Nominally the live **DCS** `/exec` (self-reference). See the note below. |
| `DOMAIN` | Yes | Corporate domain, no `@` (e.g. `megaworldcorp.com`) |

> ⚠️ The old DCS manual listed an `HMAC_SECRET` property. It is a **misnomer**: DCS does no
> token signing. The signing secret is `SYSTEM_SECRET` and lives in the **PIA** project
> ([§0.6](part-0-common.md#06--security-model)).

> ⚠️ **`DCS_WEB_APP_URL` is not read anywhere in the DCS project.** Verified: zero occurrences in
> `Phase 1/Code.js` and `Phase 1/index.html`. It was previously documented as Required, which is
> wrong, nothing breaks if it is absent, and setting it changes no behavior. The property that
> genuinely matters is the **PIA** project's own `DCS_WEB_APP_URL`, which powers the applicant's
> "View DCS Submission" link ([§2.2](part-2-pia.md#22--maintenance-)). Leave any existing DCS-side
> value in place: it is harmless, and deleting a live Script Property has no upside.

### Downloadable templates (7 forms)
The Step-1 download buttons are driven by the `DOWNLOADABLES` array in `renderGuide()`
(`Phase 1/index.html` ~line 4034). The actual link for each is admin-managed via a
`LINK_*_TEMPLATE` row in the `System_Configuration` sheet (generic passthrough, no backend
code change needed). A missing row shows "Link not set" (`#`). **To add or remove a form**, see
the end-to-end procedure below the table.

| `System_Configuration` key | Form (display name) | Audience |
|----------------------------|---------------------|----------|
| `LINK_NDA_EMPLOYEE_TEMPLATE` | Non-Disclosure Agreement for Employee | employees / internal |
| `LINK_DSA_TEMPLATE` | Data Sharing Agreement | external / third-party |
| `LINK_DPA_MEGAWORLD_TEMPLATE` | DPA for Megaworld Employee | DPA (Megaworld) |
| `LINK_DPA_LUXURY_GLOBAL_TEMPLATE` | DPA for Luxury Global Employee | DPA (Luxury Global) |
| `LINK_DPA_GLOBAL_ONE_TEMPLATE` | DPA for Global One Employee | DPA (Global One) |
| `LINK_CU_AGENCY_TEMPLATE` | Confidentiality Undertaking for Agency | agency personnel |
| `LINK_CU_OJT_TEMPLATE` | Confidentiality Undertaking for OJT | OJT / interns |
| `LINK_TC_PAGE` | *(not a form)* Terms & Conditions page | T&C modal |

*(The two Confidentiality Undertaking forms render with a distinct amber color + "person-with-check"
icon to set them apart from the NDA/DPA/DSA forms.)*

#### Adding a new downloadable form (end-to-end)
A new form is added in **two apps** and then given a link, three edits, then redeploy both:

1. **DCS, `Phase 1/index.html`.** Add an entry to the `DOWNLOADABLES` array in `renderGuide()`
   (~line 4033). This makes it appear in the Step-1 download list:
   ```js
   { configKey: 'LINK_YOURKEY_TEMPLATE', title: 'Your Form Name', descSet: 'Short audience note',
     descStyle: '', iconStyle: 'background:#eff6ff;border-color:#93c5fd;color:#2563eb;',
     icon: '<svg …></svg>' },
   ```
2. **Admin, `Admin/adminView.html`.** So ISM can set/edit the link in **Settings → System Links**,
   make **both** of these edits:
   - Add an input field to the **System Links** card (~line 2073):
     `<div class="form-group"><label>Your Label</label><input type="url" id="cfg-LINK_YOURKEY_TEMPLATE" placeholder="https://..."></div>`
   - Add the **same key** (`LINK_YOURKEY_TEMPLATE`) to the key array inside `saveSettings()`
     (~line 6726). ⚠️ The field alone will *display* a value but silently **won't save** edits
     without this.
3. **The link value.** Add a `System_Configuration` row, key `LINK_YOURKEY_TEMPLATE`, value = the
   file URL: or just fill the new Admin field and **Save**. No backend code change is needed;
   `apiGetSystemConfig` / `saveConfigData` pass any key through.
4. **Redeploy both** the DCS and Admin projects (Edit → New version,
   [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).

> ⚠️ **No stray spaces in the link value.** The `System_Configuration` value must be the clean URL
> only (`https://…`, never `␣https://…`). A leading/trailing space makes the link invalid, the DCS
> **Download** button won't open the file, and the value may not display correctly in Admin Settings.
> The Admin Settings form auto-trims on Save; pasting straight into the sheet does **not**.

### Email
DCS sends **exactly one** email: `notifyDcsRequester_` (~`Code.js:1705`), the styled
*"Request submitted: Proceed to Phase 2"* confirmation, fired inside `submitDCS` in a
try/catch failsafe, with a `?parentID=` deep-link into PIA. (All other RARS email lives in
PIA / Admin: [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls).)

### Routine tasks
- Monitor GAS **Executions** for API failures.
- Verify old drafts auto-expire (7-day TTL).
- Update template links via `System_Configuration` as needed.
- Confirm uploaded files remain accessible in the `ADMIN_FOLDER_ID` Drive folder.

---

## §1.3: Developer handover 👨‍💻

### Frontend (`Phase 1/index.html`)
Single-page app, vanilla JS, no frameworks. Screens are `<div>`s that are **empty in the
HTML** and filled by `render*()` at runtime, search the render function, not the markup
([§0.5](part-0-common.md#05--known-gotchas--debugging)). CSS uses design tokens in `:root`
(navy palette, `--radius`, motion vars). Responsive breakpoints at **768px** and **480px**.

**The 9 screens** (swapped by `show(name)`):

| Screen | Purpose | Render fn (approx) |
|--------|---------|--------------------|
| landing | Home: New Request vs Review Applications | `renderLanding()` ~2791 |
| guide | Step 1: intro, T&Cs, template downloads | `renderGuide()` ~3043 |
| form | Step 2: main input form | `renderForm()` ~3217 |
| agency | Step 2b: extra fields (agency only) | `renderAgency()` ~4019 |
| summary | Step 3: review before submit | `renderSummary()` ~4108 |
| success | Confirmation + DCS ID | `renderSuccess()` ~4375 |
| drafts | Resume / disregard drafts | `renderDrafts()` ~2917 |
| requests | "My Applications" list + legend | `renderRequests()` ~4410 |
| request-details | One request's timelines + comments | `renderRequestDetails()` ~4593 |

Other key fns: `show()` (router), `validateDCSForm()`, `triggerAutoSave()`,
`submitRequest()`, `editReturnedApplication()`, timelines `renderApprovalTracker()` /
`renderPiaTimeline()`. *(Line numbers drift: treat as hints.)*

### Backend (`Phase 1/Code.js`, ~2,670 lines)
Functions prefixed `api*` are callable from the frontend; trailing-underscore fns are
private.

**Server API contract** (read the function before relying on a field):
- `apiGetSystemConfig()` → `{success, config:{DOMAIN, LINK_*_TEMPLATE, …}}`
- `apiGenerateNewSessionId()`
- `apiSaveDraft(sessionId, stateData)` · `apiRestoreDraft` · `apiListUserDrafts` · `apiDeleteDraft`
- `submitDCS(payload, sessionId)` → `{success, reqId, phase2Url?}`
- `apiListUserRequests()`
- `apiGetRequestData(reqId)` (form data + approvers + timelines)
- `apiGetReturnedApplication(reqId)` (revision flags)

### Data flow: how a request is processed
1. User fills the form; frontend calls `submitDCS(payload, sessionId)` via `google.script.run`.
2. Backend validates + sanitizes server-side ([§0.6](part-0-common.md#06--security-model)).
3. Files upload (base64) to Drive (`ADMIN_FOLDER_ID`).
4. Metadata → `Data_Collection`; cross-ref → `Applications`; approver rows → `Approval_Workflow`.
5. Draft cleaned up; risk auto-flags (`analyzeDCSRisk()`) written to `Risk_Audit`.
6. `notifyDcsRequester_` confirmation email sent; success returns `reqId` (+ `phase2Url`).

### Key design notes
Vanilla JS (GAS has no npm); `TextFinder` over `getDataRange()` for speed; `LockService` for
concurrency; base64 file transfer (only way through `google.script.run`); filenames cleared
on draft restore (files aren't stored); sanitize on both client and server.

### Revision mode
`state.isEditing = true` highlights flagged fields and forces re-upload of **flagged files
only**, non-flagged files stay in Drive.

> ⚠️ **Revisions submitted before 2026-08-12 lost their document history.** `submitDCS` read the
> stored metadata from the wrong two columns (a range starting at column 2 was indexed as though it
> started at column 1), so on every revision the previous metadata was overwritten with the file-ID
> list instead of merged. Two consequences, both silent: the **revision counter reset to 1** on each
> resubmit, and the **superseded-document trail was dropped**, so a replaced NDA/DPA/DSA was no
> longer recorded as having been replaced. Fixed. The **files themselves were never deleted**, they
> remain in the Drive folder; it is the record of *which version superseded which* that was lost for
> those revisions and cannot be reconstructed from the sheet. Recent revisions are worth spot-checking
> against the Drive folder if a superseded document matters to an audit.

---

## §1.4: Troubleshooting

### For end users
| Problem | Solution |
|---------|----------|
| "Access Denied" | Sign in with your corporate account; try an incognito window. |
| Can't upload a file | Must be PDF/DOC/DOCX and ≤10 MB. |
| "Files need to be re-uploaded" | Resuming a draft doesn't keep files, re-attach them. |
| Form won't submit | Check required fields (red flags) and that emails are valid. |
| Can't see my requests | Sign in with the same account you submitted with. |
| Draft lost | Drafts expire after 7 days; start over if older. |
| "Maximum 5 drafts" | Submit or delete existing drafts first. |

### For administrators
| Problem | Solution |
|---------|----------|
| "Script property not set" | Add the missing key in Project Settings → Script Properties ([§1.2](#12--maintenance-)). |
| Emails not sending | Check approver emails; confirm the DCS confirmation email path (`notifyDcsRequester_`). |
| Slow performance | Large sheets slow scans; consider archiving old records. |
| File upload fails | Check the `ADMIN_FOLDER_ID` folder exists and has space. |
| Deployment "not updating" / links dead | You likely clicked **New deployment**. See the golden rule, [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls). |
| Page is blank with a parse error | Suspect GAS template-literal serve corruption, [§0.5](part-0-common.md#05--known-gotchas--debugging). |

---

*← [Part 0](part-0-common.md) · Next: [Part 2: PIA](part-2-pia.md) →*
