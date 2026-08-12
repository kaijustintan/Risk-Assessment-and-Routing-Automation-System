# 05 · PIA (Phase 2) Reference, the approval engine

> The privacy assessment **and** the entire multi-level approval workflow. Files:
> `Phase 2/pia_index.html` (frontend wizard) + `Phase 2/pia_code.js` (backend, ~9,000 lines) +
> `Phase 2/pia_appsscript.json`. Verbatim deep-dive: `reference-docs/docs/manual/part-2-pia.md`.

---

## ⚠️ Templating gotcha (pia_index.html only)

PIA's `pia_index.html` **is** a GAS template, `doGet` calls `createTemplateFromFile('index').evaluate()`
on the `?parentID=` path. So the `<?…?>` scriptlet engine is active and **parses `<?…?>` even inside
comments**. Never put a literal `<?…?>` example in a comment here (it caused the "Proceed to Phase 2"
crash). The one real scriptlet is `const parentId = <?!= … ?>` (~line 4044), leave it; VS Code's
"problems" on it are false positives.

## The approval ladder (top to bottom)

```
Applicant submits PIA
 └─ STAGE A — Main heads        (Approval_Workflow sheet)
      Step 1: Immediate Head     ← from the applicant's PIA1 answers (per-request)
      Step 2: Department Head     ← from PIA1.  Fallback: PRIVACY_OFFICER_EMAIL if neither valid.
 └─ STAGE B — InfoSec / ISM      (ISM_Approval_Workflow sheet)
      InfoSec Reviewer 1 → Reviewer 2   ← from InfoSec_Email_Config (active=YES)
      both must Approve in sequence.  Each can: Approve · Deny · Return · EscalateToDivisionHead.
 └─ STAGE C — Routing            (chosen by the InfoSec reviewer on Approve/Escalate, NOT a gate)
      DCOPS · TECHSERVE · BOTH    ← where access is provisioned after final approval.
 └─ STAGE D — Division Head      (DivisionHead_Approval_Workflow sheet) — ONLY if an InfoSec member escalates.
Final: all InfoSec approve → 'Approved by ISM' → applicant notified, DCS marked COMPLETE, routed.
```

Key functions: `buildApproversFromAppData` (seeds Stage A), `initializeApprovalWorkflow`,
`processApprovalDecision` (Stage A heads), `apiPhase3_ProcessISMDecision` (Stage B/C/D dispatch),
`getISMReviewerStep` (1=Person1, 2=Person2), `processDivHeadDecision` (Stage D),
`apiPhase3_RouteApprovedRequest` (finalize: certificate + route + DCS Complete).

## Who fills each approver (hybrid, deliberate)

- **Fixed, org-wide roles are admin-configured:** the InfoSec reviewers + DCOPS/TechServe destinations
  live in `InfoSec_Email_Config` (active=YES); `PRIVACY_OFFICER_EMAIL` is the head fallback.
- **Per-applicant roles are applicant-filled in PIA1:** Immediate / Dept / **Division** Head, because
  they're that person's own reporting line, which varies per request and would be unmaintainable as a
  central org chart.
- Integrity risk (naming yourself/a friend) is **mitigated, not prevented**, by `analyzeApplicationRisk`
  (flags drafter-email == head-email). Future hardening = source the head chain from HR/Workspace.

## Escalation = "up to Division Head, then back down" (NOT skip-to-final)

When an InfoSec member picks `EscalateToDivisionHead`:
- That ISM row → `EscalatedToDivisionHead`; app status → `Escalated to Division Head`; the ISM chain
  **pauses** (the next ISM member is NOT notified yet).
- A single Pending `DivisionHead_Approval_Workflow` row is created (dedup guard prevents duplicates),
  and the Division Head named in PIA1 (`divHeadEmail`) is emailed a review link.
- Division Head decides (`processDivHeadDecision`):
  - **Approve** → the escalated ISM step is marked Approved. If that makes **all** ISM rows Approved →
    finalize. If not → **resume the ISM chain at the next step** (`apiPhase3_NotifyISMember`), i.e. it
    comes back *down* to the remaining reviewer.
  - **Deny** → app Denied (terminal). **Return** → app Returned to applicant → full restart.

## Return = FULL restart, not resume

A "Return" from **any** approver (head, InfoSec, or DivHead) always bounces to the **applicant**,
never to a previous approver. On resubmit, `submitApplication` **deletes all** `Approval_Workflow` +
`ISM_Approval_Workflow` + `DivisionHead_Approval_Workflow` rows for that session and **rebuilds from
Stage A, Step 1 (Immediate Head)**. All prior approvals are wiped; nothing resumes. Lineage is kept
via a revision id (`-V2`, `-V3`…) but approval progress resets to zero. **Return ≠ Deny** (Return is a
fixable loop; Deny is terminal). If the linked **DCS** is `Returned`, PIA resubmission is **blocked**
until the DCS is fixed first.

## ISM reviewer screen (redesigned)

Inline decision panel (replaced the old "Review & Submit Decision" modal): the routing radios
(DCOPS/TechServe/Both) + all 4 actions (Approve/Escalate/Return/Deny) are shown directly on the page,
with a "Submitting your decision…" overlay. **`submitWithRouting` (client) enforces 50-char remarks on
every decision + a routing destination on Approve/Escalate.** ⚠️ The **server** enforces the 50-char
minimum only for **Deny/Return**, so the client gate is what covers Approve/Escalate. The final
reviewer's routing choice **binds**; Step 1's routing is a recommendation shown to Step 2.
> Tech debt note from history: an old hidden "Decision Modal" HTML block was later **deleted**, if you
> see references to a decision modal in old notes, it's gone.

## Certificate & finalization

`apiPhase3_RouteApprovedRequest(sessionId, destination)` builds the **Certificate of Approval**
(Application Brief + Supporting Documents list + Agency info + full approver chain + routing label),
emails it **+ a PDF attachment** to DCOPS/TechServe immediately (not queued), marks DCS COMPLETE, and
the applicant gets the `approved_ism_final` email. See `08-emails-and-notifications.md` for the
certificate-content limitation (iHelp-dependent spec).

## Security guards added (F-02, F-05)
Identity checks on `apiPhase3_ProcessISMDecision`, `processApprovalDecision`, `processDivHeadDecision`
(caller must be the named approver); `isAuthorizedForApplication_` (owner-or-approver) on
`apiPhase3_FetchPIAData` / `apiPhase3_FetchDCSData`. See `07-security-hardening.md`.

## Other PIA facts
- **All PIA email is queued** (`Email_Queue` + `processEmailQueue` trigger). **Reminders live here**
  (`sendDailyReminders`, ~line 4671), not in Admin. See `08-emails-and-notifications.md`.
- PIA reads the DCS row via `parentID` / `Linked_ReqID`. PIA1 answers are stored on `Applications`
  (e.g. `PIA_1_DATA`). The PIA3 stakeholder section hides external fields when the DCS access type is
  Internal (and vice versa), frontend-only in `pia_index.html` `renderPIA3`.
- `SYSTEM_SECRET` (this project) signs the HMAC review tokens (14-day TTL).
