# DCS / PIA / Admin (RARS): Features & Fixes List

**Scope:** DCS + PIA + Admin only (COC and the campaigns excluded).
**Total: 94 items** in feature format, covering June 8 to July 17, 2026.
Excluded from this list: 13 pure planning/documentation/audit entries, 2 config/deploy incidents, and 2 presentation deliverables (the user-manual flowchart and the TechServe/DCOPS PowerPoint), which do not fit a "how to test" format.

Grounded in the daily logs; several backend items were also cross-checked against the live code.

---

## June 8 to June 23 (27 items)

**Feature:** Fix Guide-screen crash (cuUrl vs cuURL typo)
**Brief Description:** The entire **New DCS Request Guide screen** failed to render (blank page), not just the **Confidentiality Undertaking (CU)** download card, an incomplete feature inherited from a previous dev.
**How it was implemented:** The CU link was declared as `cuURL` (from `state.config['LINK_CU_TEMPLATE']`) but referenced as `cuUrl` inside the template literal that builds the screen's innerHTML, so the undefined variable threw a **ReferenceError** and aborted the whole HTML string in `renderGuide()`. The fix aligned the reference to the existing `cuURL` declaration so the template literal builds successfully.
**Where to see / How to test:** Open the Guide screen (New DCS Request): it now loads completely, the CU card subtext reads "View agency document" (not "Link not set"), and clicking it opens the correct agency document. Clearing/restoring `LINK_CU_TEMPLATE` confirms it is config-driven.

**Feature:** CU download-card alignment fix
**Brief Description:** The **CU download card** was misaligned versus the sibling NDA/DPA/DSA cards.
**How it was implemented:** Changed the card's `align-items` from `center` to `left` so it matches the sibling NDA/DPA/DSA download cards.
**Where to see / How to test:** On the Guide screen, compare the CU card against the NDA/DPA/DSA cards: they now line up consistently.

**Feature:** Rebrand app to "Privacy Impact Assessment"
**Brief Description:** Rebranded the app surface to **"Privacy Impact Assessment"** across the main touchpoints.
**How it was implemented:** Updated the **homepage title, browser tab, guide-screen title, and footer** (footer now reads "Megaworld Corporation").
**Where to see / How to test:** Load the app: check the homepage heading, the browser tab label, the guide-screen title, and the footer text.

**Feature:** Add "OJT NDA" as 5th downloadable form
**Brief Description:** Added **"OJT NDA"** as a fifth downloadable form and tidied the downloads list so forms are easier to add/remove going forward.
**How it was implemented:** Added the new form to the downloadables list on the Guide screen and cleaned up that list structure.
**Where to see / How to test:** On the Guide screen download section, confirm "OJT NDA" appears as a fifth form.

**Feature:** Personalized greeting on main screens
**Brief Description:** Added a personalized **"Hi [firstname]"** greeting, headline-sized, pulled from the user's login email.
**How it was implemented:** Derived the first name from the user's login email and rendered it as a larger, headline-sized greeting on the homepage, guide, form, drafts, and my applications screens.
**Where to see / How to test:** Log in and view the homepage, guide, form, drafts, and My Applications screens: each shows "Hi [firstname]" at the top.

**Feature:** New request-category dropdown (None / Agency / OJT)
**Brief Description:** Replaced the old **"This request involves an Agency"** checkbox with a **dropdown (None / Agency / OJT)**; picking OJT requires a **Confidentiality Undertaking + Endorsement Letter** and skips agency-only fields.
**How it was implemented:** Converted the boolean agency checkbox into a three-option category dropdown; selecting OJT enforces the CU and Endorsement Letter uploads and bypasses the agency-only detail fields (frontend and backend).
**Where to see / How to test:** On the main form, open the category dropdown and pick OJT: confirm CU + Endorsement Letter become required and the agency-only fields are skipped.

**Feature:** Styled submission-confirmation email with "Proceed to Phase 2" button
**Brief Description:** After submitting a DCS, the requester now receives a **styled confirmation email** with a **"Proceed to Phase 2"** button (since a DCS request is cleared for Phase 2 immediately).
**How it was implemented:** Replaced the plain confirmation with a styled email template containing the Phase 2 call-to-action button.
**Where to see / How to test:** Submit a DCS request and check the requester's inbox: the confirmation email is styled and includes a working "Proceed to Phase 2" button.

**Feature:** Greeting changed to surname + fixed surname extraction
**Brief Description:** The greeting now reads **"Hello, <Surname>!"** and the surname parsing was corrected (`abcruz.global` wrongly gave "Global", now correctly "Cruz").
**How it was implemented:** In `index.html`, rewrote `deriveFirstName` into `deriveSurname` and updated `greetingLine()`, changing wording from "Hi …," to "Hello, …!"; `deriveSurname` strips the two leading initials, then takes the surname up to any separator (`.` `/` `_` `+` `-`).
**Where to see / How to test:** Log in as a user like `abcruz.global` and view any main screen: greeting shows "Hello, Cruz!" (not "Global").

**Feature:** Rename OJT downloadable to "OJT Confidentiality Undertaking"
**Brief Description:** The **"OJT NDA"** download was renamed to **"OJT Confidentiality Undertaking."**
**How it was implemented:** Changed the title in the `DOWNLOADABLES` array in `renderGuide()`; the config key `LINK_OJT_NDA_TEMPLATE` was left unchanged.
**Where to see / How to test:** On the Guide screen download list, confirm the item now reads "OJT Confidentiality Undertaking."

**Feature:** Restyle the category dropdown to the standard form-field pattern
**Brief Description:** The **"Agency or OJT?" category dropdown** now matches the clean look of the other form fields.
**How it was implemented:** Rewrapped the dropdown in the standard `.field` + `.input-wrapper` + `.select-wrap` pattern used by the other form fields.
**Where to see / How to test:** On the main form, compare the category dropdown to the other fields: styling is now consistent.

**Feature:** Fix DSA leak on External-to-Internal switch
**Brief Description:** Picking **External**, attaching a **DSA**, then switching to **Internal** could still submit the DSA file; this leak was fixed.
**How it was implemented:** Guarded the submit payload so the DSA is only included when `state.dcs.access === 'External'`.
**Where to see / How to test:** Select External, attach a DSA, switch to Internal, then submit: the DSA file is no longer sent.

