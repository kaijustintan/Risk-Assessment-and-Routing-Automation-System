# Post-Deploy Verification Checklist: RARS (DCS / PIA / Admin)

**Deployed:** 2026-08-13, all three apps.
**Purpose:** every feature below is **live in production right now** and has passed its automated
checks, but has never been exercised end to end by a person. This walks through each one.

> **Why this document exists.** Five separate defects this cycle passed `node --check`, passed the
> checker suite, and passed code review, then failed the moment real code ran or a real page was
> served. Automated green is evidence, not proof. Nothing below is verified until a human has seen
> it behave.

---

## Before you start

**Prerequisites**

| | |
|---|---|
| Accounts | Your own corporate account. A **second** account is required for P1-08 (delegation) and useful for P0-02 |
| Data state | Database was wiped 2026-08-13. All workflow tables start empty |
| Backup | A backup was taken **after** the wipe, so it is empty. `DPS_DB (1).xlsx` in Downloads is the only copy of pre-wipe data. Move it somewhere safe |

**⚠️ Standing test-config caveat, affects P0-02, P0-05, P1-06, P1-09**

`InfoSec_Email_Config` currently has the **ISM coordinator's address in `Member_Email` for four
rows** (INFOSEC-002 and the three TECHSERVE-AGT rows). Each person's real address sits in an
unheadered 8th column. This is deliberate, so test mail lands in one inbox.

Consequences while it stays this way:
- Both ISM steps route to the same person, so the **two-person ISM control is not actually being
  tested**. You are testing one person approving twice.
- The AGT TechServe certificate recipients are also that same inbox.

**Revert `Member_Email` from column 8 before go-live.** Nothing in the code will remind you.

---

# P0: verify before any real user touches the system

## P0-01: HTML escaping of user text

**Brief description**
Text typed by users and approvers is neutralised before it is drawn onto a page, so it displays as
characters instead of executing as code.

**Rationale**
This was broken for the entire deployed life of the system. Four of the escaper's five replacements
swapped each character for itself, so only apostrophes were ever escaped. It is the only defence for
71 places in the DCS frontend, including the approver comment box. An approver could have run code
inside an applicant's browser session. It is the single most serious defect found this cycle.

**Steps to test**
1. Submit any DCS request, then take it through to an approver decision.
2. As the approver, type this **exact** text into the comment box and submit:
   `<b>bold</b> <img src=x onerror=alert(1)>`
3. Log in as the applicant, open the request, and read the approver's comment.
4. ✅ **Pass:** you see the literal text including the angle brackets. No bold rendering, no popup.
5. ❌ **Fail:** the word "bold" appears bold, or an alert box appears. Stop and report immediately.

---

## P0-02: Approver email links work

**Brief description**
The secure one-click "Review Access Request" link inside every approval email opens the review page
for the intended approver.

**Rationale**
A function rename in August left one call pointing at a name that no longer existed. That call signs
the link in every approval email. Deployed as-is, no approver could have opened any request, the
entire approval pipeline would have stopped, and the failure was silent because the email still
looked fine on arrival.

**Steps to test**
1. Submit a DCS request, proceed to Phase 2, submit the PIA.
2. Check the Immediate Head's inbox for the review email.
3. Click **Review Access Request** in the email.
4. ✅ **Pass:** the review page opens showing that request's details, with Approve / Return / Deny.
5. ❌ **Fail:** an error page, "Access Denied", or an invalid-token message.
6. Repeat for at least one ISM-stage email, since those are built by a different function.

---

## P0-03: Both pages render at all

**Brief description**
The DCS request form and the Admin dashboard load, and the small warning/check icons draw correctly.

**Rationale**
An inline SVG carried a namespace attribute whose URL contained a double slash. Google's page-serving
step truncated the line there, leaving an unterminated string, and both apps blanked with a script
error. Valid on disk, so every offline check passed. Already confirmed loading, but the icons
themselves have not been looked at since the attribute was removed.

**Steps to test**
1. Open DCS. Open Admin. Both should render fully.
2. Open the browser console (F12) on each. ✅ **Pass:** no red `SyntaxError`.
3. Trigger a warning icon: start a revision on a returned request. The **Revision Mode** badge must
   show a small triangle warning icon beside the text, not a blank gap or a broken-image box.
4. In Admin, find any status area using check / warning / x glyphs and confirm they draw.

---

## P0-04: Uploaded documents are private

**Brief description**
NDA / DPA / DSA / Confidentiality Undertaking / Endorsement Letter files are readable only through
the app, by people party to that request.

