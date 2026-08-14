# V2: Difference from V1 (Old System)

> **What this document is.** Megaworld's **RARS** (Risk Assessment & Routing System), the
> DCS → PIA → Admin pipeline, was **already built by a previous intern (V1)**. I was tasked to
> **finalize, fix, and polish it (V2)**. This document captures *everything* changed or added in
> the V2 pass versus the original V1, written for use as context in a follow-up documentation
> session. Explanations follow **Layman → Technical → Scenario**, and each item emphasizes the
> **V1 (before) vs V2 (after)** difference.

---

## Table of Contents

**Orientation**
1. [System Overview (what RARS is)](#1-system-overview)
2. [V1 → V2 At a Glance](#2-v1--v2-at-a-glance) · incl. [2.1 The three delivery batches](#21-the-three-delivery-batches)

**🅐 BATCH 1: Initial scope and early feedback** *(June 15 to July 6)*

3. [Supervisor-Requested Work (achieved)](#3-supervisor-requested-work-achieved)
4. [Bonus Features & Fixes (beyond what was asked)](#4-bonus-features--fixes-beyond-what-was-asked)
5. [The Journey: Key Iterations & Decisions](#5-the-journey--key-iterations--decisions)
6. [Pending Inputs from Sir: Spoonfed Edit Guide](#6-pending-inputs-from-sir--spoonfed-edit-guide)
7. [Architecture, Deployment & Verification Notes](#7-architecture-deployment--verification-notes)
8. [Documentation Pass (V1 vs V2 code docs)](#8-documentation-pass)
9. [Tester Waves 1-2, and the Post-Demo Rounds](#9-tester-waves-1-2-and-the-post-demo-rounds)

**🅑 BATCH 2: July 9 meeting revisions** *(July 14 to 17)*

10. [The July 9 Meeting Batch](#10-the-july-9-meeting-batch)

**🅒 BATCH 3: Hardening, integrity, and the live test passes** *(August 11 to 14)*

11. [Wave 3: Hardening, Integrity & the Live Test Passes](#11-wave-3--hardening-integrity--the-live-test-passes)

---

## 1. System Overview

**Layman:** RARS is Megaworld's online "request → assess → approve" pipeline for getting access
to company data. It is **three separate web apps that act as one flow**, all sharing **one Google
Sheet as their database**:
- **Phase 1: DCS** (Data Collection System): the request form. You apply + attach legal docs.
- **Phase 2: PIA** (Privacy Impact Assessment): the privacy questionnaire after DCS clears.
- **Phase 3: Admin**: the ISM (InfoSec) control tower, dashboard, email routing, settings.

**Technical:** Three **independent Google Apps Script (GAS) web apps**, each its own project +
deployment + manifest. They never call each other directly, they coordinate **only through the
shared Google Spreadsheet** (`Data_Collection`, `Applications`, `*_Approval_Workflow`, `Drafts`,
`System_Configuration`, `Risk_Audit`, `Email_Queue`, …). DCS hands off to PIA via the `PIA_APP_URL`
script property. Each phase is deployed separately by manual copy-paste into its GAS project.

**Repo layout (organized during V2):** `Phase 1/` (DCS), `Phase 2/` (PIA), `Admin/` (Phase 3),
`docs/`, `CLAUDE.md`. Files: `index.html`+`Code.js` (DCS), `pia_index.html`+`pia_code.js` (PIA),
`adminView.html`+`admin_code.js` (Admin), plus per-phase `appsscript.json` manifests.

---

## 2. V1 → V2 At a Glance

| Area | V1 (Old) | V2 (Now) |
|------|----------|----------|
| App branding | "Data Collection System" | "Privacy Impact Assessment" + "Megaworld Corporation" footer |
| Greeting | none | "Hello, `<Surname>`!" headline on 5 screens |
| Request categories | single "Agency" checkbox | dropdown **None / Agency / OJT** |
| Downloadables | 4 hardcoded blocks | array-driven, now **7 audience-named forms** incl. per-entity DPA (Megaworld / Luxury Global / Global One) + CU for Agency & OJT, admin-manageable *(see §9.1)* |
| Stakeholder section (PIA) | always shows Internal **and** External | shows only the relevant one (by access type) |
| Emails (Admin) | plain text | professional navy HTML card |
| Emails (PIA) | Arial + blue, inconsistent | unified navy card style |
| Approval reminders | **two** engines (Admin + PIA) silently overlapping | **one** (PIA's, the better one); Admin duplicate removed |
| Post-submit notification | none (in-app button only) | styled "Proceed to Phase 2" email |
| Application Requests list | no filtering | search + status filter |
| Status badge after PIA submit | wrongly stayed "Ready for Phase 2" | correctly "PIA In Progress" |
| Code documentation | inconsistent / Taglish / sparse | full English doc format, ~455 functions |
| Form labeling | generic "Click to download"; static "Endorsement Letter" | audience tags per form + type-aware "School / Agency Endorsement Letter" |
| Callable backend surface | 178 of 229 functions reachable from any employee's browser console | **82 public, none unguarded** *(see §11.1)* |
| Uploaded NDA/DPA/DSA files | published to **anyone on the internet** with the link | owner-only; shared with the company only at the moment an authorised person opens one *(§11.2)* |
| Resubmit after a Return | prior approval rows **deleted**, history kept as a lossy photocopy | **append-only rounds**; nothing is ever deleted *(§11.3)* |
| Error messages | raw Google exceptions, quoting the spreadsheet and Drive folder IDs | one `{ok, code, message, ref}` shape; real exception logged, user gets a reference code *(§11.4)* |
| Column positions | index map + header list hand-synced per sheet, silently drifting | **one header list per sheet**, indices derived, mismatch fails loudly *(§11.5)* |
| HTML escaping (DCS) | `escapeHtml` shipped as an **identity no-op**, the sole XSS defence for 71 sites | genuinely escapes; enforced by a checker *(§11.6)* |
| Pre-deploy verification | `node --check` only | **five checkers**, auditing behaviour as well as names *(§11.7)* |
| Approval history | different shape on every surface | one format across 5 emails, 2 review pages, 2 certificates, 2 apps *(§11.9)* |
| Data retention & backup | nothing ever deleted; no independent backup | retention sweep (ships **off**) + fail-loud weekly backup *(§11.4)* |

---

### 2.1 The three delivery batches

> **Read this first if you are writing or reviewing a progress report.** The V2 work did not
> arrive as one push. It arrived as **three distinct batches**, each triggered by a different
> event, and the rest of this document is ordered to match.

| | Batch | Trigger | Dates | What it is | Sections |
|---|---|---|---|---|---|
| 🅐 | **Initial scope and early feedback** | The original handover, then testing and a demo | **2026-06-15 to 07-06** | The requested scope, delivered ~3 weeks in, then four successive rounds of feedback from testers and the post-demo review | §§3-9 |
| 🅑 | **July 9 meeting revisions** | The **July 9 meeting** with Sir Darwin | **2026-07-14 to 07-17** | Nine explicitly requested items, plus eleven fixes found while building them | §10 |
| 🅒 | **Hardening, integrity, live tests** | An adversarial code read, then two live test passes | **2026-08-11 to 08-14** | Security, data-integrity and correctness work, plus the first end-to-end runs by a real reviewer | §11 |

**Timeline in one line:**

```
Jun 15 ────── Jul 6        Jul 9 ──── Jul 14-17         Aug 11 ──── Aug 14
│                  │        │              │              │             │
🅐 initial scope   │     MEETING          🅑           adversarial      🅒
   + 4 feedback  demo                 revisions         read      + 2 live tests
   rounds
```

**Delivery counts.** Across batches 🅐 and 🅑 (the period covered by the Week 8-9 report):

| Category | Count |
|---|---|
| New features delivered | **40** |
| Fixes to the pre-existing / inherited V1 system | **39** |
| Fixes to my own newly built work | **17** |
| **Subtotal, batches 🅐 + 🅑** | **96** |
| Batch 🅒 items (August) | **24** |
| **Total shipped** | **120** |

> ℹ️ **On the numbers.** `docs/DCS-PIA-Admin - Features and Fixes List.md` counts **94** for the
> same June-to-July period rather than 96, because it excludes 13 planning, documentation and
> audit entries that do not fit a "how to test" format, and splits a few items differently. Both
> counts are defensible; **use one of them consistently** in any report rather than mixing them.

> 🚩 **Context for the timeline.** The project was handed over in the **2nd week of June** and the
> **originally requested scope was complete about 3 weeks in**. Everything after that, which is the
> majority of the elapsed time and roughly two thirds of the shipped items, came from **subsequent
> rounds of feedback, revision and additional requests** that surfaced through continued testing
> and review. That pattern is the single most important thing the timeline shows.

---

# 🅐 BATCH 1: Initial scope and early feedback
*June 15 to July 6, 2026. Sections 3 to 9.*

---

## 3. Supervisor-Requested Work (achieved)

> These map to the notes sir/the supervisor handed over. Each: **Layman · Technical · Scenario ·
> V1→V2 · Where.**

### 3.1 Rebrand DCS → "Privacy Impact Assessment"
- **Layman:** The app used to be called "Data Collection System" everywhere; now it reads
  "Privacy Impact Assessment," and the footer says "Megaworld Corporation."
- **Technical:** Replaced 7 user-visible strings in `Phase 1/index.html`, `<title>`, landing `<h1>`,
  logo aria-label, the guide `<h1>` ("Data Collection Guide & Terms" → "Privacy Assessment
  Instructions"), and 3 request-status strings. Footer: "Company Workspace · Data Collection System
  Phase 1" → "Megaworld Corporation · Privacy Impact Assessment · Build vX".
- **V1→V2:** V1 was branded "DCS"; V2 is branded "Privacy Impact Assessment / Megaworld Corporation."
- **Scenario:** A user opens the link, browser tab, homepage title, and footer all say "Privacy
  Impact Assessment / Megaworld Corporation."

### 3.2 Personalized greeting "Hello, `<Surname>`!"
- **Layman:** Each main screen now greets the logged-in user by surname, big and visible.
- **Technical:** `deriveSurname(email)` + `greetingLine()` in `index.html`. Megaworld emails follow
  `<initials><surname>[.suffix]`, so it **strips the 2 leading initials then takes the surname up to
  any separator** (e.g. `abcruz.global@…` → "Cruz", `xydelacruz@…` → "Delacruz"). Rendered at
  `clamp(1.35rem … 1.9rem)`, bold navy, on landing/guide/form/drafts/requests. Identity comes from the
  existing `getUserIdentity()` (email only: GAS exposes no display name).
- **V1→V2:** V1 had **no greeting**. V2 has a prominent personalized one.
- **Scenario:** `xydelacruz` logs in → every main screen shows **"Hello, Delacruz!"**

### 3.3 OJT downloadable (5th template)
- **Layman:** Added a 5th downloadable form, "OJT Confidentiality Undertaking."
- **Technical:** Refactored the 4 hardcoded download blocks into a single `DOWNLOADABLES` array in
  `renderGuide()`; added a 5th entry `{ configKey: 'LINK_OJT_NDA_TEMPLATE', title: 'OJT
  Confidentiality Undertaking' }`. The link resolves from the `System_Configuration` sheet (admin-set).
- **V1→V2:** V1 had 4 hardcoded forms; V2 has 5, list is array-driven (one-line add/remove).
- **Scenario:** Guide screen shows 5 downloads; the OJT one links to whatever URL the admin set.

### 3.4 Section-1 guide title rename
- **Layman:** Guide-screen heading changed to "Privacy Assessment Instructions."
- **Technical:** `index.html` renderGuide `<h1>` (currently ~line 4041).
- **V1→V2:** "Data Collection Guide & Terms" → "Privacy Assessment Instructions."

### 3.5 Internal vs External: show only what applies
- **Layman:** If a DCS request is "Internal," the external-only upload (DSA) doesn't show.
- **Technical:** Already gated on `access === 'External'` at render/toggle/validation, verified, then
  hardened (see bonus 4.2). In PIA, made the **Stakeholder Identification** section mutually exclusive:
  Internal request → only Internal stakeholders; External → only External (`renderPIA3` + `savePIA3`
  in `pia_index.html`, driven by `state.dcsData.access`).
- **V1→V2:** V1's PIA always showed **both** internal and external stakeholder cards; V2 shows only
  the relevant one.
- **Scenario:** External request → PIA Section 3 shows only "External Stakeholders."

### 3.6 OJT category (checkbox → dropdown)
- **Layman:** The "This request involves an Agency" checkbox became a dropdown: **None / Agency / OJT.**
  OJT requires a **Confidentiality Undertaking** + an **Endorsement Letter** (no agency-detail fields).
- **Technical:** `index.html`, `state.dcs.isOJT` added alongside `isAgency`; checkbox replaced by
  `<select id="dcs-involvement">` styled with the standard `.field` pattern; CU label + endorsement
  wrapper show for `isAgency || isOJT`; OJT skips the agency-details screen → straight to summary;
  payload sends `agencyData = { type:'OJT', endorsementLetterFile }`. `Code.js submitDCS` branches on
  `payload.agencyData.type`, for OJT it skips agency-field validation and stores `{type:'OJT',
  endorsementLetter}` in the `Metadata_Agency` column. PIA reads that metadata generically, so **no PIA
  change needed**.
- **V1→V2:** V1 had only a binary agency flag; V2 supports a real category (OJT) with its own required
  attachments, end-to-end (frontend + backend).
- **Scenario:** Pick "OJT" → main doc relabels to "Confidentiality Undertaking," endorsement required,
  no agency screen; submit stores `type:'OJT'`.

### 3.7 Admin-manageable downloadables (OJT link)
- **Layman:** An admin can now set the OJT download link from Admin → Settings (no sheet editing).
- **Technical:** `adminView.html`, added an "OJT NDA Template Link" field (`cfg-LINK_OJT_NDA_TEMPLATE`)
  + its key in `saveSettings()`. `admin_code.js saveConfigData()` was taught to **append** new config
  keys (see bonus 4.7), so a brand-new `LINK_OJT_NDA_TEMPLATE` row is created on first save.
- **V1→V2:** V1's Settings only had NDA/DPA/DSA/T&C links and could only **update existing** rows; V2
  adds the OJT link and can **create** new config rows.

### 3.8 Daily approval reminder (8am, COC-style)
- **Layman:** A reminder emails the approver who hasn't acted yet, daily at 8am, like the COC portal.
- **Technical:** This was the trickiest (see Journey 5.3). I first built an approver-targeted engine in
  `admin_code.js`, then discovered **PIA already had a more robust one** (`sendDailyReminders` +
  `buildReminderEmail`). Decision: **keep PIA's, remove the Admin duplicate.**
- **V1→V2:** V1 had a **hidden, applicant-targeted** reminder in PIA (and no clean way to know it
  existed); V2 makes **PIA's the single canonical approver-reminder**, restyled to navy, with the Admin
  duplicate stripped out so approvers don't get two emails.

### 3.9 Email beautification (HTML, navy, professional)
- **Layman:** All system emails were plain and ugly; now they're clean navy "cards."
- **Technical:** Added shared builders `buildAdminEmailHtml_` (`admin_code.js`) and `buildPiaEmailHtml_`
  (`pia_code.js`), navy `#2a5285` header bar, Helvetica, white card, detail table, CTA button, footer.
  Routed all Admin senders (approver/ISM/divhead/applicant/account-deletion) and all PIA senders
  (applicant status, approver request, ISM, divhead, the reminder) through them; aligned the certificate
  email accent `#185FA5 → #2a5285`. **Functional links/tokens preserved exactly.**
- **V1→V2:** V1 emails were a mix of plain text (Admin) and Arial/blue (PIA); V2 unifies everything to
  one professional navy style. (Chosen path: "Option C", restyle PIA to match the navy template.)
- **Scenario:** An approver gets a navy "Action Required: Review" card with a working Review button.

### 3.10 Downloadable & endorsement labeling clarity (audience-aware copy)
- **Layman:** Three copy/labeling fixes so users instantly know *who each form is for* and
  *which endorsement letter to attach*: (1) each downloadable form now shows its audience
  ("For employees", "For external / third-party sharing", "For OJT / interns"); (2) the
  vague "No, standard request" option now reads "This is a standard request"; (3) the
  Endorsement Letter upload renames itself by request type, **"School Endorsement Letter"**
  for OJT, **"Agency Endorsement Letter"** for Agency, on the upload card *and* the review
  summary.
- **Technical:** All in `Phase 1/index.html` (frontend/copy only, no backend).
  - Downloadables: repurposed each `DOWNLOADABLES` entry's `descSet` from "Click to download"
    into an audience tag; DPA's `descStyle` bolded navy for emphasis.
  - Dropdown: relabeled the empty `<option>` in `renderForm()`'s `#dcs-involvement` select.
  - Endorsement label: wrapped the dynamic scope word in `<span id="endorse-scope-word">`
    across all 3 upload-card states (fresh / flagged / retained), and taught
    `updateMainUploadLabel()` to set it to "School"/"Agency" on every dropdown change (the
    label was previously frozen at initial render, so switching to OJT kept showing "Agency").
    Gave the span inline overrides (`display:inline; font-size/color:inherit`) so it isn't
    captured by the `.upload-text span` sub-line style. Summary rows relabeled to match
    ("School Endorsement Letter" for OJT, "Agency Endorsement Letter" for Agency).
- **V1→V2:** V1 used generic "Click to download" subtexts, a confusing "No, standard request"
  option, and a single static "Endorsement Letter" label regardless of request type; V2 makes
  all three audience-aware and self-updating.
- **Scenario:** A user picks "OJT" → the upload card live-updates to "Upload School Endorsement
  Letter" and the review summary shows "School Endorsement Letter"; picking "Agency" shows the
  Agency variant. The guide's download cards each state who they're for.
- **Where:** `Phase 1/index.html`, `renderGuide()` (`DOWNLOADABLES`), `renderForm()`
  (`#dcs-involvement` option + endorsement upload cards + `updateMainUploadLabel()`), and the
  summary render rows.

---

## 4. Bonus Features & Fixes (beyond what was asked)

> Things we added or fixed on our own, standalone improvements, or **bugs found in the existing V1
> system** that we corrected.

### 4.1 🐞 Status badge bug, "Ready for Phase 2" stuck after PIA submit
- **Layman:** After submitting a PIA, the request list still said "Ready for Phase 2" as if you hadn't
  started, now it correctly says "PIA In Progress."
- **Technical:** `getCombinedStatusBadge()` in `index.html` lumped `pia === 'pending'` together with
  "no PIA yet" (`!pia`), both returning "Ready for Phase 2." Split them: `pending` now returns a
  **"PIA In Progress: Awaiting Phase 2 approval"** badge.
- **V1→V2:** V1 mislabeled submitted-and-pending PIAs as not-started; V2 reflects real progress.

### 4.2 🐞 DSA edge-case leak (External → switch to Internal)
- **Layman:** If you picked External, attached a DSA, then switched to Internal, the DSA file could
  still be submitted even though Internal shouldn't have one, fixed.
- **Technical:** Guarded the submit payload with `state.dcs.access === 'External' && dsaInput?.files…`.
- **V1→V2:** V1 could carry a stray DSA on an Internal request; V2 cannot.

### 4.3 ✨ Application Requests filtering
- **Layman:** The "My Applications" list now has a search box + a status filter.
- **Technical:** `renderRequests()` caches results in `_requestsCache`; added `getStatusKey()`,
  `renderRequestRow()`, `applyRequestFilters()`. Search matches name/ReqID; status dropdown maps to the
  badge categories. Styled with the standard `.field`/`.select-wrap` design.
- **V1→V2:** V1 had a flat, unfilterable list; V2 is searchable + filterable.

### 4.4 ✨ DCS submission confirmation email ("Proceed to Phase 2")
- **Layman:** After submitting a DCS request, the requester now gets a styled email with a "Proceed to
  Phase 2" button. Before, they only saw an in-app button.
- **Technical:** Added `notifyDcsRequester_()` to `Code.js`, called in `submitDCS` after the record is
  written (new submits only, in try/catch so a mail error never blocks the submission). Reuses the
  existing `generatePhase2Url_` + `gmail.send` scope (no manifest change).
- **Why it's shaped this way (a V1 discovery):** A DCS request is written as **`STATUS_COMPLETE` the
  instant it's submitted**, there is **no separate DCS approval gate** (the whole approval ladder lives
  in PIA). DCS had **zero email code**. So the only meaningful "notification" is a submission
  confirmation, not an "approved" email.
- **V1→V2:** V1 left the requester to discover the Phase-2 button by re-opening the app; V2 emails it.

### 4.5 🐞 Duplicate reminder engines (found + resolved)
- **Layman:** There were secretly **two** daily-reminder systems that would have double-emailed
  approvers. We kept the better one and removed the duplicate.
- **Technical:** `admin_code.js` had the new engine; `pia_code.js` already had `sendDailyReminders`/
  `buildReminderEmail` (status-pre-filtered, idempotent via `ReminderDate`, reliable queue + retry).
  Removed the entire Admin reminder engine (functions, dispatch cases, Settings UI), keeping PIA's.
- **V1→V2:** V1 risked overlapping reminders; V2 has exactly one canonical engine.

### 4.6 🔎 "Review Access Request: Access Denied", diagnosed (not a bug)
- **Layman:** Clicking the approver email's Review button showed "Access Denied." Turned out it's the
  security working as designed + **Google multi-login**, not a bug.
- **Technical:** The link is HMAC-bound to one approver email and checks `Session.getActiveUser()` =
  the intended recipient. The app identifies you by your browser's **active/default Google session**,
  not the inbox you opened the email in. Fix for testing: open the link while signed in **as the
  approver** (Incognito with only that account).
- **V1→V2:** Behavior unchanged (V1 = V2), documented the gotcha so future testers don't lose time.

### 4.7 🐞 `saveConfigData` could not add new config keys
- **Layman:** Saving a brand-new setting link silently did nothing, fixed so new keys are created.
- **Technical:** `admin_code.js saveConfigData()` only **updated existing** `System_Configuration`
  rows. Added an append pass so new keys (e.g. `LINK_OJT_NDA_TEMPLATE`) get created on first save.

### 4.8 🐞 Missing manifest scope for the reminder trigger
- **Technical:** `admin_appsscript.json` lacked `script.scriptapp` (needed by `ScriptApp.newTrigger`).
  Added it (later moot once the Admin reminder was removed, but it was a real V1 gap).

### 4.9 🧰 Project hygiene
- Added project `CLAUDE.md` (architecture + design tokens + workflow guardrails), `.gitignore`
  (protects `DPS_DB*.xlsx` which holds real PII), and `docs/` (incl. `category-dropdown-handoff.md`).
- **V1→V2:** V1 had a one-line README and no project guardrails; V2 documents the architecture and
  shields the PII export.

### 4.10 📚 Full code documentation (see §8).

### 4.11 🐞 PIA "Proceed to Phase 2" crash, `<?…?>` scriptlet examples in doc comments
- **Layman:** Clicking "Proceed to Phase 2" threw a full-page `SyntaxError: Unexpected token '...'`.
  The PIA app itself was fine, the crash came from two **documentation comments** that happened
  to contain the literal example `<?!= parentID ? ... ?>`.
- **Technical:** The GAS HtmlService template engine scans **raw file text** for `<?…?>` tags and
  does **not** skip comments. `pia_index.html` had the example scriptlet (with a literal `...`) in
  its file-header and a `DOMContentLoaded` note; the engine compiled them as real printing
  scriptlets and choked on `...`. It surfaced **only** on the `?parentID=` path, because that's the
  only `doGet` branch that calls `createTemplateFromFile('index').evaluate()` (the no-parentID path
  uses `createHtmlOutput`). The error reported as `file "Code", line 1201`, the `template.evaluate()`
  call site, which sent the debug down a long wrong trail (runtime, deployments, properties) before
  the real cause (the template file) was isolated. Fix: rephrased both doc comments to describe the
  tag **without** the `<?…?>` delimiters; the one real scriptlet (now ~line 4044) is untouched.
  Verified DCS `index.html` and Admin `adminView.html` contain no `<?…?>` sequences.
- **V1→V2:** This was a **self-inflicted regression from the V2 documentation pass** (commit
  `39f2a46`), the doc comments that added the literal example scriptlet are what broke it. Pre-doc
  PIA had only the one real scriptlet and worked. **Rule recorded in CLAUDE.md §3b:** never write
  literal `<?…?>` inside comments in a templated HTML file.

### 4.12 🔌 Deployment-URL & Script-Property untangling (ops, not code)
- **Layman:** After redeploys, the "Proceed to Phase 2" button and **all email links** broke. Root
  cause was never the code, it was that the cross-app URLs are stored in **Script Properties** that
  had drifted to old/archived deployments, made worse by creating a **new deployment per change**
  (which mints a new `/exec` URL each time) instead of versioning one.
- **Technical:** Established the canonical map (now CLAUDE.md §3b): DCS holds `PIA_APP_URL` +
  `DCS_WEB_APP_URL`; **PIA** holds `WEB_APP_URL` (its own, for approver/ISM/reminder links via
  `getWebAppUrl`) + `DCS_WEB_APP_URL` (for the applicant "View DCS Submission" link via
  `getDCSWebAppUrl`). `DCS_WEB_APP_URL` exists in **both** projects, the **PIA** copy is the one the
  email code reads. Links freeze at **send time**; tokens have a **14-day TTL**. **The golden rule:
  one web-app deployment per app, always `Edit → New version` (never "New deployment") → the `/exec`
  URL is permanent and the properties are set-once.**
- **V1→V2:** V1 had no documentation of this wiring; V2 documents the full property→URL map, the
  golden rule, and the failure modes so the links never silently rot again.

---

## 5. The Journey: Key Iterations & Decisions

> The non-obvious paths, in the order they happened, useful for explaining *why* the system looks
> the way it does now.

**5.1 Understanding the architecture.** I initially thought this was a single DCS app. Reading the
code revealed `Code.js` was empty locally (backend lived only in the cloud), then that there are
**three** separate apps (DCS/PIA/Admin) sharing one sheet. Decision: treat the shared spreadsheet as
the only integration point and never break cross-app column/URL contracts.

**5.2 The greeting evolved three times.**
1. First: small "Hi `<firstname>`," on homepage + form (derived first name from email).
2. Feedback "too small / want it everywhere" → made it headline-sized on 5 screens.
3. Feedback "Megaworld emails are `<initials><surname>`; `abcruz.global` gave 'Global'" →
   rewrote `deriveSurname` to **strip 2 leading initials then take up to a separator** → "Cruz,"
   and changed wording to **"Hello, `<Surname>`!"**

**5.3 The reminder saga (biggest decision).** Sir asked for a COC-style 8am approver reminder. I
built one in the Admin app and we activated it. While restyling emails, I discovered **PIA already had
its own reminder engine**, more robust (status pre-filter, "already reminded today" guard, reliable
queue). We compared them head-to-head, concluded PIA's was better and that the Admin one's only unique
coverage (DCS) was moot (DCS auto-completes on submit). **Decision: keep PIA's, strip the Admin
duplicate** to avoid double reminders. Then verified via the PIA project's Triggers that `processEmailQueue`
existed but `sendDailyReminders` had to be created via `setupReminderTrigger`.

**5.4 OJT category: scoped down from a big blueprint.** The full "category dropdown" (agency/OJT/etc.,
each with different attachments) needs backend work and a finalized category list, so it stayed a
documented blueprint (`docs/category-dropdown-handoff.md`). When sir gave a concrete category (OJT =
CU + endorsement), we implemented **just OJT** cleanly (keeping `isAgency`, adding `isOJT`), leaving the
generic framework for later.

**5.5 Email styling: three families → one.** Found 3 looks: our new Admin navy template, the PIA
Arial/blue workflow emails, and the navy-ish certificate. Presented options (keep / match PIA / match
navy). Sir chose **Option C: restyle PIA to navy**, the cleanest-looking and now consistent.

**5.6 Internal/External, one direction, then symmetric.** First implemented "Internal → hide
External." Sir clarified with a screenshot that it should be symmetric (External → hide Internal too),
so we generalized it.

**5.7 The "Access Denied" mystery.** Spent real effort tracing the HMAC token logic (it was correct).
The breakthrough: sir noticed the error page showed *his* account even when opening another approver's
inbox → **Google multi-login**: the app reads the browser's active Google account, not the inbox.

**5.8 The status-badge bug.** Sir noticed a submitted PIA still read "Ready for Phase 2." Traced it to
one line in `getCombinedStatusBadge` lumping `pending` with empty; one-line fix.

---

## 6. Pending Inputs from Sir: Spoonfed Edit Guide

> Sir still needs to provide final **content** for a few spots. Here is **exactly where and how** to
> change each, manually, with no developer help. ⚠️ Line numbers drift as the file changes, use the
> **search text** to jump there (Ctrl+F), then edit.
>
> Reminder of the workflow: edit the file here → **copy-paste the whole file into the matching GAS
> project → redeploy**. Content edits are frontend-only (DCS `index.html`) unless noted.

### 6.1 "Purpose of …" paragraph (Guide / Step 1)
- **File:** `Phase 1/index.html` → function `renderGuide()`
- **Find (Ctrl+F):** `Purpose of Data Collection System (DCS)` (≈ line 4049), this is the **card title**.
- **Right below it** (≈ line 4051) is the paragraph that starts: `The DCS is designed to streamline…`
- **How to edit:**
  1. To rename the heading: change the text inside `<div class="card-title">Purpose of … (DCS)</div>`.
  2. To replace the body: change the sentence inside the `<p style="…">…</p>` directly under it.
  - Keep the surrounding HTML tags intact, only change the words between `>` and `<`.

### 6.2 Terms & Conditions content (Guide / Step 1)
- **File:** `Phase 1/index.html` → `renderGuide()`
- **Find (Ctrl+F):** `Terms &amp; Conditions` (≈ line 4056), the **card title** of the T&C box.
- **Below it:** the line `By proceeding, you agree to:` (≈ line 4057), then a bulleted list `<ul>…<li>…
  </li></ul>` of the four agreement points (≈ lines 4058–4063).
- **How to edit:**
  - Change/extend the bullets by editing each `<li>…</li>` (add or remove `<li>…</li>` lines to add/remove
    bullets). Write `&amp;` instead of a literal `&`.
  - The checkbox label "I agree to the Terms & Conditions" is separate (Ctrl+F `I agree to the`, ≈ line 4095).

### 6.3 Section 2 heading rename ("Details / Profile & Access")
- **Status:** sir's intended new label was never finalized (the original note trailed off).
- **File:** `Phase 1/index.html` → `renderForm()`
- **Two spots:**
  - The step badge: Ctrl+F `DCS Section 2: Details` (≈ line 4268), change "Details" to the new label.
  - The card title: Ctrl+F `Profile & Access` (≈ line 4300), rename if desired.
- **How:** once sir gives the target label, replace the text between the tags at those spots.

### 6.4 OJT download **link** (the actual file URL)
- **Who sets it:** an admin, in the **Admin app → Settings → "OJT NDA Template Link"** field (saves to
  the `System_Configuration` sheet as key `LINK_OJT_NDA_TEMPLATE`). No code edit needed.
- **Or directly in the sheet:** add a row, column `Configuration_Key` = `LINK_OJT_NDA_TEMPLATE`,
  `Value` = the file's share URL. Until set, the DCS guide shows "Link not set."

### 6.5 (Bigger, deferred) Full category framework
- If sir later wants **more** categories beyond Agency/OJT (each with its own attachments), the
  blueprint is `docs/category-dropdown-handoff.md`, it lists the exact frontend + backend touch points.
  This one needs a backend change to `submitDCS`, so it's not a content-only edit.

---

## 7. Architecture, Deployment & Verification Notes

- **3 independent deployments.** A change to one phase goes live only after **that** project is
  re-pasted + redeployed (Deploy → Manage deployments → New version → keeps the same `/exec` URL).
  Editing one phase does nothing to the others.
- **Cross-app contract (do not break):** shared sheet column names, the `parentID`/`Linked_ReqID`
  link, and stored URLs (`PIA_APP_URL`, `DCS_WEB_APP_URL`, `WEB_APP_URL`).
- **Manual reminder activation (PIA):** run `setupReminderTrigger()` once in the PIA project to create
  the 8am `sendDailyReminders` trigger; `processEmailQueue` must also be active to actually send queued
  mail. (And delete any leftover `adminApi_sendDailyReminders` trigger in the Admin project.)
- **Cannot run locally:** all three apps need `google.script.run` + the cloud Sheet, so verification is
  done in the live deployments. During V2 we syntax-checked every change (`node --check` for backends,
  `<script>` parse for frontends) before declaring done.
- **PII:** `DPS_DB*.xlsx` (a DB export with real `@megaworldcorp.com` data) is **gitignored**.

---

## 8. Documentation Pass

- **V1 docs:** inconsistent, a mix of Taglish "Tropang Ex" notes, terse JSDoc, stale comments (one even
  described the wrong function), and many undocumented functions.
- **V2 docs:** every one of the **6 source files** was given a uniform **Full-English** format:
  a top `[ OUTLINE ]` header (purpose + technical + a categorized index of all functions), a per-function
  block (`Function / LAYMAN / TECHNICAL / PARAMS / RETURNS / EXAMPLE`, depth-scaled), inline
  `/* Step N */` comments in substantive bodies, and essential section banners in the HTML/CSS.
- **Coverage:** ~**455 functions**: Code.js 35, index.html 89, pia_code.js 109, admin_code.js 65,
  pia_index.html ~47, adminView.html 110.
- **Safety:** comments-only, verified that **no executable line, string, or logic changed** (byte-level
  code-equality diffs on the backends + the cleanly-checkable frontend; "no executable line removed" on
  the two complex HTML files; all backends pass `node --check`, all frontends' scripts parse).
- **V1→V2:** V1 was hard to onboard into; V2's outline-first, layman-first docs let a new dev locate and
  understand any function fast.

---

## 9. Tester Waves 1-2, and the Post-Demo Rounds

> **Still Batch 🅐.** Everything in §§3-8 is the **first** V2 finalization pass, the originally
> requested scope. This section captures the feedback rounds that followed it and still precede
> the July 9 meeting: the OJT-tester waves 1 and 2 (June 24), a security-hardening pass (June 23),
> a serve-time bug fix, the consolidated manual, and then the **four post-demo rounds of July 6**
> (§9.9), which were the largest single block of change before the July 9 meeting.
> Same **Layman · Technical · V1→V2** shape throughout.

### 9.1 Downloadables restructured: 5 → **7 audience-named forms** (per-entity DPA)
- **Layman:** The download list grew from 5 generic forms to **7 clearly-named** ones, with a
  **separate DPA per entity** (Megaworld / Luxury Global / Global One) and distinct, clearer
  names. The two Confidentiality Undertaking forms now look different (amber + a person-with-check
  icon) so users don't confuse them with NDA/DPA.
- **Technical:** `DOWNLOADABLES` in `renderGuide()` (`Phase 1/index.html` ~4034) now has 7
  entries with **new config keys**: `LINK_NDA_EMPLOYEE_TEMPLATE`, `LINK_DSA_TEMPLATE`,
  `LINK_DPA_MEGAWORLD_TEMPLATE`, `LINK_DPA_LUXURY_GLOBAL_TEMPLATE`, `LINK_DPA_GLOBAL_ONE_TEMPLATE`,
  `LINK_CU_AGENCY_TEMPLATE`, `LINK_CU_OJT_TEMPLATE`. (Only `LINK_DSA_TEMPLATE` kept its old key;
  the earlier `LINK_OJT_NDA_TEMPLATE` from §3.3 was superseded by `LINK_CU_OJT_TEMPLATE`.)
- **V1→V2:** V1 had 4 hardcoded forms; the first V2 pass made it 5 (array-driven + OJT); Wave 2
  is **7 audience-named, per-entity forms**.

### 9.2 5-stage progress timeline (Heads Approval split out)
- **Layman:** The progress tracker now shows **5 stages** instead of 4, the Immediate/Dept-Head
  phase is its own step, separate from "PIA Assessment," so the requester sees where they really are.
- **Technical:** `renderPiaTimeline` / the overall-timeline builder (`Phase 1/index.html` ~2636)
  now renders: **DCS Request → PIA Assessment → Heads Approval → ISM Approval → Certification**.
- **V1→V2:** earlier the timeline was 4 stops (DCS → PIA → ISM → Certification); Wave 2 adds a
  distinct **Heads Approval** stop.

### 9.3 Uploaded documents shown as clickable Drive "View" links
- **Layman:** In a request's details, uploaded files (NDA/DPA/DSA) are now **clickable "View"
  links** to the Drive file, not just plain filenames.
- **Technical:** `renderRequestDetails` builds per-file Drive links. *(This is also the helper
  that triggered the blank-page bug, see §9.6.)*
- **V1→V2:** V1 showed plain filenames; V2 shows working View links.
- 🔴 **Superseded by §11.2, and this version was insecure.** These were **raw Drive links to files
  that V1 had published to anyone on the internet**. Making them clickable did not create that
  problem, but it did put the public URL on screen. The sharing was removed and the links replaced
  by authorization-checked endpoints on 2026-08-11; the current behaviour is in §11.8.

### 9.4 Reliable reviewer documents + Certificate supporting-docs list
- **Layman:** Reviewers were sometimes shown "No documents attached" for internal requests;
  fixed. And the Certificate of Approval now lists the supporting documents.
- **Technical:** `getAndShareDCSFiles` (PIA) now resolves files by the **IDs stored on the DCS
  record** (reliable), with an Admin-folder title-search fallback, so the internal NDA/DPA is
  shown to reviewers. The same reliable lookup feeds a new "Supporting Documents" section on the
  Certificate.
- **V1→V2:** V1's reviewer doc lookup was title-search only (fragile for internal requests); V2
  is ID-based with fallback. *(Note: saving the certificate **PDF to Drive** was intentionally
  **deferred**, only the supporting-docs list was implemented.)*

### 9.5 Security hardening pass (F-01 … F-08)
- **Layman:** A security review found that some sensitive backend functions could be called
  directly by any logged-in employee (bypassing the on-screen gates). These were closed.
- **Technical:** Added server-side authorization **inside** the functions (not just at the page
  gate): Admin destructive/config ops now call `checkAccess_` (INFOSEC-only, **22 guard sites**);
  PIA decision processors verify `Session.getActiveUser()` == the approver (**identity guards**)
  and reads gate via `isAuthorizedForApplication_`; DCS `apiGetRequestData` got an owner guard and
  `getGatewayRecord` is bound to the active user. Critical/High/Low all fixed; one error-message
  sweep (F-06) deferred.
- **V1→V2:** V1 relied only on the `doGet`/`doPost` entry gates (the GAS "every global function is
  directly callable" threat model was unmitigated); V2 enforces **per-function** authorization.
- **Detail:** `docs/Security - Review Findings.md` (findings + remediation table) and
  `docs/Security - Recommendations.md` (future backlog).

### 9.6 🐞 Blank DCS page: GAS serve-time template-literal corruption (fixed)
- **Layman:** After a deploy, the DCS page went **blank** with a JavaScript syntax error, even
  though the file was valid on disk.
- **Technical:** A string-building helper in `renderRequestDetails` (the §9.3 file-link helper)
  was written as a **template literal** (backticks). GAS's serve-time serialization corrupted
  that backtick string (leaving it unterminated), so the parser choked downstream on a `style=`.
  `node --check` couldn't catch it because it validates the **disk** file, not GAS's serve
  transform. **Fix:** rebuilt the helper with plain ASCII string concatenation. Recorded as a
  permanent gotcha in CLAUDE.md §8 + the manual (§0.5).
- **V1→V2:** A V2-introduced helper regressed at serve time; fixed and documented so it can't
  recur silently.

### 9.7 Resolved / updated "Pending Inputs" (§6)
- **Terms & Conditions content** (§6.2), now drafted in full as `docs/Terms and Conditions.md`
  (paste into the `LINK_TC_PAGE` doc). No longer a blank pending item.
- The OJT download **link** (§6.4) is set per the new key `LINK_CU_OJT_TEMPLATE`.
- Remaining open items (e.g. the §6.3 Section-2 heading label) still await sir's final wording.

### 9.8 📚 Consolidated manual created
- The three separate phase manuals were superseded by **one unified manual** in
  `docs/manual/` (a shared **Part 0** + per-phase Parts 1–3 + appendices), correcting several
  stale facts from the old manuals (deployment golden rule, `SYSTEM_SECRET` vs the `HMAC_SECRET`
  misnomer, the 5-stage timeline, strict-INFOSEC Admin access, domain-check now on). See
  `docs/manual/README.md`.

### 9.9 The post-demo rounds (2026-07-06), four batches in one day

> The system was demoed, and the feedback came back in four themed batches plus two hardening
> rounds. This is the **last** work before the July 9 meeting, and the largest single block in
> Batch 🅐. It is the point at which RARS stopped being "the intern's finalization" and started
> being shaped by how the business actually intends to operate it.

**Batch 1: DCS intake form becomes strict.**
- **Layman:** The request form let people through with missing or vague answers. Three fields
  became genuinely required, and agency requests now ask whether this is a **new** person or a
  **replacement** for someone leaving.
- **Technical:** iHelp Reference required (frontend `requiredFields` **and** server-side
  `submitDCS` validation); Office/Site required with the free-text **"Others" option removed**, so
  every request resolves to a known site. Fixed a `FORM_FIELDS.location` id mismatch and deleted
  the dead Specify-Location field. Agency requests gained New vs Replacement; Replacement reveals
  and requires the replaced person's full name and email, for DCOPS to retire the right account.
- **V1→V2:** V1 accepted free-text sites and had no replacement concept, so requests could not be
  reliably routed or reconciled against a leaver.
- 🚩 Stored as **new additive keys** in the agency metadata JSON. No key renamed, so the cross-app
  contract held.

**Batch 2: the certificate becomes the artifact the business actually needs.**
- **Layman:** The Certificate of Approval now shows each approver's comments, is **emailed to the
  applicant as a PDF**, and tells them the request is being processed and who to contact.
- **Technical:** Approver tables gained a Comments column across all three tables; the data already
  existed in the workflow sheets, only the certificate had never printed it. The fully-approved
  applicant email now carries the certificate as a **PDF attachment**, which required building and
  routing the cert first and sending that email **synchronously** rather than through the async
  queue, since the queue cannot hold a blob. Applied to both finalize paths (ISM-final and the
  division-head proxy), with the existing no-duplicate guard intact.
- **V1→V2:** V1's certificate went only to the implementation inboxes and carried no reviewer
  feedback; the applicant never received a copy.

**Batch 3: per-site TechServe routing.**
- **Layman:** "TechServe" is not one team. Each office has its own, so an approved request now
  routes to the TechServe for **that** site.
- **Technical:** `InfoSec_Email_Config` gained a **Site** column; TechServe is one row per
  (site, email) and a site may have several, while DCOPS stays single. New
  `resolveTechserveForSite_` matches on the request's site and **falls back** to blank-Site rows
  then to all TechServe, so nothing is ever dropped. The site list was finalized to AGT, GDP, EGP,
  TWS.
- 🚩 **Shipped behaviour-preserving:** the Site column is read with a falsy guard, so routing was
  unchanged until the column was actually populated. That is why this could ship the same day.

**Batch 4: records can no longer be destroyed from the Admin app.**
- **Layman:** Admin had a "Close Ticket" button that **hard-deleted** a request and its entire
  audit history. It is gone.
- **Technical:** Removed the per-row trash button, the bulk Close Ticket button, the confirmation
  modal, six client handlers, and the `deleteEntry` / `batchDeleteEntries` /
  `deleteRowsBySessionId_` backend functions. The row-selection machinery was deliberately kept,
  since Export Selected still uses it.
- **V1→V2:** V1 allowed irreversible destruction of records, with their audit trail, from a UI
  button. V2 has no delete path at all. *(A governed, dry-run-gated retention sweep arrives later,
  in Batch 🅒 §11.4. That is the correct shape for this: deliberate and reversible-by-default,
  not a button next to the export.)*

**Round 2: the Admin lockout, and access by role.**
- **Layman:** Renaming the InfoSec member IDs locked the admins out of their own console.
- **Technical:** `checkAccess_` stopped hardcoding `INFOSEC-001/002`. Access is now granted to
  active **InfoSec-role** members matched **by Role, not by Member_ID**, so a future rename cannot
  lock anyone out, plus any entry in `Admin_Notification_Config`. Fail-closed, with try/catch per
  source.
- 🚩 **The lesson:** the identifier that was being used as a permission key was also a label people
  felt free to edit. Matching on the role is what made the config safe to touch.

**Round 2 continued: DCS form correctness.**
- Stale uploads are cleared when the required document type changes (the CU ↔ NDA/DPA flip), via a
  new `clearUpload()` helper, so a file for the wrong category cannot survive a switch.
- **OJT now forces External access**, locked in the UI and rejected server-side if violated.
- Network Drive became required for agency requests.
- Required-field red asterisks (`reqMark()`) added across Profile / Heads / Agency labels.
  *(This is the same helper whose absence in PIA caused the unmarked field found much later in
  Batch 🅒, §11.9.)*

**Round 3: final hardening before redeploy.**
- **The Documents section now lists every submitted file.** The Endorsement Letter was shown only
  for OJT in the summary and **omitted entirely** from the post-submission details list; it now
  appears for both Agency and OJT, and the duplicate copy in the Agency-Info card was removed.
- Fixed the Details step falsely showing "?" on every Internal request.
- `submitDCS` rejects a document-less submission server-side.
- **All four approver emails** now carry the same "Review Status" block the applicant emails had,
  so an approver sees who already decided, with comments, before them. *(This is the direct
  ancestor of the unified approval history built in Batch 🅑.)*
- Admin's selected-row highlight used the same colour as the even-row zebra stripe, so selecting an
  even row showed **no visible change**; selection now gets a wash plus a left accent bar.

---

# 🅑 BATCH 2: July 9 meeting revisions
*July 14 to 17, 2026. Section 10.*

---

## 10. The July 9 Meeting Batch

> **What this section is.** The revisions and recommendations raised in the **July 9 meeting**,
> built between July 14 and 17 and reported in the Week 8-9 report (July 20-24 / July 27-31).
>
> It splits in two, and the split is worth keeping in a progress report:
> **§10.1** is what was explicitly asked for (**9 items**). **§10.2** is what was found and fixed
> while building it (**11 items**), which was not requested by anyone.
>
> The unifying theme of the requested half: **a returned request used to lose its history.**
> Comments, flags and replaced documents all vanished on resubmit, so nobody downstream could see
> what had already been said. Six of the nine requested items are different faces of that one
> problem.

### 10.1 What the July 9 meeting asked for (9 items)

**1. Certificate shows the raw program details.**
- **Layman:** The Certificate of Approval now prints the program's Scope, Benefits and End User
  directly on the document.
- **Technical:** Added the three rows to the certificate table, sourced from PIA application
  metadata with a graceful fallback when a field is blank.
- **Test:** Check the Certificate of Approval on the emails sent to Miss Tine.

**2. Revision history is preserved across rounds.**
- **Layman:** Returned-and-resubmitted requests were losing every prior comment, flag and document.
  A store was built to keep each round before it was overwritten.
- **Technical:** New `Revision_History` sheet with a snapshot taken before the workflow rows were
  rebuilt, feeding a shared `getUnifiedHistory()` builder in `pia_code.js`.
- **Test:** Not directly visible; it is the backing store. Confirm through item 3.
- 🔴 **Superseded in Batch 🅒 (§11.3).** This was the right fix for the requirement, but it was a
  copy-before-delete: the underlying resubmit still **deleted** the previous round, and the
  snapshot was non-blocking, so a failed snapshot lost the round silently. In August the workflow
  became **append-only**, nothing is deleted, and `Revision_History` was retired. The requirement
  from this meeting is still met, by a stronger mechanism.

**3. That history is surfaced to approvers, the certificate, and the requestor.**
- **Layman:** Preserving history is useless if nobody sees it. One history component now renders
  everywhere it matters.
- **Technical:** A single grouped-by-round component renders on both approver review forms, all
  approval emails, the certificate ("Complete Approval History"), the DCS request-details page, and
  a new requestor-facing timeline.
- **Test:** Open any approver review form, the certificate, the DCS request-details page, or the
  requestor's PIA Approval History for a request that has been through a return-and-resubmit cycle.
- ℹ️ This component is the direct ancestor of the **five-way format contract** standardised in
  Batch 🅒 (§11.9).

**4. Replaced documents are archived, not deleted.**
- **Layman:** Replacing a flagged document permanently destroyed the old one. Old versions are now
  kept and viewable.
- **Technical:** New `archiveAndRecordSuperseded_` moves replaced or flagged files to an archive
  instead of discarding them.
- **Test:** Have an approver flag and return a document, re-upload it, then check the request
  details and certificate: only the new file under active documents, the old one under
  **Superseded Documents**.
- ⚠️ **A defect in this shipped with it:** a wrong-column lookup meant the old file sometimes
  failed to archive. Found and corrected in a later pass (see §10.2).

**5. Additional supporting documents (ad-hoc upload).**
- **Layman:** There was no slot for extra documents an approver might ask for outside the standard
  NDA / DPA / DSA set.
- **Technical:** A dedicated ad-hoc multi-file upload section. When an approver flags a specific
  supplementary document, the requestor is **forced to re-upload it** on resubmit and the old
  version is archived.
- **Test:** On the DCS request form, look for "Additional Supporting Documents".

**6. Reminder cadence changed from daily to 7 days, then every 3.**
- **Layman:** Approvers were nagged daily. Now the first reminder waits a week, then repeats every
  three days until they act.
- **Technical:** Added a `NotifiedDate` column to all three approval sheets to timestamp first
  notification. `sendDailyReminders()` sends the first reminder only when
  `today − NotifiedDate ≥ 7 days`, and subsequent ones when `today − last reminder ≥ 3 days`.
- **Test:** Hard to observe live, since it is time-based. Verify via the `NotifiedDate` /
  `ReminderDate` columns on a pending row, or confirm no reminder fires before day 7.

**7. Replacement email can be marked N/A.**
- **Layman:** The replacement-request email field can now be marked N/A when there is nothing to
  enter.
- **Technical:** An N/A checkbox stores `'N/A'` and skips reading the disabled input; email-format
  validation treats `'N/A'` as valid so it no longer trips the required-field error.
- **Test:** DCS Agency screen, select "Replacement": the N/A checkbox appears beside the field.

**8. "Megaworld ISM Department" branding on emails.**
- **Layman:** Department branding now appears in both the header and body of system emails.
- **Technical:** Sender name and email eyebrow set to "Megaworld ISM Department", with a matching
  eyebrow added to the certificate header.
- **Test:** Check the emails going to Miss Tine.

**9. Cross-visibility between the two ISM approvers.**
- **Layman:** ISM Approver 2 can now see ISM Approver 1's feedback and routing decision before
  acting, instead of reviewing blind.
- **Technical:** Delivered as part of the unified history component, explicitly extended to the ISM
  review form so the second reviewer sees the first's decision and comments inline.
- **Test:** Visible once Sir Darwin reviews as 2nd ISM approver: his screen should already show
  Miss Tine's decision.
- ℹ️ Batch 🅒 later found that the two reviewers could still **disagree on the routing destination**
  with the last one silently winning. Now logged to the audit trail (§11.8).

### 10.2 Additional work delivered in the same pass (11 items, not requested)

> Found while building §10.1. Several are defects in **V1's inherited code**, not in the new work.

**Draft resume: file-loss prevention.** Resuming a saved draft falsely showed supplementary files
as still attached, so requests were being submitted **missing their actual files**. `resumeDraft()`
now clears the stale names and shows an amber re-attach notice; submission is blocked with a
confirmation if the file is still missing.

**Agency N/A checkbox fixes.** The unrelated Agency-section N/A checkbox was **invisible** (CSS
override restored native rendering) and separately still triggered a false "email required" error
(validation now skips the disabled field).

**Return/Deny result page colour.** The confirmation page rendered red for Return and Deny, which
read as alarming and as though something had failed. It is now always green, because the colour
confirms **the decision saved**, not the verdict. The heading still states the actual outcome.

**Boilerplate default comments removed.** A generic fallback, "Approved via secure access review
link.", was being stored and displayed wherever an approver left no comment. Removed at the write
path, plus a filter that suppresses the string across every existing display surface **without
rewriting historical data**.

**Requestor visibility into flagged fields.** Requestors could not tell which fields were flagged
without entering edit mode. The read-only request-details view now lists flagged items directly,
ahead of any edit action.

**Minimum-flag rule made consistent.** The standard review form required **2** flagged items to
return a request; the ISM form required **none**. Both now require exactly **1**.

**Unified status colour system.** Status indicators used inconsistent colours across screens and
emails. One rule applied across all four project files: green approved, amber returned, red denied,
blue pending/escalated.

**"Previously reviewed by you" chip.** When a revised request came back to an approver who had
already seen it, nothing indicated that. A chip now shows their own prior decision and round number.

**Stakeholder Add/Remove buttons repaired.** They were **completely non-functional**. An internal
state-sync function was silently discarding empty rows before the buttons could register a change.

**Approval status display consistency.** Statuses on the requestor's own timeline rendered as plain
text instead of the coloured pills used everywhere else.

**DCS progress indicator fix.** The Section 2 sidebar icon showed a confusing "?" instead of a green
checkmark under certain conditions. The conditional causing it was removed; a passed section always
shows a check.

---

# 🅒 BATCH 3: Hardening, integrity, and the live test passes
*August 11 to 14, 2026. Section 11.*

---

## 11. Wave 3: Hardening, Integrity & the Live Test Passes

> **What this section is.** §§1–10 took the system from V1 to a working, documented V2 shaped by
> two rounds of business feedback. Wave 3
> (2026-08-11 → 2026-08-14) is different in character: it is what happened once the system was
> **read adversarially** and then **driven end to end by a real reviewer**. Nearly every item here
> is a defect that was already live in V1 and had simply never been noticed, because **none of them
> threw an error**. They returned plausible wrong answers.
>
> That is the single theme of this wave, and the most useful thing to take from it: **the dangerous
> bugs in this system were never crashes. They were things that looked like they worked.**

### 11.1 🔒 The callable-surface sweep: 178 public functions → 82

- **Layman:** In Google Apps Script, **every** backend function is callable from any logged-in
  employee's browser console, whether or not the app puts a button on screen. The system was
  written as if the on-screen buttons were the only way in. They were not.
- **Technical:** 178 of 229 top-level functions were reachable via `google.script.run`. Among them:
  `getSystemSecret` (returned the HMAC signing key as a string to any domain caller),
  `getApplicationData` (full PII record for any sequential, therefore guessable, session ID), 16
  unguarded `admin*` config mutators, and two unauthenticated ISM workflow mutators. The fix is the
  **trailing-underscore convention**: in Apps Script a name ending in `_` is unreachable from the
  browser. Functions that legitimately serve the frontend keep a bare name **and guard their own
  body**. After the sweep: **82 public, none unguarded.**
- **V1→V2:** V1's threat model was "the page gate is the gate." V2 treats **every function as its
  own front door**.
- **🔴 The lesson worth keeping (F-05):** the security doc had recorded the `getApplicationData`
  leak as fixed. What had actually been fixed was `apiGetApplicationData`, the **wrapper**. The
  primitive stayed public and unguarded. **A finding is not closed until the primitive is closed.**

### 11.2 🔒 Uploaded documents were public to the entire internet

- **Layman:** Every NDA, DPA, DSA, Confidentiality Undertaking and Endorsement Letter uploaded to
  the system was published so that **anyone on the internet holding the link** could read it, and
  the raw link was printed directly into the request page, the PIA summary and the approver's
  review form. One forwarded screenshot leaked a signed contract publicly.
- **Technical:** `uploadProxy_` ended with `file.setSharing(ANYONE_WITH_LINK, …)`. Removed;
  `DriveApp.createFile()` already leaves a file owner-only. Reading is now served by two endpoints
  per project behind identical gates (extracted into one shared `authorizeDcsFileAccess_` so they
  cannot drift), including an **anti-confused-deputy check**: the requested file ID must actually
  belong to that request. *Owning a request is not owning a file*, without that check a caller could
  pass the ownership gate on their own request and then hand in any Drive ID in the script owner's
  Drive.
- **V1→V2:** V1 published every legal document publicly. V2 keeps them owner-only, and shares one
  file with **the company only**, at the moment an authorised person opens it.

### 11.3 🗒 The approval workflow became append-only

- **Layman:** When a request was returned and resubmitted, the system **deleted** every prior
  approval row and started over, keeping a photocopy of them in a separate tab. If the photocopy
  failed, the round was gone with no signal. For a Privacy Impact Assessment, that is a compliance
  gap: there was no reliable answer to "what exactly did the Department Head approve last time?"
- **Technical:** The workflow sheets gained `RoundNumber` and `FlaggedFields` (appended at the end,
  so no existing index shifted). A resubmit now **appends round N+1** and earlier rounds stay
  untouched. `rowMatches_(row, cols, sessionId, round)` makes the critical distinction explicit at
  every call site: pass a round for **routing** reads ("who acts next?"), pass `null` for
  **history and authorisation** reads ("what happened?"). The old delete existed only because the
  sheets had no round column, so a scan could not tell a live Pending row from an abandoned one.
  `Revision_History` and its 256 lines of stitching logic are retired. Separately,
  `Application_Snapshots` preserves the applicant's **answers** per round, since the `Applications`
  row is still overwritten in place.
- **V1→V2:** V1 destroyed approval history on every resubmit. V2 never deletes it.

### 11.4 The 2026-08-12 batch: error contract, caching, retention, backup

Seven items from a cross-repo review, each of which set a convention later code must respect.

- **One error shape, `{ok, code, message, ref}`.** 110 catch blocks were returning Google's raw
  exception, which quotes the spreadsheet ID and Drive folder IDs. Users now get a plain sentence
  plus a short reference code; the real exception goes to the execution log under that code.
  **🔴 The lesson (F-06):** the first sweep anchored on the pattern `error: e.message` and reported
  89 sites closed. 21 leaks shaped `error: 'Loading failed: ' + e.message` slipped through, and
  they were the highest-traffic ones. **Re-grep with a second, differently-shaped pattern before
  writing "closed" in a findings doc.**
- **A sheet read cache**, off by default and only ever wrapped around read-only paths, so
  write-then-stale-read is structurally impossible rather than a thing someone has to remember.
- **Retention and purge**, shipped deliberately **inert**: two separate switches must both be
  thrown before a single row is deleted, and the config fails safe in every direction.
- **A weekly database backup**, deliberately **fail-loud**: it rethrows after logging, the opposite
  of the retention sweep. A backup job that fails silently is discovered on the day you need it.
- **Formula-injection guard** on the Admin export, the only artifact in the system a human opens in
  the Sheets UI, where `=IMPORTXML(...)` stops being an inert string and runs as the admin.
- **An aging report** ("where do requests get stuck"), and one canonical design-token file replacing
  six drifting copies, two of which were rendering the approver's decision page in the wrong navy.

### 11.5 🚩 One header list per sheet, and it now checks itself

- **Layman:** Each sheet had its column order written down in **two** places that nothing kept in
  agreement. When they drifted, the system read the neighbouring column and reported the result
  without complaint.
- **Technical:** `PIA_SCHEMA` is now the single ordered header list per sheet; indices are
  **derived** from it via `colsOf_()`, never hand-numbered. `assertSheetSchema_` compares the live
  header row on first access and **throws** on mismatch. `healSheetHeaders_` repairs an existing
  database once, automatically, and is itself derived from `PIA_SCHEMA` rather than hand-listed.
- **Seven defects were found by doing this**, four of them user-visible: Admin's Flags tab always
  read **zero**; agency metadata was invisible in Admin depending on which app created the sheet
  first; every DCS revision silently **dropped the superseded-document trail** and reset the
  revision count; and delegated decisions wrote under a blank header. **Not one of them threw.**
- **🔴 The lesson, learned twice in one session:** both the repair function and its regression test
  shipped **wrong**, in the same direction. Each was written against what the schema *said* rather
  than what the live database *held*, and each failed quietly. The test printed "19 passed, 0
  failed" against a database missing 11 header cells. **Before trusting a schema migration, dump
  the live header rows and diff them.** Row 1 of every sheet is enough and carries no personal data.

### 11.6 🐞 The escaper that never escaped anything

- **Layman:** The function responsible for making user-typed text safe to display had been written
  so that it did **nothing**. It shipped that way for the app's entire deployed life.
- **Technical:** DCS's `escapeHtml` performed identity replacements (`.replace(/&/g,'&')`,
  `.replace(/</g,'<')`, …). Only the apostrophe was ever escaped. That function was the sole XSS
  defence for **71** `innerHTML` interpolation sites, approver comments included. It is valid
  JavaScript with a correct-looking shape, so it passed `node --check` and every human review.
- **V1→V2:** V1 had no HTML escaping in practice. V2 has real escaping, verified by a checker that
  asserts every escaper in all six files actually escapes.
- **🔴 The generalizable lesson, and the reason this wave exists:** **a function that looks like its
  job description proves nothing.** Name-based review cannot catch this class of bug.

### 11.7 🧰 The pre-deploy ritual grew to five checkers

`node docs/tools/surface.js && calls.js && escapers.js && shared.js && serve.js`

They split cleanly in two, **and the split is the point**. `surface.js` and `calls.js` audit what
the code is **named**. `escapers.js`, `shared.js` and `serve.js` audit what the code **does** when
it runs or is served. **Every outage this project has had was caught by the second kind and missed
by the first.**

- `calls.js` exists because privatizing a function means renaming every caller, and one was missed:
  `generateAuthToken_` kept calling `getSystemSecret()` after the definition became
  `getSystemSecret_()`. That call signs **every approver review link**, so the deploy would have
  broken the entire approval workflow. It survived `node --check` (a call to a missing function is
  syntactically perfect), `surface.js`, and three review passes.
- `serve.js` exists because Apps Script **truncated a served line** at the double slash inside an
  `xmlns` attribute, leaving an unterminated string that blanked the entire page. All four other
  checkers passed on that file.

> 🔴 **The meta-lesson of this whole wave, and it recurred three times in one day: an undeployed
> batch is an untested batch.** The `xmlns` lines were written, passed every offline check, sat in
> git for a day, and failed the instant they were first served. **Deploy small and deploy often; a
> commit that has never been served has not been tested in any meaningful sense.**

### 11.8 The second live test pass (feedback batch 2)

The first time a real reviewer drove the system end to end. Most findings were presentation
defects; two were genuine workflow failures.

- **🐞 Closed rounds displayed fake "Pending" approvers.** After a Return, approvers further up the
  ladder who were **never reached** still rendered as though actively reviewing. Root cause was a
  documented contract that the code did not honour: the comment said "current round", the flag was
  global. Now enforced in three places that must stay in agreement.
- **🐞 Two ISM reviewers could disagree on the routing destination and the last one silently won.**
  The winner is unchanged, since that is an ISM policy call and not a bug to fix unilaterally, but
  a disagreement is now written to `Risk_Audit` so it is visible at all.
- **Documents open in the Google Drive viewer.** The in-page preview was abandoned after being
  proven impossible rather than merely difficult: Chrome refuses to render `blob:` document bytes
  inside Apps Script's sandboxed frame, in an `<iframe>` **and** in an `<object>`. Both were tried
  on the deployed app.
- **🐞 `[object Object]` shown as a filename** when restoring a returned agency request.
- **Certificates carry one approval record** instead of the same information twice in two shapes.

### 11.9 The third live test pass (feedback batch 3) and the delegation reversal

- **⛔ Approver delegation was deleted, two days after being built.** Built in §11.4, removed here.
  The judgment: deciding who covers an absent approver is **not an admin's call**. If an approver
  is unreachable, file a new request naming an available one.
  - **The write path is gone entirely**, so no delegation can be created by any path.
  - **The read path is deliberately kept and inert.** `canActAs_` **is** the identity guard on all
    three decision mutators, and with a permanently empty table it collapses to a plain identity
    check, exactly the pre-delegation behaviour. Rewriting the system's most security-sensitive
    predicate to delete five unused helpers is a bad trade. ⛔ Do not "finish the job."
  - **⚠️ One accepted gap:** heads are named by the applicant, so an absent head can be routed
    around. **ISM reviewers cannot be**, they come from `InfoSec_Email_Config`, so a new request
    reaches the same two people, and deactivating one does not rescue an already-Pending row.
    A request stuck on an absent ISM reviewer waits for them.
- **Comment minimums lowered to 30**, from 50 and 100. Reviewers were padding text to clear 100,
  which is worse than a short honest comment. 🚩 **Changing the constants would not have been
  enough on its own:** four of the five 50-sites and one 100-site had the number **hardcoded as a
  literal**, so the on-screen hint and the actual gate could silently disagree. Every site now
  reads its constant. The two limits stay separate so ISM can raise the Return/Deny bar alone.
- **Approval history reordered** so the actionable part comes first: identity and decision, then
  flagged items, then the comment, and the **date last** rather than second. This is now a
  **five-way contract** across the PIA server builder, both apps' timelines, the Admin certificate
  and the Admin audit table.
- **🐞 A required field was not marked required.** The stakeholder Name field in PIA Section 3 had
  no asterisk while the field next to it read "Email (Optional)". Both apps were audited; a shared
  `reqMark()` helper now exists in each, so the asterisk is never hand-pasted again.

### 11.10 Two of the reported "bugs" were false positives, and that mattered

Not everything reported was real, and checking first was the difference between a fix and a
regression. Two batch-3 items were disproven **using the reporter's own screenshots**: the document
chips were already one per row (the complaint was about ragged widths, a different fix), and the
"50 vs 100 discrepancy" was two genuinely different thresholds doing their jobs, not a drift bug.

**V1→V2 on process, not code:** V1 had no verification story. V2's rule is that a claim (from a
tester, a reviewer, or an earlier session) is checked against the actual code before anything is
changed, and a false positive is reported back as such.

### 11.11 📋 Final pre-deploy audit (2026-08-14)

Run before the Wave 3 deploy, over and above the five checkers. All passed:

| Checked | Result |
|---|---|
| Five checkers, `node --check` on 3 backends, all frontend script blocks | green |
| The approver page's emitted script, **rendered** rather than eyeballed | parses; no template-literal corruption |
| 128 derived column indices | all resolve, no load-time throw |
| Cross-app headers (`Risk_Audit`, `Data_Collection`) | identical between DCS and PIA |
| Document-sharing invariants | no `ANYONE_WITH_LINK`; all 5 elevation sites are the documented ones |
| Every inline event handler across 4 surfaces | all 113 resolve |
| Deleting the now-unused `Delegations` tab | proven it **cannot** break approvals (the guard fails safe) |

Neither Wave 3 commit changed the schema, any sheet name, or any manifest, so the deploy needs
**no migration, no header repair and no re-authorisation**. The three apps are deployed together
for consistency of the shared history format, not because a partial deploy would corrupt anything.

**Known and still open:** the Megaworld logo is hotlinked from Wikimedia in seven places, including
every workflow email. It predates V2 and is the likely source of a console error seen in testing. A
wiki that anyone can edit hosting corporate branding is not a good long-term dependency; the fix is
an inline image for the pages and an attached inline image for the emails.

---

*Prepared as context for the official documentation session, and as the source for the monthly
progress reports.*

*The V2 work is organised into **three delivery batches** (see [§2.1](#21-the-three-delivery-batches)):*

- *🅐 **§§3-9**, June 15 to July 6: the originally requested scope, complete about 3 weeks in,
  followed by the tester waves, the security pass, and the four post-demo rounds of July 6.*
- *🅑 **§10**, July 14 to 17: the July 9 meeting revisions, 9 requested items plus 11 found while
  building them. Reported in the Week 8-9 report.*
- *🅒 **§11**, August 11 to 14: hardening, data integrity, and the first two end-to-end test passes
  by a real reviewer.*

*The through-line across all three: the originally requested scope was the small part. Roughly two
thirds of what shipped came from feedback, revision and defects surfaced by continued testing, and
the most serious defects found were ones that had never produced an error message.*
