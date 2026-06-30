# 10 · Work History & Current State (start here to know where to pick up)

> Reconstructed from all 10 Claude Code session transcripts + the weekly logs. This is the "where
> things stand" file. Dates are 2026.

---

## Backstory

Kai **inherited** the RARS system — it was pre-built by a previous co-intern (and an older AppSheet
version by "Carl"). Kai's job was to **finalize it**: supervisor-requested design changes, bug fixes,
security hardening, and documentation. The README notes the system was pre-built and handed to him.

> Two other internship tracks appear in Kai's weekly logs — a **Security Awareness Video** series and
> a **COC (E-Certificate) automation** portal — but those are **separate projects/repos**, not this
> one. This bundle is RARS (DCS/PIA/Admin) only.

## Timeline (this repo)

**June 15 (Mon) — Onboarding + Round 1.** Discovered the 3-app architecture (DCS/PIA/Admin sharing
one Sheet). Created `CLAUDE.md`, the `/design-fix` command, `.gitignore`, and
`docs/category-dropdown-handoff.md`. Reorganized the repo into `Phase 1/ Phase 2/ Admin/` folders.
DCS frontend: rebranded UI to "Privacy Impact Assessment" + "Megaworld Corporation"; refactored the
4 hardcoded download links into a `DOWNLOADABLES` array and added OJT NDA (5th); added a personalized
greeting (first "Hi <name> 👋", restyled to a professional navy no-emoji headline on homepage + form).

**June 16 (Tue) — DCS copy/label cleanup + fixes.** Audience subtexts on downloads; "No — standard
request" → "This is a standard request"; context-aware Endorsement Letter label (School for OJT,
Agency for Agency); removed the unreachable "Pending Immediate Head" filter option. Greeting changed
to "Hello, <Surname>!" with a surname-extraction fix (strip 2 leading initials). Fixed the status
badge stuck on "Ready for Phase 2" → "PIA In Progress". Added Application Requests search/filter.
Hardened the DSA payload leak. Footer build v0.0.3 → v0.0.4. Wrote full code-documentation comments
across all 6 files. Wrote the V2-vs-V1 doc + README update.

**June 19 (Fri) — The crash + email-link outage.** Fixed the "Proceed to Phase 2" crash (`<?…?>`
scriptlet inside a doc comment). Fixed every dead email link (Script-Property deployment graveyard →
adopted the deployment golden rule). Rebuilt the ISM reviewer screen as an **inline decision panel**
(routing + Approve/Escalate/Return/Deny shown directly) with a submit overlay. Made applicant status
emails stage-honest. Fixed the certificate routing label ("BOTH" → "DCOPS and TechServe"). Removed
the "CAUTION" email footer. Added the DCS deep-link (`?parentID=` → opens the exact request).
Documented CLAUDE.md §3b (deploy golden rule + URL map) and §8b (approval ladder).

**June 22–23 (Sun–Mon) — Security + content (the heavy week).** Full security review →
**8 findings F-01…F-08**, then 3-batch hardening across all 3 apps (see `07-security-hardening.md`).
Downloadables restructured **5 → 7** (per-entity DPAs + per-audience CU) with renamed config keys in
3 places; CU forms given a unique amber/person-check look; "Confidential" → "Confidentiality"
spelling fix. Removed the dead "Decision Modal" code; fixed the PIA timezone (Shanghai → Manila).
Investigated "no emails received" → a recipient Gmail filter (not a bug). Wrote the full **Terms &
Conditions** content. Wrote the Security Findings + Recommendations docs and rewrote the Test Guide
(added Part E attack-sims). Adjusted Drive permissions on the downloadable forms.

**June 24 (Wed) — OJT feedback + docs + blank-page fix.** Assessed ~20 tester feedback items, then
implemented Wave 1 + Wave 2 (below). Hit and fixed the **blank-page bug** (GAS template-literal serve
corruption — see `09-gotchas-and-learnings.md`). Consolidated all documentation into a unified manual
(`docs/manual/` parts 0–3). Added the gotcha to CLAUDE.md §8 + a memory entry. Produced weekly
reports, a user-journey flowchart, and this migration bundle.