**Feature:** Fix status badge stuck on "Ready for Phase 2"
**Brief Description:** After submitting a PIA, the applications list wrongly stayed **"Ready for Phase 2"**; it now correctly shows **"PIA In Progress."**
**How it was implemented:** In `getCombinedStatusBadge()`, stopped lumping `pia === 'pending'` together with the "no PIA yet" state.
**Where to see / How to test:** Submit a PIA, then open My Applications: the row shows "PIA In Progress" instead of "Ready for Phase 2."

**Feature:** Search box + status filter on Applications list
**Brief Description:** Added a **search box and status filter** to the applications list.
**How it was implemented:** `renderRequests()` now caches results, and new helpers `getStatusKey()`, `renderRequestRow()`, and `applyRequestFilters()` drive the search and status filtering.
**Where to see / How to test:** Open My Applications: use the search box and status filter to narrow the list.

**Feature:** Fix wrong DPA and OJT-CU downloadable links
**Brief Description:** The **DPA** and **OJT Confidentiality Undertaking** downloadables pointed to the wrong document links; both were corrected.
**How it was implemented:** Corrected the download link targets for the DPA and OJT CU forms.
**Where to see / How to test:** On the Guide screen, click the DPA and OJT CU download cards: each now opens the correct document.

**Feature:** Downloadable subtext labels + contextual Endorsement Letter label
**Brief Description:** Added clarifying **subtext to downloadables** (e.g. DSA "for third party", DPA emphasizing "for employee") and made the **Endorsement Letter** upload label contextual (School vs Agency).
**How it was implemented:** Added descriptive subtext to the download cards; when a request involves OJT the Endorsement Letter upload is labeled "School endorsement letter" and for Agency it becomes "Agency endorsement letter."
**Where to see / How to test:** On the Guide/form, check the download-card subtexts, then pick OJT vs Agency and confirm the Endorsement Letter upload label changes (School vs Agency).

**Feature:** Remove "Pending Immediate Head" from the status filter
**Brief Description:** Removed the **"Pending Immediate Head"** option from the applications status filter dropdown.
**How it was implemented:** Dropped that option from the status filter choices on the applications list.
**Where to see / How to test:** Open My Applications and check the status filter dropdown: "Pending Immediate Head" is no longer listed.

**Feature:** Fix "Proceed to Phase 2" crash (scriptlet in a doc-comment)
**Brief Description:** Clicking **"Proceed to Phase 2"** threw a full-page **`Unexpected token '...'`** error; the cause was a scriptlet example living inside a documentation comment, not real app code.
**How it was implemented:** In `Phase 2/pia_index.html`, two doc comments contained the literal example `<?!= parentID ? ... ?>`, and the GAS HtmlService template engine (which scans raw file text for scriptlet delimiters and does not skip comments) compiled them and failed on the `...`; the fix rephrased both comments to drop the `<?…?>` delimiters, leaving the one functional scriptlet untouched. It surfaced only via the button because that is the sole `doGet` branch calling `createTemplateFromFile('index').evaluate()`.
**Where to see / How to test:** Use a `?parentID=` deep link (the "Proceed to Phase 2" button): the PIA form now loads instead of crashing.

**Feature:** DCS deep-link for applicant "View DCS Submission" email button
**Brief Description:** The applicant's **"View DCS Submission"** email button used to dump the user on the DCS homepage; it now opens the exact request they applied for.
**How it was implemented:** In `Phase 1/index.html`, `boot()` reads `google.script.url.getLocation()` and routes to `viewRequestDetails(parentID)` when `?parentID=<DCS ReqID>` is present (sandbox-safe, no server templating); the PIA email already sends `?parentID`, so no PIA-side change was needed.
**Where to see / How to test:** Click "View DCS Submission" in an applicant email: it opens that specific request's details, not the homepage.

**Feature:** Honest approval-status wording in applicant emails
**Brief Description:** Intermediate approval steps in applicant emails no longer say **"APPROVED"** (which looked final); only the truly-done state now reads as fully approved.
**How it was implemented:** In `notifyApplicant`, reworded the `approved_main`, `approved_divhead_progressing`, and `approved` states so "APPROVED" is used final-only (intermediate steps say things like "Heads Approved, not yet final").
**Where to see / How to test:** Progress a request through an intermediate approval and read the applicant email: it no longer implies final approval until the request is actually fully approved.

**Feature:** InfoSec reviewer inline decision panel
**Brief Description:** Replaced the InfoSec reviewer's **pop-up decision modal** with an **inline panel** (Approve / Escalate / Return / Deny plus DCOPS/TechServe/Both routing) and added a submit spinner.
**How it was implemented:** In `Phase 2/pia_code.js`, removed the decision modal from the flow and surfaced inline routing radios plus action buttons (the `action-approve-group` set to `display:flex`), added a submit overlay, and made `submitWithRouting` enforce 50-char remarks for all decisions plus a routing destination for Approve/Escalate (client gate, since the server enforces 50 chars only for Deny/Return).
**Where to see / How to test:** Open the ISM reviewer screen: the decision choices and routing pick appear directly on the page, and clicking submit shows a "Submitting…" spinner.

**Feature:** Clean email footers (remove yellow "CAUTION" box)
**Brief Description:** Removed the alarming yellow **"CAUTION"** box from email footers and replaced it with a professional **no-reply notice**.
**How it was implemented:** Removed the CAUTION boxes in `buildPiaEmailHtml_`, the certificate, and the plain-text fallback, replacing them with a neutral "No-reply notice"; verified with a grep showing zero remaining CAUTION references.
**Where to see / How to test:** Trigger any workflow email and check the footer: it shows a clean no-reply notice instead of the yellow caution box.

**Feature:** Certificate routing label "BOTH" to "DCOPS and TechServe"
**Brief Description:** On the final certificate, **"Routed to: BOTH"** now reads **"Routed to: DCOPS and TechServe."**
**How it was implemented:** In `apiPhase3_RouteApprovedRequest`, the `routedLabel` mapping now converts `BOTH` to "DCOPS and TechServe" (and `TECHSERVE` to "TechServe").
**Where to see / How to test:** Finalize a request routed to both destinations and view the certificate: the routing line reads "DCOPS and TechServe."

