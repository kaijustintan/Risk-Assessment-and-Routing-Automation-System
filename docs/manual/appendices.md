# Appendices (RARS Manual)

> Reference material that supports all three parts. To avoid drift, the long-form documents
> (test guide, T&Cs, security findings) keep their **canonical copy in `docs/`** — this file
> summarizes and links rather than duplicating.

---

## Appendix A — Changelog / version history

> The live source of truth for each phase is its GAS cloud project; this repo is where we
> edit before copy-pasting in (see [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).
> Dates are approximate to the work session; see `git log` for exact commits.

> **Canonical narrative lives elsewhere.** The full V1→V2 before/after — including the
> "Journey" of *why* each decision was made — is maintained in
> **`docs/V2 - Difference from V1 (Old System).md`**. To avoid drift, this appendix only
> summarizes; update the V2 doc, not this list, when describing what changed.

### June 2026 session — Wave 1/2 + security hardening *(detail: V2 doc §9)*
- **Downloadables 5 → 7 forms** (per-entity DPA: Megaworld / Luxury Global / Global One + CU
  for Agency & OJT), new `LINK_*_TEMPLATE` keys ([Part 1 §1.2](part-1-dcs.md#12--maintenance-)).
- **5-stage timeline** — "Heads Approval" split out
  ([§0.3](part-0-common.md#03--the-approval-ladder--progress-timeline)).
- **Clickable Drive "View" links** for uploaded docs in request details; **reliable reviewer
  docs** (ID-based lookup + fallback); **Certificate supporting-documents list** (saving the
  cert PDF to Drive was intentionally deferred).
- **Security hardening (F-01…F-08)** — per-function authorization across all 3 apps
  ([§0.6](part-0-common.md#06--security-model), Appendix D).
- **Bug fix:** blank DCS page from GAS template-literal serve corruption — fixed via string
  concatenation ([§0.5](part-0-common.md#05--known-gotchas--debugging)).

### July 2026 session — post-demo feedback (Rounds 1–3) + full hardening audit
- **DCS form:** iHelp Reference and **Office/Site** are now **required**; Office/Site fixed to
  **AGT / GDP / EGP / TWS** (removed CIP/Eastgate + the "Others" free-text). Agency requests ask
  **New vs Replacement** (Replacement captures the replaced person for DCOPS); **OJT forces
  External** access; **Network Drive required** for agency; red-asterisk required-field indicators;
  the summary + details Documents section now lists **every** submitted file (main doc, DSA,
  endorsement) ([Part 1](part-1-dcs.md)).
- **PIA per-site TechServe** — `InfoSec_Email_Config` gains a **`Site`** column; TechServe is one
  row per (site, email), resolved by the request's Office/Site with a DCOPS-only fallback
  ([§0.2](part-0-common.md#02--architecture--data-model), [Part 2](part-2-pia.md)).
- **PIA certificate + emails** — the certificate now shows approver **comments** and is **attached
  to the applicant's FULLY-APPROVED email** (with a named per-site TechServe contact block); all
  four **approver emails carry a Review Status** block ([Part 2](part-2-pia.md)).
- **Admin access rewired** — `checkAccess_` is now **role-based** (active `InfoSec` role) **+ the
  `Admin_Notification_Config` tab**, replacing the hardcoded `INFOSEC-001/002` allowlist that broke
  when IDs were renamed to `INFOSEC-ALL-1/2` ([§0.6](part-0-common.md#06--security-model),
  [Part 3](part-3-admin.md)).
- **Admin delete feature removed** — the hard cascading ticket-delete (+ audit purge) was pulled;
  records are now immutable from Admin. Also fixed invisible row-selection highlighting.
- **Ops lesson:** a non-owner deploy took the whole system down mid-day (execute-as identity) —
  always deploy as the owner `ismaiapps` ([§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls)).
- **Loophole/hardening pass:** queue-fallback for the final applicant email, safe TechServe
  fallback (no PII to the wrong team), and a document-required backend check.

### Recent commits (newest first)
| Commit | Summary |
|--------|---------|
| `e379af1` | docs(claude): add GAS serve-time template-literal corruption to §8 gotchas |
| `0a706fb` | minor fix part 3 |
| `aa287ad` | minor fix again |
| `7d5f2ea` | minor fix — DCS not displaying "kasi" |
| `bf1df2d` | feat(pia,dcs): wave-2 feedback fixes — doc links, 5-stage timeline, reliable reviewer docs, certificate doc list |

> Keep this table updated as new versions ship. For deeper V1→V2 differences, see
> `docs/V2 - Difference from V1 (Old System).md`.

---

## Appendix B — Testing & QA

The full, step-by-step manual test plan (including **Part F** for the Wave 1/2 changes) lives
in **`docs/TEST GUIDE - DCS PIA Session Changes.md`**. Run it after every deploy, with the
caveats from [§0.4](part-0-common.md#04--operations-runbook-deployment--cross-app-urls):

- **Test with a fresh transaction** — emails freeze their links at send time, so old inbox
  links won't reflect a property change.
- **Use freshly generated links** — review tokens expire after 14 days.
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

## Appendix C — Terms & Conditions

The canonical Terms & Conditions text shown to DCS applicants is maintained in
**`docs/Terms and Conditions.md`** (and surfaced in DCS Step 1 via the `LINK_TC_PAGE`
`System_Configuration` row — [§1.2](part-1-dcs.md#12--maintenance-)). Refer to that file for
the authoritative wording; update it there, not here, to avoid drift.

---

## Appendix D — Security findings & recommendations

This session's security review is documented in two `docs/` files:
- **`docs/Security - Review Findings.md`** — the findings (incl. F-04, F-05, F-08, identity
  guards, access-control gaps).
- **`docs/Security - Recommendations.md`** — recommended hardening and follow-ups.

Summary of what was applied is in [Appendix A](#appendix-a--changelog--version-history) and
[§0.6](part-0-common.md#06--security-model). Notable **future** hardening (not yet done):
sourcing the per-applicant head chain from an HR directory / Workspace org unit instead of
applicant-entered emails (mitigates self-approval risk).

---

*← [Part 3 — Admin](part-3-admin.md) · Back to [Index](README.md)*