**Rationale**
These files were previously shared as "anyone with the link", and the raw Drive URL was printed onto
the page. One forwarded screenshot exposed a signed contract publicly. Files are now owner-only and
served through an access-checked endpoint.

**Steps to test**
1. Submit a DCS request with an attachment.
2. As the applicant, open the request and click **View** on the document.
3. ✅ **Pass:** the document opens in an overlay on the page. A Download button is present.
4. Confirm the page contains **no** `drive.google.com` link for the file (check via right-click, or
   search the page source for `drive.google.com`).
5. Log in as an **unrelated** third account and try to open that same request. ✅ **Pass:** refused.

---

## P0-05: One complete approval, end to end

**Brief description**
A request travels the full ladder: Immediate Head, Department Head, ISM member 1, ISM member 2, then
final certification and routing.

**Rationale**
This is the product. It also exercises the largest untested change: the approval round is now
computed once per decision and passed down through six helper functions instead of being recomputed
up to seven times. Every notification, token and workflow row on the path depends on that value
being correct.

**Steps to test**
1. Submit DCS → Proceed to Phase 2 → submit PIA.
2. Approve at each stage in turn, checking after **each** approval that:
   - the next approver receives an email,
   - the applicant's status display advances,
   - the `Approval_Workflow` sheet shows the decision with a timestamp.
3. After final ISM approval: ✅ the Certificate of Approval email reaches the DCOPS / TechServe
   inboxes with a **PDF attached**, the applicant is notified, and the DCS row flips to `Complete`.
4. Open the PDF. ✅ **Pass:** the approver roster is populated and the layout is intact.

---

# P1: verify this week

## P1-06: Return and resubmit keeps history

**Brief description**
When an approver returns a request and the applicant fixes and resubmits, the earlier round's
decisions are kept instead of being deleted, and a new round is appended below.

**Rationale**
Until this change, resubmission **deleted every workflow row** for that request and rebuilt from
scratch, with only a best-effort photocopy taken first. For a Privacy Impact Assessment, losing the
record of what an approver actually approved is a compliance gap.

**Steps to test**
1. Take a request to any approver and choose **Return**, with a comment and at least one flagged field.
2. As the applicant, fix it and resubmit.
3. In the spreadsheet, open `Approval_Workflow` and filter to that SessionID.
4. ✅ **Pass:** you see **both** rounds. `RoundNumber` is 1 on the old rows and 2 on the new ones.
   The round-1 rows still carry their decisions and comments.
5. Open `Application_Snapshots`. ✅ **Pass:** one row for round 1 holding the answers **as submitted
   the first time**.
6. On the applicant's request-details screen, the Approval History card shows both rounds grouped.

---

## P1-07: Revision counter and superseded documents

**Brief description**
Each revision increments a counter, and a re-uploaded document archives the version it replaced
instead of leaving both visible.

**Rationale**
A read was taking values from the wrong two columns, so every revision overwrote the stored metadata
with the wrong data. The counter reset to 1 each time and the superseded-document trail was silently
dropped. Nothing errored; it just quietly lost the history.

**Steps to test**
1. Using the returned request from P1-06, make sure the approver flagged a **document**.
2. Resubmit with a **new file** for that flagged document.
3. Open the request details. ✅ **Pass:** only the newest version is listed as current, the old one
   is marked superseded / archived, and it is not offered as the live document.
4. Return and resubmit a **second** time. ✅ **Pass:** the revision count reads 2, not 1.

---

## P1-08: Delegation (out-of-office cover)

**Brief description**
ISM can record that one approver is covering for another. While active, emails, reminders and the
approval link all go to the delegate, and the original cannot act.

**Rationale**
Previously an approver on leave stopped a request dead. Forwarding their email did not work, because
three separate mechanisms key off the approver's address. Delegation is deliberately a **handover,
not a second key**: exactly one person can act at a time, otherwise two people could approve the
same step seconds apart.

**Steps to test**

*Needs two accounts, A (original approver) and B (delegate).*
1. In Admin → Delegation, create A → B, active today.
2. Send a request to A for approval.
3. ✅ **Pass:** the email arrives in **B's** inbox, and it says it is on behalf of A.
4. As **A**, try to act on that request. ✅ **Pass:** refused. This is correct, not a bug.
5. As **B**, approve it. ✅ **Pass:** accepted, and `ACTED_BY` in the sheet records B.
6. Confirm A can still **see** their own previously decided requests. Only the live handed-off step
   should disappear from their view.
7. Set the delegation to inactive. ✅ **Pass:** routing returns to A immediately.

---

## P1-09: Admin dashboard reads the right columns

**Brief description**
Admin's Flags tab, agency information block, and the "who actually acted" column display real data.

