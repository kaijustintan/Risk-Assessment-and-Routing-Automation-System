# Handoff Spec: "Involves an Agency" checkbox → multi-category dropdown

> Status: **PARTIALLY IMPLEMENTED, generic framework still deferred.**
> Since this was written, **OJT was implemented as a concrete one-off** (the "involves an
> Agency" checkbox became a **None / Agency / OJT** dropdown; OJT requires a Confidentiality
> Undertaking + a School Endorsement Letter; backend branches on `agencyData.type`). See
> `docs/V2 - Difference from V1 (Old System).md` §3.6. **This blueprint remains the plan for
> the *generic* multi-category framework** (any number of categories, each config-driven), that
> larger refactor is still **deferred** and is a **cross-team** change needing a backend edit
> owned by the GAS cloud team, not just our frontend.

---

## 0. What we're waiting on before any code is written

1. **The category list + each category's requirements** (from sir). Fill in §1's table.
   Today the system only knows one binary: "is this an Agency request, yes/no." The ask is
   to turn that into a picker, "This request involves a(n): Agency / OJT / …", where
   **each choice implies a different set of required attachments / fields**.
2. **Backend team commitment** to the `submitDCS` changes in §3. Until the backend accepts
   a category, a frontend dropdown would submit data the server can't interpret.

---

## 1. The category matrix (FILL THIS IN with sir)

One row per category. This table is the single source of truth that drives both the
frontend UI and the backend validation.

| Category key | Picker label | Main doc label | Extra required files | Extra required fields | Notes |
|--------------|--------------|----------------|----------------------|-----------------------|-------|
| `standard` | (none / "Standard request") | NDA (or DPA if Internal) |, | — | the current non-agency default |
| `agency` | "Agency" | Confidentiality Undertaking (CU) | Endorsement Letter | agencyName, agencyPersonnel, contractStartDate, networkDrive, recovery email/number | = today's agency flow |
| `ojt` | "OJT" | Confidentiality Undertaking for OJT | School Endorsement Letter |, | ✅ **implemented** (one-off, not via the generic framework) |
| `…` | … | … | … | … | |

---

## 2. LAYMAN: what changes for the user

Dati: isang checkbox lang, "This request involves an Agency." Check mo → lalabas yung
Agency section + Endorsement Letter. Hindi mo check → normal.

Bago: isang dropdown, "This request involves a(n): [Standard / Agency / OJT / …]." Depende
sa pipiliin, **iba-iba yung required na attachments at fields** na lalabas. Parang yung
agency logic ngayon, pero generalized para sa maraming category.

---

## 3. TECHNICAL: backend changes (`Code.gs` / `Code.js`, owned by cloud team)

The backend currently hardcodes a **binary** agency assumption. These are the exact spots:

- **`submitDCS`, `Code.js:1164`**
  `const ndaType = payload.agencyData ? 'CU' : 'NDA';`
  → must become category-driven: map `payload.formData.category` → the correct doc type
  (e.g. `agency → CU`, `ojt → OJT_NDA`, default → `NDA`/`DPA`).
- **`submitDCS`, `Code.js:1193–1225`** (agency-field validation + `agencyJson` written to
  `Data_Collection` column **K** `METADATA_AGENCY`)
  → validation must branch on category, not on `agencyData` presence. Decide where the
  category is stored: simplest is to add `category` into the existing `MetadataJSON`
  (column I) and keep column K for agency-only payloads.
- **`submitDCS`, required-fields list `Code.js:1078`** → may need per-category required
  fields.
- **`analyzeDCSRisk`, `Code.js:1460`, check #7** (`agencyData.agencyName`) → extend so
  category-specific risk checks still fire.
- **Backward compatibility:** existing rows have **no** category. Reads must treat a
  missing category as `agency` when `METADATA_AGENCY` is populated, else `standard`.

**Contract decision needed:** the new field name + allowed values (recommend
`formData.category` as a lowercase enum matching §1's keys). Frontend will send exactly
this.

---

## 4. TECHNICAL: frontend changes (`index.html`, ours, do AFTER §3 is agreed)

Replace the binary `state.dcs.isAgency` boolean with a `state.dcs.category` string, and
generalize every spot that currently branches on `isAgency`. From exploration these are:

- **The control itself**, `renderForm()` checkbox `#dcs-is-agency` (~`:3354`) → a
  `<select>` using the existing `.select-wrap` pattern.
- **A `CATEGORY_REQUIREMENTS` config object** (new) mirroring §1, single place that says,
  per category: main doc label, which upload wrappers show, which fields are required.
- **`validateFileUploads()`** (~`:3882`) → loop over the selected category's required files
  instead of the hardcoded NDA-always / DSA-if-External / Endorsement-if-Agency chain.
- **The agency screen** `renderAgency()` (~`:4019`) + its navigation (`show('agency')`) →
  generalize to a per-category "extra details" step, or keep agency-only and add new
  steps per category as defined.
- **Conditional wrappers**: DSA wrapper (`:3467`), endorsement wrapper, main-doc label
  updater (`updateMainUploadLabel`, ~`:3659`) → driven by `CATEGORY_REQUIREMENTS`.
- **Summary** (`renderSummary` ~`:4108`) + **payload construction** (`submitRequest`
  ~`:4291`) → emit `formData.category` and the category-appropriate files; keep
  `agencyData` populated when `category === 'agency'` for backend back-compat.
- **Revision mode**, the per-file flag logic (`isFileFlaggedForRevision`) must respect the
  category's file set.

**Access type note:** `Internal/External` (which controls the DSA) is a **separate** axis
from category and already works, do not merge the two unless sir explicitly wants it.

---

## 5. Suggested sequence (once unblocked)
1. Sir fills §1. 2. Backend team implements §3 + agrees the `category` contract.
3. We implement §4 against that contract. 4. Test each category end-to-end in the live GAS
editor (every required-file path + revision mode). 5. Commit as its own feature.

## 6. Effort estimate
Frontend ~half a day once the contract is fixed (≈8–10 touch points, but they're modular).
Backend is the gating dependency. Do **not** ship the frontend dropdown before the backend
accepts the category, it would submit uninterpretable data.
