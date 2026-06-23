// ============================================================
//  admin_code.js  (Admin — Phase 3 backend)
// ============================================================
/*
  [ OUTLINE ]
  FILE: admin_code.js
  PURPOSE (Layman): This is the server brain of the Admin app, the ISM control
    tower for Megaworld's access-request system. It pulls every request from the
    shared Google Spreadsheet, joins the DCS form data with the PIA assessment and
    the approval decisions, and hands a clean dashboard to the admin page. It also
    lets ISM admins resend stuck emails, re-route a finished request's Certificate
    of Approval to DCOPS/TechServe, edit system settings, read audit logs, and
    delete entries. Only INFOSEC-001 / INFOSEC-002 accounts get in.

  TECHNICAL: Google Apps Script web-app backend (doGet/doPost) plus a JSON REST API
    and google.script.run handlers. Data layer is the shared Spreadsheet read through
    sheetToObjects_ / sheetToObjectsFiltered_ helpers; no ORM, header-indexed row
    arrays. Email sending goes through MailApp wrapped in sendEmailWithRetry_ (5-try
    backoff) and rendered with the navy buildAdminEmailHtml_ / buildCertificateHtml_
    templates. Access is gated by two layers: isAuthorizedDomain() (domain) then
    checkAccess_() (INFOSEC member ID). The Risk_Audit sheet doubles as both the audit
    log and the email queue. Constraints: returns must be plain-string POJOs (GAS V8
    drops non-serializable values / returns null on uncaught throw), so almost every
    function is wrapped in try/catch and stringifies sheet cells defensively.

  CATEGORY: SHEET NAME CONSTANTS & CONFIG
    - SHEET_NAMES (constant)              canonical sheet tab names
    - ENABLED_DOMAIN_CHECK (constant)     master switch for the domain gate
    - ADMIN_API_KEY (constant)            shared secret for the JSON REST API
    - getPrefix()                         optional sheet-name prefix from Script Properties
    - getProp_(key)                       raw Script Property reader

  CATEGORY: DISPATCH / ENTRY
    - doGet(e)                            serve AdminView (or access-denied / setup page)
    - doPost(e)                           route JSON API, submitDCS, or deny
    - handleAdminApi_(request)            authenticate + switch() the JSON REST actions

  CATEGORY: ACCESS CONTROL
    - checkAccess_(email)                 allow only INFOSEC-001 / INFOSEC-002
    - isAuthorizedDomain(userEmail)       domain-suffix gate (fail-secure)
    - submitDCS(payload)                  re-validates domain (defense-in-depth stub)

  CATEGORY: EMAIL QUEUE & ROUTING (Risk_Audit as queue)
    - adminApi_getEmailQueue(params)      list Email* audit rows as a queue
    - adminApi_getQueueSummary(params)    queue health / counts
    - adminApi_getFailedEmails(sinceDays) wrapper -> adminGetFailedEmails
    - adminApi_getEmailLog(sessionId)     wrapper -> adminGetEmailLog
    - adminApi_resendEmail(...)           wrapper -> adminResendEmail
    - adminApi_retryQueuedEmail(queueId)  flip one Failed row back to Pending
    - adminApi_retryAllForSession(...)    flip many rows back to Pending
    - adminApi_cancelQueuedEmails(...)    mark rows Cancelled
    - adminApi_resendToStage(...)         re-notify approver / ISM / DivHead stage
    - adminApi_getPipelineView(sessionId) full per-session pipeline snapshot

  CATEGORY: CONFIG (notification + System_Configuration)
    - adminApi_getNotificationConfig()    read ADMIN_NOTIFY_EMAIL / NOTIFY_* flags
    - adminApi_setNotificationConfig(cfg) write those flags
    - getConfigData()                     read System_Configuration + InfoSec_Email_Config
    - saveConfigData(sysUpdates, info)    write/append those two config sheets

  CATEGORY: SHEET HELPERS & UTILS
    - getSpreadsheet_()                   open the DB by SPREADSHEET_ID
    - getSheet_(name)                     resolve a sheet by exact-then-prefixed name
    - sheetToObjects_(sheet)              rows -> array of header-keyed objects
    - sheetToObjectsFiltered_(...)        same, filtered by one column value
    - deleteRowsBySessionId_(...)         bottom-up row deletion by SessionID
    - include(filename)                   inline an HTML partial into the template
    - escapeHtml_(str)                    HTML-escape a string
    - getOptionalUrl_(key)                optional URL Script Property for CTA buttons

  CATEGORY: AUTH / DIAGNOSTICS
    - forceAuthorize()                    touch every service to trigger OAuth consent
    - ping()                              spreadsheet reachability check
    - getAdminDataDebug()                 report which sheets resolve
    - debugSheets()                       list actual tab names
    - checkProperties()                   log whether ADMIN_API_KEY is set
    - testAdminApi()                      end-to-end self-test of the API surface

  CATEGORY: DASHBOARD DATA
    - getAdminData()                      main join: DCS + PIA + approvals -> rows
    - parseMetadata_(jsonStr)             safe JSON.parse of a metadata cell
    - normalizeDcsStatus_(rawStatus)      canonicalize DCS status text
    - computePiaStatus_(app)              Not Started / In Progress / Complete
    - computePiaDisplay_(app, sessionId)  "n/5 Submitted" badge text
    - computeApprovalStatus_(...)         Pending / In Progress / Approved / Denied
    - getAuditLogs(reqId, sessionId)      audit rows + workflow rows for one entry
    - exportToSheet(rows)                 dump the dashboard to a new Spreadsheet

  CATEGORY: DELETE
    - deleteEntry(...)                    remove one request across all sheets + notify
    - batchDeleteEntries(items)           loop deleteEntry over many items

  CATEGORY: CERTIFICATE ROUTING
    - apiAdmin_GetRoutingStatus(sessionId)        routing eligibility snapshot
    - apiAdmin_RerouteApprovedRequest(...)        regenerate cert + email DCOPS/TechServe
    - apiAdmin_GetApprovedApplications()          all apps ranked by route-readiness
    - apiAdmin_DownloadCertificate(sessionId)     cert as base64 PDF (no email)

  CATEGORY: EMAIL SENDERS & TEMPLATE
    - getStyledHtmlWrapper(header, body)  full-page navy HTML (access-denied pages)
    - sendEmailWithRetry_(...)            MailApp with 5-try backoff
    - buildAdminEmailHtml_(opts)          shared navy HTML email shell
    - buildCertificateHtml_(...)          Certificate of Approval HTML body
    - logAuditTrail(sessionId, action, flags)  append an Email* audit row
    - getApplicationData(sessionId)       fetch one Applications row
    - notifyApprover(sessionId, stepIndex)        email a department approver
    - notifyApplicant(sessionId, status)          email the applicant
    - apiPhase3_NotifyISMember(sessionId, step)   email an ISM member
    - adminGetEmailLog(sessionId)         Email* audit rows for a session
    - adminGetFailedEmails(sinceDays)     recent 'Email Failed' rows
    - adminResendEmail(...)               re-trigger the right notify* for a recipient
*/

/*
  Constant: SHEET_NAMES
  LAYMAN:    The canonical list of tab names inside the shared spreadsheet. Code
             references SHEET_NAMES.APPLICATIONS instead of typing "Applications"
             everywhere, so a tab rename only has to change here.
  TECHNICAL: Frozen-by-convention lookup map. Values must match the real tab names
             exactly (getSheet_ also tries a prefixed fallback). Do NOT repurpose
             these to point at different tabs — PIA and DCS read the same sheets.
*/
// ─── Sheet Name Constants (must match actual sheet tab names exactly) ─────────
var SHEET_NAMES = {
  DATA_COLLECTION:      'Data_Collection',
  APPLICATIONS:         'Applications',
  APPROVAL_WORKFLOW:    'Approval_Workflow',
  ISM_APPROVAL:         'ISM_Approval_Workflow',
  DIVHEAD_APPROVAL:     'DivisionHead_Approval_Workflow',
  RISK_AUDIT:           'Risk_Audit',
  INFOSEC_EMAIL_CONFIG: 'InfoSec_Email_Config',
  SYSTEM_CONFIG:        'System_Configuration'
};

/*
  Constant: ENABLED_DOMAIN_CHECK
  LAYMAN:    Master on/off switch for the "must be a company email" gate. Set true
             in production. Flip to false only for local testing.
  TECHNICAL: When true, isAuthorizedDomain() enforces the DOMAIN / ALLOWED_DOMAIN
             suffix check; when false it returns true for everyone (bypass).
*/
// ─── Domain Authorization Configuration ───────────────────────────────────────
// DOMAIN Script Property — e.g. "companycorp.com" (no leading @)
// Set in Project Settings → Script Properties.
const ENABLED_DOMAIN_CHECK = true;

/*
  Function: getPrefix
  LAYMAN:    Returns the optional text stuck in front of sheet names for legacy
             databases (most tabs have no prefix, so this is usually unused).
  TECHNICAL: Reads SHEET_PREFIX from Script Properties, defaulting to
             'PIA System Database - '. Used only by getSheet_'s fallback lookup.
  PARAMS:    (none)
  RETURNS:   String prefix (never null).
*/
function getPrefix() {
  return PropertiesService.getScriptProperties().getProperty('SHEET_PREFIX') || 'PIA System Database - ';
}

/*
  Function: doGet
  LAYMAN:    The front door of the Admin web app. When an ISM admin opens the URL,
             this checks they are using a company account AND are an authorized
             INFOSEC member; if both pass it serves the dashboard page, otherwise it
             shows a styled "Access Denied" screen. It also has a one-time setup mode
             to record which email domain is allowed.
  TECHNICAL: GAS web-app GET handler. Order: (1) optional ?setup=domain writes
             ALLOWED_DOMAIN/DOMAIN; (2) auto-config ALLOWED_DOMAIN from the caller's
             email if they appear in InfoSec_Email_Config; (3) Layer-1 domain gate
             via isAuthorizedDomain; (4) Layer-2 member gate via checkAccess_;
             (5) serve the AdminView templated HTML. Denied responses are built with
             getStyledHtmlWrapper.
  PARAMS:    - e — GAS event; reads e.parameter.setup.
  RETURNS:   HtmlOutput (the dashboard, a setup-complete page, or access-denied).
  EXAMPLE:   GET ?setup=companycorp.com -> "Domain Configured" page

  STEPS
    Step 1 — Optional setup: persist ALLOWED_DOMAIN/DOMAIN, render confirmation.
    Step 2 — Auto-config domain from caller if found in InfoSec_Email_Config.
    Step 3 — Layer 1: reject non-corporate domains.
    Step 4 — Layer 2: reject non-INFOSEC members.
    Step 5 — Serve the AdminView template.
*/
// ─── doGet() - Serve Admin View ────────────────────────────────────────────────
function doGet(e) {
  // Step 1 — One-time setup: visit ?setup=domain to configure ALLOWED_DOMAIN
  if (e && e.parameter && e.parameter.setup) {
    var domain = String(e.parameter.setup).trim().toLowerCase();
    if (domain) {
      PropertiesService.getScriptProperties().setProperty('ALLOWED_DOMAIN', domain);
      PropertiesService.getScriptProperties().setProperty('DOMAIN', domain);
      return HtmlService.createHtmlOutput(
        '<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f7fb;">' +
        '<div style="text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);">' +
        '<h1 style="color:#065f46;font-size:22px;">Domain Configured</h1>' +
        '<p style="color:#4b5563;margin-top:12px;">ALLOWED_DOMAIN set to <strong>' + escapeHtml_(domain) + '</strong></p>' +
        '</div></body></html>'
      ).setTitle('Setup Complete');
    }
  }

  /* Step 2 — Auto-configure ALLOWED_DOMAIN if not set and user is a known admin */
  var domainProps = PropertiesService.getScriptProperties().getProperty('ALLOWED_DOMAIN');
  if (!domainProps) {
    try {
      var configSheet = getSheet_('InfoSec_Email_Config');
      if (configSheet) {
        var rows = sheetToObjects_(configSheet);
        var userEmail = Session.getActiveUser().getEmail().toLowerCase();
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var memberEmail = String(r.Member_Email || '').trim().toLowerCase();
          if (memberEmail === userEmail) {
            var inferredDomain = userEmail.split('@')[1];
            if (inferredDomain) {
              PropertiesService.getScriptProperties().setProperty('ALLOWED_DOMAIN', inferredDomain);
              PropertiesService.getScriptProperties().setProperty('DOMAIN', inferredDomain);
            }
            break;
          }
        }
      }
    } catch (er) {
      // Sheet might not exist; skip auto-config
    }
  }

  var userEmail = Session.getActiveUser().getEmail();

  // ── Domain Authorization Check (Layer 1) ──
  if (!isAuthorizedDomain(userEmail)) {
    var header = '<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Strictly Access Denied</span><h1>Restricted</h1>';
    var content = '' +
      '<div class="alert alert-danger">Security verification failed. This system is restricted</div>' +
      '<p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Outside of the corporation is strictly access denied. Please switch to your corporate account and try again.</p>' +
      '<p class="email-line">Current account: <strong>' + HtmlService.createHtmlOutput(userEmail).getContent() + '</strong></p>';
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content))
    .setTitle('Access Denied');
  }

  // ── Existing Access Control Check (Layer 2) ──
  var accessResult = checkAccess_(userEmail);
  
  if (!accessResult.allowed) {
    var header = '<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Access Denied</span><h1>Restricted</h1>';
    var content = '' +
      '<div class="alert alert-danger">' + HtmlService.createHtmlOutput(accessResult.reason).getContent() + '</div>' +
      '<p style="color: var(--text2); line-height: 1.6; font-size: 14px;">You are not authorized to access this system. Only authorized ISM administrators (INFOSEC-001 / INFOSEC-002) can proceed.</p>' +
      '<p class="email-line">Current account: <strong>' + HtmlService.createHtmlOutput(userEmail).getContent() + '</strong></p>';
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content))
    .setTitle('Access Denied')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  return HtmlService.createTemplateFromFile('AdminView')
    .evaluate()
    .setTitle('Data Privacy Admin View')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/*
  Function: doPost
  LAYMAN:    Handles POST requests to the Admin web app. There are two real callers:
             the separate Admin Panel project sending JSON commands (with an API key),
             and a legacy DCS submission path. Everything else, or any non-corporate
             account, gets an "Access Denied" page.
  TECHNICAL: GAS web-app POST handler. (1) If the body is application/json with an
             apiKey, parse it and delegate to handleAdminApi_, returning JSON.
             (2) Otherwise enforce the domain gate. (3) If ?action=submitDCS, run the
             submitDCS stub and return JSON. (4) Default: styled access-denied HTML.
  PARAMS:    - e — GAS event; reads e.postData and e.parameter.action.
  RETURNS:   ContentService JSON (API / submitDCS) or HtmlOutput (denied).
  EXAMPLE:   POST {apiKey, action:'getQueueSummary'} -> {success:true, data:{...}}

  STEPS
    Step 1 — JSON API: parse body, dispatch to handleAdminApi_.
    Step 2 — Domain gate for non-API posts.
    Step 3 — Route ?action=submitDCS to submitDCS.
    Step 4 — Default deny.
*/
// ─── doPost() - Handle POST Requests ───────────────────────────────────────────
function doPost(e) {
  // Step 1 — Admin API: detect JSON payloads and route to handleAdminApi_
  var postData = e && e.postData;
  if (postData && postData.type === 'application/json' && postData.contents) {
    try {
      var body = JSON.parse(postData.contents);
      if (body && body.apiKey) {
        var result = handleAdminApi_(body);
        return ContentService.createTextOutput(JSON.stringify(result))
          .setMimeType(ContentService.MimeType.JSON);
      }
    } catch (parseErr) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Invalid JSON payload: ' + parseErr.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  var userEmail = Session.getActiveUser().getEmail();

  // Domain Authorization Check
  if (!isAuthorizedDomain(userEmail)) {
    var header = '<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Strictly Access Denied</span><h1>Restricted</h1>';
    var content = '' +
      '<div class="alert alert-danger">Security verification failed. This system is restricted</div>' +
      '<p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Outside of the corporation is strictly access denied. Please switch to your corporate account and try again.</p>' +
      '<p class="email-line">Current account: <strong>' + HtmlService.createHtmlOutput(userEmail).getContent() + '</strong></p>';
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content))
    .setTitle('Access Denied');
  }

  // Forward to the appropriate POST handler based on request parameter
  var action = e && e.parameter && e.parameter.action ? String(e.parameter.action) : '';
  if (action === 'submitDCS') {
    var payload = e && e.postData ? e.postData.contents : '';
    var result = submitDCS(payload);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Default: return access denied for unrecognized POST actions
  return HtmlService.createHtmlOutput(
    '<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f7fb;">' +
    '<div style="text-align:center;padding:40px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);">' +
    '<h1 style="color:#991b1b;font-size:22px;">Access Denied</h1>' +
    '<p style="color:#4b5563;margin-top:12px;">Invalid request.</p>' +
    '</div></body></html>'
  ).setTitle('Invalid Request');
}

/*
  Function: checkAccess_
  LAYMAN:    Layer-2 gate: confirms the caller is one of the two authorized ISM
             admins (INFOSEC-001 or INFOSEC-002) by matching their email against the
             InfoSec_Email_Config sheet. The domain check already happened before
             this runs.
  TECHNICAL: Requires SPREADSHEET_ID set. Reads InfoSec_Email_Config and allows only
             rows whose Member_ID is INFOSEC-001/002 AND Member_Email matches the
             caller (case-insensitive). Fail-closed: any error or no match denies.
  PARAMS:    - email — the active user's email.
  RETURNS:   {allowed:true} or {allowed:false, reason:string}.
  EXAMPLE:   checkAccess_('ism@companycorp.com') -> {allowed:true}

  STEPS
    Step 1 — Require SPREADSHEET_ID, else deny.
    Step 2 — Scan InfoSec_Email_Config for an INFOSEC-001/002 row matching the email.
    Step 3 — No match -> deny.
*/
// ─── Access Control ────────────────────────────────────────────────────────────
function checkAccess_(email) {
  // Step 1 — SPREADSHEET_ID must be set, or deny immediately
  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) {
    return { allowed: false, reason: 'SPREADSHEET_ID not configured.' };
  }
  
  // 2. Check InfoSec_Email_Config — ONLY INFOSEC-001 or INFOSEC-002 are allowed.
  //    The domain check (Layer 1) already happened in isAuthorizedDomain() before
  //    this function is called, so we only gate on specific member IDs here.
  try {
    var configSheet = getSheet_('InfoSec_Email_Config');
    if (configSheet) {
      var rows = sheetToObjects_(configSheet);
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var memberId = String(r.Member_ID || '').trim();
        var memberEmail = String(r.Member_Email || '').trim().toLowerCase();
        if ((memberId === 'INFOSEC-001' || memberId === 'INFOSEC-002') && memberEmail === email.toLowerCase()) {
          return { allowed: true };
        }
      }
    }
  } catch (e) {
    // InfoSec_Email_Config sheet not found — skip
  }

  // 3. Not an authorized INFOSEC member — deny
  return { allowed: false, reason: 'Access restricted to authorized ISM administrators (INFOSEC-001 / INFOSEC-002).' };
}

/*
  Function: getProp_
  LAYMAN:    One-liner that reads a single Script Property value.
  TECHNICAL: Thin wrapper over PropertiesService.getScriptProperties().getProperty.
  PARAMS:    - key — property name.
  RETURNS:   String value, or null if unset.
*/
// ─── Script Properties Helper ──────────────────────────────────────────────────
function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/*
  Function: isAuthorizedDomain
  LAYMAN:    Layer-1 gate: returns true only if the email ends with the company's
             allowed domain. Outside accounts are turned away.
  TECHNICAL: If ENABLED_DOMAIN_CHECK is false, allows everyone. Otherwise reads
             DOMAIN (then ALLOWED_DOMAIN as fallback) and checks the email ends with
             '@' + that domain (case-insensitive). Fail-secure: missing config or any
             error returns false.
  PARAMS:    - userEmail — the active user's email.
  RETURNS:   Boolean.
  EXAMPLE:   isAuthorizedDomain('a@companycorp.com') -> true
*/
// ─── Domain Authorization ──────────────────────────────────────────────────────
function isAuthorizedDomain(userEmail) {
  if (!ENABLED_DOMAIN_CHECK) return true; // Skip check if disabled for testing
  if (!userEmail) return false;
  try {
    // Try DOMAIN first, then fall back to ALLOWED_DOMAIN
    var domain = getProp_('DOMAIN') || getProp_('ALLOWED_DOMAIN');
    if (!domain) return false;
    return userEmail.toLowerCase().endsWith('@' + domain.toLowerCase());
  } catch (e) {
    // Fail-secure if configuration is missing
    return false;
  }
}

