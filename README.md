# Megaworld RARS: DCS / PIA / Admin

Megaworld's **RARS** (Risk Assessment & Routing System): the online pipeline for requesting
access to company data. It is **three independent Google Apps Script web apps** that act as one
flow, all sharing **one Google Spreadsheet** as their database:

- **Phase 1: DCS** (Data Collection System), the request form (`Phase 1/`).
- **Phase 2: PIA** (Privacy Impact Assessment), the privacy questionnaire after DCS clears (`Phase 2/`).
- **Phase 3: Admin**, the ISM (InfoSec) control tower: dashboard, email routing, settings (`Admin/`).

The three apps never call each other directly, they coordinate **only through the shared
spreadsheet** (and stored URLs like `PIA_APP_URL`). Each phase is its own GAS project/deployment and
ships by manual copy-paste of its files into the matching cloud project, then redeploy.

> **Note on ownership.** This system was **already built by a previous intern (V1)**. It was then
> **handed to me to finalize, fix, and polish (V2)**, branding, the OJT category, unified HTML emails,
> a single reminder engine, several bug fixes, request-list filtering, and full code documentation.
> A complete before/after of that finalization is in
> [`docs/V2 - Difference from V1 (Old System).md`](docs/V2%20-%20Difference%20from%20V1%20(Old%20System).md).

## Repository layout
| Path | What |
|------|------|
| `Phase 1/` | DCS: `index.html` (frontend), `Code.js` (backend), `appsscript.json` |
| `Phase 2/` | PIA: `pia_index.html`, `pia_code.js`, `pia_appsscript.json` |
| `Admin/` | Phase 3: `adminView.html`, `admin_code.js`, `admin_appsscript.json` |
| `docs/manual/` | **Unified user & maintenance manual** (Part 0 common + Parts 1–3 + appendices), start at `docs/manual/README.md` |
| `docs/` | Handoff specs, security docs, test guide, T&Cs + the V2 difference document |
| `CLAUDE.md` | Project guide: architecture, design tokens, workflow guardrails |
| `DPS_DB*.xlsx` | DB export for schema reference, **gitignored (real PII)** |

## Working on it
- We edit files in this repo; **deployment is separate**, copy-paste each edited file into its GAS
  project and redeploy (each phase independently).
- The apps **cannot run locally** (they need `google.script.run` + the cloud spreadsheet); verify in
  the live deployments.
- Don't break the cross-app contract: shared sheet column names, the `parentID`/`Linked_ReqID` link,
  and stored URLs.

**New here?** Read the [unified manual](docs/manual/README.md), its **Part 0** is the
cross-app source of truth (architecture, deployment golden rule, security, glossary). See
[`CLAUDE.md`](CLAUDE.md) for engineering conventions, and [`docs/`](docs/) for handoff specs,
security docs, and the V2 difference write-up.
