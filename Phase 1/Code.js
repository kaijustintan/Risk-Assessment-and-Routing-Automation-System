// ============================================================
//  Code.js  (DCS / Privacy Impact Assessment — Phase 1 backend)
// ============================================================
/* mema
  [ OUTLINE ]
  FILE: Code.js
  PURPOSE (Layman): This is the server brain for Phase 1 of Megaworld's data-access
    request pipeline (the "DCS" form). It accepts a request, saves any attached NDA/DPA/DSA
    documents into a private Drive vault, records the request into the shared Google Sheet
    database, autosaves drafts while the user types, scans each request for suspicious
    patterns, emails the requester a "Proceed to Phase 2" link, and tells the Phase 2 (PIA)
    app whether a given user is cleared to continue. The employee never touches the database
    or the document vault directly — this script does it all on the developer's authority.
  TECHNICAL: Google Apps Script web app backend (server tier of a 3-phase system that shares
    ONE spreadsheet as its only integration point). Key patterns: a per-execution in-memory
    CACHE for Script Properties and opened Spreadsheets; LockService write locks (with
    operation-specific timeouts) around all multi-step DB mutations; defense-in-depth
    (domain + field + email re-validation server-side, mirroring the frontend); Sheets-as-DB
    accessed via TextFinder + batched getRange/getValues instead of full-sheet loads;
    secrets in Script Properties (DB_ID, ADMIN_FOLDER_ID, HMAC_SECRET, PIA_APP_URL, DOMAIN).
    Status column on Data_Collection drives the Phase 2 gate (PENDING / READY_FOR_PIA /
    COMPLETE / REJECTED / RETURNED). Execute-as: Me (least privilege / identity isolation);
    Access: anyone in the domain.

  CATEGORY: CONFIGURATION & HELPERS
    - initializePropertyCache_()          Loads all Script Properties into CACHE once per run.
    - getProp_(key)                       Returns a Script Property or throws if unset.
    - getCachedSpreadsheet_(id)           Opens/caches a Spreadsheet by ID.
    - apiGetSystemConfig()                Reads System_Configuration sheet + DOMAIN into a config map.
    - isAuthorizedDomain_(userEmail)       True if the email belongs to the corporate domain.
    - isValidEmail_(email)                 RFC-ish email format/length check.
    - getStyledHtmlWrapper_(header, body)  Wraps content in the branded HTML error/page shell.

  CATEGORY: ENTRY POINTS
    - doGet(e)                            Serves the DCS frontend (after domain auth) or a denial page.
    - doPost(e)                           Domain-gated POST handler; returns an "invalid request" page.
    - getUserIdentity()                   Returns the active user's email for frontend prefill.

  CATEGORY: DRAFT SYSTEM
    - apiDiscardDrafts_()                  Clears all of the user's DCS drafts (fresh start).
    - cleanupDraftsForUser_(sid,sheet,em) Lock-free draft row deletion helper.
    - apiMarkDraftComplete_(sessionId)     Locked wrapper around cleanupDraftsForUser_.
    - apiGenerateNewSessionId()           Allocates a sequential DCS-XXXXXX session ID.
    - apiSaveDraft(sessionId, stateData)  Upserts an autosaved draft (with limits/TTL).
    - apiRestoreDraft(sessionId)          Restores a draft by session ID.
    - apiListUserDrafts()                 Lists the user's non-expired, non-revision drafts.
    - apiLoadDraft_(draftId)               Loads one draft by draft ID (ownership-checked).
    - apiDeleteDraft(draftId)             Deletes a draft by draft ID or session ID.

  CATEGORY: FILE UPLOAD
    - uploadProxy_(b64,name,type,mime,req) Validates + decodes a base64 file into the Drive vault.
    - trashOldDriveFiles_(fileList)       Trashes superseded Drive files on revision.

  CATEGORY: SUBMISSION
    - submitDCS(payload, sessionId)       Main submit handler: validate→upload→write row→email.
    - notifyDcsRequester_(to, req, url)   Sends the styled "Proceed to Phase 2" confirmation email.
    - generatePhase2Url_(reqId)           Builds the PIA URL with ?parentID=reqId.
    - generateDCSReqId_()                 Allocates a sequential DCS-XXXXXX ReqID.

  CATEGORY: RISK AUDIT
    - analyzeDCSRisk_(dcsData, email)      Flags conflict-of-interest / duplicate-role / thin data.
    - logDCSAuditTrail_(sid, action, flags) Appends one audit row to Risk_Audit.
    - logDCSAuditTrailBatch_(entries)     Appends many audit rows in one write.

  CATEGORY: REQUEST DATA & APPROVERS
    - getRequestDataBatch_(ss,req,piaSid) Loads PIA record + all approval-workflow rows in one pass.
    - getPIARecordByDCSId_(ss, dcsReqId)  Finds the PIA record linked to a DCS request.
    - getApproversList_(ss,req,sid,meta)  Builds the DCS approver list from metadata + workflow.
    - getISMApproversList_(ss, piaSid)    Builds the InfoSec (ISM) approver list.
    - getDivHeadApproversList_(ss, piaSid) Builds the Division Head approver list.
    - apiGetRequestData(reqId)            Full request payload (form + files + timelines + flags).
    - apiListUserRequests()               Lists the current user's DCS requests (newest first).
    - apiGetReturnedApplication(reqId)    Validates + returns a request eligible for edit/resubmit.

  CATEGORY: STATUS & GATEWAY
    - apiGetStatus_()                      Status of the user's most recent DCS request.
    - getLatestDCSRecord_(sheet, email)   Returns the user's most recent Data_Collection row.
    - getGatewayRecord_(userEmail)         PIA handshake: is this user cleared for Phase 2?

  CATEGORY: INTEGRITY
    - computeIntegrityHash_(dcsId, piaSid) SHA-256 binding DCS ReqID to PIA SessionID.

  CATEGORY: ADMIN & SETUP
    - setupDataCollectionSheet()          One-time creation of core sheets + headers.
    - adminSetStatus(reqId, newStatus)    Manual status override (editor use).
    - purgeExpiredDrafts()                Daily-trigger purge of expired draft rows.
    - forceAuthorize()                    Dummy run to trigger the OAuth consent prompt.
*/

// ============================================================
//  DATA COLLECTION SYSTEM (DCS) — Code.gs
//  Phase 1 of the Risk Assessment & Routing System (RARS)
//
//  Architecture  : Google Apps Script Web App
//  Execute as    : Me (developer)  — Least Privilege / Identity Isolation
//  Access        : Anyone in the domain
//
//  Sheet targets (all in the DB spreadsheet):
//    • Data_Collection  — primary DCS record store
//    • Drafts           — temporary JSON store shared with PIA
//
//  PIA handshake: Status column drives the gate.
//    PENDING         → Immediate Head has not yet approved
//    READY_FOR_PIA   → Cleared for Phase 2
//    REJECTED        → Denied by Immediate Head
// ============================================================


// ============================================================
// 0. CONFIGURATION — set these in Script Properties (File → 
//    Project Properties → Script Properties) so secrets are
//    never hardcoded in source.
//
//    Required keys:
//      DB_ID             — Spreadsheet ID of the PIA_System_Database
//      ADMIN_FOLDER_ID   — Drive folder ID for vaulted document storage
//      HMAC_SECRET       — Random secret string for approval token signing
//      PIA_APP_URL       — Deployment URL of the PIA Web App (e.g., https://script.google.com/a/macros/domain.com/s/..../exec)
//      DOMAIN            — e.g. "companycorp.com"  (no leading @)
// ============================================================

// ============================================================
// PERFORMANCE OPTIMIZATION: Caching Layer
// ============================================================
const CACHE = {
  properties: {}, // Cached PropertiesService values
  spreadsheets: {}, // Cached spreadsheet objects
  initialized: false
};

const FILENAME_SANITIZE_REGEX = /[/\\<>:"|?*\x00-\x1f]/g;
const EMAIL_VALIDATE_REGEX = /^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// ============================================================
// Fix 3: Lock Timeouts — Define timeouts based on operation
// ============================================================
const LOCK_TIMEOUTS = {
  DRAFT: 30000,        // 30s for draft operations
  SUBMISSION: 45000,   // 45s for file upload + submission
  SESSION: 60000,      // 60s for session ID generation
  CLEANUP: 30000       // 30s for cleanup operations
};

/*
  Function: initializePropertyCache_
  LAYMAN:    On the first call of an execution it grabs every Script Property in one shot and
             stashes them in memory, so later code never has to ask Apps Script for them again.
  TECHNICAL: Idempotent — returns immediately if CACHE.initialized is already true. Copies
             PropertiesService.getScriptProperties().getProperties() into CACHE.properties.
             Failures are swallowed (logged as a warning) so a missing-cache never hard-crashes.
  PARAMS:    (none)
  RETURNS:   undefined (side effect: populates CACHE.properties and sets CACHE.initialized).
*/
function initializePropertyCache_() {
  if (CACHE.initialized) return;
  try {
    const props = PropertiesService.getScriptProperties().getProperties();
    CACHE.properties = { ...props };
    CACHE.initialized = true;
  } catch (e) {
    console.warn('Failed to initialize property cache:', e.message);
  }
}

/*
  Function: getProp_
  LAYMAN:    Hands back the value of a named secret/config (like DB_ID or DOMAIN). If that key
             was never set up in Project Properties, it throws a clear error instead of failing weirdly.
  TECHNICAL: Lazily initializes the property cache, then reads from CACHE.properties. Any
             falsy value (missing/empty) throws a descriptive Error naming the key.
  PARAMS:
    - key — Script Property name (e.g. 'DB_ID', 'ADMIN_FOLDER_ID', 'PIA_APP_URL', 'DOMAIN').
  RETURNS:   The string value, or throws Error if unset.
*/
function getProp_(key) {
  initializePropertyCache_();
  const val = CACHE.properties[key];
  if (!val) throw new Error(`Script property "${key}" is not set. Configure it in Project Properties.`);
  return val;
}

/*
  Function: getCachedSpreadsheet_
  LAYMAN:    Opens the database spreadsheet — but only the first time. After that it reuses the
             already-open handle, so we don't pay the cost of re-opening it again and again.
  TECHNICAL: Memoizes SpreadsheetApp.openById() results in CACHE.spreadsheets keyed by ID.
  PARAMS:
    - spreadsheetId — the Spreadsheet ID to open (usually getProp_('DB_ID')).
  RETURNS:   A SpreadsheetApp Spreadsheet object (cached for the rest of the execution).
*/
function getCachedSpreadsheet_(spreadsheetId) {
  if (!CACHE.spreadsheets[spreadsheetId]) {
    CACHE.spreadsheets[spreadsheetId] = SpreadsheetApp.openById(spreadsheetId);
  }
  return CACHE.spreadsheets[spreadsheetId];
}

/*
  Function: apiGetSystemConfig
  LAYMAN:    Reads the admin-managed settings sheet (template download links, T&C page URL, etc.)
             and returns them to the frontend as one tidy key→value bag, with the corporate
             DOMAIN folded in so the UI has a single source of truth.
  TECHNICAL: Reads every row of System_Configuration (col A = key, col B = value), trims and
             skips blank keys, then merges the DOMAIN Script Property into the map. Missing
             sheet → returns empty config (still success). Caller is the frontend on load.
  PARAMS:    (none)
  RETURNS:   { success:true, config:{KEY:value,...,DOMAIN} } on success;
             { success:false, error } on failure.
  EXAMPLE:   apiGetSystemConfig() -> { success:true, config:{ LINK_NDA_EMPLOYEE_TEMPLATE:'https://…', DOMAIN:'megaworld.com' } }
*/
function apiGetSystemConfig() {
  try {
    /* Step 1 — Open DB and locate the config sheet; absent sheet is non-fatal (empty config). */
    const ss = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName('System_Configuration');
    if (!sheet) return { success: true, config: {} };

    /* Step 2 — Walk every non-header row, building key→value pairs (blank keys skipped). */
    const data = sheet.getDataRange().getValues();
    const config = {};
    // Start from i=1 to skip headers
    for (let i = 1; i < data.length; i++) {
      const key = String(data[i][0] || '').trim();
      const val = String(data[i][1] || '').trim();
      if (key) {
        config[key] = val;
      }
    }

    /* Step 3 — Inject DOMAIN from Script Properties (blank if unset) so the UI need not guess. */
    // Merge the DOMAIN script property into the config so the frontend
    // has a single source of truth for the corporate domain.
    try {
      config['DOMAIN'] = getProp_('DOMAIN');
    } catch (e) {
      config['DOMAIN'] = '';
    }

    return { success: true, config: config };
  } catch (e) {
    console.error('apiGetSystemConfig error:', e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================
// 1. ENTRY POINTS
// ============================================================

// ============================================================
// HELPER FUNCTIONS — Authorization, Input Sanitization, HTML Styling
// ============================================================

/*
  Function: isAuthorizedDomain_
  LAYMAN:    The bouncer at the door — returns true only if the signed-in email ends in the
             company domain. Used everywhere we must keep outsiders out.
  TECHNICAL: Honors the ENABLED_DOMAIN_CHECK kill-switch (true in prod). Compares the
             lowercased email suffix against '@' + DOMAIN. Fail-secure: a missing DOMAIN
             property or a falsy email returns false rather than allowing access.
  PARAMS:
    - userEmail — the email to validate (typically Session.getActiveUser().getEmail()).
  RETURNS:   true if authorized, false otherwise (also false on missing config).
  EXAMPLE:   isAuthorizedDomain_('jane@megaworld.com') -> true
             isAuthorizedDomain_('hax@gmail.com')      -> false
*/

const ENABLED_DOMAIN_CHECK = true;
function isAuthorizedDomain_(userEmail) {
  if (!ENABLED_DOMAIN_CHECK) return true; // Skip check if disabled for testing
  if (!userEmail) return false;
  try {
    const domain = getProp_('DOMAIN');
    return userEmail.toLowerCase().endsWith('@' + domain.toLowerCase());
  } catch (e) {
    // Fail-secure if configuration is missing
    return false;
  }
}
/*
  Function: isValidEmail_
  LAYMAN:    Quick sanity check that a string actually looks like an email and isn't absurdly long.
  TECHNICAL: Guards non-strings, trims, tests against the precompiled EMAIL_VALIDATE_REGEX, and
             caps length at 180 chars. Not a full RFC parser — a pragmatic format gate.
  PARAMS:
    - email — candidate email string.
  RETURNS:   true if it passes the regex and length check, false otherwise.
*/
function isValidEmail_(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = String(email).trim();
  return EMAIL_VALIDATE_REGEX.test(trimmed) && trimmed.length <= 180;
}

/*
  Function: isOwnerContext_

  LAYMAN (Tropang Ex):
  Ito yung bouncer para sa mga function na HINDI pwedeng bigyan ng trailing underscore — yung
  mga trigger handler at yung mga pinapatakbo mo mismo sa editor. Sila kasi kailangang manatiling
  "public", kaya kahit sinong naka-login sa domain pwede silang tawagin galing browser console.
  Ang tanong na sinasagot nito: "ikaw ba talaga yung may-ari ng script, o isang trigger — o
  random na empleyado lang na nag-aalboroto sa console?"

  TECHNICAL:
  Under a webapp deployed with executeAs: USER_DEPLOYING, getEffectiveUser() always resolves to
  the deploying account while getActiveUser() resolves to the visiting account. Inside a
  time-driven trigger or an editor Run, BOTH resolve to the owner. Equality therefore implies
  owner-or-trigger context and is false for every ordinary visitor.

  Fails closed: a blank/withheld active user cannot match, and any thrown Session error returns
  false rather than allowing the call.

  PARAMS:    (none)
  RETURNS:   true only when running as the script owner or from a trigger; false otherwise.
*/
function isOwnerContext_() {
  try {
    const eff = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    const act = String(Session.getActiveUser().getEmail()    || '').trim().toLowerCase();
    return !!eff && !!act && eff === act;
  } catch (e) {
    return false;
  }
}

/*
  Function: getStyledHtmlWrapper_
  LAYMAN:    Takes a title block and some body HTML and wraps them in the branded Megaworld
             page shell (logo, fonts, navy styling). Used for the access-denied / error pages
             that doGet and doPost serve.
  TECHNICAL: Returns a complete standalone HTML document string (DM Sans, CSS variables, card
             layout). Pure string builder — no sheet/Drive access. Content is interpolated
             as-is, so callers must pass trusted/escaped markup.
  PARAMS:
    - header  — HTML for the page header (e.g. a badge + <h1>).
    - content — HTML for the card body.
  RETURNS:   A full HTML document string ready for HtmlService.createHtmlOutput().
*/
function getStyledHtmlWrapper_(header, content) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>DCS Approval</title>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg:      #ffffff;
          --bg2:     #f7f8fa;
          --bg3:     #eff1f5;
          --text:    #111827;
          --text2:   #4b5563;
          --text3:   #9ca3af;
          --border:  #e5e7eb;
          --border2: #d1d5db;
          --radius:  6px;
          --radius-lg: 12px;
          --font:    'DM Sans', system-ui, sans-serif;
          --navy:    #1a3a5c;
          --navy-mid: #1e4976;
          --navy-bright: #185FA5;
          --navy-glow: rgba(26, 58, 92, 0.12);
          --navy-tint: #eef4fb;
          --navy-border: rgba(26, 58, 92, 0.18);
          --danger:  #fef2f2;
          --danger-text: #991b1b;
          --warn:    #fffbeb;
          --warn-text: #92400e;
          --success: #ecfdf5;
          --success-text: #065f46;
        }
        body {
          font-family: var(--font);
          color: var(--text);
          background: var(--bg2);
          margin: 0; padding: 0;
          -webkit-font-smoothing: antialiased;
        }
        #app {
          max-width: 680px;
          margin: 0 auto;
          margin-top: 3.5rem;
          padding: 1rem 1.5rem 3rem;
        }
        .logo-brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 19px;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--navy);
          margin-bottom: 2rem;
          opacity: 0.8;
        }
        .logo-brand span { color: var(--navy); font-weight: 600; }
        .page-header { margin-bottom: 1.25rem; margin-top: 0.5rem; }
        .page-header h1 { font-size: 24px; font-weight: 800; color: var(--text); letter-spacing: -0.02em; line-height: 1.3; margin: 0; }
        .page-header p { font-size: 13.5px; color: var(--text2); margin-top: 5px; line-height: 1.6; margin: 0; }
        .step-badge {
          display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
          letter-spacing: 0.06em; text-transform: uppercase; background: var(--navy-tint);
          color: var(--navy-mid); padding: 3px 10px; border-radius: 99px; margin-bottom: 10px;
          border: 1px solid var(--navy-border);
        }
        .card {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: 1.25rem 1.5rem;
          margin-bottom: 1rem;
        }
        .alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--radius); font-size: 13px; margin-bottom: 1rem; line-height: 1.55; border: 1px solid transparent; }
        .alert-danger { background: var(--danger); color: var(--danger-text); border-color: rgba(220,38,38,0.2); }
        .btn {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 6px; padding: 9px 18px; font-size: 13.5px; font-weight: 500;
          border-radius: var(--radius); cursor: pointer; border: 1px solid var(--border2);
          background: var(--bg); color: var(--text); font-family: var(--font);
          transition: all 140ms ease; text-decoration: none;
        }
        .btn-primary { background: var(--navy); color: white; }
        .summary-row {
          display: grid; grid-template-columns: 1fr 2fr; gap: 12px; padding: 8px 0;
          border-bottom: 1px solid var(--border); font-size: 13px; text-align: left; align-items: flex-start;
        }
        .summary-label {
          color: var(--text3); min-width: 156px; flex-shrink: 0; font-size: 12.5px;
          font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
          line-height: 1.75;
          overflow-wrap: anywhere;
        }
        .summary-value { color: var(--text); word-break: break-word; flex: 1; min-width: 0; padding: 0; }
        .pii-tag {
          display: inline-block; background: var(--navy-tint); color: var(--navy-mid);
          border: 1px solid var(--navy-border); padding: 3px 10px; border-radius: 99px;
          font-size: 11.5px; font-weight: 500; margin: 0 4px 6px 0;
        }
        .stakeholder-tag {
          display: inline-block; background: var(--bg3); color: var(--text2);
          border: 1px solid var(--border2); padding: 3px 10px; border-radius: var(--radius);
          font-size: 12px; font-weight: 500; margin: 0 4px 4px 0;
        }
        .status-badge {
          display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
          padding: 3px 10px; border-radius: 99px; letter-spacing: 0.01em;
          white-space: nowrap;
        }
        .status-approved { background: var(--success); color: var(--success-text); }
        .status-pending  { background: var(--warn);    color: var(--warn-text); }
        .status-rejected { background: var(--danger);  color: var(--danger-text); }
        .status-denied   { background: var(--danger);  color: var(--danger-text);  }
        .btn-success { background: var(--success); color: var(--success-text); border-color: transparent; }
        .btn-warn    { background: var(--warn);    color: var(--warn-text);    border-color: transparent; }
        .btn-danger  { background: var(--danger);  color: var(--danger-text);  border-color: transparent; }
        .summary-section-title {
          font-size: 11px; font-weight: 600; color: var(--text3);
          text-transform: uppercase; letter-spacing: 0.07em; margin-top: 1.5rem; margin-bottom: 10px;
        }
        .form-textarea {
          display: block;
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          padding: 9px 12px;
          border: 1px solid var(--border2);
          border-radius: var(--radius);
          background: var(--bg);
          color: var(--text);
          font-family: var(--font);
          outline: none;
          resize: vertical;
          min-height: 88px;
          line-height: 1.6;
          font-size: 14px;
          margin-top: 10px;
          margin-bottom: 15px;
          overflow: auto;
          word-wrap: break-word;
        }
        .form-textarea::placeholder { color: var(--text3); }
        details {
          margin-top: 1rem;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--bg2);
          padding: 0.75rem 1rem;
        }
        summary {
          font-weight: 500;
          color: var(--navy-mid);
          cursor: pointer;
          padding: 0.25rem 0;
          outline: none;
        }
        .details-content { padding: 4px 2px 12px; }
        @media (max-width: 767px) {
          #app { padding: 0.5rem 1rem 3rem; margin-top: 1.5rem; }
          .page-header h1 { font-size: 20px; }
          .card { padding: 1rem 1.25rem; }
          .btn { width: 100%; margin-bottom: 8px; box-sizing: border-box; }
          .summary-row { grid-template-columns: 1fr; gap: 4px; padding: 12px 0; }
          .summary-label { min-width: unset; font-size: 11px; line-height: 1.2; }
        }
      </style>
    </head>
    <body>
      <div id="app">
          <div class="logo-brand" id="app-mini-logo">
            <img src="https://upload.wikimedia.org/wikipedia/commons/e/e2/Megaworld_logo_and_wordmark.svg" alt="Megaworld Logo" height="28">
          </div>
        <div class="page-header">${header}</div>
        <div class="card">${content}</div>
      </div>
    </body>
    </html>
  `;
}


// ============================================================
// 1. ENTRY POINTS — Web App Handlers
// ============================================================

/*
  Function: doGet
  LAYMAN:    The front door of the web app. When someone opens the DCS URL, this decides what
             they see: an "Access Denied" page if they're not on a company account, otherwise
             the actual DCS application (index.html).
  TECHNICAL: GAS HTTP GET entry point. Re-checks isAuthorizedDomain_ before serving anything
             (defense-in-depth layer 1). On failure returns a styled denial page; on success
             serves index.html with SAMEORIGIN framing when supported.
  PARAMS:
    - e — the GAS event object (query params; unused here beyond being the handler signature).
  RETURNS:   An HtmlOutput — either the denial page or the DCS frontend.
*/
function doGet(e) {
  const userEmail = Session.getActiveUser().getEmail();

  /* Step 1 — Gate by domain; bounce non-corporate accounts with a styled denial page. */
  // Domain authorization check
  if (!isAuthorizedDomain_(userEmail)) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Strictly Access Denied</span><h1>Restricted</h1>`;
    const content = `
      <div class="alert alert-danger">Security verification failed. This system is restricted</div>
      <p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Outside of the corporation is strictly access denied. Please switch to your corporate account and try again.</p>
      <p style="color: var(--text3); font-size: 0.85rem; margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem;">Current account: <strong>${userEmail || 'Anonymous/Public'}</strong></p>
    `;
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(header, content))
    .setTitle('Access Denied');
  }

  /* Step 2 — Authorized: serve the DCS frontend with SAMEORIGIN framing where available. */
  // Serve main DCS frontend
  const output = HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Data Collection System (DCS)');

  if (HtmlService.XFrameOptionsMode && HtmlService.XFrameOptionsMode.SAMEORIGIN) {
    output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.SAMEORIGIN);
  }

  return output;
}

