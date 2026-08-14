# Feedback Batch 2: findings and gameplan

**Date:** 2026-08-13 (post-deploy, all three apps live)
**Sources:** `FEEDBACL.pdf` (14 screenshots, extracted and read) plus the organised write-up.
**Status:** investigation complete, no code written. Decisions needed on B1, C8, D3.

Every verdict below names the function and line that settles it. Where I could not settle
something from code, it says so explicitly and what would settle it.

---

## 0. Sheet ordering: safe, reorder freely

**Verdict: no effect. Reorder the tabs however you like.**

Every database access in all three backends resolves a sheet **by name**, 86 `getSheetByName`
calls (Admin 53, Phase 1 29, PIA 4, PIA being low because it funnels through
`getDatabaseSheet_`). There are exactly two positional calls in the whole repo and neither
touches the database:

| Call | File | What it actually is |
|---|---|---|
| `ss.getSheets()` | `Admin/admin_code.js:1498` | A name lister for a debug endpoint. Order-insensitive. |
| `ss.getActiveSheet()` | `Admin/admin_code.js:3262` | The **newly created** export spreadsheet in `exportToSheet`, one sheet old. Nothing to do with the DB. |

`assertSheetSchema_` compares header **rows**, not tab positions, so it will not complain
either. One caveat that is about renaming, not reordering: do not rename a tab. That would
break every one of those 86 lookups.

---

# PART A: the questions that gate everything else

## A1. Sheet flow, and Revision_History is dead

**`Revision_History` is retired. Nothing writes it, nothing reads it.** Confirmed: zero code
references across all three backends. Every remaining hit in the repo is a comment, a doc, or
an archived snapshot. `writeRevisionHistorySnapshot_`, `getRevisionHistorySheet_`,
`getRevisionHistory_`, `REVISION_HISTORY_COLS` and DCS's `getRevisionHistoryRows_` are all
deleted. If the tab still exists in the spreadsheet it is an empty shell you can ignore or
delete after a backup.

What replaced it: the workflow sheets became append-only, so prior rounds are never deleted
and are themselves the history. Per-approver flags live on the approver's own decision row
(`FLAGGED_FIELDS`).

### The write map

| Event | Sheets written | Where |
|---|---|---|
| **DCS submit** | `Data_Collection` (new row), `Risk_Audit` (risk flags), `Drafts` (delete) | `Code.js submitDCS` |
| **DCS revision** | `Data_Collection` (overwrite row, `metadata.supersededFiles` appended), `Risk_Audit` | `Code.js:1924` |
| **PIA submit** | `Applications` (new row), `Approval_Workflow` (round 1 ladder), `Risk_Audit` | `submitApplication_` |
| **PIA resubmit** | `Application_Snapshots` (copy of the old answers, **first, inside the lock**), then `Applications` (overwrite, `Approver_Flags` cleared), then round N+1 appended to the ladder | `submitApplication_` |
| **Head decision** | `Approval_Workflow` (that row), `Applications.Status`, `Applications.Approver_Flags` on Return only, `Risk_Audit` (email log) | `processApprovalDecision_` |
| **ISM decision** | `ISM_Approval_Workflow`, `Applications.Status`, `Risk_Audit` | `apiPhase3_ProcessISMDecision` |
| **Escalation** | `DivisionHead_Approval_Workflow` (one Pending row), ISM row to `EscalatedToDivisionHead` | same |
| **Return with a `DCS - ` flag** | all of the above **plus** `Data_Collection.Status = 'Returned'` | `updateDCSStatus_`, see D1 |
| **Final certification** | `Applications.Status = 'Approved by ISM'`, `Data_Collection.Status = 'Complete'`, `ISM_Approval_Workflow.Routing_Destination`, cert emailed (never archived) | `routeApprovedRequest_` |

### The read rule, and it is the one that matters

- **Routing reads** ("who acts next?") must be scoped to the current round via
  `rowMatches_(row, cols, sid, round)`.
- **History and authorisation reads** ("what happened?", "were they ever party to this?")
  must span all rounds, `round = null`.

`isAuthorizedForApplication_` is deliberately NOT round-scoped. Scoping it would silently
revoke view access from anyone who approved an earlier round.