/*
  Function: submitDCS
  LAYMAN:    Placeholder backend submission entry point. Right now it only confirms
             the caller is on the company domain; the actual DCS write lives in the
             Phase 1 project, not here.
  TECHNICAL: Defense-in-depth stub. Re-checks isAuthorizedDomain even on the
             programmatic path (google.script.run / POST), then returns a success
             marker without persisting anything (real logic is a TODO).
  PARAMS:    - payload — raw submission body (currently unused).
  RETURNS:   {success:false, error} if domain fails, else {success:true, message}.
*/
function submitDCS(payload) {
  var userEmail = Session.getActiveUser().getEmail();

  // Domain Authorization Check (Layer 2 — defense-in-depth)
  if (!isAuthorizedDomain(userEmail)) {
    return { success: false, error: 'Unauthorized domain. Access denied.' };
  }

  // TODO: Implement DCS submission logic here.
  // Placeholder — returns success to indicate the gate passed.
  return { success: true, message: 'submitDCS not yet implemented. Domain check passed.' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN REST API — called via JSON POST from the separate Admin Panel project
// ═══════════════════════════════════════════════════════════════════════════════

/*
  Constant: ADMIN_API_KEY
  LAYMAN:    The shared secret the separate Admin Panel project must send with every
             JSON request. Loaded once from Script Properties.
  TECHNICAL: Module-level snapshot of the ADMIN_API_KEY Script Property ('' if unset).
             Compared against request.apiKey in handleAdminApi_.
*/
var ADMIN_API_KEY = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY') || '';

/*
  Function: handleAdminApi_
  LAYMAN:    The switchboard for the JSON REST API. It checks the API key, then runs
             whichever admin action was requested (get the email queue, retry emails,
             read/save notification config, re-route a stage, etc.) and returns the
             result.
  TECHNICAL: Authenticates request.apiKey against ADMIN_API_KEY, then switch()es on
             request.action, forwarding request.params to the matching adminApi_*
             function. Unknown actions and thrown errors return {success:false,error}.
  PARAMS:    - request — {apiKey, action, params}.
  RETURNS:   The chosen handler's result, or an error object.
  EXAMPLE:   handleAdminApi_({apiKey, action:'getQueueSummary', params:{}})
             -> {success:true, data:{...}}

  STEPS
    Step 1 — Reject if apiKey missing or mismatched.
    Step 2 — Dispatch action -> adminApi_* handler.
    Step 3 — Unknown action / caught error -> error object.
*/
function handleAdminApi_(request) {
  try {
    // Authenticate
    var apiKey = String(request.apiKey || '').trim();
    if (!apiKey || !ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
      return { success: false, error: 'Unauthorized: invalid or missing API key.' };
    }

    var action = String(request.action || '').trim();
    var params = request.params || {};

    switch (action) {
      // ── Email Queue ──
      case 'getEmailQueue':
        return adminApi_getEmailQueue(params);
      case 'getQueueSummary':
        return adminApi_getQueueSummary(params);
      case 'getFailedEmails':
        return adminApi_getFailedEmails(params.sinceDays);
      case 'getEmailLog':
        return adminApi_getEmailLog(params.sessionId);
      case 'retryQueuedEmail':
        return adminApi_retryQueuedEmail(params.queueId);
      case 'retryAllForSession':
        return adminApi_retryAllForSession(params.sessionId, params.status);
      case 'cancelQueuedEmails':
        return adminApi_cancelQueuedEmails(params.sessionId, params.type);
      case 'resendEmail':
        return adminApi_resendEmail(params.sessionId, params.recipient, params.type);

      // ── Notification Config ──
      case 'getNotificationConfig':
        return adminApi_getNotificationConfig();
      case 'setNotificationConfig':
        return adminApi_setNotificationConfig(params.config);

      // ── Resend to Stage ──
      case 'resendToStage':
        return adminApi_resendToStage(params.sessionId, params.stageType, params.approverEmail);
      case 'getPipelineView':
        return adminApi_getPipelineView(params.sessionId);

      default:
        return { success: false, error: 'Unknown admin API action: ' + action };
    }
  } catch (e) {
    Logger.log('[ADMIN_API] Unhandled error in handleAdminApi_: ' + e.toString());
    return { success: false, error: 'Internal server error: ' + e.toString() };
  }
}

// ─── Email Queue (Risk_Audit sheet as queue) ───────────────────────────────────

/*
  Function: adminApi_getEmailQueue
  LAYMAN:    Lists the email "queue" for the Admin Panel. There is no real queue
             table — every email attempt is logged in Risk_Audit, so this reads those
             "Email ..." log rows and presents them as queue entries (recipient, type,
             status, attempts, last error), with optional filters.
  TECHNICAL: Reads Risk_Audit via sheetToObjects_, keeps rows whose Action starts with
             'email ', then filters by params.status (Action prefix), params.type and
             params.q (recipient substring) pulled from the InternalFlags JSON. Maps
             each to a queue DTO, applies params.limit, sorts by timestamp desc.
  PARAMS:    - params — {status?, type?, q?, limit?}.
  RETURNS:   {success:true, data:[queueEntry...], count} or {success:false, error}.
  EXAMPLE:   adminApi_getEmailQueue({type:'ism', limit:5})
             -> {success:true, data:[...], count:3}
*/
function adminApi_getEmailQueue(params) {
  try {
    var auditSheet;
    try { auditSheet = getSheet_(SHEET_NAMES.RISK_AUDIT); } catch(e) { return { success: false, error: e.message }; }
    var rows = sheetToObjects_(auditSheet);
    var results = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var actionStr = String(r.Action || '').toLowerCase();
      if (actionStr.indexOf('email ') !== 0) continue;
      if (params.status && actionStr.indexOf(params.status.toLowerCase()) !== 0) continue;
      var flags = {};
      try { flags = JSON.parse(String(r.InternalFlags || '{}')); } catch(e) {}
      var qType = String(flags.type || '');
      var qRecipient = String(flags.recipient || '');
      if (params.type && params.type.toLowerCase() !== qType.toLowerCase()) continue;
      if (params.q && qRecipient.toLowerCase().indexOf(params.q.toLowerCase()) === -1) continue;
      results.push({
        queueId:    String(r.LogID || ''),
        sessionId:  String(r.SessionID || ''),
        recipient:  qRecipient,
        type:       qType,
        status:     String(r.Action || ''),
        attempts:   Number(flags.attempts) || 1,
        lastError:  flags.error || '',
        timestamp:  String(r.Timestamp || ''),
        notifiedAdmin: (String(r.UserAgent || '').indexOf('Admin') !== -1)
      });
    }
    var limit = parseInt(params.limit, 10) || 0;
    if (limit > 0) results = results.slice(0, limit);
    results.sort(function(a,b){ return b.timestamp.localeCompare(a.timestamp); });
    return { success: true, data: results, count: results.length };
  } catch (e) { return { success: false, error: e.toString() }; }
}

/*
  Function: adminApi_getQueueSummary
  LAYMAN:    Computes the small stat tiles at the top of the email-queue page: how
             many sent today, how many failed, cancelled, an overall "health" %, and
             a breakdown by email type.
  TECHNICAL: Reads Risk_Audit, walks 'email ' rows, buckets by Action prefix
             ('email sent'/'email failed'/'email cancelled') and counts sent-today
             against midnight. Tallies flags.type. queueHealth = pending/total * 100.
             (Note: the "pending" tally here counts 'email sent' rows.)
  PARAMS:    - params — unused; kept for signature uniformity.
  RETURNS:   {success:true, data:{totalPending, sentToday, totalFailed,
             totalCancelled, queueHealth, byType}} or {success:false, error}.
*/
function adminApi_getQueueSummary(params) {
  try {
    var ss = getSpreadsheet_();
    var auditSheet;
    try { auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT); } catch(e) { return { success: false, error: e.message }; }
    var rows = sheetToObjects_(auditSheet);
    var sentToday = 0, failed = 0, pending = 0, cancelled = 0;
    var today = new Date();
    today.setHours(0,0,0,0);
    var typeCounts = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var actionStr = String(r.Action || '').toLowerCase();
      if (actionStr.indexOf('email ') !== 0) continue;
      var rowDate = new Date(r.Timestamp);
      if (isNaN(rowDate.getTime())) continue;
      if (actionStr.indexOf('email sent') === 0) {
        pending++;
        if (rowDate >= today) sentToday++;
      } else if (actionStr.indexOf('email failed') === 0) { failed++; }
      else if (actionStr.indexOf('email cancelled') === 0) { cancelled++; }
      var flags = {};
      try { flags = JSON.parse(String(r.InternalFlags || '{}')); } catch(e) {}
      var t = String(flags.type || 'other');
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    var total = pending + failed + cancelled;
    var health = total > 0 ? Math.round((pending / total) * 100) : 100;
    return { success: true, data: {
      totalPending: pending, sentToday: sentToday, totalFailed: failed,
      totalCancelled: cancelled, queueHealth: health, byType: typeCounts
    }};
  } catch (e) { return { success: false, error: e.toString() }; }
}

/*
  Function: adminApi_getFailedEmails
  LAYMAN:    Thin REST alias for the failed-email lookup.
  TECHNICAL: Delegates to adminGetFailedEmails(sinceDays).
  PARAMS:    - sinceDays — lookback window in days.
  RETURNS:   adminGetFailedEmails' result.
*/
function adminApi_getFailedEmails(sinceDays) {
  return adminGetFailedEmails(sinceDays);
}

/*
  Function: adminApi_getEmailLog
  LAYMAN:    Thin REST alias for one session's email log.
  TECHNICAL: Delegates to adminGetEmailLog(sessionId).
  PARAMS:    - sessionId — session/application ID.
  RETURNS:   adminGetEmailLog' result.
*/
function adminApi_getEmailLog(sessionId) {
  return adminGetEmailLog(sessionId);
}

/*
  Function: adminApi_resendEmail
  LAYMAN:    Thin REST alias for resending one email.
  TECHNICAL: Delegates to adminResendEmail(sessionId, recipient, type).
  PARAMS:    - sessionId, recipient, type.
  RETURNS:   adminResendEmail' result.
*/
function adminApi_resendEmail(sessionId, recipient, type) {
  return adminResendEmail(sessionId, recipient, type);
}

// ─── Queue Entry Actions ──────────────────────────────────────────────────────

