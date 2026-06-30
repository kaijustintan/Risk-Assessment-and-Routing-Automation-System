# 07 · Security Review & Hardening (F-01 … F-08)

> The biggest single piece of backend work in the project. Full detail in
> `reference-docs/docs/Security - Review Findings.md` and `…/Security - Recommendations.md`.
> Attack-simulation test procedures are in `reference-docs/docs/TEST GUIDE - DCS PIA Session Changes.md`
> **Part E**.

---

## The core vulnerability class (read this first)

In Google Apps Script, **every global server function is directly callable from the browser** via
`google.script.run` (or the console). The `doGet`/`doPost` gate only protects the **entry point** —
it does **not** protect individual functions. So any logged-in `@megaworldcorp.com` user can open the
console and call any backend function with **attacker-chosen arguments.**

Several functions trusted an **email / id / role passed as an argument** instead of re-checking who
is actually calling. That's the root of nearly every finding.

**The universal fix pattern:** derive the caller's identity at the **start** of each sensitive
function and never trust client-supplied identity:
```js
// Admin (Phase 3) — INFOSEC-only:
var _me = Session.getActiveUser().getEmail();
var _authz = checkAccess_(_me);
if (!_authz.allowed) return { success: false, error: _authz.reason };

// PIA decision processors — caller must BE the named approver:
const _me = getNormalizedEmail(Session.getActiveUser().getEmail());
if (_me !== getNormalizedEmail(approverEmail)) {
  return { success:false, error:'Access denied: you may only submit your own decision.' };
}
```

## Findings & fixes

| ID | Severity | Risk found | Fix |
|----|----------|-----------|-----|
| **F-01 / F-03** | Critical | Any domain user could delete records, tamper config, or self-promote to admin (`deleteEntry`, `saveConfigData`, all `adminApi_*` had no internal authz) | `checkAccess_` (INFOSEC-only) guard on **~17 Admin callables** (`admin_code.js`) |
| **F-02** | Critical | Approval forgery — `apiPhase3_ProcessISMDecision` (`pia_code.js:6932`), `processApprovalDecision` (4099), `processDivHeadDecision` (3850) trusted the approver email arg | identity check: `activeUser` must equal the approver param, else deny |
| **F-04** | High | DCS IDOR — `apiGetRequestData` (`Code.js:2521`) returned any request with no ownership check | owner-only guard |
| **F-05** | High | PIA IDOR — `getApplicationData` / ISM fetches (`pia_code.js`) readable by any user | new helper `isAuthorizedForApplication_` (owner OR on the approval chain incl. ISM/DivHead), applied to `apiPhase3_FetchPIAData` / `apiPhase3_FetchDCSData` |
| **F-08** | High | Gateway lookup (`getGatewayRecord`, `Code.js:2845`) could query another user's status | bound to the signed-in user |
| **F-06** | Medium | Raw error messages leaked to client (~58 sites) | **DEFERRED** — needs a focused pass with a shared `safeError_` helper |
| **F-07** | Medium | (suspected) mass-assignment / form tampering | **Verified already-mitigated** — `submitApplication` re-checks ownership inside a lock (`pia_code.js:3704`) + status is server-computed; no change |

**Guard counts (verified against code):** Admin ≈ **17–22 `checkAccess_` sites**; PIA ≈ **26
identity-guard sites**.

## Deployment status of the hardening

- **Implemented + committed** in the repo.
- **NOT yet deployed live** at migration time — needs the manual paste + "New version" for:
  `Phase 2/pia_code.js` (F-02, F-05), `Admin/admin_code.js` (F-01/F-03), `Phase 1/Code.js` (F-04, F-08).
- **After deploy, TEST** (test guide Part E — 2 domain accounts + browser console). Priorities:
  - **E6 — INFOSEC admin regression:** confirm all ~17 guarded admin functions still work for a real
    INFOSEC member. A wrong `checkAccess_` lookup would lock out legit admins — highest regression risk.
  - **F-05 — ISM reviewer load:** confirm a legitimate ISM reviewer can still open requests assigned
    to them.
  - Expected side effect: the new guards **block dev test functions** that call decision processors
    with synthetic emails. Don't add a client-reachable bypass.

## Recommendations backlog (NOT yet done — see `Security - Recommendations.md`)

- **F-06 error-message sweep** (58 sites) with a shared `safeError_` helper.
- **External-API `adminApi_` hardening** (resend / reroute — "Batch 3b") — was awaiting Kai's
  decision on the external-API question.
- **HR-sourced approver chain:** today the Immediate/Dept/Division heads are applicant-filled in PIA1
  (no central org chart). Integrity risk (naming yourself/a friend) is *mitigated* (the risk analyzer
  flags drafter-email == head-email) but not *prevented*. Future hardening = source the head chain
  from an HR directory / Workspace org unit. Kai chose **recommendation-only** for now ("need nito ng
  manual insertion … wala pa ako niyan") — note the multi-account bypass.
- **Token TTL:** consider shorter / one-time tokens (Kai deferred — "lagay sa recommendations").
- **Secret strength / rotation:** verify `SYSTEM_SECRET` and `ADMIN_API_KEY` strength. `ADMIN_API_KEY`
  is safe to rotate anytime (server-side only). `SYSTEM_SECRET` rotation invalidates all in-flight
  email links — quiet-window only.
- Macro scanning on uploaded Office docs (the existing `uploadProxy` already does magic-byte
  anti-spoofing; macro scanning would go further).