## A2. The "something is wrong here" page: almost certainly not a role leak

**Verdict: this is the approver's own review form re-rendered after a server-side validation
failure. It is E1's symptom, not a view leak.** I need one confirmation from you before I
close it, per your instruction, but here is why I am confident.

The evidence, all from your own screenshots:

1. The deployment ID in that URL (`AKfycbw_vEAn8Y_kb...`) is byte-identical to the URL in the
   two full-resolution screenshots of the same session, and **those two show the footer
   "You are reviewing as ctpaulican.global@megaworldcorp.com"**.
2. That footer is rendered at `pia_code.js:3869`, inside `renderReviewForm`, from
   `Session.getActiveUser()` resolved server-side. It cannot be spoofed by a link.
3. The page can only be reached with a valid HMAC token bound to the approver email
   (`isTokenValid`, 14-day TTL).
4. The error banner text is generated at `pia_code.js:4110` and re-rendered by the
   `renderReviewForm(errorMsg, comment)` call at `pia_code.js:4120`. That is the exact string
   in your screenshot.

So: you submitted a Return with a comment under 100 characters, the server did the full
round-trip, rejected it, and re-drew the approver form with the error at the top. The
"ACTION REQUIRED / CURRENT STATUS Pending" framing is that form's normal chrome.

**One thing that keeps this from being airtight, and it is worth saying plainly:** in the
current test rig `ctpaulican.global@megaworldcorp.com` is the approver for **every** step, and
the requestor on PIA-000027 is a different person (Juan Dela Cruz). So the only way you land
on that page is signed in as ctpaulican. The screenshots say you were.

**Confirm for me:** were you signed in as `ctpaulican.global@megaworldcorp.com` at 8:01 PM,
and did you reach that page from an email link? If yes, this is closed as E1. If you were
signed in as the requestor account, stop everything and tell me, because that would be a
genuine authorisation break and it outranks this entire document.

## A3. The four open questions

### `Risk_Audit`: not useless, it is doing four jobs

It looks empty of value from the Admin dashboard because the dashboard only surfaces one of
its four roles. Deleting or ignoring it would break the Admin email console.

| Job | Written by | Read by |
|---|---|---|
| DCS auto risk flags (conflict of interest, duplicate role, short entry) | `logDCSAuditTrail_`, `analyzeDCSRisk_` (Phase 1) | Admin audit modal, "Risk Audit Logs" |
| **The email log and queue** | every send path | **Email Routing → Email Queue and Email Failover tabs** (`admin_code.js:641`, `:703`, `:5141`, `:5215`), plus cancel and resend (`:790`, `:882`) |
| Retention and backup outcomes | `runRetentionSweep`, `runDatabaseBackup_` (`:3024`) | operator, after the fact |
| Snapshot-failure alarm | `writeApplicationSnapshot_` on failure | operator, this is the alarm that replaced a silent `Logger.log` |

Nothing downstream computes from it: the aging report reads the workflow sheets, retention
reads decision dates. But job 2 means **Email Routing stops working without it**. Keep it.

### Admin → Email Routing: not redundant, it is the recovery console

Three tabs (`adminView.html:1727`):

1. **Certificate Routing:** look up one request, see where its certificate went, re-send it.
2. **Email Failover:** list failed sends, resend.
3. **Email Queue:** monitor the async queue, cancel entries.

It does **not** configure the DCOPS/TechServe destinations. Those live in
`InfoSec_Email_Config` (active=YES) and are edited in Settings. So Routing and Settings are
not duplicating each other: Settings decides who gets mail, Routing fixes mail that did not
arrive. Keep both.

### Re-uploaded documents on resubmit: yes, archived, working

**P1-07's archiving half is implemented and correct.** `archiveSupersededFiles_`
(`Code.js:1462`) records `{type, id, name, supersededAt, supersededRound}` for each replaced
file, and `Code.js:1924` carries the prior trail forward and appends this round's
replacements. Files are **moved to an Archive folder, not trashed**. They surface as
"Previous Versions (superseded)" on the DCS request-details screen (`index.html:6805`) and in
the certificate (`pia_code.js:10376`). The counter half was the `freshData[5]/[6]` off-by-one
already fixed on 2026-08-12.