/*
  Function: adminApi_retryQueuedEmail
  LAYMAN:    Marks one failed email-queue row as "retry": it bumps the attempt
             counter, clears the error, and flips its status to pending so the system
             will try again.
  TECHNICAL: Locates the Risk_Audit row by LogID whose Action starts with
             'Email Failed', increments InternalFlags.attempts, nulls flags.error,
             and sets Action to 'Email Pending (Retried)'. Writes only the two cells.
  PARAMS:    - queueId — the LogID of the failed row.
  RETURNS:   {success:true, message} or {success:false, error} (incl. not-found).
*/
function adminApi_retryQueuedEmail(queueId) {
  // SECURITY: re-authorize the caller — adminApi_* functions are directly callable via google.script.run,
  // bypassing the ADMIN_API_KEY dispatch gate; require an INFOSEC member.
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };
  try {
    var ss = getSpreadsheet_();
    var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
    if (!auditSheet) return { success: false, error: 'Risk_Audit sheet not found.' };
    var data = auditSheet.getDataRange().getValues();
    var header = data[0];
    var logIdIdx = header.indexOf('LogID');
    var actionIdx = header.indexOf('Action');
    var flagsIdx = header.indexOf('InternalFlags');
    if (logIdIdx === -1) return { success: false, error: 'LogID column not found.' };
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][logIdIdx]) === String(queueId) && String(data[i][actionIdx]).indexOf('Email Failed') === 0) {
        if (flagsIdx !== -1) {
          var flags = {};
          try { flags = JSON.parse(String(data[i][flagsIdx] || '{}')); } catch(e) { flags = {}; }
          flags.attempts = (Number(flags.attempts) || 0) + 1;
          flags.error = null;
          auditSheet.getRange(i+1, flagsIdx+1).setValue(JSON.stringify(flags));
        }
        auditSheet.getRange(i+1, actionIdx+1).setValue('Email Pending (Retried)');
        return { success: true, message: 'Queue entry retried.' };
      }
    }
    return { success: false, error: 'Queue entry not found or not in failed state.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

/*
  Function: adminApi_retryAllForSession
  LAYMAN:    Like retryQueuedEmail but for every email row tied to one session
             (optionally only those in a given status). Resets their attempts and
             flips them back to pending.
  TECHNICAL: Scans Risk_Audit for rows matching SessionID (and, if status given, whose
             Action starts with that status). For each, resets InternalFlags.attempts
             to 0, clears error, sets Action to 'Email Pending (Retried)'.
  PARAMS:    - sessionId — required.
             - status — optional Action-prefix filter (e.g. 'Email Failed').
  RETURNS:   {success:true, retried:n, message} or {success:false, error}.
*/
function adminApi_retryAllForSession(sessionId, status) {
  // SECURITY: re-authorize the caller (see adminApi_retryQueuedEmail).
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };
  try {
    if (!sessionId) return { success: false, error: 'Session ID required.' };
    sessionId = String(sessionId).trim();
    var ss = getSpreadsheet_();
    var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
    if (!auditSheet) return { success: false, error: 'Risk_Audit sheet not found.' };
    var data = auditSheet.getDataRange().getValues();
    var header = data[0];
    var sessionIdx = header.indexOf('SessionID');
    var actionIdx = header.indexOf('Action');
    var flagsIdx = header.indexOf('InternalFlags');
    if (sessionIdx === -1 || actionIdx === -1) return { success: false, error: 'Required columns not found.' };
    var retried = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][sessionIdx]) !== sessionId) continue;
      var act = String(data[i][actionIdx]);
      var isTarget = !status || act.toLowerCase().indexOf(status.toLowerCase()) === 0;
      if (!isTarget) continue;
      if (flagsIdx !== -1) {
        var flags = {};
        try { flags = JSON.parse(String(data[i][flagsIdx] || '{}')); } catch(e) { flags = {}; }
        flags.attempts = 0;
        flags.error = null;
        auditSheet.getRange(i+1, flagsIdx+1).setValue(JSON.stringify(flags));
      }
      auditSheet.getRange(i+1, actionIdx+1).setValue('Email Pending (Retried)');
      retried++;
    }
    return { success: true, retried: retried, message: retried + ' queue entries retried.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

/*
  Function: adminApi_cancelQueuedEmails
  LAYMAN:    Cancels the still-active (sent/pending) email rows for a session so they
             won't be retried. Optionally limited to one email type.
  TECHNICAL: Scans Risk_Audit for the session's rows, skips already-cancelled ones,
             targets only Action starting with 'email sent' or 'email pending', and
             (if type given) matches InternalFlags.type. Sets Action to
             'Email Cancelled'.
  PARAMS:    - sessionId — required.
             - type — optional flags.type filter.
  RETURNS:   {success:true, cancelled:n, message} or {success:false, error}.
*/
function adminApi_cancelQueuedEmails(sessionId, type) {
  // SECURITY: re-authorize the caller (see adminApi_retryQueuedEmail).
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };
  try {
    if (!sessionId) return { success: false, error: 'Session ID required.' };
    sessionId = String(sessionId).trim();
    var ss = getSpreadsheet_();
    var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
    if (!auditSheet) return { success: false, error: 'Risk_Audit sheet not found.' };
    var data = auditSheet.getDataRange().getValues();
    var header = data[0];
    var sessionIdx = header.indexOf('SessionID');
    var actionIdx = header.indexOf('Action');
    var flagsIdx = header.indexOf('InternalFlags');
    var cancelled = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][sessionIdx]) !== sessionId) continue;
      var act = String(data[i][actionIdx]).toLowerCase();
      if (act.indexOf('email cancelled') === 0) continue;
      if (act.indexOf('email sent') !== 0 && act.indexOf('email pending') !== 0) continue;
      if (type) {
        if (flagsIdx === -1) continue;
        var f = {};
        try { f = JSON.parse(String(data[i][flagsIdx] || '{}')); } catch(e) {}
        if (String(f.type || '').toLowerCase() !== type.toLowerCase()) continue;
      }
      auditSheet.getRange(i+1, actionIdx+1).setValue('Email Cancelled');
      cancelled++;
    }
    return { success: true, cancelled: cancelled, message: cancelled + ' emails cancelled.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ─── Notification Config ──────────────────────────────────────────────────────

/*
  Function: adminApi_getNotificationConfig
  LAYMAN:    Reads the three notification settings shown on the Admin settings page:
             the admin notify address, whether to alert on failures, and whether to
             notify the requestor.
  TECHNICAL: Scans System_Configuration key/value rows for ADMIN_NOTIFY_EMAIL,
             NOTIFY_ON_FAILURE, NOTIFY_REQUESTOR; YES/NO -> boolean.
  PARAMS:    (none)
  RETURNS:   {success:true, data:{adminEmail, notifyOnFailure, notifyRequestor}}
             or {success:false, error}.
*/
function adminApi_getNotificationConfig() {
  try {
    var sysSheet;
    try { sysSheet = getSheet_(SHEET_NAMES.SYSTEM_CONFIG); } catch(e) { return { success: false, error: e.message }; }
    var rows = sheetToObjects_(sysSheet);
    var config = {};
    for (var i = 0; i < rows.length; i++) {
      var key = String(rows[i].Configuration_Key || '').trim();
      var val = String(rows[i].Value || '').trim();
      if (key === 'ADMIN_NOTIFY_EMAIL') config.adminEmail = val;
      if (key === 'NOTIFY_ON_FAILURE') config.notifyOnFailure = val.toUpperCase() === 'YES';
      if (key === 'NOTIFY_REQUESTOR') config.notifyRequestor = val.toUpperCase() === 'YES';
    }
    return { success: true, data: config };
  } catch (e) { return { success: false, error: e.toString() }; }
}

/*
  Function: adminApi_setNotificationConfig
  LAYMAN:    Saves the notification settings back to the sheet. Updates existing rows
             and appends any setting that doesn't have a row yet.
  TECHNICAL: Maps the config object to ADMIN_NOTIFY_EMAIL / NOTIFY_ON_FAILURE /
             NOTIFY_REQUESTOR (booleans -> YES/NO), rewrites matching
             System_Configuration rows in one setValues, then appendRow for any
             missing keys. Only provided fields are touched.
  PARAMS:    - config — {adminEmail?, notifyOnFailure?, notifyRequestor?}.
  RETURNS:   {success:true, message} or {success:false, error}.
*/
function adminApi_setNotificationConfig(config) {
  // SECURITY: re-authorize the caller — config write (see adminApi_retryQueuedEmail).
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };
  try {
    if (!config || typeof config !== 'object') return { success: false, error: 'config object required.' };
    var ss = getSpreadsheet_();
    var sysSheet;
    try { sysSheet = getSheet_(SHEET_NAMES.SYSTEM_CONFIG); } catch(e) { return { success: false, error: e.message }; }
    var data = sysSheet.getDataRange().getValues();
    var header = data[0];
    var keyIdx = header.indexOf('Configuration_Key');
    var valIdx = header.indexOf('Value');
    if (keyIdx === -1 || valIdx === -1) return { success: false, error: 'System_Configuration columns not found.' };
    var updates = {};
    if (config.adminEmail !== undefined) updates['ADMIN_NOTIFY_EMAIL'] = String(config.adminEmail);
    if (config.notifyOnFailure !== undefined) updates['NOTIFY_ON_FAILURE'] = config.notifyOnFailure ? 'YES' : 'NO';
    if (config.notifyRequestor !== undefined) updates['NOTIFY_REQUESTOR'] = config.notifyRequestor ? 'YES' : 'NO';
    var changed = false;
    for (var i = 1; i < data.length; i++) {
      var k = String(data[i][keyIdx]).trim();
      if (updates[k] !== undefined) {
        data[i][valIdx] = updates[k];
        changed = true;
      }
    }
    if (changed) sysSheet.getDataRange().setValues(data);
    // Append missing keys
    var existing = {};
    for (var j = 1; j < data.length; j++) { existing[String(data[j][keyIdx]).trim()] = true; }
    for (var uk in updates) {
      if (!existing[uk]) sysSheet.appendRow([uk, updates[uk]]);
    }
    return { success: true, message: 'Notification config updated.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ─── Resend to Stage ───────────────────────────────────────────────────────────

/*
  Function: adminApi_resendToStage
  LAYMAN:    Re-sends the notification for a particular stage of a request — the
             department approver, the ISM reviewer, or the Division Head — when an
             email got stuck.
  TECHNICAL: Validates stageType in {approver, ism, divhead}, confirms the
             application exists, then dispatches: 'approver' -> notifyApprover(.,0),
             'ism' -> apiPhase3_NotifyISMember(.,1), 'divhead' -> verifies a
             DivisionHead_Approval_Workflow row then notifyApplicant(., 'Escalated to
             Division Head'). On success, logs an 'Email Resend (Admin API)' audit row.
  PARAMS:    - sessionId — required.
             - stageType — 'approver' | 'ism' | 'divhead'.
             - approverEmail — optional, recorded in the audit flags.
  RETURNS:   The underlying notify result, or {success:false, error}.

  STEPS
    Step 1 — Validate sessionId and stageType.
    Step 2 — Confirm the application exists.
    Step 3 — Dispatch to the stage-appropriate notifier.
    Step 4 — Log audit on success.
*/
function adminApi_resendToStage(sessionId, stageType, approverEmail) {
  try {
    if (!sessionId) return { success: false, error: 'Session ID required.' };
    sessionId = String(sessionId).trim();
    var validStages = ['approver', 'ism', 'divhead'];
    var normalizedStage = String(stageType || '').toLowerCase().trim();
    if (validStages.indexOf(normalizedStage) === -1) {
      return { success: false, error: 'Invalid stage type: ' + stageType + '. Must be approver, ism, or divhead.' };
    }
    var app = getApplicationData(sessionId);
    if (!app) return { success: false, error: 'Application not found.' };
    var result;
    if (normalizedStage === 'approver') {
      result = notifyApprover(sessionId, 0); // first step
    } else if (normalizedStage === 'ism') {
      result = apiPhase3_NotifyISMember(sessionId, 1);
    } else if (normalizedStage === 'divhead') {
      // Re-notify via DH path — write to DivisionHead_Approval_Workflow
      var ss = getSpreadsheet_();
      var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
      if (dhSheet) {
        var dhRows = sheetToObjectsFiltered_(dhSheet, 'SessionID', sessionId);
        if (dhRows.length > 0) {
          result = notifyApplicant(sessionId, 'Escalated to Division Head');
        } else {
          return { success: false, error: 'No Division Head workflow entry found.' };
        }
      } else {
        return { success: false, error: 'Division Head sheet not found.' };
      }
    }
    if (result && result.success) {
      logAuditTrail(sessionId, 'Email Resend (Admin API)', { recipient: approverEmail || 'stage', type: normalizedStage, attempts: 1 });
    }
    return result || { success: false, error: 'Unknown stage.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ─── Pipeline View ─────────────────────────────────────────────────────────────

/*
  Function: adminApi_getPipelineView
  LAYMAN:    Gathers EVERYTHING about one request into a single object for the
             Admin Panel's detail view: the application, each approval stage, the
             email log, and the audit trail.
  TECHNICAL: For a sessionId, loads the Applications row (getApplicationData) plus
             filtered rows from Approval_Workflow, ISM_Approval_Workflow,
             DivisionHead_Approval_Workflow, the email log (adminGetEmailLog) and audit
             logs (getAuditLogs). safeObj_ stringifies every cell to keep the GAS
             return serializable.
  PARAMS:    - sessionId — required.
  RETURNS:   {success:true, data:{application, approvals, ismWorkflow,
             divHeadWorkflow, emailQueue, auditTrail}} or {success:false, error}.

  STEPS
    Step 1 — Load application (404 if missing).
    Step 2-4 — Load approval / ISM / DivHead workflow rows.
    Step 5-6 — Load email log and audit trail.
*/
function adminApi_getPipelineView(sessionId) {
  try {
    if (!sessionId) return { success: false, error: 'Session ID required.' };
    sessionId = String(sessionId).trim();
    var ss = getSpreadsheet_();

    // 1. Application
    var app = getApplicationData(sessionId);
    if (!app) return { success: false, error: 'Application not found.' };

    // 2. Approval Workflow
    var approvals = [];
    try {
      var awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
      if (awSheet) approvals = sheetToObjectsFiltered_(awSheet, 'SessionID', sessionId);
    } catch(e) {}

    // 3. ISM Workflow
    var ismEntries = [];
    try {
      var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
      if (ismSheet) ismEntries = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);
    } catch(e) {}

    // 4. Division Head Workflow
    var dhEntries = [];
    try {
      var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
      if (dhSheet) dhEntries = sheetToObjectsFiltered_(dhSheet, 'SessionID', sessionId);
    } catch(e) {}

    // 5. Email Queue
    var emailLog = adminGetEmailLog(sessionId);
    var emailEntries = (emailLog && emailLog.success) ? emailLog.data : [];

    // 6. Audit Trail
    var auditResult = getAuditLogs(app.Linked_ReqID || '', sessionId);
    var auditLogs = (auditResult && auditResult.success) ? auditResult.auditLogs : [];

    function safeObj_(row) {
      if (!row) return {};
      var o = {};
      Object.keys(row).forEach(function(k){ o[k] = String(row[k] || ''); });
      return o;
    }

    return { success: true, data: {
      application: safeObj_(app),
      approvals: approvals.map(safeObj_),
      ismWorkflow: ismEntries.map(safeObj_),
      divHeadWorkflow: dhEntries.map(safeObj_),
      emailQueue: emailEntries,
      auditTrail: auditLogs
    }};
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ─── Sheet Helpers ─────────────────────────────────────────────────────────────
/*
  Function: getSpreadsheet_
  LAYMAN:    Opens the one shared database spreadsheet.
  TECHNICAL: Reads SPREADSHEET_ID from Script Properties and opens it by ID; throws
             if the property is missing.
  PARAMS:    (none)
  RETURNS:   Spreadsheet object (throws on missing ID).
*/
function getSpreadsheet_() {
  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('SPREADSHEET_ID not set in Script Properties.');
  return SpreadsheetApp.openById(ssId);
}

/*
  Function: getSheet_
  LAYMAN:    Finds a tab by name. Tries the plain name first, then a prefixed version
             for older databases.
  TECHNICAL: ss.getSheetByName(name) then getSheetByName(getPrefix()+name); throws a
             descriptive error if neither resolves.
  PARAMS:    - name — bare tab name (usually a SHEET_NAMES value).
  RETURNS:   Sheet object (throws if not found).
*/
function getSheet_(name) {
  var ss = getSpreadsheet_();
  var prefix = getPrefix();
  
  // Try exact name first (most common — sheets usually have no prefix)
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  
  // Fall back to prefixed name (legacy sheets)
  sheet = ss.getSheetByName(prefix + name);
  if (sheet) return sheet;
  
  throw new Error('Sheet not found. Tried "' + name + '" and "' + prefix + name + '".');
}

/*
  Function: forceAuthorize
  LAYMAN:    A one-click "wake up the permissions" helper. Run it once from the editor
             when emails stop sending or sheets won't open; it touches every Google
             service so Apps Script prompts you to re-approve the needed scopes.
  TECHNICAL: Calls a harmless method on MailApp, SpreadsheetApp, DriveApp,
             UrlFetchApp and PropertiesService to force the OAuth consent for all
             scopes the app uses. Re-deploy afterward so new scopes apply to all users.
  PARAMS:    (none)
  RETURNS:   {success:true, message}.
*/
function forceAuthorize() {
  // MailApp — email sending
  MailApp.getRemainingDailyQuota();
  // SpreadsheetApp — reading/writing sheets
  var ss = getSpreadsheet_();
  SpreadsheetApp.setActiveSpreadsheet(ss);
  // DriveApp — file name lookups in getAdminData
  DriveApp.getRootFolder().getName();
  // UrlFetchApp — PIA cross-project API calls
  UrlFetchApp.getRequest('https://script.google.com');
  // PropertiesService — script properties
  PropertiesService.getScriptProperties().getKeys();
  Logger.log('[AUTH] forceAuthorize completed — all scopes touched successfully.');
  return { success: true, message: 'Authorization check complete. Re-deploy the web app if scopes changed.' };
}

/*
  Function: ping
  LAYMAN:    A quick "is the database reachable?" check the frontend can call first.
  TECHNICAL: Attempts getSpreadsheet_() and reports success/failure.
  PARAMS:    (none)
  RETURNS:   {success:true, message} or {success:false, error}.
*/
function ping() {
  try {
    getSpreadsheet_();
    return { success: true, message: 'Spreadsheet accessible.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/*
  Function: getAdminDataDebug
  LAYMAN:    A diagnostics report that tells you which expected tabs exist (and their
             row counts), both with and without the name prefix. Handy when the
             dashboard comes up empty.
  TECHNICAL: Opens the spreadsheet, probes the five core sheets by bare and prefixed
             names, and returns a status string per sheet.
  PARAMS:    (none)
  RETURNS:   {success:true, debug:{...}} or {success:false, error}.
*/
function getAdminDataDebug() {
  try {
    var info = { steps: [] };
    
    info.steps.push('getSpreadsheet_');
    var ss = getSpreadsheet_();
    
    info.steps.push('Testing sheet access...');
    var testNames = ['Data_Collection', 'Applications', 'Approval_Workflow', 'ISM_Approval_Workflow', 'DivisionHead_Approval_Workflow'];
    for (var i = 0; i < testNames.length; i++) {
      try {
        var s = ss.getSheetByName(testNames[i]);
        info[testNames[i]] = s ? 'FOUND (rows: ' + s.getLastRow() + ')' : 'NOT FOUND';
      } catch (e) {
        info[testNames[i]] = 'ERROR: ' + e.message;
      }
    }
    
    // Test with prefix too
    var prefix = getPrefix();
    info.prefix = prefix;
    for (var i = 0; i < testNames.length; i++) {
      try {
        var s = ss.getSheetByName(prefix + testNames[i]);
        info['PREFIX_' + testNames[i]] = s ? 'FOUND' : 'not found';
      } catch (e) {
        info['PREFIX_' + testNames[i]] = 'ERROR: ' + e.message;
      }
    }
    
    return { success: true, debug: info };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/*
  Function: sheetToObjects_
  LAYMAN:    Turns a whole sheet into a list of row objects, using the header row as
             the keys. The workhorse for reading data everywhere in this file.
  TECHNICAL: getDataRange().getValues(); first row = headers; each subsequent row
             becomes {header: cellValue}. Returns [] for empty/header-only sheets.
             Values stay raw (Dates, numbers) — callers stringify as needed.
  PARAMS:    - sheet — a Sheet object.
  RETURNS:   Array of plain objects (possibly empty).
*/
function sheetToObjects_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];
  var header = data[0];
  var rows = data.slice(1);
  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var obj = {};
    for (var j = 0; j < header.length; j++) {
      obj[header[j]] = rows[i][j];
    }
    result.push(obj);
  }
  return result;
}

/*
  Function: sheetToObjectsFiltered_
  LAYMAN:    Same as sheetToObjects_ but only returns rows where one column equals a
             given value (e.g. all rows for a SessionID).
  TECHNICAL: Finds filterKey's column index; returns [] if the column is missing.
             String-compares each row's value to filterValue.
  PARAMS:    - sheet, filterKey (column name), filterValue (compared as string).
  RETURNS:   Array of matching row objects (possibly empty).
*/
function sheetToObjectsFiltered_(sheet, filterKey, filterValue) {
  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return [];
  var header = data[0];
  var idx = header.indexOf(filterKey);
  if (idx === -1) return [];
  var rows = data.slice(1);
  var result = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idx]) === String(filterValue)) {
      var obj = {};
      for (var j = 0; j < header.length; j++) {
        obj[header[j]] = rows[i][j];
      }
      result.push(obj);
    }
  }
  return result;
}

/*
  Function: debugSheets
  LAYMAN:    Lists the real tab names in the spreadsheet — useful for spotting a typo
             or rename.
  TECHNICAL: Iterates ss.getSheets() and returns their names.
  PARAMS:    (none)
  RETURNS:   {success:true, sheets:[name...]} or {success:false, error}.
*/
// ─── Debug: list actual sheet names ────────────────────────────────────────────
function debugSheets() {
  try {
    var ss = getSpreadsheet_();
    var sheets = ss.getSheets();
    var names = [];
    for (var i = 0; i < sheets.length; i++) {
      names.push(sheets[i].getName());
    }
    return { success: true, sheets: names };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/*
  Function: getAdminData
  LAYMAN:    The big one. Builds the entire admin dashboard table: it reads the DCS
             requests, the PIA applications, and all the approval sheets, then stitches
             them together one row per request — name, department, access type, DCS
             status, PIA progress, approval status, dates — plus the raw data each
             modal needs. It also swaps stored Drive file IDs for real file names.
  TECHNICAL: Single-pass join. Reads Data_Collection, Applications, Approval_Workflow,
             ISM_Approval_Workflow, DivisionHead_Approval_Workflow; builds lookup maps
             keyed by ReqID/SessionID; for up to MAX_ROWS (500) DCS rows computes
             piaStatus / approvalStatus / pia display via the compute*_ helpers and
             produces string-only POJOs (dcsData/piaData) so the GAS return never
             carries Date/object values. FileID and Metadata_Agency JSON are parsed and
             Drive file names resolved (cached). EVERYTHING is wrapped in try/catch
             because GAS V8 returns null on any uncaught throw.
  PARAMS:    (none)
  RETURNS:   {success:true, data:[row...]} or {success:false, error}.

  STEPS
    Step 1 — Validate spreadsheet access.
    Step 2 — Read all five sheets (each individually validated).
    Step 3 — Build ReqID/SessionID lookup maps.
    Step 4 — For each DCS row: join, compute statuses, serialize to safe POJOs.
*/
// ─── getAdminData() - Main Data Fetch ──────────────────────────────────────────
function getAdminData() {
  // CRITICAL: outer try-catch wrapping EVERYTHING. GAS V8 returns null if any
  // unhandled error propagates out of the function, even though this shouldn't
  // happen according to the spec. We've seen it happen repeatedly.
  try {
    // Helper to get file name from Drive, with caching to avoid repeated API calls for the same file.
    var driveNameCache = {};
    function getCachedDriveFileName_(fileId) {
      if (!fileId || typeof fileId !== 'string') return null;
      if (driveNameCache[fileId]) return driveNameCache[fileId];
      try {
        var name = DriveApp.getFileById(fileId).getName();
        driveNameCache[fileId] = name;
        return name;
      } catch (e) {
        // Cache the failure to avoid retrying for a file that doesn't exist or we can't access.
        driveNameCache[fileId] = 'File not found';
        return 'File not found';
      }
    }

    // Helper to recursively find and update file names in an object/array
    function updateFileNamesRecursive_(data) {
      if (Array.isArray(data)) {
        data.forEach(updateFileNamesRecursive_);
      } else if (data && typeof data === 'object') {
        if (data.id && data.hasOwnProperty('name')) {
          // This looks like a file object: {id: '...', name: '...'}
          var driveName = getCachedDriveFileName_(data.id);
          if (driveName) data.name = driveName;
        } else {
          // Recurse into other properties for nested objects
          Object.keys(data).forEach(function(key) { updateFileNamesRecursive_(data[key]); });
        }
      }
    }

    var dcSheet, dcRows, appSheet, appRows, awSheet, awRows, ismSheet, ismRows, dhSheet, dhRows;
    
    // ── Step 1: Validate spreadsheet access ──
    try {
      var ss = getSpreadsheet_();
    } catch (e) {
      return { success: false, error: 'getAdminData: SPREADSHEET_ID invalid or inaccessible: ' + e.message };
    }
    
    // ── Step 2: Read all sheets with individual validation ──
    try {
      dcSheet = ss.getSheetByName(SHEET_NAMES.DATA_COLLECTION);
      if (!dcSheet) return { success: false, error: 'getAdminData: Sheet "' + SHEET_NAMES.DATA_COLLECTION + '" not found.' };
      dcRows = sheetToObjects_(dcSheet);
    } catch (e) {
      return { success: false, error: 'getAdminData: Failed reading Data_Collection: ' + e.message };
    }
    
    try {
      appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
      if (!appSheet) return { success: false, error: 'getAdminData: Sheet "' + SHEET_NAMES.APPLICATIONS + '" not found.' };
      appRows = sheetToObjects_(appSheet);
    } catch (e) {
      return { success: false, error: 'getAdminData: Failed reading Applications: ' + e.message };
    }
    
    try {
      awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
      if (!awSheet) return { success: false, error: 'getAdminData: Sheet "' + SHEET_NAMES.APPROVAL_WORKFLOW + '" not found.' };
      awRows = sheetToObjects_(awSheet);
    } catch (e) {
      return { success: false, error: 'getAdminData: Failed reading Approval_Workflow: ' + e.message };
    }
    
    try {
      ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
      if (!ismSheet) return { success: false, error: 'getAdminData: Sheet "' + SHEET_NAMES.ISM_APPROVAL + '" not found.' };
      ismRows = sheetToObjects_(ismSheet);
    } catch (e) {
      return { success: false, error: 'getAdminData: Failed reading ISM_Approval_Workflow: ' + e.message };
    }
    
    try {
      dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
      if (!dhSheet) return { success: false, error: 'getAdminData: Sheet "' + SHEET_NAMES.DIVHEAD_APPROVAL + '" not found.' };
      dhRows = sheetToObjects_(dhSheet);
    } catch (e) {
      return { success: false, error: 'getAdminData: Failed reading DivisionHead_Approval_Workflow: ' + e.message };
    }
    
    // ── Step 3: Build lookup maps ──
    var appByReqId = {};
    var appBySessionId = {};
    for (var i = 0; i < appRows.length; i++) {
      var a = appRows[i];
      if (a.Linked_ReqID) appByReqId[a.Linked_ReqID] = a;
      if (a.SessionID) appBySessionId[a.SessionID] = a;
    }
    
    var apprBySessionId = {};
    for (var i = 0; i < awRows.length; i++) {
      var a = awRows[i];
      if (!apprBySessionId[a.SessionID]) apprBySessionId[a.SessionID] = [];
      apprBySessionId[a.SessionID].push(a);
    }
    
    var ismBySessionId = {};
    for (var i = 0; i < ismRows.length; i++) {
      var item = ismRows[i];
      if (!ismBySessionId[item.SessionID]) ismBySessionId[item.SessionID] = [];
      ismBySessionId[item.SessionID].push(item);
    }
    
    var dhBySessionId = {};
    for (var i = 0; i < dhRows.length; i++) {
      var d = dhRows[i];
      if (!dhBySessionId[d.SessionID]) dhBySessionId[d.SessionID] = [];
      dhBySessionId[d.SessionID].push(d);
    }
    
    // ── Step 4: Build joined rows ──
    var MAX_ROWS = 500;
    var rows = [];
    var limit = Math.min(dcRows.length, MAX_ROWS);
    for (var i = 0; i < limit; i++) {
      var dc = dcRows[i];
      var meta = {};
      try {
        meta = parseMetadata_(dc.Metadata_JSON);
      } catch (e2) {
        meta = {};
      }
      var app = appByReqId[dc.ReqID] || appBySessionId[dc.ReqID] || null;
      var sessionId = app ? app.SessionID : null;
      var approvals = sessionId ? (apprBySessionId[sessionId] || []) : [];
      var ismApprovals = sessionId ? (ismBySessionId[sessionId] || []) : [];
      var dhApprovals = sessionId ? (dhBySessionId[sessionId] || []) : [];
      
      var piaStatus = 'Unknown';
      // PIA Status column: use the application's own Status from Applications sheet
      // (the authoritative status from the status flow document).
      // Falls back to PIA form completion check only if no application exists.
      try { 
        if (app && app.Status && String(app.Status).trim()) {
          piaStatus = String(app.Status).trim();
        } else {
          piaStatus = computePiaStatus_(app);
        }
      } catch (e2) { piaStatus = 'Error'; }
      var approvalStatus = 'Pending';
      // Pass the app object so computeApprovalStatus_ can check app.Status directly
      try { approvalStatus = computeApprovalStatus_(app, approvals, ismApprovals, dhApprovals); } catch (e2) { approvalStatus = 'Error'; }
      var pia = '\u2014';
      try { pia = computePiaDisplay_(app, sessionId); } catch (e2) { pia = 'Error'; }
      
      // Convert raw sheet row to safe POJO — sheet cells may contain Date objects
      // or other non-serializable values that crash the GAS return path.
      var safeDcsData = {};
      try {
        var dcKeys = Object.keys(dc);
        for (var k = 0; k < dcKeys.length; k++) {
          var keyName = dcKeys[k];
          var val = dc[keyName];
          if ((keyName === 'FileID' || keyName === 'Metadata_Agency') && val && typeof val === 'string' && (val.trim().startsWith('[') || val.trim().startsWith('{'))) {
            try {
              var parsedData = JSON.parse(val);
              updateFileNamesRecursive_(parsedData);
              safeDcsData[keyName] = JSON.stringify(parsedData);
            } catch (e) {
              safeDcsData[keyName] = String(val); // Fallback if not valid JSON
            }
          } else if (val instanceof Date) {
            safeDcsData[keyName] = val.toISOString();
          } else {
            safeDcsData[keyName] = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val);
          }
        }
      } catch (e2) { safeDcsData = { _error: 'Failed to serialize' }; }
      
      var safePiaData = null;
      if (app) {
        safePiaData = {};
        try {
          var appKeys = Object.keys(app);
          for (var k = 0; k < appKeys.length; k++) {
            var val = app[appKeys[k]];
            if (val instanceof Date) safePiaData[appKeys[k]] = val.toISOString();
            else safePiaData[appKeys[k]] = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : String(val);
          }
        } catch (e2) { safePiaData = { _error: 'Failed to serialize' }; }
      }
      
      rows.push({
        reqId:          String(dc.ReqID || ''),
        logId:          String(dc.LogID || ''),
        name:           String(meta.name || ''),
        location:       String(meta.location || ''),
        dept:           String(meta.dept || ''),
        accessType:     String(meta.access || ''),
        dcs:            String(dc.LogID || ''),
        dcsStatus:      normalizeDcsStatus_(dc.Status),
        pia:            String(pia),
        piaStatus:      String(piaStatus),
        emailApproval:  String(app ? String(app.Status || 'Pending') : (approvalStatus || 'Pending')),
        date:           String(dc.Timestamp || ''),
        sessionId:      String(sessionId || ''),
        applicantEmail: String(dc.UserEmail || ''),
        // Raw data for modals — safe string-only objects
        dcsData:        safeDcsData,
        piaData:        safePiaData
      });
    }
    
    return { success: true, data: rows };
  } catch (e) {
    // Absolute last resort — catch ANYTHING that might have escaped
    return { success: false, error: 'getAdminData: [FATAL] ' + e.message };
  }
}

// ─── Parsing Helpers ───────────────────────────────────────────────────────────
/*
  Function: parseMetadata_
  LAYMAN:    Safely turns a Metadata_JSON cell into an object; returns {} if it's
             empty or unparseable.
  TECHNICAL: JSON.parse if string; passes through if already an object; {} on error.
  PARAMS:    - jsonStr — string or object.
  RETURNS:   Object (never null).
*/
function parseMetadata_(jsonStr) {
  if (!jsonStr) return {};
  try {
    if (typeof jsonStr === 'string') return JSON.parse(jsonStr);
    return jsonStr;
  } catch (e) {
    return {};
  }
}

/*
  Function: normalizeDcsStatus_
  LAYMAN:    Cleans up the DCS status text so the dashboard shows one consistent label.
             "COMPLETE", "Complete", "completed" all become "DCS Completed".
  TECHNICAL: Uppercases and maps COMPLETE/COMPLETED -> 'DCS Completed'; otherwise
             returns the trimmed original or 'Unknown'.
  PARAMS:    - rawStatus — the stored Data_Collection.Status value.
  RETURNS:   Display string.
*/
function normalizeDcsStatus_(rawStatus) {
  var s = String(rawStatus || '').trim();
  var upper = s.toUpperCase();
  if (upper === 'COMPLETE' || upper === 'COMPLETED') return 'DCS Completed';
  return s || 'Unknown';
}

/*
  Function: computePiaStatus_
  LAYMAN:    Works out how far along the PIA questionnaire is: Not Started, In
             Progress, or Complete — used only as a fallback when the application has
             no explicit Status.
  TECHNICAL: Inspects PIA_1_Data..PIA_5_Data. A section counts as completed if its
             cell text is COMPLETED/COMPLETE/APPROVED, or its JSON .status is one of
             those, or it is malformed JSON (lenient). Complete when completed===total
             of the filled sections.
  PARAMS:    - app — Applications row object (or null).
  RETURNS:   'No Application' | 'Not Started' | 'In Progress' | 'Complete'.
*/
function computePiaStatus_(app) {
  if (!app) return 'No Application';
  var piaFields = ['PIA_1_Data', 'PIA_2_Data', 'PIA_3_Data', 'PIA_4_Data', 'PIA_5_Data'];
  var completed = 0;
  var total = 0;
  for (var f = 0; f < piaFields.length; f++) {
    var val = app[piaFields[f]];
    if (val && String(val).trim()) {
      total++;
      var cellStr = String(val).trim();
      var cellUpper = cellStr.toUpperCase();
      // Direct cell value match (some sheets store status directly)
      if (cellUpper === 'COMPLETED' || cellUpper === 'COMPLETE' || cellUpper === 'APPROVED') {
        completed++;
        continue;
      }
      // Try parsing as JSON and reading internal status
      try {
        var p = (typeof val === 'string') ? JSON.parse(val) : val;
        var ps = String(p.status || '').toLowerCase();
        if (ps === 'completed' || ps === 'complete' || ps === 'approved') {
          completed++;
        }
        // If ps is a non-empty string that's not a completion status — not counted
      } catch (e) {
        // Not JSON, not a direct status keyword.
        // If it looks like JSON (starts with { or [), it's malformed — count as completed
        if (cellStr.charAt(0) === '{' || cellStr.charAt(0) === '[') completed++;
      }
    }
  }
  if (total === 0) return 'Not Started';
  if (completed === total) return 'Complete';
  return 'In Progress';
}

/*
  Function: computePiaDisplay_
  LAYMAN:    Produces the little "3/5 Submitted" badge text for the PIA column, or a
             dash when nothing's filled.
  TECHNICAL: Counts non-empty PIA_1..5_Data cells; returns 'n/5 Submitted' or an
             em-dash. sessionId is currently unused.
  PARAMS:    - app \u2014 Applications row (or null).
             - sessionId \u2014 unused.
  RETURNS:   Display string.
*/
function computePiaDisplay_(app, sessionId) {
  if (!app) return '\u2014';
  var piaFields = ['PIA_1_Data', 'PIA_2_Data', 'PIA_3_Data', 'PIA_4_Data', 'PIA_5_Data'];
  var filled = 0;
  for (var f = 0; f < piaFields.length; f++) {
    var val = app[piaFields[f]];
    if (val && String(val).trim()) filled++;
  }
  return filled > 0 ? filled + '/5 Submitted' : '\u2014';
}

/*
  Function: computeApprovalStatus_
  LAYMAN:    Decides the single approval label shown per row: Pending, In Progress,
             Approved, or Denied. It trusts the application's own Status first, then
             falls back to reading the individual approver decisions.
  TECHNICAL: If app.Status is terminal ('Approved by ISM' -> Approved; 'Rejected by'
             /'Denied' -> Denied; 'Escalated to Division Head' -> In Progress), use it.
             Otherwise collects each row's Status||Decision across approvals / ISM /
             DivHead: any Denied/Rejected/Return(ed) -> 'Denied'; all 'Approved' ->
             'Approved'; none -> 'Pending'; mixed -> 'In Progress'.
  PARAMS:    - app — Applications row (or null).
             - approvals, ismApprovals, dhApprovals — arrays of workflow rows.
  RETURNS:   'Pending' | 'In Progress' | 'Approved' | 'Denied'.
*/
function computeApprovalStatus_(app, approvals, ismApprovals, dhApprovals) {
  // FIRST: check the application's own Status column — it's the authoritative signal
  if (app) {
    var appStatus = String(app.Status || '').trim();
    // Terminal statuses from the application override workflow computation
    if (appStatus === 'Approved by ISM' || appStatus.indexOf('Approved by ISM') !== -1) return 'Approved';
    if (appStatus === 'Rejected by ISM' || appStatus.indexOf('Rejected by') !== -1) return 'Denied';
    if (appStatus === 'Denied') return 'Denied';
    if (appStatus === 'Escalated to Division Head') return 'In Progress';
  }

  // SECOND: compute from individual workflow decisions
  var decisions = [];
  function getDec_(row) {
    return String(row.Status || row.Decision || '').trim();
  }
  for (var i = 0; i < approvals.length; i++) {
    var d = getDec_(approvals[i]);
    if (d) decisions.push(d);
  }
  for (var i = 0; i < ismApprovals.length; i++) {
    var d = getDec_(ismApprovals[i]);
    if (d) decisions.push(d);
  }
  for (var i = 0; i < dhApprovals.length; i++) {
    var d = getDec_(dhApprovals[i]);
    if (d) decisions.push(d);
  }
  if (decisions.length === 0) return 'Pending';
  for (var i = 0; i < decisions.length; i++) {
    if (decisions[i] === 'Denied' || decisions[i] === 'Rejected' || decisions[i] === 'Deny' || decisions[i] === 'Return' || decisions[i] === 'Returned') return 'Denied';
  }
  var allApproved = true;
  for (var i = 0; i < decisions.length; i++) {
    if (decisions[i] !== 'Approved') { allApproved = false; break; }
  }
  if (allApproved) return 'Approved';
  return 'In Progress';
}

/*
  Function: getAuditLogs
  LAYMAN:    Pulls the audit/history rows for one request, plus the approval-stage rows,
             so the Admin Panel can show a timeline. Matches by SessionID when known,
             otherwise by ReqID, and deliberately returns nothing if given neither (so
             it never leaks the whole log).
  TECHNICAL: Reads Risk_Audit. If sessionId, filters by SessionID column; else if
             reqId, matches SessionID OR an InternalFlags substring (different event
             types store IDs in different columns); else returns empty. When sessionId
             is present, also loads filtered Approval / ISM / DivHead rows. safeRow_
             stringifies every cell.
  PARAMS:    - reqId — linked DCS ReqID (used when sessionId absent).
             - sessionId — preferred key.
  RETURNS:   {success:true, auditLogs, approvals, ismApprovals, dhApprovals}
             or {success:false, error}.

  STEPS
    Step 1 — Open sheet; read Risk_Audit.
    Step 2 — Filter rows by sessionId, then reqId, else empty.
    Step 3 — If sessionId, attach the three workflow row sets.
*/
// ─── getAuditLogs() ────────────────────────────────────────────────────────────
function getAuditLogs(reqId, sessionId) {
  try {
    var ss;
    try {
      ss = getSpreadsheet_();
    } catch (e) {
      return { success: false, error: 'getAuditLogs: SPREADSHEET_ID invalid: ' + e.message };
    }
    
    var auditSheet, auditRows;
    try {
      auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
      if (!auditSheet) return { success: false, error: 'getAuditLogs: Sheet "' + SHEET_NAMES.RISK_AUDIT + '" not found.' };
      auditRows = sheetToObjects_(auditSheet);
    } catch (e) {
      return { success: false, error: 'getAuditLogs: Failed reading Risk_Audit: ' + e.message };
    }
    
    if (sessionId) {
      // Filter by SessionID (primary path — entry has a linked Application)
      var filtered = [];
      for (var i = 0; i < auditRows.length; i++) {
        var rowSessionId = String(auditRows[i].SessionID || '');
        if (rowSessionId === String(sessionId)) {
          filtered.push(auditRows[i]);
        }
      }
      auditRows = filtered;
    } else if (reqId) {
      // No SessionID — filter by ReqID instead.
      // Different audit event types store identifiers in different columns:
      //   DELETE_ENTRY → SessionID column (sessionId || reqId)
      //   ADMIN_REROUTE → InternalFlags column (linkedReqId)
      //   STATUS_* → InternalFlags may contain reqId/sessionId
      var filtered = [];
      for (var i = 0; i < auditRows.length; i++) {
        var rowSessionId = String(auditRows[i].SessionID || '');
        var rowFlags = String(auditRows[i].InternalFlags || '');
        if (rowSessionId === String(reqId) ||
            rowFlags.indexOf(String(reqId)) !== -1 ||
            rowFlags.indexOf(String(sessionId || '')) !== -1) {
          filtered.push(auditRows[i]);
        }
      }
      auditRows = filtered;
    } else {
      // Neither sessionId nor reqId — return nothing instead of leaking all logs
      auditRows = [];
    }

    // Helper to safely serialize a row: convert every value to string
    function safeRow_(row) {
      if (!row) return null;
      var out = {};
      var keys = Object.keys(row);
      for (var k = 0; k < keys.length; k++) {
        out[keys[k]] = String(row[keys[k]]);
      }
      return out;
    }

    var approvals = [];
    var ismApprovals = [];
    var dhApprovals = [];

    if (sessionId) {
      try {
        var awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
        if (awSheet) {
          var raw = sheetToObjectsFiltered_(awSheet, 'SessionID', sessionId);
          approvals = raw.map(safeRow_);
        }
      } catch (e) {}
      try {
        var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
        if (ismSheet) {
          var raw = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);
          ismApprovals = raw.map(safeRow_);
        }
      } catch (e) {}
      try {
        var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
        if (dhSheet) {
          var raw = sheetToObjectsFiltered_(dhSheet, 'SessionID', sessionId);
          dhApprovals = raw.map(safeRow_);
        }
      } catch (e) {}
    }

    return {
      success: true,
      auditLogs: auditRows.map(safeRow_),
      approvals: approvals,
      ismApprovals: ismApprovals,
      dhApprovals: dhApprovals
    };
  } catch (e) {
    return { success: false, error: 'getAuditLogs: [FATAL] ' + e.message };
  }
}

/*
  Function: deleteEntry
  LAYMAN:    Permanently removes one request from the system — its DCS row, its
             application, all its approval-stage rows, and its old audit logs — then
             writes a single DELETE_ENTRY record and (optionally) emails the requestor
             to tell them it was removed.
  TECHNICAL: Captures requestor email + a display name from Data_Collection BEFORE
             deleting that row. Deletes the Applications row by SessionID, then the
             three workflow sheets via deleteRowsBySessionId_. Purges linked Risk_Audit
             rows, appends a DELETE_ENTRY audit row (actor = active user). If sendEmail,
             sends a styled notice via sendEmailWithRetry_ + buildAdminEmailHtml_.
             Whole thing is try/catch wrapped.
  PARAMS:    - reqId, logId — identify the DCS row (either may match).
             - sessionId — links the application + workflow + audit rows (optional).
             - sendEmail — whether to email the requestor.
             - ismComment — optional note included in the email/audit.
  RETURNS:   {success:true, message, emailSent} or {success:false, error}.

  STEPS
    Step 1 — Capture requestor info, then delete the Data_Collection row.
    Step 2 — Delete Applications + the three workflow sheets by SessionID.
    Step 3 — Purge old audit rows, then append the DELETE_ENTRY record.
    Step 4 — Optionally email the requestor.
*/
// ─── deleteEntry() ─────────────────────────────────────────────────────────────
// Extracts the requestor email FROM the row before deleting, so we can notify them.
function deleteEntry(reqId, logId, sessionId, sendEmail, ismComment) {
  // SECURITY (F-01): re-authorize the caller server-side — doGet's INFOSEC gate does NOT protect a
  // direct google.script.run call to this function. Same checkAccess_ idiom as doGet.
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };

  // Normalise optional params
  sendEmail = !!sendEmail;
  ismComment = String(ismComment || '').trim();

  try {
    var ss;
    try { ss = getSpreadsheet_(); } catch (e) { return { success: false, error: 'deleteEntry: SPREADSHEET_ID invalid: ' + e.message }; }
    
    var dcSheet = ss.getSheetByName(SHEET_NAMES.DATA_COLLECTION);
    if (!dcSheet) return { success: false, error: 'deleteEntry: Data_Collection sheet not found.' };
    var dcData = dcSheet.getDataRange().getValues();
    var header = dcData[0];
    var reqIdIdx   = header.indexOf('ReqID');
    var logIdIdx   = header.indexOf('LogID');
    var emailIdx   = header.indexOf('UserEmail');
    var statusIdx  = header.indexOf('Status');
    var metaIdx    = header.indexOf('Metadata_JSON');

    // Capture requestor info BEFORE deletion
    var requestorEmail = '';
    var entryName = '';
    for (var i = dcData.length - 1; i >= 1; i--) {
      if (String(dcData[i][reqIdIdx]) === String(reqId) || String(dcData[i][logIdIdx]) === String(logId)) {
        if (emailIdx > -1) requestorEmail = String(dcData[i][emailIdx] || '').trim();
        if (metaIdx > -1) {
          try {
            var meta = JSON.parse(dcData[i][metaIdx] || '{}');
            entryName = meta.name || meta.program || '';
          } catch (e) {}
        }
        if (!entryName && statusIdx > -1) entryName = 'ReqID ' + dcData[i][reqIdIdx];
        dcSheet.deleteRow(i + 1);
        break;
      }
    }

    if (sessionId) {
      try {
        var appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
        if (appSheet) {
          var appData = appSheet.getDataRange().getValues();
          var appHeader = appData[0];
          var sessionIdx = appHeader.indexOf('SessionID');
          for (var j = appData.length - 1; j >= 1; j--) {
            if (String(appData[j][sessionIdx]) === String(sessionId)) {
              appSheet.deleteRow(j + 1);
              break;
            }
          }
        }
      } catch (e) {}

      deleteRowsBySessionId_(ss, SHEET_NAMES.APPROVAL_WORKFLOW, sessionId);
      deleteRowsBySessionId_(ss, SHEET_NAMES.ISM_APPROVAL, sessionId);
      deleteRowsBySessionId_(ss, SHEET_NAMES.DIVHEAD_APPROVAL, sessionId);
    }

    // ── Clean up linked audit logs BEFORE writing the new audit entry ──
    try {
      var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
      if (auditSheet) {
        var auditData = auditSheet.getDataRange().getValues();
        var auditHeader = auditData[0];
        var auditSessionIdx = auditHeader.indexOf('SessionID');
        if (auditSessionIdx > -1) {
          var matchKeys = {};
          if (sessionId) matchKeys[String(sessionId)] = true;
          if (reqId)     matchKeys[String(reqId)] = true;
          for (var r = auditData.length - 1; r >= 1; r--) {
            if (matchKeys[String(auditData[r][auditSessionIdx])]) {
              auditSheet.deleteRow(r + 1);
            }
          }
        }
      }
    } catch (e) {}

    var adminEmail = Session.getActiveUser().getEmail();

    // ── Write new DELETE_ENTRY audit record ──
    try {
      var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
      if (auditSheet) {
        var flags = [];
        if (sendEmail) flags.push('EMAIL_SENT');
        if (ismComment) flags.push('COMMENT:' + ismComment.slice(0, 200));
        auditSheet.appendRow([
          Utilities.getUuid(), sessionId || reqId, flags.join('; '), 'DELETE_ENTRY',
          adminEmail, ismComment, new Date().toISOString()
        ]);
      }
    } catch (e) {}

    // Send notification email if requested
    var emailSent = false;
    if (sendEmail && requestorEmail) {
      try {
        var subject = '[DELETED] Your access request has been removed';
        var body = 'Dear User,\n\n' +
          'This is to inform you that the following entry has been deleted from the Data Privacy System:\n\n' +
          '  Entry: ' + (entryName || 'ReqID ' + reqId) + '\n' +
          '  ReqID: ' + reqId + '\n' +
          '  LogID: ' + logId + '\n\n' +
          'Deleted by: ' + adminEmail + '\n' +
          'Date/Time: ' + new Date().toLocaleString('en-PH') + '\n' +
          (ismComment ? '\nISM Comment: ' + ismComment + '\n' : '') +
          '\nIf you have questions, please contact the ISM team at ' + adminEmail + '.\n\n' +
          '— Data Privacy Admin System';
        sendEmailWithRetry_(requestorEmail, subject, body, { htmlBody: buildAdminEmailHtml_({
          heading: 'Entry Deleted', accent: '#b46d14',
          intro: 'Dear User,',
          bodyHtml: 'The following entry has been removed from the Data Privacy System.',
          detailRows: [['Entry', (entryName || 'ReqID ' + reqId)], ['ReqID', reqId], ['LogID', logId], ['Deleted by', adminEmail], ['Date/Time', new Date().toLocaleString('en-PH')]].concat(ismComment ? [['ISM Comment', ismComment]] : []),
          footerNote: 'If you have questions, please contact the ISM team at ' + adminEmail + '.'
        }), replyTo: adminEmail });
        emailSent = true;
      } catch (e) {
        Logger.log('[ADMIN] Failed to send deletion email to ' + requestorEmail + ': ' + e.toString());
      }
    }

    return { success: true, message: 'Entry deleted successfully.', emailSent: emailSent };
  } catch (e) {
    return { success: false, error: 'deleteEntry: [FATAL] ' + e.message };
  }
}

/*
  Function: deleteRowsBySessionId_
  LAYMAN:    Deletes every row in a given sheet that belongs to a session. Used to wipe
             a request's approval-stage rows during deletion.
  TECHNICAL: Finds the SessionID column and deletes matching rows bottom-up (so row
             indices stay valid). Silent no-op if the sheet or column is missing.
  PARAMS:    - ss — Spreadsheet.
             - sheetName — tab to clean.
             - sessionId — value to match.
  RETURNS:   undefined (mutates the sheet).
*/
function deleteRowsBySessionId_(ss, sheetName, sessionId) {
  try {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var header = data[0];
    var sessionIdx = header.indexOf('SessionID');
    if (sessionIdx === -1) return;
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][sessionIdx]) === String(sessionId)) {
        sheet.deleteRow(i + 1);
      }
    }
  } catch (e) {}
}

