# 00 · START HERE — Megaworld RARS Project Migration Bundle

> **Purpose of this bundle.** Kai (Kai Justin Tan) is migrating this project to a new Claude
> account. These files are **portable, standalone context** so a fresh Claude with zero memory
> can pick up the project exactly where it was left — understanding the system, the history, the
> decisions, the user's working style, and the open work. Read **this file first**, then
> `01-kai-profile-and-working-style.md`, then the rest as needed.

---

## What this project is (60-second version)

**Megaworld RARS** = **Risk Assessment & Routing System** — the company's online pipeline for
**requesting access to company data**, with a privacy-impact assessment and a multi-level approval
ladder. It is **three independent Google Apps Script (GAS) web apps** that behave as one flow,
coordinating **only through one shared Google Spreadsheet** (their database):

| Phase | App | What it does |
|-------|-----|--------------|
| **Phase 1** | **DCS** (Data Collection System) | The request form. Apply, attach NDA/DPA/DSA/CU, submit. |
| **Phase 2** | **PIA** (Privacy Impact Assessment) | Privacy questionnaire + the full approval workflow (Immediate Head → Dept Head → InfoSec ×2 → optional Division Head). |
| **Phase 3** | **Admin** | ISM control panel — dashboard, settings (download links, reminders), email resend, oversight. Restricted to INFOSEC-001/002. |

A request climbs the approval ladder until **"Fully Certified,"** then access is routed to **DCOPS
/ TechServe** for provisioning. DCS itself has **no approval gate** (it's `COMPLETE` on submit);
the entire ladder lives in PIA.

**Repo location (on Kai's machine):** `C:\Users\kaita\OneDrive\Desktop\megaworld-DCS-automation`
(git repo, branch `main`).

---

## ⚠️ Important honesty note about this bundle

This bundle was produced by **Claude Code running locally on Kai's machine.** It was built from
**everything on disk**: the full repo, the `docs/` folder, `CLAUDE.md` (project + global), the
local Claude Code memory, and **10 local Claude Code session transcripts**.

It does **NOT** include any content that lived only in the **Claude.ai web Project** (web chat
threads or web-uploaded knowledge files), because those live on Anthropic's servers, not on disk,
and Claude Code cannot read them. If Kai had web-only material, it is not captured here — he should
paste anything critical into the new account separately.

---

## How to use these files (for the new Claude)

1. **Read `01-kai-profile-and-working-style.md` carefully and follow it.** It defines how Kai wants
   you to communicate, structure explanations, write code, and run git. This matters as much as the
   technical content.
2. Use `02`–`08` as the technical reference for the system. Each is standalone.
3. `09-gotchas-and-learnings.md` will save you hours — read before editing GAS-served files.
4. `10-work-history-and-current-state.md` tells you **what's done, what's deployed, and what's
   pending** — start there to know where to pick up.
5. `reference-docs/` holds **verbatim copies** of every original project document (the manual,
   security docs, T&C, test guide, etc.) and both `CLAUDE.md` files. These are the fidelity
   guarantee — if a synthesis file is ever ambiguous, the original is here.

---

## File index

| File | Topic |
|------|-------|
| `00-START-HERE.md` | This orientation + index |
| `01-kai-profile-and-working-style.md` | Who Kai is + exactly how he wants Claude to work |
| `02-rars-overview-and-architecture.md` | System overview, 3-app architecture, data model, secrets |
| `03-deployment-and-operations.md` | Deployment golden rule, Script-Property→URL map, scopes |
| `04-dcs-phase1-reference.md` | DCS frontend screens, render fns, backend, design system |
| `05-pia-phase2-reference.md` | Approval ladder, returns, escalation, certificate, emails |
| `06-admin-phase3-reference.md` | Admin features, config, security guards |
| `07-security-hardening.md` | Findings F-01…F-08, fixes, recommendations, status |
| `08-emails-and-notifications.md` | Every email flow, who gets what, reminders, queue |
| `09-gotchas-and-learnings.md` | Hard-won gotchas (GAS template literals, scriptlets, etc.) |
| `10-work-history-and-current-state.md` | Timeline, what's deployed vs pending, open items |
| `11-codebase-map.md` | Every source file, key functions, line references |
| `reference-docs/` | Verbatim copies of all original docs + both CLAUDE.md + memory |

---

## Current status at time of migration (summary — see file 10 for detail)

- **Confirmed deployed & working live:** DCS `index.html` (Wave 1/2 frontend + a blank-page bug fix).
- **Pending live deploy** (manual copy-paste into each GAS project, then "New version"):
  `Phase 1/Code.js`, `Phase 2/pia_code.js`, `Admin/admin_code.js` — carrying the security
  hardening (F-01…F-08) + remaining Wave 1/2 backend.
- **Pending config (no deploy):** create the Terms & Conditions Google Doc and set the
  `LINK_TC_PAGE` Script Property; one DPA download link still to be supplied by Miss Tine.
- **Git:** clean working tree (everything committed) as of the last session.