### DCS-only flags: see D1.

---

# PART B: bugs

## B1. Document preview: the fallback is correct, the experiment failed

**Verdict: the fallback is firing correctly, for the correct reason. It is not masking a
broken preview path. The preview path genuinely cannot work here.**

`<object data="blob:..." type="application/pdf">` renders its child fallback when the browser
declines to instantiate a PDF viewer for that source. Inside Apps Script's sandboxed iframe,
Chrome declines for `blob:` PDFs. That is the same refusal that blanked the `<iframe>`; the
only thing `<object>` bought us is that the refusal is now visible instead of a silent blank
panel. So the experiment you agreed to run has run, and it lost.

**Every surface that renders this viewer, three copies, they must be edited together:**

| Surface | File | Line |
|---|---|---|
| DCS request details | `Phase 1/index.html` | 3453 |
| PIA applicant wizard | `Phase 2/pia_index.html` | 4042 |
| Approver and ISM review pages | `getStyledHtmlWrapper_` in `Phase 2/pia_code.js` | 2135 |

They are three copies of one function, not one shared component. Admin has no preview overlay;
it links out separately.

**This is your decision. Three real options:**

| Option | What the approver sees | Cost |
|---|---|---|
| **A. Drive link** (you pre-agreed to this) | New tab, native Google PDF viewer, works everywhere | Requires elevating files to `DOMAIN_WITH_LINK`. Reverses part of the 2026-08-11 private-documents rule. |
| **B. Download only** | Click, file downloads, opens in their PDF reader | Zero sharing, zero new risk. Removes the overlay entirely, back to pre-2026-08-12 behaviour. |
| **C. Leave as is** | Fallback message plus a working Download button | Zero work. Reads as broken even though it is not. |

**My recommendation: A, with one narrowing.** You are right that `DOMAIN_WITH_LINK` keeps the
files inside `megaworldcorp.com`, and there is already a documented precedent for exactly this
elevation (`getAndShareDCSFiles_`, for the certificate). But do it **lazily**: elevate a file
the first time an authorised viewer actually opens it, not at upload. That keeps "private by
default" true for every document nobody ever views, and it keeps the elevation attributable.
Elevating all files at upload is a bigger change to the security posture than you need.

**And the honest counter-argument, since you asked me to argue:** option B costs nothing, adds
no risk, and the approvers are opening these documents to read and sign off on them, which
they will do in a real PDF reader anyway. The preview is a nicety. If you want this closed
today with zero policy change, take B. If you want the nicer experience, take A-lazy and I
will document the reversal as a dated decision.

## B2. HTML in comments: the write path is closed, please retest once

**Verdict: not a live code defect, on the evidence. One fresh test closes it.**

The plain-text strip is at the entry of all three mutators and covers **both** paths into
them:

- The RPC path (`google.script.run`): stripped at the top of `processApprovalDecision_`,
  `processDivHeadDecision_`, `apiPhase3_ProcessISMDecision`.
- The email-form path: `handleEmailAction_` passes `comment || ''` straight through to those
  same mutators (`pia_code.js:4128` and `:4137`), so it inherits the strip. There is no third
  way in.

Every render sink escapes: `renderDecision` uses `escapeHtml_` (`pia_code.js:7463`), the Admin
audit table uses `esc()` (`adminView.html:4451`).

So bold that still renders is **a row written before the deploy**. Stored data is not
retroactively cleaned, deliberately: rewriting historical approver comments in a compliance
record is worse than displaying one stale `<b>`.

**What closes it:** submit one NEW Return comment containing
`<b>bold</b> <img src=x onerror=alert(1)>` on the currently deployed build, then read the
stored `Comments` cell in the sheet. If the cell contains `bold ` with no tags, done. If it
still has tags, tell me and I will treat it as a real defect.

## B3. `[object Object]` as a document name: confirmed, root cause found

**Confirmed. Two lines, one file.**

