# 04 · DCS (Phase 1) Reference

> The request form. Files: `Phase 1/index.html` (frontend, ~6,400 lines) + `Phase 1/Code.js`
> (backend, ~2,670 lines) + `Phase 1/appsscript.json`. UI is branded "Privacy Impact Assessment"
> but architecturally this is DCS / Phase 1. Verbatim deep-dive:
> `reference-docs/docs/manual/part-1-dcs.md`.

---

## Key behavior facts

- **DCS has NO approval gate.** On submit, `submitDCS` writes `Data_Collection.Status = COMPLETE`
  immediately. The entire approval ladder lives in PIA. So the post-submit email is a *submission
  confirmation* ("Proceed to Phase 2"), not an "approved" email.
- **Screens are built by JS at runtime**, the screen `<div>`s are empty in the HTML; `render*()`
  functions fill them. To find on-screen text, search the render function, not the HTML body.
- **Deep-link:** `boot()` reads `?parentID=<reqId>` via `google.script.url.getLocation()` and routes
  to `viewRequestDetails(reqId)`, sandbox-safe, no server templating. (DCS `index.html` is served
  with `createHtmlOutputFromFile`, it is **NOT** a GAS template, so no `<?…?>` engine.)

## The 9 screens (in `index.html`, swapped by `show(name)`)

| Screen | Purpose | Render fn (approx line, drifts) |
|--------|---------|-------------------------|
| landing | Home: New Request vs Review Applications | `renderLanding()` ~3626 |
| guide | Step 1: intro, T&C, template downloads | `renderGuide()` ~4008 |
| form | Step 2: main input form | `renderForm()` ~4237 |
| agency | Step 2b: extra fields, only if "involves an Agency" | `renderAgency()` ~5212 |
| summary | Step 3: review before submit | `renderSummary()` ~5327 |
| success | Confirmation + DCS ID | `renderSuccess()` ~5642 |
| drafts | Resume / disregard saved drafts | `renderDrafts()` |
| requests | "My Applications" list + status legend | `renderRequests()` ~5693 |
| request-details | One request's timelines + approver comments | `renderRequestDetails()` ~6029 |

Other key functions: `show()` (router), `validateDCSForm()`, `triggerAutoSave()` (debounced
autosave), `submitRequest()`, `editReturnedApplication()`, timelines `renderApprovalTracker()` /
`renderPiaTimeline()` (now **5 stages**: DCS Request → PIA Assessment → **Heads Approval** → ISM
Approval → Certification), `getCombinedStatusBadge()` / `getStatusKey()` (compute the rich badges).

## Form structure (Step 2)

- Profile (name auto/edited), location (pre-defined dropdown), department, **Access Type** (a
  2-option dropdown: **External / Internal**: External requires a DSA; Internal hides it), iHelp
  Reference (optional, numbers only), accountable persons (1–5), reporting heads (Immediate / Dept /
  Division: domain-validated emails), file uploads.
- **Category dropdown** (replaced the old "involves an Agency" checkbox): **None / Agency / OJT**.
  Agency → extra agency fields + Agency Endorsement Letter. OJT → Confidentiality Undertaking + School
  Endorsement Letter (the endorsement label is context-aware via `<span id="endorse-scope-word">`).
- The Step-2 **upload field is one dynamic field keyed by doc TYPE** (NDA/DPA/CU), not mirrored to
  the 7 download templates.

## Downloadable forms (7), `DOWNLOADABLES` array in `renderGuide()`

Labels/icons live in the array (code); the URLs are admin-managed `LINK_*_TEMPLATE` rows in
`System_Configuration` (generic config passthrough, adding/editing a link needs no code change).
Current keys: `LINK_NDA_EMPLOYEE_TEMPLATE`, `LINK_DSA_TEMPLATE`, `LINK_DPA_MEGAWORLD_TEMPLATE`,
`LINK_DPA_LUXURY_GLOBAL_TEMPLATE`, `LINK_DPA_GLOBAL_ONE_TEMPLATE`, `LINK_CU_AGENCY_TEMPLATE`,
`LINK_CU_OJT_TEMPLATE`. (Old `LINK_NDA_TEMPLATE` / `LINK_DPA_TEMPLATE` / `LINK_OJT_NDA_TEMPLATE` names
are **superseded.**) CU forms have a distinct amber color + person-check icon. Missing row → "Link
not set" (`#`).

## Backend (`Code.js`) highlights

- **`doGet`**, blocks non-domain accounts before serving the HTML (defense-in-depth).
- **Drafts**, `apiSaveDraft` / `apiRestoreDraft` / `apiListUserDrafts` / `apiDeleteDraft`. JSON
  autosave, 7-day TTL, shared `Drafts` sheet with PIA. **Files are NOT stored in drafts** (only text)
  — resuming requires re-upload. Intended.
- **`submitDCS(payload, sessionId)`** → `{success, reqId, phase2Url?}`, re-validates domain +
  required fields + email formats server-side. Writes `Data_Collection`, status `COMPLETE`. Fires
  `notifyDcsRequester_` (try/catch) on new submits.
- **`uploadProxy`**, base64 → Drive folder `ADMIN_FOLDER_ID`. Does **magic-byte anti-spoofing**
  (checks the file's real bytes vs claimed extension: `%PDF`, OLE, ZIP/DOCX), rejects renamed files.
- **`analyzeDCSRisk()`**, auto-flags conflict-of-interest / duplicate-role / short-entry /
  missing-accountable patterns into `Risk_Audit` (incl. drafter-email == head-email).
- **`notifyDcsRequester_`**, the one DCS email (see `08-emails-and-notifications.md`).
- **Security guards added (F-04, F-08):** `apiGetRequestData` (owner-only), `getGatewayRecord`
  (caller-bound).

## Design system (reuse these tokens, do NOT hardcode)

Defined in `:root` near the top of the `<style>` block. Navy palette: `--navy #1e3a5f`,
`--navy-mid #2a5285`, `--navy-bright #3b76c4`, `--navy-tint #f4f7fb`, `--navy-text #0f2238`.
Semantic: `--success / --danger / --warn` (+ `-text`). Type: `--font` = DM Sans, `--font-mono` =
DM Mono, base 13px, headings use `clamp()`. Shape: `--radius` 4px, `--radius-lg` 9px. Motion:
`--dur-fast/med/slow` + `--ease-*`. Components: `.card`, `.btn`/`.btn-primary`, `.status-badge`
(+ `-approved/-denied/-returned/-pending/-escalated/-processing/-submitted/-info`), `.alert-*`,
navy sidebars, vertical + horizontal timelines. Responsive breakpoints **768px** (tablet) and
**480px** (phone, sticky bottom button bar). New colors must reuse existing `--vars`.

## Change-safety checklist (run before declaring a DCS design change done)
Edited the right `render*()` (screens are JS-built)? · Reused `--design-tokens`, not hardcoded? ·
Checked **both** breakpoints (768 + 480)? · If you touched a timeline, updated **both** horizontal +
vertical variants? · Status badge/legend color+label+legend still agree? · No `google.script.run.api*`
call renamed/removed/invented? · No accidental change to validation / autosave debounce / submit
flow? · Loading / error / success / revision-mode states still render?