**Rationale**
Three separate column defects, all silent. Admin was reading a key that did not match the sheet
header, so the **Flags tab and its count badge always showed zero**. The two apps disagreed on the
name of one column, so **agency metadata was invisible to Admin**. A third column was written under
a blank header.

**Steps to test**
1. Submit a request that **involves an agency** (fill the agency section), and have an approver flag
   at least one field.
2. In Admin, open that request.
3. ✅ **Pass:** the **Flags** tab shows a **non-zero** count and lists the flagged item.
4. ✅ **Pass:** the **agency** block renders with the agency details and endorsement letter.
5. Make a **delegated** decision (from P1-08), then check the sheet. ✅ **Pass:** `ActedBy` sits under
   a real column header, not a blank one.

---

## P1-10: Drafts save and restore honestly

**Brief description**
The autosave indicator reports the truth. If a save is refused, it says so instead of showing "Saved".

**Rationale**
The five draft endpoints were changed to return a structured error rather than crash. That change
exposed a real display bug: the frontend showed **"Saved"** even when the server had refused the
save, so a user could believe their work was stored when it was not.

**Steps to test**
1. Start a PIA, fill several fields, and watch the autosave indicator. ✅ **Pass:** it reads "Saving"
   then "Saved".
2. Close the tab, reopen the request, and resume the draft. ✅ **Pass:** your answers come back.
3. Do the same in DCS.
4. ✅ **Pass:** at no point does "Saved" appear alongside a console error.

---

## P1-11: Weekly database backup

**Brief description**
The whole database is copied to a Drive folder every Sunday around 3am, keeping the newest eight.

**Rationale**
The entire system lives in one spreadsheet. Drive's version history protects against a bad edit but
not against the file being deleted or corrupted. The job is deliberately **fail-loud**: if it breaks
you get an email, because a backup that fails quietly is discovered on the day you need it.

**Steps to test**
1. Already done manually: folder created, first copy written, trigger installed.
2. **On Monday 2026-08-17**, open the `RARS Database Backups` folder.
3. ✅ **Pass:** a new copy dated Sunday the 16th is present.
4. Open it and confirm it contains the real tabs and data.
5. Check the owner account's inbox for any Apps Script failure notice. ✅ **Pass:** none.

---

# P2: verify when convenient

## P2-12: PIA on a phone

**Brief description**
The PIA questionnaire is usable on a phone, with the Next button pinned to the bottom of the screen.

**Rationale**
PIA is the longest form in the system and applicants open status links on phones. It previously had
one breakpoint against the DCS form's seven, so the primary action could end up stranded below a long
scroll. **This is the one change in this batch that has had no visual confirmation at all.**

**Steps to test**
1. Open PIA on an actual phone, or use browser DevTools at 375px wide.
2. Walk through sections 1 to 5.
3. ✅ **Pass:** nothing overflows sideways, no horizontal scrollbar.
4. ✅ **Pass:** the Back / Next buttons sit in a bar pinned to the bottom of the viewport.
5. ✅ **Pass:** the PII checklist tables are readable and their YES / NO columns are tappable.

---

## P2-13: Aging report

**Brief description**
An Admin panel showing where requests are stuck and for how long.

**Rationale**
There was no way to answer "what is waiting on whom, and since when" without reading the sheets by
hand. It is also the only place a stalled escalation becomes visible (see P2-16).

**Steps to test**
1. Leave a request pending at some approver for a day, or check against existing ones.
2. Admin → Analytics / Aging.
3. ✅ **Pass:** the request appears, with the correct next approver and a sensible day count.
4. ✅ **Pass:** nothing shows an absurd age such as 20,000 days, which would mean an unparsed date.

---

## P2-14: Retention stays switched off

**Brief description**
A cleanup sweep that can delete old closed requests. It ships inert and requires two separate
switches before it deletes anything.

**Rationale**
Nothing in this system had ever deleted personal data. **This test is to confirm it is still doing
nothing**, not to turn it on. Enabling it is an ISM decision, and there is a related question worth
raising: a Privacy Impact Assessment system that keeps personal data indefinitely sits awkwardly
against the storage-limitation principle in RA 10173.

**Steps to test**
1. Admin → Settings → Data Retention.
2. ✅ **Pass:** Retention sweep reads **Disabled**, Mode reads **Dry run**.
3. Click **Preview what would be deleted**.
4. ✅ **Pass:** it reports a count and deletes nothing. Re-check a sample request still exists.
5. Raise the retention-period question with ISM. Do not set it yourself.

---

## P2-15: Export to Sheet is inert

