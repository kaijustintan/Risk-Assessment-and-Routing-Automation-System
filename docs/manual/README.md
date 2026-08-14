# RARS: User & Maintenance Manual

**System:** RARS (Risk Assessment & Routing System): Megaworld
**Architecture:** three independent Google Apps Script web apps (DCS · PIA · Admin) sharing
one Google Spreadsheet
**Last updated:** 14 August 2026 (Wave 3: hardening, integrity, and two live test passes)

---

RARS is Megaworld's online pipeline for requesting access to company data. A request is filed
in **DCS**, assessed and approved through **PIA**, and overseen/routed by the **Admin** control
tower, three apps that look like one product to the user and coordinate through a single
shared spreadsheet.

This manual is **one document split across files** so each part stays readable and maps
cleanly to a chapter when exported to `.docx`. Everything shared across the three apps lives in
**Part 0**; the per-phase parts link back to it instead of repeating it. **If two places ever
disagree, Part 0 wins.**

> **Legend:** 🧑 end-user · 🛠 admin · 👨‍💻 developer · 🚩 = do not break this / hard-won lesson.

---

## How to read this manual

- **Just using the system?** Read **Part 0 §0.1** (overview), then the **End-user guide** of
  your phase (§1.1 / §2.1 / §3.1).
- **Maintaining or deploying?** Read **Part 0 §0.4 (Operations runbook)** and **§0.6
  (Security)** first, they are the highest-risk material, then your phase's Maintenance
  section.
- **New developer taking over?** Read **all of Part 0**, then the **Developer handover**
  section of each phase.

---

## Table of contents

### [Part 0: Common Reference](part-0-common.md) *(read first)*
- §0.1 RARS overview
- §0.2 Architecture & data model *(canonical sheet schema)*
- §0.3 The approval ladder & 5-stage progress timeline
- §0.4 🚩 Operations runbook: deployment & cross-app URLs
- §0.5 🚩 Known gotchas & debugging
- §0.6 Security model
- §0.7 Glossary & conventions

### [Part 1: DCS (Phase 1)](part-1-dcs.md)
- §1.1 End-user guide · §1.2 Maintenance · §1.3 Developer handover · §1.4 Troubleshooting

### [Part 2: PIA (Phase 2)](part-2-pia.md)
- §2.1 End-user guide · §2.2 Maintenance · §2.3 Developer handover · §2.4 Troubleshooting

### [Part 3: Admin (Phase 3)](part-3-admin.md)
- §3.1 End-user guide · §3.2 Maintenance · §3.3 Developer handover · §3.4 Troubleshooting

### [Appendices](appendices.md)
- A Changelog / version history · B Testing & QA · C Terms & Conditions · D Security findings

---

## Related repo docs (canonical sources)
This manual summarizes and links to these rather than duplicating them:

| Doc | What it is |
|-----|------------|
| `docs/V2 - Difference from V1 (Old System).md` | V1→V2 changes |
| `docs/TEST GUIDE - DCS PIA Session Changes.md` | Full manual test plan (incl. Part F) |
| `docs/Terms and Conditions.md` | DCS applicant T&Cs |
| `docs/Security - Review Findings.md` | Security findings |
| `docs/Security - Recommendations.md` | Security recommendations |
| `docs/category-dropdown-handoff.md` | Category dropdown handoff spec |
| `CLAUDE.md` (repo root) | Engineering instructions / source of truth for cross-app facts |

---

*Authoring note: write in Markdown here (version-controlled); export to `.docx` for
stakeholder distribution when the content is finalized.*
