# 11 · Codebase Map

> A fast index of the source files. **The full source is in the git repo** (kept across the
> migration), this map exists so a fresh Claude can navigate it without re-reading everything. Line
> numbers are **approximate** (they drift as files change), treat as hints, confirm with a search.

---

## Repo layout

```
megaworld-DCS-automation/
├── Phase 1/                 # DCS app
│   ├── index.html           # frontend (~6,400 lines)
│   ├── Code.js              # backend (~2,670 lines)
│   └── appsscript.json      # manifest (Asia/Manila, domain access, scopes)
├── Phase 2/                 # PIA app
│   ├── pia_index.html       # frontend wizard (GAS TEMPLATE — scriptlet engine active)
│   ├── pia_code.js          # backend (~9,000 lines)
│   └── pia_appsscript.json
├── Admin/                   # Admin app
│   ├── adminView.html       # frontend
│   ├── admin_code.js        # backend
│   └── admin_appsscript.json
├── docs/                    # manual/, security docs, T&C, test guide, V2 diff, handoff
├── DPS_DB*.xlsx             # real DB export — GITIGNORED (PII), read-only reference
├── CLAUDE.md                # project instructions (the source for files 02–09)
├── README.md
└── .claude/commands/design-fix.md   # the /design-fix slash command
```

## `Phase 1/Code.js` (DCS backend), key functions
- `doGet(e)`, domain gate + serves `index.html` (`createHtmlOutputFromFile`, NOT a template).
- `apiGetSystemConfig` → `{success, config:{DOMAIN, LINK_*_TEMPLATE, ...}}` (generic passthrough).
- Drafts: `apiSaveDraft` / `apiRestoreDraft` / `apiListUserDrafts` / `apiDeleteDraft` (7-day TTL,
  text only, shared `Drafts` sheet).
- `submitDCS(payload, sessionId)` → `{success, reqId, phase2Url?}` (~line 1681), server re-validates,
  writes `Data_Collection` status `COMPLETE`, fires `notifyDcsRequester_` (~1705/1734).
- `uploadProxy` (~line 1090–1171), base64 → Drive `ADMIN_FOLDER_ID`; magic-byte anti-spoofing.
- `analyzeDCSRisk()`, risk auto-flagging → `Risk_Audit`.
- `apiListUserRequests` · `apiGetRequestData(reqId)` (~2521, **owner-guard F-04**) ·
  `apiGetReturnedApplication(reqId)` · `getGatewayRecord` (~2845, **caller-bound F-08**).
- `generatePhase2Url_`: builds the `?parentID=` PIA deep-link from `PIA_APP_URL`.
- Category-dropdown backend touch points (for the future category work): `Code.js:~1164, 1193–1225`.

## `Phase 1/index.html` (DCS frontend), key functions
`boot()` (reads `?parentID=`), `show(name)` (router), `renderLanding/Guide/Form/Agency/Summary/
Success/Drafts/Requests/RequestDetails`, `validateDCSForm()`, `triggerAutoSave()` (debounced),
`submitRequest()`, `editReturnedApplication()`, `renderApprovalTracker()`, `renderPiaTimeline()`
(5 stages), `getCombinedStatusBadge()` / `getStatusKey()`, `updateMainUploadLabel()` (endorsement
label), `DOWNLOADABLES` array (in `renderGuide()`), `fileLinkHtml` (Wave 2 #2, **built with string
concatenation, not a template literal**, see `09-gotchas`). `:root` design tokens near the top of
`<style>`.

## `Phase 2/pia_code.js` (PIA backend), key functions
- `doGet` / `doPost` (doPost dispatches cross-app APIs incl. `getReminderConfig`/`setReminderConfig`).
- Approval: `buildApproversFromAppData`, `initializeApprovalWorkflow`, `processApprovalDecision`
  (~4099, **F-02 guard**), `apiPhase3_ProcessISMDecision` (~6932, **F-02 guard**), `getISMReviewerStep`,
  `processDivHeadDecision` (~3850, **F-02 guard**).
- `submitApplication` (~3704), ownership re-check in a lock; rebuilds ladder on resubmit (~3790).
- Reads: `getApplicationData`, `apiPhase3_FetchPIAData` / `apiPhase3_FetchDCSData` (**F-05 guard via
  `isAuthorizedForApplication_`**).
- Email: `queueEmail` → `Email_Queue`; `processEmailQueue` + `setupEmailQueueTrigger()` (~4625);
  `notifyApplicant`, `notifyApprover`, `apiPhase3_NotifyISMember`; `sendEmailWithRetry`.
- Reminders: `sendDailyReminders` / `buildReminderEmail` / `setupReminderTrigger` (~4671).
- Finalize: `apiPhase3_RouteApprovedRequest(sessionId, destination)` (~7425; called ~7159 normal,
  ~3970 escalated), certificate + PDF to DCOPS/TechServe.
- Tokens: `generateAuthToken` / `isTokenValid` (14-day TTL), `getSystemSecret()` → `SYSTEM_SECRET`.
- `analyzeApplicationRisk` (~3602), flags drafter==head.
- ⚠️ `pia_index.html` real scriptlet: `const parentId = <?!= … ?>` (~4044), don't delete.

## `Admin/admin_code.js` (Admin backend), key functions
- `checkAccess_(email)`: INFOSEC-only gate (~17–22 call sites after hardening).
- `SHEET_NAMES` constant (~line 124), canonical sheet-name list.
- `saveConfigData()` (~1636), create-or-update config rows (appends new keys).
- `getConfigData`, `deleteEntry`, `batchDeleteEntries`, `adminApi_*` (read/write),
  `apiAdmin_RerouteApprovedRequest`, `apiAdmin_DownloadCertificate`, `adminResendEmail` (~874–912).
- `buildAdminEmailHtml_` (navy email template), `sendEmailWithRetry_`, `getOptionalUrl_`.
- (Removed) `adminApi_sendDailyReminders`, reminder engine moved to PIA; delete any stale trigger.

## Manifests (`*_appsscript.json`)
All `Asia/Manila`, domain access. Scopes only as needed: `script.send_mail` (MailApp),
`script.scriptapp` (time triggers: PIA reminder + email-queue; was added to Admin then the Admin
reminder was removed).

## Tooling notes (Kai's machine)
`node` available (`node --check` validates disk only, see `09-gotchas`). `python/python3` are broken
Windows stubs. `pdftotext` available. `jq` not guaranteed. Edits happen on a personal laptop → GitHub
→ work laptop pastes into GAS + redeploys (no clasp).