- `Phase 1/Code.js:1782` stores the endorsement letter in `Metadata_Agency` as an **object**:
  `endorsementFile = { id: eId, name: ... }`. That is correct and PIA depends on it
  (`pia_index.html:3605` reads `.id` and `.name`).
- `Phase 1/index.html:7115` restores revision state and, when the request **is** an agency or
  OJT request, assigns `res.application.metadataAgency` **wholesale** into `state.dcs.agency`.
  So `state.dcs.agency.endorsementLetter` becomes that `{id, name}` object.
- `Phase 1/index.html:4996` then renders it as a filename:
  `escapeHtml(state.dcs.agency.endorsementLetter || '')`, and `String({...})` is
  `[object Object]`.

The correct value is already sitting two lines away: `endorseFileName` at `index.html:7095`,
derived from `res.application.files`. It is only used in the **else** branch at `:7117`, which
never runs for an agency or OJT request. That is the whole bug.

Two more display sites read the same field and will show the same string:
`index.html:5040` and `:5041` ("Selected: ...").

## B4. Phantom "Pending review" inside closed rounds: confirmed, and it is one concept in two places

**Confirmed. The root cause is a contract violation between a doc comment and its code.**

`collectAllRoundDecisions_(sessionId, includePending)` at `pia_code.js:4503`. Line 4523:

```
if (isPending && !includePending) continue;
```

`includePending` is **global across every round**. The function's own doc comment at
`pia_code.js:4575` says "include Pending rows **in the current round**". The code does not do
that. So any caller passing `true` gets round 1's abandoned Pending rows as well.

This explains the split you observed exactly, and it is a nice confirmation that the diagnosis
is right:

| Surface | `includePending` | Phantom Pending? | Matches your screenshots |
|---|---|---|---|
| All five email templates | `false` (`pia_code.js:7515`) | No | Correct, the emails were clean |
| Approver review page | `true` (`:3856`) | **Yes** | Correct, screenshot shows it |
| ISM review page | `true` (`:3398`) | **Yes** | Correct |
| Applicant PIA timeline | `true` (`:4621`) | **Yes** | Correct |
| Certificate | `false` (`:10395`) | No | Correct, cert was clean |

**DCS has the same bug in a different function.** `getApprovalHistoryRounds_`
(`Phase 1/Code.js:2815`) has **no pending filter at all**, so the DCS request-details screen
shows it too. That is a second edit, in a second app.

**This is a cross-app item. Both must ship together**, or the DCS screen and the PIA screen
will disagree about the same request in front of the same person.

## B5. Resubmit email showing round 1: labelling gap, not the wrong round

**Verdict: the email is not rendering the wrong round. It is failing to mention that a newer
round exists.** Your second possibility is ruled out.

`generateEmailDecisionsHTML_` calls `getUnifiedHistory_(sessionId, false)`. At the moment the
resubmit confirmation is sent, round 2 exists but contains **only Pending rows**, so
`collectAllRoundDecisions_` skips every one of them and round 2 never appears in `byRound`.
Only round 1 renders. And `isCurrent` is `(1 === 2)`, which is false, which is why the header
reads a bare "ROUND 1" with no "(CURRENT)" badge.

Your own screenshots prove the mechanism: the 8:22 PM resubmit email shows "ROUND 1" with no
badge; the 8:31 PM email, sent after round 2 had two real decisions, shows "ROUND 1" then
"ROUND 2 (CURRENT)" correctly.

So the fix is not a round-selection fix. It is: when the current round has no decisions yet,
say so, something like a "Round 2 (current): awaiting Immediate Head" line, instead of ending
on a historical round with no marker.

**Noted, and you are right to weight it:** this is the third time round labelling has come up.
C6 and C9 are the same complaint from other angles. They should be scoped and fixed as one
piece of work, not five.

---

# PART C: display, copy, layout

## The shared-builder map, which is what collapses this list

**One function, `buildUnifiedHistoryHtml_` (`pia_code.js:7445-7502`), renders the decision
history in seven places at once:**