/*
  Function: batchDeleteEntries
  LAYMAN:    Deletes many requests in one server call instead of one round-trip per
             request, and reports how many succeeded, failed, and got an email.
  TECHNICAL: Loops over items calling deleteEntry for each, collecting per-item
             results and tallying deleted / failed / emailsSent. Per-item errors are
             caught so one bad item doesn't abort the batch.
  PARAMS:    - items — array of {reqId, logId, sessionId, sendEmail, ismComment}.
  RETURNS:   {success:true, deleted, failed, emailsSent, total, results[]}
             or {success:false, error} if items isn't an array.
*/
// ─── batchDeleteEntries() — Server-side batch processing ──────────────────────
// Accepts an array of {reqId, logId, sessionId, sendEmail, ismComment} objects.
// Returns a summary: {success, deleted, failed, emailsSent, results[]}.
// This is more efficient than N individual GAS round-trips from the frontend.
function batchDeleteEntries(items) {
  // SECURITY (F-01): re-authorize the caller server-side (see deleteEntry).
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };

  try {
    if (!items || !Array.isArray(items)) {
      return { success: false, error: 'batchDeleteEntries: items must be an array.' };
    }
    var total   = items.length;
    var deleted = 0;
    var failed  = 0;
    var emailsSent = 0;
    var results = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      try {
        var res = deleteEntry(item.reqId, item.logId, item.sessionId, item.sendEmail, item.ismComment);
        results.push({
          reqId: item.reqId,
          logId: item.logId,
          success: !!res.success,
          emailSent: !!res.emailSent,
          error: res.error || null
        });
        if (res.success) {
          deleted++;
          if (res.emailSent) emailsSent++;
        } else {
          failed++;
        }
      } catch (e) {
        results.push({ reqId: item.reqId, logId: item.logId, success: false, emailSent: false, error: e.message });
        failed++;
      }
    }

    return {
      success: true,
      deleted: deleted,
      failed: failed,
      emailsSent: emailsSent,
      total: total,
      results: results
    };
  } catch (e) {
    return { success: false, error: 'batchDeleteEntries: [FATAL] ' + e.message };
  }
}

/*
  Function: exportToSheet
  LAYMAN:    Takes the dashboard rows and dumps them into a brand-new Google Sheet for
             download/sharing, flattening the nested DCS and PIA data into readable
             columns, then moves that new file next to the source database.
  TECHNICAL: Creates a new Spreadsheet, builds a header set from baseHeaders plus the
             union of dcsData/piaData keys (dropping FileID and a few ID/Status cols),
             writes one row per record (formatExportCell pretty-prints JSON cells),
             auto-resizes, and relocates the file into the source DB's Drive folder.
  PARAMS:    - rows — the dashboard rows array (or its JSON string).
  RETURNS:   {success:true, url, sheetName} or {success:false, error}.

  STEPS
    Step 1 — Parse input; bail if empty.
    Step 2 — Create sheet; compute the union header set.
    Step 3 — Append a formatted row per record.
    Step 4 — Move the export file beside the source database.
*/
// ─── exportToSheet() ───────────────────────────────────────────────────────────
function exportToSheet(rows) {
  try {
    var parsed = (typeof rows === 'string') ? JSON.parse(rows) : rows;
    if (!parsed || !parsed.length) return { success: false, error: 'No rows to export.' };

    var ss = SpreadsheetApp.create('PIA Admin Export - ' + new Date().toISOString().slice(0, 10));
    var sheet = ss.getActiveSheet();
    sheet.setName('Export');

    var baseHeaders = ['ReqID', 'SessionID', 'Name', 'Location', 'Department', 'Access Type', 'DCS Status', 'PIA Status', 'Email Approval', 'Submission Date'];
    
    var allDcsKeys = {};
    var allPiaKeys = {};

    for (var i = 0; i < parsed.length; i++) {
      var r = parsed[i];
      if (r.dcsData) Object.keys(r.dcsData).forEach(function(k) { allDcsKeys[k] = true; });
      if (r.piaData) Object.keys(r.piaData).forEach(function(k) { allPiaKeys[k] = true; });
    }

    delete allDcsKeys['FileID'];
    delete allPiaKeys['FileID'];
    delete allDcsKeys['ReqID'];
    delete allDcsKeys['LogID'];
    delete allDcsKeys['Status'];
    delete allPiaKeys['SessionID'];
    delete allPiaKeys['Status'];

    var dcsCols = Object.keys(allDcsKeys).sort();
    var piaCols = Object.keys(allPiaKeys).sort();

    var headers = baseHeaders.slice();
    dcsCols.forEach(function(c) { headers.push('DCS: ' + c); });
    piaCols.forEach(function(c) { headers.push('PIA: ' + c); });

    sheet.appendRow(headers);

    function formatExportCell(val) {
      if (val === null || val === undefined || val === 'undefined') return '';
      var s = String(val);
      if ((s.charAt(0) === '{' || s.charAt(0) === '[') && s.length > 2) {
        try {
          var obj = JSON.parse(s);
          if (typeof obj === 'object' && !Array.isArray(obj)) {
            var parts = [];
            for (var k in obj) {
              var v = obj[k];
              if (typeof v === 'object') v = JSON.stringify(v);
              parts.push(k + ': ' + v);
            }
            return parts.join('\n');
          }
          return JSON.stringify(obj, null, 2);
        } catch(e) {}
      }
      return s;
    }

    for (var i = 0; i < parsed.length; i++) {
      var r = parsed[i];
      var rowData = [
        r.reqId, r.sessionId, r.name, r.location, r.dept, r.accessType,
        r.dcsStatus, r.piaStatus, r.emailApproval, r.date
      ];

      dcsCols.forEach(function(col) {
        var val = r.dcsData ? r.dcsData[col] : '';
        rowData.push(formatExportCell(val));
      });
      piaCols.forEach(function(col) {
        var val = r.piaData ? r.piaData[col] : '';
        rowData.push(formatExportCell(val));
      });

      sheet.appendRow(rowData);
    }
    sheet.autoResizeColumns(1, headers.length);

    try {
      var sourceFile = DriveApp.getFileById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
      var folder = sourceFile.getParents().next();
      var exportFile = DriveApp.getFileById(ss.getId());
      folder.addFile(exportFile);
      DriveApp.getRootFolder().removeFile(exportFile);
    } catch (e) {}

    return { success: true, url: ss.getUrl(), sheetName: sheet.getName() };
  } catch (e) {
    return { success: false, error: 'exportToSheet: ' + e.message };
  }
}

