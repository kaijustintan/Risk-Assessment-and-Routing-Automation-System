# Appendices (RARS Manual)

> Reference material that supports all three parts. To avoid drift, the long-form documents
> (test guide, T&Cs, security findings) keep their **canonical copy in `docs/`**, this file
> summarizes and links rather than duplicating.

---

## Appendix A: Changelog / version history

> The live source of truth for each phase is its GAS cloud project; this repo is where we
> edit before copy-pasting in (see [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).
> Dates are approximate to the work session; see `git log` for exact commits.

> **Canonical narrative lives elsewhere.** The full V1→V2 before/after, including the
> "Journey" of *why* each decision was made, is maintained in
> **`docs/V2 - Difference from V1 (Old System).md`**. To avoid drift, this appendix only
> summarizes; update the V2 doc, not this list, when describing what changed.

### June 2026 session: Wave 1/2 + security hardening *(detail: V2 doc §9)*
- **Downloadables 5 → 7 forms** (per-entity DPA: Megaworld / Luxury Global / Global One + CU
  for Agency & OJT), new `LINK_*_TEMPLATE` keys ([Part 1 §1.2](part-1-dcs.md#12--maintenance-)).
- **5-stage timeline**, "Heads Approval" split out
  ([§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline)).
- **Clickable Drive "View" links** for uploaded docs in request details; **reliable reviewer
  docs** (ID-based lookup + fallback); **Certificate supporting-documents list** (saving the
  cert PDF to Drive was intentionally deferred).
- **Security hardening (F-01…F-08)**, per-function authorization across all 3 apps
  ([§0.6](part-0-common.md#06--security-model), Appendix D).
- **Bug fix:** blank DCS page from GAS template-literal serve corruption, fixed via string
  concatenation ([§0.5](part-0-common.md#05--known-gotchas--debugging)).

### July 2026 session: post-demo feedback (Rounds 1–3) + full hardening audit
- **DCS form:** iHelp Reference and **Office/Site** are now **required**; Office/Site fixed to
  **AGT / GDP / EGP / TWS** (removed CIP/Eastgate + the "Others" free-text). Agency requests ask
  **New vs Replacement** (Replacement captures the replaced person for DCOPS); **OJT forces
  External** access; **Network Drive required** for agency; red-asterisk required-field indicators;
  the summary + details Documents section now lists **every** submitted file (main doc, DSA,
  endorsement) ([Part 1](part-1-dcs.md)).
- **PIA per-site TechServe**, `InfoSec_Email_Config` gains a **`Site`** column; TechServe is one
  row per (site, email), resolved by the request's Office/Site with a DCOPS-only fallback
  ([§0.2](part-0-common.md#02--architecture--data-model), [Part 2](part-2-pia.md)).
- **PIA certificate + emails**, the certificate now shows approver **comments** and is **attached
  to the applicant's FULLY-APPROVED email** (with a named per-site TechServe contact block); all
  four **approver emails carry a Review Status** block ([Part 2](part-2-pia.md)).
- **Admin access rewired**, `checkAccess_` is now **role-based** (active `InfoSec` role) **+ the
  `Admin_Notification_Config` tab**, replacing the hardcoded `INFOSEC-001/002` allowlist that broke
  when IDs were renamed to `INFOSEC-ALL-1/2` ([§0.6](part-0-common.md#06--security-model),
  [Part 3](part-3-admin.md)).
- **Admin delete feature removed**, the hard cascading ticket-delete (+ audit purge) was pulled;
  records are now immutable from Admin. Also fixed invisible row-selection highlighting.
- **Ops lesson:** a non-owner deploy took the whole system down mid-day (execute-as identity),
  always deploy as the owner `<owner-account>` ([§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).
- **Loophole/hardening pass:** queue-fallback for the final applicant email, safe TechServe
  fallback (no PII to the wrong team), and a document-required backend check.

### August 2026 session: cross-repo review backlog cleared
Prompted by `docs/Cross-Repo Review - DCS vs COC.md`. Two waves.

**Wave 1 (2026-08-11), append-only approvals + callable surface.** A resubmit no longer deletes
the previous round's approvals; `Revision_History` retired. Callable surface closed project-wide
(178 → 82 public functions). Uploaded documents made private. Answer snapshots added.
See [§0.6 Hardening history, Round 2](part-0-common.md#hardening-history).

**Wave 2 (2026-08-12), the remaining seven items.**
- **No raw error text reaches a browser** (finding F-06). 110 catch blocks were handing
  Google's own error message to the user, and those quote the spreadsheet and Drive folder IDs.
  Users now see a plain sentence plus a short **reference code**; ask for that code and search the
  Executions log for it. Errors also carry a machine-readable type so the UI can distinguish
  "not allowed" from "system busy" ([§0.6](part-0-common.md#06--security-model)).
  ⚠️ This wave reported it closed at **89**; 21 more were found and fixed in Wave 3 (below).
- **Export to Sheet is no longer formula-injectable.** A request whose text began with `=` used to
  execute as a spreadsheet formula the moment an admin opened the export, under the admin's own
  Google account ([Part 3](part-3-admin.md)).
- ~~**Approver delegation / out-of-office**~~ **(REMOVED in Wave 5, 2026-08-14.)** Built here,
  deleted two days later after review: picking a stand-in approver was judged outside an admin's
  scope. The `Delegations` tab and `ActedBy` columns survive but are permanently empty and inert
  ([Part 3](part-3-admin.md)).
- **Retention & purge, built and shipped SWITCHED OFF.** Nothing had ever deleted personal data.
  The sweep reports what *would* go and deletes nothing until ISM sets a period and turns off
  dry-run. 🚩 **A purge cannot be undone, preview it with ISM first.** It also takes over the DCS
  draft purge, which had been written for a trigger that was never installed.
- **"Where do requests get stuck" panel** in Admin → Analytics: days-waiting buckets and a
  most-stuck list, from data that already existed.
- **Performance**, ~150 whole-sheet reads unified behind one reader with an opt-in per-request
  cache; the database file is now opened once per run instead of up to 13 times.
- **One canonical design-token file**, replacing six drifting copies, including two that had been
  rendering the approver-facing decision page in the wrong navy.
- ~~**"View" shows the document on the page**~~ **(SUPERSEDED in Wave 4, 2026-08-14.)** The in-page
  overlay could not be made to work: Chrome refuses to render the document bytes inside Apps
  Script's sandboxed frame. "View" now opens the **Google Drive viewer in a new tab** instead.

Detail: [§0.6 Hardening history, Round 3](part-0-common.md#hardening-history).

**Wave 3 (2026-08-12), data-integrity pass.** Wave 2 closed the review backlog but left four items
open; this wave clears them. Where Waves 1 and 2 were about *who can reach what*, this one is about
the system **reading the wrong thing without complaining**.

- **Six silent column-drift defects fixed.** Four were user-visible: Admin's Flags tab always read
  zero; agency details could be invisible in Admin depending on which app created the sheet first;
  revising a DCS request silently dropped its superseded-document trail and reset the revision
  count; and delegated decisions wrote into a column with no header.
- **One header list per sheet, and it checks itself.** Column positions are now derived from a
  single ordered header list rather than hand-numbered next to it, so the two can no longer drift
  apart. A sheet whose headers disagree fails **loudly on first access** instead of quietly reading
  the neighbouring column. Existing databases repair their own headers once, automatically, on the
  first load after deploy. No manual spreadsheet editing is needed.
- **The error format finished its transition.** Responses carry one shape now, not two.
- **21 further raw-error leaks closed**, including every Admin dashboard handler. 🚩 Wave 2 had
  recorded this finding as complete; it was not. See
  [Appendix D](#appendix-d--security-findings--recommendations).
- **Em dashes removed** from source comments, user-facing copy and documentation, per the house
  writing rule. Empty-state placeholders (a bare dash meaning "no value") are deliberately kept.

⚠️ **Deliberately still open, not a defect:** approver emails typed by the applicant are **not**
validated against an employee directory, because no such directory is available to this project.
The mitigation is after-the-fact rather than preventive: the approval history records every
approver's name and email, so a self-approval or a friend-approval is visible on the record.

Detail: [§0.6 Hardening history, Round 4](part-0-common.md#hardening-history).

**Wave 4 (2026-08-13/14), second manual test pass.** The first round of the system being driven by
a real reviewer end to end. Most items were presentation defects, but two were genuine workflow
failures.

- **Documents open in the Google Drive viewer.** The Wave 2 in-page overlay was abandoned after
  being proven impossible: Chrome refuses to render the document bytes inside Apps Script's frame,
  in an `<iframe>` and an `<object>` alike (both were tried on the deployed app). "View" now opens
  Drive in a new tab. Files stay private at upload and are shared **only** with the company, and
  **only** at the moment an authorised person opens one. If the browser blocks the pop-up, it falls
  back to downloading the file.
- **🐞 Closed rounds no longer show fake "Pending" approvers.** When a request was returned, the
  approvers further up the ladder who were never reached still displayed as if they were actively
  reviewing. A round that is over now shows only what was actually decided.
- **🐞 Two reviewers could disagree on the routing destination, silently.** The last one to decide
  simply won. The winner is unchanged (that is an ISM policy call, not a bug to fix in code), but a
  disagreement is now written to the audit log so it is visible.
- **One approval-history format everywhere.** The same block now renders in all five emails, both
  review pages, both certificates, the applicant's request page and the Admin audit modal.
- **The certificate carries one approval record**, the round-grouped history, instead of the same
  information twice in two different shapes.
- **Two serve-time outages fixed and permanently guarded.** An `xmlns` attribute inside a script
  block was silently truncated by Apps Script on serve, blanking the entire page. A new checker
  (`serve.js`) now fails the build on it. See [§0.5](part-0-common.md#05--known-gotchas).

**Wave 5 (2026-08-14), third feedback pass and the delegation reversal.**

- **⛔ Approver delegation deleted.** See Wave 2 above. Choosing who covers an absent approver was
  judged to sit outside an admin's scope: file a new request naming an available approver instead.
  One case cannot be routed around, an absent **ISM reviewer**, because those come from
  configuration rather than from the applicant. Accepted and documented
  ([Part 3](part-3-admin.md)).
- **Comment minimums lowered to 30 characters**, from 50 (ISM remarks) and 100 (Return/Deny
  reason). Reviewers were padding text to clear 100, which is worse than a short honest comment.
  🚩 The two limits remain **separate constants**, so ISM can raise the Return/Deny bar alone
  without touching routine remarks.
- **Approval history reordered so the actionable part comes first**: who decided what, then the
  items they flagged, then their comment, and the **date last** instead of second.
- **🐞 A required field was not marked as required.** The stakeholder Name field in PIA Section 3
  had no asterisk while the field beside it read "Email (Optional)", so people only discovered it
  was mandatory after pressing Next. Every required field in both apps was audited.

Detail: CLAUDE.md §8e.

### Recent commits (newest first)
| Commit | Summary |
|--------|---------|
| `3d1e7e4` | feat(dcs,pia,admin): batch-3 fixes: date-last history format, 30-char comment floor, required markers |
| `0731607` | refactor(admin): delete delegation write path, keep the identity guard intact |
| `7635a82` | feat(dcs,pia,admin): batch-2 fixes: Drive-viewer documents, round-scoped history, unified format, single-record certificates |
| `ca152b2` | docs: record the flags-only-on-return contract, plain-text policy, and cert round fix |
| `845d740` | fix(pia): repair stakeholder buttons, supplementary-doc duplication, and status display |
| `e449dd8` | feat(tools): add serve.js, catch GAS serve-time xmlns truncation |
| `4a3b617` | fix(dcs,admin): drop the xmlns attribute that GAS truncated on serve |
| `737e71c` | fix(dcs): repair the HTML escaper that never escaped anything |

> Keep this table updated as new versions ship. For deeper V1→V2 differences, see
> `docs/V2 - Difference from V1 (Old System).md`.

---

## Appendix B: Testing & QA

The full, step-by-step manual test plan (including **Part F** for the Wave 1/2 changes) lives
in **`docs/TEST GUIDE - DCS PIA Session Changes.md`**. Run it after every deploy, with the
caveats from [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls):

- **Test with a fresh transaction**, emails freeze their links at send time, so old inbox
  links won't reflect a property change.
- **Use freshly generated links**, review tokens expire after 14 days.
- Use a test corporate account; prefer a **copy** of the production spreadsheet (point the
  relevant `*_ID` Script Property at it) over live data.

Quick smoke test per phase:
- **DCS:** submit a request with test PDFs → verify it appears in Review Applications, a row
  lands in `Data_Collection`, files are in the Drive folder, and the confirmation email sends.
- **PIA:** open via a `?parentID=` link → complete the 7 steps → approve as each role →
  verify the certificate routes to the chosen team.
- **Admin:** load the dashboard as an INFOSEC account → verify the joined table, audit logs,
  routing, and settings read/write.

---

## Appendix C: Terms & Conditions

The canonical Terms & Conditions text shown to DCS applicants is maintained in
**`docs/Terms and Conditions.md`** (and surfaced in DCS Step 1 via the `LINK_TC_PAGE`
`System_Configuration` row, [§1.2](part-1-dcs.md#12--maintenance-)). Refer to that file for
the authoritative wording; update it there, not here, to avoid drift.

---

## Appendix D: Security findings & recommendations

This session's security review is documented in two `docs/` files:
- **`docs/Security - Review Findings.md`**, the findings (incl. F-04, F-05, F-08, identity
  guards, access-control gaps).
- **`docs/Security - Recommendations.md`**, recommended hardening and follow-ups.

Summary of what was applied is in [Appendix A](#appendix-a--changelog--version-history) and
[§0.6](part-0-common.md#06--security-model). Notable **future** hardening (not yet done):
sourcing the per-applicant head chain from an HR directory / Workspace org unit instead of
applicant-entered emails (mitigates self-approval risk).

---

*← [Part 3: Admin](part-3-admin.md) · Back to [Index](README.md)*
