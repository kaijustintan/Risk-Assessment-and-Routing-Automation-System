# 08 · Emails & Notifications

> Every email in the system, who sends it, who receives it, and how. This trips people up because
> **DCS and PIA use different sending mechanisms** and several "missing email" reports were actually
> recipient-side filters.

---

## Two sending engines (key distinction)

| | DCS (Phase 1) | PIA (Phase 2) | Admin (Phase 3) |
|---|---|---|---|
| Mechanism | **Direct** `MailApp.sendEmail` | **Queue** → time-trigger | Direct (`MailApp`, manual resend only) |
| Where | `notifyDcsRequester_` (`Code.js:~1734`) | `queueEmail` → `Email_Queue` sheet → `processEmailQueue` (~1-min trigger, installed once via `setupEmailQueueTrigger()` `pia_code.js:~4625`) | `adminResendEmail` |
| Timing | synchronous (silent try/catch) | arrives ~1–2 min after the action | on demand |

> **"Sent" in `Email_Queue` ≠ delivered.** And a recipient Gmail filter ("Skip the Inbox + Apply
> label") once made all mail land in *All Mail*, not the Inbox — diagnosed as a human filter, not a
> system bug.

## The emails, by trigger

### DCS — exactly one email
- **`notifyDcsRequester_(toEmail, reqId, phase2Url)`** — the styled *"Request submitted — Proceed to
  Phase 2"* confirmation. Fired inside `submitDCS` (try/catch failsafe), **new submissions only**
  (`!isRevision`). Contains a `?parentID=` deep-link into PIA. Reuses `generatePhase2Url_`.
  (DCS has **no approval gate** — it's `COMPLETE` on submit — so this is a *submission confirmation*,
  not an "approved" email.)

### PIA — the workflow emails (all queued, all build links at send time)
- **Approver "Review Access Request"** (Immediate Head, Dept Head, ISM reviewers) — tokenized review
  link built from **`WEB_APP_URL`** via `getWebAppUrl()`.
- **Applicant status emails** (`notifyApplicant`) — `submitted`, `progressing`, `approved_main`
  ("Heads approved — not yet final"), `approved_ism_final` ("FULLY APPROVED"),
  `approved_divhead_final`, `returned`, `denied`. Wording is **stage-honest** (no bare "APPROVED"
  mid-flow). Applicant "View DCS Submission" link built from **`DCS_WEB_APP_URL`** (the PIA copy) via
  `getDCSWebAppUrl()`.
- **Daily approver reminders** — see below.
- **Final routing → DCOPS / TechServe** — see below.
- Footers: the alarming yellow "CAUTION" box was removed → a neutral **"No-reply notice."**

### Admin — manual resend only
- An ISM clicks "Resend Email" → `adminResendEmail` re-fires `notifyApprover` / `notifyApplicant` /
  `apiPhase3_NotifyISMember` via `sendEmailWithRetry_`. These are **generic "log in to the system"**
  notices (CTA = `getOptionalUrl_('WEB_APP_URL')`, **no token, no `parentID`**) — a fallback nudge,
  not the primary tokenized workflow emails. Missing property → button silently omitted (graceful).
- Admin emails were **beautified** with a shared navy template (`buildAdminEmailHtml_`, applied to ~6
  senders via `htmlBody`, additive — recipients/subjects/plain-text fallback unchanged).

## Final approval → DCOPS / TechServe (important, often misunderstood)

On final approval **two separate things happen**:
1. **Applicant** gets the `approved_ism_final` "fully approved" email (queued).
2. **DCOPS and/or TechServe** get a **"[CERTIFICATE OF APPROVAL] Implementation Required"** email —
   the full certificate HTML **+ a PDF attachment** — telling them to provision the access. Sent
   **immediately** via `sendEmailWithRetry` (NOT the queue), in `apiPhase3_RouteApprovedRequest`
   (`pia_code.js:~7425`, called at `:7159` for the normal path and `:3970` for the escalated path).

- **Which team(s):** depends on the routing the final InfoSec reviewer chose — `DCOPS`, `TECHSERVE`,
  or `BOTH`. (Step-1 reviewer's routing is a *recommendation* shown to Step 2; the **final** reviewer's
  choice binds.)
- **Recipient addresses:** from `InfoSec_Email_Config` (active=YES) → `destinationEmails.dcops` /
  `.techserve`. If none configured → returns an error, no send (graceful).
- **What the certificate contains:** an "Application Brief" (DCS Request ID, Program, Department,
  Requestor, **Purpose**, **Access Type**, **iHelp Reference**, Accountable Persons), a **Supporting
  Documents** list (clickable Drive links — Wave 2 #19), Agency info (if any), the full approver chain
  with timestamps, and the routing label.
- **Known design limitation (flagged, not a bug):** the cert is a *brief*, not a full PIA dump. The
  PIA "Scope of Processing" (`pia1.scope`) answer is **not** forwarded; "Access Type" is only the
  Internal/External dropdown. The **exact technical spec is expected to live in the iHelp ticket** —
  but **iHelp Reference is an OPTIONAL field**, so if left blank the implementer has only the free-text
  Purpose. Open question for ISM: should iHelp be mandatory? (See `10-work-history-and-current-state.md`.)
- The old duplicate applicant "routed for implementation" email was **removed** (Wave 1 #20) to avoid
  two applicant emails — the team notification is unaffected.

## Daily approver reminders (lives in PIA, NOT Admin)

- The real engine is **`sendDailyReminders()` / `buildReminderEmail()` / `setupReminderTrigger()` in
  `Phase 2/pia_code.js` (~line 4671).** A daily `ScriptApp` time-trigger **inside the PIA project**
  (`atHour(8).everyDays(1)`, needs `script.scriptapp`) scans the 3 workflow sheets for `Pending` rows
  and emails **only the next pending approver per request**, stamping `ReminderDate` so each is nagged
  **once per day** until they act. Reminder emails carry a **valid tokenized review link**.
- **History:** an Admin-side reminder was built first, then **deliberately removed** ("PIA's is
  canonical") — so the CLAUDE.md note "reminders live in PIA, not Admin" reflects a real refactor.
  ⚠️ If an old `adminApi_sendDailyReminders` time-trigger still exists in the Admin project, it will
  error daily (the function is gone) — **delete that Admin trigger.**
- The **Admin panel only *configures*** reminders (on/off, hour) via a cross-app API
  (`getReminderConfig` / `setReminderConfig`, dispatched in PIA `doPost`).
- ⚠️ The PIA reminder trigger must be **scheduled once** (`setupReminderTrigger()` in PIA → Triggers);
  Kai later confirmed it exists, but verify if reminders aren't firing.

## Properties feeding email links (see `03-deployment-and-operations.md` for the full map)
`WEB_APP_URL` (PIA) → approver/ISM/reminder links · `DCS_WEB_APP_URL` (PIA copy) → applicant "View
DCS Submission" · all frozen at send time · HMAC tokens 14-day TTL.