| Surface | Reached via |
|---|---|
| All five email templates | `generateEmailDecisionsHTML_` (`:7514`) |
| Approver review page | `:3856` |
| ISM review page | `:3398` |
| Certificate (PIA copy, the one actually emailed) | `:10395` |
| Applicant PIA timeline | client-side twin at `pia_index.html:2288` |
| DCS request details | client-side twin, fed by `Code.js:2815` |
| Admin audit trail | separate: `approvalTable` at `adminView.html:4427` |

**So the scoping answer you asked for:** C4, C5, C7 and the routing repetition are **one edit**
to `renderDecision` inside that function, and they land on emails, both review pages and the
certificate simultaneously. Only the three client-side twins need matching edits.

| Item | Where it actually lives | Scope |
|---|---|---|
| **C1** documents one per row | `previewHtml` supporting-docs block, `pia_code.js` ~3050; plus DCS and PIA client copies | 3 sites |
| **C2** flagged-file message format | `index.html` upload cards (the `has-flag` branches), the string is per-card | 1 file, several cards |
| **C3** email hierarchy (round h1, group h2) | `buildUnifiedHistoryHtml_` `headerHtml` and `subHeader` | **1 edit, 7 surfaces** |
| **C4** label the comment `Comments:` | `renderDecision`, `pia_code.js:7463` | **1 edit, 7 surfaces** |
| **C5** flags before comment | `renderDecision`, swap `:7463` and `:7464` | **1 edit, 7 surfaces** |
| **C6** current round in green | `headerHtml` `:7493` (currently navy tint `#f4f7fb`), plus the three client twins | 1 edit + 3 |
| **C7** body text black not grey | `renderDecision` (`#666`, `#999`, `#333`), plus `design-tokens.css` `--text2` if you want it system-wide | **decide scope first, see below** |
| **C8** certificate: delete the two tables | PIA cert `pia_code.js` ~10401; Admin cert `buildCertificateHtml_` `admin_code.js:4795` | **blocked, see below** |
| **C9** Admin audit trail round grouping | `approvalTable`, `adminView.html:4427` | 1 file, no backend change |

### C7, one thing to decide before I touch it

"Grey as default body text is unacceptable, make it black across all three apps" has two very
different readings:

- **Narrow:** the decision-history block only (comment `#666`, date `#999`). Cheap, safe, and
  it is what your screenshots are actually showing.
- **Wide:** change `--text2` in `docs/design-tokens.css`, which is pasted into **six** places
  (three frontends plus the `getStyledHtmlWrapper_` block in each backend). That is every
  secondary label, hint and helper text in the entire system going black, which will flatten
  the visual hierarchy everywhere.

**I recommend narrow.** Wide would make every form hint and every field description compete
with its own label for attention. Tell me if you meant wide.

### C8 is blocked on a decision, and this is important

The two summary tables and the round-grouped history are duplicates **in PIA's certificate**.
Deleting them there is correct and straightforward.

**But Admin's certificate is a different builder with no history section at all.**
`buildCertificateHtml_` (`admin_code.js:4795`) has zero occurrences of "Round", "History" or
"DEPARTMENT" in its body. Its only approver content **is** those two tables. Delete them there
and a re-issued certificate lists no approvers whatsoever.

So C8 is one of:

- **(a)** Fix PIA only. Fastest. Consequence: the certificate you download or resend from
  Admin no longer matches the one that was originally emailed, and that gap widens.
- **(b)** Give Admin's certificate the round-grouped history first, then delete the tables from
  both. More work. Correct outcome: a re-issued certificate matches the original.

**I recommend (b)**, because a certificate that changes shape depending on which app produced
it is a compliance smell, and re-issuance is the case where someone is most likely to compare
the two. But it is real extra work and it is your call.

### The routing repetition: there is a reason, and it hides a real problem

`renderDecision` prints `Routing: <dest>` per ISM row because **routing is recorded per ISM
reviewer**, not per request: each one picks a destination when they approve
(`pia_code.js:9798`).

Which is fine until you look at how the final destination is chosen. `pia_code.js:5765`:

```
if (freshData[i][ISM_WORKFLOW_COLS.ROUTING_DESTINATION - 1]) {
  routingDest = freshData[i][ISM_WORKFLOW_COLS.ROUTING_DESTINATION - 1];
}
```

