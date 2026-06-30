# 06 · Admin (Phase 3) Reference — the ISM control panel

> The control tower for the ISM team. Files: `Admin/adminView.html` (frontend) +
> `Admin/admin_code.js` (backend) + `Admin/admin_appsscript.json`. Verbatim deep-dive:
> `reference-docs/docs/manual/part-3-admin.md`.

---

## Access control

- **Restricted to INFOSEC-001 / INFOSEC-002** — a strict allowlist (verified: not a third role, an
  explicit allowlist), on top of the domain check (`true` in all 3 apps).
- The enforcement helper is **`checkAccess_(email)`** → `{allowed, reason}`. After the June 22–23
  hardening, **~17–22 callables are guarded** with it (`F-01/F-03`):
  ```js
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };
  ```
  Guarded functions include `deleteEntry`, `batchDeleteEntries`, `saveConfigData`, `getConfigData`,
  the `adminApi_*` read+write functions, `apiAdmin_RerouteApprovedRequest`,
  `apiAdmin_DownloadCertificate`, `adminResendEmail`, etc.

> `adminView.html` is served with `createHtmlOutputFromFile` — **NOT** a GAS template (no `<?…?>`
> engine), so the scriptlet-in-comment gotcha doesn't apply here (unlike PIA's `pia_index.html`).

## What Admin can do

1. **All-requests oversight** — read-only view of every request in the system (reuses the DTO shapes
   from the request detail).
2. **Settings — download links** — manage the `LINK_*_TEMPLATE` rows used by the DCS downloadables.
   The save function **`saveConfigData()` appends new keys** if they don't exist (it was taught to
   create-or-update, copying the INFOSEC-003 pattern), so adding a new download link = one form-group
   in `adminView.html` + one array entry. The UI historically exposed NDA/DPA/DSA/T&C; CU + OJT were
   added.
3. **Settings — reminder config** — on/off + hour. ⚠️ This is **cross-app**: Admin calls PIA's
   `getReminderConfig` / `setReminderConfig` (dispatched in PIA's `doPost`). The reminder **engine
   itself runs in PIA**, not Admin (see below).
4. **Email resend** — `adminResendEmail` re-fires `notifyApprover` / `notifyApplicant` /
   `apiPhase3_NotifyISMember` via `sendEmailWithRetry_`. These are **generic "log in to the system"**
   notices (CTA = `getOptionalUrl_('WEB_APP_URL')`, **no token, no `parentID`**) — a fallback nudge,
   not the primary tokenized workflow emails. Missing `WEB_APP_URL` → button silently omitted.
5. **Reroute / certificate download** — `apiAdmin_RerouteApprovedRequest`, `apiAdmin_DownloadCertificate`
   (both guarded).
6. Admin emails were **beautified** with a shared navy template (`buildAdminEmailHtml_`).

## ⚠️ Reminder-engine history (important)

An approver-reminder feature was **first built in Admin** (`adminApi_sendDailyReminders` +
`setupReminderTrigger`, plus the `script.scriptapp` scope), then it was discovered that **PIA already
had a better one**, so the **Admin reminder code was deliberately removed** ("PIA's is canonical").

- **Action item:** if a stale `adminApi_sendDailyReminders` **time-trigger** still exists in the Admin
  project, it errors daily (the function is gone) — **delete it** in Admin → Triggers.
- The real reminder engine is `sendDailyReminders()` in `Phase 2/pia_code.js` (~line 4671). Admin only
  *configures* it.

## Script Properties (Admin project)
- `WEB_APP_URL` → live **PIA** `/exec` (for the generic resend CTAs).
- `SPREADSHEET_ID` → the shared Sheet (same Sheet as DCS `DB_ID` / PIA `PIA_DB_SPREADSHEET_ID`).
- `ADMIN_API_KEY` → server-side only (not in the web UI). **Safe to rotate anytime** (no frozen email
  links depend on it), unlike PIA's `SYSTEM_SECRET`.
- Admin uses **no** `DCS_WEB_APP_URL` / `PIA_APP_URL`.

## Security status
F-01 / F-03 fixed (the ~17 `checkAccess_` guards). After deploying `admin_code.js`, run test guide
**Part E6** to confirm a legitimate INFOSEC member can still use every admin feature (a wrong
`checkAccess_` lookup would lock out real admins — the top regression risk).