**June 25 (Thu) — Stress-tested again and finalized the documents/manuals.**

## OJT tester feedback waves (June 24)

Assessed ~20 items against actual code: **6 working-as-designed, 7 confirmed issues, 6 improvements.**

**Wave 1 (quick, low-risk):**
- #20 — merged the two final-approval applicant emails into one
- #14 — personalized email greetings (name looked up from the DCS record)
- #13 — approver **role labels** in the email decision list
- #16 — stage-honest status badge (no bare "Approved" before ISM finishes)
- #12 — loading spinner/overlay on the head/dept approve action
- #10 — redirect home / refresh after PIA submit (no stale "Proceed to Phase 2")
- #5 — resumed drafts say "re-upload required" instead of "✓ selected"

**Wave 2 (larger features):**
- #2 — clickable "View" Drive links for submitted documents
- #15 — reviewers now see **all** uploaded docs (incl. NDA/DPA), via stored file IDs
- #11 — added a 5th **"Heads Approval"** stage to the progress timeline (was 4)
- #19 — added a **Supporting Documents** list to the certificate
- #18 (save certificate PDF to a Drive folder) — **intentionally skipped** per Kai's call

## Current state at migration

**Deployed & verified live:**
- DCS `index.html` — Wave 1/2 frontend + the blank-page fix (confirmed working).
- Earlier DCS/PIA UI + email changes from the June 16/19 sessions (deployed in those sessions).

**⏳ Pending live deploy** (manual paste + "New version", one per app):
- `Phase 1/Code.js` — F-04, F-08 security guards + downloadables seed.
- `Phase 2/pia_code.js` — Wave 1/2 backend (emails, #15, #11, #19) + F-02, F-05 guards.
- `Admin/admin_code.js` — F-01/F-03 (~17 `checkAccess_` guards).

**⏳ Pending config (no deploy):**
- Create the Terms & Conditions Google Doc (content is in `docs/Terms and Conditions.md`; it still
  has `[DATE]` / `[ISM/DPO email]` placeholders and needs Legal/DPO review), share domain-Viewer, and
  put the `/preview` URL in the `LINK_TC_PAGE` Script Property (or `System_Configuration` row).
- One DPA download link still to be supplied by **Miss Tine**.

**🔍 To verify after deploy:**
- The PIA daily-reminder trigger is actually scheduled (`setupReminderTrigger()` in PIA → Triggers).
- **Delete any stale `adminApi_sendDailyReminders` time-trigger** in the Admin project (function was
  removed — it errors daily otherwise).
- Admin project's URL Script Properties are correct.
- Security regression (test guide Part E): INFOSEC admin still works (E6), ISM reviewer can still
  load assigned requests (F-05).

**Git:** clean working tree as of the last session. Note Kai sometimes **merges** the suggested
multi-commit split into one commit despite his own 1–2-per-commit rule — confirm git state before
re-proposing splits.

## Open questions / decisions waiting on supervisors

- **Section 2 rename** — Sir's target label for "Details / Profile & Access" (the instruction trailed
  off in an early session; never resolved).
- **Guide "Purpose" body + final T&C copy** — Sir / Legal / DPO.
- **Category dropdown category matrix** — Sir's final category list + per-category required
  attachments. Blueprint ready in `docs/category-dropdown-handoff.md`; needs a `submitDCS` backend
  edit (`Code.js:~1164, 1193–1225`). (The None/Agency/OJT dropdown is built; broader categories are not.)
- **Make iHelp Reference mandatory?** — open question for ISM: the implementer certificate relies on
  the iHelp ticket for the exact spec, but iHelp is currently optional (see `08-emails-and-notifications.md`).
- **Deferred security:** F-06 error-message sweep (58 sites); external-API `adminApi_` hardening
  (Batch 3b).