/*
  Function: getConfigData
  LAYMAN:    Loads the two config tables the Admin Settings page edits: system settings
             (template links, flags) and the ISM member roster.
  TECHNICAL: Reads System_Configuration and InfoSec_Email_Config via sheetToObjects_;
             missing sheets degrade to [].
  PARAMS:    (none)
  RETURNS:   {success:true, sys:[...], info:[...]} or {success:false, error}.
*/
// ─── CONFIGURATION SETTINGS ────────────────────────────────────────────────────
function getConfigData() {
  // SECURITY (F-01): re-authorize the caller server-side (see deleteEntry).
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };

  try {
    var ss = getSpreadsheet_();
    var sysSheet, infoSheet;
    try { sysSheet = getSheet_(SHEET_NAMES.SYSTEM_CONFIG); } catch(e){}
    try { infoSheet = getSheet_(SHEET_NAMES.INFOSEC_EMAIL_CONFIG); } catch(e){}
    
    var sysData = sysSheet ? sheetToObjects_(sysSheet) : [];
    var infoData = infoSheet ? sheetToObjects_(infoSheet) : [];
    
    return { success: true, sys: sysData, info: infoData };
  } catch (e) {
    return { success: false, error: 'getConfigData: ' + e.message };
  }
}

/*
  Function: saveConfigData
  LAYMAN:    Saves edits from the Admin Settings page back to both config tables —
             updating rows that exist and adding rows for brand-new keys or members
             (e.g. a new LINK_* template link, or an added INFOSEC-003).
  TECHNICAL: For System_Configuration, rewrites Value cells for keys present in
             sysUpdates, then appendRow for new non-empty keys (filling a Description
             column if present). For InfoSec_Email_Config, updates Member_Name/Email by
             Member_ID, then appends new members (defaulting Role/IsActive columns).
  PARAMS:    - sysUpdates — {Configuration_Key: value, ...}.
             - infoUpdates — {Member_ID: {name, email}, ...}.
  RETURNS:   {success:true} or {success:false, error}.

  STEPS
    Step 1 — Update + append System_Configuration rows.
    Step 2 — Update + append InfoSec_Email_Config rows.
*/
function saveConfigData(sysUpdates, infoUpdates) {
  // SECURITY (F-01/F-03): re-authorize the caller server-side. Without this, any domain user could call
  // saveConfigData directly to tamper config or add themselves to InfoSec_Email_Config (privilege escalation).
  var _me = Session.getActiveUser().getEmail();
  var _authz = checkAccess_(_me);
  if (!_authz.allowed) return { success: false, error: _authz.reason };

  try {
    var ss = getSpreadsheet_();

    // 1. System Config
    var sysSheet;
    try { sysSheet = getSheet_(SHEET_NAMES.SYSTEM_CONFIG); } catch(e){}
    if (sysSheet) {
      var sysData = sysSheet.getDataRange().getValues();
      var sysHeader = sysData[0];
      var keyIdx = sysHeader.indexOf('Configuration_Key');
      var valIdx = sysHeader.indexOf('Value');
      if (keyIdx !== -1 && valIdx !== -1) {
        var sysChanged = false;
        var existingSysKeys = {};
        for (var i = 1; i < sysData.length; i++) {
          var k = sysData[i][keyIdx];
          existingSysKeys[k] = true;
          if (sysUpdates[k] !== undefined) {
            sysData[i][valIdx] = sysUpdates[k];
            sysChanged = true;
          }
        }
        if (sysChanged) sysSheet.getDataRange().setValues(sysData);
        // Append any NEW config keys that don't have a row yet (e.g. a newly-added LINK_*
        // template link set from Admin → Settings). Only non-empty values are appended.
        for (var uk in sysUpdates) {
          if (!existingSysKeys[uk] && sysUpdates[uk] !== undefined && String(sysUpdates[uk]).trim() !== '') {
            var newSysRow = [];
            for (var c = 0; c < sysHeader.length; c++) {
              if (c === keyIdx) newSysRow.push(uk);
              else if (c === valIdx) newSysRow.push(sysUpdates[uk]);
              else if (sysHeader[c] === 'Description') newSysRow.push('Added via Admin Settings');
              else newSysRow.push('');
            }
            sysSheet.appendRow(newSysRow);
          }
        }
      }
    }
    
    // 2. InfoSec Config
    var infoSheet;
    try { infoSheet = getSheet_(SHEET_NAMES.INFOSEC_EMAIL_CONFIG); } catch(e){}
    if (infoSheet) {
      var infoData = infoSheet.getDataRange().getValues();
      var infoHeader = infoData[0];
      var idIdx = infoHeader.indexOf('Member_ID');
      var nameIdx = infoHeader.indexOf('Member_Name');
      var emailIdx = infoHeader.indexOf('Member_Email');
      
      if (idIdx !== -1) {
        var existingIds = {};
        var infoChanged = false;
        for (var i = 1; i < infoData.length; i++) {
          var mid = infoData[i][idIdx];
          existingIds[mid] = true;
          if (infoUpdates[mid]) {
            if (nameIdx !== -1 && infoData[i][nameIdx] !== infoUpdates[mid].name) { infoData[i][nameIdx] = infoUpdates[mid].name; infoChanged = true; }
            if (emailIdx !== -1 && infoData[i][emailIdx] !== infoUpdates[mid].email) { infoData[i][emailIdx] = infoUpdates[mid].email; infoChanged = true; }
          }
        }
        if (infoChanged) infoSheet.getDataRange().setValues(infoData);
        
        // Append missing optionally added members (INFOSEC-003)
        for (var mid in infoUpdates) {
          if (!existingIds[mid] && (infoUpdates[mid].name || infoUpdates[mid].email)) {
            var newRow = [];
            for (var c = 0; c < infoHeader.length; c++) {
              if (c === idIdx) newRow.push(mid);
              else if (c === nameIdx) newRow.push(infoUpdates[mid].name);
              else if (c === emailIdx) newRow.push(infoUpdates[mid].email);
              else if (infoHeader[c] === 'Role') newRow.push(mid.includes('INFOSEC') ? 'ISM Approver' : mid);
              else if (infoHeader[c] === 'IsActive') newRow.push('TRUE');
              else newRow.push('');
            }
            infoSheet.appendRow(newRow);
          }
        }
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: 'saveConfigData: ' + e.message };
  }
}

/*
  Function: include
  LAYMAN:    Lets the AdminView template pull in another HTML file inline (partials).
  TECHNICAL: Returns the raw content of another HtmlService file; called from
             <?!= include('name') ?> in the template.
  PARAMS:    - filename — partial file name (no extension).
  RETURNS:   HTML string.
*/
// ─── Utility: Include HTML partials ────────────────────────────────────────────
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── CERTIFICATE ROUTING — Admin API ──────────────────────────────────────────
// These functions let an ISM admin regenerate the Certificate of Approval and
// resend the routing email to DCOPS, TechServe, or Both.
// ───────────────────────────────────────────────────────────────────────────────

/*
  Function: getStyledHtmlWrapper
  LAYMAN:    Wraps a header + body into a full, good-looking HTML page using the navy
             design system. Used for the access-denied / restricted screens.
  TECHNICAL: Returns a complete <html> document string with an inline <style> block
             (navy palette, DM Sans/Mono, card + alert styles) and the supplied
             header/body injected into a .card.
  PARAMS:    - headerContent — HTML for the badge + title area.
             - bodyContent — HTML for the card body.
  RETURNS:   Full HTML document string.
*/
function getStyledHtmlWrapper(headerContent, bodyContent) {
  return '<!DOCTYPE html><html lang="en">' +
  '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Admin SPA System</title>' +
  '<style>' +
  '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}' +
  '@import url("https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&family=DM+Mono:wght@400;500&display=swap");' +
  ':root{' +
  '--bg:var(--color-background-primary,#ffffff);' +
  '--bg2:var(--color-background-secondary,#f7f8fa);' +
  '--bg3:var(--color-background-tertiary,#eff1f5);' +
  '--text:var(--color-text-primary,#111827);' +
  '--text2:var(--color-text-secondary,#4b5563);' +
  '--text3:var(--color-text-tertiary,#9ca3af);' +
  '--border:var(--color-border-tertiary,#e5e7eb);' +
  '--border2:var(--color-border-secondary,#d1d5db);' +
  '--radius:var(--border-radius-md,4px);' +
  '--radius-lg:var(--border-radius-lg,9px);' +
  '--font:var(--font-sans,"DM Sans",system-ui,sans-serif);' +
  '--font-mono:var(--font-mono,"DM Mono",monospace);' +
  '--success:var(--color-background-success,#ecfdf5);' +
  '--success-text:var(--color-text-success,#065f46);' +
  '--danger:var(--color-background-danger,#fef2f2);' +
  '--danger-text:var(--color-text-danger,#991b1b);' +
  '--warn:var(--color-background-warning,#fffbeb);' +
  '--warn-text:var(--color-text-warning,#92400e);' +
  '--navy:#1e3a5f;--navy-mid:#2a5285;--navy-bright:#3b76c4;' +
  '--navy-glow:rgba(30,58,95,0.12);--navy-tint:#f4f7fb;' +
  '--navy-text:#0f2238;--navy-border:rgba(30,58,95,0.18);' +
  '--ease-out:cubic-bezier(0.16,1,0.3,1);--ease:cubic-bezier(0.4,0,0.2,1);' +
  '--dur-fast:140ms;--dur-med:240ms;--dur-slow:400ms}' +
  'html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}' +
  'body{' +
  'font-family:var(--font);color:var(--text);background:var(--bg2);' +
  'font-size:13px;line-height:1.5;' +
  'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}' +
  '.card{' +
  'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);' +
  'padding:clamp(1.25rem,3vw,2rem);max-width:500px;width:100%;' +
  'box-shadow:0 2px 8px rgba(0,0,0,0.02);text-align:left}' +
  '.step-badge{' +
  'display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;' +
  'letter-spacing:0.05em;padding:5px 14px;border-radius:99px;margin-bottom:12px;' +
  'border:1px solid var(--navy-border)}' +
  'h1{font-size:clamp(0.95rem,0.8rem+0.7vw,1.3rem);font-weight:600;' +
  'color:var(--text);letter-spacing:-0.02em;line-height:1.3;margin-bottom:1rem}' +
  '.alert{' +
  'display:flex;gap:10px;align-items:flex-start;padding:12px 14px;' +
  'border-radius:var(--radius);font-size:13px;line-height:1.55;margin-bottom:4px;' +
  'border:1px solid transparent;text-align:left}' +
  '.alert-danger{background:var(--danger);color:var(--danger-text);border-color:rgba(220,38,38,0.2)}' +
  '.alert-warn{background:var(--warn);color:var(--warn-text);border-color:rgba(180,109,20,0.2)}' +
  '.alert-success{background:var(--success);color:var(--success-text);border-color:rgba(22,163,74,0.2)}' +
  'p{color:var(--text2);line-height:1.6;font-size:14px;margin-top:0.75rem}' +
  '.email-line{color:var(--text3);font-size:0.85rem;margin-top:1.5rem;' +
  'border-top:1px solid var(--border);padding-top:1rem}' +
  '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important}}' +
  '</style></head><body>' +
  '<div class="card">' + headerContent + bodyContent + '</div>' +
  '</body></html>';
}

/*
  Function: escapeHtml_
  LAYMAN:    Makes user text safe to drop into HTML by escaping the dangerous
             characters.
  TECHNICAL: Replaces & < > " ' with their HTML entities. Used throughout the email
             and access-denied HTML builders.
  PARAMS:    - str — any value (coerced to string).
  RETURNS:   Escaped string.
*/
function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/*
  Function: sendEmailWithRetry_
  LAYMAN:    Sends an email, and if Gmail hiccups, waits and tries again — up to five
             times — before giving up. The single choke point every Admin email goes
             through.
  TECHNICAL: Calls MailApp.sendEmail up to 5 times with increasing backoff
             (5s,10s,15s,20s; ~75s total incl. API overhead). Returns true on success;
             re-throws the last error after the final attempt so callers can log
             'Email Failed'.
  PARAMS:    - recipients — comma-joined address string.
             - subject, plainText — message basics.
             - options — MailApp options (htmlBody, replyTo, attachments, ...).
  RETURNS:   true on success (throws if all attempts fail).
*/
function sendEmailWithRetry_(recipients, subject, plainText, options) {
  var maxRetries = 5;
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      MailApp.sendEmail(recipients, subject, plainText, options);
      Logger.log('[ADMIN] Email sent successfully to: ' + recipients);
      return true;
    } catch (e) {
      Logger.log('[ADMIN] Email attempt ' + attempt + '/' + maxRetries + ' failed: ' + e.toString());
      if (attempt === maxRetries) throw e;
      // 5s → 10s → 15s → 20s (total window ~50s + API overhead ≈ 75s)
      Utilities.sleep(5000 * attempt);
    }
  }
  return false;
}

/*
  Function: apiAdmin_GetRoutingStatus
  LAYMAN:    For one request, tells the Email Routing page everything it needs to draw
             the routing controls: where it was last sent, the DCOPS/TechServe
             addresses, the ISM approval tally, Division Head state, and whether it's
             eligible to be routed yet.
  TECHNICAL: Loads the Applications row by SessionID, walks ISM_Approval_Workflow
             (Status||Decision; routing dest read from the CurrentStep=2 row), reads
             DivisionHead_Approval_Workflow, derives canRoute from status + ISM/DH
             approval, pulls dcops/techserve emails from active InfoSec_Email_Config
             rows, and joins DCS metadata for display.
  PARAMS:    - sessionId — required.
  RETURNS:   {success:true, data:{...routing snapshot...}} or {success:false, error}.

  STEPS
    Step 1 — Read the application (404 if missing).
    Step 2 — Tally ISM approvals + last routing destination.
    Step 3 — Read Division Head decision.
    Step 4 — Compute routing eligibility.
    Step 5-6 — Resolve destination emails + DCS display fields.
*/
function apiAdmin_GetRoutingStatus(sessionId) {
  try {
    if (!sessionId || String(sessionId).trim() === '') {
      return { success: false, error: 'Session ID is required.' };
    }
    sessionId = String(sessionId).trim();

    var ss = getSpreadsheet_();

    // 1. Read Application status
    var appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
    var appRow = null;
    if (appSheet) {
      var appData = appSheet.getDataRange().getValues();
      var appHeader = appData[0];
      var sessionIdx = appHeader.indexOf('SessionID');
      if (sessionIdx !== -1) {
        for (var i = 1; i < appData.length; i++) {
          if (String(appData[i][sessionIdx]) === sessionId) {
            appRow = {};
            for (var j = 0; j < appHeader.length; j++) {
              appRow[appHeader[j]] = appData[i][j];
            }
            break;
          }
        }
      }
    }

    if (!appRow) {
      return { success: false, error: 'Application not found for Session ID: ' + sessionId };
    }

    var status = String(appRow.Status || 'Unknown');

    // 2. Read ISM approval status from ISM_Approval_Workflow
    // NOTE: Decision may be stored in the 'Decision' column OR the 'Status' column.
    var lastRoutingDest = '';
    var ismApprovalCount = 0;
    var totalIsmMembers = 0;
    var ismRejected = false;
    var ismEscalated = false;
    var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
    if (ismSheet) {
      var ismRows = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);
      totalIsmMembers = ismRows.length;
      for (var i = 0; i < ismRows.length; i++) {
        // Check Status column first (authoritative per flow doc), fall back to Decision
        var dec = String(ismRows[i].Status || ismRows[i].Decision || '').toUpperCase();
        if (dec === 'APPROVED') {
          ismApprovalCount++;
          // Routing destination: always use ISM Person 2 (CurrentStep=2)
          var stepVal = parseInt(String(ismRows[i].CurrentStep || '0'), 10);
          if (stepVal === 2) {
            var rd = ismRows[i].Routing_Destination || ismRows[i].RoutingDestination || ismRows[i].Routing || '';
            if (String(rd).trim()) lastRoutingDest = String(rd).trim();
          }
        } else if (dec === 'ESCALATEDTODIVISIONHEAD' || dec === 'ESCALATED') {
          ismEscalated = true;
        } else if (dec === 'DENIED') {
          ismRejected = true;
        }
      }
    }

    var allIsmApproved = totalIsmMembers > 0 && ismApprovalCount === totalIsmMembers;

    // 3. Read Division Head Approval Workflow
    var dhStatus = '';
    var dhEmail = '';
    var dhDecision = '';
    var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
    if (dhSheet) {
      var dhRows = sheetToObjectsFiltered_(dhSheet, 'SessionID', sessionId);
      if (dhRows.length > 0) {
        var dhRow = dhRows[0];
        dhStatus = String(dhRow.Status || '');
        dhEmail  = String(dhRow.DivHead_Email || '');
        dhDecision = String(dhRow.Decision || '');
      }
    }

    var dhApproved = dhDecision.toUpperCase() === 'APPROVED';

    // 4. Determine routing eligibility based on full status flow
    var canRoute = false;
    if (status === 'Approved by ISM') {
      canRoute = true;
    } else if (status === 'Approved' && allIsmApproved) {
      canRoute = true;
    } else if (status === 'Approved (ISM Pending)') {
      canRoute = true;
    } else if (status === 'Escalated to Division Head' && dhApproved) {
      canRoute = true;
    } else if (ismEscalated && dhApproved) {
      canRoute = true;
    }

    // 5. Read destination emails from InfoSec_Email_Config
    var dcopsEmail = '';
    var techserveEmail = '';
    var infoSheet = ss.getSheetByName(SHEET_NAMES.INFOSEC_EMAIL_CONFIG);
    if (infoSheet) {
      var infoRows = sheetToObjects_(infoSheet);
      for (var i = 0; i < infoRows.length; i++) {
        var r = infoRows[i];
        var role = String(r.Role || '').toLowerCase().trim();
        var isActive = String(r.IsActive || 'YES').toUpperCase().trim() === 'YES';
        if (isActive) {
          if (role === 'dcops') dcopsEmail = r.Member_Email || '';
          if (role === 'techserve') techserveEmail = r.Member_Email || '';
        }
      }
    }

    // 6. Read DCS info for display
    var linkedReqId = appRow.Linked_ReqID || '';
    var dcsStatus = '—';
    var requestorName = '';
    if (linkedReqId) {
      var dcSheet = ss.getSheetByName(SHEET_NAMES.DATA_COLLECTION);
      if (dcSheet) {
        var dcData = dcSheet.getDataRange().getValues();
        var dcHeader = dcData[0];
        var reqIdIdx = dcHeader.indexOf('ReqID');
        var statusIdx = dcHeader.indexOf('Status');
        var metaIdx = dcHeader.indexOf('Metadata_JSON');
        if (reqIdIdx !== -1) {
          for (var i = 1; i < dcData.length; i++) {
            if (String(dcData[i][reqIdIdx]) === linkedReqId) {
              if (statusIdx !== -1) dcsStatus = String(dcData[i][statusIdx]);
              if (metaIdx !== -1) {
                try {
                  var meta = JSON.parse(dcData[i][metaIdx] || '{}');
                  requestorName = meta.name || meta.requestorName || '';
                } catch (e) {}
              }
              break;
            }
          }
        }
      }
    }

    var pia1 = {};
    try { pia1 = JSON.parse(appRow.PIA_1_Data || '{}'); } catch (e) {}

    return {
      success: true,
      data: {
        sessionId: sessionId,
        status: status,
        lastRoutingDestination: lastRoutingDest || 'BOTH',
        dcopsEmail: dcopsEmail,
        techserveEmail: techserveEmail,
        linkedReqId: linkedReqId,
        dcsStatus: dcsStatus,
        requestorName: requestorName,
        ismApprovalCount: ismApprovalCount,
        totalIsmMembers: totalIsmMembers,
        allIsmApproved: allIsmApproved,
        isApprovedByISM: ismApprovalCount > 0,
        ismEscalated: ismEscalated,
        ismRejected: ismRejected,
        // Division Head escalation info
        dhStatus: dhStatus,
        dhEmail: dhEmail,
        dhDecision: dhDecision,
        dhApproved: dhApproved,
        // Routing eligibility
        canRoute: canRoute,
        application: {
          program: pia1.program || '—',
          department: pia1.dept || '—',
          purpose: pia1.purpose || '—'
        }
      }
    };
  } catch (e) {
    Logger.log('[ADMIN] Error in apiAdmin_GetRoutingStatus: ' + e.toString());
    return { success: false, error: 'apiAdmin_GetRoutingStatus: ' + e.toString() };
  }
}

