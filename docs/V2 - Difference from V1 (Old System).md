# V2 — Difference from V1 (Old System)

> **What this document is.** Megaworld's **RARS** (Risk Assessment & Routing System) — the
> DCS → PIA → Admin pipeline — was **already built by a previous intern (V1)**. I was tasked to
> **finalize, fix, and polish it (V2)**. This document captures *everything* changed or added in
> the V2 pass versus the original V1, written for use as context in a follow-up documentation
> session. Explanations follow **Layman → Technical → Scenario**, and each item emphasizes the
> **V1 (before) vs V2 (after)** difference.

---

## Table of Contents
1. [System Overview (what RARS is)](#1-system-overview)
2. [V1 → V2 At a Glance](#2-v1--v2-at-a-glance)
3. [Supervisor-Requested Work (achieved)](#3-supervisor-requested-work-achieved)
4. [Bonus Features & Fixes (beyond what was asked)](#4-bonus-features--fixes-beyond-what-was-asked)
5. [The Journey — Key Iterations & Decisions](#5-the-journey--key-iterations--decisions)
6. [Pending Inputs from Sir — Spoonfed Edit Guide](#6-pending-inputs-from-sir--spoonfed-edit-guide)
7. [Architecture, Deployment & Verification Notes](#7-architecture-deployment--verification-notes)
8. [Documentation Pass (V1 vs V2 code docs)](#8-documentation-pass)

---

## 1. System Overview

**Layman:** RARS is Megaworld's online "request → assess → approve" pipeline for getting access
to company data. It is **three separate web apps that act as one flow**, all sharing **one Google
Sheet as their database**:
- **Phase 1 — DCS** (Data Collection System): the request form. You apply + attach legal docs.
- **Phase 2 — PIA** (Privacy Impact Assessment): the privacy questionnaire after DCS clears.
- **Phase 3 — Admin**: the ISM (InfoSec) control tower — dashboard, email routing, settings.

**Technical:** Three **independent Google Apps Script (GAS) web apps**, each its own project +
deployment + manifest. They never call each other directly — they coordinate **only through the
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
| Downloadables | 4 hardcoded blocks | array-driven + **OJT Confidentiality Undertaking** (admin-manageable) |
| Stakeholder section (PIA) | always shows Internal **and** External | shows only the relevant one (by access type) |
| Emails (Admin) | plain text | professional navy HTML card |
| Emails (PIA) | Arial + blue, inconsistent | unified navy card style |
| Approval reminders | **two** engines (Admin + PIA) silently overlapping | **one** (PIA's, the better one); Admin duplicate removed |
| Post-submit notification | none (in-app button only) | styled "Proceed to Phase 2" email |
| Application Requests list | no filtering | search + status filter |
| Status badge after PIA submit | wrongly stayed "Ready for Phase 2" | correctly "PIA In Progress" |
| Code documentation | inconsistent / Taglish / sparse | full English doc format, ~455 functions |
| Form labeling | generic "Click to download"; static "Endorsement Letter" | audience tags per form + type-aware "School / Agency Endorsement Letter" |

---

## 3. Supervisor-Requested Work (achieved)

> These map to the notes sir/the supervisor handed over. Each: **Layman · Technical · Scenario ·
> V1→V2 · Where.**

### 3.1 Rebrand DCS → "Privacy Impact Assessment"
- **Layman:** The app used to be called "Data Collection System" everywhere; now it reads
  "Privacy Impact Assessment," and the footer says "Megaworld Corporation."
- **Technical:** Replaced 7 user-visible strings in `Phase 1/index.html` — `<title>`, landing `<h1>`,
  logo aria-label, the guide `<h1>` ("Data Collection Guide & Terms" → "Privacy Assessment
  Instructions"), and 3 request-status strings. Footer: "Company Workspace · Data Collection System
  Phase 1" → "Megaworld Corporation · Privacy Impact Assessment · Build vX".
- **V1→V2:** V1 was branded "DCS"; V2 is branded "Privacy Impact Assessment / Megaworld Corporation."
- **Scenario:** A user opens the link — browser tab, homepage title, and footer all say "Privacy
  Impact Assessment / Megaworld Corporation."

### 3.2 Personalized greeting "Hello, `<Surname>`!"
- **Layman:** Each main screen now greets the logged-in user by surname, big and visible.
- **Technical:** `deriveSurname(email)` + `greetingLine()` in `index.html`. Megaworld emails follow
  `<initials><surname>[.suffix]`, so it **strips the 2 leading initials then takes the surname up to
  any separator** (e.g. `ctpaulican.global@…` → "Paulican", `drbisquera@…` → "Bisquera"). Rendered at
  `clamp(1.35rem … 1.9rem)`, bold navy, on landing/guide/form/drafts/requests. Identity comes from the
  existing `getUserIdentity()` (email only — GAS exposes no display name).
- **V1→V2:** V1 had **no greeting**. V2 has a prominent personalized one.
- **Scenario:** `drbisquera` logs in → every main screen shows **"Hello, Bisquera!"**

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

### 3.5 Internal vs External — show only what applies
- **Layman:** If a DCS request is "Internal," the external-only upload (DSA) doesn't show.
- **Technical:** Already gated on `access === 'External'` at render/toggle/validation — verified, then
  hardened (see bonus 4.2). In PIA, made the **Stakeholder Identification** section mutually exclusive:
  Internal request → only Internal stakeholders; External → only External (`renderPIA3` + `savePIA3`
  in `pia_index.html`, driven by `state.dcsData.access`).
- **V1→V2:** V1's PIA always showed **both** internal and external stakeholder cards; V2 shows only
  the relevant one.
- **Scenario:** External request → PIA Section 3 shows only "External Stakeholders."

### 3.6 OJT category (checkbox → dropdown)
- **Layman:** The "This request involves an Agency" checkbox became a dropdown: **None / Agency / OJT.**
  OJT requires a **Confidentiality Undertaking** + an **Endorsement Letter** (no agency-detail fields).
- **Technical:** `index.html` — `state.dcs.isOJT` added alongside `isAgency`; checkbox replaced by
  `<select id="dcs-involvement">` styled with the standard `.field` pattern; CU label + endorsement
  wrapper show for `isAgency || isOJT`; OJT skips the agency-details screen → straight to summary;
  payload sends `agencyData = { type:'OJT', endorsementLetterFile }`. `Code.js submitDCS` branches on
  `payload.agencyData.type` — for OJT it skips agency-field validation and stores `{type:'OJT',
  endorsementLetter}` in the `Metadata_Agency` column. PIA reads that metadata generically, so **no PIA
  change needed**.
- **V1→V2:** V1 had only a binary agency flag; V2 supports a real category (OJT) with its own required
  attachments, end-to-end (frontend + backend).
- **Scenario:** Pick "OJT" → main doc relabels to "Confidentiality Undertaking," endorsement required,
  no agency screen; submit stores `type:'OJT'`.

### 3.7 Admin-manageable downloadables (OJT link)
- **Layman:** An admin can now set the OJT download link from Admin → Settings (no sheet editing).
- **Technical:** `adminView.html` — added an "OJT NDA Template Link" field (`cfg-LINK_OJT_NDA_TEMPLATE`)
  + its key in `saveSettings()`. `admin_code.js saveConfigData()` was taught to **append** new config
  keys (see bonus 4.7), so a brand-new `LINK_OJT_NDA_TEMPLATE` row is created on first save.
- **V1→V2:** V1's Settings only had NDA/DPA/DSA/T&C links and could only **update existing** rows; V2
  adds the OJT link and can **create** new config rows.

### 3.8 Daily approval reminder (8am, COC-style)
- **Layman:** A reminder emails the approver who hasn't acted yet, daily at 8am — like the COC portal.
- **Technical:** This was the trickiest (see Journey 5.3). I first built an approver-targeted engine in
  `admin_code.js`, then discovered **PIA already had a more robust one** (`sendDailyReminders` +
  `buildReminderEmail`). Decision: **keep PIA's, remove the Admin duplicate.**
- **V1→V2:** V1 had a **hidden, applicant-targeted** reminder in PIA (and no clean way to know it
  existed); V2 makes **PIA's the single canonical approver-reminder**, restyled to navy, with the Admin
  duplicate stripped out so approvers don't get two emails.

### 3.9 Email beautification (HTML, navy, professional)
- **Layman:** All system emails were plain and ugly; now they're clean navy "cards."
- **Technical:** Added shared builders `buildAdminEmailHtml_` (`admin_code.js`) and `buildPiaEmailHtml_`
  (`pia_code.js`) — navy `#2a5285` header bar, Helvetica, white card, detail table, CTA button, footer.
  Routed all Admin senders (approver/ISM/divhead/applicant/account-deletion) and all PIA senders
  (applicant status, approver request, ISM, divhead, the reminder) through them; aligned the certificate
  email accent `#185FA5 → #2a5285`. **Functional links/tokens preserved exactly.**
- **V1→V2:** V1 emails were a mix of plain text (Admin) and Arial/blue (PIA); V2 unifies everything to
  one professional navy style. (Chosen path: "Option C" — restyle PIA to match the navy template.)
- **Scenario:** An approver gets a navy "Action Required — Review" card with a working Review button.

### 3.10 Downloadable & endorsement labeling clarity (audience-aware copy)
- **Layman:** Three copy/labeling fixes so users instantly know *who each form is for* and
  *which endorsement letter to attach*: (1) each downloadable form now shows its audience
  ("For employees", "For external / third-party sharing", "For OJT / interns"); (2) the
  vague "No — standard request" option now reads "This is a standard request"; (3) the
  Endorsement Letter upload renames itself by request type — **"School Endorsement Letter"**
  for OJT, **"Agency Endorsement Letter"** for Agency — on the upload card *and* the review
  summary.
- **Technical:** All in `Phase 1/index.html` (frontend/copy only — no backend).
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
- **V1→V2:** V1 used generic "Click to download" subtexts, a confusing "No — standard request"
  option, and a single static "Endorsement Letter" label regardless of request type; V2 makes
  all three audience-aware and self-updating.
- **Scenario:** A user picks "OJT" → the upload card live-updates to "Upload School Endorsement
  Letter" and the review summary shows "School Endorsement Letter"; picking "Agency" shows the
  Agency variant. The guide's download cards each state who they're for.
- **Where:** `Phase 1/index.html` — `renderGuide()` (`DOWNLOADABLES`), `renderForm()`
  (`#dcs-involvement` option + endorsement upload cards + `updateMainUploadLabel()`), and the
  summary render rows.

---

## 4. Bonus Features & Fixes (beyond what was asked)

> Things we added or fixed on our own — standalone improvements, or **bugs found in the existing V1
> system** that we corrected.

### 4.1 🐞 Status badge bug — "Ready for Phase 2" stuck after PIA submit
- **Layman:** After submitting a PIA, the request list still said "Ready for Phase 2" as if you hadn't
  started — now it correctly says "PIA In Progress."
- **Technical:** `getCombinedStatusBadge()` in `index.html` lumped `pia === 'pending'` together with
  "no PIA yet" (`!pia`), both returning "Ready for Phase 2." Split them: `pending` now returns a
  **"PIA In Progress — Awaiting Phase 2 approval"** badge.
- **V1→V2:** V1 mislabeled submitted-and-pending PIAs as not-started; V2 reflects real progress.

### 4.2 🐞 DSA edge-case leak (External → switch to Internal)
- **Layman:** If you picked External, attached a DSA, then switched to Internal, the DSA file could
  still be submitted even though Internal shouldn't have one — fixed.
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
  instant it's submitted** — there is **no separate DCS approval gate** (the whole approval ladder lives
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

### 4.6 🔎 "Review Access Request — Access Denied" — diagnosed (not a bug)
- **Layman:** Clicking the approver email's Review button showed "Access Denied." Turned out it's the
  security working as designed + **Google multi-login**, not a bug.
- **Technical:** The link is HMAC-bound to one approver email and checks `Session.getActiveUser()` =
  the intended recipient. The app identifies you by your browser's **active/default Google session**,
  not the inbox you opened the email in. Fix for testing: open the link while signed in **as the
  approver** (Incognito with only that account).
- **V1→V2:** Behavior unchanged (V1 = V2) — documented the gotcha so future testers don't lose time.

### 4.7 🐞 `saveConfigData` could not add new config keys
- **Layman:** Saving a brand-new setting link silently did nothing — fixed so new keys are created.
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

---

## 5. The Journey — Key Iterations & Decisions

> The non-obvious paths, in the order they happened — useful for explaining *why* the system looks
> the way it does now.

**5.1 Understanding the architecture.** I initially thought this was a single DCS app. Reading the
code revealed `Code.js` was empty locally (backend lived only in the cloud), then that there are
**three** separate apps (DCS/PIA/Admin) sharing one sheet. Decision: treat the shared spreadsheet as
the only integration point and never break cross-app column/URL contracts.

**5.2 The greeting evolved three times.**
1. First: small "Hi `<firstname>`," on homepage + form (derived first name from email).
2. Feedback "too small / want it everywhere" → made it headline-sized on 5 screens.
3. Feedback "Megaworld emails are `<initials><surname>`; `ctpaulican.global` gave 'Global'" →
   rewrote `deriveSurname` to **strip 2 leading initials then take up to a separator** → "Paulican,"
   and changed wording to **"Hello, `<Surname>`!"**

**5.3 The reminder saga (biggest decision).** Sir asked for a COC-style 8am approver reminder. I
built one in the Admin app and we activated it. While restyling emails, I discovered **PIA already had
its own reminder engine** — more robust (status pre-filter, "already reminded today" guard, reliable
queue). We compared them head-to-head, concluded PIA's was better and that the Admin one's only unique
coverage (DCS) was moot (DCS auto-completes on submit). **Decision: keep PIA's, strip the Admin
duplicate** to avoid double reminders. Then verified via the PIA project's Triggers that `processEmailQueue`
existed but `sendDailyReminders` had to be created via `setupReminderTrigger`.

**5.4 OJT category — scoped down from a big blueprint.** The full "category dropdown" (agency/OJT/etc.,
each with different attachments) needs backend work and a finalized category list, so it stayed a
documented blueprint (`docs/category-dropdown-handoff.md`). When sir gave a concrete category (OJT =
CU + endorsement), we implemented **just OJT** cleanly (keeping `isAgency`, adding `isOJT`), leaving the
generic framework for later.

**5.5 Email styling — three families → one.** Found 3 looks: our new Admin navy template, the PIA
Arial/blue workflow emails, and the navy-ish certificate. Presented options (keep / match PIA / match
navy). Sir chose **Option C — restyle PIA to navy**, the cleanest-looking and now consistent.

**5.6 Internal/External — one direction, then symmetric.** First implemented "Internal → hide
External." Sir clarified with a screenshot that it should be symmetric (External → hide Internal too),
so we generalized it.

**5.7 The "Access Denied" mystery.** Spent real effort tracing the HMAC token logic (it was correct).
The breakthrough: sir noticed the error page showed *his* account even when opening another approver's
inbox → **Google multi-login**: the app reads the browser's active Google account, not the inbox.

**5.8 The status-badge bug.** Sir noticed a submitted PIA still read "Ready for Phase 2." Traced it to
one line in `getCombinedStatusBadge` lumping `pending` with empty; one-line fix.

---

## 6. Pending Inputs from Sir — Spoonfed Edit Guide

> Sir still needs to provide final **content** for a few spots. Here is **exactly where and how** to
> change each, manually, with no developer help. ⚠️ Line numbers drift as the file changes — use the
> **search text** to jump there (Ctrl+F), then edit.
>
> Reminder of the workflow: edit the file here → **copy-paste the whole file into the matching GAS
> project → redeploy**. Content edits are frontend-only (DCS `index.html`) unless noted.

### 6.1 "Purpose of …" paragraph (Guide / Step 1)
- **File:** `Phase 1/index.html` → function `renderGuide()`
- **Find (Ctrl+F):** `Purpose of Data Collection System (DCS)` (≈ line 4049) — this is the **card title**.
- **Right below it** (≈ line 4051) is the paragraph that starts: `The DCS is designed to streamline…`
- **How to edit:**
  1. To rename the heading: change the text inside `<div class="card-title">Purpose of … (DCS)</div>`.
  2. To replace the body: change the sentence inside the `<p style="…">…</p>` directly under it.
  - Keep the surrounding HTML tags intact — only change the words between `>` and `<`.

### 6.2 Terms & Conditions content (Guide / Step 1)
- **File:** `Phase 1/index.html` → `renderGuide()`
- **Find (Ctrl+F):** `Terms &amp; Conditions` (≈ line 4056) — the **card title** of the T&C box.
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
  - The step badge: Ctrl+F `DCS Section 2: Details` (≈ line 4268) — change "Details" to the new label.
  - The card title: Ctrl+F `Profile & Access` (≈ line 4300) — rename if desired.
- **How:** once sir gives the target label, replace the text between the tags at those spots.

### 6.4 OJT download **link** (the actual file URL)
- **Who sets it:** an admin, in the **Admin app → Settings → "OJT NDA Template Link"** field (saves to
  the `System_Configuration` sheet as key `LINK_OJT_NDA_TEMPLATE`). No code edit needed.
- **Or directly in the sheet:** add a row — column `Configuration_Key` = `LINK_OJT_NDA_TEMPLATE`,
  `Value` = the file's share URL. Until set, the DCS guide shows "Link not set."

### 6.5 (Bigger, deferred) Full category framework
- If sir later wants **more** categories beyond Agency/OJT (each with its own attachments), the
  blueprint is `docs/category-dropdown-handoff.md` — it lists the exact frontend + backend touch points.
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

- **V1 docs:** inconsistent — a mix of Taglish "Tropang Ex" notes, terse JSDoc, stale comments (one even
  described the wrong function), and many undocumented functions.
- **V2 docs:** every one of the **6 source files** was given a uniform **Full-English** format:
  a top `[ OUTLINE ]` header (purpose + technical + a categorized index of all functions), a per-function
  block (`Function / LAYMAN / TECHNICAL / PARAMS / RETURNS / EXAMPLE`, depth-scaled), inline
  `/* Step N */` comments in substantive bodies, and essential section banners in the HTML/CSS.
- **Coverage:** ~**455 functions** — Code.js 35, index.html 89, pia_code.js 109, admin_code.js 65,
  pia_index.html ~47, adminView.html 110.
- **Safety:** comments-only — verified that **no executable line, string, or logic changed** (byte-level
  code-equality diffs on the backends + the cleanly-checkable frontend; "no executable line removed" on
  the two complex HTML files; all backends pass `node --check`, all frontends' scripts parse).
- **V1→V2:** V1 was hard to onboard into; V2's outline-first, layman-first docs let a new dev locate and
  understand any function fast.

---

*Prepared as context for the official documentation session. Everything above reflects the V2
finalization pass over the previous intern's V1 build.*