**Feature:** Remove dead Decision Modal code
**Brief Description:** Deleted the leftover **"Decision Modal"** (the old pop-up already replaced by the inline decision panel), a harmless but dead remnant.
**How it was implemented:** Removed the modal's HTML block, its two functions, its navigation helpers, and the unused CSS from the PIA app.
**Where to see / How to test:** Code-level cleanup; confirm the ISM reviewer flow still works via the inline panel and no unused modal remains.

**Feature:** Fix PIA project timezone (Asia/Shanghai to Asia/Manila)
**Brief Description:** The **PIA project timezone** was set to **Asia/Shanghai**, causing timestamps to be **one hour off**; corrected to **Asia/Manila**.
**How it was implemented:** Changed the PIA GAS project timezone setting from Asia/Shanghai to Asia/Manila.
**Where to see / How to test:** Generate any PIA timestamp (submission, decision) and confirm it now matches Philippine local time.

**Feature:** Restructure downloadable forms from 5 to 7 (per-entity DPAs)
**Brief Description:** Expanded the downloadables from **5 to 7 templates** with clearer, audience-specific names and **per-entity DPAs** (Megaworld / Luxury Global / Global One).
**How it was implemented:** Renamed the config keys to be descriptive (e.g. `LINK_NDA_TEMPLATE` to `LINK_NDA_EMPLOYEE_TEMPLATE`) and updated all three touchpoints: the DCS guide list, the Admin Settings UI (link-management fields plus save logic), and the DB-seed default.
**Where to see / How to test:** On the Guide screen check the 7 forms and the three DPA variants; in Admin Settings confirm the link fields and save logic use the new keys.

**Feature:** Distinct look for Confidentiality Undertaking forms
**Brief Description:** Gave the **Confidentiality Undertaking (CU)** forms a unique appearance (**amber color + person-with-check icon**) so they no longer look like NDA/DPA cards.
**How it was implemented:** Styled the CU download cards with an amber color and a person-with-check icon to visually distinguish them.
**Where to see / How to test:** On the Guide screen, the CU cards now stand out in amber with the person-with-check icon versus the NDA/DPA cards.

**Feature:** Fix wording "Confidential Undertaking" to "Confidentiality Undertaking"
**Brief Description:** Corrected the wording bug **"Confidential Undertaking"** to **"Confidentiality Undertaking"** across the app.
**How it was implemented:** Updated the wording in the upload label, the validation, and the summary.
**Where to see / How to test:** Check the CU file upload label, trigger its validation message, and view the summary screen: all three now read "Confidentiality Undertaking."

---

## June 23 to June 24: Security hardening + feedback wave (19 items)

**Feature:** Admin privilege lockdown (F-01 / F-03)
**Brief Description:** Closed the hole where **any employee** could delete records, tamper with config, or **self-promote to admin** by calling server functions directly. Every privileged Admin function now requires an **INFOSEC member**.
**How it was implemented:** Added roughly **17 `checkAccess_` guards** across the read, write, reroute, download, and resend endpoints in `Admin/admin_code.js`, so each privileged call re-checks the caller is INFOSEC instead of trusting the page gate.
**Where to see / How to test:** Sign in as a non-INFOSEC account and call an Admin delete/config endpoint via `google.script.run` in the browser console: it should be rejected. INFOSEC accounts still use the full Admin dashboard normally.

**Feature:** Anti-forgery on approval decisions (F-02)
**Brief Description:** Stopped **any employee** from forging an approval **as another approver**. Decision functions now require the caller to actually be that approver.
**How it was implemented:** Added identity guards (active user must match the `approverEmail` param) to `apiPhase3_ProcessISMDecision`, `processApprovalDecision`, and `processDivHeadDecision` in `Phase 2/pia_code.js`.
**Where to see / How to test:** As user A, try to submit a decision passing user B's approver email through the console: it should be refused. The normal email-link approval path for the real approver still works.

**Feature:** DCS request read authorization (F-04 IDOR)
**Brief Description:** Closed an **IDOR** where **any employee** could read **other people's DCS requests**. Read access is now limited to the **owner or someone on the approval chain**.
**How it was implemented:** Added owner/approver guards to `apiGetRequestData` in `Phase 1/Code.js` so the fetch only returns data for the request's owner or an approver on its chain.
**Where to see / How to test:** As a user unrelated to a request, call `apiGetRequestData` with someone else's `reqId`: it should be denied. Owners and listed approvers still load the request details screen.

**Feature:** PIA submission read authorization (F-05)
**Brief Description:** Closed the hole where **any employee** could read **others' PIA submissions**.
**How it was implemented:** Added the authorization helper **`isAuthorizedForApplication_`** and applied it to `apiPhase3_FetchPIAData` and `apiPhase3_FetchDCSData` in `Phase 2/pia_code.js`.
**Where to see / How to test:** As an unrelated user, call the PIA/DCS fetch endpoints for another user's application via the console: it should be blocked. Owners and chain approvers still open the review screen.

**Feature:** Gateway status bound to signed-in user (F-08)
**Brief Description:** Stopped a caller from querying **another user's gateway status**; the lookup is now bound to the **signed-in user**.
**How it was implemented:** Changed `getGatewayRecord` in `Phase 1/Code.js` to key off the active session user instead of an email/ID passed as an argument.
**Where to see / How to test:** Call the gateway lookup passing a different user's identifier: it should only ever return your own record.

**Feature:** System-specific Terms & Conditions
**Brief Description:** The **T&C was empty**; wrote a full, system-specific Terms & Conditions grounded in **RA 10173 (Data Privacy Act)**, covering document requirements, approval process, confidentiality, and monitoring.
**How it was implemented:** Authored the content (`docs/Terms and Conditions.md`) tailored to the RARS workflow, displayed from an **external Google Doc** via the **`LINK_TC_PAGE`** setting (iframe mechanism, not inline), so Legal/ISM can edit without a code change. Also aligned the short summary card in the form (added CU and RA 10173).
**Where to see / How to test:** Open the DCS guide/form step where the T&C is shown: it should render the full document from the `LINK_TC_PAGE` Google Doc. Confirm the summary card mentions CU and RA 10173.

**Feature:** Downloadable file permission fix
**Brief Description:** Fixed access to the downloadable template files so **all Megaworld Corp** can view (and download), while **editing is limited to specific people**.
**How it was implemented:** Changed the Drive file permissions on the downloadables (OJT CU, Agency CU, and all DPA forms) to view-all for Megaworld Corp; editor rights kept to the DCS supervisor, the ISM coordinator, and the document custodian only, with everyone else view-only but able to download.
**Where to see / How to test:** As a general Megaworld Corp account, open each downloadable from the DCS guide list: you should be able to view and download but not edit.