/*
  Function: apiAdmin_RerouteApprovedRequest
  LAYMAN:    Re-creates the Certificate of Approval for an approved request and emails
             it (with a PDF copy) to the implementation team — DCOPS, TechServe, or
             both. The admin uses this to (re)route a finished request.
  TECHNICAL: Validates destination in {DCOPS,TECHSERVE,BOTH}; a 30s per
             session+destination idempotency cache (on the function object) blocks
             accidental double-sends unless force=true. Confirms the app is in a
             routable state (Approved* / Complete / DH-approved), gathers DCS metadata,
             InfoSec destination emails, and approval rows, builds the certificate via
             buildCertificateHtml_, attaches a generated PDF, sends through
             sendEmailWithRetry_, and writes an ADMIN_REROUTE audit row.
  PARAMS:    - sessionId — required.
             - destination — 'DCOPS' | 'TECHSERVE' | 'BOTH'.
             - force — optional; bypass the idempotency cache.
  RETURNS:   {success:true, message, sentTo, destination, certificateFile}
             or {success:false, error}.

  STEPS
    Step 0 — Validate inputs + idempotency cache.
    Step 1 — Read application; confirm routable status (incl. DH approval).
    Step 2-3 — Read DCS metadata + InfoSec destination/ISM emails.
    Step 4 — Resolve recipient list for the chosen destination.
    Step 5-6 — Build approver tables + certificate HTML.
    Step 7-8 — Generate PDF + send the email.
    Step 9 — Log ADMIN_REROUTE audit entry.
*/
function apiAdmin_RerouteApprovedRequest(sessionId, destination, force) {
  try {
    if (!sessionId || String(sessionId).trim() === '') {
      return { success: false, error: 'Session ID is required.' };
    }
    sessionId = String(sessionId).trim();

    if (!destination || String(destination).trim() === '') {
      return { success: false, error: 'Destination is required (DCOPS, TECHSERVE, or BOTH).' };
    }
    var normalizedDest = String(destination).toUpperCase().trim();
    var validDests = ['DCOPS', 'TECHSERVE', 'BOTH'];
    if (validDests.indexOf(normalizedDest) === -1) {
      return { success: false, error: 'Invalid destination: ' + destination + '. Must be DCOPS, TECHSERVE, or BOTH.' };
    }

    // Idempotency check — skip if force=true (admin recovery resend)
    if (!force) {
      var cache = apiAdmin_RerouteApprovedRequest._rerouteCache || (apiAdmin_RerouteApprovedRequest._rerouteCache = {});
      var cacheKey = sessionId + '::' + normalizedDest;
      var now = Date.now();
      if (cache[cacheKey] && (now - cache[cacheKey] < 30000)) {
        return { success: false, error: 'Duplicate request detected. Please wait 30 seconds before re-sending to ' + normalizedDest + '.' };
      }
      cache[cacheKey] = now;
    }

    var ss = getSpreadsheet_();

    // ── Step 1: Read Application Data ──
    var appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
    var appRow = null;
    if (appSheet) {
      var appData = appSheet.getDataRange().getValues();
      var appHeader = appData[0];
      var sessionIdx = appHeader.indexOf('SessionID');
      if (sessionIdx !== -1) {
        for (var i = 1; i < appData.length; i++) {
          if (String(appData[i][sessionIdx]) === sessionId) {
            appRow = {};
            for (var j = 0; j < appHeader.length; j++) {
              appRow[appHeader[j]] = appData[i][j];
            }
            break;
          }
        }
      }
    }

    if (!appRow) {
      return { success: false, error: 'Application not found for Session ID: ' + sessionId };
    }

    // Check that app is in an approved/routable state
    var status = String(appRow.Status || '');
    var isRoutableStatus = status.indexOf('Approved') !== -1 || status === 'Complete';

    // Also check Div Head approval for escalated flows
    if (!isRoutableStatus) {
      // If status is "Escalated to Division Head", check if DH approved
      try {
        var dhCheckSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
        if (dhCheckSheet) {
          var dhCheckRows = sheetToObjectsFiltered_(dhCheckSheet, 'SessionID', sessionId);
          if (dhCheckRows.length > 0) {
            var dhDec = String(dhCheckRows[0].Status || dhCheckRows[0].Decision || '').toUpperCase().trim();
            if (dhDec === 'APPROVED') isRoutableStatus = true;
          }
        }
      } catch (e) {}
    }

    if (!isRoutableStatus) {
      return { success: false, error: 'Application status is "' + status + '". Must be "Approved", "Approved by ISM", or Div Head approved to route.' };
    }

    var pia1 = {};
    try { pia1 = JSON.parse(appRow.PIA_1_Data || '{}'); } catch (e) {}
    var linkedReqId = appRow.Linked_ReqID || '';
    var applicantEmail = appRow.ApplicantEmail || '';

    // ── Step 2: Read DCS Data ──
    var dcsData = {};
    if (linkedReqId) {
      var dcSheet = ss.getSheetByName(SHEET_NAMES.DATA_COLLECTION);
      if (dcSheet) {
        var dcData = dcSheet.getDataRange().getValues();
        var dcHeader = dcData[0];
        var reqIdIdx = dcHeader.indexOf('ReqID');
        var metaIdx = dcHeader.indexOf('Metadata_JSON');
        var agencyIdx = dcHeader.indexOf('Metadata_Agency');
        var userEmailIdx = dcHeader.indexOf('UserEmail');
        if (reqIdIdx !== -1) {
          for (var i = 1; i < dcData.length; i++) {
            if (String(dcData[i][reqIdIdx]) === linkedReqId) {
              if (userEmailIdx !== -1) dcsData.requestor = dcData[i][userEmailIdx];
              if (metaIdx !== -1) {
                try { dcsData.metadata = JSON.parse(dcData[i][metaIdx] || '{}'); } catch (e) {}
              }
              if (agencyIdx !== -1) {
                try { dcsData.metadataAgency = JSON.parse(dcData[i][agencyIdx] || '{}'); } catch (e) {}
              }
              break;
            }
          }
        }
      }
    }

    var requestorName = dcsData.metadata ? (dcsData.metadata.name || dcsData.metadata.requestorName || '') : '';
    var department = dcsData.metadata ? (dcsData.metadata.dept || dcsData.metadata.department || '') : '';
    var accessNeeded = dcsData.metadata ? (dcsData.metadata.access || '') : '';
    var iHelpReference = dcsData.metadata ? (dcsData.metadata.ihelp || '') : '';
    var accountable = dcsData.metadata ? (dcsData.metadata.accountable || null) : null;

    // ── Step 3: Read ISM InfoSec Config for destination emails ──
    var dcopsEmail = '';
    var techserveEmail = '';
    var ismMembers = [];
    var infoSheet = ss.getSheetByName(SHEET_NAMES.INFOSEC_EMAIL_CONFIG);
    if (infoSheet) {
      var infoRows = sheetToObjects_(infoSheet);
      for (var i = 0; i < infoRows.length; i++) {
        var r = infoRows[i];
        var role = String(r.Role || '').toLowerCase().trim();
        var isActive = String(r.IsActive || 'YES').toUpperCase().trim() === 'YES';
        if (isActive) {
          if (role === 'infosec') {
            ismMembers.push({ name: r.Member_Name || '', email: r.Member_Email || '' });
          }
          if (role === 'dcops') dcopsEmail = r.Member_Email || '';
          if (role === 'techserve') techserveEmail = r.Member_Email || '';
        }
      }
    }

    // ── Step 4: Resolve destination emails ──
    var destinationEmails = [];
    if (normalizedDest === 'DCOPS' || normalizedDest === 'BOTH') {
      destinationEmails.push(dcopsEmail);
    }
    if (normalizedDest === 'TECHSERVE' || normalizedDest === 'BOTH') {
      destinationEmails.push(techserveEmail);
    }
    var validEmails = [];
    for (var i = 0; i < destinationEmails.length; i++) {
      if (destinationEmails[i] && String(destinationEmails[i]).trim()) {
        validEmails.push(String(destinationEmails[i]).trim());
      }
    }
    if (validEmails.length === 0) {
      return { success: false, error: 'No destination emails configured for ' + normalizedDest + '. Please check InfoSec_Email_Config sheet.' };
    }
    var recipients = validEmails.join(',');

    // ── Step 5: Gather Approval Data from sheets ──
    var headApproversHtml = '';
    var awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
    if (awSheet) {
      var approvalRows = sheetToObjectsFiltered_(awSheet, 'SessionID', sessionId);
      for (var i = 0; i < approvalRows.length; i++) {
        var a = approvalRows[i];
        // Check Status column first (authoritative), fall back to Decision
        if (String(a.Status || a.Decision || '').toUpperCase() === 'APPROVED') {
          var dateStr = a.DecisionDate ? new Date(a.DecisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
          headApproversHtml += '<tr>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">' +
              '<div style="font-weight:600;color:#1e3a5f;">' + escapeHtml_(a.ApproverName || a.ApproverEmail || '—') + '</div>' +
              '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">' + escapeHtml_(a.ApproverRole || 'Approver') + '</div>' +
            '</td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;">' +
              '<span style="display:inline-flex;align-items:center;background:#ecfdf5;color:#065f46;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;">Approved</span>' +
            '</td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:12px;color:#4b5563;">' + escapeHtml_(dateStr) + '</td>' +
          '</tr>';
        }
      }
    }

    // Division Head approvals
    var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
    if (dhSheet) {
      var dhRows = sheetToObjectsFiltered_(dhSheet, 'SessionID', sessionId);
      for (var i = 0; i < dhRows.length; i++) {
        var dh = dhRows[i];
        // Check Status column first (authoritative), fall back to Decision
        if (String(dh.Status || dh.Decision || '').toUpperCase() === 'APPROVED') {
          var dateStr = dh.DecisionDate ? new Date(dh.DecisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
          headApproversHtml += '<tr>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">' +
              '<div style="font-weight:600;color:#1a3a5c;">' + escapeHtml_(dh.DivHead_Email || '—') + '</div>' +
              '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Division Head</div>' +
            '</td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;">' +
              '<span style="display:inline-flex;align-items:center;background:#ecfdf5;color:#065f46;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;">Approved</span>' +
            '</td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:12px;color:#4b5563;">' + escapeHtml_(dateStr) + '</td>' +
          '</tr>';
        }
      }
    }

    if (!headApproversHtml) {
      headApproversHtml = '<tr><td colspan="3" style="padding:10px 0;color:#6b7280;font-style:italic;border-bottom:1px solid #e5e7eb;">No head approvers found.</td></tr>';
    }

    // ISM Approvals
    var ismApproversHtml = '';
    var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
    if (ismSheet) {
      var ismRows = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);
      for (var i = 0; i < ismRows.length; i++) {
        var im = ismRows[i];
        // Check Status column first (authoritative), fall back to Decision
        if (String(im.Status || im.Decision || '').toUpperCase() === 'APPROVED') {
          var dateStr = im.DecisionDate ? new Date(im.DecisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
          ismApproversHtml += '<tr>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">' +
              '<div style="font-weight:600;color:#1a3a5c;">' + escapeHtml_(im.ISM_Member_Name || im.ISM_Member_Email || '—') + '</div>' +
              '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;">ISM InfoSec Member</div>' +
            '</td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;">' +
              '<span style="display:inline-flex;align-items:center;background:#ecfdf5;color:#065f46;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;">Approved</span>' +
            '</td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:12px;color:#4b5563;">' + escapeHtml_(dateStr) + '</td>' +
          '</tr>';
        }
      }
    }

    if (!ismApproversHtml) {
      ismApproversHtml = '<tr><td colspan="3" style="padding:10px 0;color:#6b7280;font-style:italic;border-bottom:1px solid #e5e7eb;">No ISM approvers found.</td></tr>';
    }

    // Accountable Persons HTML
    var accountableRowsHtml = '';
    if (accountable) {
      for (var i = 1; i <= 5; i++) {
        var name = accountable['accountableName' + i];
        var email = accountable['accountableEmail' + i];
        if (name || email) {
          accountableRowsHtml += '<tr>' +
            '<td style="padding:6px 0;font-weight:600;color:#6b7280;">Accountable Person ' + i + '</td>' +
            '<td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(name || '—') + ' (' + escapeHtml_(email || '—') + ')</td>' +
          '</tr>';
        }
      }
    }

    // ── Step 6: Build Certificate HTML ──
    var nowStr = new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' });

    var subject = '[CERTIFICATE OF APPROVAL] Implementation Required for: ' + sessionId +
      ' (' + (pia1.program || 'No Program Name') + ')';

    var htmlBody = buildCertificateHtml_(sessionId, pia1, linkedReqId, applicantEmail,
      requestorName, department, accessNeeded, iHelpReference, accountableRowsHtml,
      dcsData.metadataAgency, headApproversHtml, ismApproversHtml, nowStr);

    // ── Step 7: Generate PDF Certificate ──
    var pdfBlob = Utilities.newBlob(htmlBody, MimeType.HTML, 'Certificate_' + sessionId + '.html')
      .getAs(MimeType.PDF)
      .setName('Approval_Certificate_' + sessionId + '.pdf');

    // ── Step 8: Send Email ──
    sendEmailWithRetry_(recipients, subject,
      'Please view this email in an HTML-compatible client.',
      {
        htmlBody: htmlBody,
        attachments: [pdfBlob]
      }
    );

    // ── Step 9: Log audit entry ──
    try {
      var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
      if (auditSheet) {
        auditSheet.appendRow([
          Utilities.getUuid(),
          sessionId,
          linkedReqId,
          'ADMIN_REROUTE',
          Session.getActiveUser().getEmail(),
          'Rerouted to ' + normalizedDest + ' via admin console',
          new Date().toISOString()
        ]);
      }
    } catch (e) {
      Logger.log('[ADMIN] Failed to write audit log: ' + e.toString());
    }

    Logger.log('[ADMIN] ' + sessionId + ': Request re-routed to ' + normalizedDest + ': ' + recipients);

    return {
      success: true,
      message: 'Certificate regenerated and successfully sent to ' + normalizedDest,
      sentTo: recipients,
      destination: normalizedDest,
      certificateFile: 'Approval_Certificate_' + sessionId + '.pdf'
    };

  } catch (e) {
    Logger.log('[ADMIN] Error in apiAdmin_RerouteApprovedRequest: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiAdmin_GetApprovedApplications
  LAYMAN:    Builds the full list for the Email Routing page — every application with
             its status, ISM/Division-Head progress, and whether it's ready to route —
             sorted so the ones most ready to send sit at the top.
  TECHNICAL: Reads Applications and groups ISM + DivHead workflow rows by SessionID,
             plus DCS metadata by ReqID and InfoSec destination emails. Per app
             computes ismApprovedCount / allIsmApproved / escalation / DH approval and
             canRoute, then sorts by a route-readiness weight (0=ready ... 9=terminal),
             tiebreaking on sessionId.
  PARAMS:    (none)
  RETURNS:   {success:true, data:[appSummary...]} or {success:false, error}.
*/
function apiAdmin_GetApprovedApplications() {
  try {
    var ss = getSpreadsheet_();

    // ── Read Applications ──
    var appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
    if (!appSheet) return { success: false, error: 'Applications sheet not found.' };
    var appRows = sheetToObjects_(appSheet);

    // ── Read ISM approvals ──
    var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
    var ismBySession = {};
    if (ismSheet) {
      var ismRows = sheetToObjects_(ismSheet);
      for (var i = 0; i < ismRows.length; i++) {
        var s = ismRows[i].SessionID;
        if (!ismBySession[s]) ismBySession[s] = [];
        ismBySession[s].push(ismRows[i]);
      }
    }

    // ── Read Division Head approvals ──
    var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
    var dhBySession = {};
    if (dhSheet) {
      var dhRows = sheetToObjects_(dhSheet);
      for (var i = 0; i < dhRows.length; i++) {
        var s = dhRows[i].SessionID;
        if (!dhBySession[s]) dhBySession[s] = [];
        dhBySession[s].push(dhRows[i]);
      }
    }

    // ── Read InfoSec config for destination emails ──
    var dcopsEmail = '';
    var techserveEmail = '';
    var infoSheet = ss.getSheetByName(SHEET_NAMES.INFOSEC_EMAIL_CONFIG);
    if (infoSheet) {
      var infoRows = sheetToObjects_(infoSheet);
      for (var i = 0; i < infoRows.length; i++) {
        var r = infoRows[i];
        var role = String(r.Role || '').toLowerCase().trim();
        var isActive = String(r.IsActive || 'YES').toUpperCase().trim() === 'YES';
        if (isActive) {
          if (role === 'dcops') dcopsEmail = r.Member_Email || '';
          if (role === 'techserve') techserveEmail = r.Member_Email || '';
        }
      }
    }

    // ── Read DCS Data for metadata ──
    var dcSheet = ss.getSheetByName(SHEET_NAMES.DATA_COLLECTION);
    var dcsByReqId = {};
    if (dcSheet) {
      var dcRows = sheetToObjects_(dcSheet);
      for (var i = 0; i < dcRows.length; i++) {
        var reqId = String(dcRows[i].ReqID || '');
        if (reqId) {
          var meta = {};
          try { meta = JSON.parse(dcRows[i].Metadata_JSON || '{}'); } catch (e) {}
          dcsByReqId[reqId] = meta;
        }
      }
    }

    // ── Build response for ALL applications ──
    var results = [];
    for (var i = 0; i < appRows.length; i++) {
      var app = appRows[i];
      var status = String(app.Status || '');

      var sessionId = String(app.SessionID || '');
      if (!sessionId) continue;

      var pia1 = {};
      try { pia1 = JSON.parse(app.PIA_1_Data || '{}'); } catch (e) {}

      // Look up DCS metadata
      var linkedReqId = String(app.Linked_ReqID || '');
      var dcsMeta = linkedReqId && dcsByReqId[linkedReqId] ? dcsByReqId[linkedReqId] : {};
      var department = dcsMeta.dept || dcsMeta.department || pia1.dept || '—';
      var requestorName = dcsMeta.name || dcsMeta.requestorName || '';

      // ISM approval info
      var ismEntries = ismBySession[sessionId] || [];
      var ismApprovedCount = 0;
      var ismEscalated = false;
      var ismRejected = false;
      var lastRoutingDest = '';
      for (var j = 0; j < ismEntries.length; j++) {
        // Check Status column first (authoritative per flow doc), fall back to Decision
        var dec = String(ismEntries[j].Status || ismEntries[j].Decision || '').toUpperCase();
        if (dec === 'APPROVED') {
          ismApprovedCount++;
          // Routing destination: always use ISM Person 2 (CurrentStep=2)
          var stepVal = parseInt(String(ismEntries[j].CurrentStep || '0'), 10);
          if (stepVal === 2) {
            var rd = ismEntries[j].Routing_Destination || ismEntries[j].RoutingDestination || ismEntries[j].Routing || '';
            if (String(rd).trim()) lastRoutingDest = String(rd).trim();
          }
        } else if (dec === 'ESCALATEDTODIVISIONHEAD' || dec === 'ESCALATED') {
          ismEscalated = true;
        } else if (dec === 'DENIED') {
          ismRejected = true;
        }
      }

      var allIsmApproved = ismEntries.length > 0 && ismApprovedCount === ismEntries.length;

      // Division Head info
      var dhEntries = dhBySession[sessionId] || [];
      var dhStatus = '';
      var dhEmail = '';
      var dhDecision = '';
      var dhApproved = false;
      if (dhEntries.length > 0) {
        var dhRow = dhEntries[0];
        dhStatus = String(dhRow.Status || '');
        dhEmail  = String(dhRow.DivHead_Email || '');
        dhDecision = String(dhRow.Decision || '');
        dhApproved = dhDecision.toUpperCase() === 'APPROVED';
      }

      // Routing eligibility
      var canRoute = false;
      if (status === 'Approved by ISM') {
        canRoute = true;
      } else if (status === 'Approved' && allIsmApproved) {
        canRoute = true;
      } else if (status === 'Approved (ISM Pending)') {
        canRoute = true;
      } else if (status === 'Escalated to Division Head' && dhApproved) {
        canRoute = true;
      } else if (ismEscalated && dhApproved) {
        canRoute = true;
      }

      results.push({
        sessionId: sessionId,
        status: status,
        program: pia1.program || '—',
        department: department,
        purpose: pia1.purpose || '—',
        requestorName: requestorName,
        applicantEmail: String(app.ApplicantEmail || ''),
        linkedReqId: linkedReqId,
        lastRoutingDestination: lastRoutingDest || 'None',
        ismApprovedCount: ismApprovedCount,
        totalIsmMembers: ismEntries.length,
        allIsmApproved: allIsmApproved,
        isApprovedByISM: ismApprovedCount > 0,
        ismEscalated: ismEscalated,
        ismRejected: ismRejected,
        // Division Head escalation info
        dhStatus: dhStatus,
        dhEmail: dhEmail,
        dhDecision: dhDecision,
        dhApproved: dhApproved,
        canRoute: canRoute,
        dcopsEmailConfigured: !!dcopsEmail,
        techserveEmailConfigured: !!techserveEmail
      });
    }

    // Sort: most-ready-to-route first
    var sortWeight = function(item) {
      // 0: Fully approved by ISM — ready to route
      if (item.status === 'Approved by ISM') return 0;
      // 1: Approved + all ISM approved (effectively Approved by ISM)
      if (item.status === 'Approved' && item.allIsmApproved) return 1;
      // 2: Escalated + Div Head approved — ready to resume/route
      if (item.ismEscalated && item.dhApproved) return 2;
      // 3: Approved (ISM Pending) — needs admin fix
      if (item.status === 'Approved (ISM Pending)') return 3;
      // 4: Escalated to Division Head (pending DH)
      if (item.status === 'Escalated to Division Head' && !item.dhApproved) return 4;
      // 5: Approved but ISM still pending
      if (item.status === 'Approved' && !item.allIsmApproved) return 5;
      // 6: In Progress
      if (item.status.indexOf('In Progress') !== -1) return 6;
      // 7: Pending / Draft
      if (item.status === 'Pending' || item.status === 'Draft' || item.status === '') return 7;
      // 8: Returned
      if (item.status === 'Returned') return 8;
      // 9: Terminal states (Denied, Rejected)
      return 9;
    };
    results.sort(function(a, b) {
      var wa = sortWeight(a), wb = sortWeight(b);
      if (wa !== wb) return wa - wb;
      return a.sessionId.localeCompare(b.sessionId);
    });

    return { success: true, data: results };

  } catch (e) {
    Logger.log('[ADMIN] Error in apiAdmin_GetApprovedApplications: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiAdmin_DownloadCertificate
  LAYMAN:    Generates the Certificate of Approval PDF and hands it straight back to
             the browser for download — no email sent.
  TECHNICAL: Mirrors the data-gathering of apiAdmin_RerouteApprovedRequest (app, DCS
             metadata, approver tables), builds the certificate via
             buildCertificateHtml_, renders a PDF, and returns it base64-encoded.
             Does not enforce the routable-status gate.
  PARAMS:    - sessionId — required.
  RETURNS:   {success:true, data:{fileName, base64, mimeType}} or {success:false, error}.
*/
function apiAdmin_DownloadCertificate(sessionId) {
  try {
    if (!sessionId || String(sessionId).trim() === '') {
      return { success: false, error: 'Session ID is required.' };
    }
    sessionId = String(sessionId).trim();

    var ss = getSpreadsheet_();

    // ── Read Application Data ──
    var appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
    var appRow = null;
    if (appSheet) {
      var appData = appSheet.getDataRange().getValues();
      var appHeader = appData[0];
      var sessionIdx = appHeader.indexOf('SessionID');
      if (sessionIdx !== -1) {
        for (var i = 1; i < appData.length; i++) {
          if (String(appData[i][sessionIdx]) === sessionId) {
            appRow = {};
            for (var j = 0; j < appHeader.length; j++) {
              appRow[appHeader[j]] = appData[i][j];
            }
            break;
          }
        }
      }
    }
    if (!appRow) return { success: false, error: 'Application not found.' };

    var pia1 = {};
    try { pia1 = JSON.parse(appRow.PIA_1_Data || '{}'); } catch (e) {}
    var linkedReqId = appRow.Linked_ReqID || '';
    var applicantEmail = appRow.ApplicantEmail || '';

    // ── Read DCS Data ──
    var dcsData = {};
    if (linkedReqId) {
      var dcSheet = ss.getSheetByName(SHEET_NAMES.DATA_COLLECTION);
      if (dcSheet) {
        var dcData = dcSheet.getDataRange().getValues();
        var dcHeader = dcData[0];
        var reqIdIdx = dcHeader.indexOf('ReqID');
        var metaIdx = dcHeader.indexOf('Metadata_JSON');
        var agencyIdx = dcHeader.indexOf('Metadata_Agency');
        var userEmailIdx = dcHeader.indexOf('UserEmail');
        if (reqIdIdx !== -1) {
          for (var i = 1; i < dcData.length; i++) {
            if (String(dcData[i][reqIdIdx]) === linkedReqId) {
              if (userEmailIdx !== -1) dcsData.requestor = dcData[i][userEmailIdx];
              if (metaIdx !== -1) {
                try { dcsData.metadata = JSON.parse(dcData[i][metaIdx] || '{}'); } catch (e) {}
              }
              if (agencyIdx !== -1) {
                try { dcsData.metadataAgency = JSON.parse(dcData[i][agencyIdx] || '{}'); } catch (e) {}
              }
              break;
            }
          }
        }
      }
    }

    var requestorName = dcsData.metadata ? (dcsData.metadata.name || dcsData.metadata.requestorName || '') : '';
    var department = dcsData.metadata ? (dcsData.metadata.dept || dcsData.metadata.department || '') : '';
    var accessNeeded = dcsData.metadata ? (dcsData.metadata.access || '') : '';
    var iHelpReference = dcsData.metadata ? (dcsData.metadata.ihelp || '') : '';
    var accountable = dcsData.metadata ? (dcsData.metadata.accountable || null) : null;

    // ── Gather Approvals ──
    var headApproversHtml = '';
    var awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
    if (awSheet) {
      var approvalRows = sheetToObjectsFiltered_(awSheet, 'SessionID', sessionId);
      for (var i = 0; i < approvalRows.length; i++) {
        var a = approvalRows[i];
        // Check Status column first (authoritative), fall back to Decision
        if (String(a.Status || a.Decision || '').toUpperCase() === 'APPROVED') {
          var dateStr = a.DecisionDate ? new Date(a.DecisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
          headApproversHtml += '<tr>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;"><div style="font-weight:600;color:#1a3a5c;">' + escapeHtml_(a.ApproverName || a.ApproverEmail || '—') + '</div><div style="font-size:11px;color:#6b7280;text-transform:uppercase;">' + escapeHtml_(a.ApproverRole || 'Approver') + '</div></td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;"><span style="display:inline-flex;align-items:center;background:#ecfdf5;color:#065f46;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;">Approved</span></td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:12px;color:#4b5563;">' + escapeHtml_(dateStr) + '</td></tr>';
        }
      }
    }

    var dhSheet = ss.getSheetByName(SHEET_NAMES.DIVHEAD_APPROVAL);
    if (dhSheet) {
      var dhRows = sheetToObjectsFiltered_(dhSheet, 'SessionID', sessionId);
      for (var i = 0; i < dhRows.length; i++) {
        var dh = dhRows[i];
        // Check Status column first (authoritative), fall back to Decision
        if (String(dh.Status || dh.Decision || '').toUpperCase() === 'APPROVED') {
          var dateStr = dh.DecisionDate ? new Date(dh.DecisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
          headApproversHtml += '<tr>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;"><div style="font-weight:600;color:#1a3a5c;">' + escapeHtml_(dh.DivHead_Email || '—') + '</div><div style="font-size:11px;color:#6b7280;text-transform:uppercase;">Division Head</div></td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;"><span style="display:inline-flex;align-items:center;background:#ecfdf5;color:#065f46;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;">Approved</span></td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:12px;color:#4b5563;">' + escapeHtml_(dateStr) + '</td></tr>';
        }
      }
    }
    if (!headApproversHtml) {
      headApproversHtml = '<tr><td colspan="3" style="padding:10px 0;color:#6b7280;font-style:italic;">No head approvers found.</td></tr>';
    }

    var ismApproversHtml = '';
    var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
    if (ismSheet) {
      var ismRows = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);
      for (var i = 0; i < ismRows.length; i++) {
        var im = ismRows[i];
        // Check Status column first (authoritative), fall back to Decision
        if (String(im.Status || im.Decision || '').toUpperCase() === 'APPROVED') {
          var dateStr = im.DecisionDate ? new Date(im.DecisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
          ismApproversHtml += '<tr>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;"><div style="font-weight:600;color:#1a3a5c;">' + escapeHtml_(im.ISM_Member_Name || im.ISM_Member_Email || '—') + '</div><div style="font-size:11px;color:#6b7280;text-transform:uppercase;">ISM InfoSec Member</div></td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:center;"><span style="display:inline-flex;align-items:center;background:#ecfdf5;color:#065f46;padding:4px 10px;border-radius:99px;font-size:11px;font-weight:600;">Approved</span></td>' +
            '<td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:12px;color:#4b5563;">' + escapeHtml_(dateStr) + '</td></tr>';
        }
      }
    }
    if (!ismApproversHtml) {
      ismApproversHtml = '<tr><td colspan="3" style="padding:10px 0;color:#6b7280;font-style:italic;">No ISM approvers found.</td></tr>';
    }

    var accountableRowsHtml = '';
    if (accountable) {
      for (var i = 1; i <= 5; i++) {
        var name = accountable['accountableName' + i];
        var email = accountable['accountableEmail' + i];
        if (name || email) {
          accountableRowsHtml += '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Accountable Person ' + i + '</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(name || '—') + ' (' + escapeHtml_(email || '—') + ')</td></tr>';
        }
      }
    }

    // ── Build Certificate HTML ──
    var nowStr = new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' });
    var htmlBody = buildCertificateHtml_(sessionId, pia1, linkedReqId, applicantEmail,
      requestorName, department, accessNeeded, iHelpReference, accountableRowsHtml,
      dcsData.metadataAgency, headApproversHtml, ismApproversHtml, nowStr);

    // ── Generate PDF ──
    var pdfBlob = Utilities.newBlob(htmlBody, MimeType.HTML, 'Certificate_' + sessionId + '.html')
      .getAs(MimeType.PDF)
      .setName('Approval_Certificate_' + sessionId + '.pdf');

    // Return as base64 so the frontend can offer a download
    var pdfBase64 = Utilities.base64Encode(pdfBlob.getBytes());

    return {
      success: true,
      data: {
        fileName: 'Approval_Certificate_' + sessionId + '.pdf',
        base64: pdfBase64,
        mimeType: 'application/pdf'
      }
    };

  } catch (e) {
    Logger.log('[ADMIN] Error in apiAdmin_DownloadCertificate: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: buildAdminEmailHtml_
  LAYMAN:    The single shared template for ALL emails the Admin app sends. Give it a
             heading, a greeting, a body line, a small label/value table, and an
             optional button, and it returns a polished navy-styled HTML email.
  TECHNICAL: Pure string builder. Escapes text fields, renders detailRows as a table,
             optionally a CTA button (ctaText+ctaUrl), and a footer. Pass the result as
             options.htmlBody to sendEmailWithRetry_, keeping a plain-text fallback for
             non-HTML clients. Matches the navy palette of buildCertificateHtml_.
  PARAMS:    - opts — {heading, accent, intro, bodyHtml, detailRows:[[label,value]...],
             ctaText, ctaUrl, footerNote}; all optional.
  RETURNS:   HTML string.
*/
function buildAdminEmailHtml_(opts) {
  opts = opts || {};
  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  var accent = opts.accent || '#2a5285';
  var rows = (opts.detailRows || []).map(function(r){
    return '<tr><td style="padding:6px 14px 6px 0;font-weight:600;color:#6b7280;white-space:nowrap;vertical-align:top;">' + esc(r[0]) +
           '</td><td style="padding:6px 0;color:#1a3a5c;word-break:break-word;">' + esc(r[1]) + '</td></tr>';
  }).join('');
  var cta = (opts.ctaText && opts.ctaUrl) ?
    '<div style="margin:22px 0 4px;"><a href="' + esc(opts.ctaUrl) + '" style="display:inline-block;background:' + accent +
    ';color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 24px;border-radius:6px;">' + esc(opts.ctaText) + '</a></div>' : '';
  var footer = opts.footerNote || 'This is an automated message from the Megaworld Data Privacy System. Please do not reply to this email.';
  return '<div style="font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;background:#f9fafb;padding:24px;color:#333;line-height:1.6;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.08);overflow:hidden;">' +
      '<div style="background:' + accent + ';padding:18px 28px;">' +
        '<div style="color:#ffffff;font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;opacity:0.9;">Megaworld Data Privacy System</div>' +
        '<div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">' + esc(opts.heading || 'Notification') + '</div>' +
      '</div>' +
      '<div style="padding:28px;">' +
        '<p style="margin:0 0 14px;font-size:14px;">' + esc(opts.intro || 'Hello,') + '</p>' +
        (opts.bodyHtml ? '<p style="margin:0 0 16px;font-size:14px;">' + opts.bodyHtml + '</p>' : '') +
        (rows ? '<table style="width:100%;border-collapse:collapse;font-size:13px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin:4px 0;"><tbody>' + rows + '</tbody></table>' : '') +
        cta +
      '</div>' +
      '<div style="padding:16px 28px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:11.5px;color:#9ca3af;">' + esc(footer) + '</div>' +
    '</div></div>';
}

/*
  Function: getOptionalUrl_
  LAYMAN:    Reads an optional link from settings for email buttons. If it's not set,
             returns '' so the button is simply left out.
  TECHNICAL: Safe getter over a URL Script Property; '' on missing or error.
  PARAMS:    - key — property name (e.g. 'WEB_APP_URL').
  RETURNS:   URL string or ''.
*/
function getOptionalUrl_(key) {
  try { return PropertiesService.getScriptProperties().getProperty(key) || ''; } catch (e) { return ''; }
}

/*
  Function: buildCertificateHtml_
  LAYMAN:    Builds the full "Certificate of Approval" HTML — the formal document
             showing the request brief, agency info, and every approver who signed off.
             Shared by both the reroute-email and download-PDF paths.
  TECHNICAL: Pure string builder. Renders an application-brief table, an optional
             agency section (only if metadataAgency has keys), and pre-built approver
             table bodies (headApproversHtml, ismApproversHtml). Escapes all dynamic
             text via escapeHtml_.
  PARAMS:    - sessionId, pia1, linkedReqId, applicantEmail, requestorName, department,
             accessNeeded, iHelpReference, accountableRowsHtml, metadataAgency,
             headApproversHtml, ismApproversHtml, nowStr.
  RETURNS:   HTML string for the certificate body.
*/
function buildCertificateHtml_(sessionId, pia1, linkedReqId, applicantEmail,
  requestorName, department, accessNeeded, iHelpReference, accountableRowsHtml,
  metadataAgency, headApproversHtml, ismApproversHtml, nowStr) {

  var isAgency = metadataAgency && typeof metadataAgency === 'object' && Object.keys(metadataAgency).length > 0;

  var agencySection = '';
  if (isAgency) {
    agencySection = '<div style="margin-bottom: 30px;">' +
      '<h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Agency Information</h2>' +
      '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">' +
      (metadataAgency.agencyName ? '<tr><td style="padding:6px 0;font-weight:600;width:30%;color:#6b7280;">Agency Name</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(metadataAgency.agencyName) + '</td></tr>' : '') +
      (metadataAgency.agencyHead ? '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Agency Head</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(metadataAgency.agencyHead) + '</td></tr>' : '') +
      (metadataAgency.agencyEmail ? '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Agency Email</td><td style="padding:6px 0;color:#1a3a5c;"><a href="mailto:' + escapeHtml_(metadataAgency.agencyEmail) + '" style="color:#2a5285;text-decoration:none;">' + escapeHtml_(metadataAgency.agencyEmail) + '</a></td></tr>' : '') +
      (metadataAgency.agencyPhone ? '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Agency Phone</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(metadataAgency.agencyPhone) + '</td></tr>' : '') +
      (metadataAgency.division ? '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Division / Office</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(metadataAgency.division) + '</td></tr>' : '') +
      '</table></div>';
  }

  return '<div style="font-family: \'Helvetica Neue\', Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333; line-height: 1.6; padding: 20px; background-color: #f9fafb;">' +
    '<div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 40px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">' +
    // Header
    '<div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #2a5285; padding-bottom: 20px;">' +
    '<h1 style="color: #2a5285; margin: 0; font-size: 28px; letter-spacing: -0.02em;">Certificate of Approval</h1>' +
    '<p style="color: #6b7280; margin: 5px 0 0 0; font-size: 14px;">Privacy Impact Assessment & Access Request</p>' +
    '</div>' +
    // Application Brief
    '<div style="margin-bottom: 30px;">' +
    '<h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Application Brief</h2>' +
    '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">' +
    '<tr><td style="padding:6px 0;font-weight:600;width:30%;color:#6b7280;">DCS Request ID</td><td style="padding:6px 0;font-weight:bold;color:#1a3a5c;">' + escapeHtml_(linkedReqId || 'N/A') + '</td></tr>' +
    '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Program Name</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(pia1.program || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Department</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(department || pia1.dept || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Requestor</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(requestorName || applicantEmail || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Purpose</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(pia1.purpose || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">Access Type</td><td style="padding:6px 0;color:#1a3a5c;">' + escapeHtml_(accessNeeded || '—') + '</td></tr>' +
    '<tr><td style="padding:6px 0;font-weight:600;color:#6b7280;">iHelp Reference</td><td style="padding:6px 0;color:#1a3a5c;"><code>' + escapeHtml_(iHelpReference || '—') + '</code></td></tr>' +
    accountableRowsHtml +
    '</table></div>' +
    agencySection +
    // Head Approvers
    '<div style="margin-bottom: 30px;">' +
    '<h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Department / Division Approvals</h2>' +
    '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">' +
    '<thead><tr><th style="text-align:left;padding:8px 0;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;width:45%;">Approver</th><th style="text-align:center;padding:8px 0;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;width:25%;">Status</th><th style="text-align:right;padding:8px 0;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;width:30%;">Date & Time of Approval</th></tr></thead>' +
    '<tbody>' + headApproversHtml + '</tbody></table></div>' +
    // ISM Approvers
    '<div style="margin-bottom: 30px;">' +
    '<h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">ISM InfoSec Approvals</h2>' +
    '<table style="width: 100%; border-collapse: collapse; font-size: 13px;">' +
    '<thead><tr><th style="text-align:left;padding:8px 0;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;width:45%;">Approver</th><th style="text-align:center;padding:8px 0;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;width:25%;">Status</th><th style="text-align:right;padding:8px 0;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;width:30%;">Date & Time of Approval</th></tr></thead>' +
    '<tbody>' + ismApproversHtml + '</tbody></table></div>' +
    // Routing Information
    '<div style="margin-top: 40px; padding-top: 25px; border-top: 2px solid #2a5285; text-align: center;">' +
    '<p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">Implementation Routing</p>' +
    '<p style="margin: 5px 0 0 0; font-size: 15px; font-weight: 600; color: #1a3a5c;">Certificate of Approval</p>' +
    '<p style="margin: 5px 0 0 0; font-size: 13px; color: #9ca3af;">Generated at: ' + escapeHtml_(nowStr) + '</p>' +
    '</div></div>' +
    '<div style="text-align: center; margin-top: 20px; font-size: 12px; color: #9ca3af;">' +
    'This is an automated message. Please proceed with the technical setup or data access granting as described.' +
    '</div></div>';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL NOTIFICATION HELPERS (used by admin failover API)
// ═══════════════════════════════════════════════════════════════════════════════

/*
  Function: logAuditTrail
  LAYMAN:    Writes one row into the audit/queue sheet recording an email event (sent,
             failed, resent) with who/what/when. Every notify* call ends here.
  TECHNICAL: Appends to Risk_Audit: [UUID LogID, sessionId, flagsJson InternalFlags,
             action, active-user email, 'Email System' UserAgent, ISO timestamp].
             flagsObj is JSON-stringified if not already a string. Silent on failure.
  PARAMS:    - sessionId — session/application ID.
             - action — e.g. 'Email Sent' | 'Email Failed' | 'Email Resend'.
             - flagsObj — {recipient, type, attempts, error}.
  RETURNS:   undefined.
*/
function logAuditTrail(sessionId, action, flagsObj) {
  try {
    var ss = getSpreadsheet_();
    var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
    if (!auditSheet) return;
    var userEmail = Session.getActiveUser().getEmail();
    var flagsJson = (typeof flagsObj === 'string') ? flagsObj : JSON.stringify(flagsObj);
    auditSheet.appendRow([
      Utilities.getUuid(),            // LogID
      sessionId,                       // SessionID
      flagsJson,                       // InternalFlags (JSON)
      action,                          // Action
      userEmail,                       // UserEmail
      'Email System',                  // UserAgent
      new Date().toISOString()         // Timestamp
    ]);
  } catch (e) {
    Logger.log('[AUDIT] Failed to write audit log: ' + e.toString());
  }
}

/*
  Function: getApplicationData
  LAYMAN:    Fetches the one Applications row for a given session, or null if there
             isn't one.
  TECHNICAL: Reads Applications via sheetToObjects_ and returns the first row whose
             SessionID matches; null on any error.
  PARAMS:    - sessionId — session/application ID.
  RETURNS:   Row object or null.
*/
function getApplicationData(sessionId) {
  try {
    var ss = getSpreadsheet_();
    var appSheet;
    try { appSheet = getSheet_(SHEET_NAMES.APPLICATIONS); } catch(e) { return null; }
    var rows = sheetToObjects_(appSheet);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].SessionID) === String(sessionId)) {
        return rows[i];
      }
    }
    return null;
  } catch (e) {
    Logger.log('[APP] getApplicationData error: ' + e.toString());
    return null;
  }
}

/*
  Function: notifyApprover
  LAYMAN:    Emails a department approver that a request is waiting on their decision,
             and records whether the email went out.
  TECHNICAL: Reads the session's Approval_Workflow rows, takes the row at stepIndex,
             builds program context from the app's PIA_1_Data, sends a navy
             buildAdminEmailHtml_ message via sendEmailWithRetry_, and logs
             'Email Sent' / 'Email Failed'. Fully try/catch wrapped.
  PARAMS:    - sessionId — session/application ID.
             - stepIndex — 0-based index into the session's workflow rows.
  RETURNS:   {success:true} or {success:false, error}.
*/
function notifyApprover(sessionId, stepIndex) {
  try {
    var ss = getSpreadsheet_();
    var awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
    if (!awSheet) return { success: false, error: 'Approval_Workflow sheet not found.' };

    // Read all workflow rows for this session
    var awRows = sheetToObjectsFiltered_(awSheet, 'SessionID', sessionId);
    if (stepIndex < 0 || stepIndex >= awRows.length) {
      return { success: false, error: 'Step index ' + stepIndex + ' out of range (0-' + (awRows.length - 1) + ').' };
    }

    var step = awRows[stepIndex];
    var approverEmail = String(step.ApproverEmail || '').trim();
    var approverName  = String(step.ApproverName || approverEmail || 'Approver').trim();
    var currentStep   = String(step.CurrentStep || '').trim();

    if (!approverEmail) {
      return { success: false, error: 'No approver email found at step ' + stepIndex + '.' };
    }

    // Build application context
    var app = getApplicationData(sessionId);
    var pia1 = {};
    try { pia1 = app ? JSON.parse(app.PIA_1_Data || '{}') : {}; } catch (e) {}
    var programName = pia1.program || 'Data Privacy Request';

    var subject = '[ACTION REQUIRED] Approval Request for ' + programName + ' (' + sessionId + ')';
    var body = 'Dear ' + approverName + ',\n\n' +
      'You have a pending approval for the following request:\n\n' +
      '  Program: ' + programName + '\n' +
      '  Session ID: ' + sessionId + '\n' +
      '  Step: ' + (currentStep || stepIndex + 1) + '\n\n' +
      'Please log in to the Data Privacy System to review and make your decision.\n\n' +
      '— Data Privacy Admin System';

    var flags = { recipient: approverEmail, type: 'approver', attempts: 1, error: null };
    var htmlBody = buildAdminEmailHtml_({
      heading: 'Action Required — Approval',
      intro: 'Dear ' + approverName + ',',
      bodyHtml: 'You have a <strong>pending approval</strong> awaiting your decision.',
      detailRows: [['Program', programName], ['Session ID', sessionId], ['Step', (currentStep || stepIndex + 1)]],
      ctaText: 'Open the System', ctaUrl: getOptionalUrl_('WEB_APP_URL')
    });

    try {
      sendEmailWithRetry_(approverEmail, subject, body, { htmlBody: htmlBody, replyTo: Session.getActiveUser().getEmail() });
      logAuditTrail(sessionId, 'Email Sent', flags);
      return { success: true };
    } catch (sendErr) {
      flags.error = sendErr.toString();
      logAuditTrail(sessionId, 'Email Failed', flags);
      return { success: false, error: sendErr.toString() };
    }
  } catch (e) {
    Logger.log('[NOTIFY] notifyApprover error: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: notifyApplicant
  LAYMAN:    Emails the person who made the request a status update (approved, denied,
             returned, etc.), with the email color matching the status.
  TECHNICAL: Looks up the app + applicant email, derives an accent color from the
             status keyword, sends a buildAdminEmailHtml_ message via
             sendEmailWithRetry_, and logs the audit row. Try/catch wrapped.
  PARAMS:    - sessionId — session/application ID.
             - currentStatus — display status; falls back to app.Status / 'Updated'.
  RETURNS:   {success:true} or {success:false, error}.
*/
function notifyApplicant(sessionId, currentStatus) {
  try {
    var app = getApplicationData(sessionId);
    if (!app) return { success: false, error: 'Application not found for session ' + sessionId + '.' };

    var applicantEmail = String(app.ApplicantEmail || '').trim();
    if (!applicantEmail) return { success: false, error: 'No applicant email on record.' };

    var pia1 = {};
    try { pia1 = JSON.parse(app.PIA_1_Data || '{}'); } catch (e) {}
    var programName = pia1.program || 'Data Privacy Request';

    var statusDisplay = currentStatus || String(app.Status || 'Updated');
    var subject = '[STATUS UPDATE] ' + programName + ' — ' + statusDisplay;
    var body = 'Dear Applicant,\n\n' +
      'Your request status has been updated:\n\n' +
      '  Program: ' + programName + '\n' +
      '  Session ID: ' + sessionId + '\n' +
      '  Status: ' + statusDisplay + '\n\n' +
      'Please log in to the Data Privacy System for more details.\n\n' +
      '— Data Privacy Admin System';

    var flags = { recipient: applicantEmail, type: 'applicant', attempts: 1, error: null };
    var sLower = String(statusDisplay).toLowerCase();
    var statusAccent = (sLower.indexOf('approv') !== -1 || sLower.indexOf('complet') !== -1) ? '#1D9E75'
                     : (sLower.indexOf('deni') !== -1 || sLower.indexOf('reject') !== -1) ? '#A22D2D'
                     : (sLower.indexOf('return') !== -1) ? '#b46d14' : '#2a5285';
    var htmlBody = buildAdminEmailHtml_({
      heading: 'Application Status Update', accent: statusAccent,
      intro: 'Dear Applicant,',
      bodyHtml: 'Your request status is now <strong>' + statusDisplay + '</strong>.',
      detailRows: [['Program', programName], ['Session ID', sessionId], ['Status', statusDisplay]],
      ctaText: 'View Details', ctaUrl: getOptionalUrl_('WEB_APP_URL')
    });

    try {
      sendEmailWithRetry_(applicantEmail, subject, body, { htmlBody: htmlBody, replyTo: Session.getActiveUser().getEmail() });
      logAuditTrail(sessionId, 'Email Sent', flags);
      return { success: true };
    } catch (sendErr) {
      flags.error = sendErr.toString();
      logAuditTrail(sessionId, 'Email Failed', flags);
      return { success: false, error: sendErr.toString() };
    }
  } catch (e) {
    Logger.log('[NOTIFY] notifyApplicant error: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_NotifyISMember
  LAYMAN:    Emails an ISM reviewer that a request needs their review at a particular
             step.
  TECHNICAL: Finds the ISM_Approval_Workflow row whose CurrentStep equals stepNumber
             (1-based), builds program context, sends a buildAdminEmailHtml_ message
             via sendEmailWithRetry_, and logs 'Email Sent' / 'Email Failed'.
             Try/catch wrapped.
  PARAMS:    - sessionId — session/application ID.
             - stepNumber — 1-based step matching the CurrentStep column.
  RETURNS:   {success:true} or {success:false, error}.
*/
function apiPhase3_NotifyISMember(sessionId, stepNumber) {
  try {
    var ss = getSpreadsheet_();
    var ismSheet = ss.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
    if (!ismSheet) return { success: false, error: 'ISM_Approval_Workflow sheet not found.' };

    var ismRows = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);
    // stepNumber is 1-based (maps to CurrentStep column)
    var targetStep = null;
    for (var i = 0; i < ismRows.length; i++) {
      var stepVal = parseInt(String(ismRows[i].CurrentStep || '0'), 10);
      if (stepVal === stepNumber) {
        targetStep = ismRows[i];
        break;
      }
    }
    if (!targetStep) {
      return { success: false, error: 'No ISM step found at step ' + stepNumber + ' for session ' + sessionId + '.' };
    }

    var ismEmail = String(targetStep.ISM_Member_Email || '').trim();
    var ismName  = String(targetStep.ISM_Member_Name || ismEmail || 'ISM Member').trim();

    if (!ismEmail) {
      return { success: false, error: 'No ISM member email at step ' + stepNumber + '.' };
    }

    var app = getApplicationData(sessionId);
    var pia1 = {};
    try { pia1 = app ? JSON.parse(app.PIA_1_Data || '{}') : {}; } catch (e) {}
    var programName = pia1.program || 'Data Privacy Request';

    var subject = '[ISM ACTION REQUIRED] Review Request for ' + programName + ' (' + sessionId + ')';
    var body = 'Dear ' + ismName + ',\n\n' +
      'You have a pending ISM review for the following request:\n\n' +
      '  Program: ' + programName + '\n' +
      '  Session ID: ' + sessionId + '\n' +
      '  Step: ' + stepNumber + '\n\n' +
      'Please log in to the Data Privacy System to review and make your decision.\n\n' +
      '— Data Privacy Admin System';

    var flags = { recipient: ismEmail, type: 'ism', attempts: 1, error: null };
    var htmlBody = buildAdminEmailHtml_({
      heading: 'ISM Action Required',
      intro: 'Dear ' + ismName + ',',
      bodyHtml: 'You have a <strong>pending ISM review</strong> awaiting your decision.',
      detailRows: [['Program', programName], ['Session ID', sessionId], ['Step', stepNumber]],
      ctaText: 'Open the System', ctaUrl: getOptionalUrl_('WEB_APP_URL')
    });

    try {
      sendEmailWithRetry_(ismEmail, subject, body, { htmlBody: htmlBody, replyTo: Session.getActiveUser().getEmail() });
      logAuditTrail(sessionId, 'Email Sent', flags);
      return { success: true };
    } catch (sendErr) {
      flags.error = sendErr.toString();
      logAuditTrail(sessionId, 'Email Failed', flags);
      return { success: false, error: sendErr.toString() };
    }
  } catch (e) {
    Logger.log('[NOTIFY] apiPhase3_NotifyISMember error: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN EMAIL FAILOVER API — called by Admin Panel via google.script.run
// ═══════════════════════════════════════════════════════════════════════════════

/*
  Function: adminGetEmailLog
  LAYMAN:    Returns the email history (sent/failed/resent) for one session, oldest
             first, for the Admin Panel's email log view.
  TECHNICAL: Reads Risk_Audit, keeps rows whose Action starts with 'Email ' (or equals
             'Email Resend') AND whose SessionID matches, parses InternalFlags into
             {recipient,type,attempts,error}, and sorts by timestamp ascending.
  PARAMS:    - sessionId — required.
  RETURNS:   {success:true, data:[{logId,action,flags,timestamp}...]}
             or {success:false, error}.
*/
function adminGetEmailLog(sessionId) {
  try {
    if (!sessionId || String(sessionId).trim() === '') {
      return { success: false, error: 'Session ID is required.' };
    }
    sessionId = String(sessionId).trim();

    var ss = getSpreadsheet_();
    var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
    if (!auditSheet) {
      return { success: false, error: 'Risk_Audit sheet not found.' };
    }

    var rows = sheetToObjects_(auditSheet);
    var results = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var action = String(r.Action || '');

      // Only include Email* actions
      if (action.indexOf('Email ') !== 0 && action !== 'Email Resend') continue;

      // Filter by sessionId (SessionID column)
      if (String(r.SessionID) !== sessionId) continue;

      var flags = {};
      try {
        var rawFlags = String(r.InternalFlags || '{}');
        flags = JSON.parse(rawFlags);
      } catch (e) {
        flags = { _raw: rawFlags };
      }

      results.push({
        logId:     String(r.LogID || ''),
        action:    action,
        flags: {
          recipient: String(flags.recipient || ''),
          type:      String(flags.type || ''),
          attempts:  Number(flags.attempts) || 1,
          error:     flags.error || null
        },
        timestamp: String(r.Timestamp || '')
      });
    }

    // Sort by timestamp ascending
    results.sort(function(a, b) { return a.timestamp.localeCompare(b.timestamp); });

    return { success: true, data: results };
  } catch (e) {
    Logger.log('[ADMIN] adminGetEmailLog error: ' + e.toString());
    return { success: false, error: 'adminGetEmailLog: ' + e.toString() };
  }
}

/*
  Function: adminGetFailedEmails
  LAYMAN:    Lists the emails that failed to send in the last N days, newest first, so
             an admin can retry them.
  TECHNICAL: Reads Risk_Audit, keeps rows with Action exactly 'Email Failed' whose
             timestamp is within sinceDays (default 7), maps InternalFlags fields, and
             sorts by timestamp descending.
  PARAMS:    - sinceDays — lookback window in days (default 7; invalid -> 7).
  RETURNS:   {success:true, data:[...], sinceDays} or {success:false, error}.
*/
function adminGetFailedEmails(sinceDays) {
  try {
    if (sinceDays === undefined || sinceDays === null) sinceDays = 7;
    sinceDays = Number(sinceDays);
    if (isNaN(sinceDays) || sinceDays < 0) sinceDays = 7;

    var ss = getSpreadsheet_();
    var auditSheet = ss.getSheetByName(SHEET_NAMES.RISK_AUDIT);
    if (!auditSheet) {
      return { success: false, error: 'Risk_Audit sheet not found.' };
    }

    var rows = sheetToObjects_(auditSheet);
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - sinceDays);

    var results = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (String(r.Action || '') !== 'Email Failed') continue;

      // Parse timestamp and check date range
      var ts = String(r.Timestamp || '');
      var rowDate = new Date(ts);
      if (isNaN(rowDate.getTime()) || rowDate < cutoff) continue;

      var flags = {};
      try {
        flags = JSON.parse(String(r.InternalFlags || '{}'));
      } catch (e) {
        flags = {};
      }

      results.push({
        sessionId: String(r.SessionID || ''),
        recipient: String(flags.recipient || ''),
        type:      String(flags.type || ''),
        error:     flags.error || null,
        timestamp: ts,
        attempts:  Number(flags.attempts) || 1
      });
    }

    // Sort by timestamp descending (most recent first)
    results.sort(function(a, b) { return b.timestamp.localeCompare(a.timestamp); });

    return { success: true, data: results, sinceDays: sinceDays };
  } catch (e) {
    Logger.log('[ADMIN] adminGetFailedEmails error: ' + e.toString());
    return { success: false, error: 'adminGetFailedEmails: ' + e.toString() };
  }
}

/*
  Function: adminResendEmail
  LAYMAN:    Re-sends a stuck notification to a specific person, figuring out which
             kind of email it should be (approver, applicant, or ISM) and finding the
             right pending step for that recipient.
  TECHNICAL: Validates type in {approver,applicant,ism} and that the app exists. For
             'approver'/'ism' it locates the recipient's pending step in the relevant
             workflow sheet and calls notifyApprover / apiPhase3_NotifyISMember; for
             'applicant' it calls notifyApplicant with the current status. Logs an
             'Email Resend' audit row regardless of outcome.
  PARAMS:    - sessionId — required.
             - recipient — intended email address.
             - type — 'approver' | 'applicant' | 'ism'.
  RETURNS:   {success, error, message}.

  STEPS
    Step 1 — Validate sessionId, type, and application existence.
    Step 2 — Resolve the recipient's pending step (approver/ism) and notify.
    Step 3 — Log the resend; return the outcome.
*/
function adminResendEmail(sessionId, recipient, type) {
  try {
    if (!sessionId || String(sessionId).trim() === '') {
      return { success: false, error: 'Session ID is required.', message: '' };
    }
    sessionId = String(sessionId).trim();

    var validTypes = ['approver', 'applicant', 'ism'];
    var normalizedType = String(type || '').trim().toLowerCase();
    if (validTypes.indexOf(normalizedType) === -1) {
      return { success: false, error: 'Invalid type "' + type + '". Must be approver, applicant, or ism.', message: '' };
    }

    // Validate application exists
    var app = getApplicationData(sessionId);
    if (!app) {
      return { success: false, error: 'Application not found for Session ID: ' + sessionId, message: '' };
    }

    var result;

    switch (normalizedType) {
      case 'approver':
        var ss = getSpreadsheet_();
        var awSheet = ss.getSheetByName(SHEET_NAMES.APPROVAL_WORKFLOW);
        if (!awSheet) return { success: false, error: 'Approval_Workflow sheet not found.', message: '' };

        var awRows = sheetToObjectsFiltered_(awSheet, 'SessionID', sessionId);

        // Find the step that has a pending status AND matches the recipient email
        var targetStepIndex = -1;
        for (var i = 0; i < awRows.length; i++) {
          var stepEmail = String(awRows[i].ApproverEmail || '').trim().toLowerCase();
          var stepStatus = String(awRows[i].Status || awRows[i].Decision || '').toLowerCase();
          if (stepEmail === recipient.toLowerCase() &&
              (stepStatus === '' || stepStatus === 'pending' || stepStatus === 'in progress')) {
            targetStepIndex = i;
            break;
          }
        }

        if (targetStepIndex === -1) {
          return {
            success: false,
            error: 'No pending approval step found for recipient ' + recipient,
            message: ''
          };
        }

        result = notifyApprover(sessionId, targetStepIndex);
        break;

      case 'applicant':
        result = notifyApplicant(sessionId, String(app.Status || 'Updated'));
        break;

      case 'ism':
        var ismSs = getSpreadsheet_();
        var ismSheet = ismSs.getSheetByName(SHEET_NAMES.ISM_APPROVAL);
        if (!ismSheet) return { success: false, error: 'ISM_Approval_Workflow sheet not found.', message: '' };

        var ismRows = sheetToObjectsFiltered_(ismSheet, 'SessionID', sessionId);

        // Find the step matching recipient
        var targetStepNum = -1;
        for (var j = 0; j < ismRows.length; j++) {
          var ismEmail = String(ismRows[j].ISM_Member_Email || '').trim().toLowerCase();
          var ismStatus = String(ismRows[j].Status || ismRows[j].Decision || '').toLowerCase();
          if (ismEmail === recipient.toLowerCase() &&
              (ismStatus === '' || ismStatus === 'pending' || ismStatus === 'in progress')) {
            targetStepNum = parseInt(String(ismRows[j].CurrentStep || (j + 1)), 10);
            break;
          }
        }

        if (targetStepNum === -1) {
          return {
            success: false,
            error: 'No pending ISM step found for recipient ' + recipient,
            message: ''
          };
        }

        result = apiPhase3_NotifyISMember(sessionId, targetStepNum);
        break;

      default:
        return { success: false, error: 'Unhandled type: ' + normalizedType, message: '' };
    }

    // Log the resend action
    var resendFlags = {
      recipient: recipient,
      type: normalizedType,
      attempts: 1,
      error: result && result.success ? null : (result ? result.error : 'Unknown error')
    };
    logAuditTrail(sessionId, 'Email Resend', resendFlags);

    if (result && result.success) {
      return { success: true, error: null, message: 'Email resent successfully to ' + recipient };
    } else {
      return { success: false, error: result ? result.error : 'Failed to send email', message: '' };
    }
  } catch (e) {
    Logger.log('[ADMIN] adminResendEmail error: ' + e.toString());
    return { success: false, error: e.toString(), message: '' };
  }
}

/*
  Function: checkProperties
  LAYMAN:    Quick editor check that logs whether the API key is configured (masked).
  TECHNICAL: Logs ADMIN_API_KEY presence with a 6-char prefix; no return value.
  PARAMS:    (none)
  RETURNS:   undefined (logs only).
*/
function checkProperties() {
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');
  Logger.log('ADMIN_API_KEY: ' + (key ? '✅ SET (' + key.substring(0, 6) + '...)' : '❌ MISSING'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API — Self-Test (run from Apps Script editor to verify all endpoints)
// ═══════════════════════════════════════════════════════════════════════════════

/*
  Function: testAdminApi
  LAYMAN:    A self-test you run from the Apps Script editor to confirm the whole Admin
             API is wired up: API key set, spreadsheet reachable, all sheets present,
             auth rejects bad keys, and the main endpoints respond. Prints a pass/fail
             report to the log.
  TECHNICAL: Sequentially asserts config, getSpreadsheet_, sheet existence, auth
             rejection/acceptance, unknown-action handling, and a sampling of
             adminApi_* endpoints (with dummy IDs), plus doPost JSON routing. Tallies
             passed/failed via the local assert_ helper and logs results.
  PARAMS:    (none)
  RETURNS:   {passed, failed, total, details:[...]}.
*/
function testAdminApi() {
  Logger.log('═══════════════════════════════════════════');
  Logger.log('ADMIN API SELF-TEST');
  Logger.log('═══════════════════════════════════════════');
  var passed = 0, failed = 0;
  var results = [];

  function assert_(name, cond, detail) {
    if (cond) { passed++; results.push('✅ ' + name); }
    else { failed++; results.push('❌ ' + name + (detail ? ' — ' + detail : '')); }
  }

  try {
    // ── 1. API Key check ──
    Logger.log('\n── 1. Configuration ──');
    var key = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');
    assert_('ADMIN_API_KEY is set', !!key && key.length >= 8, key ? 'Key length: ' + key.length : 'NOT SET');
    results.push('   ADMIN_API_KEY: ' + (key ? '✅ SET (' + key.substring(0, 6) + '...' + key.length + ' chars)' : '❌ MISSING'));

    // ── 2. Spreadsheet access ──
    Logger.log('\n── 2. Spreadsheet Access ──');
    try {
      var ss = getSpreadsheet_();
      assert_('getSpreadsheet_()', true, ss.getName());
    } catch (e) {
      assert_('getSpreadsheet_()', false, e.message);
    }

    // ── 3. Sheet existence ──
    Logger.log('\n── 3. Sheet Checks ──');
    var sheets = ['Data_Collection', 'Applications', 'Approval_Workflow', 'ISM_Approval_Workflow',
                  'DivisionHead_Approval_Workflow', 'Risk_Audit', 'InfoSec_Email_Config', 'System_Configuration'];
    for (var i = 0; i < sheets.length; i++) {
      try {
        var s = getSheet_(sheets[i]);
        assert_('Sheet: ' + sheets[i], !!s, 'Rows: ' + s.getLastRow());
      } catch (e) {
        assert_('Sheet: ' + sheets[i], false, e.message);
      }
    }

    // ── 4. Auth check ──
    Logger.log('\n── 4. API Auth ──');
    var fakeResp1 = handleAdminApi_({ apiKey: 'bad-key', action: 'getQueueSummary', params: {} });
    assert_('Rejects bad API key', fakeResp1 && !fakeResp1.success && fakeResp1.error.indexOf('Unauthorized') === 0, fakeResp1.error);
    if (key) {
      var fakeResp2 = handleAdminApi_({ apiKey: key, action: 'getQueueSummary', params: {} });
      assert_('Accepts valid API key', fakeResp2 && fakeResp2.success === true, fakeResp2.error);
    }

    // ── 5. Unknown action ──
    Logger.log('\n── 5. Unknown Action ──');
    var unkResp = handleAdminApi_({ apiKey: key || 'test', action: 'nonexistentAction', params: {} });
    assert_('Rejects unknown action', unkResp && !unkResp.success && unkResp.error.indexOf('Unknown') !== -1, unkResp.error);

    // ── 6. getQueueSummary ──
    Logger.log('\n── 6. getQueueSummary ──');
    if (key) {
      var qsResult = adminApi_getQueueSummary({});
      assert_('getQueueSummary succeeds', qsResult && qsResult.success, qsResult.error);
      if (qsResult && qsResult.success && qsResult.data) {
        var d = qsResult.data;
        assert_('Has totalPending', d.totalPending !== undefined);
        assert_('Has totalFailed', d.totalFailed !== undefined);
        assert_('Has queueHealth', d.queueHealth !== undefined);
      }
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 7. getEmailQueue ──
    Logger.log('\n── 7. getEmailQueue ──');
    if (key) {
      var eqResult = adminApi_getEmailQueue({ limit: 5 });
      assert_('getEmailQueue succeeds', eqResult && eqResult.success, eqResult.error);
      if (eqResult && eqResult.success) {
        assert_('Returns data array', Array.isArray(eqResult.data));
        assert_('Respects limit (≤5)', eqResult.data.length <= 5, 'Returned: ' + eqResult.data.length);
      }
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 8. getEmailLog ──
    Logger.log('\n── 8. getEmailLog ──');
    if (key) {
      var elResult = adminApi_getEmailLog('PIA-000222');
      assert_('getEmailLog returns (may be empty)', elResult && elResult.success === true, elResult.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 9. getFailedEmails ──
    Logger.log('\n── 9. getFailedEmails ──');
    if (key) {
      var feResult = adminApi_getFailedEmails(30);
      assert_('getFailedEmails succeeds', feResult && feResult.success, feResult.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 10. getNotificationConfig ──
    Logger.log('\n── 10. getNotificationConfig ──');
    if (key) {
      var ncResult = adminApi_getNotificationConfig();
      assert_('getNotificationConfig succeeds', ncResult && ncResult.success, ncResult.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 11. getPipelineView (with dummy ID) ──
    Logger.log('\n── 12. getPipelineView ──');
    if (key) {
      var pvResult = adminApi_getPipelineView('PIA-000222');
      assert_('getPipelineView returns (may be not-found)', pvResult && (pvResult.success || pvResult.error), pvResult.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 13. retryQueuedEmail (with dummy ID) ──
    Logger.log('\n── 13. retryQueuedEmail ──');
    if (key) {
      var rqResult = adminApi_retryQueuedEmail('nonexistent-id');
      assert_('retryQueuedEmail handles not-found gracefully', rqResult && !rqResult.success, rqResult.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 14. resendToStage validation ──
    Logger.log('\n── 14. resendToStage ──');
    if (key) {
      var rsResult1 = adminApi_resendToStage('', 'invalid', '');
      assert_('Rejects empty sessionId', rsResult1 && !rsResult1.success);
      var rsResult2 = adminApi_resendToStage('fake-session', 'invalid', '');
      assert_('Rejects invalid stageType', rsResult2 && !rsResult2.success && rsResult2.error.indexOf('Invalid stage') !== -1, rsResult2.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 15. doPost JSON routing ──
    Logger.log('\n── 15. doPost JSON parsing ──');
    var fakeEvent = { postData: { type: 'application/json', contents: '{"apiKey":"' + (key || 'test') + '","action":"getQueueSummary","params":{}}' } };
    try {
      var dpResult = doPost(fakeEvent);
      assert_('doPost routes JSON to handler', dpResult && dpResult.getMimeType() === ContentService.MimeType.JSON);
    } catch (e) {
      assert_('doPost routes JSON', false, e.message);
    }

  } catch (e) {
    results.push('💥 FATAL TEST ERROR: ' + e.toString());
    failed++;
  }

  // ── Summary ──
  Logger.log('\n═══════════════════════════════════════════');
  Logger.log('RESULTS: ' + passed + ' passed, ' + failed + ' failed (' + (passed + failed) + ' total)');
  Logger.log('═══════════════════════════════════════════');
  for (var i = 0; i < results.length; i++) { Logger.log(results[i]); }

  return { passed: passed, failed: failed, total: passed + failed, details: results };
}