**The last non-empty value in sheet order wins, silently.** If InfoSec member 1 picks DCOPS and
member 2 picks TechServe, the request goes to TechServe and nothing anywhere flags the
disagreement. You have not been able to hit this yet because both ISM steps currently route to
one inbox in the test rig.

**This is a new finding, not something you reported.** My recommendation: keep the per-row
routing in the **history** (it is genuine audit value, it records who chose what), drop the
repetition from the **certificate**, and show one authoritative "Routed to: X" line there
instead. Whether two reviewers disagreeing should be blocked, warned about, or left alone is an
ISM policy call. Flag it to them.

## C10: acknowledged, not treated as a task

Understood. C1 to C9 get fixed, then you look again.

---

# PART D: design questions

## D1. Does a DCS-only flag need to force a PIA resubmit? Here is the rationale as it exists

**The mechanism, exactly:**

1. An approver flags a DCS field. Flag labels carry the `DCS - ` prefix
   (`pia_code.js:3050`, and `:2933` for the endorsement letter).
2. On Return, `hasDCSFlags` is computed (`:6128`, `:7177`, `:9887`) and if true,
   `updateDCSStatus_(linkedReqId, 'Returned', approverFlags)` also marks the **DCS** row
   Returned.
3. `apiGenerateRevisionSessionId_` (`:11470-11481`) then **blocks** the PIA resubmit while the
   linked DCS is still `Returned`: "you will need to check the DCS to review and resubmit".
4. Fix the DCS, DCS goes back to `READY_FOR_PIA`, the block lifts, and the PIA resubmit
   appends round N+1.

**Why the PIA round has to exist, and this is the part worth understanding:** the approval
ladder lives entirely in PIA. DCS has no approval gate at all. So the head who returned the
request holds a `Return` decision row in `Approval_Workflow`, and that row is resolved, not
pending. There is no mechanism to hand a request back to that same approver mid-chain; a
Return always bounces to the applicant and always restarts at Stage A step 1. Without a new
round there is no Pending row for anyone to act on, and the request would sit in `Returned`
forever with a fixed DCS and nobody notified.

**So the step is load-bearing, but your complaint is still valid**, and the honest framing is:
you are not being asked to *redo* the PIA, you are being asked to *re-file* it. The answers are
still there. The friction is that the UI does not say that, so it reads as "fill it all in
again".

**What I would actually change (cheap, no workflow risk):** the return email currently says
"Update DCS Request First". After the DCS is fixed, the applicant lands on a PIA resubmit with
no explanation of why they are there when nothing in the PIA was flagged. One sentence on that
screen, along the lines of "Nothing in your assessment was flagged. Your answers are unchanged;
resubmitting sends the corrected documents back to your Immediate Head", removes almost all of
the confusion for none of the risk.

**What I would not do:** auto-resubmit the PIA when the DCS is fixed. That would mean the
system submitting an approval request on a person's behalf without them seeing it, which is
exactly the kind of silent action a Privacy Impact Assessment record should not contain.

## D2. Certificate on the final approval email: already done

**The attach half is already implemented.** `notifyApplicant_` at `pia_code.js:7283-7289`
sends the final-approval email synchronously with `attachments: [opts.certBlob]`. Your own
screenshot confirms it: "Your Certificate of Approval is attached to this email for your
reference."

**On your quota question, and this is the good news:** it costs nothing. The blob is the
**same** `pdfBlob` already generated for DCOPS/TechServe and returned at `pia_code.js:10611`.
No second generation, no second email. Gmail quota counts recipients, not attachments. So this
was free.

**What is not done is the display half:** the email body still shows the standard history block
rather than the certificate layout. My recommendation: **leave it.** The certificate is
attached; duplicating a 200-line table-based certificate inline would make the email enormous,
and that inline copy would have to be maintained against the legacy HTML-to-PDF constraints
(tables and inline CSS only) for no gain. If the goal is "cleaner than the current text
summary", the cheaper win is C3 and C4 on the history block, which you are already getting.

## D3. Delegation: do not remove it, hide the entry point

You asked me to put the trade-off to you plainly, so here it is, and my recommendation is
**hide, not remove**.