**Feature:** Single merged final-approval email
**Brief Description:** Combined the **two final-approval emails** into **one** so applicants get a single clean notification at the end.
**How it was implemented:** Merged the two final-approval email sends into one in `Phase 2/pia_code.js` (Wave 1 item #20).
**Where to see / How to test:** Run a request through to final ISM approval: the applicant should receive one final email, not two.

**Feature:** Personalized approver email greetings
**Brief Description:** Approver emails now open with the **approver's name** instead of a generic greeting.
**How it was implemented:** Added a **name lookup from the DCS record** to personalize greetings in the PIA email flow (`Phase 2/pia_code.js`, Wave 1 item #14).
**Where to see / How to test:** Trigger an approver notification email and confirm the greeting shows the approver's actual name.

**Feature:** Role labels in email decisions HTML
**Brief Description:** The decisions block inside emails now shows each approver's **role label** for clearer context.
**How it was implemented:** Added role labels in **`generateEmailDecisionsHTML`** in `Phase 2/pia_code.js` (Wave 1 item #13).
**Where to see / How to test:** Open any workflow email that lists decisions: each decision line should carry its approver role label.

**Feature:** Stage-honest status badge in emails
**Brief Description:** The email status badge no longer **implies final approval** while the request is still mid-chain; it reflects the **true current stage**.
**How it was implemented:** Reworked the status badge to be stage-honest in the PIA email generation (`Phase 2/pia_code.js`, Wave 1 item #16).
**Where to see / How to test:** Approve only an early step and check the applicant/approver email: the badge should show the in-progress stage, not "approved."

**Feature:** Decision loading overlay on head review form
**Brief Description:** Added a **loading overlay** on the head review form so the reviewer sees clear feedback while a decision is submitting.
**How it was implemented:** Added a decision overlay to the head review form (`Phase 2/pia_code.js`, Wave 1 item #12).
**Where to see / How to test:** Open the head review form, submit a decision, and confirm the overlay appears during processing.

**Feature:** Redirect to home after PIA submit
**Brief Description:** After a PIA submission, the user is now **redirected to home** instead of being left on the form.
**How it was implemented:** Added redirect-home behavior after PIA submit in `Phase 1/index.html` (Wave 1 item #10).
**Where to see / How to test:** Complete a PIA submission and confirm the app returns to the home/landing screen.

**Feature:** Honest "re-upload required" on resumed drafts
**Brief Description:** Resuming a draft no longer shows a **false "checkmark selected"** for files that were never carried over; it now clearly says **re-upload required**.
**How it was implemented:** Replaced the misleading "checkmark selected" indicator with a "re-upload required" state on resumed drafts in `Phase 1/index.html` (Wave 1 item #5).
**Where to see / How to test:** Save a draft with files, resume it, and confirm the file fields show "re-upload required" rather than an already-selected checkmark.

**Feature:** Clickable Drive "view" links on submitted documents
**Brief Description:** Submitted documents in the **review summary** now have **clickable "View" links** that open the file in Drive.
**How it was implemented:** Added Drive `/view` links via `fileLinkHtml` and `summaryRowRaw` in the review summary (Wave 2 item #2). Note: this same `fileLinkHtml` template-literal later caused the blank-page bug (see the June 24 fix below).
**Where to see / How to test:** Open a submitted request's review summary and click a document's "View" link: it should open the file in Drive.

**Feature:** Reviewers see all documents (NDA/DPA included)
**Brief Description:** Reviewers can now see **all documents** attached to a request, including **NDA and DPA files**, not just a subset.
**How it was implemented:** Rewrote **`getAndShareDCSFiles`** to use **stored file IDs** so every submitted document is surfaced to reviewers (Wave 2 item #15).
**Where to see / How to test:** As a reviewer, open a request that includes NDA/DPA uploads and confirm all documents appear and are accessible.

**Feature:** PIA progress timeline expanded to 5 stages
**Brief Description:** The PIA progress timeline went from **4 to 5 stages**, adding a distinct **"Heads Approval"** stage.
**How it was implemented:** Refactored **`renderPiaTimeline`** to 5 stages with the new "Heads Approval" step (Wave 2 item #11).
**Where to see / How to test:** View the PIA progress timeline on any request and confirm it shows 5 stages including "Heads Approval," on both the horizontal and vertical (mobile) variants.

**Feature:** Supporting Documents section on the certificate
**Brief Description:** The certificate now includes a **"Supporting Documents"** section listing the attached files.
**How it was implemented:** Added the "Supporting Documents" section into the routing/certificate flow (Wave 2 item #19). Note: the separate certificate-to-Drive link item was intentionally skipped.
**Where to see / How to test:** Reach a fully certified request and view its certificate: it should show the Supporting Documents section.

**Feature:** Blank-page production bug fix (GAS serve-time corruption)
**Brief Description:** After deploying the feedback waves, the entire **DCS page went blank**. Root cause was a **template-literal helper corrupted at the GAS serve step**, not the app logic.
**How it was implemented:** The page threw `Uncaught SyntaxError: Unexpected identifier 'style'` at GAS's `document.write(s(g))` serve step even though `node --check` passed (it validates disk, not serve-time serialization); the `fileLinkHtml` template literal was serialized into an unterminated string. Fixed by rebuilding the helper with plain **ASCII string concatenation** (`Phase 1/index.html`). Two earlier hypotheses (a Unicode arrow char, then its adjacent backtick) were tested and ruled out.
**Where to see / How to test:** Load the live DCS page after deploy: it should render fully. To see ground truth on any recurrence, read the served VM file at the console error's `VM##:line`, not the disk file.

---

## July 6: Post-ISM-demo feedback (24 items)

**Feature:** Required iHelp Ticket Number and Office/Site
**Brief Description:** The DCS intake form now **requires** the **iHelp ticket number** and the **Office/Site** field before a request can be submitted.
**How it was implemented:** Added both fields to the **requiredFields** validation on the frontend and backend (defense in depth).
**Where to see / How to test:** Open the DCS request form, leave the iHelp ticket or Office/Site blank, and try to submit: it should block you until both are filled.

**Feature:** Agency New vs Replacement Request Type
**Brief Description:** Agency requests now ask whether the access is **New** or a **Replacement**, and Replacement prompts for the person being replaced (full name plus email, for DCOPS).
**How it was implemented:** Added new **agencyRequestType**, **replacementFullName**, and **replacementEmail** fields written into the **MetadataAgency** JSON (additive, no column rename).
**Where to see / How to test:** In the DCS form, flag the request as involving an Agency, choose Replacement, and confirm the full name and email fields for the replaced person appear and are captured.

**Feature:** Approver Comments on the Certificate of Approval
**Brief Description:** The **Certificate of Approval** now displays each approver's **comments**, not just their decision.
**How it was implemented:** Added a new **Comments column** to the certificate tables.
**Where to see / How to test:** Take a request to full approval and open the generated certificate: each approver row should show their comment text.

**Feature:** Certificate PDF Attached to the Approved Email
**Brief Description:** The applicant's **"fully approved" email** now carries the **certificate PDF** as an attachment plus a **"being processed, contact TechServe"** message.
**How it was implemented:** Reordered **cert-PDF generation to run before notifyApplicant** so the PDF can be attached synchronously, with a **queue fallback** if the send fails.
**Where to see / How to test:** Fully certify a request and check the applicant's approval email for the attached certificate PDF and the TechServe processing note.

**Feature:** Per-Site TechServe Routing
**Brief Description:** **TechServe emails now route per-site** (a site can have multiple recipients) instead of going to one shared address.
**How it was implemented:** Added a **SITE column** to **InfoSec_Email_Config** and a **resolveTechserveForSite_** resolver with a safe DCOPS-only fallback; the real site list (AGT/GDP/EGP/TWS) and account IDs (INFOSEC-ALL-1/2, DCOPS-ALL-1) were later finalized with the supervisor.
**Where to see / How to test:** Submit requests for different sites and confirm the TechServe notification reaches the site-specific recipient(s) rather than one global address.

**Feature:** Removal of Admin Delete/Close Ticket
**Brief Description:** Removed the risky Admin **"delete/close ticket"** feature that **permanently wiped records and audit history**.
**How it was implemented:** Removed the **deleteEntry** and **batchDeleteEntries** functions.
**Where to see / How to test:** In the Admin dashboard, confirm the delete/close ticket action is gone and records can no longer be permanently removed.

**Feature:** Silent Email-Notification Failure Fix
**Brief Description:** A notification that silently failed to send is now **retried via the email queue** instead of being lost.
**How it was implemented:** Fixed **notifyApplicant** to **fall back to the queue** when the direct send fails.
**Where to see / How to test:** Simulate or trigger a send failure and confirm the applicant notification is queued and still delivered rather than dropped.

**Feature:** TechServe Misrouting Edge-Case Fix
**Brief Description:** Fixed an edge case where TechServe routing could resolve incorrectly.
**How it was implemented:** Added **fallback safety** to the **resolveTechserveForSite_** resolver.
**Where to see / How to test:** Submit a request for a site with missing or partial TechServe config and confirm it falls back safely instead of misrouting.

**Feature:** Missing Agency Fields on the Certificate Fix
**Brief Description:** Agency-specific fields that were **missing from the certificate** now appear correctly.
**How it was implemented:** Fixed the **cert Agency section field mapping**.
**Where to see / How to test:** Certify an Agency request and confirm all agency fields render on the certificate.

**Feature:** Empty OJT Certificate Section Fix
**Brief Description:** Fixed a certificate section that showed up **empty for OJT requests**.
**How it was implemented:** Added an **OJT empty-header guard**.
**Where to see / How to test:** Certify an OJT request and confirm no blank/empty section appears on the certificate.

**Feature:** Admin Access Lockout Fix
**Brief Description:** Restored **Admin access** after an ID rename had **orphaned the login check** and locked out everyone, and added a way to grant access.
**How it was implemented:** Rewrote **checkAccess_** to authorize on **Role === 'InfoSec'** (instead of hardcoded Member_IDs) OR presence in the new **Admin_Notification_Config** list.
**Where to see / How to test:** Log into the Admin app as an InfoSec user (or one listed in Admin_Notification_Config) and confirm access is granted.

**Feature:** Stale Selected File on Internal/External Switch Fix
**Brief Description:** An old uploaded file no longer stays **"selected"** after switching between **Internal and External**.
**How it was implemented:** Added a new **clearUpload()** helper that fires on doc-type change.
**Where to see / How to test:** Upload a file, switch Internal to External (or back), and confirm the previous file selection is cleared.

**Feature:** OJT Forces External Access Type
**Brief Description:** OJT requests now **force the Access Type to External** and lock it.
**How it was implemented:** **applyInvolvement()** locks the Access Type field when the request is OJT.
**Where to see / How to test:** Select OJT in the DCS form and confirm the Access Type is set to External and cannot be changed.

**Feature:** Agency Requires Network Drive
**Brief Description:** Agency requests now **require a Network Drive** value.
**How it was implemented:** Added the **networkDrive** requirement to **validateAgencyForm** and **submitDCS**.
**Where to see / How to test:** Submit an Agency request without a Network Drive value and confirm it is blocked until filled.

**Feature:** Loading Spinner on Disregard Draft
**Brief Description:** Disregarding a draft now shows a **loading spinner** for feedback.
**How it was implemented:** Added a loading spinner to the **disregard-draft** action.
**Where to see / How to test:** Open the Drafts screen and click disregard on a draft: a spinner should appear while it processes.

**Feature:** Red-Asterisk Required-Field Markers
**Brief Description:** Required fields now show a **red asterisk** marker.
**How it was implemented:** Reused the **reqMark()** required-field indicator pattern from PIA.
**Where to see / How to test:** Open the DCS form and confirm required fields display a red asterisk next to their labels.

**Feature:** TechServe Contacts as Name Plus Email
**Brief Description:** TechServe contacts now display as **Name plus email** instead of a jumbled comma-separated list.
**How it was implemented:** **apiPhase3_GetInfoSecMembers** now returns **{name, email} pairs**.
**Where to see / How to test:** View the TechServe contact block (in the approval email or Admin) and confirm each contact shows a name and email cleanly.

**Feature:** Restructured Approval-Email Layout
**Brief Description:** The applicant approval email was **restructured** into a cleaner, ordered layout.
**How it was implemented:** Reordered **notifyApplicant** content into: **banner, cert note, Review Status, TechServe block, button**.
**Where to see / How to test:** Trigger a fully-approved applicant email and confirm the sections appear in the new order.

**Feature:** Documents Section Shows Every Submitted File
**Brief Description:** The review/documents section now lists **every submitted file**, not just the CU, including the **Agency/OJT endorsement letter** as a Drive link.
**How it was implemented:** Added the **endorsement letter** to both the summary and the post-submit details as a **Drive link** for Agency and OJT requests.
**Where to see / How to test:** Submit an Agency or OJT request with an endorsement letter and confirm it appears (as a clickable Drive link) in both the summary and request details.

**Feature:** Step Tracker False "Incomplete" Fix
**Brief Description:** Fixed a step tracker that **falsely showed "incomplete"**.
**How it was implemented:** Removed the false positive in **hasUnfilledOptionalFields()**.
**Where to see / How to test:** Complete a form with optional fields left blank and confirm the step tracker no longer marks the step incomplete.

**Feature:** Validate Before Loading Spinner
**Brief Description:** Form **validation now runs before the loading spinner**, avoiding a frozen UI.
**How it was implemented:** Reordered the submit flow so **validation runs ahead of the spinner** display.
**Where to see / How to test:** Submit the DCS form with an invalid field and confirm you get the validation message immediately without the UI freezing behind a spinner.

**Feature:** Cleaner PII-Collected Pills Layout
**Brief Description:** The **PII-collected pills** now lay out cleanly in a full-width wrapping row.
**How it was implemented:** Moved **.pii-tag** to a **full-width flex-wrap** layout.
**Where to see / How to test:** View a request with multiple PII categories and confirm the pills wrap neatly across the full width.

**Feature:** Review Status of Prior Decisions in All Approver Emails
**Brief Description:** All **4 approver emails** now show a **"Review Status"** of the decisions made before them.
**How it was implemented:** Reused **generateEmailDecisionsHTML** across all approver-email builders.
**Where to see / How to test:** Advance a request through the approval ladder and confirm each approver's email shows the prior approvers' decisions.

**Feature:** Admin Row-Selection Highlight Fix
**Brief Description:** Fixed **invisible row-selection highlighting** in the Admin dashboard.
**How it was implemented:** Fixed the **.selected row CSS**, which was colliding with the **zebra-stripe background**.
**Where to see / How to test:** In the Admin dashboard, click a table row and confirm the selection highlight is now visible over the striped rows.

---

## July 15 to July 17: Round-4 and round-5 batch (24 items)

**Feature:** Supplementary files no longer lost on draft resume
**Brief Description:** Resuming a draft used to show a false **"3 files selected"** over an empty input, so people submitted thinking their supporting files were attached when they were not.
**How it was implemented:** In `Phase 1/index.html`, `resumeDraft()` now includes supplementary in its `hasFiles` check, clears `supplementaryNames`, and stashes the count in `state.dcs._suppReuploadCount`; the supplementary card renders an amber re-attach notice when that count is set. `handleSupplementaryChange` clears the count on a new selection, and `submitRequest` shows a confirm dialog if the count is set but the input is still empty.
**Where to see / How to test:** Save a draft with supplementary files attached, resume it, and confirm the card shows the amber re-attach notice instead of a green "files selected", then try to submit without re-attaching to hit the confirm dialog.

**Feature:** N/A checkbox now visible
**Brief Description:** The **"No email available (N/A)"** checkbox rendered invisibly because a blanket CSS rule had stripped its native appearance.
**How it was implemented:** In `Phase 1/index.html`, the blanket `.field input { appearance: none }` had removed native checkbox rendering with no override in place. Added a `.field input[type="checkbox"]` rule restoring `appearance: auto`, `-webkit-appearance: checkbox`, `accent-color: var(--navy-bright)`, and auto width/height.
**Where to see / How to test:** On the agency step, click the N/A email checkbox and confirm it now displays a proper checkmark.

**Feature:** N/A checkbox no longer triggers false email-validation error
**Brief Description:** Checking the **N/A email box** still raised an "email is required" error even though N/A was the intended value.
**How it was implemented:** In `Phase 1/index.html`, `syncAgencyState()` was reading the disabled empty email input and overwriting `'N/A'` with `''` before validation ran. Added an early return: if the N/A checkbox is checked, store `'N/A'` and skip reading the disabled input entirely.
**Where to see / How to test:** On the agency step, check the N/A email box and submit; confirm no email-validation error appears.

**Feature:** Decision result box always green
**Brief Description:** After an approver acted, the confirmation box showed **red for Return and Deny** but green for Approve, which read as inconsistent since the color only confirms the save.
**How it was implemented:** In `Phase 2/pia_code.js`, only `action === 'Approve'` previously hit the green box while Return and Deny fell to the red branch. The result page now always renders the **green box** regardless of decision, while the heading text still states the actual decision ("Request Returned," "Request Denied," etc.).
**Where to see / How to test:** As an approver, submit a Return or Deny and confirm the result page is green with a heading that names the correct decision.

**Feature:** Legacy boilerplate approval comments filtered everywhere
**Brief Description:** The auto-inserted filler comments **"Approved via secure access review link."** and "No additional comments provided." were showing up as if they were real approver remarks.
**How it was implemented:** In `Phase 2/pia_code.js` and `Phase 1/index.html`, both fallback strings were removed at the write path (now stores `''`). Added `isLegacyDefaultComment_(c)` (pia_code.js) and `isLegacyDefaultComment(c)` (index.html) to silently filter the two boilerplate strings at every render surface (approval trackers, emails, certificate, review forms), with a read-only filter that never rewrites sheet rows.
**Where to see / How to test:** Approve a request without typing a comment, then view the approval trackers, emails, and certificate and confirm no boilerplate comment appears.

**Feature:** Heads now see prior-round decisions on their review screen
**Brief Description:** Department Head and Immediate Head reviewing in a later round saw **nothing from prior rounds**; only the Division Head saw other-approver history.
**How it was implemented:** In `Phase 2/pia_code.js`, the standard review form showed other-approver badges only when `approverType === 'divhead'`. That conditional was replaced with `buildUnifiedHistoryHtml(getUnifiedHistory(sessionId, true))` for **all approver types**, so every reviewer sees the complete grouped-by-round history.
**Where to see / How to test:** Have a request returned and resubmitted, then open the standard review form as a Department or Immediate Head and confirm the full prior-round Approval History shows.

**Feature:** Requestor sees flagged fields in read-only details
**Brief Description:** A requestor could only see **which fields an approver flagged** after entering edit mode, not in the plain details view.
**How it was implemented:** In `Phase 1/index.html`, `data.approverFlags` had been reduced to an unused boolean and reasons only rendered in edit mode. `renderRequestDetails` now builds a `flaggedItemsListHtml` block (stripping the `'DCS - '` prefix from labels) and injects it into the amber `dcsRevisionBannerHtml` card, visible in the read-only details view before clicking Edit.
**Where to see / How to test:** As a requestor with a returned request, open the request details view and confirm the flagged items list shows in the amber banner before entering edit mode.

**Feature:** Flag reasons moved inside each upload card
**Brief Description:** Flag reasons for the **NDA, DSA, and Endorsement** documents floated in separate boxes above the upload cards instead of belonging to them.
**How it was implemented:** In `Phase 1/index.html`, three standalone `alert-danger` divs sat above the NDA, DSA, and Endorsement upload cards. All three were removed, and each card now renders its flag reason as a danger-colored `<span>` inside its own `.upload-text` section.
**Where to see / How to test:** On a returned request in edit mode, confirm each flagged document's reason appears inside its upload card rather than in a box above it.

**Feature:** Return requires exactly one flagged item on both forms
**Brief Description:** The **return threshold was inconsistent**: the standard review form required two flags while the ISM form required none.
**How it was implemented:** In `Phase 2/pia_code.js`, `showReturnOptions` had a `< 2` guard on the standard form and no guard on the ISM form. Both forms now use `< 1`, so **exactly one flag** is required to return on either form.
**Where to see / How to test:** On both the standard and ISM review forms, try to Return with zero flags (blocked) and with one flag (allowed).

**Feature:** Flag buttons on every document row
**Brief Description:** Approvers can now **flag any document individually**, including each additional supporting (supplementary) file.
**How it was implemented:** In `Phase 2/pia_code.js`, `dcsFilesHtml` and `endorsementFileHtml` now wrap each doc link with `makeFlagBtn(label)` in an inline-flex span, using labels like 'DCS - NDA Document', 'DCS - DSA Document', 'DCS - Endorsement Letter', and 'DCS - Additional Supporting Document: <filename>'. The review-screen doc-type detection (Layer 0) also now checks `f.type === 'SUPPLEMENTARY'` first so each supplementary file gets its own correctly labeled flag key.
**Where to see / How to test:** On a review form with attached documents, confirm every doc row (including each supplementary file) shows its own flag button.

**Feature:** Flagged supplementary files force replacement and archive the old version
**Brief Description:** When an approver flags a supporting document, the requestor **must re-upload it on resubmit**, and the old file is archived rather than kept or deleted.
**How it was implemented:** In `Phase 1/index.html`, new `getFlaggedSupplementaryFiles()` scans `approverFlags` for the supplementary prefix; in revision mode the supplementary card shows a danger notice and `validateFileUploads()` blocks submission until a new file is uploaded. In `Phase 1/Code.js`, `submitDCS()` runs `archiveAndRecordSuperseded_` on existing SUPPLEMENTARY drive entries before uploading replacements when it is a revision, flags contain a supplementary key, and new supplementary files are present.
**Where to see / How to test:** Flag a supplementary file as an approver, resubmit as the requestor, and confirm submission is blocked until re-upload and that the old file is archived (not deleted) in Drive.

**Feature:** getFlagMessage enriched
**Brief Description:** Flag messages gained a proper **Endorsement Letter label** and a guard so supplementary file keys do not accidentally match other document cards.
**How it was implemented:** In `Phase 1/index.html`, `getFlagMessage` added the `'dcs-agency-endorsement'` to 'Endorsement Letter' label mapping, plus a guard preventing supplementary filename keys (which start with `'DCS - Additional Supporting Document:'`) from substring-matching against other cards.
**Where to see / How to test:** Flag an endorsement letter and a supplementary file, then confirm each card shows its own correct flag message with no cross-labeling.

**Feature:** Unified status-color matrix across all surfaces
**Brief Description:** One consistent color rule now applies everywhere: **approved green, returned amber, denied red, escalated and pending blue**, unknown neutral.
**How it was implemented:** Applied across all four files: in `Phase 2/pia_code.js` served CSS, added `.status-returned`, changed `.status-escalated` purple to blue and `.status-pending` amber to blue, remapped Return/Returned to `status-returned` while keeping 'Rejected by ISM' as terminal red, and recolored the escalate button and Teams routing badge from purple (#7c3aed) to blue (#1e40af). In `Phase 2/pia_index.html` the pending/escalated badges went to blue and identity chips to neutral `.chip-identity`, and in `Phase 1/index.html` the unknown-decision fallback moved from green `status-approved` to neutral `status-info`.
**Where to see / How to test:** Compare status badges across emails, review forms, certificate, and the DCS details view and confirm the color for each status matches on every surface.

**Feature:** "Previously reviewed by you" chip
**Brief Description:** When a revised request comes back to an approver who already acted, they now see a personal chip noting **they previously approved or returned it**.
**How it was implemented:** In `Phase 2/pia_code.js`, new `getLatestPriorDecisionByEmail_(sessionId, email)` walks revision-history rounds descending and matches by normalized email, and `buildPriorReviewChipHtml_(sessionId, email)` returns an email-safe amber chip ("You approved/returned this on [date] (Round N). It was revised, please re-review."). It is injected at four call sites (before the CTA in `notifyApprover` and `apiPhase3_NotifyISMember`, and near the top of both review forms) with try/catch so a failure never breaks an email.
**Where to see / How to test:** Have an approver act, get the request returned and resubmitted back to them, then confirm the amber "previously reviewed by you" chip appears in their email and on the review form.

**Feature:** Certificate enrichment
**Brief Description:** The final certificate's Application Brief now shows **Site/Office, the DCS submission date, and the PII categories collected**.
**How it was implemented:** In `Phase 2/pia_code.js`, the certificate Application Brief gained three rows: Site/Office (`dcsData.locations`), DCS Submitted (`dcsData.submissionDate`), and PII Categories Collected (`getPIIFieldsList(appData)` joined, fallback "None specified").
**Where to see / How to test:** Fully certify a request and open the certificate; confirm the three new rows appear in the Application Brief.

**Feature:** Unified approval-history builder feeding seven surfaces
**Brief Description:** A single shared builder now produces the same **grouped-by-round approval history** across emails, both review forms, the certificate, DCS details, and the PIA timeline.
**How it was implemented:** In `Phase 2/pia_code.js`, new `collectCurrentRoundDecisions_(sessionId, includePending)` reads all three live workflow sheets (write path untouched), and `getUnifiedHistory(sessionId, includePending)` combines prior rounds from `getRevisionHistory` with the current round, feeding `buildUnifiedHistoryHtml` (email-safe inline styles, "Round N (Current)" headers, unified colors, legacy-comment filter). `generateEmailDecisionsHTML` was refactored to delegate to it (all five email call sites unchanged), both review forms and the certificate now render it, `buildRevisionHistoryHtml` was deleted after zero callers remained, and `Phase 1/Code.js` added `getRevisionHistoryRows_` plus a `revisionHistory` field on `apiGetRequestData` so `renderUnifiedApprovalHistory(data)` in `Phase 1/index.html` merges the two prior tracker cards into one.
**Where to see / How to test:** View the approval history in an email, a standard review form, an ISM review form, the certificate, the DCS request-details card, and the PIA wizard timeline; confirm all show the same grouped-by-round history.

**Feature:** Additional Supporting Documents upload section
**Brief Description:** Requestors can now attach **ad-hoc extra supporting files** through a new multi-file upload section.
**How it was implemented:** A new supplementary (SUPPLEMENTARY-typed) multi-file upload section was added, with the review side detecting `f.type === 'SUPPLEMENTARY'` and giving each file its own flag key, and the DCS side handling re-upload and archival of these files on revision.
**Where to see / How to test:** On the DCS form, use the Additional Supporting Documents section to attach multiple files and confirm they upload and appear as individually flaggable rows on the review screen.

**Feature:** Reminder cadence changed to 7 then every 3 days
**Brief Description:** Pending approvers now get a **first reminder after 7 days, then one every 3 days** after that.
**How it was implemented:** The reminder clock is driven by a `NotifiedDate` column that gates the first reminder at 7 days and subsequent reminders at a 3-day interval, in `sendDailyReminders()` (`Phase 2/pia_code.js`).
**Where to see / How to test:** Leave an approval pending and confirm the first reminder email fires around day 7 and repeats every 3 days after, with `NotifiedDate` stamped on the workflow row.

**Feature:** Admin "Megaworld ISM Department" branding
**Brief Description:** Admin emails and the certificate header now carry consistent **"Megaworld ISM Department" branding**.
**How it was implemented:** In `Admin/admin_code.js`, `sendEmailWithRetry_` now sets `options.name = 'Megaworld ISM Department'` when not already set, `buildAdminEmailHtml_`'s eyebrow was changed to "Megaworld ISM Department," and `buildCertificateHtml_` gained a "Megaworld ISM Department" eyebrow div in the certificate header.
**Where to see / How to test:** Trigger an admin-sent email and open a certificate; confirm both display the "Megaworld ISM Department" branding.

**Feature:** New Revision_History sheet with snapshot-before-delete hook
**Brief Description:** A new **Revision_History sheet** preserves the full approval audit trail across resubmits instead of losing prior rounds when the ladder rebuilds.
**How it was implemented:** A snapshot is written before the workflow rows are deleted on resubmit, and `Phase 1/Code.js`'s `getRevisionHistoryRows_(ss, piaSessionId)` reads that sheet through a local col map mirroring `REVISION_HISTORY_COLS` (read-only, schema owned by PIA), surfacing prior rounds to the unified history builders.
**Where to see / How to test:** Return and resubmit a request, then confirm prior rounds still appear in the unified approval history (sourced from the Revision_History sheet) rather than being wiped.

**Feature:** Dead stakeholder Add/Remove buttons fixed
**Brief Description:** On the privacy assessment form, the **Add and Remove stakeholder buttons were completely non-functional**.
**How it was implemented:** In `Phase 2/pia_index.html`, `syncPIA3State()`'s `gather()` collapsed empty stakeholder rows before `addStakeholderField`/`removeStakeholderField`'s length guards could run. Fixed by adding a `keepEmptyRows` param so the guards see the blank rows.
**Where to see / How to test:** On PIA Section 3 stakeholders, click Add and Remove and confirm rows are added and removed correctly.

**Feature:** Duplicate supplementary files on return fixed
**Brief Description:** When a request was returned and its supporting document re-uploaded, the **old version was quietly kept alongside the new one**, so both showed in the file list and certificate.
**How it was implemented:** In `Phase 1/Code.js`, `getPIARecordByDCSId_` searched a hardcoded `'B:B'` range instead of the resolved `Linked_ReqID` column, so `submitDCS`'s supplementary-archive gate never fired; the column lookup was corrected and an `oldMetadata.approverFlags` fallback added. In `Phase 2/pia_code.js`, `updateDCSStatus` now accepts an `approverFlags` param and mirrors flags into the DCS `Metadata_JSON` at all three Return call sites (`processDivHeadDecision`, `processApprovalDecision`, `apiPhase3_ProcessISMDecision`).
**Where to see / How to test:** Return a request with a supplementary document, re-upload it, complete the flow, and confirm only the newest version shows in the file list and certificate while the old one is archived.

**Feature:** Approval status shown as a colored pill badge
**Brief Description:** Each approval step's status now renders as a **clean colored pill badge** instead of plain text.
**How it was implemented:** In `Phase 2/pia_index.html`, `renderApprovalTimeline` now wraps status labels in `getStatusBadgeClass()` pills.
**Where to see / How to test:** Open the PIA approval timeline and confirm each status shows as a colored pill rather than plain text.

**Feature:** DCS Section 2 checklist icon always shows a green check once passed
**Brief Description:** The Section 2 sidebar icon sometimes showed a confusing **"?" instead of a green checkmark** after you moved past it.
**How it was implemented:** In `Phase 1/index.html`, `renderSidebarTracker` dropped its Section-2-specific "?" branch and the now-dead `hasUnfilledOptionalFields()` helper, so a passed step always renders as done.
**Where to see / How to test:** Fill Section 2 of the DCS form, advance past it, and confirm the sidebar icon shows a green check every time.