**Brief description**
The Admin dashboard export produces a spreadsheet where user-typed text stays text.

**Rationale**
Google Sheets executes any cell beginning with `=`. Text an applicant typed into the request form sat
harmlessly in the database and then ran the moment an admin opened the export, under that admin's own
account. This is the only artefact in the system a human opens directly in the Sheets UI.

**Steps to test**
1. Submit a request with a field containing exactly: `=1+1`
2. In Admin, run **Export to Sheet** and open the result.
3. ✅ **Pass:** the cell shows the literal text `=1+1`, not `2`.

---

## P2-16: Escalation to Division Head

**Brief description**
An ISM reviewer can escalate to the Division Head, who then decides, and the chain resumes.

**Rationale**
Included because the audit found a **known unfixed weakness** here, and you should see it rather
than discover it later. If the applicant left the Division Head field blank in PIA 1, escalating
creates a pending row that nobody is notified about, pauses the ISM chain, and still reports success.
The request stalls silently. It is only visible via the aging report.

**Steps to test**
1. Submit a PIA **with** a Division Head named. Escalate from ISM.
2. ✅ **Pass:** the Division Head receives a review email; approving resumes the ISM chain.
3. *(Optional, to see the weakness)* Submit a PIA leaving Division Head **blank**, then escalate.
4. ⚠️ **Expected:** it reports success but nobody is emailed and the request stalls.
5. Decide with ISM whether the Division Head field should become **required**. That is the fix, and
   it is a policy call rather than a technical one.

---

# Addendum: the F1-F9 fixes (added 2026-08-13)

Verify these after the F-fix waves deploy. They ship in three independent waves, so each block can
be checked as soon as its wave is live.

## Wave 1 (PIA only)

**A1: Flags can only be sent with a Return** *(F5, the highest-value fix here)*
1. Open any approver review link. Flag one field, save a reason.
2. ✅ **Pass:** Approve is **greyed out** and hovering it explains why. On an ISM link, Escalate is
   greyed out too.
3. Remove the flag. ✅ **Pass:** both buttons come back.
4. Flag again, then click **Return to Requestor**. ✅ **Pass:** the Return goes through normally.
5. Confirm on a Stage A head link **and** an ISM link; they are two separate code copies.

**A2: Flag reason is a dialog** *(F9)*: clicking the flag icon opens a centered dialog, not a box
inside the row. Esc closes it, Enter saves it, Save shows the red "Flagged:" chip on the row, and
the chip's Remove clears the flag.

**A3: Status label at the ISM stage** *(F6)*: with a request past both heads, the ISM review page's
Current Status reads **"Approved by Heads (Awaiting ISM Review)"**, not a bare "Approved".

**A4: Return email deep-links** *(F4)*: trigger a Return **that flags a DCS field** (this is the
branch that was broken). The applicant's email button must open **that request's details**, not the
DCS home screen.

**A5: Plain text everywhere** *(F1a/F1b)*: put `<b>test</b>` in a decision comment **and** in a flag
reason. ✅ **Pass:** both store and display as literal text with no bold anywhere: the request page,
the notification email, and the certificate.

## Wave 2 (DCS + PIA)

**B1: PDF preview** *(F2, the experiment)*: click **View** on a PDF.
- ✅ **Best case:** the PDF renders in the overlay.
- ✅ **Acceptable:** a message says it could not be previewed, and **Download** works.
- ❌ **Fail:** a blank panel with no message. Report this; it means `<object>` did not help either
  and we fall back to the Drive-link decision.
- Check on **both** DCS and PIA, and on an approver review page (three separate copies).

**B2: Current round stands out** *(F7)*: on a request with 2+ rounds, the current round's heading
is a navy pill; earlier rounds stay muted grey. Check the DCS request detail and the PIA history.

## Wave 3 (PIA + Admin)

**C1: History groups by round, then by body** *(F8)*: open a certificate PDF from a multi-round
request. Under each round heading you should see **Department / Division Approvals** then
**ISM InfoSec Approvals** as sub-headings. Same structure in the approval emails and on the review
pages.

**C2: Certificate roster is current-round only** *(latent bug found while scoping F8)*: on a
request that went through a return and resubmit, the Admin certificate's approver tables must list
each approver **once**, not once per round. Compare the PIA-emailed certificate with the one
downloaded from Admin: the rosters should now agree.

---

## Reporting a failure

For anything that fails, capture:
1. Which check number.
2. What you expected versus what happened.
3. The **reference code** if an error message showed one (`Reference: 7f3a91`), which maps to the
   real exception in the Apps Script Executions log.
4. A browser console screenshot if a page misbehaved.