**1. Where the cost lands. Confirmed, and it is worse than you think.**

"Just make a new request" means the applicant:
- re-uploads **every notarised document** (files are deliberately not kept in drafts, that is
  documented intended behaviour, not a bug),
- re-answers all five PIA sections,
- restarts at Immediate Head, so **every approval already given is thrown away**.

The admin saves one record. The applicant loses a notarised document set and the whole
organisation redoes an approval chain. That trade is upside down.

**2. Orphaned assessments. Real, and it is the strongest argument against your proposal.**

The abandoned request does not disappear. It sits in `Applications` with a live `Pending` row
in the workflow sheets, carrying real approval decisions from real people, forever. It never
reaches a terminal state, so **retention will never clean it up** (retention is terminal-state
only, and both sides must be closed). Every leave period produces one permanent half-finished
Privacy Impact Assessment with genuine signatures on it and no outcome. For a compliance
record, that is hard to defend.

**3. You have never seen it run.** Correct, P1-08 needs a second account. Noted.

**4. Cost of removal. Larger than it looks.**

169 references across the repo, **118 in `pia_code.js` alone**, 22 in `admin_code.js`, 13 in
`adminView.html`. It threads through five distinct mechanisms:

- `resolveDelegate_` at every notify site,
- `recipientFor_`, the single choke point that keeps the recipient and the **HMAC token
  subject** in agreement,
- `canActAs_`, which is the widened F-02 identity guard on all three decision mutators,
- `isAuthorizedForApplication_`, for view filtering,
- `ACTED_BY`, a real column in three workflow sheets and in `PIA_SCHEMA`.

Ripping that out means re-opening the F-02 guard on three mutators and touching the token path.
It spans PIA and Admin, which deploy independently, so there is a window where one app has it
and the other does not. That is a genuinely risky change to make for a feature that is not
hurting anything.

**Hiding it: one nav item in `adminView.html`.** Reversible in a minute. The tables stay empty,
`resolveDelegate_` **fails open to "no delegate"** by design, so with an empty `Delegations`
sheet `canActAs_` collapses to a plain identity check and the system behaves exactly as if
delegation did not exist.

| Option | Effort | Risk | Reversible |
|---|---|---|---|
| **Hide the Admin entry point** | 1 line | None | Instantly |
| Leave as is | 0 | None | n/a |
| Remove entirely | Days across 2 apps | Re-opens the F-02 guard and the token path | No |

**My recommendation: hide it.** You get exactly what you want (no admin is responsible for it,
nobody can create one) at effectively zero risk, and if ISM later says "an approver is on leave
for three weeks and we are not making them redo a notarised submission", you un-hide it.

Either way, **write the decision down**. Your instinct was right that this is an ISM policy
call about who absorbs the cost of an approver being on leave, and it should be a recorded
decision rather than a deletion.

---

# PART E

## E1. Return-reason minimum: confirmed server-only

**Confirmed.** The 100-character floor exists in exactly one place:
`pia_code.js:4109`, inside `handleEmailAction_`, which is the **POST handler**. The form at
`pia_code.js:3883` only prints a hint, "(Minimum 100 required for Return/Deny)". There is no
client gate at all.

So the sequence is: full POST, token verification, sheet reads, then rejection, then
`renderReviewForm` re-renders the entire page including the whole approval history. On a
linear-scan spreadsheet backend that is exactly the wait you saw. You are right that it should
not cost a round-trip.

**Other validations with the same shape**, all server-only, all in the same handler:

| Check | Line |
|---|---|
| ISM 50-character minimum | `:3773` |
| Maximum 4000 characters | `:3779`, `:4111` |
| Repeated-character spam (`/(.)\1{5,}/`) | `:4113` |
| Consonant-run gibberish | `:4115` |

All five are pure string checks over data the browser already has. They can all be mirrored
client-side.

**One thing that must not change:** the server checks stay exactly where they are. The client
copy is a courtesy that saves a round-trip; the server copy is the rule, because
`apiProcessApprovalDecision` is public RPC. Same split as the flags contract. Mirror, never
move.

---

# The gameplan