/*
  Function: doPost
  LAYMAN:    Handles HTTP POSTs to the web app. Like doGet it first blocks non-company accounts,
             but DCS has no real POST workflow, so an authorized POST just gets an "Invalid
             Request" page (the actual form submits go through google.script.run → submitDCS).
  TECHNICAL: GAS HTTP POST entry point. Re-validates domain (denial page on failure), then
             returns a generic "missing parameters" page — kept for the PIA-style security shape.
  PARAMS:
    - e — the GAS POST event object (parameters; not consumed beyond the signature).
  RETURNS:   An HtmlOutput — denial page or the invalid-request page.
*/
function doPost(e) {
  const userEmail = Session.getActiveUser().getEmail();
  
  // Domain authorization check
  if (!isAuthorizedDomain_(userEmail)) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Access Denied</span><h1>Restricted</h1>`;
    const content = `
      <div class="alert alert-danger">Security verification failed. This system is restricted</div>
      <p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Outside of the corporation is strictly access denied. Please switch to your corporate account and try again.</p>
      <p style="color: var(--text3); font-size: 0.85rem; margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem;">Current account: <strong>${userEmail || 'Anonymous/Public'}</strong></p>
    `;
    
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(header, content))
    .setTitle('Access Denied');
  }

  return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
    `<h1>Invalid Request</h1>`,
    `<div class="alert alert-danger">The request is missing required parameters.</div>`
  ));
}




/*
  Function: getUserIdentity
  LAYMAN:    Tells the frontend who is logged in (their email), so the form can prefill identity.
  TECHNICAL: Thin wrapper over Session.getActiveUser().getEmail(). Called via google.script.run on load.
  PARAMS:    (none)
  RETURNS:   { email: <active user email string> }.
*/
function getUserIdentity() {
  return { email: Session.getActiveUser().getEmail() };
}


// ============================================================
// 3. DRAFT SYSTEM
// ============================================================

// --- Schema reference ------------------------------------
// Drafts sheet columns (1-indexed):
//   A: DraftID   B: UserEmail   C: SessionID   D: Type
//   E: StateJSON   F: SavedTimestamp   G: ExpiresAt

const DRAFTS_SHEET_NAME   = 'Drafts';
const DCS_DRAFT_TYPE      = 'DCS';
const DRAFT_TTL_DAYS      = 7;

/*
  Function: apiDiscardDrafts_
  LAYMAN:    "Throw away all my saved drafts." Called when the user wants a clean slate to start
             a brand-new request, so no half-finished autosaves linger.
  TECHNICAL: Delegates to apiMarkDraftComplete_() with no sessionId (clears all of the user's DCS
             drafts), then best-effort logs the discard to the audit trail.
  PARAMS:    (none)
  RETURNS:   The { success, error? } object from apiMarkDraftComplete_().
*/
function apiDiscardDrafts_() {
  const result = apiMarkDraftComplete_();
  if (result.success) {
    try { logDCSAuditTrail_('', 'DCS Drafts Discarded', false); } catch (e) {}
  }
  return result;
}

/*
  Function: cleanupDraftsForUser_
  LAYMAN:    Deletes a user's DCS draft rows from the Drafts sheet — either one specific session's
             draft, or all of them. This is the lock-free engine; callers that need a lock wrap it.
  TECHNICAL: Does NOT acquire its own LockService lock, so it is safe to call from an already-locked
             context (e.g. submitDCS). Uses TextFinder on the email column (B) and optionally the
             session column (C), filters to rows of type DCS, dedupes row numbers, then deletes
             bottom-up (descending) to avoid row-shift corruption.
  PARAMS:
    - sessionId — specific session to clear; if undefined/'' all of the user's DCS drafts are cleared.
    - sheet     — the Drafts Sheet object.
    - email     — the owning user's email (case-insensitive match).
  RETURNS:   undefined (side effect: deletes matching draft rows).
*/
function cleanupDraftsForUser_(sessionId, sheet, email) {
  const sessionFinder = sessionId 
    ? sheet.getRange('C:C').createTextFinder(sessionId).matchEntireCell(true).findAll()
    : null;
  
  const emailFinder = sheet.getRange('B:B')
    .createTextFinder(email)
    .matchEntireCell(true)
    .findAll();

  const rowsToDelete = [];
  
  for (const cell of emailFinder) {
    const row = cell.getRow();
    const [, , rowSid, rowType] = sheet.getRange(row, 1, 1, 4).getValues()[0];
    if (rowType !== DCS_DRAFT_TYPE) continue;
    if (sessionId === undefined || sessionId === '' || String(rowSid) === String(sessionId)) {
      rowsToDelete.push(row);
    }
  }

  if (sessionFinder) {
    for (const cell of sessionFinder) {
      const row = cell.getRow();
      const [rowEmail, , , rowType] = sheet.getRange(row, 1, 1, 4).getValues()[0];
      if (String(rowEmail).toLowerCase() === email.toLowerCase() && rowType === DCS_DRAFT_TYPE) {
        if (!rowsToDelete.includes(row)) rowsToDelete.push(row);
      }
    }
  }

  rowsToDelete.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
}

/*
  Function: apiMarkDraftComplete_
  LAYMAN:    The locked, safe way to delete a user's draft(s) — used when a draft is finished or
             discarded. Grabs a write lock so two simultaneous calls can't trip over each other.
  TECHNICAL: Acquires a script lock (DRAFT timeout), resolves the active user + Drafts sheet, then
             calls the lock-free cleanupDraftsForUser_. Logs completion best-effort; always
             releases the lock in finally.
  PARAMS:
    - sessionId — optional; specific session to clear, else all the user's DCS drafts.
  RETURNS:   { success:true } on success; { success:false, error } on failure.
*/
function apiMarkDraftComplete_(sessionId) {
  /* Step 1 — Acquire the draft write lock to serialize cleanup. */
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.DRAFT);
  try {
    /* Step 2 — Resolve user + Drafts sheet (missing sheet is a hard error). */
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Drafts sheet not found' };

    /* Step 3 — Delete the matching draft row(s) via the lock-free helper. */
    cleanupDraftsForUser_(sessionId, sheet, email);
    
    try { logDCSAuditTrail_(sessionId || 'all', 'DCS Draft Completed', false); } catch (e) {}
    return { success: true };
  } catch (err) {
    console.error('apiMarkDraftComplete_ error:', err.message);
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// 3B. SESSION-BASED DRAFT SYSTEM (Aligned with PIA)
// ============================================================

const DCS_SESSION_ID_COUNTER_PROP = 'DCS_COUNTER';

/*
  Function: apiGenerateNewSessionId
  LAYMAN:    Hands the frontend a fresh, unique request ID (like DCS-000042) the moment a new
             application begins, so autosaves and the eventual submission share one identifier.
  TECHNICAL: Locks (SESSION timeout), atomically increments the DCS_COUNTER Script Property, and
             formats it as 'DCS-' + 6-digit zero-padded number. Logs generation best-effort.
  PARAMS:    (none)
  RETURNS:   The new session-ID string (e.g. 'DCS-000001').
*/
function apiGenerateNewSessionId() {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.SESSION);
  
  try {
    const props = PropertiesService.getScriptProperties();
    const rawNum = Number(props.getProperty(DCS_SESSION_ID_COUNTER_PROP) || 0) + 1;
    props.setProperty(DCS_SESSION_ID_COUNTER_PROP, String(rawNum));
    
    const sid = 'DCS-' + String(rawNum).padStart(6, '0');
    try { logDCSAuditTrail_(sid, 'DCS Session Generated', false); } catch (e) {}
    return sid;
  } finally {
    lock.releaseLock();
  }
}

/*
  Function: apiSaveDraft
  LAYMAN:    Autosaves the in-progress form. If a draft for this session already exists it overwrites
             it; otherwise it creates a new one (up to 5 per user). It refuses payloads that are too
             big — drafts store text only, never base64 files.
  TECHNICAL: Locked (DRAFT timeout) upsert into the Drafts sheet. Serializes stateData to JSON and
             rejects > 50,000 chars. Uses TextFinder (session col C, email col B) instead of full-sheet
             loads to find an existing owned DCS row, counts the user's live (non-expired) DCS drafts,
             and enforces a max of 5 only on new inserts. Updates cols E-G (state, savedAt, expiresAt)
             on update, or appends a UUID-keyed row on insert. TTL = DRAFT_TTL_DAYS from now.
  PARAMS:
    - sessionId — the DCS session ID this draft belongs to.
    - stateData — the form state object to persist (text only).
  RETURNS:   { success:true, draftId } on success; { success:false, error } on size/limit/error.
  EXAMPLE:   apiSaveDraft('DCS-000007', { dcs:{ name:'Payroll access' } })
               -> { success:true, draftId:'a1b2-…' }
*/
function apiSaveDraft(sessionId, stateData) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.DRAFT);
  
  try {
    /* Step 1 — Resolve user/sheet, compute TTL, serialize state, and reject oversized payloads. */
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    const now   = new Date();
    const expires = new Date(now.getTime() + DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const stateStr = JSON.stringify(stateData);

    if (stateStr.length > 50000) {
      return { success: false, error: 'Draft size exceeds storage limit (50,000 characters). Cannot store large base64 files in StateJSON.' };
    }
    
    /* Step 2 — Find an existing draft row owned by this user for this session (update target). */
    // OPTIMIZED: Use TextFinder to locate existing session instead of getDataRange()
    let existingRow = -1;
    let existingDraftId = '';
    if (sessionId) {
      const sessionFinder = sheet.getRange('C:C')
        .createTextFinder(sessionId)
        .matchEntireCell(true)
        .findAll();
      
      for (const cell of sessionFinder) {
        const row = cell.getRow();
        const [userEmail, , type] = sheet.getRange(row, 2, 1, 3).getValues()[0];
        if (String(userEmail).toLowerCase() === email.toLowerCase() && type === DCS_DRAFT_TYPE) {
          existingRow = row;
          existingDraftId = sheet.getRange(row, 1).getValue();
          break;
        }
      }
    }

    /* Step 3 — Count the user's live (non-expired) DCS drafts to enforce the 5-draft cap. */
    // Count user's DCS drafts for limit check (OPTIMIZED: uses filtered query)
    let userDraftCount = 0;
    const emailFinder = sheet.getRange('B:B')
      .createTextFinder(email)
      .matchEntireCell(true)
      .findAll();
    
    for (const cell of emailFinder) {
      const row = cell.getRow();
      const [, , type, , , expiresAt] = sheet.getRange(row, 2, 1, 6).getValues()[0];
      if (type === DCS_DRAFT_TYPE) {
        if (!expiresAt || new Date(expiresAt) >= now) {
          userDraftCount++;
        }
      }
    }

    // Enforce limit only when creating a new draft
    if (existingRow < 0 && userDraftCount >= 5) {
      return { success: false, error: 'Maximum limit of 5 drafts reached. Please delete or submit existing drafts.' };
    }
    
    /* Step 4 — Upsert: overwrite the existing row's state/timestamps, or append a new UUID-keyed row. */
    let draftId;
    if (existingRow > 0) {
      // UPDATE existing draft
      draftId = existingDraftId;
      sheet.getRange(existingRow, 5, 1, 3).setValues([[stateStr, now, expires]]);
    } else {
      // INSERT new draft row
      draftId = Utilities.getUuid();
      sheet.appendRow([
        draftId,
        email,
        sessionId,
        DCS_DRAFT_TYPE,
        stateStr,
        now,
        expires
      ]);
    }
    
    return { success: true, draftId: draftId };
  } catch (err) {
    console.error('apiSaveDraft error:', err.message);
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

/*
  Function: apiRestoreDraft
  LAYMAN:    Brings back a saved draft for a given session so the user can keep editing. Expired
             drafts are skipped (and quietly deleted). Note: files are never restored — only text.
  TECHNICAL: TextFinder on session col C; for each match owned by the user with type DCS, checks
             expiry (deletes + skips if past), else JSON-parses the state and returns it. Logs the
             restore best-effort. Read-only except for purging expired rows it encounters.
  PARAMS:
    - sessionId — the DCS session ID whose draft to restore.
  RETURNS:   { found:true, state } if a live draft is found; { found:false, state:null } otherwise;
             { found:false, state:null, error } on exception.
*/
function apiRestoreDraft(sessionId) {
  try {
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    const now   = new Date();
    
    const emailFinder = sheet.getRange('C:C')
      .createTextFinder(sessionId)
      .matchEntireCell(true)
      .findAll();
    
    // OPTIMIZED: Batch cell access to reduce API calls
    for (const cell of emailFinder) {
      const row = cell.getRow();
      const [rowEmail, , rowType, rowState, , rowExpiresAt] = sheet.getRange(row, 2, 1, 6).getValues()[0];
      
      if (rowType !== DCS_DRAFT_TYPE) continue;
      if (String(rowEmail).toLowerCase() !== email.toLowerCase()) continue;
      
      /* Step — Drop expired drafts on sight; otherwise parse and return the saved state. */
      const expiresAt = new Date(rowExpiresAt);
      if (rowExpiresAt && expiresAt < now) {
        sheet.deleteRow(row);
        continue;
      }

      const parsed = rowState ? JSON.parse(rowState) : null;
      try { logDCSAuditTrail_(sessionId, 'DCS Draft Restored', false); } catch (e) {}
      return { found: true, state: parsed };
    }
    
    return { found: false, state: null };
  } catch (err) {
    console.error('apiRestoreDraft error:', err.message);
    return { found: false, state: null, error: err.message };
  }
}

/*
  Function: apiListUserDrafts
  LAYMAN:    Builds the "Resume a saved draft" list for the current user — each entry shows a name
             and when it was saved. Expired drafts are pruned, and revision-mode drafts are hidden.
  TECHNICAL: TextFinder on email col B; for each owned DCS row, expired rows are queued for batch
             deletion, otherwise JSON is lazily parsed. Skips drafts with state.isEditing (revision
             mode). Expired rows are deleted bottom-up after the scan to avoid row shift.
  PARAMS:    (none)
  RETURNS:   { drafts:[{ draftId, sessionId, savedAt(ISO|null), name }, ...] };
             { drafts:[], error } on exception.
*/
function apiListUserDrafts() {
  try {
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    const now   = new Date();
    
    const drafts = [];
    const rowsToDelete = [];
    
    // OPTIMIZED: Use TextFinder to pre-filter by email instead of loading entire sheet
    const emailFinder = sheet.getRange('B:B')
      .createTextFinder(email)
      .matchEntireCell(true)
      .findAll();
    
    for (const cell of emailFinder) {
      const row = cell.getRow();
      // Get A:G in one batch (ID, email, sessionId, type, state, savedAt, expiresAt)
      const [draftId, , sessionId, type, stateStr, savedAt, expiresAt] = sheet.getRange(row, 1, 1, 7).getValues()[0];
      
      if (type !== DCS_DRAFT_TYPE) continue;
      
      const expiresDate = new Date(expiresAt);
      if (expiresAt && expiresDate < now) {
        rowsToDelete.push(row);
        continue;
      }
      
      // OPTIMIZED: Only parse JSON for non-expired drafts (lazy evaluation)
      const state = stateStr ? JSON.parse(stateStr) : {};
      if (state.isEditing) continue; // Skip revision mode drafts

      drafts.push({
        draftId: draftId,
        sessionId: sessionId,
        savedAt: (savedAt instanceof Date) ? savedAt.toISOString() : (savedAt ? new Date(savedAt).toISOString() : null),
        name: (state.dcs && state.dcs.name) ? state.dcs.name : 'Untitled Request'
      });
    }

    // OPTIMIZED: Batch delete in reverse order to avoid row shifting issues
    if (rowsToDelete.length > 0) {
      rowsToDelete.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
    }
    
    return { drafts: drafts };
  } catch (err) {
    console.error('apiListUserDrafts error:', err.message);
    return { drafts: [], error: err.message };
  }
}

/*
  Function: apiLoadDraft_
  LAYMAN:    Opens one specific saved draft (chosen from the list) by its draft ID, but only if it
             belongs to the current user and hasn't expired.
  TECHNICAL: TextFinder.findNext on draft-ID col A. Ownership-checks col B (case-insensitive);
             mismatch returns an 'Unauthorized access' error. Expired rows are deleted and reported
             as not found. Otherwise JSON-parses and returns the state plus its sessionId.
  PARAMS:
    - draftId — the draft's UUID (column A).
  RETURNS:   { found:true, sessionId, state } if owned and live;
             { found:false, sessionId:'', state:null, error? } otherwise.
*/
function apiLoadDraft_(draftId) {
  try {
    const ss = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    const now = new Date();
    const email = Session.getActiveUser().getEmail();
    
    const finder = sheet.getRange('A:A')
      .createTextFinder(draftId)
      .matchEntireCell(true)
      .findNext();
    
    if (!finder) return { found: false, sessionId: '', state: null };
    
    const row = finder.getRow();

    // OPTIMIZED: Batch access to cells B:G in one call instead of 4 separate calls
    const [draftOwner, , sessionId, , stateStr, , expiresAt] = sheet.getRange(row, 2, 1, 6).getValues()[0];
    
    if (String(draftOwner).toLowerCase() !== email.toLowerCase()) {
      return { found: false, sessionId: '', state: null, error: 'Unauthorized access' };
    }

    const expiresDate = new Date(expiresAt);
    if (expiresAt && expiresDate < now) {
      sheet.deleteRow(row);
      return { found: false, sessionId: '', state: null };
    }
    
    const parsed = stateStr ? JSON.parse(stateStr) : null;
    return { found: true, sessionId: sessionId, state: parsed };
  } catch (err) {
    console.error('apiLoadDraft_ error:', err.message);
    return { found: false, sessionId: '', state: null, error: err.message };
  }
}

/*
  Function: apiDeleteDraft
  LAYMAN:    Deletes a single draft the user chose to disregard. It accepts either a draft ID or a
             session ID, and only deletes rows the user actually owns.
  TECHNICAL: TextFinder.findNext first on draft-ID col A, then (if not found) on session-ID col C.
             Each candidate is ownership-checked on col B before deletion; logs the delete best-effort.
             Note: returns success even when nothing matched (idempotent delete).
  PARAMS:
    - draftId — a draft UUID (col A) or a session ID (col C).
  RETURNS:   { success:true } (incl. no-op); { success:false, error } on missing ID or exception.
*/
function apiDeleteDraft(draftId) {
  try {
    if (!draftId) return { success: false, error: 'No ID provided' };

    const email = Session.getActiveUser().getEmail();
    const ss = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    const targetId = String(draftId || '').trim();

    // OPTIMIZED: Try to find by DraftID first (column A) with TextFinder
    let draftIdFinder = sheet.getRange('A:A')
      .createTextFinder(targetId)
      .matchEntireCell(true)
      .findNext();
    
    if (draftIdFinder) {
      const row = draftIdFinder.getRow();
      const rowEmail = sheet.getRange(row, 2).getValue();
      if (String(rowEmail).toLowerCase() === email.toLowerCase()) {
        sheet.deleteRow(row);
        try { logDCSAuditTrail_(draftId, 'DCS Draft Deleted', false); } catch (e) {}
        return { success: true };
      }
    }

    /* Step — Fallback: not found by draft ID, so try matching the session ID (still ownership-checked). */
    // If not found by DraftID, search by SessionID (column C)
    const sessionIdFinder = sheet.getRange('C:C')
      .createTextFinder(targetId)
      .matchEntireCell(true)
      .findNext();
    
    if (sessionIdFinder) {
      const row = sessionIdFinder.getRow();
      const rowEmail = sheet.getRange(row, 2).getValue();
      if (String(rowEmail).toLowerCase() === email.toLowerCase()) {
        sheet.deleteRow(row);
        try { logDCSAuditTrail_(draftId, 'DCS Draft Deleted', false); } catch (e) {}
        return { success: true };
      }
    }
    
    return { success: true };
  } catch (err) {
    console.error('apiDeleteDraft error:', err.message);
    return { success: false, error: err.message };
  }
}



// ============================================================
// 4. FILE PROXY SERVICE  (Vaulted Storage)
// ============================================================

/*
  Function: uploadProxy_
  LAYMAN:    The secure file drop. The browser hands over a document (NDA/DPA/DSA/endorsement) as
             base64 text; this function checks it's really a PDF/DOC/DOCX, isn't too big, and isn't
             a disguised file, then saves it into the admin-only Drive vault and returns the file's ID.
             The employee never gets access to that folder — the script does it on the developer's authority.
  TECHNICAL: Multi-layer validation: required-param check; MIME allowlist (incl. octet-stream because
             browsers misreport); filename sanitization (FILENAME_SANITIZE_REGEX, 255-char cap); renames
             to `${reqId}-${fileType}.${ext}`; extension allowlist; base64 decode; min/max size (10 MB);
             and magic-byte signature check per extension (anti-spoofing). Creates the blob in the
             ADMIN_FOLDER_ID folder and DELIBERATELY sets no sharing, so the file stays owner-only
             (private). Read access goes through apiDownloadDcsFile(). All failures rethrow with
             file-type context.
  PARAMS:
    - base64File       — base64-encoded file content.
    - originalFileName — the file's original name (sanitized; used only for its extension).
    - fileType         — logical type tag ('NDA','CU','DPA','DSA','ENDORSEMENT') used in the new name.
    - mimeType         — the claimed MIME type.
    - reqId            — DCS Request ID, prefixed onto the stored filename.
  RETURNS:   The new Drive file's ID (string). Throws a descriptive Error on any validation/IO failure.
  EXAMPLE:   uploadProxy_('JVBER...', 'nda.pdf', 'NDA', 'application/pdf', 'DCS-000007')
               -> '1AbC...xyz'  (Drive file ID)
*/
function uploadProxy_(base64File, originalFileName, fileType, mimeType, reqId) {
  try {
    /* Step 1 — Validate inputs: presence, MIME allowlist, sanitized name, and extension allowlist. */
    // ============ VALIDATION ============
    if (!base64File || !originalFileName || !mimeType) {
      throw new Error('uploadProxy_: missing required parameter.');
    }

    // MEDIUM: File type validation on backend (beyond client-side)
    // NOTE: Security is enforced by extension check + magic bytes below.
    // We accept 'application/octet-stream' because the browser's File.type API
    // sometimes fails to detect the MIME type for valid PDFs/DOCX files.
    const ALLOWED_MIME_TYPES = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream'
    ];
    
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error(`Invalid file type: ${mimeType}. Allowed: PDF, DOC, DOCX`);
    }

    // Sanitise filename — strip path traversal attempts
    const safeOriginalFileName = originalFileName.replace(FILENAME_SANITIZE_REGEX, '_').slice(0, 255);
    
    // Check file extension matches claimed type
    const fileExt = safeOriginalFileName.includes('.') ? safeOriginalFileName.split('.').pop().toLowerCase() : '';
    const newFileName = `${reqId}-${fileType}.${fileExt}`;
    const validExts = {
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    
    if (!fileExt || !validExts[fileExt]) {
      throw new Error(`Invalid or missing file extension. Allowed: PDF, DOC, DOCX`);
    }

    /* Step 2 — Decode base64 to bytes and verify size bounds (min 4 bytes, max 10 MB). */
    // ============ DECODE & VERIFY ============
    let bytes;
    try {
      bytes = Utilities.base64Decode(base64File);
    } catch (e) {
      throw new Error(
        'File content could not be decoded. The file may be corrupted or incomplete. ' +
        'Please re-save the file as a standard PDF or Word document and try again.'
      );
    }
    if (bytes.length < 4) {
      throw new Error('File content is too short or empty.');
    }
    
    // HIGH: File size validation (prevents OOM from oversized payloads)
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB, must match frontend limit
    if (bytes.length > MAX_BYTES) {
      const sizeMB = (bytes.length / 1024 / 1024).toFixed(2);
      throw new Error(
        'File exceeds maximum size of 10 MB. Received ' + sizeMB + ' MB.'
      );
    }
    
    /* Step 3 — Magic-byte check: confirm the file's real signature matches its claimed extension. */
    // Magic bytes verification
    const magicBytes = [
      bytes[0].toString(16).padStart(2, '0'),
      bytes[1].toString(16).padStart(2, '0'),
      bytes[2].toString(16).padStart(2, '0'),
      bytes[3].toString(16).padStart(2, '0')
    ].join('').toUpperCase();
    
    const MAGIC_BYTES_MAP = {
      'pdf': ['25504446'],
      'doc': ['D0CF11E0'],
      'docx': ['504B0304']
    };
    
    const allowedMagic = MAGIC_BYTES_MAP[fileExt] || [];
    if (!allowedMagic.includes(magicBytes)) {
      throw new Error(`File content does not match extension (.${fileExt}). Possible MIME spoofing attempt.`);
    }

    /* Step 4 — Create the file in the admin-only vault folder. */
    // ============ CREATE FILE IN DRIVE ============
    const folder = DriveApp.getFolderById(getProp_('ADMIN_FOLDER_ID'));
    
    let blob, file;
    try {
      blob = Utilities.newBlob(bytes, mimeType, newFileName);
      file = folder.createFile(blob);
    } catch (e) {
      throw new Error(
        'Failed to create file in Drive. The file may be too large or corrupted. ' +
        'Error: ' + e.message
      );
    }

    /* Step 5 — Leave the file PRIVATE (no setSharing call) and return the new file ID. */
    // ============ NO SHARING — PRIVATE BY DEFAULT ============
    // SECURITY: this function previously called
    //     file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
    // which published every NDA / DPA / DSA / Confidentiality Undertaking / Endorsement Letter
    // to anyone on the internet holding the URL. Those documents carry personal data, signatures
    // and contract terms, and the raw Drive URL was rendered into the UI and into approver review
    // pages, so a single forwarded screenshot leaked the document publicly.
    //
    // DriveApp.createFile() leaves a file owner-only, so doing nothing here is the control.
    // Read access is now served exclusively through apiDownloadDcsFile(), which re-authorizes the
    // caller AND verifies the requested fileId actually belongs to that request.
    //
    // ONE DELIBERATE EXCEPTION, elsewhere: PIA's getAndShareDCSFiles_() still elevates a single
    // request's files to DOMAIN_WITH_LINK at final-certificate time, because the Certificate of
    // Approval email + PDF sent to DCOPS/TechServe cannot call google.script.run. See the comment
    // block on that function in Phase 2/pia_code.js.

    return file.getId();

  } catch (e) {
    // Catch-all: convert any GAS runtime error (including "Invalid argument")
    // into a descriptive message with context about which file type failed.
    throw new Error(
      'uploadProxy_(' + fileType + ', ' + (originalFileName || 'unknown') + '): ' + e.message
    );
  }
}


/*
  Function: archiveOldDriveFiles_
  LAYMAN (Tropang Ex):
  Pag nagpalit ng dokumento si requestor sa isang revision, huwag na nating itapon sa Trash yung luma
  (namamatay ang link in ~30 days). Sa halip, ilipat natin sa isang "Archive" na subfolder sa loob ng
  admin vault — buhay pa rin yung file at gumagana pa yung link kahit na-supersede na.

  TECHNICAL:
  Resolves (or creates once) an "Archive" subfolder under ADMIN_FOLDER_ID and moveTo()'s each listed
  file into it. Fail-safe: if the Archive folder cannot be resolved, returns WITHOUT trashing — the
  file simply stays where it is (still referenced and resolvable). Per-file errors are swallowed.

  PARAMS:
    - fileList — array of { type, id, name, ... } identifying the Drive files to archive.
  RETURNS:   undefined (side effect: moves the listed Drive files into the Archive subfolder).
*/
function archiveOldDriveFiles_(fileList) {
  if (!fileList || fileList.length === 0) return;
  let archiveFolder = null;
  try {
    const parent = DriveApp.getFolderById(getProp_('ADMIN_FOLDER_ID'));
    const existing = parent.getFoldersByName('Archive');
    archiveFolder = existing.hasNext() ? existing.next() : parent.createFolder('Archive');
  } catch (e) {
    Logger.log('archiveOldDriveFiles_: could not resolve Archive folder, leaving files in place: ' + e.toString());
    return; // fail-safe: never trash — a mis-resolved folder must not destroy the file
  }
  fileList.forEach(function (f) {
    try { DriveApp.getFileById(f.id).moveTo(archiveFolder); }
    catch (e) { /* file already gone or inaccessible; skip */ }
  });
}

/*
  Function: archiveAndRecordSuperseded_
  LAYMAN (Tropang Ex):
  Katulong ng revision flow. Kinukuha yung mga lumang file ng type na papalitan, inaarchive yung Drive
  file nila, tinatala sila sa isang "superseded" na listahan (para makita sa trail kung ano ang
  pinalitan), tapos ibinabalik yung natitirang kasalukuyang files. Kaya ang FILE_ID cell = current set
  pa rin — walang halong luma, hindi nasisira yung existing render logic.

  TECHNICAL:
  Splits fileArr by predicate. Matches → archived + pushed to `sink` as
  { type, id, name, supersededAt, supersededRound }. Non-matches → returned as the surviving current
  list. Mirrors the old "filter out same-type" behaviour exactly (FILE_ID stays current-only), but
  archives instead of trashing and records the trail.

  PARAMS:
    - fileArr   — the working current-file array.
    - predicate — fn(file) → true for the type(s) being replaced.
    - sink      — array to push superseded records into (later stored in metadata.supersededFiles).
    - stamp     — ISO timestamp for supersededAt.
    - round     — the revision round doing the replacing (supersededRound).
  RETURNS:   the surviving current-file array (input minus the replaced entries).
*/
function archiveAndRecordSuperseded_(fileArr, predicate, sink, stamp, round) {
  const kept = [];
  const toArchive = [];
  (fileArr || []).forEach(function (f) {
    if (f && predicate(f)) {
      toArchive.push(f);
      sink.push({ type: f.type, id: f.id, name: f.name, supersededAt: stamp, supersededRound: round });
    } else {
      kept.push(f);
    }
  });
  archiveOldDriveFiles_(toArchive);
  return kept;
}

// ============================================================
// 5. DCS SUBMISSION  (The Proxy Submit)
// ============================================================

// --- Data_Collection sheet column map (1-indexed) ----------
// ORDER: LogID, ReqID, UserEmail, Status, ImmHeadEmail, DeptHeadEmail, DivHeadEmail, FileID, Metadata_JSON, Timestamp, Metadata_Agency
const DC_SHEET_NAME  = 'Data_Collection';
const DC_COL = {
  LOG_ID           : 1,   // A
  REQ_ID           : 2,   // B
  USER_EMAIL       : 3,   // C
  STATUS           : 4,   // D
  IMM_HEAD_EMAIL   : 5,   // E
  DEPT_HEAD_EMAIL  : 6,   // F
  DIV_HEAD_EMAIL   : 7,   // G
  FILE_ID          : 8,   // H
  METADATA_JSON    : 9,   // I
  TIMESTAMP        : 10,  // J
  METADATA_AGENCY  : 11   // K — JSON for Agency access type; was Remarks
};

const STATUS_PENDING       = 'PENDING';
const STATUS_READY_FOR_PIA = 'READY_FOR_PIA';
const STATUS_REJECTED      = 'REJECTED';
const STATUS_RETURNED      = 'RETURNED';
const STATUS_COMPLETE      = 'COMPLETE'; // This status means it's ready to proceed to Phase 2.

// ============================================================
// DCS Risk Audit (PIA-style flagging system)
// ============================================================
const DCS_RISK_AUDIT_SHEET = 'Risk_Audit';
// Columns: LogID | SessionID | InternalFlags | Action | UserEmail | UserAgent | Timestamp

const DCS_AUDIT_COLS = {
  LOG_ID: 1,          // A: UUID generated per entry
  SESSION_ID: 2,      // B: Session / Request identifier
  INTERNAL_FLAGS: 3,  // C: JSON payload of risk details
  ACTION: 4,          // D: Human-readable description of the event
  USER_EMAIL: 5,      // E: Current authenticated user
  USER_AGENT: 6,      // F: Hardcoded 'DCS Web App'
  TIMESTAMP: 7        // G: Locale-formatted timestamp
};

/*
  Function: submitDCS
  LAYMAN:    The heart of Phase 1 — what runs when the user hits "Submit." It double-checks the form
             on the server, uploads every attached document to the vault, writes (or updates, if this
             is a revision) the request row in the database, scans it for risk flags, clears the draft,
             and emails the requester a "Proceed to Phase 2" link. If anything important is missing or
             wrong, it returns a clear error instead of saving a broken record.
  TECHNICAL: Defense-in-depth layer 2. Re-validates domain + required fields + email formats + iHelp
             numeric + at-least-one accountable person, ALL server-side. Detects revision when a
             DCS-prefixed sessionId already exists in Data_Collection (ownership-checked). Uploads run
             BEFORE the lock (slow IO) and supersede old files via trashOldDriveFiles_. Agency/OJT
             metadata and the combined file-ID JSON are prepared before locking. Then acquires the
             SUBMISSION lock and RE-READS revision state inside it to close a TOCTOU race before
             writing. Writes status COMPLETE (cols 4-11 on update, or appendRow on insert), cleans
             drafts with the lock-free helper, builds the Phase 2 URL, releases the lock, and (outside
             the lock) batch-logs audit entries and sends the confirmation email (new submits only).
  PARAMS:
    - payload   — { formData:{ name, location, dept, access, ihelp, immHead*, deptHead*, divHead*,
                    accountable:{...} }, ndaFile?, dpaFile?, dsaFile?, agencyData? } (files: {base64,fileName,mimeType}).
    - sessionId — the DCS-XXXXXX session; if it matches an existing owned row, this is treated as a revision.
  RETURNS:   { success:true, reqId, sessionId, timestamp, phase2Url } on success;
             { success:false, error } on any validation/upload/write failure.
  EXAMPLE:   submitDCS({ formData:{ name:'Payroll access request', dept:'HR', access:'Read', immHeadName:'A',
               immHeadEmail:'a@megaworld.com', deptHeadName:'B', deptHeadEmail:'b@megaworld.com',
               accountable:{ accountableName1:'C', accountableEmail1:'c@megaworld.com' } } }, 'DCS-000007')
               -> { success:true, reqId:'DCS-000007', phase2Url:'https://…?parentID=DCS-000007' }
             Missing field -> { success:false, error:'Missing required field: dept' }
*/
function submitDCS(payload, sessionId = '') {
  /* Step 1 — Re-validate identity, payload shape, required fields, emails, iHelp, and accountable person. */
  // --- Re-validate identity on backend (Defense-in-Depth Layer 2) ---
  const email = Session.getActiveUser().getEmail();
  if (!isAuthorizedDomain_(email)) {
    return { success: false, error: 'Unauthorized domain. Access denied.' };
  }

  if (!payload || !payload.formData) {
    return { success: false, error: 'Invalid payload.' };
  }

  const form = payload.formData;

  // CRITICAL: Validate required fields on backend
  const requiredFields = ['name', 'location', 'dept', 'access', 'ihelp', 'immHeadEmail', 'immHeadName', 'deptHeadName', 'deptHeadEmail'];
  for (const field of requiredFields) {
    if (!form[field] || String(form[field]).trim() === '') {
      return { success: false, error: `Missing required field: ${field}` };
    }
  }
  
  // HIGH: Email validation on backend
  if (!isValidEmail_(form.immHeadEmail)) {
    return { success: false, error: 'Invalid Immediate Head email address.' };
  }
  if (!isValidEmail_(form.deptHeadEmail)) {
    return { success: false, error: 'Invalid Department Head email address.' };
  }
  if (form.divHeadEmail && form.divHeadEmail.trim() && !isValidEmail_(form.divHeadEmail)) {
    return { success: false, error: 'Invalid Division Head email address.' };
  }

  // MEDIUM: iHelp reference must be numeric if provided
  if (form.ihelp && String(form.ihelp).trim() !== '' && !/^\d+$/.test(String(form.ihelp).trim())) {
    return { success: false, error: 'iHelp Reference must contain only numbers.' };
  }

  // HIGH: At least 1 Accountable Person/Entity is required (both name and email must be filled)
  const accountable = form.accountable || {};
  let hasValidAccountable = false;
  for (const key in accountable) {
    if (/^accountableName\d+$/i.test(key)) {
      const idx = key.replace(/\D/g, '');
      const emailKey = 'accountableEmail' + idx;
      const name = String(accountable[key] || '').trim();
      const email = String(accountable[emailKey] || '').trim();
      if (name && email) {
        hasValidAccountable = true;
        break;
      }
    }
  }
  if (!hasValidAccountable) {
    return { success: false, error: 'At least 1 Accountable Person/Entity is required (with both name and email).' };
  }

  /* Step 2 — Resolve DB/sheet and pick the ReqID (reuse the DCS-prefixed sessionId, else mint a new one). */
  const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
  const sheet = ss.getSheetByName(DC_SHEET_NAME);
  const now   = new Date();

  // --- Generate ReqID using UUID-backed counter ---
  const reqId = (sessionId && sessionId.startsWith('DCS-')) ? sessionId : generateDCSReqId_();
  const logId = Utilities.getUuid();

  let existingRow = -1;
  let oldFileIdStr = '';
  let isRevision = false;
  let oldMetadata = {};

  // --- STEP 1: Check if revision (BEFORE lock) ---
  if (sessionId && sessionId.startsWith('DCS-')) {
    const reqIdFinder = sheet.getRange('B:B')
      .createTextFinder(sessionId)
      .matchEntireCell(true)
      .findAll();
    
    if (reqIdFinder && reqIdFinder.length > 0) {
      const row = reqIdFinder[reqIdFinder.length - 1].getRow();
      const [reqIdVal, userEmail, , , , , fileIdVal, metadataVal] = sheet.getRange(row, 2, 1, 8).getValues()[0];
      if (String(userEmail).toLowerCase() === email.toLowerCase()) {
        existingRow = row;
        oldFileIdStr = fileIdVal;
        try { oldMetadata = JSON.parse(metadataVal || '{}'); } catch(e) {}
        isRevision = true;
      } else {
        return { success: false, error: 'Unauthorized revision attempt.' };
      }
    }
  }

  // --- STEP 2: UPLOAD FILES BEFORE ACQUIRING LOCK ---
  // File uploads (3-8 seconds each) should NOT be inside lock to allow parallel submissions
  let uploadedIds  = [];

  if (oldFileIdStr) {
    try { uploadedIds = JSON.parse(oldFileIdStr); } catch(e) {}
  }

  // Commit 4: version trail — archive (not trash) replaced files and record them so the old→new
  // history stays viewable. FILE_ID keeps holding the CURRENT set only (existing renders unaffected).
  const newlySuperseded = [];
  const supersedeStamp = new Date().toISOString();
  const supersedeRound = (isRevision ? ((oldMetadata.revisionCount || 0) + 1) : 0) + 1;

  try {
    // Determine NDA/CU type based on agency data presence
    const ndaType = payload.agencyData ? 'CU' : 'NDA';
    if (payload.ndaFile && payload.ndaFile.base64) {
      const id = uploadProxy_(payload.ndaFile.base64, payload.ndaFile.fileName, ndaType, payload.ndaFile.mimeType, reqId);
      uploadedIds = archiveAndRecordSuperseded_(uploadedIds, function(f) { return f.type === 'NDA' || f.type === 'CU'; }, newlySuperseded, supersedeStamp, supersedeRound);
      uploadedIds.push({ type: ndaType, id: id, name: payload.ndaFile.fileName });
    }
    if (payload.dpaFile && payload.dpaFile.base64) {
      const id = uploadProxy_(payload.dpaFile.base64, payload.dpaFile.fileName, 'DPA', payload.dpaFile.mimeType, reqId);
      uploadedIds = archiveAndRecordSuperseded_(uploadedIds, function(f) { return f.type === 'DPA'; }, newlySuperseded, supersedeStamp, supersedeRound);
      uploadedIds.push({ type: 'DPA', id: id, name: payload.dpaFile.fileName });
    }
    if (payload.dsaFile && payload.dsaFile.base64) {
      const id = uploadProxy_(payload.dsaFile.base64, payload.dsaFile.fileName, 'DSA', payload.dsaFile.mimeType, reqId);
      uploadedIds = archiveAndRecordSuperseded_(uploadedIds, function(f) { return f.type === 'DSA'; }, newlySuperseded, supersedeStamp, supersedeRound);
      uploadedIds.push({ type: 'DSA', id: id, name: payload.dsaFile.fileName });
    }
    // Commit 5: Additional Supporting Documents — optional, ad-hoc extra files (e.g. an approver asks
    // for a document not covered by the fixed NDA/DPA/DSA/Endorsement slots). Stored as MULTIPLE
    // SUPPLEMENTARY entries (never one-per-type replaced), so they accumulate across resubmissions —
    // retained prior entries stay in uploadedIds and each newly uploaded file is appended.
    // Round-4: EXCEPT when an approver flagged a supplementary doc — then the resubmit replaces the
    // whole set (old entries archived as superseded, same as the fixed slots). Server-authoritative:
    // the flag is read from the PIA Applications sheet, not trusted from the client.
    if (isRevision && Array.isArray(payload.supplementaryFiles) && payload.supplementaryFiles.some(function (f) { return f && f.base64; })) {
      try {
        const piaRec = getPIARecordByDCSId_(ss, reqId);
        // Two independent sources so the gate fires even if one is empty at this stage:
        // (1) the now-corrected Applications read, (2) the flags PIA mirrors into DCS metadata
        // on return (oldMetadata is the current DCS row's parsed Metadata_JSON, used above).
        const flags = (piaRec && piaRec.approverFlags) ? piaRec.approverFlags : (oldMetadata.approverFlags || {});
        const hasSuppFlag = Object.keys(flags).some(function (k) { return k.indexOf('DCS - Additional Supporting Document:') === 0; });
        if (hasSuppFlag) {
          uploadedIds = archiveAndRecordSuperseded_(uploadedIds, function (f) { return f.type === 'SUPPLEMENTARY'; }, newlySuperseded, supersedeStamp, supersedeRound);
        }
      } catch (e) { Logger.log('Supplementary flag check failed (non-blocking, docs accumulate as before): ' + e.toString()); }
    }
    if (Array.isArray(payload.supplementaryFiles)) {
      for (let i = 0; i < payload.supplementaryFiles.length; i++) {
        const sf = payload.supplementaryFiles[i];
        if (sf && sf.base64) {
          // Globally-unique Drive filename suffix (counts prior SUPPLEMENTARY entries incl. retained ones).
          const existingSupp = uploadedIds.filter(function (f) { return f.type === 'SUPPLEMENTARY'; }).length;
          const sId = uploadProxy_(sf.base64, sf.fileName, 'SUPPLEMENTARY-' + (existingSupp + 1), sf.mimeType, reqId);
          uploadedIds.push({ type: 'SUPPLEMENTARY', id: sId, name: sf.fileName });
        }
      }
    }
  } catch (err) {
    return { success: false, error: 'File upload failed: ' + err.message };
  }

  // Store as JSON string so multiple file IDs fit in one cell
  const combinedFileId = uploadedIds.length > 0 ? JSON.stringify(uploadedIds) : '';

  /* Step (pre-lock) — If agency/OJT involved, validate its fields, upload the endorsement letter, and serialize its metadata. */
  // --- Build Agency Metadata if agency data is present (BEFORE lock) ---
  let agencyJson = '';
  try {
    if (payload.agencyData) {
      const ad = payload.agencyData;
      // 'OJT' and 'AGENCY' both upload a Confidentiality Undertaking + Endorsement Letter.
      // Only AGENCY requires the agency detail fields; OJT needs just the endorsement letter.
      const involvementType = String(ad.type || 'AGENCY').toUpperCase();

      // OJT requires External access (defense-in-depth; the form also forces this).
      if (involvementType === 'OJT' && String(form.access || '').trim() !== 'External') {
        return { success: false, error: 'OJT requests require External access type.' };
      }

      if (involvementType !== 'OJT') {
        // Validate required agency fields
        if (!ad.agencyName || String(ad.agencyName).trim() === '') {
          return { success: false, error: 'Agency Name is required.' };
        }
        if (!ad.agencyPersonnel || String(ad.agencyPersonnel).trim() === '') {
          return { success: false, error: 'Agency Personnel is required.' };
        }
        // Network Drive is required for agency requests (server-side parity with the form).
        if (!ad.networkDrive || String(ad.networkDrive).trim() === '') {
          return { success: false, error: 'Network Drive to Access is required for agency requests.' };
        }
        // Replacement requests must identify the person being replaced (for DCOPS).
        if (String(ad.agencyRequestType || '') === 'Replacement') {
          if (!ad.replacementFullName || String(ad.replacementFullName).trim() === '') {
            return { success: false, error: 'Full name of the person being replaced is required.' };
          }
          if (!ad.replacementEmail || String(ad.replacementEmail).trim() === '' ||
              (String(ad.replacementEmail).trim() !== 'N/A' && !isValidEmail_(ad.replacementEmail))) {
            return { success: false, error: 'A valid email of the person being replaced is required (or "N/A" if none).' };
          }
        }
        if (ad.immHeadRecoveryEmail && !isValidEmail_(ad.immHeadRecoveryEmail)) {
          return { success: false, error: 'Invalid Immediate Head Recovery Email.' };
        }
      }

      // Upload endorsement letter if provided (both AGENCY and OJT)
      let endorsementFile = null;
      if (ad.endorsementLetterFile && ad.endorsementLetterFile.base64) {
        const eId = uploadProxy_(ad.endorsementLetterFile.base64, ad.endorsementLetterFile.fileName, 'ENDORSEMENT', ad.endorsementLetterFile.mimeType, reqId);
        uploadedIds = archiveAndRecordSuperseded_(uploadedIds, function(f) { return f.type === 'ENDORSEMENT'; }, newlySuperseded, supersedeStamp, supersedeRound);
        uploadedIds.push({ type: 'ENDORSEMENT', id: eId, name: ad.endorsementLetterFile.fileName });
        endorsementFile = { id: eId, name: ad.endorsementLetterFile.fileName };
      }

      if (involvementType === 'OJT') {
        // OJT: store only the type marker + endorsement letter (no agency detail fields).
        agencyJson = JSON.stringify({
          type: 'OJT',
          endorsementLetter: endorsementFile
        });
      } else {
        // AGENCY: full detail record (unchanged shape, kept backward-compatible).
        agencyJson = JSON.stringify({
          agencyRequestType: String(ad.agencyRequestType || '').trim(),
          replacementFullName: String(ad.replacementFullName || '').trim(),
          replacementEmail: String(ad.replacementEmail || '').trim(),
          agencyName: String(ad.agencyName || '').trim(),
          agencyPersonnel: String(ad.agencyPersonnel || '').trim(),
          contractStartDate: ad.contractStartDate || '',
          endorsementLetter: endorsementFile,
          networkDrive: String(ad.networkDrive || '').trim(),
          immHeadRecoveryEmail: String(ad.immHeadRecoveryEmail || '').trim(),
          immHeadRecoveryNumber: String(ad.immHeadRecoveryNumber || '').trim()
        });
      }
    }
  } catch (err) {
    return { success: false, error: 'Agency file upload failed: ' + err.message };
  }
  const finalCombinedFileId = (payload.agencyData && uploadedIds.length > 0) ? JSON.stringify(uploadedIds) : combinedFileId;

  // Defense-in-depth: a submission must carry at least one supporting document (newly uploaded or
  // retained from a prior revision). The frontend enforces this; this is the server-side backstop.
  if (!uploadedIds || uploadedIds.length === 0) {
    return { success: false, error: 'At least one supporting document is required.' };
  }

  // --- STEP 3: NOW ACQUIRE LOCK (only for critical DB write section) ---
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.SUBMISSION);

  // ✅ FIX 3&4: Re-read revision state INSIDE the lock (eliminates TOCTOU race)
  // The pre-lock revision check (Step 1) may be stale by now.
  // Re-validate with fresh data before committing the write.
  if (sessionId && sessionId.startsWith('DCS-')) {
    const freshFinder = sheet.getRange('B:B')
      .createTextFinder(sessionId)
      .matchEntireCell(true)
      .findAll();

    if (freshFinder && freshFinder.length > 0) {
      const freshRow = freshFinder[freshFinder.length - 1].getRow();
      const freshData = sheet.getRange(freshRow, 2, 1, 8).getValues()[0];
      const freshEmail = String(freshData[1] || '').toLowerCase(); // UserEmail

      if (freshEmail === email.toLowerCase()) {
        const freshFileIdStr = String(freshData[5] || ''); // FileID
        // Only override if state changed since the pre-lock read
        if (freshRow !== existingRow || freshFileIdStr !== oldFileIdStr) {
          existingRow = freshRow;
          oldFileIdStr = freshFileIdStr;
          isRevision = true;
          try { oldMetadata = JSON.parse(freshData[6] || '{}'); } catch(e) { oldMetadata = {}; }
        }
      } else {
        // Row exists but belongs to another user — abort
        lock.releaseLock();
        return { success: false, error: 'Unauthorized revision attempt.' };
      }
    } else {
      // Row was deleted between pre-lock check and now — treat as new submission
      existingRow = -1;
      oldFileIdStr = '';
      isRevision = false;
      oldMetadata = {};
    }
  }

  /* Step 4 — Build metadata (with accountable fail-safe + risk analysis), write the row, clear drafts, build Phase 2 URL. */
  let result;
  let riskAnalysis; // Hoist to outer scope for audit trail logging below
  try {
    // Build metadata
    let accountable = form.accountable || {};

    // 🔒 Safety net: If no accountable persons were provided (shouldn't happen due to
    // frontend + backend validation, but serves as a fail-safe), auto-register the
    // requestor as the accountable person so the record is never orphaned.
    let hasValidAccountable = false;
    for (const key in accountable) {
      if (/^accountableName\d+$/i.test(key)) {
        const idx = key.replace(/\D/g, '');
        const emailKey = 'accountableEmail' + idx;
        const accName = String(accountable[key] || '').trim();
        const accEmail = String(accountable[emailKey] || '').trim();
        if (accName && accEmail) {
          hasValidAccountable = true;
          break;
        }
      }
    }
    if (!hasValidAccountable) {
      accountable = {
        accountableName1: String(form.name || '').trim() || email.split('@')[0],
        accountableEmail1: email
      };
    }

    const metadata = {
      name        : form.name        || '',
      location    : form.location    || '',
      dept        : form.dept        || '',
      access      : form.access      || '',
      ihelp       : form.ihelp       || '',
      immHeadName : form.immHeadName || '',
      immHeadEmail: form.immHeadEmail || '',
      deptHeadName: form.deptHeadName || '',
      deptHeadEmail: form.deptHeadEmail || '',
      divHeadName : form.divHeadName  || '',
      divHeadEmail: form.divHeadEmail || '',
      accountable : accountable
    };

    // --- DCS Risk Analysis (PIA-style flagging) ---
    riskAnalysis = analyzeDCSRisk_(payload, email);
    metadata.isFlagged = riskAnalysis.isFlagged;

    if (isRevision) {
      metadata.isRevised = true;
      metadata.revisionCount = (oldMetadata.revisionCount || 0) + 1;
      metadata.isEditing = false;
    } else {
      metadata.isRevised = false;
      metadata.revisionCount = 0;
      metadata.isEditing = false;
    }

    // Commit 4: carry forward the superseded-document trail and append this round's replacements.
    metadata.supersededFiles = (Array.isArray(oldMetadata.supersededFiles) ? oldMetadata.supersededFiles : []).concat(newlySuperseded);

    // ✅ STEP 4: Write to database (agencyJson and finalCombinedFileId already prepared BEFORE lock)
    if (isRevision && existingRow > 0) {
        // Batched array write — includes 8 columns (cols 4-11) to cover Metadata_Agency
        sheet.getRange(existingRow, 4, 1, 8).setValues([[
          STATUS_COMPLETE,
          form.immHeadEmail || '',
          form.deptHeadEmail || '',
          form.divHeadEmail || '',
          finalCombinedFileId,
          JSON.stringify(metadata),
          now,
          agencyJson
        ]]);
      } else {
        sheet.appendRow([
          logId,                          // A: LogID
          reqId,                          // B: ReqID
          email,                          // C: UserEmail
          STATUS_COMPLETE,                // D: Status
          form.immHeadEmail  || '',       // E: ImmediateHeadEmail
          form.deptHeadEmail || '',       // F: DeptHeadEmail
          form.divHeadEmail  || '',       // G: DivHeadEmail
          finalCombinedFileId,            // H: FileID (JSON array)
          JSON.stringify(metadata),       // I: Metadata_JSON
          now,                            // J: Timestamp
          agencyJson                      // K: Metadata_Agency
        ]);
      }

    // ✅ Clean up drafts INSIDE lock (uses lock-free helper to avoid reentrancy issues)
    if (sessionId) {
      const draftSheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
      if (draftSheet) {
        cleanupDraftsForUser_(sessionId, draftSheet, email);
      }
    }

    let phase2Url = generatePhase2Url_(reqId);
    if (isRevision) {
      phase2Url += '&revisedDCS=true';
    }    
    
    result = {
      success: true,
      reqId: reqId,
      sessionId: reqId,
      timestamp: now.toISOString(),
      phase2Url: phase2Url
    };

  } catch (err) {
    console.error('submitDCS error:', err.message, err.stack);
    try { logDCSAuditTrail_(reqId || 'unknown', 'DCS Request Failed: ' + err.message, false); } catch (e) {}
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }

  /* Step 5 — Outside the lock: batch-log audit entries and email the requester (new submits only, failsafe). */
  // --- DCS Audit Trail (OUTSIDE lock to avoid reentrancy) ---
  // Batch: Write session-gen + submission + cleanup events in a single sheet operation
  if (result && result.success) {
    const analysis = riskAnalysis || { isFlagged: false, reasons: [] };
    const hasParanormalFlags = analysis.isFlagged && analysis.reasons.length > 0;
    const internalFlagsStr = hasParanormalFlags
      ? JSON.stringify({ riskLevel: 'HIGH', reasons: analysis.reasons })
      : null;

    // Batch: Combine submission + draft cleanup into single sheet write
    // (Session generation is already logged independently by apiGenerateNewSessionId)
    const auditEntries = [
      {
        sessionId: reqId,
        action: isRevision ? 'DCS Revision Submitted' : 'DCS Request Submitted',
        flagsData: internalFlagsStr || false
      },
      {
        sessionId: reqId,
        action: 'DCS Draft Completed',
        flagsData: false
      }
    ];

    logDCSAuditTrailBatch_(auditEntries);

    // Notify the requester their request is submitted and cleared for Phase 2 (PIA).
    // New submits only; failsafe so a mail error never affects the already-saved submission.
    if (!isRevision) {
      try {
        notifyDcsRequester_(email, reqId, result.phase2Url);
      } catch (mailErr) {
        console.error('notifyDcsRequester_ failed:', mailErr.message);
        try { logDCSAuditTrail_(reqId, 'DCS Confirmation Email Failed: ' + mailErr.message, false); } catch (e) {}
      }
    }
  }

  return result;
}

/*
  Function: notifyDcsRequester_
  LAYMAN:    Sends the requester a nice branded email saying "your request was submitted — click here
             to start Phase 2." Purely a notification; if the email fails, the saved request is unaffected.
  TECHNICAL: Builds an HTML-escaped, navy-styled email (plus a plain-text fallback) with the request ID,
             a Manila-formatted timestamp, and a "Proceed to Phase 2" button. Sends via MailApp.sendEmail.
             No-ops if toEmail is falsy. Caller wraps this in try/catch (failsafe).
  PARAMS:
    - toEmail   — requester email (the Session active user).
    - reqId     — DCS Request ID shown in the email.
    - phase2Url — full PIA URL (already includes ?parentID=<reqId>); '#' fallback if empty.
  RETURNS:   undefined (side effect: sends one email).
*/
function notifyDcsRequester_(toEmail, reqId, phase2Url) {
  if (!toEmail) return;
  const safe = function(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  const accent = '#2a5285';
  const dateStr = Utilities.formatDate(new Date(), 'Asia/Manila', "MMMM d, yyyy 'at' h:mm a");
  const subject = '[Megaworld] DCS request ' + reqId + ' submitted — Proceed to Phase 2';
  const plain = 'Dear Requester,\n\n' +
    'Your Data Collection request (' + reqId + ') has been submitted successfully and is cleared to proceed to Phase 2 (Privacy Impact Assessment).\n\n' +
    'Proceed to Phase 2: ' + (phase2Url || '(open the DCS app)') + '\n\n' +
    'Submitted: ' + dateStr + '\n\n' +
    '— Megaworld ISM Department';
  const html =
    '<div style="font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;background:#f9fafb;padding:24px;color:#333;line-height:1.6;">' +
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.08);overflow:hidden;">' +
        '<div style="background:' + accent + ';padding:18px 28px;">' +
          '<div style="color:#ffffff;font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;opacity:0.9;">Megaworld ISM Department</div>' +
          '<div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">Request Submitted — Proceed to Phase 2</div>' +
        '</div>' +
        '<div style="padding:28px;">' +
          '<p style="margin:0 0 14px;font-size:14px;">Dear Requester,</p>' +
          '<p style="margin:0 0 16px;font-size:14px;">Your Data Collection request has been <strong>submitted successfully</strong> and is cleared to continue with <strong>Phase 2 (Privacy Impact Assessment)</strong>.</p>' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin:4px 0;"><tbody>' +
            '<tr><td style="padding:6px 14px 6px 0;font-weight:600;color:#6b7280;white-space:nowrap;vertical-align:top;">Request ID</td><td style="padding:6px 0;color:#1a3a5c;">' + safe(reqId) + '</td></tr>' +
            '<tr><td style="padding:6px 14px 6px 0;font-weight:600;color:#6b7280;white-space:nowrap;vertical-align:top;">Submitted</td><td style="padding:6px 0;color:#1a3a5c;">' + safe(dateStr) + '</td></tr>' +
          '</tbody></table>' +
          '<div style="margin:22px 0 4px;"><a href="' + safe(phase2Url || '#') + '" style="display:inline-block;background:' + accent + ';color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 24px;border-radius:6px;">Proceed to Phase 2 &rarr;</a></div>' +
        '</div>' +
        '<div style="padding:16px 28px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:11.5px;color:#9ca3af;">This is an automated message from the Megaworld ISM Department. Please do not reply to this email.</div>' +
      '</div></div>';
  // Commit 9: brand the From display name as the ISM Department.
  MailApp.sendEmail(toEmail, subject, plain, { htmlBody: html, name: 'Megaworld ISM Department' });
}

/*
  Function: generatePhase2Url_
  LAYMAN:    Builds the link that takes the user from Phase 1 into Phase 2 (the PIA app), tagging it
             with this request's ID so PIA knows which DCS record it belongs to.
  TECHNICAL: Reads PIA_APP_URL (should end in /exec for all-user access) and appends ?parentID=<reqId>.
             The PIA app reads parentID as Linked_ReqID — the cross-app link. Do not break this contract.
  PARAMS:
    - reqId — the DCS Request ID to embed.
  RETURNS:   The full PIA URL string, e.g. 'https://…/exec?parentID=DCS-000007'.
*/
function generatePhase2Url_(reqId) {
  const piaAppUrl = getProp_('PIA_APP_URL');
  // The /dev URL is typically only accessible by the script owner and editors.
  // For the redirect to work for all users, the production /exec URL must be used.
  // The base URL from properties should end in /exec.
  // const devUrl = piaAppUrl.replace(/\/exec$/, '/dev'); // Use for owner testing only.
  return `${piaAppUrl}?parentID=${reqId}`;
}

/*
  Function: generateDCSReqId_
  LAYMAN:    Mints the next sequential request ID (DCS-000001, DCS-000002, …) when a submission needs
             a brand-new ID rather than reusing an existing session.
  TECHNICAL: Under a script lock (SESSION timeout), reads/increments the DCS_COUNTER Script Property
             and zero-pads to 6 digits. Same read-increment-write as apiGenerateNewSessionId, which
             bumps the same counter, so it takes the same lock.

  ⚠️ CALL THIS ONLY FROM AN UNLOCKED CONTEXT. GAS script locks are NOT reentrant, so calling this
  while already holding the script lock will block until timeout. Its one caller, submitDCS (~1424),
  runs it BEFORE acquiring its own lock (~1608) — do not move that call inside submitDCS's lock.

  PARAMS:    (none)
  RETURNS:   A new ReqID string, e.g. 'DCS-000001'.
*/
function generateDCSReqId_() {
  // Without this lock two concurrent new submissions could both read the same counter and mint a
  // duplicate ReqID. The window is wide in practice: submitDCS calls this ~184 lines before it takes
  // its own lock, with the file uploads happening in between.
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.SESSION);

  try {
    const props  = PropertiesService.getScriptProperties();
    const rawNum = Number(props.getProperty(DCS_SESSION_ID_COUNTER_PROP) || 0) + 1;
    props.setProperty(DCS_SESSION_ID_COUNTER_PROP, String(rawNum));
    return 'DCS-' + String(rawNum).padStart(6, '0');
  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// 14. DCS RISK ANALYSIS & AUDIT LOGGING  (PIA-style Flagging)
// ============================================================

/*
  Function: analyzeDCSRisk_
  LAYMAN:    Scans a request for red flags before it's saved — e.g. the requester listing themselves as
             their own approver, the same person filling two approver roles, a suspiciously short
             description, no accountable person, or missing department/access. It just reports what it
             found; it doesn't block the submission.
  TECHNICAL: Pure analysis (no sheet/Drive writes). Accepts either { formData } or a flat form object.
             Runs 7 checks: requestor==any approver email (conflict of interest); immHead name==deptHead
             or ==divHead (duplicate role); name < 20 chars; zero accountable persons (handles flat and
             nested shapes); missing dept/access; and a too-short agency name. Each hit appends a
             human-readable reason.
  PARAMS:
    - dcsData       — the DCS payload ({ formData, agencyData, email } or a flat form object).
    - providedEmail — the authenticated user's email (preferred source of the requestor identity).
  RETURNS:   { isFlagged:boolean, reasons:string[] } (isFlagged === reasons.length > 0).
  EXAMPLE:   analyzeDCSRisk_({ formData:{ immHeadEmail:'me@x', deptHeadEmail:'me@x' } }, 'me@x')
               -> { isFlagged:true, reasons:['Requestor email matches Immediate Head email …', …] }
*/
function analyzeDCSRisk_(dcsData, providedEmail = '') {
  const reasons = [];
  
  if (!dcsData || typeof dcsData !== 'object') {
    return { isFlagged: false, reasons: [] };
  }

  const form = dcsData.formData || dcsData;

  // Check 1: Drafter/requestor email matches any approver email (conflict of interest)
  const requestorEmail = String(providedEmail || dcsData.email || form.email || '').toLowerCase();
  const immHeadEmail = String(form.immHeadEmail || '').toLowerCase();
  const deptHeadEmail = String(form.deptHeadEmail || '').toLowerCase();
  const divHeadEmail = String(form.divHeadEmail || '').toLowerCase();
  
  if (requestorEmail && requestorEmail === immHeadEmail) {
    reasons.push('Requestor email matches Immediate Head email — potential conflict of interest');
  }
  if (requestorEmail && requestorEmail === deptHeadEmail) {
    reasons.push('Requestor email matches Department Head email — potential conflict of interest');
  }
  if (requestorEmail && divHeadEmail && requestorEmail === divHeadEmail) {
    reasons.push('Requestor email matches Division Head email — potential conflict of interest');
  }

  // Check 2: Immediate Head name == Department Head name (same person in two roles)
  const immHeadName = String(form.immHeadName || '').trim().toLowerCase();
  const deptHeadName = String(form.deptHeadName || '').trim().toLowerCase();
  const divHeadName = String(form.divHeadName || '').trim().toLowerCase();
  
  if (immHeadName && deptHeadName && immHeadName === deptHeadName) {
    reasons.push('Immediate Head name matches Department Head name — same person in 2 approval roles');
  }
  
  // Check 3: Immediate Head name == Division Head name
  if (immHeadName && divHeadName && immHeadName === divHeadName) {
    reasons.push('Immediate Head name matches Division Head name — same person in 2 approval roles');
  }

  // Check 4: Request name/description is unusually short (< 20 chars)
  const requestName = String(form.name || '').trim();
  if (requestName && requestName.length < 20) {
    reasons.push('Request description is suspiciously short (' + requestName.length + ' characters)');
  }

  // Check 5: No accountable persons defined when required
  // Handles two data formats:
  //   Flat:  { accountableName1: 'Name', accountableEmail1: 'Email' }
  //   Object:{ accountable1: { name: 'Name', email: 'Email' } }
  const accountable = form.accountable || {};
  const accountableNames = [];
  for (const key in accountable) {
    if (typeof accountable[key] === 'object' && accountable[key] && accountable[key].name) {
      accountableNames.push(accountable[key].name);
    } else if (/^accountableName\d+$/i.test(key) && accountable[key]) {
      // Flat format: key = "accountableName1", value = "Pedro Penduko"
      accountableNames.push(accountable[key]);
    }
  }
  if (accountableNames.length === 0) {
    reasons.push('No accountable persons defined for data processing');
  }

  // Check 6: Suspicious metadata patterns — missing department or access type
  const dept = String(form.dept || '').trim();
  const access = String(form.access || '').trim();
  if (!dept) {
    reasons.push('Missing department information');
  }
  if (!access) {
    reasons.push('Missing access type information');
  }

  // Check 7: Agency fields with suspicious patterns
  const agencyData = dcsData.agencyData || {};
  if (agencyData && typeof agencyData === 'object') {
    const agencyName = String(agencyData.agencyName || '').trim();
    if (agencyName && agencyName.length < 5) {
      reasons.push('Agency name is unusually short (' + agencyName.length + ' characters)');
    }
  }

  return {
    isFlagged: reasons.length > 0,
    reasons: reasons
  };
}

/*
  Function: logDCSAuditTrail_
  LAYMAN:    Writes one line into the audit log for an action (draft saved, request submitted, etc.).
             If the action carried risk flags it stores them; normal actions store an empty marker.
             It never throws — a logging failure must not break the real operation.
  TECHNICAL: Appends a row to Risk_Audit (falls back to legacy 'DCS_Risk_Audit' name). Builds the
             InternalFlags cell from flagsData: a non-empty string is stored verbatim (flagged JSON),
             true → generic HIGH legacy marker, false/null/undefined → '{}' (normal). Stamps LogID
             (UUID), user email, 'DCS Web App' agent, and a native Date. Errors are caught and logged.
  PARAMS:
    - sessionId — session/request identifier for the event.
    - action    — human-readable description of the event.
    - flagsData — string (flagged JSON) | true (legacy HIGH) | false/null/undefined (normal).
  RETURNS:   undefined (side effect: appends one audit row; swallows its own errors).
*/
function logDCSAuditTrail_(sessionId, action, flagsData) {
  try {
    const ss = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DCS_RISK_AUDIT_SHEET) || ss.getSheetByName('DCS_Risk_Audit');
    if (!sheet) {
      Logger.log('[DCS-AUDIT-WARN] Risk_Audit sheet unavailable for: ' + sessionId + ': ' + action);
      return;
    }

    const logId = Utilities.getUuid();
    const userEmail = Session.getActiveUser().getEmail() || 'anonymous';
    const now = new Date();

    // Build flags payload — if flagsData is false/null/undefined (normal action), store empty object
    let flags = '{}';
    if (typeof flagsData === 'string' && flagsData.length > 0) {
      flags = flagsData;  // Paranormal: actual risk data
    } else if (flagsData === true) {
      flags = JSON.stringify({ riskLevel: 'HIGH', reason: 'Legacy flag trigger' });
    }
    // flagsData === false/null/undefined → flags stays '{}' (normal action, no anomalies)

    sheet.appendRow([
      logId,              // A: LogID
      sessionId || 'N/A', // B: SessionID
      flags,              // C: InternalFlags — '{}' for normal, filled JSON for paranormal
      action,             // D: Action
      userEmail,          // E: UserEmail
      'DCS Web App',      // F: UserAgent
      now                 // G: Timestamp (Native Date object for Sheets)
    ]);

    if (flags !== '{}') {
      Logger.log('[DCS-AUDIT-FLAG] ' + sessionId + ': ' + action + ' — Paranormal: ' + flags);
    } else {
      Logger.log('[DCS-AUDIT] ' + sessionId + ': ' + action);
    }
  } catch (err) {
    Logger.log('[DCS-AUDIT-ERROR] Error logging DCS audit trail: ' + err.toString());
  }
}

/*
  Function: logDCSAuditTrailBatch_
  LAYMAN:    Same idea as logDCSAuditTrail_ but writes several audit lines at once (e.g. "submitted" +
             "draft completed") in a single trip to the sheet, which is faster.
  TECHNICAL: Maps each entry to a Risk_Audit row (same flags encoding as logDCSAuditTrail_) and writes
             them all with one getRange(start,1,n,7).setValues() call. No-ops on empty input; errors
             are caught and logged so it never breaks the caller.
  PARAMS:
    - entries — array of { sessionId, action, flagsData } (flagsData encoded as in logDCSAuditTrail_).
  RETURNS:   undefined (side effect: appends N audit rows in one write).
*/
function logDCSAuditTrailBatch_(entries) {
  if (!entries || entries.length === 0) return;
  try {
    const ss = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DCS_RISK_AUDIT_SHEET) || ss.getSheetByName('DCS_Risk_Audit');
    if (!sheet) {
      Logger.log('[DCS-AUDIT-WARN] Risk_Audit sheet unavailable for batch write');
      return;
    }

    const userEmail = Session.getActiveUser().getEmail() || 'anonymous';
    const rows = entries.map(function(e) {
      let flags = '{}';
      if (typeof e.flagsData === 'string' && e.flagsData.length > 0) {
        flags = e.flagsData;
      } else if (e.flagsData === true) {
        flags = JSON.stringify({ riskLevel: 'HIGH', reason: 'Legacy flag trigger' });
      }
      return [
        Utilities.getUuid(),       // A: LogID
        e.sessionId || 'N/A',      // B: SessionID
        flags,                     // C: InternalFlags
        e.action,                  // D: Action
        userEmail,                 // E: UserEmail
        'DCS Web App',             // F: UserAgent
        new Date()                 // G: Timestamp
      ];
    });

    // Batch write — single API call for all entries
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 7).setValues(rows);

    Logger.log('[DCS-AUDIT-BATCH] Wrote ' + rows.length + ' audit entries in 1 batch call');
  } catch (err) {
    Logger.log('[DCS-AUDIT-ERROR] Batch audit write failed: ' + err.toString());
  }
}

// ============================================================
// 6. HANDLING APPROVER INFORMATION (Metadata Collection Only)
// ============================================================

// Approver information is collected and stored as metadata but no automated
// approval workflow or email notifications are performed.


// ============================================================
// 7. LEGACY APPROVAL CALLBACK (REMOVED)
// ============================================================

// All approval decision handling has been removed as the system
// no longer sends email approval requests or processes approvals.


// ============================================================
// Fix 2: Batch Query Consolidation — Helper function
// Fetches all related data for a DCS request in optimized batch.
// ============================================================

/*
  Function: getRequestDataBatch_
  LAYMAN:    Gathers, in one efficient sweep, everything Phase 2 knows about a request: the linked PIA
             record and all the approval decisions (regular approvers, InfoSec/ISM members, and the
             Division Head). Used to build the request's status timelines.
  TECHNICAL: Consolidated read across four PIA-owned sheets (Applications, Approval_Workflow,
             ISM_Approval_Workflow, DivisionHead_Approval_Workflow). Resolves columns dynamically via a
             header-index map (so column order can change safely) and locates rows with TextFinder on
             the relevant key columns, then batch-reads matched ranges. Discovers piaSessionId from the
             Applications row when not passed in. Read-only.
  PARAMS:
    - ss           — the database Spreadsheet object.
    - dcsReqId     — the DCS Request ID (matched against Linked_ReqID / ReqID).
    - piaSessionId — optional PIA session ID; auto-discovered from Applications if omitted.
  RETURNS:   { piaRecord:{piaSessionId,piaStatus,approverFlags,approverComments}|null,
               approvals:[], ismApprovals:[], divHeadApprovals:[] }.
*/
function getRequestDataBatch_(ss, dcsReqId, piaSessionId) {
  const batch = {
    piaRecord: null,
    approvals: [],
    ismApprovals: [],
    divHeadApprovals: []
  };

  /*
    Function: getColIndexMap_ (nested helper)
    LAYMAN:    Reads a sheet's header row and makes a quick lookup of "column name → which column it is."
    TECHNICAL: Returns an object mapping each non-empty trimmed header string to its 0-based index.
    PARAMS:
      - sheet — the Sheet whose header row (row 1) to map.
    RETURNS:   { headerName: columnIndex, ... } (0-based indices).
  */
  function getColIndexMap_(sheet) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const map = {};
    headers.forEach(function(h, i) { if (h) map[String(h).trim()] = i; });
    return map;
  }

  /* Step 1 — Applications sheet: find the row linked to this DCS ReqID; capture PIA status/flags/comments and the PIA session ID. */
  // --- Process PIA record from Applications sheet (TextFinder) ---
  const appSheet = ss.getSheetByName('Applications');
  if (appSheet && dcsReqId) {
    const appCols = getColIndexMap_(appSheet);
    const linkedReqIdCol = appCols['Linked_ReqID'];
    const statusCol = appCols['Status'];
    const sessionIdCol = appCols['SessionID'];
    const flagsCol = appCols['Approver_Flags'] !== undefined ? appCols['Approver_Flags'] : appCols['Approvers_Flag'];
    const commentsCol = appCols['Approver_Comments'] !== undefined ? appCols['Approver_Comments'] : appCols['Comments'];

    if (linkedReqIdCol !== undefined && statusCol !== undefined) {
      // Find the column letter for Linked_ReqID (0-based → 1-based → letter)
      const linkedColLetter = String.fromCharCode(65 + linkedReqIdCol);
      const finder = appSheet.getRange(linkedColLetter + ':' + linkedColLetter)
        .createTextFinder(String(dcsReqId))
        .matchEntireCell(true)
        .findAll();

      if (finder && finder.length > 0) {
        const lastMatch = finder[finder.length - 1];
        const rowData = appSheet.getRange(lastMatch.getRow(), 1, 1, appSheet.getLastColumn()).getValues()[0];

        const piaSessionIdFound = sessionIdCol !== undefined ? rowData[sessionIdCol] : null;
        const piaStatus = rowData[statusCol];
        let approverFlags = null;
        if (flagsCol !== undefined) {
          try { approverFlags = rowData[flagsCol] ? JSON.parse(rowData[flagsCol]) : null; } catch (e) { approverFlags = null; }
        }
        let approverComments = null;
        if (commentsCol !== undefined) {
          approverComments = rowData[commentsCol] || null;
        }
        batch.piaRecord = { piaSessionId: piaSessionIdFound, piaStatus: piaStatus, approverFlags: approverFlags, approverComments: approverComments };
        if (!piaSessionId) piaSessionId = piaSessionIdFound;
      }
    }
  }

  /* Step 2 — Approval_Workflow: collect approver decisions matched by PIA session and/or DCS ReqID (deduped, batch-read). */
  // --- Process Approval_Workflow (TextFinder) ---
  const awSheet = ss.getSheetByName('Approval_Workflow');
  if (awSheet && (piaSessionId || dcsReqId)) {
    const awCols = getColIndexMap_(awSheet);
    const sessionCol = awCols['SessionID'];
    const reqCol = awCols['ReqID'];
    const emailCol = awCols['ApproverEmail'];
    const nameCol = awCols['ApproverName'];
    const decisionCol = awCols['Decision'];
    const commentCol = awCols['Comments'];
    const dateCol = awCols['DecisionDate'];
    const lastCol = awSheet.getLastColumn();

    // Collect matched row numbers using TextFinder (deduplicated via Set)
    const matchedRows = new Set();
    if (piaSessionId && sessionCol !== undefined) {
      const sessionColLetter = String.fromCharCode(65 + sessionCol);
      const matches = awSheet.getRange(sessionColLetter + ':' + sessionColLetter)
        .createTextFinder(String(piaSessionId))
        .matchEntireCell(true)
        .findAll();
      matches.forEach(function(m) { matchedRows.add(m.getRow()); });
    }
    if (dcsReqId && reqCol !== undefined) {
      const reqColLetter = String.fromCharCode(65 + reqCol);
      const matches = awSheet.getRange(reqColLetter + ':' + reqColLetter)
        .createTextFinder(String(dcsReqId))
        .matchEntireCell(true)
        .findAll();
      matches.forEach(function(m) { matchedRows.add(m.getRow()); });
    }

    if (matchedRows.size > 0) {
      // Fetch all matched rows in a single batch
      const sortedRows = Array.from(matchedRows).sort(function(a, b) { return a - b; });
      const batchData = awSheet.getRange(sortedRows[0], 1, sortedRows[sortedRows.length - 1] - sortedRows[0] + 1, lastCol).getValues();
      const offset = sortedRows[0];

      sortedRows.forEach(function(row) {
        const d = batchData[row - offset];
        const aEmail = emailCol !== undefined ? String(d[emailCol]).toLowerCase() : '';
        const aDec = decisionCol !== undefined ? d[decisionCol] : '';
        const aCom = commentCol !== undefined ? d[commentCol] : '';
        const aDate = dateCol !== undefined && d[dateCol] ? String(d[dateCol]) : '';

        batch.approvals.push({
          name: nameCol !== undefined ? d[nameCol] : aEmail,
          email: aEmail,
          decision: aDec,
          comment: aCom,
          date: aDate,
          role: decisionCol !== undefined ? (aDec ? 'Approver' : 'Reviewer') : 'Reviewer'
        });
      });
    }
  }

  /* Step 3 — ISM_Approval_Workflow + DivisionHead_Approval_Workflow: collect InfoSec and Division Head decisions (only when a PIA session exists). */
  // --- Process ISM_Approval_Workflow (TextFinder) ---
  if (piaSessionId) {
    const ismSheet = ss.getSheetByName('ISM_Approval_Workflow');
    if (ismSheet) {
      const ismCols = getColIndexMap_(ismSheet);
      const sessionCol = ismCols['SessionID'];
      const nameCol = ismCols['ISM_Member_Name'];
      const emailCol = ismCols['ISM_Member_Email'];
      const decisionCol = ismCols['Decision'];
      const statusCol = ismCols['Status'];
      const commentCol = ismCols['Comments'];
      const dateCol = ismCols['DecisionDate'];
      const lastCol = ismSheet.getLastColumn();

      if (sessionCol !== undefined) {
        const sessionColLetter = String.fromCharCode(65 + sessionCol);
        const matches = ismSheet.getRange(sessionColLetter + ':' + sessionColLetter)
          .createTextFinder(String(piaSessionId))
          .matchEntireCell(true)
          .findAll();

        if (matches && matches.length > 0) {
          const sortedRows = matches.map(function(m) { return m.getRow(); }).sort(function(a, b) { return a - b; });
          const batchData = ismSheet.getRange(sortedRows[0], 1, sortedRows[sortedRows.length - 1] - sortedRows[0] + 1, lastCol).getValues();
          const offset = sortedRows[0];

          sortedRows.forEach(function(row) {
            const d = batchData[row - offset];
            const aDate = dateCol !== undefined && d[dateCol] ? String(d[dateCol]) : '';
            batch.ismApprovals.push({
              name: nameCol !== undefined ? d[nameCol] : '',
              email: emailCol !== undefined ? d[emailCol] : '',
              decision: decisionCol !== undefined ? d[decisionCol] : '',
              status: statusCol !== undefined ? d[statusCol] : '',
              comment: commentCol !== undefined ? d[commentCol] : '',
              date: aDate,
              role: 'InfoSec Member'
            });
          });
        }
      }
    }

    // --- Process DivisionHead_Approval_Workflow (TextFinder) ---
    const divHeadSheet = ss.getSheetByName('DivisionHead_Approval_Workflow');
    if (divHeadSheet) {
      const dhCols = getColIndexMap_(divHeadSheet);
      const sessionCol = dhCols['SessionID'];
      const emailCol = dhCols['DivHead_Email'];
      const decisionCol = dhCols['Decision'];
      const statusCol = dhCols['Status'];
      const commentCol = dhCols['Comments'];
      const dateCol = dhCols['DecisionDate'];
      const lastCol = divHeadSheet.getLastColumn();

      if (sessionCol !== undefined) {
        const sessionColLetter = String.fromCharCode(65 + sessionCol);
        const matches = divHeadSheet.getRange(sessionColLetter + ':' + sessionColLetter)
          .createTextFinder(String(piaSessionId))
          .matchEntireCell(true)
          .findAll();

        if (matches && matches.length > 0) {
          const sortedRows = matches.map(function(m) { return m.getRow(); }).sort(function(a, b) { return a - b; });
          const batchData = divHeadSheet.getRange(sortedRows[0], 1, sortedRows[sortedRows.length - 1] - sortedRows[0] + 1, lastCol).getValues();
          const offset = sortedRows[0];

          sortedRows.forEach(function(row) {
            const d = batchData[row - offset];
            const aDate = dateCol !== undefined && d[dateCol] ? String(d[dateCol]) : '';
            batch.divHeadApprovals.push({
              name: emailCol !== undefined ? d[emailCol] : '',
              email: emailCol !== undefined ? d[emailCol] : '',
              decision: decisionCol !== undefined ? d[decisionCol] : '',
              status: statusCol !== undefined ? d[statusCol] : '',
              comment: commentCol !== undefined ? d[commentCol] : '',
              date: aDate,
              role: 'Division Head'
            });
          });
        }
      }
    }
  }

  return batch;
}

/*
  Function: getPIARecordByDCSId_
  LAYMAN:    Looks up the Phase 2 (PIA) record that belongs to a given Phase 1 request, plus its latest
             approval decision — so the UI can show whether PIA has acted on it.
  TECHNICAL: TextFinder on Applications col B for dcsReqId, taking the LAST match (most recent revision);
             reads Status / SessionID / Approver_Flags (or legacy Approvers_Flag) / Approver_Comments
             (or legacy Comments) via dynamic header indices. Then finds the latest Decision in
             Approval_Workflow by PIA SessionID (preferred) or DCS ReqID. Read-only.
  PARAMS:
    - ss       — the database Spreadsheet object.
    - dcsReqId — the DCS Request ID to resolve.
  RETURNS:   { piaSessionId, piaStatus, piaDecision, approverFlags, approverComments } if anything found;
             null if no related PIA data exists.
*/
function getPIARecordByDCSId_(ss, dcsReqId) {
  const sheet = ss.getSheetByName('Applications'); // From db_schema.md
  let piaSessionId = null;
  let piaStatus = null;
  let piaDecision = null;
  let approverFlags = null;
  let approverComments = null;

  if (sheet) {
    // Bugfix: search the Linked_ReqID column, not a hardcoded 'B:B'. In the Applications sheet
    // column B is the Applicant Email, so the DCS ReqID never matched and this returned an empty
    // record, which silently skipped the supplementary-archive gate in submitDCS. Mirrors the
    // healthy sibling getRequestDataBatch_. Falls back to 'B:B' only if the header is missing.
    const _hdrsForSearch = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const _linkedColForSearch = _hdrsForSearch.indexOf('Linked_ReqID');
    const _searchRange = _linkedColForSearch !== -1
      ? sheet.getRange(String.fromCharCode(65 + _linkedColForSearch) + ':' + String.fromCharCode(65 + _linkedColForSearch))
      : sheet.getRange('B:B');
    const finder = _searchRange
      .createTextFinder(String(dcsReqId))
      .matchEntireCell(true)
      .findAll();

    if (finder && finder.length > 0) {
      // Get the LAST match (most recent revision)
      const lastMatchRange = finder[finder.length - 1];
      const row = lastMatchRange.getRow();
      
      // Get header row to find column indices
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const linkedReqIdCol = headers.indexOf('Linked_ReqID');
      const statusCol = headers.indexOf('Status');
      const sessionIdCol = headers.indexOf('SessionID');
      let flagsCol = headers.indexOf('Approver_Flags');
      if (flagsCol === -1) flagsCol = headers.indexOf('Approvers_Flag');
      let commentsCol = headers.indexOf('Approver_Comments');
      if (commentsCol === -1) commentsCol = headers.indexOf('Comments'); // Fallback
      
      // Get only the matched row
      if (linkedReqIdCol !== -1 && statusCol !== -1) {
        const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
        
        piaSessionId = rowData[sessionIdCol] || null;
        piaStatus = rowData[statusCol] || null;
        if (flagsCol !== -1) {
          try {
            approverFlags = rowData[flagsCol] ? JSON.parse(rowData[flagsCol]) : null;
          } catch (e) {
            approverFlags = null;
          }
        }
        if (commentsCol !== -1) {
          approverComments = rowData[commentsCol] || null;
        }
      }
    }
  }

  // Check Approval_Workflow dataset for decisions
  const awSheet = ss.getSheetByName('Approval_Workflow');
  if (awSheet && (piaSessionId || dcsReqId)) {
    // Try finding by SessionID first, then by ReqID
    let awFinder = null;
    
    if (piaSessionId) {
      awFinder = awSheet.getRange('C:C')
        .createTextFinder(String(piaSessionId))
        .matchEntireCell(true)
        .findAll();
    }
    
    if (!awFinder || awFinder.length === 0) {
      awFinder = awSheet.getRange('B:B')
        .createTextFinder(String(dcsReqId))
        .matchEntireCell(true)
        .findAll();
    }
    
    if (awFinder && awFinder.length > 0) {
      // Get the LAST match (most recent decision)
      const lastMatch = awFinder[awFinder.length - 1];
      const awRow = lastMatch.getRow();
      
      const awHeaders = awSheet.getRange(1, 1, 1, awSheet.getLastColumn()).getValues()[0];
      const decisionCol = awHeaders.indexOf('Decision');
      
      if (decisionCol !== -1) {
        const awRowData = awSheet.getRange(awRow, 1, 1, awSheet.getLastColumn()).getValues()[0];
        piaDecision = awRowData[decisionCol] || null;
      }
    }
  }

  if (piaSessionId || piaStatus || piaDecision || approverFlags || approverComments) {
    return { piaSessionId, piaStatus, piaDecision, approverFlags, approverComments };
  }
  return null;
}

/*
  Function: getApproversList_
  LAYMAN:    Builds the list of approvers for a request — seeded from the form's Immediate Head and
             Department Head, then enriched with any actual decisions/comments recorded in the workflow.
  TECHNICAL: Starts with the Immediate Head and Department Head from metadata (decision 'Pending'),
             then scans Approval_Workflow (matched by reqId or piaSessionId via header-resolved columns).
             Existing approvers are updated in place by email match; unknown decision-makers are appended
             as 'Reviewer'. Loads the workflow via getDataRange (full scan). Read-only.
  PARAMS:
    - ss           — the database Spreadsheet object.
    - reqId        — the DCS Request ID.
    - piaSessionId — optional PIA session ID to also match on.
    - metadata     — DCS metadata containing the Immediate Head and Department Head name/email.
  RETURNS:   Array of { name, email, decision, comment, date, role } approver objects.
*/
function getApproversList_(ss, reqId, piaSessionId, metadata) {
  const approvers = [];
  if (metadata.immHeadName) approvers.push({ name: metadata.immHeadName, email: metadata.immHeadEmail, decision: 'Pending', comment: '', role: 'Immediate Head', date: '' });
  if (metadata.deptHeadName) approvers.push({ name: metadata.deptHeadName, email: metadata.deptHeadEmail, decision: 'Pending', comment: '', role: 'Department Head', date: '' });

  const awSheet = ss.getSheetByName('Approval_Workflow');
  if (awSheet) {
    const awData = awSheet.getDataRange().getValues();
    if (awData.length > 0) {
      const awHeaders = awData[0];
      const sessionCol = awHeaders.indexOf('SessionID');
      const reqCol = awHeaders.indexOf('ReqID');
      const emailCol = awHeaders.indexOf('ApproverEmail');
      const nameCol = awHeaders.indexOf('ApproverName');
      const decisionCol = awHeaders.indexOf('Decision');
      const commentCol = awHeaders.indexOf('Comments');
      const dateCol = awHeaders.indexOf('DecisionDate');

      for (let i = 1; i < awData.length; i++) {
        const rSession = sessionCol !== -1 ? String(awData[i][sessionCol]) : '';
        const rReq = reqCol !== -1 ? String(awData[i][reqCol]) : '';
        
        if (rSession === String(reqId) || rReq === String(reqId) || (piaSessionId && rSession === String(piaSessionId))) {
          const aEmail = emailCol !== -1 ? String(awData[i][emailCol]).toLowerCase() : '';
          const aDec = decisionCol !== -1 ? awData[i][decisionCol] : '';
          const aCom = commentCol !== -1 ? awData[i][commentCol] : '';
          const aDate = dateCol !== -1 && awData[i][dateCol] ? String(awData[i][dateCol]) : '';
          
          const match = approvers.find(a => a.email && a.email.toLowerCase() === aEmail);
          if (match) {
            if (aDec) match.decision = aDec;
            if (aCom) match.comment = aCom;
            if (aDate) match.date = aDate;
          } else if (aEmail) {
            approvers.push({
              name: nameCol !== -1 ? awData[i][nameCol] : aEmail,
              email: aEmail,
              decision: aDec,
              comment: aCom,
              date: aDate,
              role: 'Reviewer'
            });
          }
        }
      }
    }
  }
  return approvers;
}

/*
  Function: getISMApproversList_
  LAYMAN:    Builds the InfoSec (ISM) reviewers list for a request's Phase 2 timeline.
  TECHNICAL: Returns [] when piaSessionId is falsy. Scans ISM_Approval_Workflow (full getDataRange),
             matching rows by SessionID via header-resolved columns. Read-only.
  PARAMS:
    - ss           — the database Spreadsheet object.
    - piaSessionId — the PIA session ID to match.
  RETURNS:   Array of { name, email, decision, status, comment, date, role:'InfoSec Member' } objects.
*/
function getISMApproversList_(ss, piaSessionId) {
  const approvers = [];
  if (!piaSessionId) return approvers;
  
  const sheet = ss.getSheetByName('ISM_Approval_Workflow');
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    if (data.length > 0) {
      const headers = data[0];
      const sessionCol = headers.indexOf('SessionID');
      const nameCol = headers.indexOf('ISM_Member_Name');
      const emailCol = headers.indexOf('ISM_Member_Email');
      const decisionCol = headers.indexOf('Decision');
      const statusCol = headers.indexOf('Status');
      const commentCol = headers.indexOf('Comments');
      const dateCol = headers.indexOf('DecisionDate');

      if (sessionCol !== -1) {
        for (let i = 1; i < data.length; i++) {
          if (String(data[i][sessionCol]) === String(piaSessionId)) {
            const aDate = dateCol !== -1 && data[i][dateCol] ? String(data[i][dateCol]) : '';
            approvers.push({
              name: nameCol !== -1 ? data[i][nameCol] : '',
              email: emailCol !== -1 ? data[i][emailCol] : '',
              decision: decisionCol !== -1 ? data[i][decisionCol] : '',
              status: statusCol !== -1 ? data[i][statusCol] : '',
              comment: commentCol !== -1 ? data[i][commentCol] : '',
              date: aDate,
              role: 'InfoSec Member'
            });
          }
        }
      }
    }
  }
  return approvers;
}

/*
  Function: getDivHeadApproversList_
  LAYMAN:    Builds the Division Head reviewers list for a request's Phase 2 timeline.
  TECHNICAL: Returns [] when piaSessionId is falsy. Scans DivisionHead_Approval_Workflow (full
             getDataRange), matching rows by SessionID via header-resolved columns. The DivHead_Email
             is used for both name and email fields. Read-only.
  PARAMS:
    - ss           — the database Spreadsheet object.
    - piaSessionId — the PIA session ID to match.
  RETURNS:   Array of { name, email, decision, status, comment, date, role:'Division Head' } objects.
*/
function getDivHeadApproversList_(ss, piaSessionId) {
  const approvers = [];
  if (!piaSessionId) return approvers;
  
  const sheet = ss.getSheetByName('DivisionHead_Approval_Workflow');
  if (sheet) {
    const data = sheet.getDataRange().getValues();
    if (data.length > 0) {
      const headers = data[0];
      const sessionCol = headers.indexOf('SessionID');
      const emailCol = headers.indexOf('DivHead_Email');
      const decisionCol = headers.indexOf('Decision');
      const statusCol = headers.indexOf('Status');
      const commentCol = headers.indexOf('Comments');
      const dateCol = headers.indexOf('DecisionDate');

      if (sessionCol !== -1) {
        for (let i = 1; i < data.length; i++) {
          if (String(data[i][sessionCol]) === String(piaSessionId)) {
            const aDate = dateCol !== -1 && data[i][dateCol] ? String(data[i][dateCol]) : '';
            approvers.push({
              name: emailCol !== -1 ? data[i][emailCol] : '',
              email: emailCol !== -1 ? data[i][emailCol] : '',
              decision: decisionCol !== -1 ? data[i][decisionCol] : '',
              status: statusCol !== -1 ? data[i][statusCol] : '',
              comment: commentCol !== -1 ? data[i][commentCol] : '',
              date: aDate,
              role: 'Division Head'
            });
          }
        }
      }
    }
  }
  return approvers;
}

/*
  Function: apiGetRequestData
  LAYMAN:    The "show me everything about this request" call the frontend uses to draw a request's
             detail page: the form data, attached files, current status, the Phase 2 link (if eligible),
             PIA status, and the full approver timelines — plus any DCS vs PIA risk flags.
  TECHNICAL: TextFinder on Data_Collection col B (last match = newest revision); reads only that row,
             parses Metadata_JSON / FileID / Metadata_Agency. Pulls linked PIA + all approval rows via
             getRequestDataBatch_. Separates DCS-prefixed flag keys from PIA flag keys. Computes the
             Phase 2 URL when status is READY_FOR_PIA/COMPLETE/RETURNED. Read-only.
  PARAMS:
    - reqId — the DCS Request ID to fetch.
  RETURNS:   { found:true, reqId, sessionId, email, immHeadEmail, deptHeadEmail, divHeadEmail, status,
               metadata, files, timestamp, logId, metadataAgency, phase2Url, piaStatus, piaSessionId,
               piaDecision, hasPiaFlags, approverFlags, approverComments, approvers, ismApprovers,
               divHeadApprovers } on success; { found:false } if missing; { found:false, error } on error.
*/
/*
  Function: getRevisionHistoryRows_
  LAYMAN (Tropang Ex):
  Binabasa nito yung "Revision_History" logbook tab na sinusulatan ng PIA app tuwing may
  return-and-resubmit, para maipakita sa requestor ang KUMPLETONG kwento ng approvals (lahat ng
  rounds), hindi lang yung kasalukuyang round na nasa workflow sheets.

  TECHNICAL:
  Pure additive READ of the PIA-owned 'Revision_History' sheet in the same DB_ID spreadsheet.
  Keyed by the PIA session id (NOT the DCS reqId). Local column map mirrors pia_code.js's
  REVISION_HISTORY_COLS — pia_code.js owns the schema; keep in sync if it ever changes.
  Null-guarded + try/catch: returns [] when the tab is missing, empty, or unreadable.

  PARAMS:
    - ss           — the database Spreadsheet object.
    - piaSessionId — the linked PIA session id ('' or null returns []).
  RETURNS: Array of { round, decisions:[{stage, approverName, approverEmail, role, decision,
           status, comments, flaggedFields, routing, decisionDate}] }, rounds ascending.
*/
function getRevisionHistoryRows_(ss, piaSessionId) {
  try {
    const sid = String(piaSessionId || '').trim();
    if (!sid) return [];
    const sheet = ss.getSheetByName('Revision_History');
    if (!sheet || sheet.getLastRow() < 2) return [];
    // Mirrors pia_code.js REVISION_HISTORY_COLS (1-based) — pia_code.js owns this schema.
    const COL = { SESSION_ID: 2, ROUND_NUMBER: 3, STAGE: 4, APPROVER_NAME: 5, APPROVER_EMAIL: 6,
                  ROLE: 7, DECISION: 8, STATUS: 9, COMMENTS: 10, FLAGGED_FIELDS: 11, ROUTING: 12,
                  DECISION_DATE: 13 };
    const data = sheet.getDataRange().getValues();
    const byRound = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[COL.SESSION_ID - 1] || '').trim() !== sid) continue;
      const round = Number(row[COL.ROUND_NUMBER - 1] || 0);
      if (!byRound[round]) byRound[round] = { round: round, decisions: [] };
      let flags = {};
      try { flags = JSON.parse(row[COL.FLAGGED_FIELDS - 1] || '{}'); } catch (e) { flags = {}; }
      byRound[round].decisions.push({
        stage: row[COL.STAGE - 1] || '',
        approverName: row[COL.APPROVER_NAME - 1] || '',
        approverEmail: row[COL.APPROVER_EMAIL - 1] || '',
        role: row[COL.ROLE - 1] || '',
        decision: row[COL.DECISION - 1] || '',
        status: row[COL.STATUS - 1] || '',
        comments: row[COL.COMMENTS - 1] || '',
        flaggedFields: flags,
        routing: row[COL.ROUTING - 1] || '',
        decisionDate: row[COL.DECISION_DATE - 1] ? String(row[COL.DECISION_DATE - 1]) : ''
      });
    }
    return Object.keys(byRound).map(function (k) { return byRound[k]; })
      .sort(function (a, b) { return a.round - b.round; });
  } catch (e) {
    Logger.log('getRevisionHistoryRows_ failed (non-blocking): ' + e.message);
    return [];
  }
}

function apiGetRequestData(reqId) {
  try {
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DC_SHEET_NAME);
    
    // ✅ Fix 1 & 2: Use TextFinder.findAll() to get ALL matches, then use the LAST (most recent) match
    // This prevents race conditions when multiple revisions exist with same ReqID
    const finder = sheet.getRange('B:B')
      .createTextFinder(String(reqId))
      .matchEntireCell(true)
      .findAll();

    if (!finder || finder.length === 0) return { found: false };
    
    // Get the LAST match (most recent revision)
    const lastMatchRange = finder[finder.length - 1];
    const row = lastMatchRange.getRow();
    // Get only needed row data (1 API call instead of full sheet load)
    const values = sheet.getRange(row, 1, 1, Math.max(DC_COL.METADATA_AGENCY, 11)).getValues()[0];

    // SECURITY (F-04): authorize the caller — only the request's owner may read its full data. A direct
    // google.script.run call must not be able to read another user's request by guessing the reqId.
    const _me = Session.getActiveUser().getEmail();
    if (String(values[DC_COL.USER_EMAIL - 1] || '').toLowerCase() !== String(_me || '').toLowerCase()) {
      return { found: false };
    }

    /* Step 1 — Parse the row's metadata, file list, and status from the newest matching row. */
    const metadata = JSON.parse(values[DC_COL.METADATA_JSON - 1] || '{}');
    const files    = JSON.parse(values[DC_COL.FILE_ID - 1] || '[]');
    const status   = values[DC_COL.STATUS - 1];

    /* Step 2 — Load linked PIA record + all approver timelines in one batched pass. */
    // ✅ Fix 2: BATCH: Load all related data in one pass
    const batch = getRequestDataBatch_(ss, reqId, null);
    const piaRecord = batch.piaRecord;

    /* Step 3 — Split risk flags into DCS-specific vs PIA-specific buckets for the UI. */
    let rawFlags = (piaRecord && piaRecord.approverFlags) ? piaRecord.approverFlags : (metadata.approverFlags || null);
    let dcsFlags = {};
    let hasDcsFlags = false;
    let hasPiaFlags = false;
    let hasAnyFlags = false;

    if (rawFlags && typeof rawFlags === 'object') {
      for (const key in rawFlags) {
        hasAnyFlags = true;
        if (key.toUpperCase().includes('DCS')) {
          dcsFlags[key] = rawFlags[key];
          hasDcsFlags = true;
        } else {
          hasPiaFlags = true;
        }
      }
    }

    const dcsStatusCheck = String(status || '').toUpperCase();
    const isDcsReturnedCheck = dcsStatusCheck === 'RETURNED' && hasDcsFlags;
    const piaStatusLowerCheck = String(piaRecord ? piaRecord.piaStatus : '').toLowerCase();
    const piaDecisionLowerCheck = String(piaRecord ? piaRecord.piaDecision : '').toLowerCase().replace(/\s+/g, '');
    const isPiaReturnedCheck = (piaStatusLowerCheck === 'rejected' || piaStatusLowerCheck === 'returned');

    /* Step 4 — Assemble the full response object (form data + files + timelines + flags + Phase 2 URL). */
    return {
      found: true,
      reqId: values[DC_COL.REQ_ID - 1],
      sessionId: values[DC_COL.REQ_ID - 1],
      email: values[DC_COL.USER_EMAIL - 1],
      immHeadEmail: values[DC_COL.IMM_HEAD_EMAIL - 1],
      deptHeadEmail: values[DC_COL.DEPT_HEAD_EMAIL - 1],
      divHeadEmail: values[DC_COL.DIV_HEAD_EMAIL - 1],
      status: status,
      metadata: metadata,
      files: files,
      timestamp: values[DC_COL.TIMESTAMP - 1] ? new Date(values[DC_COL.TIMESTAMP - 1]).toISOString() : '',
      logId: values[DC_COL.LOG_ID - 1] || 'N/A',
      metadataAgency: (values.length >= DC_COL.METADATA_AGENCY) ? (() => { try { return JSON.parse(values[DC_COL.METADATA_AGENCY - 1] || '{}'); } catch(e) { return {}; } })() : {},
      phase2Url: (status === STATUS_READY_FOR_PIA || status === STATUS_COMPLETE || dcsStatusCheck === 'RETURNED') ? generatePhase2Url_(values[DC_COL.REQ_ID - 1]) : '',
      piaStatus: piaRecord ? piaRecord.piaStatus : null,
      piaSessionId: piaRecord ? piaRecord.piaSessionId : null,
      piaDecision: piaRecord ? piaRecord.piaDecision : null,
      hasPiaFlags: hasPiaFlags,
      approverFlags: hasDcsFlags ? dcsFlags : null,
      approverComments: (piaRecord && piaRecord.approverComments) ? piaRecord.approverComments : (metadata.approverComments || null),
      approvers: batch.approvals,
      ismApprovers: batch.ismApprovals,
      divHeadApprovers: batch.divHeadApprovals,
      // Round-4 (additive): prior rounds from PIA's Revision_History logbook, keyed by the PIA
      // session id. [] for requests that never reached PIA or were never returned.
      revisionHistory: getRevisionHistoryRows_(ss, piaRecord ? piaRecord.piaSessionId : '')
    };
    
  } catch (err) {
    console.error('apiGetRequestData error:', err.message);
    return { found: false, error: err.message };
  }
}

/*
  Function: apiListUserRequests
  LAYMAN:    Builds the "My Applications" list — every request the current user has submitted, newest
             first, each with its status, PIA status, name, and any approver remarks.
  TECHNICAL: TextFinder on Data_Collection col C (UserEmail) for the user's rows. Builds a PIA status/
             comments map keyed by Linked_ReqID from the Applications sheet (last row wins). For each
             owned row, batch-reads the needed columns, looks up its PIA record, and attaches a Phase 2
             URL when status is READY_FOR_PIA/COMPLETE. Returns the list reversed (newest first). Read-only.
  PARAMS:    (none)
  RETURNS:   { success:true, requests:[{ reqId, status, piaStatus, timestamp, name, remarks, phase2Url? }] };
             { success:false, error } on exception.
*/
function apiListUserRequests() {
  try {
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DC_SHEET_NAME);
    
    // ✅ Use TextFinder to get only user's rows
    const emailFinder = sheet.getRange('C:C')
      .createTextFinder(email)
      .matchEntireCell(true)
      .findAll();

    if (emailFinder.length === 0) {
      return { success: true, requests: [] };
    }

    // ✅ Build PIA map with targeted column search (no full sheet load)
    const piaMap = {};
    const appSheet = ss.getSheetByName('Applications');
    if (appSheet) {
      const appData = appSheet.getDataRange().getValues();
      if (appData.length > 0) {
        const headers = appData[0];
        const reqCol = headers.indexOf('Linked_ReqID');
        const statusCol = headers.indexOf('Status');
        let commentsCol = headers.indexOf('Approver_Comments');
        if (commentsCol === -1) commentsCol = headers.indexOf('Comments');
        
        if (reqCol !== -1 && statusCol !== -1) {
          for (let i = appData.length - 1; i > 0; i--) {
            const reqId = String(appData[i][reqCol]);
            if (reqId && !piaMap[reqId]) {
              piaMap[reqId] = {
                status: appData[i][statusCol],
                comments: commentsCol !== -1 ? appData[i][commentsCol] : ''
              };
            }
          }
        }
      }
    }

    // ✅ Build results from already-found rows (no second full sheet load)
    const requests = [];
    emailFinder.forEach(cell => {
      const row = cell.getRow();
      // Get only the columns we need in a single batch
      const rowData = sheet.getRange(row, 1, 1, 10).getValues()[0];
      const status = rowData[DC_COL.STATUS - 1];
      const reqId = rowData[DC_COL.REQ_ID - 1];

      const piaRec = piaMap[reqId] || {};

      const request = {
        reqId: reqId,
        status: status,
        piaStatus: piaRec.status || null,
        timestamp: rowData[DC_COL.TIMESTAMP - 1] ? new Date(rowData[DC_COL.TIMESTAMP - 1]).toISOString() : '',
        name: JSON.parse(rowData[DC_COL.METADATA_JSON - 1] || '{}').name || 'Untitled Request',
        remarks: piaRec.comments || ''
      };

      if (status === STATUS_READY_FOR_PIA || status === STATUS_COMPLETE) {
        request.phase2Url = generatePhase2Url_(reqId);
      }
      requests.push(request);
    });

    return { success: true, requests: requests.reverse() }; // Newest first
  } catch (err) {
    console.error('apiListUserRequests error:', err.message);
    return { success: false, error: err.message };
  }
}

/*
  Function: apiGetReturnedApplication
  LAYMAN:    Decides whether a request can be re-opened for editing (revision mode). It only says yes
             if the request belongs to you AND it was genuinely returned with fixable DCS flags — and it
             won't re-open something you already resubmitted after the return.
  TECHNICAL: Wraps apiGetRequestData, enforces ownership (case-insensitive email), and computes
             editability: requires DCS-specific approverFlags AND (DCS status RETURNED, OR PIA
             returned/rejected and NOT already resubmitted). "Recently resubmitted" = the DCS timestamp
             is newer than the latest returned/rejected approver decision date across all timelines.
  PARAMS:
    - reqId — the DCS Request ID to evaluate for editing.
  RETURNS:   { success:true, application:<apiGetRequestData result> } if editable;
             { success:false, error } if not found, unauthorized, or not in a returnable state.
*/
function apiGetReturnedApplication(reqId) {
  const userEmail = Session.getActiveUser().getEmail();
  const result = apiGetRequestData(reqId);
  
  if (!result.found) return { success: false, error: 'Application not found.' };
  if (result.email.toLowerCase() !== userEmail.toLowerCase()) return { success: false, error: 'Unauthorized.' };
  
  const dcsStatus = String(result.status || '').toUpperCase();
  const piaStatusLower = String(result.piaStatus || '').toLowerCase();
  const isPiaReturned = (piaStatusLower === 'rejected' || piaStatusLower === 'returned');

  let hasDcsFlags = false;
  if (result.approverFlags !== null && Object.keys(result.approverFlags).length > 0) {
    hasDcsFlags = true;
  }

      const dcsTimestamp = result.timestamp ? new Date(result.timestamp).getTime() : 0;
      let latestReturnTime = 0;
      const allApprovers = [...(result.approvers || []), ...(result.ismApprovers || []), ...(result.divHeadApprovers || [])];
      allApprovers.forEach(a => {
        const dec = String(a.decision || a.status || '').toLowerCase().trim();
        if (dec === 'returned' || dec === 'rejected') {
          if (a.date) {
            const d = new Date(a.date);
            if (!isNaN(d.getTime()) && d.getTime() > latestReturnTime) {
              latestReturnTime = d.getTime();
            }
          }
        }
      });

      const isRecentlyResubmitted = latestReturnTime > 0 && dcsTimestamp > latestReturnTime;
  const isDcsReturned = dcsStatus === 'RETURNED' && hasDcsFlags;
      const canEditDcs = hasDcsFlags && (isDcsReturned || (isPiaReturned && !isRecentlyResubmitted));

  // Check if it's eligible for editing
      if (!canEditDcs) {
    return { success: false, error: 'This application is not in a returnable state for editing.' };
  }
  
  return { success: true, application: result };
}

// ============================================================
// 8. STATUS POLLING  (Frontend Tracker — Stage 5)
// ============================================================

/*
  Function: apiGetStatus_
  LAYMAN:    Tells the frontend the status of the user's most recent request (for the live status tracker).
  TECHNICAL: Resolves the user's latest Data_Collection row via getLatestDCSRecord_ and returns its
             ReqID/status/timestamp. Read-only.
  PARAMS:    (none)
  RETURNS:   { found:true, reqId, sessionId, status, timestamp } if a record exists;
             { found:false } if none; { found:false, error } on exception.
*/
function apiGetStatus_() {
  try {
    const email  = Session.getActiveUser().getEmail();
    const ss     = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet  = ss.getSheetByName(DC_SHEET_NAME);

    const record = getLatestDCSRecord_(sheet, email);
    if (!record) return { found: false };

    return {
      found    : true,
      reqId    : record[DC_COL.REQ_ID - 1],
      sessionId: record[DC_COL.REQ_ID - 1],
      status   : record[DC_COL.STATUS - 1],
      timestamp: record[DC_COL.TIMESTAMP - 1] ? String(record[DC_COL.TIMESTAMP - 1]) : ''
    };

  } catch (err) {
    console.error('apiGetStatus_ error:', err.message);
    return { found: false, error: err.message };
  }
}

/*
  Function: getLatestDCSRecord_
  LAYMAN:    Finds the user's newest request row in the database and hands back its raw cell values.
  TECHNICAL: TextFinder on Data_Collection col C (UserEmail); the last match is the most recent entry.
             Returns that full row as a values array. Read-only.
  PARAMS:
    - sheet — the Data_Collection Sheet object.
    - email — the user's email to match.
  RETURNS:   The row's values array (1 row × all columns), or null if the user has no rows.
*/
function getLatestDCSRecord_(sheet, email) {
    const emailFinder = sheet.getRange('C:C')
    .createTextFinder(email)
    .matchEntireCell(true)
    .findAll();

  if (!emailFinder || emailFinder.length === 0) return null;

  // The last occurrence is the most recent entry
  const lastCell = emailFinder[emailFinder.length - 1];
  const lastRow  = lastCell.getRow();
  const lastCol  = sheet.getLastColumn();
  return sheet.getRange(lastRow, 1, 1, lastCol).getValues()[0];
}


// ============================================================
// 9. PIA HANDSHAKE GATE  (Called by the PIA app's doGet)
// ============================================================

/*
  Function: getGatewayRecord_
  LAYMAN:    The handshake between Phase 1 and Phase 2. When someone opens the PIA app, the PIA backend
             calls this to ask "does this person have a cleared DCS request?" If not, PIA stays locked;
             if yes, this hands PIA the ReqID and file IDs it needs to link the two phases together.
  TECHNICAL: Cross-app gate, called from the PIA backend's doGet (defense-in-depth — never trust a
             frontend flag alone). TextFinder on Data_Collection col C for the user's latest row; if
             status is not READY_FOR_PIA/COMPLETE it returns gated:true with a reason
             (DCS_PENDING/DCS_REJECTED/DCS_RETURNED/NO_DCS_RECORD/SYSTEM_ERROR); if cleared it returns
             gated:false plus reqId and fileId. Read-only.
  PARAMS:
    - userEmail — optional override; defaults to the Session active user's email.
  RETURNS:   { gated, reason, reqId, fileId, status, error? }.
  EXAMPLE:   getGatewayRecord_('jane@megaworld.com')
               -> { gated:false, reason:'CLEARED', reqId:'DCS-000007', fileId:'[…]', status:'COMPLETE' }
             No record -> { gated:true, reason:'NO_DCS_RECORD', reqId:'', fileId:'', status:'' }
*/
function getGatewayRecord_(userEmail) {
  try {
    // SECURITY (F-08): always use the signed-in user's identity. The userEmail override is ignored so a
    // direct google.script.run call cannot query another user's gateway status / reqId / fileId.
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DC_SHEET_NAME);

    // Search only UserEmail column (Column C) — targeted for performance
    const emailFinder = sheet.getRange('C:C')
      .createTextFinder(email)
      .matchEntireCell(true)
      .findAll();

    if (!emailFinder || emailFinder.length === 0) {
      return {
        gated : true,
        reason: 'NO_DCS_RECORD',
        reqId : '',
        fileId: '',
        status: ''
      };
    }

    // Get the LAST occurrence (most recent request)
    const lastRow  = emailFinder[emailFinder.length - 1].getRow();
    const lastCol  = sheet.getLastColumn();
    const record   = sheet.getRange(lastRow, 1, 1, lastCol).getValues()[0];

    const status = record[DC_COL.STATUS - 1];
    const reqId  = record[DC_COL.REQ_ID - 1];
    const fileId = record[DC_COL.FILE_ID - 1];

    if (status !== STATUS_READY_FOR_PIA && status !== STATUS_COMPLETE) {
      let reason = 'DCS_PENDING';
      if (status === STATUS_REJECTED) reason = 'DCS_REJECTED';
      if (status === STATUS_RETURNED) reason = 'DCS_RETURNED';
      return {
        gated : true,
        reason: reason,
        reqId : reqId,
        fileId: '',
        status: status
      };
    }

    // Cleared — pass ReqID and FileID to PIA
    return {
      gated : false,
      reason: 'CLEARED',
      reqId : reqId,
      fileId: fileId,
      status: status
    };

  } catch (err) {
    console.error('getGatewayRecord_ error:', err.message);
    return {
      gated : true,
      reason: 'SYSTEM_ERROR',
      reqId : '',
      fileId: '',
      status: '',
      error : err.message
    };
  }
}


// ============================================================
// 10. PIA INTEGRITY BINDING  (Final Certificate Hash)
// ============================================================

/*
  Function: computeIntegrityHash_
  LAYMAN:    Produces the tamper-proof fingerprint printed on the final PIA approval certificate. It
             locks Phase 1 and Phase 2 together, so editing either ID would make the certificate's
             fingerprint no longer match.
  TECHNICAL: Computes SHA-256 over `dcsReqId + '|' + piaSessionId` (UTF-8) and hex-encodes the digest.
             Throws if either ID is missing. Pure function — no sheet/Drive access.
  PARAMS:
    - dcsReqId     — the DCS Request ID (e.g. 'DCS-000001').
    - piaSessionId — the PIA Session ID (e.g. 'PIA-000075').
  RETURNS:   The lowercase hex SHA-256 digest string. Throws Error if either ID is falsy.
  EXAMPLE:   computeIntegrityHash_('DCS-000001', 'PIA-000075') -> '9f2c…' (64 hex chars)
*/
function computeIntegrityHash_(dcsReqId, piaSessionId) {
  if (!dcsReqId || !piaSessionId) throw new Error('Both IDs are required for integrity hash.');
  const message  = dcsReqId + '|' + piaSessionId;
  const rawBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    message,
    Utilities.Charset.UTF_8
  );
  return rawBytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}


// ============================================================
// 10b. SECURE DOCUMENT ACCESS
//   Uploaded documents are PRIVATE in Drive (see uploadProxy_ Step 5). The only read path is
//   apiDownloadDcsFile below, which re-authorizes the caller server-side and streams the bytes
//   back as base64 — the browser never receives a Drive URL.
// ============================================================

/*
  Function: collectRequestFileIds_

  LAYMAN (Tropang Ex):
  Kinukuha nito lahat ng Drive file ID na TALAGANG kabilang sa isang DCS request — yung kasalukuyang
  attachments, yung mga lumang bersyon na na-replace, at yung endorsement letter. Ito yung listahan
  na ikukumpara natin bago tayo magbukas ng kahit anong file.

  TECHNICAL:
  Builds the set of Drive file IDs legitimately reachable from one Data_Collection row: the FILE_ID
  JSON array (current attachments), Metadata_JSON.supersededFiles (archived prior versions), and
  Metadata_Agency.endorsementLetter.id. Every parse is defensive — a malformed cell contributes
  nothing rather than throwing.

  This is the anti-confused-deputy list. Owning a request is not owning a file: without this check
  a caller who passes the ownership gate on their OWN request could hand in any Drive file ID in the
  script owner's Drive and have it served back under the owner's full `drive` scope.

  PARAMS:
    - values — the full Data_Collection row as a 0-indexed array (from getRange(...).getValues()[0]).
  RETURNS:   An object used as a set: { '<driveFileId>': true, ... }. Empty object if nothing parses.
*/
function collectRequestFileIds_(values) {
  const allowed = {};
  const add = function (id) {
    const s = String(id || '').trim();
    if (s) allowed[s] = true;
  };

  /* Current attachments — FILE_ID holds a JSON array of { type, id, name }. */
  try {
    const files = JSON.parse(values[DC_COL.FILE_ID - 1] || '[]');
    (Array.isArray(files) ? files : []).forEach(function (f) { if (f) add(f.id); });
  } catch (e) { /* malformed cell contributes nothing */ }

  /* Superseded (archived) prior versions live inside Metadata_JSON. */
  try {
    const meta = JSON.parse(values[DC_COL.METADATA_JSON - 1] || '{}');
    (Array.isArray(meta.supersededFiles) ? meta.supersededFiles : []).forEach(function (f) {
      if (f) add(f.id);
    });
  } catch (e) { /* malformed cell contributes nothing */ }

  /* Agency / OJT endorsement letter lives inside Metadata_Agency. */
  try {
    const agency = JSON.parse(values[DC_COL.METADATA_AGENCY - 1] || '{}');
    if (agency && agency.endorsementLetter) add(agency.endorsementLetter.id);
  } catch (e) { /* malformed cell contributes nothing */ }

  return allowed;
}

/*
  Function: apiDownloadDcsFile

  LAYMAN (Tropang Ex):
  Ito yung bagong paraan para makita mo yung na-attach mong dokumento. Dati kasi, direktang Drive
  link yung binibigay — at yung link na yun ay bukas sa kahit sino sa internet. Ngayon, ikaw mismo
  ang tinatanong ng server: "sayo ba talaga to?" Kapag oo, ipapadala niya yung mismong laman ng file
  pabalik sa browser mo para ma-download. Walang Drive link na lumalabas kahit kailan.

  TECHNICAL:
  Identity-gated document proxy, the sole read path now that uploadProxy_ leaves files private.
  Four gates in order, each failing before any Drive I/O:
    (1) corporate domain,
    (2) request ownership — same rule and same opaque failure text as the F-04 guard on
        apiGetRequestData, so a non-owner cannot distinguish "no such request" from "not yours",
    (3) file membership via collectRequestFileIds_ (anti-confused-deputy),
    (4) a size ceiling, because base64 inflates ~33% and google.script.run return payloads become
        unreliable well before the 10 MB upload cap round-trips.

  Errors returned to the client are deliberately generic; the real exception is logged server-side
  only. Drive exceptions echo the offending resource ID and would otherwise leak ADMIN_FOLDER_ID.

  PARAMS:
    - reqId  — the DCS Request ID that owns the document (e.g. 'DCS-000007').
    - fileId — the Drive file ID being requested. Validated against reqId, never trusted alone.
  RETURNS:   { success:true, data:{ base64, mimeType, filename } } on success;
             { success:false, error } with a generic message on any failure.

  STEPS
    Step 1 — Domain + argument gate
      Layman    : Kailangan corporate account ka, at kailangan kumpleto yung hinihingi mo.
      Technical : isAuthorizedDomain_ on the Session user; reject blank reqId/fileId.
    Step 2 — Resolve the request row (newest revision wins)
      Layman    : Hanapin yung request sa database, yung pinakabagong bersyon.
      Technical : TextFinder over column B with matchEntireCell, take the LAST match.
    Step 3 — Ownership gate
      Layman    : Ikaw ba yung nag-file nito? Kung hindi, "not available" — hindi natin sasabihin
                  kung existing ba talaga yung request, para walang makakalkula ng ID.
      Technical : Case-insensitive compare against DC_COL.USER_EMAIL; identical failure shape to
                  the "not found" branch.
    Step 4 — File-membership gate
      Layman    : Kabilang ba talaga yung file na to sa request na to?
      Technical : collectRequestFileIds_ set lookup. Logs a SECURITY ALERT on mismatch.
    Step 5 — Size gate, then read and encode
      Layman    : Kung sobrang laki, sabihin nating hingin na lang sa ISM. Kung ok, i-encode natin.
      Technical : getBlob().getBytes(), reject > MAX_DOWNLOAD_BYTES, else Utilities.base64Encode.

  EXAMPLE
    apiDownloadDcsFile('DCS-000007', '1AbC...xyz')
      -> { success:true, data:{ base64:'JVBERi0…', mimeType:'application/pdf',
                                filename:'DCS-000007-NDA.pdf' } }
    apiDownloadDcsFile('DCS-000007', '<a file belonging to DCS-000009>')
      -> { success:false, error:'Document not available.' }
*/
function apiDownloadDcsFile(reqId, fileId) {
  const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // 8 MB decoded; ~10.7 MB once base64-encoded
  // One opaque message for every authorization failure — never reveal which gate rejected.
  const DENIED = { success: false, error: 'Document not available.' };

  try {
    /* Step 1 — Domain + argument gate. */
    const me = Session.getActiveUser().getEmail();
    if (!isAuthorizedDomain_(me)) return DENIED;
    if (!reqId || !fileId) return DENIED;

    /* Step 2 — Resolve the request row; the LAST match is the newest revision. */
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DC_SHEET_NAME);
    const finder = sheet.getRange('B:B')
      .createTextFinder(String(reqId))
      .matchEntireCell(true)
      .findAll();
    if (!finder || finder.length === 0) return DENIED;

    const row    = finder[finder.length - 1].getRow();
    const values = sheet.getRange(row, 1, 1, Math.max(DC_COL.METADATA_AGENCY, 11)).getValues()[0];

    /* Step 3 — Ownership gate (mirrors the F-04 guard; same opaque failure as "not found"). */
    if (String(values[DC_COL.USER_EMAIL - 1] || '').toLowerCase() !== String(me || '').toLowerCase()) {
      return DENIED;
    }

    /* Step 4 — File-membership gate: the fileId must belong to THIS request. */
    const allowed = collectRequestFileIds_(values);
    if (!allowed[String(fileId).trim()]) {
      console.warn('SECURITY ALERT: ' + me + ' requested file ' + fileId +
                   ' which does not belong to ' + reqId);
      return DENIED;
    }

    /* Step 5 — Size gate, then read and encode. */
    const file  = DriveApp.getFileById(String(fileId).trim());
    const blob  = file.getBlob();
    const bytes = blob.getBytes();
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      return {
        success: false,
        error: 'This document is too large to open here (' +
               (bytes.length / 1024 / 1024).toFixed(1) +
               ' MB). Please request a copy from the ISM Department.'
      };
    }

    return {
      success: true,
      data: {
        base64  : Utilities.base64Encode(bytes),
        mimeType: blob.getContentType() || 'application/octet-stream',
        filename: file.getName()
      }
    };

  } catch (e) {
    // Generic to the caller, specific to the log — Drive errors echo resource IDs.
    console.error('apiDownloadDcsFile failed for ' + reqId + '/' + fileId + ': ' + e.message);
    return { success: false, error: 'Could not open this document. Please try again or contact ISM.' };
  }
}


// ============================================================
// 11. ADMIN UTILITIES  (Run manually from the Apps Script editor)
// ============================================================

/*
  Function: setupDataCollectionSheet
  LAYMAN:    One-time scaffolding you run by hand after pointing the script at a fresh spreadsheet. It
             creates the core tabs (Data_Collection, DCS_Risk_Audit, System_Configuration) with the
             right headers and some starter config rows, without clobbering anything that already exists.
  TECHNICAL: Idempotent setup. Creates Data_Collection if absent and writes the 11-column header
             (styled, frozen) only when A1 is empty. Likewise creates DCS_Risk_Audit and
             System_Configuration with headers if missing, seeding LINK_NDA_EMPLOYEE_TEMPLATE and LINK_TC_PAGE.
             Run manually from the editor. Logs each action.
  PARAMS:    (none)
  RETURNS:   undefined (side effect: creates/initializes sheets; logs to Logger).
*/
function setupDataCollectionSheet() {
  // SECURITY: editor-run only. Cannot take a trailing underscore (must be Run-able from the
  // editor UI), so it is gated on owner-or-trigger context instead.
  if (!isOwnerContext_()) return { success: false, error: 'Not authorized.' };
  const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
  let sheet   = ss.getSheetByName(DC_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DC_SHEET_NAME);
  }

  const headers = [
    'LogID', 'ReqID', 'UserEmail', 'Status',
    'ImmediateHeadEmail', 'DeptHeadEmail', 'DivHeadEmail',
    'FileID', 'Metadata_JSON', 'Timestamp', 'Metadata_Agency'
  ];

  // Only write headers if row 1 is empty
  if (!sheet.getRange('A1').getValue()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#1a3a5c')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    Logger.log('Data_Collection sheet initialized with headers.');
  } else {
    Logger.log('Data_Collection sheet already has content in row 1 — skipped.');
  }

  // Initialize DCS_Risk_Audit sheet if missing
  let auditSheet = ss.getSheetByName(DCS_RISK_AUDIT_SHEET);
  if (!auditSheet) {
    auditSheet = ss.insertSheet(DCS_RISK_AUDIT_SHEET);
    const auditHeaders = ['LogID', 'SessionID', 'InternalFlags', 'Action', 'UserEmail', 'UserAgent', 'Timestamp'];
    auditSheet.getRange(1, 1, 1, auditHeaders.length).setValues([auditHeaders]);
    auditSheet.setFrozenRows(1);
    auditSheet.getRange(1, 1, 1, auditHeaders.length)
      .setBackground('#1a3a5c')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    Logger.log('DCS_Risk_Audit sheet initialized with headers.');
  }

  // Initialize System_Configuration if missing
  let configSheet = ss.getSheetByName('System_Configuration');
  if (!configSheet) {
    configSheet = ss.insertSheet('System_Configuration');
    const configHeaders = ['Configuration_Key', 'Value', 'Description'];
    configSheet.getRange(1, 1, 1, configHeaders.length).setValues([configHeaders]);
    configSheet.setFrozenRows(1);
    configSheet.getRange(1, 1, 1, configHeaders.length)
      .setBackground('#1a3a5c')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    configSheet.appendRow(['LINK_NDA_EMPLOYEE_TEMPLATE', '#', 'URL for the NDA (Employee) form']);
    configSheet.appendRow(['LINK_TC_PAGE', 'https://docs.google.com/document/d/REPLACE_WITH_DOC_ID/preview', 'URL for the T&C page embed (Google Docs embed readonly)']);
    Logger.log('System_Configuration sheet initialized.');
  }
}

/*
  Function: adminSetStatus
  LAYMAN:    An admin escape hatch (run from the editor) to manually force a request's status to a
             different value when a correction is needed.
  TECHNICAL: Validates newStatus against the allowed set (PENDING / READY_FOR_PIA / REJECTED),
             TextFinder.findNext on Data_Collection col B for reqId, and sets the Status cell. Throws
             on invalid status or unknown ReqID. Note: opens the spreadsheet directly via openById
             (not the cache).
  PARAMS:
    - reqId     — the DCS Request ID to update.
    - newStatus — one of STATUS_PENDING | STATUS_READY_FOR_PIA | STATUS_REJECTED.
  RETURNS:   undefined (side effect: writes the Status cell; logs). Throws on invalid input.
*/
function adminSetStatus(reqId, newStatus) {
  // SECURITY: editor-run status override. Public by necessity (editor Run), so gate on
  // owner-or-trigger context — otherwise any domain user could flip any request's status.
  if (!isOwnerContext_()) return { success: false, error: 'Not authorized.' };
  const allowed = [STATUS_PENDING, STATUS_READY_FOR_PIA, STATUS_REJECTED];
  if (!allowed.includes(newStatus)) {
    throw new Error('Invalid status. Allowed: ' + allowed.join(', '));
  }

  const ss     = SpreadsheetApp.openById(getProp_('DB_ID'));
  const sheet  = ss.getSheetByName(DC_SHEET_NAME);
  const finder = sheet.getRange('B:B')
    .createTextFinder(reqId)
    .matchEntireCell(true)
    .findNext();

  if (!finder) throw new Error('ReqID not found: ' + reqId);

  sheet.getRange(finder.getRow(), DC_COL.STATUS).setValue(newStatus);
  Logger.log('Status for ' + reqId + ' set to ' + newStatus);
}


// ============================================================
// 12. EXPIRY CLEANUP  (Set as a daily time-driven trigger)
// ============================================================

/*
  Function: purgeExpiredDrafts
  LAYMAN:    Housekeeping that deletes drafts whose 7-day life has run out. Meant to run automatically
             once a day via a time trigger so the Drafts sheet doesn't accumulate stale rows.
  TECHNICAL: Reads only the ExpiresAt column (G) for all data rows, collects rows whose expiry is past,
             and deletes them bottom-up to avoid row shift. No-ops on an empty sheet. Intended as a
             daily time-driven trigger. Logs the count removed.
  PARAMS:    (none)
  RETURNS:   undefined (side effect: deletes expired draft rows; logs count).
*/
function purgeExpiredDrafts() {
  // SECURITY: daily trigger handler. A trigger handler cannot take a trailing underscore, so it is
  // gated on owner-or-trigger context to stop any domain user invoking a mass row delete.
  if (!isOwnerContext_()) return { success: false, error: 'Not authorized.' };
  const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
  const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
  if (!sheet) return;

  const now      = new Date();
  const lastRow  = sheet.getLastRow();
  if (lastRow < 2) return;

  // Collect expired rows (iterate bottom-up to avoid row shift)
  const expiresVals = sheet.getRange(2, 7, lastRow - 1, 1).getValues();
  const toDelete    = [];

  for (let i = expiresVals.length - 1; i >= 0; i--) {
    const expiresAt = expiresVals[i][0];
    if (expiresAt && new Date(expiresAt) < now) {
      toDelete.push(i + 2); // 1-indexed, offset by header row
    }
  }

  toDelete.forEach(r => sheet.deleteRow(r));
  Logger.log('purgeExpiredDrafts: removed ' + toDelete.length + ' expired row(s).');
}

// ============================================================
// 13. AUTHORIZATION UTILITY
// ============================================================

/*
  Function: forceAuthorize
  LAYMAN:    A throwaway function you run by hand to make Apps Script pop up its permission prompt, so
             you can grant all the access (Sheets, Drive, Mail) the app needs after adding a new scope.
  TECHNICAL: Touches SpreadsheetApp and DriveApp (creates a tiny test file in ADMIN_FOLDER_ID) so the
             OAuth consent screen covers every scope in appsscript.json. Run manually from the editor
             when you hit permission errors. Logs the verified folder + created file ID.
  PARAMS:    (none)
  RETURNS:   undefined (side effect: creates a test file; triggers OAuth consent; logs).
*/
function forceAuthorize() {
  if (!isOwnerContext_()) return { success: false, error: 'Not authorized.' };
  SpreadsheetApp.getActiveSpreadsheet();
  const folderId = getProp_('ADMIN_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  const dummy = folder.createFile('DCS_AUTH_TEST.txt', 'Verified');
  Logger.log('Auth check complete for folder: ' + folder.getName() + '. File ID: ' + dummy.getId());
}

// ============================================================
// 14. ONE-TIME BACKFILL  (Run manually from the Apps Script editor)
// ============================================================

/*
  Function: backfillPrivateDcsFiles

  LAYMAN (Tropang Ex):
  Yung fix sa uploadProxy_ ay para lang sa mga BAGONG upload. Lahat ng dokumentong na-upload BAGO
  yun ay naka-"anyone with the link" pa rin — publiko pa rin sila. Ito yung linis-lahat: dadaanan
  niya yung buong vault folder (pati Archive) at ipipsara lahat.

  🚩 MAG-INGAT: pagkatapos nito, mamamatay yung mga Drive link na nasa mga EMAIL na naipadala na.
  Tama yun (yun nga yung point), pero dapat may abiso muna ang ISM bago patakbuhin.
  Kaya nga dryRun = true ang default: unang takbo, tingin lang, walang binabago.

  TECHNICAL:
  Owner/trigger-gated one-time remediation for files created before uploadProxy_ stopped calling
  setSharing. Walks ADMIN_FOLDER_ID plus its 'Archive' subfolder and sets
  Access.PRIVATE / Permission.NONE on each file, but ONLY when dryRun is explicitly false.

  Per-file errors are counted and logged, never thrown, so one undeletable/shortcut file cannot
  abort the sweep. Not idempotent-sensitive: re-running is harmless.

  NOT git-revertible. Reverting the commit restores the code but does NOT restore link sharing;
  undoing this would need a counterpart script. Run it last, after the proxy is verified in prod.

  PARAMS:
    - dryRun — defaults to TRUE. Pass exactly false to actually write. Any other value = dry run.
  RETURNS:   { success, dryRun, scanned, changed, failed } summary (also logged).

  EXAMPLE
    backfillPrivateDcsFiles()        -> { dryRun:true,  scanned:142, changed:0,   failed:0 }
    backfillPrivateDcsFiles(false)   -> { dryRun:false, scanned:142, changed:142, failed:0 }
*/
function backfillPrivateDcsFiles(dryRun) {
  if (!isOwnerContext_()) return { success: false, error: 'Not authorized.' };

  // Fail safe: anything that is not exactly `false` is treated as a dry run.
  const isDry = (dryRun !== false);
  let scanned = 0, changed = 0, failed = 0;

  Logger.log('🔒 backfillPrivateDcsFiles — ' + (isDry ? 'DRY RUN (no writes)' : '⚠ LIVE RUN (writing)'));

  const sweep = function (folder, label) {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      scanned++;
      try {
        if (isDry) {
          Logger.log('  [dry] would privatize [' + label + '] ' + file.getName() + ' (' + file.getId() + ')');
        } else {
          file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
          changed++;
        }
      } catch (e) {
        failed++;
        Logger.log('  ⚠ could not privatize ' + file.getName() + ' (' + file.getId() + '): ' + e.message);
      }
    }
  };

  try {
    const parent = DriveApp.getFolderById(getProp_('ADMIN_FOLDER_ID'));
    sweep(parent, 'vault');

    const archives = parent.getFoldersByName('Archive');
    if (archives.hasNext()) {
      sweep(archives.next(), 'archive');
    } else {
      Logger.log('  (no Archive subfolder — nothing further to sweep)');
    }
  } catch (e) {
    Logger.log('❌ backfillPrivateDcsFiles aborted: ' + e.message);
    return { success: false, error: e.message, dryRun: isDry, scanned: scanned, changed: changed, failed: failed };
  }

  Logger.log('🔒 Done. scanned=' + scanned + ' changed=' + changed + ' failed=' + failed +
             (isDry ? '  → re-run as backfillPrivateDcsFiles(false) to apply.' : ''));
  return { success: true, dryRun: isDry, scanned: scanned, changed: changed, failed: failed };
}