Grouped by app and file. Nothing here is written yet.

## Ships as one unit: rounds and history

**Cross-app. These must deploy together or the two apps will disagree in front of the same
person.**

| # | Change | File | Fixes |
|---|---|---|---|
| 1 | Scope `includePending` to the current round | `pia_code.js` `collectAllRoundDecisions_` :4503 | **B4** on 3 PIA surfaces |
| 2 | Add the same pending filter | `Phase 1/Code.js` `getApprovalHistoryRounds_` :2815 | **B4** on DCS |
| 3 | Render "current round, awaiting X" when the round has no decisions | `pia_code.js` `buildUnifiedHistoryHtml_` | **B5** |
| 4 | Group by round | `adminView.html` `approvalTable` :4427 | **B4** + **C9** |

`RoundNumber` already reaches `adminView.html` (`getAuditLogs` returns rows unfiltered and
resolves by header), so item 4 needs **no Admin backend change**.

## One edit, seven surfaces: `renderDecision` and `buildUnifiedHistoryHtml_`

`Phase 2/pia_code.js:7445-7502`. Fixes **C3, C4, C5, C6, C7-narrow** and the routing
repetition on emails, both review pages and the certificate at once.

Then the three client-side twins for consistency: `pia_index.html:2288`,
`Phase 1/index.html` request-details renderer, and the current-round pill in each.

## Phase 1 (DCS) only

| # | Change | File |
|---|---|---|
| 5 | Use `endorseFileName` instead of the raw metadata object | `index.html:7115` (also check `:4996`, `:5040`, `:5041`) | **B3** |
| 6 | Flagged-file message format | `index.html` upload-card `has-flag` branches | **C2** |
| 7 | Supporting documents one per row | `index.html` | **C1** |

## Phase 2 (PIA) only

| # | Change | File |
|---|---|---|
| 8 | Mirror the five comment validations client-side, server checks untouched | `pia_code.js:3883` form, `:3773` ISM form | **E1** |
| 9 | Supporting documents one per row | `previewHtml` ~:3050 | **C1** |
| 10 | One sentence on the resubmit screen explaining nothing in the PIA was flagged | resubmit path | **D1** |

## Admin only

| # | Change | File |
|---|---|---|
| 11 | Hide the Delegation nav entry | `adminView.html` | **D3** |

## Blocked on your decision

| Item | Blocked on |
|---|---|
| **B1** preview | Drive-link-lazy, download-only, or leave as is |
| **C8** certificate | PIA only, or add history to Admin's cert first |
| **C7** scope | Narrow (history block) or wide (`--text2` in six places) |
| **A2** | Confirm which account you were signed in as |

## Needs another manual pass, cannot be settled from code

| Item | What would settle it |
|---|---|
| **B2** | One fresh Return comment with tags on the deployed build, then read the sheet cell |
| Two-person ISM control | Revert `InfoSec_Email_Config.Member_Email` from column 8, four rows, then run a real two-person approval |
| Split routing destinations | Same rig. Have member 1 pick DCOPS and member 2 pick TechServe, confirm which wins |

## Deliberately not doing

- **Revision_History cleanup:** already retired in code. Nothing to remove.
- **`Risk_Audit` removal:** would break Email Routing.
- **Email Routing removal:** it is the recovery console, not a duplicate of Settings.
- **Certificate inline in the applicant email (D2 display half):** attach already works, inline
  would double a 200-line table-based layout for no gain.
- **Delegation removal (D3):** hide instead.
- **Auto-resubmit the PIA after a DCS fix (D1):** the system must not file an approval request
  on someone's behalf.
- **C10 "overall clutter":** not a task, by your instruction.

---

## Open questions for you

1. **A2:** which account were you signed in as at 8:01 PM, and did you reach that page from an
   email link?
2. **B1:** Drive-link-lazy, download-only, or leave as is?
3. **C7:** narrow (history block) or wide (all three apps)?
4. **C8:** fix PIA's certificate only, or add the history section to Admin's certificate first
   so a re-issued one matches?
5. **New, for ISM:** two InfoSec reviewers can pick different routing destinations and the last
   one silently wins. Block, warn, or leave?
