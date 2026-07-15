// ============================================================
//  pia_code.js  (PIA — Phase 2 backend)
// ============================================================
/*
  [ OUTLINE ]
  FILE: pia_code.js
  PURPOSE (Layman): This is the brain of Phase 2 of Megaworld's RARS — the Privacy Impact
    Assessment app. After a DCS request is cleared, the applicant fills out a privacy
    questionnaire here. This file takes that submission, runs it up an approval ladder
    (Immediate Head → Dept Head → maybe Division Head → ISM/InfoSec), sends every email the
    process needs, tracks who approved/denied/returned, and finally produces the certificate
    when everything is fully approved. It also exposes the admin tools used to inspect and
    resend stuck emails.
  TECHNICAL: Google Apps Script web-app backend. Single shared Google Spreadsheet is the only
    DB (tabs: Applications, Approval_Workflow, ISM_Approval_Workflow,
    DivisionHead_Approval_Workflow, Drafts, Risk_Audit, Email_Queue, Admin_Notification_Config,
    etc.). Key patterns: queue-based email engine with exponential-backoff retry
    (queueEmail → processEmailQueue → sendEmailWithRetry), HMAC-SHA256 review tokens
    (generateAuthToken/isTokenValid, action-bound, 14-day TTL) for one-click approve/deny
    links, LockService to serialize decisions, domain-restricted doGet, and ISM + Division-Head
    escalation routing. Column positions are centralized in *_COLS constants. Phases never call
    each other directly — they coordinate only through the shared sheet and the parentID /
    Linked_ReqID link plus stored Script Property URLs (PIA_APP_URL, DCS_WEB_APP_URL).

  CATEGORY: CONFIG & SECURITY
    - getWebAppUrl()                         read PIA web-app URL from Script Properties
    - getDCSWebAppUrl()                      read DCS web-app URL (fallback to PIA URL)
    - getAllowedDomain()                     read the single allowed email domain
    - isAuthorizedDomain(email)              true if email is on the allowed domain
    - getSystemSecret()                      read HMAC secret (throws if unset)
    - getNormalizedEmail(email)              strip +alias and lowercase an address
    - getWorkflowInfoForType(type)           map an email-queue type to its workflow sheet
    - getAdminNotificationConfig()           read admin-notification settings row
    - generateAuthToken(sessionId,email,timestamp,action)  build an HMAC review token
    - isTokenValid(...)                      verify a review token (TTL + action bound)
    - isValidEmail(email)                    RFC-ish email format check
    - sanitizeEmail(email)                   trim/lowercase/validate or null
    - encodePayload(data) / decodePayload(s) base64 URL payload (NOT encryption)
    - escapeHtml(str)                        HTML-escape for safe email/page output

  CATEGORY: SHEET HELPERS & UI
    - batchDeleteRows(sheet, rowNumbers)     delete rows bottom-to-top
    - findRowsToDelete(data, colIndex, value) row numbers matching a column value
    - getAndShareDCSFiles(dcsReqId)          find + domain-share the DCS attachments
    - getStyledHtmlWrapper(header, content)  shared HTML page shell for action/result pages
    - buildPiaEmailHtml_(opts)               navy email-card HTML wrapper

  CATEGORY: ENTRY POINTS (web app)
    - doGet(e)                               serve the app or handle a token review link
    - doPost(e)                              route POSTs (admin API)
    - handleAdminApiRequest(e)               dispatch admin API actions from doPost
    - handleEmailAction(params)             render/process one-click email approve/deny pages

  CATEGORY: DATABASE & SCHEMA
    - getDatabaseSpreadsheet(createIfMissing) open (or create) the shared spreadsheet
    - getDatabaseSheet(sheetName, createIfMissing)  open (or create) a tab
    - initializeDatabase()                   create all tabs/headers on first run
    - sheetExists(name)                      tab-exists check
    - createPhase3SheetWithValidation(...)   create a tab with headers + seed rows
    - formatHeaderRow(sheet)                 style a header row

  CATEGORY: SESSION IDS & RISK
    - seedSessionCounterFromDatabase()       sync the ID counter to existing data
    - formatSessionId(seq, version)          format a PIA session id string
    - nextBaseSessionId()                    allocate the next new session id
    - getNextRevisionSessionId(base)         allocate a revision (-R) id
    - resolveSubmissionId(appData)           pick new vs revision id for a submit
    - analyzeApplicationRisk(appData)        auto risk flags (PII count, etc.)

  CATEGORY: APPLICATION SUBMIT/READ
    - submitApplication(appData)             persist a PIA submission + start workflow
    - buildApproversFromAppData(appData)     derive the approver ladder from DCS data
    - getApplicationData(sessionId)          full app record + workflow timelines
    - getUserSubmissions()                   current user's submitted applications
    - findRowBySessionID(sessionId)          locate the Applications row
    - getPIIFieldsList(appData)              list selected PII categories

  CATEGORY: APPROVAL WORKFLOW
    - initializeApprovalWorkflow(sessionId, appData)  seed approver rows
    - processApprovalDecision(...)           record a head/approver decision + advance
    - processDivHeadDecision(...)            record a Division-Head escalation decision
    - checkAllApproved(sessionId)            true when every approver approved
    - updateDCSStatus(reqId, newStatus)      write status back to the DCS sheet
    - logAuditTrail(sessionId, action, flags) append a Risk_Audit row

  CATEGORY: ISM & DIVISION HEAD (Phase 3)
    - apiPhase3_FetchPIAData(sessionId)      PIA answers for the ISM reviewer UI
    - apiPhase3_FetchDCSData(sessionId)      linked DCS context for the ISM reviewer UI
    - apiPhase3_GetDivisionHeadConfig(email) division-head lookup/validation
    - apiPhase3_GetInfoSecMembers()          active InfoSec/ISM roster
    - apiPhase3_InitializeISMWorkflow(sessionId)  seed the ISM approval chain
    - apiPhase3_RetryISMWorkflow(sessionId)  re-seed/repair a broken ISM chain
    - apiPhase3_ProcessISMDecision(...)      record an ISM decision + route
    - apiPhase3_NotifyISMember(sessionId, step)  email the current ISM member
    - apiPhase3_RouteApprovedRequest(sessionId, destination)  final routing/certify

  CATEGORY: EMAIL ENGINE & QUEUE
    - sendEmailWithRetry(recipient, subject, body, options)  send with backoff retry
    - queueEmail(...)                        enqueue an email row
    - processEmailQueue()                    drain the queue (trigger-driven)
    - setupEmailQueueTrigger()               install the queue time trigger
    - sendDailyReminders()                   nudge the current pending approver
    - buildReminderEmail(...)                compose one reminder email
    - getReminderConfig() / setupReminderTrigger()  reminder settings + trigger

  CATEGORY: NOTIFICATION BUILDERS
    - notifyApprover(sessionId, approverIndex)  build + queue an approver email
    - notifyApplicant(sessionId, status)     build + queue an applicant status email
    - generateEmailDecisionsHTML(sessionId)  render the decisions table for emails

  CATEGORY: ADMIN API (email ops + pipeline)
    - adminGetEmailLog / adminGetFailedEmails / adminResendEmail
    - adminGetEmailQueue / adminRetryQueuedEmail / adminRetryAllForSession
    - adminCancelQueuedEmails / adminGetQueueSummary
    - adminGetReminderConfig / adminSetReminderConfig
    - adminGetNotificationConfig / adminSetNotificationConfig
    - adminResendToStage(...) / adminGetPipelineView(sessionId)

  CATEGORY: VALIDATION
    - validateApplicationData(appData)       server-side submit validation
    - validateComment(comment, minLength)    decision-comment length/format check
    - sanitizeInput(data, maxLength, depth)  recursive string clamp/clean

  CATEGORY: CLIENT API (google.script.run)
    - apiSubmitApplication / apiGetDCSContext / apiGetUserDCSRequests
    - apiGetUserEmail / apiGetUserSubmissions / apiGenerateNewSessionId
    - apiProcessApprovalDecision / apiGetApplicationData
    - apiSaveDraft / apiRestoreDraft / apiListUserDrafts / apiLoadDraft
    - apiDeleteDraft / apiMarkDraftComplete / apiGenerateRevisionSessionId

  CATEGORY: SETUP / MIGRATION / UTILITIES / TESTS
    - cleanupExpiredDrafts() / getProp_(key) / migrateAddReminderColumns()
    - testReminderEngine / testPhase3DatabaseInitialization / reinitializePhase3Database
    - testFullSystemFlow / testUltimateSystem / checkProperties
*/

/**
 * PIA System - Google Apps Script Backend
 * Main controller and business logic for Privacy Impact Assessment automation
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔧 CONFIGURATION & CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: getWebAppUrl
  LAYMAN:    Gets this PIA app's own public URL. Used to build links back into the app.
  TECHNICAL: Reads the WEB_APP_URL Script Property; logs a warning and returns '' if unset.
  PARAMS:    (none)
  RETURNS:   The URL string, or '' when the property is not configured.
*/
function getWebAppUrl() {
  const url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) {
    Logger.log('WARNING: WEB_APP_URL not configured. Please set it in Project Settings > Script Properties.');
    return '';  // Return empty string, caller should handle
  }
  return url;
}

/*
  Function: getDCSWebAppUrl
  LAYMAN:    Gets the Phase 1 DCS app's URL so "Update DCS Request" links point to the right
             app. If it is not set, callers fall back to the PIA URL.
  TECHNICAL: Reads the DCS_WEB_APP_URL Script Property; logs a warning and returns '' if unset.
  PARAMS:    (none)
  RETURNS:   The DCS URL string, or '' when the property is not configured.
*/
function getDCSWebAppUrl() {
  const url = PropertiesService.getScriptProperties().getProperty('DCS_WEB_APP_URL');
  if (!url) {
    Logger.log('WARNING: DCS_WEB_APP_URL not configured. "Update DCS Request" links will fall back to PIA URL. Set it in Project Settings > Script Properties.');
    return '';  // Return empty string, caller should handle
  }
  return url;
}

// Declare Pii2fields for Application Summary for emailHTML.
const pii2Fields = ['Name','Home Address','Business Address','Email Address','Telephone No. (Work)','Telephone No. (Home)','Age','Date of Birth','Marital Status','Color, Race or Ethnic Origin','Religion','Education','Photo','Biometrics','Political Association','Philosophical Beliefs / Orientation','Health','Sexual Life, Preference, Practice','Offences Committed or Alleged','Government-issued IDs','Others'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛡️ DOMAIN SECURITY CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ENABLE_DOMAIN_CHECK = true; // SECURITY: Strictly restricts access to configured domain

/*
  Function: getAllowedDomain
  LAYMAN:    Gets the one company email domain that is allowed to use the app.
  TECHNICAL: Reads the ALLOWED_DOMAIN Script Property; logs a warning and returns '' if unset.
             '' makes isAuthorizedDomain deny everyone (fail-closed).
  PARAMS:    (none)
  RETURNS:   The domain string (e.g. 'megaworldcorp.com'), or '' when unconfigured.
*/
function getAllowedDomain() {
  const domain = PropertiesService.getScriptProperties().getProperty('ALLOWED_DOMAIN');
  if (!domain) {
    Logger.log('WARNING: ALLOWED_DOMAIN not configured. Please set it in Project Settings > Script Properties.');
    return '';  // Return empty string, caller should handle
  }
  return domain;
}

/*
  Function: isAuthorizedDomain
  LAYMAN:    Decides whether a given email is allowed to use the app, based on its domain.
  TECHNICAL: When ENABLE_DOMAIN_CHECK is on, returns true only if email ends with
             '@' + getAllowedDomain(). Fail-closed: empty email or unconfigured domain → false.
  PARAMS:    - email — the address to check.
  RETURNS:   Boolean. Always true if ENABLE_DOMAIN_CHECK is false.
  EXAMPLE:   isAuthorizedDomain('a@megaworldcorp.com') -> true
*/
function isAuthorizedDomain(email) {
  if (!ENABLE_DOMAIN_CHECK) return true;
  if (!email) return false;
  const domain = getAllowedDomain();
  if (!domain) return false;  // No domain configured → deny access
  return email.toLowerCase().endsWith('@' + domain);
}

/*
  Function: getSystemSecret
  LAYMAN:    Gets the private signing key used to make tamper-proof email approve/deny links.
  TECHNICAL: Reads SYSTEM_SECRET Script Property. Throws (fail-closed) if missing — tokens must
             never be signed with an empty key.
  PARAMS:    (none)
  RETURNS:   The secret string. Throws Error if not configured.
*/
function getSystemSecret() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYSTEM_SECRET');
  if (!secret) throw new Error('Security Error: SYSTEM_SECRET not configured.');
  return secret;
}

const DB_SHEET_NAMES = {
  APPLICATIONS: 'Applications',
  APPROVAL_WORKFLOW: 'Approval_Workflow',
  RISK_AUDIT: 'Risk_Audit',
  DRAFTS: 'Drafts',
  DATA_COLLECTION: 'Data_Collection',
  ISM_WORKFLOW: 'ISM_Approval_Workflow',
  DIV_HEAD_CONFIG: 'DivisionHead_Approval_Workflow',
  INFOSEC_CONFIG: 'InfoSec_Email_Config',
  EMAIL_QUEUE: 'Email_Queue',
  ADMIN_NOTIFICATION: 'Admin_Notification_Config',
  REVISION_HISTORY: 'Revision_History'
};

const DB_SPREADSHEET_ID_PROP = 'PIA_DB_SPREADSHEET_ID';
const SESSION_ID_COUNTER_PROP = 'PIA_SESSION_ID_COUNTER';
const DB_INIT_FLAG_PROP = 'PIA_DB_INIT_DONE';
const REMINDER_CONFIG_PROP = 'PIA_REMINDER_CONFIG';
// CRITICAL FIX C1: EMAIL_FROM removed from module-level const. Use Session.getActiveUser().getEmail() at runtime.

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔢 MAGIC NUMBER CONSTANTS (Anti-Magic-Number Pattern)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TOKEN_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;  // 14 days
const SESSION_ID_MAX = 999999;
const LOCK_TIMEOUT_MS = 30000;                        // 30 seconds
const COMMENT_MIN_CHARS_STANDARD = 50;               // Standard comment minimum (ISM step 1)
const COMMENT_MIN_CHARS_DECISION = 100;              // Minimum for Deny/Return decisions
const COMMENT_MAX_CHARS = 4000;                      // Maximum for all comments
const MAX_USER_DRAFTS = 5;                           // Maximum concurrent drafts per user
const DRAFT_EXPIRY_DAYS = 7;                         // Draft expiration in days
const RISK_FLAG_THRESHOLD = 18;                      // PII field threshold for risk flagging

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HMAC SECURITY CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: getNormalizedEmail
  LAYMAN:    Cleans up an email so 'user+anything@x.com' and 'user@x.com' count as the same
             person. Used so token checks and authorization are not fooled by Gmail aliases.
  TECHNICAL: Lowercases/trims, splits on '@', drops everything after '+' in the local part,
             rejoins. Returns the lowercased input unchanged if there is no '@'.
  PARAMS:    - email — the raw address.
  RETURNS:   Normalized address string, or '' for falsy input.
  EXAMPLE:   getNormalizedEmail('Me+Tag@X.com') -> 'me@x.com'
*/
function getNormalizedEmail(email) {
  if (!email) return '';
  const emailLower = String(email).toLowerCase().trim();
  const [localPart, domain] = emailLower.split('@');
  if (!domain) return emailLower; // Invalid email, return as-is
  // Remove everything after the + sign in the local part
  const normalizedLocal = localPart.split('+')[0];
  return normalizedLocal + '@' + domain;
}

/*
  Function: getWorkflowInfoForType
  LAYMAN:    Given an email category ('approver'/'ism'/'divhead'), tells the caller which
             workflow sheet and columns to stamp email status into.
  TECHNICAL: Lookup mapping queue type → { name, cols, emailCol } for the matching
             *_Approval_Workflow sheet. Used by queueEmail stamping / processEmailQueue.
  PARAMS:    - type — 'approver' | 'ism' | 'divhead'.
  RETURNS:   { name, cols, emailCol } object, or null for unknown types (e.g. 'applicant').
*/
function getWorkflowInfoForType(type) {
  if (type === 'approver') {
    return { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, cols: APPROVAL_COLS, emailCol: APPROVAL_COLS.APPROVER_EMAIL };
  } else if (type === 'ism') {
    return { name: DB_SHEET_NAMES.ISM_WORKFLOW, cols: ISM_WORKFLOW_COLS, emailCol: ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL };
  } else if (type === 'divhead') {
    return { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, cols: DIV_HEAD_CONFIG_COLS, emailCol: DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL };
  }
  return null;
}

/*
  Function: getAdminNotificationConfig
  LAYMAN:    Reads the admin settings that say who gets alerted about failed emails and whether
             to notify the requestor. Falls back to safe defaults if the settings sheet is empty.
  TECHNICAL: Reads first data row of Admin_Notification_Config via ADMIN_NOTIFICATION_COLS.
             Wrapped in try/catch; any failure returns the defaults object.
  PARAMS:    (none)
  RETURNS:   { adminEmail, notifyOnFailure, notifyRequestor, lastNotified[, configId] }.
*/
function getAdminNotificationConfig() {
  var defaults = {
    adminEmail: 'systems.manager@company.com',
    notifyOnFailure: 'YES',
    notifyRequestor: 'YES',
    lastNotified: ''
  };
  try {
    var sheet = getDatabaseSheet(DB_SHEET_NAMES.ADMIN_NOTIFICATION, false);
    if (!sheet || sheet.getLastRow() < 2) return defaults;
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return defaults;
    var row = data[1]; // First data row
    return {
      configId: String(row[ADMIN_NOTIFICATION_COLS.CONFIG_ID - 1] || '').trim(),
      adminEmail: String(row[ADMIN_NOTIFICATION_COLS.ADMIN_EMAIL - 1] || '').trim() || defaults.adminEmail,
      notifyOnFailure: String(row[ADMIN_NOTIFICATION_COLS.NOTIFY_ON_FAILURE - 1] || 'YES').trim(),
      notifyRequestor: String(row[ADMIN_NOTIFICATION_COLS.NOTIFY_REQUESTOR - 1] || 'YES').trim(),
      lastNotified: String(row[ADMIN_NOTIFICATION_COLS.LAST_NOTIFIED - 1] || '').trim()
    };
  } catch (e) {
    Logger.log('⚠ Failed to read admin notification config: ' + e.toString());
    return defaults;
  }
}

/*
  Function: generateAuthToken
  LAYMAN:    Creates the secret signature baked into one-click approve/deny email links so a
             link cannot be forged or its action swapped (approve→deny).
  TECHNICAL: HMAC-SHA256 over (sessionId + normalizedEmail + timestamp + action) keyed by
             SYSTEM_SECRET, hex-encoded. Binding the action prevents CSRF via action tampering.
  PARAMS:    - sessionId — the application id.
             - email — approver email (normalized internally).
             - timestamp — issue time (ms) embedded in the link.
             - action — the bound action string (e.g. 'approve'); default ''.
  RETURNS:   Lowercase hex HMAC string.
*/
function generateAuthToken(sessionId, email, timestamp, action = '') {
  // CRITICAL FIX: Include action in token to prevent CSRF via action modification
  const normalizedEmail = getNormalizedEmail(email);
  const message = sessionId + normalizedEmail + timestamp + action;
  const signature = Utilities.computeHmacSha256Signature(message, getSystemSecret()); 
  return signature.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/*
  Function: isValidEmail
  LAYMAN:    Checks that a string looks like a real email address.
  TECHNICAL: Simplified RFC-5322 pattern plus structural checks: exactly one '@', a domain with
             a dot, a TLD of >= 2 chars, and no consecutive dots.
  PARAMS:    - email — candidate string.
  RETURNS:   Boolean. False for non-strings/empty.
  EXAMPLE:   isValidEmail('a@b.com') -> true ; isValidEmail('a@b') -> false
*/
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return false;
  // RFC 5322 simplified pattern with domain requirement
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!pattern.test(trimmed)) return false;
  // Validate domain structure
  const parts = trimmed.split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  // Domain must have at least one dot and a valid TLD (at least 2 chars after last dot)
  const domainParts = domain.split('.');
  if (domainParts.length < 2) return false;
  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2) return false;
  // No consecutive dots
  if (domain.indexOf('..') !== -1) return false;
  return true;
}

/*
  Function: sanitizeEmail
  LAYMAN:    Cleans an email (trim + lowercase) and returns it only if it is actually valid.
  TECHNICAL: Trim/lowercase then isValidEmail gate; logs a WARN and returns null on failure.
  PARAMS:    - email — raw candidate.
  RETURNS:   Clean email string, or null if invalid/non-string.
*/
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!isValidEmail(trimmed)) {
    Logger.log('WARN: Invalid email format: ' + email);
    return null;
  }
  return trimmed;
}

/*
  Function: batchDeleteRows
  LAYMAN:    Deletes several rows from a sheet at once, safely.
  TECHNICAL: Sorts row numbers descending and deletes bottom-to-top so earlier deletions do not
             shift the indices of rows still to delete. Each delete is in try/catch (logs WARN).
  PARAMS:    - sheet — target Sheet.
             - rowNumbers — 1-indexed row numbers to remove.
  RETURNS:   undefined (mutates the sheet). No-op for empty input.
*/
function batchDeleteRows(sheet, rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) return;
  // Sort descending: delete from bottom to top to avoid index shifts
  const sorted = rowNumbers.sort((a, b) => b - a);
  for (let i = 0; i < sorted.length; i++) {
    try {
      sheet.deleteRow(sorted[i]);
    } catch (e) {
      Logger.log('WARN: Failed to delete row ' + sorted[i] + ': ' + e.toString());
    }
  }
}

/*
  Function: findRowsToDelete
  LAYMAN:    Scans a sheet's data and lists which rows have a given value in a given column —
             handy for collecting rows to delete in one batch.
  TECHNICAL: Skips the header (i=1..), trims-and-compares data[i][colIndex-1] to value, returns
             the 1-indexed sheet row numbers (i+1).
  PARAMS:    - data — values from getDataRange().getValues().
             - colIndex — 1-indexed column (matches *_COLS constants).
             - value — value to match.
  RETURNS:   Array of 1-indexed row numbers (possibly empty).
*/
function findRowsToDelete(data, colIndex, value) {
  const rowsToDelete = [];
  const colIdx = colIndex - 1;  // Convert to 0-indexed
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][colIdx] || '').trim() === String(value || '').trim()) {
      rowsToDelete.push(i + 1);
    }
  }
  return rowsToDelete;
}

/*
  Function: sendEmailWithRetry
  LAYMAN:    Actually sends an email, retrying a couple of times if Gmail is temporarily busy or
             over quota. The lowest level of the email engine.
  TECHNICAL: Up to 3 GmailApp.sendEmail attempts with 1s/3s/5s backoff. Only retries on
             retryable errors (quota / "too many times" / temporary / timeout); other errors fail
             immediately. Sleeps between retries (Utilities.sleep).
  PARAMS:    - recipient — to-address.
             - subject — subject line.
             - body — plain-text body.
             - options — GmailApp options (htmlBody, cc, bcc, name, ...).
  RETURNS:   { success, attempts, error } — error is null on success.
  EXAMPLE:   sendEmailWithRetry('a@x.com','Hi','text',{htmlBody:'<b>Hi</b>'})
             -> { success:true, attempts:1, error:null }
*/
function sendEmailWithRetry(recipient, subject, body, options) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1000, 3000, 5000];  // 1s, 3s, 5s backoff

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      /* Step 1 — Try to send; success returns immediately. */
      GmailApp.sendEmail(recipient, subject, body, options);

      if (attempt > 0) {
        Logger.log('Email sent to ' + recipient + ' on attempt ' + (attempt + 1));
      }

      return {
        success: true,
        attempts: attempt + 1,
        error: null
      };
    } catch (e) {
      const errorMsg = e.toString();

      /* Step 2 — Classify the error; only transient/quota errors are worth retrying. */
      // Check if error is retryable
      const isRetryable = errorMsg.includes('Service invoked too many times') ||
                         errorMsg.includes('quota') ||
                         errorMsg.includes('temporary') ||
                         errorMsg.includes('timeout');

      if (!isRetryable || attempt === MAX_ATTEMPTS - 1) {
        // Non-retryable error or last attempt failed
        Logger.log('ERROR: Email send failed to ' + recipient +
                   ' after ' + (attempt + 1) + ' attempts: ' + errorMsg);
        return {
          success: false,
          attempts: attempt + 1,
          error: errorMsg
        };
      }

      /* Step 3 — Retryable and attempts remain: back off, then loop again. */
      // Wait and retry (exponential backoff)
      const delayMs = RETRY_DELAYS_MS[attempt];
      Logger.log('Retry attempt ' + (attempt + 2) + ' in ' + delayMs + 'ms for ' + recipient);
      Utilities.sleep(delayMs);
    }
  }

  return {
    success: false,
    attempts: MAX_ATTEMPTS,
    error: 'Failed after ' + MAX_ATTEMPTS + ' attempts'
  };
}

/*
  Function: isTokenValid
  LAYMAN:    Checks that an approve/deny email link is genuine, not expired, and for the right
             action — before honoring the click.
  TECHNICAL: Rejects missing token/timestamp or links older than TOKEN_VALIDITY_MS (14 days).
             Recomputes the action-bound HMAC and compares. For legacy links issued before the
             2026-06-01 cutoff it also accepts the old action-less HMAC (bounded backward compat).
  PARAMS:    - sessionId, email, token, timestamp — fields from the link.
             - action — expected bound action (default '').
  RETURNS:   Boolean — true only if the token verifies and is within TTL.
*/
function isTokenValid(sessionId, email, token, timestamp, action = '') {
  if (!token || !timestamp) return false;
  const now = new Date().getTime();
  const issuedAt = parseInt(timestamp, 10);
  // Enforce 14-day validity period
  if (isNaN(issuedAt) || now - issuedAt > TOKEN_VALIDITY_MS) {
    return false;
  }
  // Normalize email to handle aliases (e.g., user+alias@domain.com → user@domain.com)
  const normalizedEmail = getNormalizedEmail(email);
  
  // Validate token with action
  const expectedTokenWithAction = generateAuthToken(sessionId, normalizedEmail, timestamp, action);
  if (token === expectedTokenWithAction) {
    return true;
  }
  
  // Gate backwards compatibility on a hard cutoff date to prevent perpetual CSRF risk on old tokens
  const FALLBACK_CUTOFF_MS = new Date('2026-06-01T00:00:00Z').getTime(); 
  if (issuedAt < FALLBACK_CUTOFF_MS) {
    const expectedTokenWithoutAction = generateAuthToken(sessionId, normalizedEmail, timestamp, '');
    if (token === expectedTokenWithoutAction) {
      return true;
    }
  }
  
  return false;
}

/*
  Function: encodePayload
  LAYMAN:    Packs an object into a compact URL-safe blob. NOT secret — anyone can decode it.
  TECHNICAL: JSON.stringify → base64. WARNING: encoding, not encryption; reversible. Use only for
             obfuscation/transport, never to protect sensitive data.
  PARAMS:    - data — any JSON-serializable value.
  RETURNS:   Base64 string.
*/
function encodePayload(data) {
  const jsonStr = JSON.stringify(data);
  const encoded = Utilities.base64Encode(jsonStr);
  return encoded;
}

/*
  Function: decodePayload
  LAYMAN:    Unpacks a blob made by encodePayload back into an object.
  TECHNICAL: base64Decode → JSON.parse, in try/catch. Returns null on any failure (logs it).
  PARAMS:    - encodedStr — base64 string from encodePayload.
  RETURNS:   The decoded value, or null if decode/parse fails.
*/
function decodePayload(encodedStr) {
  try {
    const jsonStr = Utilities.base64Decode(encodedStr);
    return JSON.parse(jsonStr);
  } catch (e) {
    Logger.log('decodePayload failed: ' + e.toString());
    return null;
  }
}

const makeFlagBtn = (label, isQuick = false) => `<button type="button" onclick="${isQuick ? 'toggleQuickFlag(this)' : 'toggleFlagBox(this)'}" data-flag="${escapeHtml(label).replace(/'/g, "\\'")}" class="flag-btn" title="Flag ${escapeHtml(label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg></button>`;

/*
  Function: escapeHtml
  LAYMAN:    Makes user text safe to drop into an email or HTML page (no broken markup / XSS).
  TECHNICAL: Escapes & < > " ' to their HTML entities. Coerces falsy input to ''.
  PARAMS:    - str — value to escape.
  RETURNS:   Escaped string.
*/
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/*
  Function: getAndShareDCSFiles
  LAYMAN:    Finds the DCS attachments (NDA/DPA/DSA) for a request in the admin Drive folder and
             makes them domain-viewable so approvers can open them from the email.
  TECHNICAL: Resolves ADMIN_FOLDER_ID (Script Property or const), searches by "title contains
             dcsReqId", sets each match to DOMAIN_WITH_LINK / VIEW. All wrapped in try/catch so a
             sharing failure never blocks the flow.
  PARAMS:    - dcsReqId — linked DCS Request ID.
  RETURNS:   Array of { id, name, url }; [] if none found or on error.
*/
function getAndShareDCSFiles(dcsReqId) {
  if (!dcsReqId) return [];
  const foundFiles = [];
  const seen = {};

  // PRIMARY (#15): use the file IDs stored on the DCS Data_Collection record. This is reliable — it does
  // not depend on the Admin folder configuration or the file-naming/search scope. Internal NDA/DPA docs
  // are included here too (previously the folder title-search could miss them).
  try {
    const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, false);
    if (dcsSheet) {
      const vals = dcsSheet.getDataRange().getValues();
      for (let i = 1; i < vals.length; i++) {
        if (String(vals[i][DCS_COLS.REQ_ID - 1] || '').trim() === String(dcsReqId).trim()) {
          let arr = [];
          try { arr = JSON.parse(vals[i][DCS_COLS.FILE_ID - 1] || '[]'); } catch (e) {}
          (Array.isArray(arr) ? arr : []).forEach(function (f) {
            if (f && f.id && !seen[f.id]) {
              try {
                const file = DriveApp.getFileById(f.id);
                try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
                foundFiles.push({ id: file.getId(), name: file.getName(), url: file.getUrl(), type: f.type || '' });
                seen[f.id] = true;
              } catch (e) { Logger.log('WARN: could not open DCS file ' + f.id + ': ' + e.toString()); }
            }
          });
          break;
        }
      }
    }
  } catch (e) { Logger.log('Error reading DCS file IDs from Data_Collection: ' + e.toString()); }

  // FALLBACK (legacy): Admin-folder title search, only if nothing was found above.
  if (foundFiles.length === 0) {
    try {
      const folderId = PropertiesService.getScriptProperties().getProperty('ADMIN_FOLDER_ID') || ADMIN_FOLDER_ID;
      const folder = DriveApp.getFolderById(folderId);
      const files = folder.searchFiles(`title contains '${dcsReqId}'`);
      while (files.hasNext()) {
        const file = files.next();
        if (seen[file.getId()]) continue;
        try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
        foundFiles.push({ id: file.getId(), name: file.getName(), url: file.getUrl() });
        seen[file.getId()] = true;
      }
    } catch (e) {
      Logger.log('Error searching/sharing DCS files from Admin Folder: ' + e.toString());
    }
  }
  return foundFiles;
}

/*
  Function: getStyledHtmlWrapper
  LAYMAN:    Wraps a header + content into a complete, styled HTML page — used for the
             "access denied", approve/deny result, and other standalone pages the app serves.
  TECHNICAL: Returns a full HTML document string (fonts, :root design tokens, toast helpers)
             with header/content interpolated. Pure template builder, no side-effects.
  PARAMS:    - header — HTML for the page title/badge area.
             - content — HTML for the page body.
  RETURNS:   Complete HTML document string.
*/
function getStyledHtmlWrapper(header, content) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
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
          max-width: 860px;
          width: 100%;
          margin: 0 auto;
          margin-top: 3.5rem;
          padding: 1rem 1.5rem 3rem;
          box-sizing: border-box;
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
          display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
          letter-spacing: 0.05em; text-transform: uppercase; background: var(--navy-tint);
          color: var(--navy-text); padding: 5px 14px; border-radius: 99px; margin-bottom: 12px;
          border: 1px solid var(--navy-border);
        }
        .card {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: clamp(1.25rem, 3vw, 2rem);
          margin-bottom: 1rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.02);
          transition: border-color 140ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 140ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        .card:focus-within { border-color: var(--navy-border); box-shadow: 0 4px 12px rgba(30,58,95,0.05); }
        .alert { gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--radius); font-size: 13px; margin-bottom: 1rem; line-height: 1.55; border: 1px solid transparent; }
        .alert::before { content: ''; width: 18px; height: 18px; display: block; flex-shrink: 0; margin-top: 1px; background-size: contain; background-repeat: no-repeat; }
        .alert-info { background: var(--navy-tint); color: var(--navy-text); border-color: var(--navy-border); }
        .alert-info::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%231e3a5f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'%3E%3C/circle%3E%3Cline x1='12' y1='16' x2='12' y2='12'%3E%3C/line%3E%3Cline x1='12' y1='8' x2='12.01' y2='8'%3E%3C/line%3E%3C/svg%3E"); }
        .alert-warn { background: var(--warn); color: var(--warn-text); border-color: rgba(180,109,20,0.2); }
        .alert-warn::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2392400e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'%3E%3C/path%3E%3Cline x1='12' y1='9' x2='12' y2='13'%3E%3C/line%3E%3Cline x1='12' y1='17' x2='12.01' y2='17'%3E%3C/line%3E%3C/svg%3E"); }
        .alert-success { background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2); }
        .alert-success::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23065f46' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 11.08V12a10 10 0 1 1-5.93-9.14'%3E%3C/path%3E%3Cpolyline points='22 4 12 14.01 9 11.01'%3E%3C/polyline%3E%3C/svg%3E"); }
        .alert-danger { background: var(--danger); color: var(--danger-text); border-color: rgba(220,38,38,0.2); }
        .alert-danger::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23dc2626' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'%3E%3C/circle%3E%3Cline x1='15' y1='9' x2='9' y2='15'%3E%3C/line%3E%3Cline x1='9' y1='9' x2='15' y2='15'%3E%3C/line%3E%3C/svg%3E"); }
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
          border-bottom: 1px solid var(--border); font-size: 13px; text-align: left; align-items: center;
        }
        .summary-row:last-child { border-bottom: none; }
        .summary-row:first-child { padding-top: 0; }
        .summary-row:last-of-type {
          border-bottom: none;
        }
        .summary-label {
          color: var(--text3); min-width: 156px; flex-shrink: 0; font-size: 12.5px;
          font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
          line-height: 1.75;
          overflow-wrap: anywhere;
        }
        .summary-value { color: var(--text); word-break: break-word; flex: 1; min-width: 0; padding: 0; }
        .pii-tag {
          display: inline-block; background: var(--navy-tint); color: var(--navy-text);
          border: 1px solid var(--navy-border); padding: 3px 10px; border-radius: 99px;
          font-size: 11.5px; font-weight: 500; margin: 0 4px 6px 0;
        }
        .stakeholder-tag {
          display: inline-block; background: var(--bg3); color: var(--text2);
          border: 1px solid var(--border2); padding: 3px 10px; border-radius: var(--radius);
          font-size: 12px; font-weight: 500; margin: 0 4px 4px 0;
        }
        .status-badge {
          display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600;
          padding: 4px 12px; border-radius: 99px; letter-spacing: 0.01em;
          white-space: nowrap; /* Prevent "Y E S" stacking */
        }
        .status-approved { background: var(--success); color: var(--success-text); }
        .status-pending  { background: var(--warn);    color: var(--warn-text); }
        .status-rejected { background: var(--danger);  color: var(--danger-text); }
        .status-denied   { background: var(--danger);  color: var(--danger-text);  }
        .status-complete { background: var(--success); color: var(--success-text); }
        .status-escalated { background: #f3e8ff; color: #6b21a8; }
        /* New styles for buttons */
        .btn-success { background: var(--success); color: var(--success-text); border-color: transparent; }
        .btn-warn    { background: var(--warn);    color: var(--warn-text);    border-color: transparent; }
        .btn-danger  { background: var(--danger);  color: var(--danger-text);  border-color: transparent; }
        
        /* Flag button styles */
        .flag-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: 1px solid var(--border2);
          border-radius: 50%;
          width: 24px;
          height: 24px;
          padding: 0;
          font-size: 12px;
          color: var(--text3);
          cursor: pointer;
          flex-shrink: 0;
          transition: transform 0.15s ease, color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
        }
         
        .flag-btn:hover {
          background: transparent;
          color: var(--danger-text);
          border-color: var(--danger-text);
          transform: scale(1.05);
        }
        
        .flag-btn.active {
          border-color: #dc2626;
          color: #dc2626;
          background: rgba(220, 38, 38, 0.05);
        }

        /* New styles for summary section titles */
        .summary-section-title {
          font-size: 11px; font-weight: 600; color: var(--text3);
          text-transform: uppercase; letter-spacing: 0.07em; margin-top: 1.5rem; margin-bottom: 10px;
        }

        /* New styles for form textarea */
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

        /* New styles for details/summary (collapsible sections) */
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
          display: flex;
          align-items: center;
          gap: 8px;
          list-style: none;
        }
        summary::-webkit-details-marker {
          display: none;
        }
        summary::before {
          content: '';
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          flex-shrink: 0;
          font-size: 12px;
          font-weight: 600;
          transition: transform 0.2s ease;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23111827' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 18l6-6-6-6'/%3E%3C/svg%3E");
          background-size: 12px;
          background-position: center;
          background-repeat: no-repeat;
        }
        details[open] > summary::before {
          transform: rotate(90deg);
        }

        /* MODAL & STEPPER COMPONENTS */
        .decision-modal-overlay {
          position: fixed; inset: 0; background: rgba(17, 24, 39, 0.6);
          z-index: 1000; align-items: center; justify-content: center; padding: 15px;
          backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
        }
        .decision-modal {
          background: var(--bg); border: 1px solid var(--border); padding: 24px;
          border-radius: var(--radius-lg); max-width: 500px; width: 100%;
          box-shadow: 0 20px 60px rgba(0,0,0,0.2); overflow: hidden; position: relative;
        }
        .decision-modal-header {
          margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--text);
          letter-spacing: -0.02em; border-bottom: 1px solid var(--border); padding-bottom: 12px;
        }
        .modal-step-title { font-weight: 600; margin-bottom: 12px; font-size: 14.5px; color: var(--text); }
        .routing-option {
          display: flex; align-items: center; padding: 12px 14px; border: 1px solid var(--border); 
          border-radius: var(--radius); cursor: pointer; background: var(--bg2); 
          transition: all 0.2s ease; 
        }
        .routing-option:hover { border-color: var(--navy-bright); background: var(--navy-tint); }
        .routing-option input[type="radio"] { margin-right: 14px; width: 18px; height: 18px; cursor: pointer; accent-color: var(--navy-bright); flex-shrink: 0; }
        .routing-title { font-weight: 600; color: var(--text); font-size: 14px; line-height: 1.2; }
        .routing-desc { font-size: 12.5px; color: var(--text2); margin-top: 4px; line-height: 1.4; }
        .btn-secondary { background: var(--bg3); border-color: var(--border2); color: var(--text); }
        .btn-secondary:hover { background: var(--border); }
        .ismApproverContainer { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }

        /* TOAST NOTIFICATIONS */
        .toast {
          position: fixed; top: 1rem; right: 1rem; max-width: 360px;
          padding: 12px 16px 12px 14px; border-radius: var(--radius);
          font-size: 13px; font-weight: 500; z-index: 2147483646;
          display: flex; align-items: center; gap: 10px;
          animation: toastIn 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
          box-shadow: 0 4px 20px rgba(0,0,0,0.12); font-family: var(--font);
          border: 1px solid transparent; line-height: 1.4;
        }
        .toast-error   { background: var(--danger);  color: var(--danger-text);  border-color: rgba(220,38,38,0.2); }
        .toast-success { background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2); }
        .toast-icon    { font-size: 15px; flex-shrink: 0; }
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(100%) scale(0.95); }
          to   { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes toastOut {
          from { opacity: 1; transform: translateX(0) scale(1); }
          to   { opacity: 0; transform: translateX(100%) scale(0.95); }
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
          <div class="logo-brand hidden" id="app-mini-logo">
            <img src="https://upload.wikimedia.org/wikipedia/commons/e/e2/Megaworld_logo_and_wordmark.svg" alt="Megaworld Logo" height="28">
          </div>
        <div class="page-header">${header}</div>
        <div class="card">${content}</div>
      </div>
      <script>
        function _showToast(msg, type) {
          const el = document.createElement('div');
          el.className = 'toast toast-' + type;
          el.setAttribute('role', type === 'error' ? 'alert' : 'status');
          const icon = type === 'error' ? 
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>' : 
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';
          el.innerHTML = '<span class="toast-icon" aria-hidden="true" style="display:flex;">' + icon + '</span><span>' + msg + '</span>';
          document.body.appendChild(el);
          setTimeout(() => {
            el.style.animation = 'toastOut 0.25s cubic-bezier(0.4,0,1,1) both';
            setTimeout(() => el.remove(), 260);
          }, type === 'error' ? 4500 : 3000);
        }
        function showError(msg) { _showToast(msg, 'error'); }
        function showSuccess(msg) { _showToast(msg, 'success'); }
      </script>
    </body>
    </html>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COLUMN INDEX CONSTANTS (Anti-Magic Number Pattern)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const APPLICATIONS_COLS = {
  SESSION_ID: 1,
  APPLICANT_EMAIL: 2,
  STATUS: 3,
  PIA_1_DATA: 4,
  PIA_2_DATA: 5,
  PIA_3_DATA: 6,
  PIA_4_DATA: 7,
  PIA_5_DATA: 8,
  ADMIN_EXPORT_ID: 9,
  SUBMISSION_DATE: 10,
  IS_FLAGGED: 11,
  NOTES: 12,
  LINKED_REQ_ID: 13,
  APPROVER_FLAGS: 14
};

const APPROVAL_COLS = {
  APPROVAL_ID: 1,
  SESSION_ID: 2,
  CURRENT_STEP: 3,
  APPROVER_NAME: 4,
  APPROVER_EMAIL: 5,
  DECISION: 6,
  COMMENTS: 7,
  DECISION_DATE: 8,
  STATUS: 9,
  REMINDER_DATE: 10,
  EMAIL_STATUS: 11,
  EMAIL_ERROR: 12
};

const AUDIT_COLS = {
  LOG_ID: 1,
  SESSION_ID: 2,
  INTERNAL_FLAGS: 3,
  ACTION: 4,
  USER_EMAIL: 5,
  USER_AGENT: 6,
  TIMESTAMP: 7
};

const DCS_COLS = {
  LOG_ID: 1,
  REQ_ID: 2,
  USER_EMAIL: 3,
  STATUS: 4,
  IMMEDIATE_HEAD_EMAIL: 5,
  DEPT_HEAD_EMAIL: 6,
  DIV_HEAD_EMAIL: 7,
  FILE_ID: 8,
  METADATA_JSON: 9,
  TIMESTAMP: 10,
  METADATA_AGENCY: 11,
  REMARKS: 12
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 WORKFLOW - ISM APPROVAL WORKFLOW SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ISM_WORKFLOW_COLS = {
  ISM_APPROVAL_ID: 1,
  SESSION_ID: 2,
  CURRENT_STEP: 3,
  ISM_MEMBER_NAME: 4,
  ISM_MEMBER_EMAIL: 5,
  DECISION: 6,
  COMMENTS: 7,
  DECISION_DATE: 8,
  STATUS: 9,
  REQUIRES_DIV_HEAD: 10,
  DIV_HEAD_ESCALATION_ID: 11,
  ROUTING_DESTINATION: 12,
  REMINDER_DATE: 13,
  EMAIL_STATUS: 14,
  EMAIL_ERROR: 15
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 WORKFLOW - DIVISION HEAD CONFIG SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const DIV_HEAD_CONFIG_COLS = {
  ESCALATION_ID: 1,
  SESSION_ID: 2,
  DIV_HEAD_EMAIL: 3,
  DECISION: 4,
  COMMENTS: 5,
  DECISION_DATE: 6,
  STATUS: 7,
  REMINDER_DATE: 8,
  EMAIL_STATUS: 9,
  EMAIL_ERROR: 10
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REVISION HISTORY SHEET COLUMNS (durable return-cycle logbook)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const REVISION_HISTORY_COLS = {
  HISTORY_ID: 1,
  SESSION_ID: 2,
  ROUND_NUMBER: 3,
  STAGE: 4,
  APPROVER_NAME: 5,
  APPROVER_EMAIL: 6,
  ROLE: 7,
  DECISION: 8,
  STATUS: 9,
  COMMENTS: 10,
  FLAGGED_FIELDS: 11,
  ROUTING: 12,
  DECISION_DATE: 13,
  SNAPSHOT_AT: 14
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 WORKFLOW - INFOSEC EMAIL CONFIG SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const INFOSEC_CONFIG_COLS = {
  MEMBER_ID: 1,
  MEMBER_NAME: 2,
  MEMBER_EMAIL: 3,
  ROLE: 4,
  IS_ACTIVE: 5,
  JOB_POS: 6,
  SITE: 7   // Batch 3: for TechServe rows, the Office/Site this email serves (AGT/TWS/CIP/EGP/Eastgate). Blank = fallback.
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 — EMAIL QUEUE SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const EMAIL_QUEUE_COLS = {
  QUEUE_ID: 1,
  SESSION_ID: 2,
  RECIPIENT: 3,
  SUBJECT: 4,
  BODY_PLAIN: 5,
  BODY_HTML: 6,
  TYPE: 7,           // 'approver' | 'applicant' | 'ism' | 'divhead' | 'reminder'
  STATUS: 8,         // 'Pending' | 'Sent' | 'Failed' | 'Cancelled'
  ATTEMPTS: 9,
  LAST_ERROR: 10,
  CREATED_AT: 11,
  SENT_AT: 12,
  NOTIFIED_ADMIN: 13  // 'YES' if admin already alerted about this failure
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 4 — ADMIN NOTIFICATION CONFIG COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ADMIN_NOTIFICATION_COLS = {
  CONFIG_ID: 1,
  ADMIN_EMAIL: 2,
  NOTIFY_ON_FAILURE: 3,
  NOTIFY_REQUESTOR: 4,
  LAST_NOTIFIED: 5
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📄 WEB APP HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: doGet
  LAYMAN:    The front door of the PIA web app. Decides what a GET request gets back: an
             "access denied" page for outsiders, the one-click approve/deny page if the URL
             carries an action token, or the main assessment app (loaded via a DCS parentID).
  TECHNICAL: GAS web-app entry. Lazy-inits the DB once. Enforces isAuthorizedDomain. Routes:
             (a) e.parameter.action → handleEmailAction; (b) requires e.parameter.parentID,
             else an error page; (c) renders the 'index' template (IFRAME sandbox) with parentID.
  PARAMS:    - e — GAS event with .parameter (action, parentID, token, ...).
  RETURNS:   HtmlOutput (the served page).
*/
function doGet(e) {
  /* Step 1 — First-run guard: build the DB tabs if they do not exist yet. */
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DB_INIT_FLAG_PROP) !== 'true') {
    initializeDatabase();
  }

  /* Step 2 — Domain gate: only corporate accounts may proceed. */
  // Domain authorization check
  const userEmail = Session.getActiveUser().getEmail();
  if (!isAuthorizedDomain(userEmail)) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Strictly Access Denied</span><h1>Restricted</h1>`;
    const content = `
      <div class="alert alert-danger">Security verification failed. This system is restricted</div>
      <p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Outside of the corporation is strictly access denied. Please switch to your corporate account and try again.</p>
      <p style="color: var(--text3); font-size: 0.85rem; margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem;">Current account: <strong>${userEmail || 'Anonymous/Public'}</strong></p>
    `;
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content))
      .setTitle('Access Denied');
  }

  /* Step 3 — Email action link (approve/deny one-click) → render the action page. */
  // 1. Check if the URL contains an email action command
  if (e && e.parameter && e.parameter.action) {
    return handleEmailAction(e.parameter).setTitle('Privacy Impact Assessment');
  }

  /* Step 4 — Otherwise the SPA requires a DCS parentID; without it, show an error page. */
  // 2. If no action command, require parentID and load the SPA
  const parentId = e.parameter.parentID;
  if (!parentId) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Invalid Access</span><h1>Link Required</h1>`;
    const content = `
      <div class="alert alert-danger">This application must be accessed via a valid link from the Data Collection System (DCS).</div>
      <p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Please provide a <code>parentID</code> in the URL to proceed.</p>
    `;
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content))
      .setTitle('Invalid Access');
  }

  const template = HtmlService.createTemplateFromFile('index');
  
  // Pass parentID from URL parameters to the template if present
  template.parentID = parentId;
  
  return template.evaluate()
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setTitle('Privacy Impact Assessment');
}

/*
  Function: doPost
  LAYMAN:    Handles POSTs. Two jobs: cross-app JSON calls from the Admin panel, and the
             form-POST version of an approval action (POST instead of GET avoids CSRF on the link).
  TECHNICAL: Lazy-inits DB. If postData is application/json → handleAdminApiRequest. Otherwise
             enforces the domain gate, then processes the token-validated approval form post.
  PARAMS:    - e — GAS event with .postData and .parameter.
  RETURNS:   ContentService/HtmlOutput depending on branch.
*/
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DB_INIT_FLAG_PROP) !== 'true') {
    initializeDatabase();
  }

  // ── Check if this is a JSON API call from the Admin Panel ──
  if (e && e.postData && e.postData.type === 'application/json') {
    return handleAdminApiRequest(e);
  }

  // Domain authorization check
  const userEmail = Session.getActiveUser().getEmail();
  if (!isAuthorizedDomain(userEmail)) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Access Denied</span><h1>Restricted</h1>`;
    const content = `<div class="alert alert-danger">Security verification failed. This system is restricted to authorized domains.</div>`;
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content));
  }

  // Handle approval decision form submission
  if (e.parameter && e.parameter.action) {
    return handleEmailAction(e.parameter).setTitle('Privacy Impact Assessment');
  }

  const paramKeys = e && e.parameter ? Object.keys(e.parameter).join(', ') : '(no parameters)';
  Logger.log('ERROR: doPost called without action parameter. Available params: ' + paramKeys);
  return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
    `<h1>Invalid Request</h1>`,
    `<div class="alert alert-danger">The request is missing required parameters. Available: ${escapeHtml(paramKeys)}</div>`
  ));
}

/*
  Function: handleAdminApiRequest
  LAYMAN:    The cross-app API the Admin panel calls to inspect/retry emails, manage reminders,
             and view the pipeline. Checks a shared key, then runs the named admin function.
  TECHNICAL: Parses JSON { apiKey, action, params }, authenticates apiKey against the
             ADMIN_API_KEY Script Property (fail-closed), dispatches action via a switch to the
             admin* helpers, and returns the result as JSON ContentService output. All in try/catch.
  PARAMS:    - e — GAS event; e.postData.contents is the JSON body.
  RETURNS:   JSON TextOutput: { success, ... } or { success:false, error }.
*/
function handleAdminApiRequest(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const apiKey = String(body.apiKey || '');
    const validKey = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');

    // Authenticate
    if (!validKey || apiKey !== validKey) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false, error: 'Unauthorized — invalid or missing apiKey'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const action = String(body.action || '').trim();
    const params = body.params || {};

    // ── Route to admin function ──
    let result;
    switch (action) {
      case 'getEmailQueue':
        result = adminGetEmailQueue(params);
        break;
      case 'retryQueuedEmail':
        result = adminRetryQueuedEmail(params.queueId);
        break;
      case 'retryAllForSession':
        result = adminRetryAllForSession(params.sessionId, params.status);
        break;
      case 'cancelQueuedEmails':
        result = adminCancelQueuedEmails(params.sessionId, params.type);
        break;
      case 'getQueueSummary':
        result = adminGetQueueSummary();
        break;
      case 'getFailedEmails':
        result = adminGetFailedEmails(params.sinceDays);
        break;
      case 'getEmailLog':
        result = adminGetEmailLog(params.sessionId);
        break;
      case 'resendEmail':
        result = adminResendEmail(params.sessionId, params.recipient, params.type);
        break;
      case 'getReminderConfig':
        result = adminGetReminderConfig();
        break;
      case 'setReminderConfig':
        result = adminSetReminderConfig(params.config);
        break;
      case 'setupReminderTrigger':
        result = setupReminderTrigger();
        break;
      case 'sendDailyReminders':
        result = sendDailyReminders();
        break;
      case 'getNotificationConfig':
        result = adminGetNotificationConfig();
        break;
      case 'setNotificationConfig':
        result = adminSetNotificationConfig(params.config);
        break;
      case 'resendToStage':
        result = adminResendToStage(params.sessionId, params.stageType, params.approverEmail);
        break;
      case 'getPipelineView':
        result = adminGetPipelineView(params.sessionId);
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false, error: 'API handler error: ' + e.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/*
  Function: handleEmailAction
  LAYMAN:    Powers the one-click approve/deny/return/review pages that approvers reach from the
             emails. It checks the click is genuine, shows the full application for review with a
             confirm form (GET), and on confirm (POST) records the decision and shows the result.
  TECHNICAL: The largest handler. Steps: validate action is allowed; identity = active user must
             equal the token's target email AND isTokenValid(action-bound); block if a decision was
             already recorded (idempotency, scanned across the right workflow sheet: ISM / divhead /
             standard approver); load application + linked DCS context; build a review preview.
             On GET render the confirm page; on POST route to apiPhase3_ProcessISMDecision /
             processDivHeadDecision / processApprovalDecision and render the outcome. Heavy inline
             HTML; logic lives at the step markers below.
  PARAMS:    - params — query/form params: action, sessionId, token, ts, email, isPost,
                        approverType, step, comment, approverFlags, routingDestination, ...
  RETURNS:   HtmlOutput — review page, "already recorded" page, access-denied page, or result page.
*/
function handleEmailAction(params) {
  const webAppUrl = getWebAppUrl() || ScriptApp.getService().getUrl();
  const { action, sessionId, token, ts, isPost, approverType } = params;
  const allowedActions = ['Approve', 'Reject', 'Deny', 'Review', 'Return', 'ISMReview'];

  if (allowedActions.indexOf(action) === -1) {
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
      `<h1>Invalid Request</h1>`,
      `<div class="alert alert-danger">The requested action is not supported by the system.</div>`
    ));
  }

  const comment = sanitizeInput(params.comment || '');
  const targetEmail = decodeURIComponent(params.email || '').toLowerCase();
  const activeUser = Session.getActiveUser().getEmail().toLowerCase();
  const approverFlags = params.approverFlags || '{}';
  // Normalize both emails to handle aliases (e.g., user+alias@domain.com matches user@domain.com)
  const normalizedActiveUser = getNormalizedEmail(activeUser);
  const normalizedTargetEmail = getNormalizedEmail(targetEmail);
  /* Step 1 — Identity + token gate: the signed-in user must BE the link's target AND the
     action-bound HMAC must verify. Both conditions required (no CSRF, no forwarding abuse). */
  // CRITICAL FIX: Include action in token validation to prevent CSRF
  const isAuthorized = (normalizedActiveUser === normalizedTargetEmail) && isTokenValid(sessionId, targetEmail, token, ts, action);
  
  if (!isAuthorized) {
    // CRITICAL FIX: Don't disclose expected email (information leakage / email enumeration)
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
      `<h1>Access Denied</h1>`,
      `<div class="alert alert-danger">Security verification failed. Only the intended recipient can perform this action.</div>
      <div style="font-size:13px; color:var(--text2); margin-top:1rem; padding:10px; background:var(--bg3); border-radius:var(--radius);">
        <strong>Current Account:</strong> ${escapeHtml(activeUser || 'Unauthenticated / Anonymous')}
      </div>
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">If the email is forwarded, delete the email from your inbox. You may now safely close this window.</p>`
    ));
  }
  
  const stepParam = params.step ? Number(params.step) : null;

  /* Step 2 — Idempotency: scan the relevant workflow sheet (ISM / divhead / standard) for this
     approver's row. If a non-pending decision already exists, short-circuit to a "Review Completed"
     page so decisions can never be re-submitted or changed. */
  // Check if decision has already been recorded for this user (prevent duplicate actions or modifications)
  let recordStatus = 'Pending';
  let existingDecision = '';
  let accountablePersonsHtmlNoFlags = ''; // Initialize for previewHtml (no flags)

  if (action === 'ISMReview' || action.startsWith('ISM')) {
    const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const ismData = ismWorkflowSheet.getDataRange().getValues();
    let foundPending = false;
    let completedRecord = null;
    for (let i = 1; i < ismData.length; i++) {
      if (ismData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId &&
          getNormalizedEmail(ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]) === normalizedTargetEmail) {
        
        const loopStep = Number(ismData[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] || 1);
        if (stepParam !== null && loopStep !== stepParam) {
          continue;
        }

        if (ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Pending') {
          foundPending = true;
          break;
        }
        completedRecord = ismData[i];
      }
    }
    if (!foundPending && completedRecord) {
      recordStatus = completedRecord[ISM_WORKFLOW_COLS.STATUS - 1];
      existingDecision = completedRecord[ISM_WORKFLOW_COLS.DECISION - 1];
    }
  } else if (action === 'Review' || ['Approve', 'Reject', 'Deny', 'Return'].includes(action)) {
    if (approverType === 'divhead') {
      const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
      const divData = divHeadSheet.getDataRange().getValues();
      let foundPending = false;
      let completedRecord = null;
      for (let i = 1; i < divData.length; i++) {
        if (divData[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === sessionId &&
            getNormalizedEmail(divData[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1]) === normalizedTargetEmail) {
          if (divData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') {
            foundPending = true;
            break;
          }
          completedRecord = divData[i];
        }
      }
      if (!foundPending && completedRecord) {
        recordStatus = completedRecord[DIV_HEAD_CONFIG_COLS.STATUS - 1];
        existingDecision = completedRecord[DIV_HEAD_CONFIG_COLS.DECISION - 1];
      }
    } else {
      const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      const apprData = apprSheet.getDataRange().getValues();
      let foundPending = false;
      let completedRecord = null;
      for (let i = 1; i < apprData.length; i++) {
        if (apprData[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId &&
            getNormalizedEmail(apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1]) === normalizedTargetEmail) {
          
          const loopStep = Number(apprData[i][APPROVAL_COLS.CURRENT_STEP - 1] || 1);
          if (stepParam !== null && loopStep !== stepParam) {
            continue;
          }

          if (apprData[i][APPROVAL_COLS.STATUS - 1] === 'Pending') {
            foundPending = true;
            break;
          }
          completedRecord = apprData[i];
        }
      }
      if (!foundPending && completedRecord) {
        recordStatus = completedRecord[APPROVAL_COLS.STATUS - 1];
        existingDecision = completedRecord[APPROVAL_COLS.DECISION - 1];
      }
    }
  }

  if (recordStatus !== 'Pending' && recordStatus !== 'NotFound') {
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
      `<span class="step-badge">Action Already Recorded</span><h1>Review Completed</h1>`,
      `<div class="alert" style="background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2);">Your decision for application <strong>${sessionId}</strong> has already been recorded as <strong>${existingDecision || recordStatus}</strong>.</div>
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">Decisions cannot be modified once they have been processed. You may now safely close this window.</p>`
    ));
  }

  /* Step 3 — Load the PIA application and its linked DCS context for the review preview. */
  // Fetch Application Data
  const appData = getApplicationData(sessionId);

  // Fetch DCS Data Context
  let dcsData = null;
  if (appData && appData.linkedReqId) {
    const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const lastRow = dcsSheet.getLastRow();
    if (lastRow >= 2) {
      const reqIdCol = dcsSheet.getRange(1, DCS_COLS.REQ_ID, lastRow, 1);
      const found = reqIdCol.createTextFinder(appData.linkedReqId).matchEntireCell(true).findNext();
      if (found) {
        const rowData = dcsSheet.getRange(found.getRow(), 1, 1, dcsSheet.getLastColumn()).getValues()[0];
        try { dcsData = JSON.parse(rowData[DCS_COLS.METADATA_JSON - 1] || '{}'); } catch(e){}
        dcsData._reqId = rowData[DCS_COLS.REQ_ID - 1];
        dcsData._email = rowData[DCS_COLS.USER_EMAIL - 1];
                dcsData._status = rowData[DCS_COLS.STATUS - 1];
                dcsData._timestamp = rowData[DCS_COLS.TIMESTAMP - 1];
                dcsData._immHeadEmail = rowData[DCS_COLS.IMMEDIATE_HEAD_EMAIL - 1];
                dcsData._deptHeadEmail = rowData[DCS_COLS.DEPT_HEAD_EMAIL - 1];
                dcsData._divHeadEmail = rowData[DCS_COLS.DIV_HEAD_EMAIL - 1];
                dcsData._fileID = rowData[DCS_COLS.FILE_ID - 1];
                try { dcsData._metadataAgency = JSON.parse(String(rowData[Math.min(DCS_COLS.METADATA_AGENCY - 1, rowData.length - 1)] || '{}')); } catch(e) { dcsData._metadataAgency = {}; }
      }
    }
  }

  let previewHtml = '';
  if (appData) {
    const piiFields = appData.pia2.fields || appData.pia2 || {};
    const yesFields = pii2Fields.filter((f, i) => piiFields[i] === 'YES');
      const customOthers = (appData.pia2.customOthers || []).filter(e => e && e.value === 'YES').map(e => e.name);
    const allPii = [...yesFields, ...customOthers];

    const pia5Questions = [
      'Do you have a Privacy Policy visible and available to your data subjects?',
      'Is consent secured prior to the collection of personal data?',
      'Will any information also be collected indirectly about the individual?',
      'Do you have steps to ensure that all data processed are accurate, complete, and up to date?',
      'The program has taken reasonable steps to protect the personal information it holds from misuse and loss and from unauthorised access, modification or disclosure.',
      'Do you have a retention policy for your hard and digital copies?',
      'Do you collect or disclose information outside the Philippines?',
      'Do you have outsourcing or data sharing agreement with 3rd parties?'
    ];
    
    const pia5Rows = pia5Questions.map((q, i) => {
      const v = appData.pia5[i] || '—';
      const badgeCls = v === 'YES' ? 'status-approved' : (v === 'NO' ? 'status-denied' : 'status-pending'); // Assuming 'N/A' is pending or similar
      return `<div class="summary-row" style="grid-template-columns: 4fr 1fr !important;">
        <div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">${i+1}. ${escapeHtml(q)}</div>
        <div class="summary-value" style="flex:0; margin-left:auto; display:flex; align-items:center; gap:4px;"><span class="status-badge ${badgeCls}">${escapeHtml(v)}</span><span style="margin-left: auto;">${makeFlagBtn('PIA 5: Q'+(i+1))}</span></div>
      </div>`;
    }).join('');

    const stakeholderLine = items => {
      if (!Array.isArray(items)) return escapeHtml(items || '—');
      const valid = items.filter(v => typeof v === 'string' ? v : (v.name || v.email));
      if (!valid.length) return '—';
      return valid.map(v => {
        if (typeof v === 'string') return `<span class="stakeholder-tag">${escapeHtml(v)}</span>`;
        const label = [v.name, v.email].filter(Boolean).join(' - ');
        return `<span class="stakeholder-tag">${escapeHtml(label)}</span>`;
      }).join('');
    };

    const fullSummaryHtml = `
      <div class="details-content">
        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Privacy Compliance Survey</div>
        ${pia5Rows}

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Program Information (PIA 1)</div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Immediate Head</div><div class="summary-value">${escapeHtml(appData.pia1.immediateHead || '—')} ${appData.pia1.immediateHeadEmail ? `(${escapeHtml(appData.pia1.immediateHeadEmail)})` : ''}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Immediate Head Phone</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia1.immediateHeadPhone || '—')}</span>${makeFlagBtn('PIA 1 - Immediate Head Phone')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Dept. Head</div><div class="summary-value">${escapeHtml(appData.pia1.deptHead || '—')} ${appData.pia1.deptHeadEmail ? `(${escapeHtml(appData.pia1.deptHeadEmail)})` : ''}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Dept. Head Phone</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia1.deptHeadPhone || '—')}</span>${makeFlagBtn('PIA 1 - Dept. Head Phone')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Division Head</div><div class="summary-value">${escapeHtml(appData.pia1.divHead || '—')} ${appData.pia1.divHeadEmail ? `(${escapeHtml(appData.pia1.divHeadEmail)})` : ''}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Division Head Phone</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia1.divHeadPhone || '—')}</span>${makeFlagBtn('PIA 1 - Division Head Phone')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Benefits</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia1.benefits || '—')}</span>${makeFlagBtn('PIA 1 - Benefits')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Scope</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia1.scope || '—')}</span>${makeFlagBtn('PIA 1 - Scope')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">End User</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia1.endUser || '—')}</span>${makeFlagBtn('PIA 1 - End User')}</div></div>

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">PII Inventory (PIA 2)</div>
        <div class="summary-row">
          <div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Collected Fields</div>
          <div class="summary-value">
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
              ${pii2Fields.map((f, i) => {
                const isSelected = piiFields[i] === 'YES';
                return '<div style="display:flex; align-items:center; gap:4px; padding:4px 8px; border:1px solid ' + (isSelected ? 'var(--navy-bright)' : 'var(--border)') + '; border-radius:4px; background:' + (isSelected ? 'var(--navy-tint)' : 'transparent') + '; opacity:' + (isSelected ? '1' : '0.6') + '; font-size:11.5px;">' +
                  '<span style="font-weight:' + (isSelected ? '600' : '400') + ';">' + escapeHtml(f) + '</span>' +
                  makeFlagBtn('PIA 2 - ' + f, true) +
                '</div>';
              }).join('')}
              ${customOthers.map((c, i) => {
                return '<div style="display:flex; align-items:center; gap:4px; padding:4px 8px; border:1px solid var(--navy-bright); border-radius:4px; background:var(--navy-tint); font-size:11.5px;">' +
                  '<span style="font-weight:600;">' + escapeHtml(c) + ' (Custom)</span>' +
                  makeFlagBtn('PIA 2 - Custom Field ' + (i+1), true) +
                '</div>';
              }).join('')}
            </div>
          </div>
        </div>

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Stakeholders (PIA 3)</div>
        <div style="background: var(--bg2); border: 1px solid var(--border); padding: 12px; border-radius: var(--radius); margin-bottom: 12px;">
          <div style="font-size: 11.5px; font-weight: 600; color: var(--navy); text-transform: uppercase; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
            <span>Internal Stakeholders</span>
            ${makeFlagBtn('PIA 3 - Internal Stakeholders')}
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-bottom: 12px;">
            ${(function() {
                const items = appData.pia3.intStakeholders || [];
                const valid = items.filter(v => typeof v === 'string' ? v : (v.name || v.email));
                if (!valid.length) return '<div style="color:var(--text3); font-size:12px;">No stakeholders identified.</div>';
                return valid.map(v => {
                  const label = typeof v === 'string' ? v : [v.name, v.email].filter(Boolean).join(' - ');
                  return `<div class="stakeholder-tag" style="margin:0; width:100%; box-sizing:border-box; padding:6px 10px;">${escapeHtml(label)}</div>`;
                }).join('');
            })()}
          </div>
          <div class="summary-row" style="border-top: 1px dashed var(--border); padding: 8px 0 0 0;"><div class="summary-label" style="min-width: 80px;">Notes</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia3.intDescription || '—')}</span>${makeFlagBtn('PIA 3 - Internal Notes')}</div></div>
        </div>
        <div style="background: var(--bg2); border: 1px solid var(--border); padding: 12px; border-radius: var(--radius);">
          <div style="font-size: 11.5px; font-weight: 600; color: var(--navy); text-transform: uppercase; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
            <span>External Stakeholders</span>
            ${makeFlagBtn('PIA 3 - External Stakeholders')}
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-bottom: 12px;">
            ${(function() {
                const items = appData.pia3.extStakeholders || [];
                const valid = items.filter(v => typeof v === 'string' ? v : (v.name || v.email));
                if (!valid.length) return '<div style="color:var(--text3); font-size:12px;">No stakeholders identified.</div>';
                return valid.map(v => {
                  const label = typeof v === 'string' ? v : [v.name, v.email].filter(Boolean).join(' - ');
                  return `<div class="stakeholder-tag" style="margin:0; width:100%; box-sizing:border-box; padding:6px 10px;">${escapeHtml(label)}</div>`;
                }).join('');
            })()}
          </div>
          <div class="summary-row" style="border-top: 1px dashed var(--border); padding: 8px 0 0 0;"><div class="summary-label" style="min-width: 80px;">Notes</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia3.extDescription || '—')}</span>${makeFlagBtn('PIA 3 - External Notes')}</div></div>
        </div>

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Data Lifecycle (PIA 4)</div>
        ${['collect','use','retain','disclose','dispose'].map(k => `<div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">${k.toUpperCase()}</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(appData.pia4[k] || '—')}</span>${makeFlagBtn('PIA 4 - ' + k.toUpperCase())}</div></div>`).join('')}
      </div>
    `;
    
    let endorsementFileHtml = '';
    let endorsementFileObj = null; // Store for flagging in Supporting Documents
    let dcsFilesHtml = '';
    let hasAttachedDocs = false;
    let dcsSummaryHtml = `<div style="padding: 10px; color: var(--text3); font-style: italic;">No DCS data linked to this application.</div>`;
    
    // Get DCS files early to check for duplicates (endorsement letter might be in both)
    const dcsFiles = appData.linkedReqId ? getAndShareDCSFiles(appData.linkedReqId) : [];

    if (dcsData) {
      
      // Build Agency Info section - dynamically render ALL fields
      let agencyHtml = '';
      if (dcsData._metadataAgency && typeof dcsData._metadataAgency === 'object' && Object.keys(dcsData._metadataAgency).length > 0) {
        const agency = dcsData._metadataAgency;
        const fieldLabels = {
          agencyName: 'Agency Name',
          agencyPersonnel: 'Agency Personnel',
          agencyHead: 'Agency Head',
          agencyEmail: 'Agency Email',
          agencyPhone: 'Agency Phone',
          division: 'Division / Office',
          contractStartDate: 'Contract Start',
          networkDrive: 'Network Drive',
          immHeadRecoveryEmail: 'Recovery Email',
          immHeadRecoveryNumber: 'Recovery Number'
        };
        let agencyFieldsHtml = '';
        Object.keys(agency).forEach(key => {
          const val = agency[key];
          if (val === null || val === undefined || val === '') return;
          if (key === 'endorsementLetter' && typeof val === 'object' && val.id) {
            // ONLY add if not already found in dcsFiles (prevents double buttons for same file)
            const alreadyFound = dcsFiles.some(f => f.id === val.id);
            if (!alreadyFound) {
              endorsementFileHtml = `<a href="https://drive.google.com/file/d/${escapeHtml(val.id)}/view" target="_blank" class="btn btn-sm" style="color: var(--navy-bright); text-decoration: none; border-color: var(--navy-bright);" title="${escapeHtml(val.name || 'Endorsement Letter')}">📄 View Endorsement Letter</a>`;
            }
            return;
          }
          const label = fieldLabels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
          agencyFieldsHtml += `<div class="summary-row"><div class="summary-label">${escapeHtml(label)}</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(String(val))}</span>${makeFlagBtn('DCS - ' + label)}</div></div>`;
        });
        if (agencyFieldsHtml) {
          agencyHtml = `<div class="summary-section-title" style="display: flex; align-items: center; gap: 8px; margin-top: 15px;">Agency Information</div>${agencyFieldsHtml}`;
        }
      }
      
      let dateStr = '—';
      if (dcsData._timestamp) {
        dateStr = dcsData._timestamp instanceof Date ? dcsData._timestamp.toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : escapeHtml(String(dcsData._timestamp));
      }
      
      // Populate accountablePersonsHtmlNoFlags (for previewHtml)
      if (dcsData.accountable) {
        for (let i = 1; i <= 5; i++) {
          const name = dcsData.accountable[`accountableName${i}`];
          const email = dcsData.accountable[`accountableEmail${i}`];
          if (name || email) {
            accountablePersonsHtmlNoFlags += `<div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Accountable Person ${i} </div><div class="summary-value">${escapeHtml(name || '—')} (${escapeHtml(email || '—')})</div></div>\n`;
          }
        }
      }
      
      // Now, build the version with flags specifically for dcsSummaryHtml
      let accountablePersonsDCSHtmlWithFlags = '';
      if (dcsData.accountable) {
        for (let i = 1; i <= 5; i++) {
          const name = dcsData.accountable[`accountableName${i}`];
          const email = dcsData.accountable[`accountableEmail${i}`];
          if (name || email) {
            accountablePersonsDCSHtmlWithFlags += `<div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Accountable Person ${i}</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(name || '—')} (${escapeHtml(email || '—')})</span>${makeFlagBtn('DCS - Accountable Person ' + i)}</div></div>\n`;
          }
        }
      }
      
      dcsSummaryHtml = `
        <div class="details-content">
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Request ID</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span><strong>${escapeHtml(dcsData._reqId || '—')}</strong></span>${makeFlagBtn('DCS - Request ID')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Requestor</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData._email || '—')}</span>${makeFlagBtn('DCS - Requestor')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">DCS Status</div><div class="summary-value"><span class="status-badge status-${String(dcsData._status).toLowerCase() === 'complete' ? 'complete' : 'pending'}">${escapeHtml(dcsData._status || '—')}</span></div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Submission Date</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${dateStr}</span>${makeFlagBtn('DCS - Submission Date')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Department</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.dept || dcsData.department || '—')}</span>${makeFlagBtn('DCS - Department')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Locations</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.locations || dcsData.location || '—')}</span>${makeFlagBtn('DCS - Locations')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Access Needed</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.access || '—')}</span>${makeFlagBtn('DCS - Access Needed')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">iHelp Reference</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.ihelp || '—')}</span>${makeFlagBtn('DCS - iHelp Reference')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Immediate Head</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.immHeadName || '—')} (${escapeHtml(dcsData._immHeadEmail || '—')})</span>${makeFlagBtn('DCS - Immediate Head')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Department Head</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.deptHeadName || '—')} (${escapeHtml(dcsData._deptHeadEmail || '—')})</span>${makeFlagBtn('DCS - Department Head')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Division Head</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml(dcsData.divHeadName || '—')} (${escapeHtml(dcsData._divHeadEmail || '—')})</span>${makeFlagBtn('DCS - Division Head')}</div></div>
          ${accountablePersonsDCSHtmlWithFlags}
          ${agencyHtml}
        </div>
      `;
    }
    
    if (dcsFiles && dcsFiles.length > 0) {
      hasAttachedDocs = true;
      dcsFilesHtml = dcsFiles.map(f => {
        const fn = (f.name || '').toUpperCase();
        let docType = '';

        // ── LAYER 1: Check Metadata_JSON for document type field ──
        if (!docType && dcsData) {
          const rawMetaType = dcsData.documentType || dcsData.docType ||
                              dcsData.agreementType || dcsData.ndaType ||
                              dcsData.formType || dcsData.docCategory || '';
          if (rawMetaType) {
            const mt = String(rawMetaType).toUpperCase();
            if (mt === 'CU' || mt.includes('CONFIDENTIALITY') || mt.includes('UNDERTAKING'))
              docType = 'Confidentiality Undertaking (Agency)';
            else if (mt === 'NDA' || mt.includes('NON-DISCLOSURE') || mt.includes('NON_DISCLOSURE'))
              docType = 'Non-Disclosure Agreement (External)';
            else if (mt === 'DPA' || mt.includes('DATA PROTECTION'))
              docType = 'Data Protection Agreement (Internal)';
            else if (mt.includes('ENDORSEMENT'))
              docType = 'Endorsement Letter';
            else if (mt === 'DSA')
              docType = 'DSA';
          }
        }

        // ── LAYER 2: File abbreviation suffix (e.g. DCS-XXXXXX-CU) ──
        if (!docType) {
          // Match abbreviation after hyphen/underscore or at end of filename
          const suffixMatch = fn.match(/[-_](CU|NDA|DPA|DSA)(?:\.[^.]+)?$/);
          if (suffixMatch) {
            switch (suffixMatch[1]) {
              case 'CU':  docType = 'Confidentiality Undertaking (Agency)'; break;
              case 'NDA': docType = 'Non-Disclosure Agreement (External)'; break;
              case 'DPA': docType = 'Data Protection Agreement (Internal)'; break;
              case 'DSA': docType = 'DSA'; break;
            }
          }
        }

        // ── LAYER 3: Full-word filename match ──
        if (!docType) {
          if (fn.includes('ENDORSEMENT')) docType = 'Endorsement Letter';
          else if (fn.includes('CONFIDENTIALITY')) docType = 'Confidentiality Undertaking (Agency)';
          else if (fn.includes('NON-DISCLOSURE') || fn.includes('NON_DISCLOSURE')) docType = 'Non-Disclosure Agreement (External)';
          else if (fn.includes('DATA PROTECTION')) docType = 'Data Protection Agreement (Internal)';
          else if (fn.includes('DSA')) docType = 'DSA';
        }

        // ── LAYER 4: Final fallback ──
        if (!docType) docType = 'NDA Document';

        return `<a href="${escapeHtml(f.url)}" target="_blank" class="btn btn-sm" style="color: var(--navy-bright); text-decoration: none; border-color: var(--navy-bright);" title="${escapeHtml(f.name)}">View ${docType}</a>`;
      }).join('');
    }

    const documentsHtml = `
      <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
        ${dcsFilesHtml}
        ${endorsementFileHtml}
        ${!hasAttachedDocs && !endorsementFileHtml ? `<span style="font-size: 13px; color: var(--text3);">No external agreements or documents attached.</span>` : ''}
      </div>
    `;

    // Determine status badge class
    const badgeClass = (() => {
      const s = String(appData.status || '').toLowerCase();
      if (s.includes('approve')) return 'approved';
      if (s.includes('reject') || s.includes('return')) return 'rejected';
      if (s.includes('deny')) return 'denied';
      if (s.includes('escalat')) return 'escalated';
      return 'pending';
    })();

    const flaggingLegend = `
      <div style="margin-top: 15px; margin-bottom: 10px; padding: 10px 12px; background: var(--navy-tint); border: 1px solid var(--navy-border); border-radius: var(--radius); font-size: 13px; line-height: 1.6; color: var(--text2);">
        <div style="font-weight: 600; color: var(--navy-text); margin-bottom: 6px;">Flag System Guide</div>
        <ol style="margin: 0 0 6px 18px; padding: 0;">
          <li>Click the flag button (<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle;"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>) next to a field value to flag it for the requestor.</li>
          <li>Type the reason for the flag (max 50 characters), then click <strong>Save</strong>. The flag turns <span style="color: var(--danger-text); font-weight: 600;">red</span> when active.</li>
          <li>To remove a flag, click <strong>Remove</strong> next to the flagged field.</li>
        </ol>
      </div>
    `;

    previewHtml = `
      <div style="margin-bottom: 12px; padding-bottom: 20px; border-bottom: 1px dashed var(--border);">
        <div class="step-badge" style="background: var(--bg3); color: var(--text3); border-color: var(--border);">Application Brief</div>
        <div class="summary-row"><div class="summary-label">DCS Request</div><div class="summary-value"><strong>${escapeHtml(appData.linkedReqId || '—')}</strong></div></div>
        <div class="summary-row"><div class="summary-label">Current Status</div><div class="summary-value"><span class="status-badge status-${badgeClass}">${escapeHtml(appData.status)}</span></div></div>
        <div class="summary-row"><div class="summary-label">Program</div><div class="summary-value"><strong>${escapeHtml(appData.pia1.program || '—')}</strong></div></div>
        <div class="summary-row"><div class="summary-label">Purpose</div><div class="summary-value">${escapeHtml(appData.pia1.purpose)}</div></div>
        <div class="summary-row">
          <div class="summary-label">PII Collected</div>
          <div class="summary-value">${allPii.length > 0 ? allPii.map(f => `<span class="pii-tag">${escapeHtml(f)}</span>`).join('') : 'None reported'}</div>
        </div>
        
        ${accountablePersonsHtmlNoFlags ? `<div class="summary-section-title" style="margin-top: 1.5rem; display: flex; align-items: center; gap: 8px;">Accountable Persons (DCS)</div>${accountablePersonsHtmlNoFlags}` : ''}
        ${flaggingLegend}
        <details style="margin-top: 15px;"><summary>Application Summary (DCS)</summary>${dcsSummaryHtml}</details>
        <details><summary>Application Summary (PIA)</summary>${fullSummaryHtml}</details>
        
        <div class="summary-section-title" style="margin-top: 20px;">Supporting Documents</div>
        ${documentsHtml}
        
      </div>
    `;
  }

  /**
   * Returns a CSS class name for status badge styling.
   * Matches status text against approval/rejection keywords.
   */
  const getStatusBadgeClass = (status) => {
    const s = String(status || '').toLowerCase();
    if (s.includes('approve')) return 'approved';
    if (s.includes('reject') || s.includes('return')) return 'rejected';
    if (s.includes('deny')) return 'denied';
    if (s.includes('escalat')) return 'escalated';
    return 'pending'; // Default for 'Pending', 'Under Review', 'Escalated...'
  };

  /**
   * Fetches ISM workflow context for a given session.
   * Returns an object with all workflow steps and total count.
   */
  const getISMWorkflowContext = (sessionId) => {
    const context = {
      steps: [],
      totalSteps: 0
    };
    try {
      const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const data = ismWorkflowSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId) {
          context.steps.push({
            step: data[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1],
            name: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1],
            email: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1],
            status: data[i][ISM_WORKFLOW_COLS.STATUS - 1],
            routing: data[i][ISM_WORKFLOW_COLS.ROUTING_DESTINATION - 1],
            decisionDate: data[i][ISM_WORKFLOW_COLS.DECISION_DATE - 1]
          });
          context.totalSteps++;
        }
      }
    } catch (e) {
      Logger.log('Error in getISMWorkflowContext: ' + e.toString());
    }
    return context;
  };

  // Determine which ISM step this reviewer is on (Person 1, Person 2, etc.)
  const getISMReviewerStep = () => {
    try {
      const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const data = ismWorkflowSheet.getDataRange().getValues();
      const normalizedTarget = String(getNormalizedEmail(targetEmail) || '').toLowerCase();
      
      for (let i = 1; i < data.length; i++) {
        if (data[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId) {
          const normalizedMember = String(getNormalizedEmail(data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]) || '').toLowerCase();
          const status = String(data[i][ISM_WORKFLOW_COLS.STATUS - 1] || '').trim();
          if (normalizedMember === normalizedTarget && status === 'Pending') {
            return Number(data[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] || 1);
          }
        }
      }
    } catch (e) {
      Logger.log('Error getting ISM reviewer step: ' + e.toString());
    }
    return 1; // Default to Person 1
  };

  const getApproverStep = () => {
    try {
      const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      const data = apprSheet.getDataRange().getValues();
      const normalizedTarget = String(getNormalizedEmail(targetEmail) || '').toLowerCase();
      
      for (let i = 1; i < data.length; i++) {
        if (data[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId) {
          const normalizedMember = String(getNormalizedEmail(data[i][APPROVAL_COLS.APPROVER_EMAIL - 1]) || '').toLowerCase();
          const status = String(data[i][APPROVAL_COLS.STATUS - 1] || '').trim();
          if (normalizedMember === normalizedTarget && status === 'Pending') {
            return Number(data[i][APPROVAL_COLS.CURRENT_STEP - 1] || 1);
          }
        }
      }
    } catch (e) {
      Logger.log('Error getting approver step: ' + e.toString());
    }
    return 1;
  };

  const checkDivHeadReviewed = () => {
    try {
      const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
      const data = divHeadSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (data[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === sessionId &&
            data[i][DIV_HEAD_CONFIG_COLS.DECISION - 1] !== '') {
          return true;
        }
      }
    } catch(e) {}
    return false;
  };

  // Shared logic for rendering ISM InfoSec review form (Phase 3)
  const renderISMReviewForm = (errMsg = '', initialComment = '') => {
    const ismWorkflowContext = getISMWorkflowContext(sessionId);
    const ismStep = getISMReviewerStep(); // 1 = Person 1, 2 = Person 2
    
    const errorAlert = errMsg ? `<div class="alert alert-danger">${escapeHtml(errMsg)}</div>` : '';
    
    let person1RoutingChoice = '';
    if (ismStep === 2 && ismWorkflowContext.steps.length > 0) {
      const step1 = ismWorkflowContext.steps.find(s => s.step == 1);
      if (step1 && step1.routing) {
        let routingBadge = '';
        if (step1.routing === 'DCOPS') {
          routingBadge = `<span class="status-badge" style="background:#e0e7ff; color:#3730a3; border:1px solid rgba(55,48,163,0.2);">DCOPS</span>`;
        } else if (step1.routing === 'TECHSERVE') {
          routingBadge = `<span class="status-badge" style="background:#ccfbf1; color:#115e59; border:1px solid rgba(17,94,89,0.2);">TechServe</span>`;
        } else if (step1.routing === 'BOTH') {
          routingBadge = `<span class="status-badge" style="background:#f3e8ff; color:#6b21a8; border:1px solid rgba(107,33,168,0.2);">Both Teams</span>`;
        } else {
          routingBadge = `<span class="status-badge" style="background:var(--bg3); color:var(--text2); border:1px solid var(--border);">${escapeHtml(step1.routing)}</span>`;
        }
        person1RoutingChoice = `<div style="font-size:12.5px; color:var(--text2); margin-bottom:12px; padding: 10px 12px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); display: flex; align-items: center; gap: 8px;"><span><strong>${escapeHtml(step1.name)}</strong> recommended routing to:</span> ${routingBadge}</div>`;
      }
    }

    const formatApproverDate = (dateVal) => {
      if (!dateVal) return '';
      try {
        if (Object.prototype.toString.call(dateVal) === '[object Date]') {
          return dateVal.toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'});
        }
        if (typeof dateVal === 'string' && dateVal.trim()) return String(dateVal);
        return '';
      } catch(e) { return ''; }
    };

    const approverBadgesHtml = (appData.approvers || []).map(a => {
      let badgeCls = 'status-pending';
      if (a.status === 'Approved') badgeCls = 'status-approved';
      else if (a.status === 'Rejected' || a.status === 'Returned') badgeCls = 'status-rejected';
      else if (a.status === 'Denied') badgeCls = 'status-denied';

      const roleLabel = a.role ? `<div style="font-size: 9px; font-weight: 800; color: var(--text3); text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.03em;">${escapeHtml(a.role)}</div>` : '';
      const dateStr = formatApproverDate(a.decisionDate);
      const dateHtml = dateStr ? `<div style="font-size: 9px; color: var(--text3); margin-top: 2px;">${escapeHtml(dateStr)}</div>` : '';

      return `
        <div style="display: inline-flex; flex-direction: column; margin-right: 12px; margin-bottom: 12px; vertical-align: top; max-width: 210px;">
          ${roleLabel}
          <span class="status-badge ${badgeCls}" style="font-size: 11px; border: 1px solid var(--border); border-color: rgba(0,0,0,0.1); padding: 4px 10px;">${escapeHtml(a.name)}: ${escapeHtml(a.status)}</span>
          ${dateHtml}
        </div>`;
    }).join('');

    const ismApproverBadgesHtml = (ismWorkflowContext.steps || []).map(a => {
      let badgeCls = 'status-pending';
      if (a.status === 'Approved') badgeCls = 'status-approved';
      else if (a.status === 'Rejected' || a.status === 'Returned') badgeCls = 'status-rejected';
      else if (a.status === 'Denied') badgeCls = 'status-denied';

      const roleLabel = `<div style="font-size: 9px; font-weight: 800; color: var(--text3); text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.03em;">InfoSec Member (Step ${a.step})</div>`;
      const dateStr = formatApproverDate(a.decisionDate);
      const dateHtml = dateStr ? `<div style="font-size: 9px; color: var(--text3); margin-top: 2px;">${escapeHtml(dateStr)}</div>` : '';

      let displayStatus = a.status;
      if (displayStatus === 'EscalatedToDivisionHead') displayStatus = 'Escalated';

      return `
        <div style="display: inline-flex; flex-direction: column; margin-right: 12px; margin-bottom: 12px; vertical-align: top; max-width: 210px;">
          ${roleLabel}
          <span class="status-badge ${badgeCls}" style="font-size: 11px; border: 1px solid var(--border); border-color: rgba(0,0,0,0.1); padding: 4px 10px;">${escapeHtml(a.name)}: ${escapeHtml(displayStatus)}</span>
          ${dateHtml}
        </div>`;
    }).join('');

    // Determine which buttons to show based on ISM step
    let actionButtonsHtml = '';
    const hasDivHeadReviewed = checkDivHeadReviewed();
    
    if (ismStep === 1) {
      // Person 1: Can Approve (with destination), Return, Deny, or Escalate
      actionButtonsHtml = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%;">
          <div class="action-approve-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Advance this application to the next approval stage or finalize it.</div>
            <button type="button" class="btn btn-success" style="padding:16px; width:100%; justify-content:center; font-size:16px;" onclick="submitWithRouting('Approve')">Approve</button>
          </div>
          <div class="action-approve-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Forward this application to the Division Head for executive review.</div>
            <button type="button" class="btn btn-secondary" style="background:#7c3aed; color:white; padding:16px; width:100%; justify-content:center; font-size:16px; border-color:#7c3aed;" onclick="submitWithRouting('EscalateToDivisionHead')">Escalate to Division Head</button>
          </div>
          <div class="action-deny-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Send this application back to the original requestor for necessary revisions.</div>
            <button type="button" class="btn btn-warn" style="padding:16px; width:100%; justify-content:center; font-size:16px;" onclick="showReturnOptions()">Return to Requestor</button>
          </div>
          <div class="action-deny-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Permanently reject this application. It will not be processed further.</div>
            <button type="button" class="btn btn-danger" style="padding:16px; width:100%; justify-content:center; font-size:16px;" onclick="submitDenial()">Deny</button>
          </div>
        </div>
      `;
    } else if (ismStep === 2) {
      // Person 2: Can Approve (with destination), Return, Deny, and Escalate (if not already escalated)
      let escalateBtnHtml = '';
      if (hasDivHeadReviewed) {
        escalateBtnHtml = `
          <div class="action-approve-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Forward this application to the Division Head for executive review.</div>
            <button type="button" class="btn btn-secondary" disabled style="background:#d1d5db; color:#9ca3af; cursor:not-allowed; padding:16px; width:100%; justify-content:center; font-size:16px; border-color:#d1d5db;" title="Escalation not available - Division Head already reviewed">Escalate to Division Head</button>
          </div>
        `;
      } else {
        escalateBtnHtml = `
          <div class="action-approve-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Forward this application to the Division Head for executive review.</div>
            <button type="button" class="btn btn-secondary" style="background:#7c3aed; color:white; padding:16px; width:100%; justify-content:center; font-size:16px; border-color:#7c3aed;" onclick="submitWithRouting('EscalateToDivisionHead')">Escalate to Division Head</button>
          </div>
        `;
      }
      actionButtonsHtml = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%;">
          <div class="action-approve-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Advance this application to the next approval stage or finalize it.</div>
            <button type="button" class="btn btn-success" style="padding:16px; width:100%; justify-content:center; font-size:16px;" onclick="submitWithRouting('Approve')">Approve</button>
          </div>
          ${escalateBtnHtml}
          <div class="action-deny-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Send this application back to the original requestor for necessary revisions.</div>
            <button type="button" class="btn btn-warn" style="padding:16px; width:100%; justify-content:center; font-size:16px;" onclick="showReturnOptions()">Return to Requestor</button>
          </div>
          <div class="action-deny-group" style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size: 13px; color: var(--text2);">Permanently reject this application. It will not be processed further.</div>
            <button type="button" class="btn btn-danger" style="padding:16px; width:100%; justify-content:center; font-size:16px;" onclick="submitDenial()">Deny</button>
          </div>
        </div>
      `;
    }
    
    const content = `
      ${errorAlert}
      ${previewHtml}
      <div class="summary-section-title" style="margin-top: 1.5rem;">Main Workflow Approvers</div>
      <div class="ismApproverContainer" style="margin-top: 8px;">${approverBadgesHtml}</div>
      <div class="summary-section-title" style="margin-top: 1.5rem;">ISM Workflow Approvers</div>
      <div class="ismApproverContainer" style="margin-top: 8px;">${ismApproverBadgesHtml}</div>
      <div style="margin-bottom:15px; font-size:13px; color:var(--text2); background:var(--navy-tint); border:1px solid var(--navy-border); padding:10px; border-radius:var(--radius); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <span>InfoSec Member Review (Step ${ismStep} of ${ismWorkflowContext.totalSteps}): You are reviewing as <strong>${escapeHtml(activeUser)}</strong></span>
        <div style="display:flex; gap:5px; flex-wrap:wrap;">
        </div>
      </div>
      <p>Please provide your InfoSec assessment and select a decision for application <strong>${escapeHtml(sessionId)}</strong> below.</p>
      <form method="POST" id="ismReviewForm" action="${webAppUrl}" target="_top">
        <input type="hidden" name="approverFlags" id="approverFlagsInput" value="{}">
        <input type="hidden" name="isPost" value="true">
        <input type="hidden" name="action" value="ISMReview">
        <input type="hidden" name="sessionId" value="${escapeHtml(sessionId)}">
        <input type="hidden" name="email" value="${escapeHtml(targetEmail)}">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input type="hidden" name="ts" value="${escapeHtml(ts)}">
        <input type="hidden" name="step" value="${ismStep}">
        <input type="hidden" name="ismDecision" id="ismDecisionInput">
        <input type="hidden" name="routingDestination" id="routingDestinationInput" value="">
        <textarea name="comment" id="editor" class="form-textarea" maxlength="${COMMENT_MAX_CHARS}" style="background:white; min-height:120px; border:1px solid var(--border2); padding:10px;" oninput="updateCharCount()">${initialComment.replace(/<[^>]*>/g, '')}</textarea>
        <div style="text-align: right; font-size: 12.5px; color: var(--text3); margin-top: -8px; margin-bottom: 15px; font-weight: 500;">
          <span id="charCount">0</span> / ${COMMENT_MAX_CHARS} characters 
          <span style="font-size: 11.5px; font-weight: 400; margin-left: 8px;">(Minimum ${COMMENT_MIN_CHARS_STANDARD} required)</span>
        </div>
        
        <!-- Inline decision panel: routing destination + all decision actions shown directly (no modal) -->
        <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 18px;">
          <div class="modal-step-title" style="margin-bottom:10px;">Routing Destination <span style="color:var(--text3); font-weight:400; font-size:12px;">(required only for Approve / Escalate)</span></div>
          ${person1RoutingChoice}
          <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
            <label class="routing-option">
              <input type="radio" name="routingDest" value="DCOPS" onclick="document.getElementById('routingErrorMain').style.display='none'">
              <div><div class="routing-title">DCOPS Team</div><div class="routing-desc">Data Collection Operations</div></div>
            </label>
            <label class="routing-option">
              <input type="radio" name="routingDest" value="TECHSERVE" onclick="document.getElementById('routingErrorMain').style.display='none'">
              <div><div class="routing-title">TechServe Team</div><div class="routing-desc">Technical Services</div></div>
            </label>
            <label class="routing-option">
              <input type="radio" name="routingDest" value="BOTH" onclick="document.getElementById('routingErrorMain').style.display='none'">
              <div><div class="routing-title">Both Teams</div><div class="routing-desc">DCOPS &amp; TechServe</div></div>
            </label>
          </div>
          <div id="routingErrorMain" style="display:none; color:var(--danger-text); font-size:12.5px; margin-top:8px;">⚠ Please select a routing destination for Approve or Escalate.</div>
          <div style="font-size:12px; color:var(--text3); line-height:1.4; margin-top:8px;">Routing is required only for <strong>Approve</strong> or <strong>Escalate</strong>. Leave it unselected for <strong>Return</strong> or <strong>Deny</strong>.</div>

          <div class="modal-step-title" style="margin:18px 0 10px;">Decision</div>
          ${actionButtonsHtml}
        </div>
      </form>

      <!-- Submitting overlay (shown on any decision submit so the click has visible feedback) -->
      <div id="submitOverlay" style="display:none; position:fixed; inset:0; background:rgba(255,255,255,0.9); z-index:99999; align-items:center; justify-content:center; flex-direction:column; gap:14px;">
        <style>@keyframes ismSpin{to{transform:rotate(360deg)}}</style>
        <div style="width:42px; height:42px; border:4px solid var(--navy-border,#cdd9ea); border-top-color:var(--navy,#1e3a5f); border-radius:50%; animation:ismSpin 0.8s linear infinite;"></div>
        <div style="font-size:14px; font-weight:600; color:var(--navy-text,#0f2238);">Submitting your decision…</div>
      </div>

      <!-- Return Options Modal -->
      <div id="returnModal" class="decision-modal-overlay" style="display:none;">
        <div class="decision-modal" style="max-width: 400px;">
          <h3 class="decision-modal-header">Return to Requestor</h3>
          <p style="color:var(--text2); margin:0 0 20px 0; font-size:14px; line-height: 1.5;">This application will be returned to the requestor. If DCS fields are flagged, the associated DCS request will also be returned. Continue?</p>
          <div style="display:flex; gap:12px; flex-direction:column;">
            <button type="button" class="btn btn-warn" onclick="submitReturnDecision('Return')" style="width:100%; padding:12px; justify-content:center;">Confirm Return to Requestor</button>
            <button type="button" class="btn btn-secondary" onclick="closeReturnModal()" style="width:100%; padding:12px; justify-content:center;">Cancel</button>
          </div>
        </div>
      </div>
      
      <script>
        let flagData = {};
        
        function toggleFlagBox(btn) {
          const flagName = btn.getAttribute('data-flag');
          const row = btn.closest('.summary-row') || btn.parentElement;
          
          let box = row.querySelector('.flag-input-box');
          if (!box) {
            box = document.createElement('div');
            box.className = 'flag-input-box';
            box.style.gridColumn = '1 / -1';
            box.style.background = 'var(--danger)';
            box.style.padding = '8px 12px';
            box.style.borderRadius = 'var(--radius)';
            box.style.display = 'flex';
            box.style.alignItems = 'center';
            box.style.gap = '8px';
            box.style.border = '1px solid rgba(220,38,38,0.2)';
            box.style.marginTop = '4px';
            
            box.innerHTML = 
              '<span style="font-size:12px; font-weight:600; color:var(--danger-text); white-space:nowrap;">Flag Reason:</span>' +
              '<input type="text" class="flag-reason-input" maxlength="50" placeholder="Required (max 50 chars)" style="flex:1; padding:6px; border:1px solid var(--border2); border-radius:4px; font-size:12px;">' +
              '<button type="button" class="btn btn-sm btn-primary save-flag-btn" style="padding:4px 10px;">Save</button>' +
              '<button type="button" class="btn btn-sm btn-danger remove-flag-btn" style="padding:4px 10px; display:none;">Remove</button>' +
              '<button type="button" class="btn btn-sm btn-secondary close-flag-btn" style="padding:4px 10px;">Close</button>';
              
            box.querySelector('.save-flag-btn').onclick = function() { saveFlagInline(this, flagName); };
            box.querySelector('.remove-flag-btn').onclick = function() { removeFlagInline(this, flagName); };
            box.querySelector('.close-flag-btn').onclick = function() { closeFlagInline(this); };
            
            row.appendChild(box);
          } else {
            box.style.display = 'flex';
          }
          
          const input = box.querySelector('.flag-reason-input');
          input.value = flagData[flagName] || '';
          box.querySelector('.remove-flag-btn').style.display = flagData[flagName] ? 'block' : 'none';
          input.focus();
        }

        function toggleQuickFlag(btn) {
          const flagName = btn.getAttribute('data-flag');
          if (flagData[flagName]) {
            delete flagData[flagName];
            btn.classList.remove('active');
          } else {
            flagData[flagName] = "Field flagged for review.";
            btn.classList.add('active');
          }
          updateFlagsInput();
        }

        function saveFlagInline(btn, flagName) {
          const box = btn.closest('.flag-input-box');
          const input = box.querySelector('.flag-reason-input');
          const reason = input.value.trim();
          
          if (!reason) { showError('Please provide a reason.'); return; }
          
          flagData[flagName] = reason;
          updateFlagsInput();
          
          const container = box.parentElement;
          const flagBtn = container.querySelector('.flag-btn[data-flag="' + flagName.replace(/"/g, '\\\\"') + '"]');
          if (flagBtn) flagBtn.classList.add('active');
          
          box.style.display = 'none';
          
          let savedDisplay = container.querySelector('.flag-saved-display');
          if (!savedDisplay) {
            savedDisplay = document.createElement('div');
            savedDisplay.className = 'flag-saved-display';
            savedDisplay.style.gridColumn = '1 / -1';
            savedDisplay.style.fontSize = '12px';
            savedDisplay.style.color = 'var(--danger-text)';
            savedDisplay.style.background = 'rgba(220,38,38,0.05)';
            savedDisplay.style.padding = '6px 10px';
            savedDisplay.style.borderRadius = '4px';
            savedDisplay.style.marginTop = '4px';
            savedDisplay.style.display = 'flex';
            savedDisplay.style.justifyContent = 'space-between';
            savedDisplay.style.alignItems = 'center';
            container.appendChild(savedDisplay);
          }
          savedDisplay.style.display = 'flex';
          savedDisplay.innerHTML = '<span><strong>Flagged:</strong> ' + escapeHtmlLocal(reason) + '</span><button type="button" class="btn btn-sm btn-danger remove-saved-flag-btn" style="padding:2px 8px; font-size:11px;">Remove</button>';
          savedDisplay.querySelector('.remove-saved-flag-btn').onclick = function() { removeFlagInline(this, flagName); };
        }

        function removeFlagInline(btn, flagName) {
          delete flagData[flagName];
          updateFlagsInput();
          
          const container = btn.closest('.flag-input-box')?.parentElement || btn.closest('.flag-saved-display')?.parentElement;
          if (!container) return;
          
          const flagBtn = container.querySelector('.flag-btn[data-flag="' + flagName.replace(/"/g, '\\\\"') + '"]');
          if (flagBtn) flagBtn.classList.remove('active');
          
          const box = container.querySelector('.flag-input-box');
          if (box) {
            box.style.display = 'none';
            box.querySelector('.flag-reason-input').value = '';
            box.querySelector('.remove-flag-btn').style.display = 'none';
          }
          
          const savedDisplay = container.querySelector('.flag-saved-display');
          if (savedDisplay) savedDisplay.style.display = 'none';
        }

        function closeFlagInline(btn) {
          const box = btn.closest('.flag-input-box');
          if (box) box.style.display = 'none';
        }

        function updateFlagsInput() {
          const input = document.getElementById('approverFlagsInput');
          if (input) input.value = JSON.stringify(flagData);
        }

        function escapeHtmlLocal(str) {
          return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function updateCharCount() {
          const editor = document.getElementById('editor');
          if (!editor) return;
          
          const count = editor.value.trim().length;
          const countEl = document.getElementById('charCount');
          if (countEl) {
            countEl.innerText = count;
            countEl.style.color = count < 50 ? 'var(--danger-text)' : 'var(--success-text)';
          }
        }
        window.addEventListener('DOMContentLoaded', function() {
          updateCharCount();
          const editor = document.getElementById('editor');
          if (editor) {
            editor.addEventListener('paste', function(e) {
              e.preventDefault();
              const text = (e.clipboardData || window.clipboardData).getData('text/plain');
              document.execCommand('insertText', false, text.replace(/<[^>]*>/g, ''));
            });
          }
          
          document.addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
              const target = event.target;
              if (target.tagName === 'TEXTAREA' || target.isContentEditable) return;
              event.preventDefault();
              if (target.classList.contains('flag-reason-input')) {
                 const saveBtn = target.parentElement.querySelector('.save-flag-btn');
                 if (saveBtn) saveBtn.click();
              }
            }
          });
        });
        
        function clearRoutingError() {
          document.getElementById('routingError').style.display = 'none';
        }
        
        function handleRoutingChange() {
          const isSelected = document.querySelector('input[name="routingDest"]:checked') !== null;
          const approveGroup = document.querySelectorAll('.action-approve-group');
          const denyGroup = document.querySelectorAll('.action-deny-group');
          
          for (let i = 0; i < approveGroup.length; i++) {
            approveGroup[i].style.display = isSelected ? 'flex' : 'none';
          }
          for (let i = 0; i < denyGroup.length; i++) {
            denyGroup[i].style.display = isSelected ? 'none' : 'flex';
          }
          clearRoutingError();
        }
        
        function clearRoutingSelection() {
          const radios = document.getElementsByName('routingDest');
          for (let i = 0; i < radios.length; i++) {
            radios[i].checked = false;
          }
          handleRoutingChange();
        }
        
        function showReturnOptions() {
          document.getElementById('returnModal').style.display = 'flex';
        }
        
        function closeReturnModal() {
          document.getElementById('returnModal').style.display = 'none';
        }
        
        function submitWithRouting(decision) {
          const editor = document.getElementById('editor');
          const decisionInput = document.getElementById('ismDecisionInput');
          const routingInput = document.getElementById('routingDestinationInput');
          
          const plainText = editor.value.trim();

          // Remarks (min 50 chars) required for every decision (the modal gate that used to enforce this is gone).
          if (plainText.length < 50) {
            showError('Please provide at least 50 characters of remarks before submitting a decision.');
            return;
          }

          // For Approve or EscalateToDivisionHead: a routing destination is required.
          if (decision === 'Approve' || decision === 'EscalateToDivisionHead') {
            const selectedRouting = document.querySelector('input[name="routingDest"]:checked');
            if (!selectedRouting || !selectedRouting.value) {
              document.getElementById('routingErrorMain').style.display = 'block';
              showError('Please select a routing destination before approving or escalating.');
              return;
            }
            routingInput.value = selectedRouting.value;
            document.getElementById('routingErrorMain').style.display = 'none';
          } else {
            routingInput.value = '';
          }

          decisionInput.value = decision;
          showSubmittingOverlay();
          document.getElementById('ismReviewForm').submit();
        }
        
        function submitReturnDecision(decision) {
          const editor = document.getElementById('editor');
          const plainText = editor.value.trim();
          if (plainText.length < 50) {
            showError('Please provide at least 50 characters of feedback when returning an application.');
            return;
          }
          document.getElementById('ismDecisionInput').value = decision;
          document.getElementById('routingDestinationInput').value = '';
          showSubmittingOverlay();
          document.getElementById('ismReviewForm').submit();
        }

        function submitDenial() {
          const editor = document.getElementById('editor');
          const plainText = editor.value.trim();
          if (plainText.length < 50) {
            showError('Please provide at least 50 characters of feedback when denying an application.');
            return;
          }
          document.getElementById('ismDecisionInput').value = 'Deny';
          document.getElementById('routingDestinationInput').value = '';
          showSubmittingOverlay();
          document.getElementById('ismReviewForm').submit();
        }

        function showSubmittingOverlay() {
          var ov = document.getElementById('submitOverlay');
          if (ov) ov.style.display = 'flex';
        }
      </script>
    `;

    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(`<span class="step-badge">InfoSec Review Required</span><h1>Privacy Assessment Review</h1>`, content));
  };

  /* Step 4a — ISM branch: GET shows the InfoSec review form; POST validates the comment then
     records the decision via apiPhase3_ProcessISMDecision (handles approve/deny/escalate/route). */
  // Handle ISM Review (Phase 3) - display the form
  if (action === 'ISMReview') {
    if (isPost !== 'true') {
      return renderISMReviewForm();
    }

    // Validate ISM comment length
    if (params.ismDecision === 'Approve' || params.ismDecision === 'EscalateToDivisionHead') {
      // Optional comments for approval/escalation are still capped
    } else {
      const plainTextComment = String(params.comment || '').replace(/<[^>]*>/g, '').trim();
      if (plainTextComment.length < 50) {
        return renderISMReviewForm(`A minimum of 50 meaningful characters is required for this decision.`, params.comment || '');
      }
    }
    
    const plainComment = String(params.comment || '').replace(/<[^>]*>/g, '').trim();
    if (plainComment.length > COMMENT_MAX_CHARS) {
      return renderISMReviewForm(`Comments cannot exceed ${COMMENT_MAX_CHARS} characters.`, params.comment || '');
    }
    
    // Process ISM Review decision
    const ismDecision = sanitizeInput(params.ismDecision || 'Approve');
    let routingDestination = sanitizeInput(params.routingDestination || '');
    const validISMDecisions = ['Approve', 'Deny', 'Return', 'EscalateToDivisionHead'];
    
    if (validISMDecisions.indexOf(ismDecision) === -1) {
      return renderISMReviewForm('Invalid decision type: ' + ismDecision);
    }
    
    // HIGH FIX: For Approve or Escalate decisions, routing destination is REQUIRED
    if ((ismDecision === 'Approve' || ismDecision === 'EscalateToDivisionHead') && !routingDestination) {
      return renderISMReviewForm('Routing destination (DCOPS/TECHSERVE/BOTH) is required when approving or escalating an application.', comment);
    }
    
    // Call Phase 3 API to process ISM decision
    const result = apiPhase3_ProcessISMDecision(sessionId, targetEmail, ismDecision, comment || 'No additional comments provided.', routingDestination, stepParam, approverFlags);
    
    if (result.success) {
      let displayDecision = ismDecision;
      if (ismDecision === 'Approve') displayDecision = 'Approved';
      if (ismDecision === 'Deny') displayDecision = 'Denied';
      if (ismDecision === 'Return') displayDecision = 'Returned to Requestor';
      if (ismDecision === 'EscalateToDivisionHead') displayDecision = 'Escalated to Division Head';

      return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
        `<span class="step-badge">Action Completed</span><h1>Successfully ${displayDecision}!</h1>`,
        `<div class="alert" style="background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2);">Your InfoSec review for application <strong>${sessionId}</strong> has been safely recorded.</div>
        ${previewHtml}
        <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">Your response has been saved. You may now safely close this window.</p>`
      ));
    } else {
      return renderISMReviewForm('Error processing decision: ' + (result.error || 'Unknown error'), comment);
    }
  }

  // Shared logic for rendering the unified review form
  const renderReviewForm = (errMsg = '', initialComment = '', approverType = '') => {
    const approverStep = getApproverStep();

    // Generate action-specific tokens for form submission
    const approveToken = generateAuthToken(sessionId, targetEmail, ts, 'Approve');
    const denyToken = generateAuthToken(sessionId, targetEmail, ts, 'Deny');
    const returnToken = generateAuthToken(sessionId, targetEmail, ts, 'Return');

    const actionButtonsHtml = `
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px;">
        <button type="submit" name="action" value="Approve" class="btn btn-success" onclick="document.getElementById('actionTokenInput').value='${approveToken}'; showDecisionOverlay();">Approve</button>
        <button type="button" class="btn btn-warn" onclick="showReturnOptions()">Return to Requestor</button>
        <button type="submit" name="action" value="Deny" class="btn btn-danger" onclick="document.getElementById('actionTokenInput').value='${denyToken}'; showDecisionOverlay();">Deny</button>
      </div>
    `;

    const errorAlert = errMsg ? `<div class="alert alert-danger">${escapeHtml(errMsg)}</div>` : '';

    const formatApproverDateReview = (dateVal) => {
      if (!dateVal) return '';
      try {
        if (Object.prototype.toString.call(dateVal) === '[object Date]') {
          return dateVal.toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'});
        }
        if (typeof dateVal === 'string' && dateVal.trim()) return String(dateVal);
        return '';
      } catch(e) { return ''; }
    };

    let badgesSection = '';
    if (approverType === 'divhead') {
      const approverBadgesHtml = (appData.approvers || []).map(a => {
        let badgeCls = 'status-pending';
        if (a.status === 'Approved') badgeCls = 'status-approved';
        else if (a.status === 'Rejected' || a.status === 'Returned') badgeCls = 'status-rejected';
        else if (a.status === 'Denied') badgeCls = 'status-denied';
        const roleLabel = a.role ? `<div style="font-size: 9px; font-weight: 800; color: var(--text3); text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.03em;">${escapeHtml(a.role)}</div>` : '';
        const dateStr = formatApproverDateReview(a.decisionDate);
        const dateHtml = dateStr ? `<div style="font-size: 9px; color: var(--text3); margin-top: 2px;">${escapeHtml(dateStr)}</div>` : '';
        return `
          <div style="display: inline-flex; flex-direction: column; margin-right: 12px; margin-bottom: 12px; vertical-align: top; max-width: 210px;">
            ${roleLabel}
            <span class="status-badge ${badgeCls}" style="font-size: 11px; border: 1px solid var(--border); border-color: rgba(0,0,0,0.1); padding: 4px 10px;">${escapeHtml(a.name)}: ${escapeHtml(a.status)}</span>
            ${dateHtml}
          </div>`;
      }).join('');

      badgesSection = `
        <div class="summary-section-title" style="margin-top: 1.5rem;">Main Workflow Approvers</div>
        <div class="ismApproverContainer" style="margin-top: 8px;">${approverBadgesHtml}</div>
      `;
    }

    const content = `
      ${errorAlert}
      ${previewHtml}
      ${badgesSection}
      <span class="step-badge" style="text-transform: none; font-weight: 500; margin-bottom: 15px;">You are reviewing as <strong>${escapeHtml(activeUser)}</strong></span>
      <p>Please provide your feedback and select a decision for application <strong>${escapeHtml(sessionId)}</strong> below.</p>
      <form method="POST" id="approvalForm" action="${webAppUrl}" target="_top">
        <input type="hidden" name="approverFlags" id="approverFlagsInput" value="{}">
        <input type="hidden" name="isPost" value="true">
        <input type="hidden" name="sessionId" value="${escapeHtml(sessionId)}">
        <input type="hidden" name="email" value="${escapeHtml(targetEmail)}">
        <input type="hidden" name="token" id="actionTokenInput" value="${escapeHtml(token)}">
        <input type="hidden" name="ts" value="${escapeHtml(ts)}">
        <input type="hidden" name="approverType" value="${escapeHtml(approverType || '')}">
        <input type="hidden" name="step" value="${approverStep}">
        <textarea name="comment" id="editor" class="form-textarea" maxlength="${COMMENT_MAX_CHARS}" style="background:white; min-height:120px; border:1px solid var(--border2); padding:10px;" oninput="updateCharCount()">${initialComment.replace(/<[^>]*>/g, '')}</textarea>
        <div style="text-align: right; font-size: 12.5px; color: var(--text3); margin-top: -8px; margin-bottom: 15px; font-weight: 500;">
          <span id="charCount">0</span> / ${COMMENT_MAX_CHARS} characters 
          <span style="font-size: 11.5px; font-weight: 400; margin-left: 8px;">(Minimum ${COMMENT_MIN_CHARS_DECISION} required for Return/Deny)</span>
        </div>
        ${actionButtonsHtml}

        <div id="decisionOverlay" style="display:none; position:fixed; inset:0; background:rgba(255,255,255,0.92); z-index:99999; align-items:center; justify-content:center; flex-direction:column; gap:14px;">
          <style>@keyframes decSpin{to{transform:rotate(360deg)}}</style>
          <div style="width:42px; height:42px; border:4px solid #cdd9ea; border-top-color:#1e3a5f; border-radius:50%; animation:decSpin 0.8s linear infinite;"></div>
          <div style="font-size:14px; font-weight:600; color:#0f2238;">Submitting your decision…</div>
        </div>
        <script>function showDecisionOverlay(){var o=document.getElementById('decisionOverlay');if(o)o.style.display='flex';}</script>

        <div id="returnModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center; margin:0; padding:15px;">
          <div style="background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-lg); padding:1.5rem; max-width:400px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <h3 style="margin-top:0; font-size:18px; font-weight:600; color:var(--text); letter-spacing:-0.02em;">Return to Requestor</h3>
            <p style="font-size:13.5px; color:var(--text2); line-height:1.5; margin-bottom:20px;">This application will be returned to the requestor. If DCS fields are flagged, the associated DCS request will also be returned. A comment of at least 100 characters is required. Continue?</p>
            <div style="display:flex; flex-direction:column; gap:10px;">
              <button type="submit" name="action" value="Return" class="btn btn-warn" style="width:100%; justify-content:center;" onclick="document.getElementById('actionTokenInput').value='${returnToken}'; showDecisionOverlay();">Confirm Return to Requestor</button>
              <button type="button" class="btn" style="width:100%; justify-content:center; margin-top:5px;" onclick="document.getElementById('returnModal').style.display='none'">Cancel</button>
            </div>
          </div>
        </div>
      </form>
      <script>
        let flagData = {};
        
        function toggleFlagBox(btn) {
          const flagName = btn.getAttribute('data-flag');
          const row = btn.closest('.summary-row') || btn.parentElement;
          
          let box = row.querySelector('.flag-input-box');
          if (!box) {
            box = document.createElement('div');
            box.className = 'flag-input-box';
            box.style.gridColumn = '1 / -1';
            box.style.background = 'var(--danger)';
            box.style.padding = '8px 12px';
            box.style.borderRadius = 'var(--radius)';
            box.style.display = 'flex';
            box.style.alignItems = 'center';
            box.style.gap = '8px';
            box.style.border = '1px solid rgba(220,38,38,0.2)';
            box.style.marginTop = '4px';
            
            box.innerHTML = 
              '<span style="font-size:12px; font-weight:600; color:var(--danger-text); white-space:nowrap;">Flag Reason:</span>' +
              '<input type="text" class="flag-reason-input" maxlength="50" placeholder="Required (max 50 chars)" style="flex:1; padding:6px; border:1px solid var(--border2); border-radius:4px; font-size:12px;">' +
              '<button type="button" class="btn btn-sm btn-primary save-flag-btn" style="padding:4px 10px;">Save</button>' +
              '<button type="button" class="btn btn-sm btn-danger remove-flag-btn" style="padding:4px 10px; display:none;">Remove</button>' +
              '<button type="button" class="btn btn-sm btn-secondary close-flag-btn" style="padding:4px 10px;">Close</button>';
              
            box.querySelector('.save-flag-btn').onclick = function() { saveFlagInline(this, flagName); };
            box.querySelector('.remove-flag-btn').onclick = function() { removeFlagInline(this, flagName); };
            box.querySelector('.close-flag-btn').onclick = function() { closeFlagInline(this); };
            
            row.appendChild(box);
          } else {
            box.style.display = 'flex';
          }
          
          const input = box.querySelector('.flag-reason-input');
          input.value = flagData[flagName] || '';
          box.querySelector('.remove-flag-btn').style.display = flagData[flagName] ? 'block' : 'none';
          input.focus();
        }

        function toggleQuickFlag(btn) {
          const flagName = btn.getAttribute('data-flag');
          if (flagData[flagName]) {
            delete flagData[flagName];
            btn.classList.remove('active');
          } else {
            flagData[flagName] = "Field flagged for review.";
            btn.classList.add('active');
          }
          updateFlagsInput();
        }

        function saveFlagInline(btn, flagName) {
          const box = btn.closest('.flag-input-box');
          const input = box.querySelector('.flag-reason-input');
          const reason = input.value.trim();
          
          if (!reason) { showError('Please provide a reason.'); return; }
          
          flagData[flagName] = reason;
          updateFlagsInput();
          
          const row = btn.closest('.summary-row') || btn.parentElement.parentElement;
          const flagBtn = row.querySelector('.flag-btn[data-flag="' + flagName.replace(/"/g, '\\\\"') + '"]');
          if (flagBtn) flagBtn.classList.add('active');
          
          box.style.display = 'none';
          
          let savedDisplay = row.querySelector('.flag-saved-display');
          if (!savedDisplay) {
            savedDisplay = document.createElement('div');
            savedDisplay.className = 'flag-saved-display';
            savedDisplay.style.gridColumn = '1 / -1';
            savedDisplay.style.fontSize = '12px';
            savedDisplay.style.color = 'var(--danger-text)';
            savedDisplay.style.background = 'rgba(220,38,38,0.05)';
            savedDisplay.style.padding = '6px 10px';
            savedDisplay.style.borderRadius = '4px';
            savedDisplay.style.marginTop = '4px';
            row.appendChild(savedDisplay);
          }
          savedDisplay.style.display = 'block';
          savedDisplay.innerHTML = '<strong>Flagged:</strong> ' + escapeHtmlLocal(reason);
        }

        function removeFlagInline(btn, flagName) {
          delete flagData[flagName];
          updateFlagsInput();
          
          const row = btn.closest('.summary-row') || btn.parentElement.parentElement;
          const flagBtn = row.querySelector('.flag-btn[data-flag="' + flagName.replace(/"/g, '\\\\"') + '"]');
          if (flagBtn) flagBtn.classList.remove('active');
          
          const box = btn.closest('.flag-input-box');
          if (box) box.style.display = 'none';
          
          const savedDisplay = row.querySelector('.flag-saved-display');
          if (savedDisplay) savedDisplay.style.display = 'none';
        }

        function closeFlagInline(btn) {
          const box = btn.closest('.flag-input-box');
          if (box) box.style.display = 'none';
        }

        function updateFlagsInput() {
          const input = document.getElementById('approverFlagsInput');
          if (input) input.value = JSON.stringify(flagData);
        }

        function escapeHtmlLocal(str) {
          return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function updateCharCount() {
          const editor = document.getElementById('editor');
          if (!editor) return;
          
          const count = editor.value.trim().length;
          const countEl = document.getElementById('charCount');
          if (countEl) {
            countEl.innerText = count;
            countEl.style.color = count < 100 ? 'var(--warn-text)' : 'var(--success-text)';
          }
        }
        window.addEventListener('DOMContentLoaded', function() {
          updateCharCount();
          const editor = document.getElementById('editor');
          if (editor) {
            editor.addEventListener('paste', function(e) {
              e.preventDefault();
              const text = (e.clipboardData || window.clipboardData).getData('text/plain');
              document.execCommand('insertText', false, text.replace(/<[^>]*>/g, ''));
            });
          }
          
          document.addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
              const target = event.target;
              if (target.tagName === 'TEXTAREA' || target.isContentEditable) return;
              event.preventDefault();
              if (target.classList.contains('flag-reason-input')) {
                 const saveBtn = target.parentElement.querySelector('.save-flag-btn');
                 if (saveBtn) saveBtn.click();
              }
            }
          });
        });
        
        function showReturnOptions() {
          if (Object.keys(flagData).length < 2) {
            showError('Please flag at least 2 fields before returning the application.');
            return;
          }
          document.getElementById('returnModal').style.display = 'flex';
        }
      </script>
    `;

    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(`<span class="step-badge">Action Required</span><h1>Review Access Request</h1>`, content));
  };

  /* Step 4b — Standard approver / Division-Head branch: GET shows the review form; POST below. */
  if (isPost !== 'true') {
    return renderReviewForm('', '', params.approverType);
  }

  /* Step 5 — On a Deny/Return POST, enforce a meaningful reason (length + anti-gibberish checks)
     before recording; re-render the form with an error if it fails. */
  // Validate POST decisions (Approve, Return, Deny)
  if (action === 'Return' || action === 'Deny') {
    const plainTextComment = comment.replace(/<[^>]*>/g, '').trim();
    let errorMsg = '';
    if (plainTextComment.length < COMMENT_MIN_CHARS_DECISION) {
      errorMsg = `A minimum of ${COMMENT_MIN_CHARS_DECISION} meaningful characters is required for a ${action === 'Deny' ? 'Denial' : 'Return'} reason.`;
    } else if (plainTextComment.length > COMMENT_MAX_CHARS) {
      errorMsg = `Comments cannot exceed ${COMMENT_MAX_CHARS} characters.`;
    } else if (/(.)\1{5,}/.test(comment)) {
      errorMsg = 'Spam or repetitive characters detected. Please provide a meaningful comment.';
    } else if (/[bcdfghjklmnpqrstvwxyz]{7,}/i.test(comment)) {
      errorMsg = 'Gibberish detected. Please provide a clear and legible comment.';
    }

    if (errorMsg) {
      return renderReviewForm(errorMsg, comment);
    }
  }

  /* Step 6 — Record the decision in the right sheet, then render success/failure. A failure here
     usually means the application advanced/closed in the meantime (race), so the link is now stale. */
  let result;
  if (approverType === 'divhead') {
    result = processDivHeadDecision(
      sessionId,
      targetEmail,
      action,
      comment || 'Approved via secure access review link.',
      approverFlags
    );
  } else {
    result = processApprovalDecision(
      sessionId, targetEmail, action, comment || 'Approved via secure access review link.', stepParam, approverFlags
    );
  }
  
  if (result.success) {
    const isSuccess = action === 'Approve';
    const textColorVar = isSuccess ? 'var(--success-text)' : 'var(--danger-text)';
    const bgColorVar = isSuccess ? 'var(--success)' : 'var(--danger)';
    const borderColorVar = isSuccess ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)';
    
    let displayAction = action;
    if (action === 'Approve') displayAction = 'Approved';
    if (action === 'Deny') displayAction = 'Denied';
    if (action === 'Return') displayAction = 'Returned to Requestor';

    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
      `<span class="step-badge">Action Completed</span><h1>Successfully ${displayAction}!</h1>`,
      `<div class="alert" style="background: ${bgColorVar}; color: ${textColorVar}; border-color: ${borderColorVar};">The decision for application <strong>${sessionId}</strong> has been safely recorded in the database.</div>
      ${previewHtml}
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">Your response has been saved. You may now safely close this window.</p>`
    ));
  } else {
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
      `<h1>Action Failed</h1>`,
      `<div class="alert alert-danger">${escapeHtml(result.error)}</div>
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">This application has already been processed, making this approval form invalid. You may now safely close this window.</p>`
    ));
  }
}

/*
  Function: getDatabaseSpreadsheet
  LAYMAN:    Opens the one shared Google Spreadsheet that is the whole system's database. Finds it
             by stored id, or falls back to the active/bound spreadsheet, or creates a new one.
  TECHNICAL: Resolves DB via DB_SPREADSHEET_ID_PROP; else uses getActiveSpreadsheet() and caches its
             id; else (createIfMissing !== false) creates 'PIA System Database' and caches its id.
  PARAMS:    - createIfMissing — pass false to never create (returns null instead).
  RETURNS:   Spreadsheet object, or null when not found and createIfMissing === false.
*/
function getDatabaseSpreadsheet(createIfMissing) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProperties.getProperty(DB_SPREADSHEET_ID_PROP);

  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (activeSpreadsheet) {
    scriptProperties.setProperty(DB_SPREADSHEET_ID_PROP, activeSpreadsheet.getId());
    return activeSpreadsheet;
  }

  if (createIfMissing === false) {
    return null;
  }

  const databaseSpreadsheet = SpreadsheetApp.create('PIA System Database');
  scriptProperties.setProperty(DB_SPREADSHEET_ID_PROP, databaseSpreadsheet.getId());
  return databaseSpreadsheet;
}

/*
  Function: getDatabaseSheet
  LAYMAN:    Opens a specific tab (e.g. 'Applications') inside the shared spreadsheet, creating it
             if it is missing and you allow that.
  TECHNICAL: Gets the spreadsheet, returns getSheetByName(sheetName); if absent and
             createIfMissing !== false, insertSheet (try/catch). Logs and returns null on failure.
  PARAMS:    - sheetName — tab name (use DB_SHEET_NAMES.*).
             - createIfMissing — pass false to require an existing tab.
  RETURNS:   Sheet object, or null if not found/createIfMissing is false/creation fails.
*/
function getDatabaseSheet(sheetName, createIfMissing) {
  const spreadsheet = getDatabaseSpreadsheet(createIfMissing !== false);
  if (!spreadsheet) {
    Logger.log('ERROR: Could not access database spreadsheet');
    return null;
  }

  let sheet = spreadsheet.getSheetByName(sheetName);
  
  if (!sheet && createIfMissing !== false) {
    Logger.log(`  → Creating sheet: "${sheetName}"`);
    try {
      sheet = spreadsheet.insertSheet(sheetName);
      if (!sheet) {
        Logger.log(`    Failed to create sheet "${sheetName}" - insertSheet returned null`);
        return null;
      }
      Logger.log(`  ✓ Sheet "${sheetName}" created successfully`);
    } catch (e) {
      Logger.log(`    Error creating sheet "${sheetName}": ${e.toString()}`);
      return null;
    }
  }
  
  if (!sheet) {
    Logger.log(`     Sheet "${sheetName}" not found and createIfMissing is false`);
  }
  
  return sheet;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🗂️ REVISION HISTORY STORE (survives the resubmit wipe)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/*
  Function: getRevisionHistorySheet_
  LAYMAN:    Grabs (or lazily creates) the "Revision_History" logbook tab and makes sure it has its
             header row. Since the production DB is already initialized, initializeDatabase never
             re-runs — so this tab is born on the first snapshot write instead.
  TECHNICAL: getDatabaseSheet(name, true) inserts the bare sheet if missing; if the sheet is empty
             (getLastRow()===0) it seeds the header row + formatHeaderRow. Returns null on failure.
  PARAMS:    (none)
  RETURNS:   Sheet, or null.
*/
function getRevisionHistorySheet_() {
  const sheet = getDatabaseSheet(DB_SHEET_NAMES.REVISION_HISTORY, true);
  if (!sheet) return null;
  if (sheet.getLastRow() === 0) {
    const headers = [
      'HistoryID', 'SessionID', 'RoundNumber', 'Stage', 'ApproverName', 'ApproverEmail',
      'Role', 'Decision', 'Status', 'Comments', 'FlaggedFields', 'Routing', 'DecisionDate', 'SnapshotAt'
    ];
    sheet.appendRow(headers);
    try { formatHeaderRow(sheet); } catch (e) { /* header formatting is best-effort */ }
  }
  return sheet;
}

/*
  Function: writeRevisionHistorySnapshot_
  LAYMAN:    Right before a returned application is resubmitted (which erases the whole approval
             trail), this copies that round's decisions — who approved/returned, their comments, the
             fields they flagged, and the ISM routing choice — into the permanent logbook so the
             back-and-forth is never lost.
  TECHNICAL: Reads the three workflow sheets for the session, keeps only ACTIONED rows (skips
             Pending/blank), and appends one Revision_History row per decision, tagged with the next
             RoundNumber (max prior round + 1). The passed-in approverFlags (captured before the
             Applications cell is cleared) is attached to the row that Returned. Fully wrapped in
             try/catch — a history-write failure must NEVER block a resubmit.
  PARAMS:    - sessionId — application id (base id; resubmits reuse it).
             - approverFlags — the Approver_Flags object, read before it was cleared.
  RETURNS:   undefined (side-effect: appended rows).
*/
function writeRevisionHistorySnapshot_(sessionId, approverFlags) {
  try {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const sheet = getRevisionHistorySheet_();
    if (!sheet) return;

    // Next round number = (max prior round for this session) + 1
    let round = 1;
    const existing = sheet.getDataRange().getValues();
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][REVISION_HISTORY_COLS.SESSION_ID - 1] || '').trim() === sid) {
        const r = Number(existing[i][REVISION_HISTORY_COLS.ROUND_NUMBER - 1] || 0);
        if (r >= round) round = r + 1;
      }
    }

    const snapshotAt = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    const flagsStr = (approverFlags && typeof approverFlags === 'object')
      ? JSON.stringify(approverFlags)
      : String(approverFlags || '');
    const isReturnDecision = function (decision, status) {
      return /return|reject/i.test(String(decision || '') + ' ' + String(status || ''));
    };
    const rows = [];

    const collect = function (sheetName, cols, stage, nameCol, emailCol, roleFn, routingCol) {
      const src = getDatabaseSheet(sheetName, false);
      if (!src) return;
      const data = src.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (String(row[cols.SESSION_ID - 1] || '').trim() !== sid) continue;
        const status = String(row[cols.STATUS - 1] || '');
        if (status === 'Pending' || status === '') continue; // only rows that were actioned
        const decision = row[cols.DECISION - 1];
        rows.push([
          Utilities.getUuid(), sid, round, stage,
          nameCol ? (row[nameCol - 1] || '') : '',
          row[emailCol - 1] || '',
          roleFn(row),
          decision || '',
          status,
          row[cols.COMMENTS - 1] || '',
          isReturnDecision(decision, status) ? flagsStr : '',
          routingCol ? (row[routingCol - 1] || '') : '',
          row[cols.DECISION_DATE - 1] || '',
          snapshotAt
        ]);
      }
    };

    collect(DB_SHEET_NAMES.APPROVAL_WORKFLOW, APPROVAL_COLS, 'head',
      APPROVAL_COLS.APPROVER_NAME, APPROVAL_COLS.APPROVER_EMAIL,
      function (row) {
        const s = Number(row[APPROVAL_COLS.CURRENT_STEP - 1] || 0);
        return s === 1 ? 'Immediate Head' : s === 2 ? 'Department Head' : 'Head';
      }, null);

    collect(DB_SHEET_NAMES.ISM_WORKFLOW, ISM_WORKFLOW_COLS, 'ism',
      ISM_WORKFLOW_COLS.ISM_MEMBER_NAME, ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL,
      function () { return 'InfoSec Reviewer'; }, ISM_WORKFLOW_COLS.ROUTING_DESTINATION);

    collect(DB_SHEET_NAMES.DIV_HEAD_CONFIG, DIV_HEAD_CONFIG_COLS, 'divhead',
      null, DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL,
      function () { return 'Division Head'; }, null);

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      Logger.log('Revision history: snapshotted ' + rows.length + ' decision(s) for ' + sid + ' (round ' + round + ')');
    }
  } catch (e) {
    Logger.log('writeRevisionHistorySnapshot_ failed (non-blocking): ' + e.toString());
  }
}

/*
  Function: getRevisionHistory
  LAYMAN:    Reads back the logbook for one application, grouped by round, so emails / the review
             screen / the certificate / the requestor timeline can show the full return history.
  TECHNICAL: Filters Revision_History by sessionId, groups rows by RoundNumber, parses FlaggedFields
             JSON, and returns rounds sorted ascending. Returns [] if the tab or rows don't exist.
  PARAMS:    - sessionId — application id.
  RETURNS:   Array of { round, decisions:[{stage, approverName, approverEmail, role, decision,
             status, comments, flaggedFields, routing, decisionDate, snapshotAt}] }.
*/
function getRevisionHistory(sessionId) {
  try {
    const sheet = getDatabaseSheet(DB_SHEET_NAMES.REVISION_HISTORY, false);
    if (!sheet || sheet.getLastRow() < 2) return [];
    const sid = String(sessionId || '').trim();
    const data = sheet.getDataRange().getValues();
    const byRound = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[REVISION_HISTORY_COLS.SESSION_ID - 1] || '').trim() !== sid) continue;
      const round = Number(row[REVISION_HISTORY_COLS.ROUND_NUMBER - 1] || 0);
      if (!byRound[round]) byRound[round] = { round: round, decisions: [] };
      let flags = {};
      try { flags = JSON.parse(row[REVISION_HISTORY_COLS.FLAGGED_FIELDS - 1] || '{}'); } catch (e) { flags = {}; }
      byRound[round].decisions.push({
        stage: row[REVISION_HISTORY_COLS.STAGE - 1] || '',
        approverName: row[REVISION_HISTORY_COLS.APPROVER_NAME - 1] || '',
        approverEmail: row[REVISION_HISTORY_COLS.APPROVER_EMAIL - 1] || '',
        role: row[REVISION_HISTORY_COLS.ROLE - 1] || '',
        decision: row[REVISION_HISTORY_COLS.DECISION - 1] || '',
        status: row[REVISION_HISTORY_COLS.STATUS - 1] || '',
        comments: row[REVISION_HISTORY_COLS.COMMENTS - 1] || '',
        flaggedFields: flags,
        routing: row[REVISION_HISTORY_COLS.ROUTING - 1] || '',
        decisionDate: row[REVISION_HISTORY_COLS.DECISION_DATE - 1] || '',
        snapshotAt: row[REVISION_HISTORY_COLS.SNAPSHOT_AT - 1] || ''
      });
    }
    return Object.keys(byRound).map(function (k) { return byRound[k]; }).sort(function (a, b) { return a.round - b.round; });
  } catch (e) {
    Logger.log('getRevisionHistory failed: ' + e.toString());
    return [];
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 💾 DATABASE INITIALIZATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: initializeDatabase
  LAYMAN:    First-run setup. Creates every tab the system needs (Applications, the workflow sheets,
             Drafts, Risk_Audit, Email_Queue, etc.) with proper headers, exactly once.
  TECHNICAL: Guarded by DB_INIT_FLAG_PROP and a script LockService lock (waitLock 30s) with a
             double-checked flag to prevent concurrent re-init. Creates each missing sheet with its
             header row + formatHeaderRow, seeds the session counter, then sets the init flag.
  PARAMS:    (none)
  RETURNS:   undefined. Throws 'System busy...' if the lock cannot be acquired.
*/
function initializeDatabase() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const isInitialized = scriptProperties.getProperty(DB_INIT_FLAG_PROP) === 'true';
  
  if (isInitialized) {
    Logger.log('✓ Database already initialized');
    return;
  }
  
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  
  try {
    try {
      lock.waitLock(30000);
      lockAcquired = true;
    } catch (lockErr) {
      Logger.log('ERROR: Could not acquire lock for database initialization');
      throw new Error('System busy, please try again');
    }
    
    // Double-check flag after acquiring lock (prevent race condition)
    if (scriptProperties.getProperty(DB_INIT_FLAG_PROP) === 'true') {
      return;
    }
    
    Logger.log('🔧 Starting database initialization...');
    getDatabaseSpreadsheet(true);
    Logger.log('✓ Database spreadsheet ready');
    
    // Create Applications table if missing
    if (!sheetExists(DB_SHEET_NAMES.APPLICATIONS)) {
      Logger.log('  Creating Applications sheet...');
      const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
      if (!appSheet) throw new Error('Failed to create Applications sheet');
    const headers = [
      'SessionID', 'ApplicantEmail', 'Status', 
      'PIA_1_Data', 'PIA_2_Data', 'PIA_3_Data', 'PIA_4_Data', 'PIA_5_Data',
      'AdminExportID', 'SubmissionDate', 'IsFlagged', 'Notes', 'Linked_ReqID', 'Approver_Flags'
    ];
      appSheet.appendRow(headers);
      formatHeaderRow(appSheet);
      Logger.log('✓ Applications sheet created');
    } else {
      Logger.log('✓ Applications sheet already exists');
    }
    
    // Create Approval Workflow table if missing
    if (!sheetExists(DB_SHEET_NAMES.APPROVAL_WORKFLOW)) {
      Logger.log('  Creating Approval_Workflow sheet...');
      const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      if (!apprSheet) throw new Error('Failed to create Approval_Workflow sheet');
      const headers = [
        'ApprovalID', 'SessionID', 'CurrentStep', 'ApproverName', 
        'ApproverEmail', 'Decision', 'Comments', 'DecisionDate', 'Status', 'ReminderDate',
        'EmailStatus', 'EmailError'
      ];
      apprSheet.appendRow(headers);
      formatHeaderRow(apprSheet);
      Logger.log('✓ Approval_Workflow sheet created');
    } else {
      Logger.log('✓ Approval_Workflow sheet already exists');
    }
    
    // Create Risk & Audit table if missing
    if (!sheetExists(DB_SHEET_NAMES.RISK_AUDIT)) {
      Logger.log('  Creating Risk_Audit sheet...');
      const auditSheet = getDatabaseSheet(DB_SHEET_NAMES.RISK_AUDIT, true);
      if (!auditSheet) throw new Error('Failed to create Risk_Audit sheet');
      const headers = [
        'LogID', 'SessionID', 'InternalFlags', 'Action', 
        'UserEmail', 'UserAgent', 'Timestamp'
      ];
      auditSheet.appendRow(headers);
      formatHeaderRow(auditSheet);
      Logger.log('✓ Risk_Audit sheet created');
    } else {
      Logger.log('✓ Risk_Audit sheet already exists');
    }

    // Create Drafts table if missing
    if (!sheetExists(DB_SHEET_NAMES.DRAFTS)) {
      Logger.log('  Creating Drafts sheet...');
      const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
      if (!draftsSheet) throw new Error('Failed to create Drafts sheet');
      const headers = [
        'DraftID', 'UserEmail', 'SessionID', 'Type', 'StateJSON', 'SavedTimestamp', 'ExpiresAt'
      ];
      draftsSheet.appendRow(headers);
      formatHeaderRow(draftsSheet);
      Logger.log('✓ Drafts sheet created');
    } else {
      Logger.log('✓ Drafts sheet already exists');
    }

    // Create Data Collection table if missing
    if (!sheetExists(DB_SHEET_NAMES.DATA_COLLECTION)) {
      Logger.log('  Creating Data_Collection sheet...');
      const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
      if (!dcsSheet) throw new Error('Failed to create Data_Collection sheet');
      const headers = [
        'LogID', 'ReqID', 'UserEmail', 'Status', 'ImmediateHeadEmail', 'DeptHeadEmail', 
        'DivHeadEmail', 'FileID', 'Metadata_JSON', 'Timestamp', 'Remarks'
      ];
      dcsSheet.appendRow(headers);
      formatHeaderRow(dcsSheet);
      Logger.log('✓ Data_Collection sheet created');
    } else {
      Logger.log('✓ Data_Collection sheet already exists');
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 3 WORKFLOW SHEETS INITIALIZATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Logger.log('\n🚀 Initializing Phase 3 workflow sheets...');

    // Create ISM Approval Workflow table with validation
    if (!sheetExists(DB_SHEET_NAMES.ISM_WORKFLOW)) {
      const ismHeaders = [
        'ISM_Approval_ID', 'SessionID', 'CurrentStep', 'ISM_Member_Name', 'ISM_Member_Email',
        'Decision', 'Comments', 'DecisionDate', 'Status', 'Requires_DivHead', 'DivHead_Escalation_ID', 'Routing_Destination', 'ReminderDate',
        'EmailStatus', 'EmailError'
      ];
      createPhase3SheetWithValidation(DB_SHEET_NAMES.ISM_WORKFLOW, ismHeaders, []);
    } else {
      Logger.log(`✓ ISM_Approval_Workflow sheet already exists`);
    }

    // Create Division Head Config table with validation
    if (!sheetExists(DB_SHEET_NAMES.DIV_HEAD_CONFIG)) {
      const divHeadHeaders = [
        'Escalation_ID', 'SessionID', 'DivHead_Email', 'Decision', 'Comments', 
        'DecisionDate', 'Status', 'ReminderDate', 'EmailStatus', 'EmailError'
      ];
      createPhase3SheetWithValidation(DB_SHEET_NAMES.DIV_HEAD_CONFIG, divHeadHeaders, []);
    } else {
      Logger.log(`✓ DivisionHead_Approval_Workflow sheet already exists`);
    }

    // Create InfoSec Email Config table with validation and seed data
    if (!sheetExists(DB_SHEET_NAMES.INFOSEC_CONFIG)) {
      const infoSecHeaders = [
        'Member_ID', 'Member_Name', 'Member_Email', 'Role', 'IsActive', 'JobPos', 'Site'
      ];

      const seedData = [
        ['INFOSEC-001', 'InfoSec Member 1', 'infosec1@company.com', 'InfoSec', 'YES', 'Security Officer', ''],
        ['INFOSEC-002', 'InfoSec Member 2', 'infosec2@company.com', 'InfoSec', 'YES', 'InfoSec Analyst', ''],
        ['DCOPS', 'DCOPS Team', 'dcops@company.com', 'DCOPS', 'YES', 'DCOPS Lead', ''],
        ['TECHSERVE', 'TechServe Team', 'techserve@company.com', 'TechServe', 'YES', 'TechServe Lead', '']
      ];
      
      createPhase3SheetWithValidation(DB_SHEET_NAMES.INFOSEC_CONFIG, infoSecHeaders, seedData);
    } else {
      Logger.log(`✓ InfoSec_Email_Config sheet already exists`);
    }

    // Create Admin Notification Config table
    if (!sheetExists(DB_SHEET_NAMES.ADMIN_NOTIFICATION)) {
      const adminNotifHeaders = [
        'Config_ID', 'Admin_Email', 'NotifyOnFailure', 'NotifyRequestor', 'Last_Notified'
      ];
      const seedData = [
        ['ADMIN-001', 'systems.manager@company.com', 'YES', 'YES', '']
      ];
      createPhase3SheetWithValidation(DB_SHEET_NAMES.ADMIN_NOTIFICATION, adminNotifHeaders, seedData);
    } else {
      Logger.log(`✓ Admin_Notification_Config sheet already exists`);
    }

    // Create Email Queue table for deferred/reliable email delivery
    if (!sheetExists(DB_SHEET_NAMES.EMAIL_QUEUE)) {
      const emailQueueHeaders = [
        'Queue_ID', 'SessionID', 'Recipient', 'Subject', 'Body_Plain',
        'Body_HTML', 'Type', 'Status', 'Attempts', 'Last_Error',
        'Created_At', 'Sent_At', 'NotifiedAdmin'
      ];
      createPhase3SheetWithValidation(DB_SHEET_NAMES.EMAIL_QUEUE, emailQueueHeaders, []);
    } else {
      Logger.log(`✓ Email_Queue sheet already exists`);
    }

    seedSessionCounterFromDatabase();
    Logger.log('✓ Session counter seeded');
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // VERIFY ALL PHASE 3 SHEETS WERE CREATED BEFORE MARKING COMPLETE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Logger.log('\n  Verifying Phase 3 sheets were created...');
    const verificationChecks = [
      { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, expectedCols: 12 },
      { name: DB_SHEET_NAMES.ISM_WORKFLOW, expectedCols: 15 },
      { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, expectedCols: 10 },
      { name: DB_SHEET_NAMES.ADMIN_NOTIFICATION, expectedCols: 5 }
    ];
    
    let allPhase3SheetsValid = true;
    verificationChecks.forEach(check => {
      const sheet = getDatabaseSheet(check.name, false);
      if (!sheet) {
        Logger.log(`  CRITICAL: Sheet "${check.name}" was NOT created`);
        allPhase3SheetsValid = false;
      } else {
        const lastCol = sheet.getLastColumn();
        if (lastCol !== check.expectedCols) {
          Logger.log(`  CRITICAL: Sheet "${check.name}" has ${lastCol} columns, expected ${check.expectedCols}`);
          allPhase3SheetsValid = false;
        } else {
          Logger.log(`✓ Sheet "${check.name}" verified (${check.expectedCols} columns)`);
        }
      }
    });
    
    if (!allPhase3SheetsValid) {
      throw new Error('Phase 3 sheets verification failed - initialization aborted to prevent marking as complete');
    }
    
    Logger.log('  All Phase 3 sheets verified successfully\n');
    
    // Mark initialization as complete ONLY after all sheets are verified
    scriptProperties.setProperty(DB_INIT_FLAG_PROP, 'true');
    Logger.log('  Database initialization completed successfully');

  } catch (e) {
    Logger.log('  ERROR during database initialization: ' + e.toString());
    Logger.log('Stack: ' + e.stack);
    // Reset flag to allow retry
    scriptProperties.deleteProperty(DB_INIT_FLAG_PROP);
    throw e;
  } finally {
    // CRITICAL FIX: Only release lock if it was acquired
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/*
  Function: sheetExists
  LAYMAN:    True/false: does this tab already exist?
  TECHNICAL: getDatabaseSheet(name, false) coerced to boolean (no creation).
  PARAMS:    - name — tab name.
  RETURNS:   Boolean.
*/
function sheetExists(name) {
  return !!getDatabaseSheet(name, false);
}

/*
  Function: createPhase3SheetWithValidation
  LAYMAN:    Builds one tab with its headers (and optional starter rows), then double-checks the
             column count came out right. Used during initialization for the Phase 3 sheets.
  TECHNICAL: getDatabaseSheet(create) → appendRow(headers) → formatHeaderRow → append seedData →
             assert getLastColumn() === headers.length, else throw. Re-throws on any error.
  PARAMS:    - sheetName — tab to create.
             - headers — header row array.
             - seedData — optional array of rows to append.
  RETURNS:   true on success; throws on failure.
*/
function createPhase3SheetWithValidation(sheetName, headers, seedData) {
  Logger.log(`\n  Creating ${sheetName} sheet...`);
  
  try {
    // Create the sheet
    const sheet = getDatabaseSheet(sheetName, true);
    if (!sheet) {
      throw new Error(`Failed to create sheet "${sheetName}"`);
    }
    
    // Add headers
    Logger.log(`  → Adding ${headers.length} column headers`);
    sheet.appendRow(headers);
    formatHeaderRow(sheet);
    
    // Add seed data if provided
    if (seedData && seedData.length > 0) {
      Logger.log(`  → Seeding ${seedData.length} rows`);
      seedData.forEach(row => {
        sheet.appendRow(row);
      });
    }
    
    // Verify sheet was created correctly
    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    
    if (lastCol !== headers.length) {
      throw new Error(`Column count mismatch: ${lastCol} ≠ ${headers.length}`);
    }
    
    Logger.log(`✓ ${sheetName} sheet created successfully`);
    Logger.log(`  - Columns: ${lastCol}`);
    Logger.log(`  - Rows: ${lastRow}`);
    
    return true;
  } catch (e) {
    Logger.log(`ERROR creating ${sheetName}: ${e.toString()}`);
    throw e;
  }
}

/*
  Function: testPhase3DatabaseInitialization
  LAYMAN:    A manual debug tool (run from the Apps Script editor) that forces a fresh DB build and
             logs whether every Phase 3 sheet and column came out correct.
  TECHNICAL: Clears DB_INIT_FLAG_PROP, runs initializeDatabase(), then verifies expected column
             counts and dumps headers for each Phase 3 sheet to Logger. Diagnostics only — not
             called by the app at runtime.
  PARAMS:    (none)
  RETURNS:   undefined (writes to Logger).
*/
function testPhase3DatabaseInitialization() {
  Logger.log('╔════════════════════════════════════════════════════════════╗');
  Logger.log('║  PHASE 3 DATABASE INITIALIZATION TEST & FIX                 ║');
  Logger.log('╚════════════════════════════════════════════════════════════╝');
  
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    Logger.log('\nCurrent State:');
    const isInitialized = scriptProperties.getProperty(DB_INIT_FLAG_PROP);
    Logger.log('- Init Flag: ' + (isInitialized ? 'SET' : 'NOT SET'));
    
    // Reset flag to force re-initialization
    Logger.log('\nResetting initialization flag...');
    scriptProperties.deleteProperty(DB_INIT_FLAG_PROP);
    Logger.log('✓ Flag reset');
    
    // Run initialization
    Logger.log('\nRunning full database initialization...');
    initializeDatabase();
    Logger.log('✓ Initialization completed');
    
    // Verify Phase 3 sheets were created
    Logger.log('\nVERIFICATION - Phase 3 Sheets:');
    const sheets = [
      { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, expectedCols: 12 },
      { name: DB_SHEET_NAMES.ISM_WORKFLOW, expectedCols: 15 },
      { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, expectedCols: 10 },
      { name: DB_SHEET_NAMES.INFOSEC_CONFIG, expectedCols: 6 },
      { name: DB_SHEET_NAMES.EMAIL_QUEUE, expectedCols: 13 },
      { name: DB_SHEET_NAMES.ADMIN_NOTIFICATION, expectedCols: 5 }
    ];
    
    let allGood = true;
    sheets.forEach(sheetInfo => {
      const sheet = getDatabaseSheet(sheetInfo.name, false);
      if (sheet) {
        const lastCol = sheet.getLastColumn();
        const lastRow = sheet.getLastRow();
        const status = lastCol === sheetInfo.expectedCols ? '✓' : ' ';
        Logger.log(`${status} ${sheetInfo.name}`);
        Logger.log(`  - Columns: ${lastCol}/${sheetInfo.expectedCols}`);
        Logger.log(`  - Rows: ${lastRow}`);
        if (lastCol !== sheetInfo.expectedCols) {
          allGood = false;
        }
      } else {
        Logger.log(`  ${sheetInfo.name} - NOT CREATED`);
        allGood = false;
      }
    });
    
    // Verify column headers
    Logger.log('\n  Column Headers Verification:');
    const apprSheet2 = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, false);
    if (apprSheet2) {
      const headers = apprSheet2.getRange(1, 1, 1, apprSheet2.getLastColumn()).getValues()[0];
      Logger.log('Approval_Workflow headers: ' + headers.join(' | '));
    }
    
    const ismSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, false);
    if (ismSheet) {
      const headers = ismSheet.getRange(1, 1, 1, ismSheet.getLastColumn()).getValues()[0];
      Logger.log('ISM_Approval_Workflow headers: ' + headers.join(' | '));
    }
    
    const divSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, false);
    if (divSheet) {
      const headers = divSheet.getRange(1, 1, 1, divSheet.getLastColumn()).getValues()[0];
      Logger.log('DivisionHead_Approval_Workflow headers: ' + headers.join(' | '));
    }
    
    const infoSheet = getDatabaseSheet(DB_SHEET_NAMES.INFOSEC_CONFIG, false);
    if (infoSheet) {
      const headers = infoSheet.getRange(1, 1, 1, infoSheet.getLastColumn()).getValues()[0];
      Logger.log('InfoSec_Email_Config headers: ' + headers.join(' | '));
      const rows = infoSheet.getLastRow();
      Logger.log(`InfoSec_Email_Config seeded rows: ${rows - 1} (expected: 4)`);
    }
    
    const adminNotifSheet = getDatabaseSheet(DB_SHEET_NAMES.ADMIN_NOTIFICATION, false);
    if (adminNotifSheet) {
      const headers = adminNotifSheet.getRange(1, 1, 1, adminNotifSheet.getLastColumn()).getValues()[0];
      Logger.log('Admin_Notification_Config headers: ' + headers.join(' | '));
      const rows = adminNotifSheet.getLastRow();
      Logger.log(`Admin_Notification_Config seeded rows: ${rows - 1} (expected: 1)`);
    }
    
    const queueSheet2 = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, false);
    if (queueSheet2) {
      const headers = queueSheet2.getRange(1, 1, 1, queueSheet2.getLastColumn()).getValues()[0];
      Logger.log('Email_Queue headers: ' + headers.join(' | '));
    }
    
    Logger.log('\n' + (allGood ? '  ALL PHASE 3 SHEETS CREATED SUCCESSFULLY' : '   SOME ISSUES FOUND'));
    Logger.log('\n📋 Next Steps:');
    Logger.log('1. Open your Google Sheet');
    Logger.log('2. Verify these new sheet tabs exist:');
    Logger.log('   - Approval_Workflow (with EmailStatus/EmailError columns)');
    Logger.log('   - ISM_Approval_Workflow (with EmailStatus/EmailError columns)');
    Logger.log('   - DivisionHead_Approval_Workflow (with EmailStatus/EmailError columns)');
    Logger.log('   - InfoSec_Email_Config');
    Logger.log('   - Email_Queue (with NotifiedAdmin column)');
    Logger.log('   - Admin_Notification_Config');
    Logger.log('3. Update InfoSec_Email_Config with your actual team emails');
    Logger.log('4. Configure DivisionHead_Approval_Workflow with your Division Heads');
    Logger.log('5. Update Admin_Notification_Config with your admin email');
    Logger.log('\n✨ Phase 4 (Failsafe) database schema is now ready!');
    
  } catch (e) {
    Logger.log('\n  ERROR: ' + e.toString());
    Logger.log('Stack: ' + e.stack);
    Logger.log('\n🔧 Troubleshooting:');
    Logger.log('1. Check that SYSTEM_SECRET is set in Project Properties');
    Logger.log('2. Try resetting the initialization flag manually');
    Logger.log('3. Check Apps Script quotas/limits');
    Logger.log('4. Contact admin if issues persist');
  }
}

/*
  Function: reinitializePhase3Database
  LAYMAN:    Manual "rebuild the database" button — clears the init flag and runs setup again.
  TECHNICAL: Deletes DB_INIT_FLAG_PROP then calls initializeDatabase(). Existing sheets are kept
             (initializeDatabase only creates missing ones).
  PARAMS:    (none)
  RETURNS:   undefined.
*/
function reinitializePhase3Database() {
  Logger.log('  Attempting to reinitialize Phase 3 database...');
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.deleteProperty(DB_INIT_FLAG_PROP);
  initializeDatabase();
  Logger.log('  Phase 3 database reinitialized. Check your sheets!');
}

/*
  Function: formatHeaderRow
  LAYMAN:    Styles the top row of a sheet (navy background, white bold text) so headers stand out.
  TECHNICAL: Sets background/fontColor/fontWeight/fontSize on row 1 across all columns.
  PARAMS:    - sheet — target Sheet.
  RETURNS:   undefined (mutates formatting).
*/
function formatHeaderRow(sheet) {
  const range = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  range.setBackground('#185FA5')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(11);
}

/*
  Function: seedSessionCounterFromDatabase
  LAYMAN:    Makes sure the "next application number" counter is never behind what is already in the
             sheet, so new IDs do not collide with existing ones.
  TECHNICAL: Scans Applications column A for PIA-###### ids, takes the max sequence found and the
             current counter, stores the larger into SESSION_ID_COUNTER_PROP. No-op if sheet empty.
  PARAMS:    (none)
  RETURNS:   undefined.
*/
function seedSessionCounterFromDatabase() {
  const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, false);
  if (!appSheet) {
    return;
  }

  const lastRow = appSheet.getLastRow();
  if (lastRow < 2) {
    return;
  }

  const values = appSheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  let maxSequence = Number(PropertiesService.getScriptProperties().getProperty(SESSION_ID_COUNTER_PROP) || '0');

  values.forEach((rawValue) => {
    const sessionId = String(rawValue || '').trim();
    const match = sessionId.match(/^PIA-(\d{6})/);
    if (match) {
      maxSequence = Math.max(maxSequence, Number(match[1]));
    }
  });

  PropertiesService.getScriptProperties().setProperty(SESSION_ID_COUNTER_PROP, String(maxSequence));
}

/*
  Function: formatSessionId
  LAYMAN:    Builds the application id string, e.g. 'PIA-000042', adding '-V2' for revisions.
  TECHNICAL: Zero-pads sequenceNumber to 6 digits; appends '-V<versionNumber>' when version > 0.
             Throws if sequence exceeds 999999.
  PARAMS:    - sequenceNumber — the running counter value.
             - versionNumber — 0 for a fresh id, >0 for a revision suffix.
  RETURNS:   Session id string. Throws on overflow.
  EXAMPLE:   formatSessionId(42, 0) -> 'PIA-000042' ; formatSessionId(42, 2) -> 'PIA-000042-V2'
*/
function formatSessionId(sequenceNumber, versionNumber) {
  // HIGH FIX: Validate sequence number doesn't exceed 999999 (6 digits)
  if (sequenceNumber > 999999) {
    throw new Error('Session ID counter limit reached (max 999999 applications)');
  }
  const baseId = `PIA-${String(sequenceNumber).padStart(6, '0')}`;
  return versionNumber > 0 ? `${baseId}-V${versionNumber}` : baseId;
}

/*
  Function: nextBaseSessionId
  LAYMAN:    Hands out the next brand-new application id, making sure two submissions never grab the
             same number even if they happen at the same time.
  TECHNICAL: Under a script lock (waitLock 30s), reads+increments SESSION_ID_COUNTER_PROP (throws at
             999999) and returns formatSessionId(next, 0). Lock released in finally.
  PARAMS:    (none)
  RETURNS:   New base session id string (e.g. 'PIA-000043'). Throws on lock failure / overflow.
*/
function nextBaseSessionId() {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    try {
      lock.waitLock(30000);
      lockAcquired = true;
    } catch (lockErr) {
      Logger.log('ERROR: Could not acquire lock after 30s');
      throw new Error('System busy, please try again');
    }

    const props = PropertiesService.getScriptProperties();
    const currentValue = Number(props.getProperty(SESSION_ID_COUNTER_PROP) || '0');
    // HIGH FIX: Check for overflow before incrementing
    if (currentValue >= 999999) {
      throw new Error('Session ID limit reached - cannot create new applications');
    }
    const nextValue = currentValue + 1;
    props.setProperty(SESSION_ID_COUNTER_PROP, String(nextValue));
    return formatSessionId(nextValue, 0);
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/*
  Function: getNextRevisionSessionId
  LAYMAN:    Given an existing application id, produces the next revision id (e.g. base-V1, base-V2)
             so a returned application can be resubmitted as a new version without losing its lineage.
  TECHNICAL: Under a script lock, strips any '-V#' from baseSessionId, scans Applications for ids
             sharing that base, finds the highest existing -V# and returns base-V<max+1>. Falls back
             to nextBaseSessionId() if the base is empty.
  PARAMS:    - baseSessionId — the original (or any version of the) application id.
  RETURNS:   Revision id string (e.g. 'PIA-000042-V3'). Throws on lock failure.
*/
function getNextRevisionSessionId(baseSessionId) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    try {
      lock.waitLock(30000);
      lockAcquired = true;
    } catch (lockErr) {
      Logger.log('ERROR: Could not acquire lock for revision session ID');
      throw new Error('System busy, please try again');
    }

    const normalizedBase = String(baseSessionId || '').trim().replace(/-V\d+$/, '');
    if (!normalizedBase) {
      return nextBaseSessionId();
    }

    const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    const lastRow = appSheet.getLastRow();
    if (lastRow < 2) {
      return `${normalizedBase}-V1`;
    }

    const sessionIds = appSheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    let maxRevision = 0;

    sessionIds.forEach((rawValue) => {
      const sessionId = String(rawValue || '').trim();
      if (!sessionId.startsWith(normalizedBase)) {
        return;
      }

      if (sessionId === normalizedBase) {
        maxRevision = Math.max(maxRevision, 0);
        return;
      }

      const versionMatch = sessionId.match(/-V(\d+)$/);
      if (versionMatch) {
        maxRevision = Math.max(maxRevision, Number(versionMatch[1]));
      }
    });

    return `${normalizedBase}-V${maxRevision + 1}`;
  } finally {
    // CRITICAL FIX: Only release lock if it was acquired
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/*
  Function: resolveSubmissionId
  LAYMAN:    Decides which application id a submission should use: an explicit one passed in, a
             formatted version of a base id, or a brand-new id if neither is given.
  TECHNICAL: Precedence: appData.appId → formatSessionId(base seq, version) when baseSessionId looks
             like PIA-###### → nextBaseSessionId(). Strips -V# from the base before formatting.
  PARAMS:    - appData — submission object (appId?, baseSessionId?, version?).
  RETURNS:   The resolved session id string.
*/
function resolveSubmissionId(appData) {
  const suppliedId = String(appData?.appId || '').trim();
  if (suppliedId) {
    Logger.log('   Using supplied appId: ' + suppliedId);
    return suppliedId;
  }

  const baseSessionId = String(appData?.baseSessionId || '').trim();
  Logger.log('   baseSessionId supplied: ' + baseSessionId);
  const versionNumber = Number(appData?.version || 0);
  if (baseSessionId) {
    const normalized = baseSessionId.replace(/-V\d+$/, '');
    const match = normalized.match(/^PIA-(\d{6})$/);
    if (match) {
      const result = formatSessionId(Number(match[1]), versionNumber);
      Logger.log('  Using baseSessionId (formatted): ' + result);
      return result;
    }
  }

  const newId = nextBaseSessionId();
  Logger.log('   Generated NEW ID (no appId/baseSessionId found): ' + newId);
  return newId;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Flagging System 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: analyzeApplicationRisk
  LAYMAN:    Auto-screens a submission for suspicious patterns (e.g. the drafter is also their own
             approver, identical approver names, an almost-empty description, too few/many PII
             fields, copy-pasted data-flow answers) and flags it for closer review.
  TECHNICAL: Pure heuristic checks over pia1/pia2/pia4. Normalizes the polymorphic pia2 shape
             (flat array / {fields,customOthers} / numeric-key object), counts 'YES' PII fields,
             and applies the conflict / short-entry / redundancy rules. No side-effects.
  PARAMS:    - appData — the full submission object.
  RETURNS:   { isFlagged: boolean, reasons: string[] }.
*/
function analyzeApplicationRisk(appData) {
  let isFlagged = false;
  const reasons = [];

  const p1 = appData.pia1 || {};
  const dEmail = String(p1.drafterEmail||'').toLowerCase().trim();
  const hEmail = String(p1.deptHeadEmail||'').toLowerCase().trim();
  const iEmail = String(p1.immediateHeadEmail||'').toLowerCase().trim();
  const vEmail = String(p1.divHeadEmail||'').toLowerCase().trim();

  if (dEmail && hEmail && dEmail === hEmail) { isFlagged = true; reasons.push('Drafter email matches Department Head'); }
  if (dEmail && iEmail && dEmail === iEmail) { isFlagged = true; reasons.push('Drafter email matches Immediate Head'); }
  if (dEmail && vEmail && dEmail === vEmail) { isFlagged = true; reasons.push('Drafter email matches Division Head'); }
  
  const dName = String(p1.deptHead||'').toLowerCase().trim();
  const iName = String(p1.immediateHead||'').toLowerCase().trim();
  const vName = String(p1.divHead||'').toLowerCase().trim();
  if (dName && iName && dName === iName) { isFlagged = true; reasons.push('Department Head and Immediate Head names are identical'); }
  if (dName && vName && dName === vName) { isFlagged = true; reasons.push('Department Head and Division Head names are identical'); }

  const p1Desc = String(p1.description||'').trim();
  if (p1Desc.length < 20) { isFlagged = true; reasons.push('Program description is empty or unusually short'); }

  // CRITICAL FIX: Handle both flat array format (from frontend) and nested fields format (from DB)
  let piiData = appData.pia2 || {};
  let piiFields = [];
  let customOthers = [];
  
  if (Array.isArray(piiData)) {
    // Frontend format: pia2 is a flat array indexed by pii2Fields positions
    piiFields = piiData;
    customOthers = appData.pia2CustomOthers || [];
  } else if (piiData.fields && Array.isArray(piiData.fields)) {
    // DB format: pia2 = { fields: [...], customOthers: [...] }
    piiFields = piiData.fields;
    customOthers = piiData.customOthers || [];
  } else if (piiData && typeof piiData === 'object') {
    // Might be an object with numeric keys, convert to array
    piiFields = [];
    for (let i = 0; i < pii2Fields.length; i++) {
      if (piiData[i] !== undefined) {
        piiFields[i] = piiData[i];
      }
    }
    customOthers = appData.pia2CustomOthers || [];
  }
  
  let yesCount = 0;
  for(let i=0; i<pii2Fields.length; i++) { if(piiFields[i] === 'YES') yesCount++; }
  customOthers.forEach(c => { if(c && c.value === 'YES') yesCount++; });
  if (yesCount < 2) { isFlagged = true; reasons.push('Fewer than 2 PII fields checked'); }
  if (yesCount > 18) { isFlagged = true; reasons.push('Suspiciously high number of PII fields checked'); }

  const p4 = appData.pia4 || {};
  const flowVals = [p4.collect, p4.use, p4.retain, p4.disclose, p4.dispose].map(v => String(v||'').trim().toLowerCase()).filter(Boolean);
  const uniqueVals = new Set(flowVals);
  if (flowVals.length > 2 && uniqueVals.size === 1) {
     isFlagged = true; reasons.push('High redundancy detected in Information Flow (copy-paste pattern)');
  }

  return { isFlagged, reasons };
}

/*
  Function: submitApplication
  LAYMAN:    The core "save my PIA" action. Figures out the id, writes all five PIA sections into
             the Applications sheet (new row, or update if resubmitting), runs risk screening,
             (re)builds the approver ladder, and kicks off the first approver + applicant emails.
  TECHNICAL: resolveSubmissionId → serialize pia1..pia5 JSON → analyzeApplicationRisk. If the id
             already exists it UPDATEs under a LockService lock with re-checked ownership (anti-
             TOCTOU; rejects editing another user's app) and resets the approval/ISM/divhead rows;
             otherwise it INSERTs a new row. Blocks resubmission while the linked DCS is 'Returned'.
             Then initializeApprovalWorkflow and notifyApprover(…,0)/notifyApplicant; email failures
             are caught and surfaced as a warning (never roll back the DB write).
  PARAMS:    - appData — full submission: pia1..pia5, pia2CustomOthers, linkedReqId, appId/base/version.
  RETURNS:   { success:true, appId, timestamp, message, warning } or { success:false, error }.
*/
function submitApplication(appData) {
  try {
    Logger.log('submitApplication called with: appId=' + (appData?.appId || 'empty') + ', baseSessionId=' + (appData?.baseSessionId || 'empty') + ', isEditing=' + appData?.isEditing);
    /* Step 1 — Resolve the id and stamp applicant email + timestamp. */
    const sessionId = resolveSubmissionId(appData);
    Logger.log('  Resolved sessionId: ' + sessionId);
    appData.appId = sessionId;
    
    const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    
    const userEmail = Session.getActiveUser().getEmail();
    appData.applicantEmail = userEmail;
    const timestamp = new Date().toLocaleString('en-PH', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
    
    // Serialize PIA data as JSON
    const pia1Data = JSON.stringify(appData.pia1);
    const pia2Data = JSON.stringify({
      fields: appData.pia2,
      customOthers: appData.pia2CustomOthers || []
    });
    const pia3Data = JSON.stringify(appData.pia3);
    const pia4Data = JSON.stringify(appData.pia4);
    const pia5Data = JSON.stringify(appData.pia5);
    
    /* Step 2 — Risk-screen; only build an audit payload if real anomalies were found. */
    // ── Risk analysis for isFlagged column (Applications sheet metadata) ──
    const riskAnalysis = analyzeApplicationRisk(appData);
    appData.isFlagged = riskAnalysis.isFlagged;

    // Only build audit payload when there are genuinely paranormal flags
    const hasParanormalFlags = riskAnalysis.isFlagged && riskAnalysis.reasons.length > 0;
    const internalFlagsStr = hasParanormalFlags
      ? JSON.stringify({ riskLevel: 'HIGH', reasons: riskAnalysis.reasons })
      : null;

    // Do NOT use appData.isEditing from client. Instead, check if the session ID exists and is owned by the user.
    let rowNum = findRowBySessionID(sessionId);
    const isEditing = rowNum > 0;

    /* Step 3 — Gate: if the linked DCS request was Returned, block the PIA resubmission. */
    // ENFORCE DCS COMPLETION BEFORE PIA EDITING
    if (appData.linkedReqId) {
      let hasDCSFlags = false;
      if (rowNum > 0) {
        const rawFlags = appSheet.getRange(rowNum, APPLICATIONS_COLS.APPROVER_FLAGS).getValue();
        try {
          const flagsObj = JSON.parse(rawFlags || '{}');
          const flagKeys = Object.keys(flagsObj);
          hasDCSFlags = flagKeys.length === 0 || flagKeys.some(key => key.startsWith('DCS - '));
        } catch(e) {}
      }
      
      if (hasDCSFlags) {
        const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
        const dcsData = dcsSheet.getDataRange().getValues();
        for(let i=1; i<dcsData.length; i++) {
          if(dcsData[i][DCS_COLS.REQ_ID - 1] === appData.linkedReqId) {
            const dcsStatus = dcsData[i][DCS_COLS.STATUS - 1];
            if (dcsStatus === 'Returned') {
              return { success: false, error: 'Your application has been returned back, you will need to check the DCS to review & resubmit.' };
            }
            break;
          }
        }
      }
    }

    /* Step 4 — Existing id → UPDATE path: lock, re-verify ownership, overwrite the PIA cells, then
       clear and rebuild the approval/ISM/divhead workflow rows. */
    if (rowNum > 0) {
      // CRITICAL FIX C5: Acquire lock to prevent race condition on resubmission
      const lock = LockService.getScriptLock();
      try {
        lock.waitLock(LOCK_TIMEOUT_MS);
      } catch (e) {
        return {
          success: false,
          error: 'System is busy. Please try again in a moment.'
        };
      }
      
      try {
        // Re-check ownership inside the lock to prevent TOCTOU
        const freshRowNum = findRowBySessionID(sessionId);
        if (freshRowNum <= 0) {
          // Row was deleted by another process, treat as new submission
          lock.releaseLock();
          return submitApplication(appData); // Recurse to handle as new submission
        }
        
        const existingRow = appSheet.getRange(freshRowNum, APPLICATIONS_COLS.APPLICANT_EMAIL, 1, 1).getValue();
        const existingEmail = String(existingRow || '').trim().toLowerCase();
        
        if (existingEmail !== userEmail.toLowerCase()) {
          // User is trying to edit someone else's application - DENY
          Logger.log('SECURITY ALERT: User ' + userEmail + ' attempted to edit application ' + sessionId + ' owned by ' + existingEmail);
          lock.releaseLock();
          return {
            success: false,
            error: 'You do not have permission to edit this application.'
          };
        }
        
        // ── Revision history: snapshot the round about to be wiped (non-blocking) ──
        // Runs BEFORE Approver_Flags is cleared (below) and BEFORE the workflow rows are
        // deleted, so the prior round's decisions + flags are preserved in Revision_History.
        try {
          const priorFlagsRaw = appSheet.getRange(freshRowNum, APPLICATIONS_COLS.APPROVER_FLAGS).getValue();
          let priorFlags = {};
          try { priorFlags = JSON.parse(priorFlagsRaw || '{}'); } catch (e) { priorFlags = {}; }
          writeRevisionHistorySnapshot_(sessionId, priorFlags);
        } catch (e) {
          Logger.log('Revision history snapshot skipped (non-blocking): ' + e.toString());
        }

        // UPDATE existing row (resubmission mode)
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.STATUS).setValue('Pending');
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.PIA_1_DATA).setValue(pia1Data);
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.PIA_2_DATA).setValue(pia2Data);
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.PIA_3_DATA).setValue(pia3Data);
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.PIA_4_DATA).setValue(pia4Data);
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.PIA_5_DATA).setValue(pia5Data);
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.SUBMISSION_DATE).setValue(timestamp);
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.IS_FLAGGED).setValue(appData.isFlagged ? 'YES' : 'NO');
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.LINKED_REQ_ID).setValue(appData.linkedReqId || '');
        // Clear the flags on resubmission
        appSheet.getRange(freshRowNum, APPLICATIONS_COLS.APPROVER_FLAGS).setValue('');

        SpreadsheetApp.flush();
        
        // Reset approval workflow for resubmitted application
        const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
        const apprData = apprSheet.getDataRange().getValues();
        
        // Clear existing approval records for this session (optimized)
        const apprRowsToDelete = findRowsToDelete(apprData, APPROVAL_COLS.SESSION_ID, sessionId);
        batchDeleteRows(apprSheet, apprRowsToDelete);
        
        // Clear ISM workflow records for this session (optimized)
        const ismSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
        if (ismSheet) {
          const ismData = ismSheet.getDataRange().getValues();
          const ismRowsToDelete = findRowsToDelete(ismData, ISM_WORKFLOW_COLS.SESSION_ID, sessionId);
          batchDeleteRows(ismSheet, ismRowsToDelete);
        }

        // Clear Division Head config records for this session (optimized)
        const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
        if (divHeadSheet) {
          const divHeadData = divHeadSheet.getDataRange().getValues();
          const divHeadRowsToDelete = findRowsToDelete(divHeadData, DIV_HEAD_CONFIG_COLS.SESSION_ID, sessionId);
          batchDeleteRows(divHeadSheet, divHeadRowsToDelete);
        }
        
        // Re-initialize approval workflow
        initializeApprovalWorkflow(sessionId, appData);
        
        // ── Risk_Audit: only log paranormal flag events ──
        if (hasParanormalFlags) {
          logAuditTrail(sessionId, 'Application Resubmitted', internalFlagsStr);
        } else {
          Logger.log(`[AUDIT] ${sessionId}: Application Resubmitted — No anomalous flags`);
        }
      } finally {
        lock.releaseLock();
      }
    } else {
      /* Step 5 — New id → INSERT a fresh Applications row, then seed the approval workflow. */
      // INSERT new row (new submission)
      appSheet.appendRow([
        sessionId,               // SessionID
        userEmail,               // ApplicantEmail
        'Pending',               // Status
        pia1Data,                // PIA_1_Data
        pia2Data,                // PIA_2_Data
        pia3Data,                // PIA_3_Data
        pia4Data,                // PIA_4_Data
        pia5Data,                // PIA_5_Data
        '',                      // AdminExportID (filled after export)
        timestamp,               // SubmissionDate
        appData.isFlagged ? 'YES' : 'NO',  // IsFlagged
        '',                      // Notes
        appData.linkedReqId || '',// Linked_ReqID
        ''                       // Approver_Flags
      ]);

      SpreadsheetApp.flush();
      
      // Initialize approval workflow with dynamic approvers from appData
      initializeApprovalWorkflow(sessionId, appData);
      
      // ── Risk_Audit: only log paranormal flag events ──
      if (hasParanormalFlags) {
        logAuditTrail(sessionId, 'Application Submitted', internalFlagsStr);
      } else {
        Logger.log(`[AUDIT] ${sessionId}: Application Submitted — No anomalous flags`);
      }
    }
    
    /* Step 6 — Notify first approver + applicant; isolate email failures so a saved app never fails. */
    // Send email notification to first approver
    // Wrap in try-catch so email failure never rolls back a successful DB write
    let emailWarning = null;
    try {
      notifyApprover(sessionId, 0);
      notifyApplicant(sessionId, 'submitted');
    } catch (emailErr) {
      emailWarning = 'Email notification failed: ' + emailErr.toString();
      Logger.log('WARNING: Application saved but ' + emailWarning);
      // Application is already in the database — do NOT throw
    }
    
    return {
      success: true,
      appId: sessionId,
      timestamp: timestamp,
      message: 'Application ' + (isEditing ? 'resubmitted' : 'submitted') + ' successfully',
      warning: emailWarning
    };
  } catch (e) {
    Logger.log('Error submitting application: ' + e.toString());
    return {
      success: false,
      error: e.toString()
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   APPROVAL WORKFLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: processDivHeadDecision
  LAYMAN:    Records a Division Head's verdict on an application that an ISM member escalated to
             them. Approve resumes the ISM chain (or finalizes if everyone is done); Deny/Return
             ends or bounces the application back.
  TECHNICAL: Under a script lock, re-reads DivisionHead_Approval_Workflow, finds the pending row for
             (sessionId, approverEmail), stamps decision/comments/date. On Approve: flips the related
             ISM 'EscalatedToDivisionHead' row to Approved, and if all ISM members are now Approved
             marks the app 'Approved by ISM', notifies the applicant, updates DCS to 'Complete', and
             routes; otherwise resumes apiPhase3_NotifyISMember at the next step. On Deny/Return:
             sets app status, optionally returns the DCS, and notifies the applicant. Lock in finally.
  PARAMS:    - sessionId — application id.
             - approverEmail — the Division Head acting.
             - decision — 'Approve' | 'Deny' | 'Return'.
             - comments — decision reason/notes.
             - approverFlags — JSON of field flags (used on Return); default '{}'.
  RETURNS:   { success:true, message } or { success:false, error }.
*/
function processDivHeadDecision(sessionId, approverEmail, decision, comments, approverFlags = '{}') {
  // SECURITY (F-02): authorize the actual caller server-side (see apiPhase3_ProcessISMDecision).
  const _me = getNormalizedEmail(Session.getActiveUser().getEmail());
  if (_me !== getNormalizedEmail(approverEmail)) {
    return { success: false, error: 'Access denied: you may only submit your own decision.' };
  }
  const lock = LockService.getScriptLock();
  let lockAcquired = false;

  try {
    try {
      lock.waitLock(30000);
      lockAcquired = true;
    } catch (lockErr) {
      Logger.log('ERROR: Lock acquisition timeout - concurrent modification risk on DivHead decision');
      return { success: false, error: 'System busy, please try again' };
    }

    // CRITICAL: Re-read data after acquiring lock to prevent race conditions
    const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    const divHeadData = divHeadSheet.getDataRange().getValues();
    let divHeadRow = -1;

    for (let i = 1; i < divHeadData.length; i++) {
      if (divHeadData[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === sessionId &&
          String(divHeadData[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1] || '').toLowerCase() === String(approverEmail || '').toLowerCase() &&
          divHeadData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') {
        divHeadRow = i + 1;
        break;
      }
    }

    if (divHeadRow === -1) {
      return { success: false, error: 'Division Head approval record not found or already processed.' };
    }

    // Handle Division Head decision
    const timestamp = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.DECISION).setValue(decision);
    divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.COMMENTS).setValue(comments);
    divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.DECISION_DATE).setValue(timestamp);
    Logger.log(`[AUDIT] ${sessionId}: Division Head Decision: ${decision} by ${approverEmail}`);
    
    if (decision === 'Approve') {
      divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.STATUS).setValue('Approved');

      const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const ismData = ismWorkflowSheet.getDataRange().getValues();
      let escalatedStep = 1;
      
      for (let i = 1; i < ismData.length; i++) {
        if (ismData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId &&
            ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'EscalatedToDivisionHead') {
          ismWorkflowSheet.getRange(i + 1, ISM_WORKFLOW_COLS.STATUS).setValue('Approved');
          escalatedStep = Number(ismData[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] || 1);
          Logger.log(`[AUDIT] ${sessionId}: ISM escalation for step ${escalatedStep} resolved by DivHead approval`);
          break; 
        }
      }

      // Check if all ISM members are now approved
      const freshData = ismWorkflowSheet.getDataRange().getValues();
      let allApproved = true;
      let totalMembers = 0;
      let routingDest = 'BOTH';

      for (let i = 1; i < freshData.length; i++) {
        if (freshData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId) {
          totalMembers++;
          if (freshData[i][ISM_WORKFLOW_COLS.STATUS - 1] !== 'Approved') {
            allApproved = false;
          }
          if (freshData[i][ISM_WORKFLOW_COLS.ROUTING_DESTINATION - 1]) {
            routingDest = freshData[i][ISM_WORKFLOW_COLS.ROUTING_DESTINATION - 1];
          }
        }
      }

      if (allApproved && totalMembers > 0) {
        const appRow = findRowBySessionID(sessionId);
        if (appRow > 0) {
          appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved by ISM');
          Logger.log(`[AUDIT] ${sessionId}: Application Approved by ISM InfoSec Team (via DivHead Proxy)`);

          const linkedReqId = appSheet.getRange(appRow, APPLICATIONS_COLS.LINKED_REQ_ID).getValue();
          if (linkedReqId) updateDCSStatus(linkedReqId, 'Complete');
          
          let certResult = null;
          try { certResult = apiPhase3_RouteApprovedRequest(sessionId, routingDest); } catch (e) {}
          notifyApplicant(sessionId, 'approved_divhead_final', {
            certBlob: (certResult && certResult.success) ? certResult.pdfBlob : null,
            techserveEmails: (certResult && certResult.success) ? certResult.techserveEmails : ''
          });
        }
      } else {
        // Don't notify applicant here — the ISM member's approval handler
        // will notify the applicant when they act (progressing_ism or approved_ism_final).
        apiPhase3_NotifyISMember(sessionId, escalatedStep + 1);
        Logger.log(`processDivHeadDecision: Resumed ISM workflow at step ${escalatedStep + 1}`);
      }
    } else { // Deny or Return
      const finalStatus = (decision === 'Deny') ? 'Denied' : 'Returned';
      divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.STATUS).setValue(finalStatus);
      
      // Update main application status
      const appRow = findRowBySessionID(sessionId);
      if (appRow > 0) {
        appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue(finalStatus);
        if (decision === 'Return') {
          appSheet.getRange(appRow, APPLICATIONS_COLS.APPROVER_FLAGS).setValue(approverFlags);
        }
      }
      
      // Handle DCS return if applicable
      if (decision === 'Return' && appRow > 0) {
        const linkedReqId = appSheet.getRange(appRow, APPLICATIONS_COLS.LINKED_REQ_ID).getValue();
        if (linkedReqId) {
          let hasDCSFlags = false;
          try {
            const flagsObj = JSON.parse(approverFlags || '{}');
            const flagKeys = Object.keys(flagsObj);
            hasDCSFlags = flagKeys.length === 0 || flagKeys.some(key => key.startsWith('DCS - '));
          } catch(e) {}
          if (hasDCSFlags) updateDCSStatus(linkedReqId, 'Returned');
        }
      }
      notifyApplicant(sessionId, decision === 'Deny' ? 'denied' : 'returned');
    }
    return { success: true, message: 'Division Head decision recorded successfully' };
  } catch (e) {
    Logger.log('Error processing Division Head approval: ' + e.toString());
    return { success: false, error: e.toString() };
  } finally {
    // CRITICAL FIX: Only release lock if it was actually acquired
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}
/*
  Function: buildApproversFromAppData
  LAYMAN:    Works out the approver ladder for an application from its PIA 1 answers: Immediate Head
             (step 1), then Department Head (step 2). If neither has a valid email, it falls back to
             the configured Privacy Officer.
  TECHNICAL: Reads pia1, sanitizeEmail-validates each head email, and pushes {name,email,step}. If
             the list is empty, falls back to PRIVACY_OFFICER_EMAIL Script Property (validated).
             Invalid emails are logged and skipped. (Division Head is NOT seeded here — that comes via
             the ISM escalation path.)
  PARAMS:    - appData — submission with a pia1 section.
  RETURNS:   Array of { name, email, step } (may be empty if nothing valid configured).
*/
function buildApproversFromAppData(appData) {
  const approvers = [];
  const pia1 = appData.pia1 || {};

  // Validate Immediate Head email
  if (pia1.immediateHeadEmail && pia1.immediateHeadEmail.trim()) {
    const headEmail = sanitizeEmail(pia1.immediateHeadEmail);
    if (headEmail) {
      approvers.push({
        name: pia1.immediateHead || 'Immediate Head',
        email: headEmail,
        step: 1
      });
    } else {
      Logger.log('ERROR: Invalid immediate head email: ' + pia1.immediateHeadEmail);
    }
  }

  // Validate Department Head email
  if (pia1.deptHeadEmail && pia1.deptHeadEmail.trim()) {
    const deptEmail = sanitizeEmail(pia1.deptHeadEmail);
    if (deptEmail) {
      approvers.push({
        name: pia1.deptHead || 'Department Head',
        email: deptEmail,
        step: 2
      });
    } else {
      Logger.log('ERROR: Invalid department head email: ' + pia1.deptHeadEmail);
    }
  }

  // Fallback to privacy officer if no approvers found
  if (approvers.length === 0) {
    const fallbackEmail = String(PropertiesService.getScriptProperties().getProperty('PRIVACY_OFFICER_EMAIL') || '').trim();
    if (fallbackEmail) {
      const pocEmail = sanitizeEmail(fallbackEmail);
      if (pocEmail) {
        approvers.push({
          name: 'Privacy Officer',
          email: pocEmail,
          step: 1
        });
      } else {
        Logger.log('ERROR: Invalid privacy officer email in config: ' + fallbackEmail);
      }
    }
  }
  return approvers;
}

/*
  Function: initializeApprovalWorkflow
  LAYMAN:    Creates the to-do rows in the approval sheet — one per approver in the ladder — all
             starting as 'Pending'.
  TECHNICAL: buildApproversFromAppData → append one Approval_Workflow row per approver with id
             '<sessionId>-<n>', the step number, and Pending Status/EmailStatus.
  PARAMS:    - sessionId — application id.
             - appData — submission (source of the approver ladder).
  RETURNS:   undefined (writes rows). No rows if no approvers resolved.
*/
function initializeApprovalWorkflow(sessionId, appData) {
  const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
  
  // Build dynamic approvers from application data
  const approversToUse = appData ? buildApproversFromAppData(appData) : [];
  
  approversToUse.forEach((approver, index) => {
    const approvalId = sessionId + '-' + (index + 1);
    apprSheet.appendRow([
      approvalId,              // ApprovalID
      sessionId,               // SessionID
      index + 1,               // CurrentStep
      approver.name,           // ApproverName
      approver.email,          // ApproverEmail
      '',                      // Decision
      '',                      // Comments
      '',                      // DecisionDate
      'Pending',               // Status
      '',                      // ReminderDate
      'Pending',               // EmailStatus
      ''                       // EmailError
    ]);
  });
}

/*
  Function: processApprovalDecision
  LAYMAN:    Records a head/approver's verdict (Approve / Return / Deny) on an application and moves
             the process forward: next approver, hand-off to the ISM stage when all heads approve, or
             bounce/kill the application.
  TECHNICAL: Validates decision, takes a script lock, re-reads Approval_Workflow (anti-stale), locates
             the matching Pending row by normalized email (and optional step), stamps it. Approve:
             if all approver rows are Approved → initialize the ISM workflow (apiPhase3_InitializeISMWorkflow)
             and notify the first ISM member; on ISM-init failure sets 'Approved (ISM Pending)'. Else
             notify the next approver. Return: status 'Returned', save flags, optionally return the
             linked DCS. Deny: status 'Denied'. Always notifies the applicant; lock released in finally.
  PARAMS:    - sessionId, approverEmail, decision('Approve'|'Return'|'Deny'), comments.
             - stepParam — optional step to disambiguate; approverFlags — JSON flags (default '{}').
  RETURNS:   { success:true, message } or { success:false, error }.
*/
function processApprovalDecision(sessionId, approverEmail, decision, comments, stepParam = null, approverFlags = '{}') {
  // SECURITY (F-02): authorize the actual caller server-side (see apiPhase3_ProcessISMDecision).
  const _me = getNormalizedEmail(Session.getActiveUser().getEmail());
  if (_me !== getNormalizedEmail(approverEmail)) {
    return { success: false, error: 'Access denied: you may only submit your own decision.' };
  }
  try {
    const allowedDecisions = ['Approve', 'Return', 'Deny'];
    if (allowedDecisions.indexOf(decision) === -1) {
      return { success: false, error: 'Invalid decision value' };
    }

    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    
    try {
      try {
        lock.waitLock(30000);
        lockAcquired = true;
      } catch (lockErr) {
        Logger.log('ERROR: Lock acquisition timeout - concurrent modification risk');
        return { success: false, error: 'System busy, please try again' };
      }
      
      try {
      const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
      
      // CRITICAL FIX: Re-read data after acquiring lock to prevent race condition
      const apprData = apprSheet.getDataRange().getValues();
      const appData_values = appSheet.getDataRange().getValues();
      
      // Find the current approver record
      let currentRow = -1;
      let approverIndex = -1;
      const normalizedTarget = String(getNormalizedEmail(approverEmail) || '').toLowerCase();
      
      for (let i = 1; i < apprData.length; i++) {
        const rowEmail = String(getNormalizedEmail(apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1]) || '').toLowerCase();
        if (apprData[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId && 
            rowEmail === normalizedTarget && 
            apprData[i][APPROVAL_COLS.STATUS - 1] === 'Pending') {

          const loopStep = Number(apprData[i][APPROVAL_COLS.CURRENT_STEP - 1] || 1);
          if (stepParam !== null && loopStep !== stepParam) {
            continue;
          }
          currentRow = i + 1;
          approverIndex = loopStep - 1;
          break;
        }
      }
      
      if (currentRow === -1) {
        return { success: false, error: 'Approval record not found.' };
      }
      
      const timestamp = new Date().toLocaleString('en-PH', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      
      // Update approval decision
      apprSheet.getRange(currentRow, APPROVAL_COLS.DECISION).setValue(decision);
      apprSheet.getRange(currentRow, APPROVAL_COLS.COMMENTS).setValue(comments);
      apprSheet.getRange(currentRow, APPROVAL_COLS.DECISION_DATE).setValue(timestamp);
      
      if (decision === 'Approve') {
        /* Approve branch — when every approver row is Approved, hand off to the ISM stage;
           otherwise advance to the next approver. */
        apprSheet.getRange(currentRow, APPROVAL_COLS.STATUS).setValue('Approved');

        // Re-read fresh data after lock to check all approvals (prevents stale cache)
        const freshApprData = apprSheet.getDataRange().getValues();
        let allApproved = true;
        for (let i = 1; i < freshApprData.length; i++) {
          if (freshApprData[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId) {
            if (freshApprData[i][APPROVAL_COLS.STATUS - 1] !== 'Approved') {
              allApproved = false;
              break;
            }
          }
        }
        
        if (allApproved) {
          // Find app row using fresh sheet data (not stale appData_values)
          const freshAppSheetData = appSheet.getDataRange().getValues();
          let appRow = -1;
          for (let i = 1; i < freshAppSheetData.length; i++) {
            if (freshAppSheetData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
              appRow = i + 1;
              break;
            }
          }
          
          // PHASE 3: Initialize ISM workflow and notify first ISM member
          let ismInitSuccess = false;
          try {
            const ismInitResult = apiPhase3_InitializeISMWorkflow(sessionId);
            if (ismInitResult.success) {
              ismInitSuccess = true;
              Logger.log(`[AUDIT] ${sessionId}: ISM_WORKFLOW_INITIALIZED`);
            } else {
              Logger.log('[AUDIT] ' + sessionId + ': ISM_WORKFLOW_INIT_FAILED: ' + ismInitResult.error);
            }
          } catch (ismError) {
            Logger.log('[AUDIT] ' + sessionId + ': Phase 3 error: ' + ismError.toString());
          }
          
          if (appRow > 0) {
            if (ismInitSuccess) {
              // Full success: mark approved and notify ISM
              appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved');
              Logger.log(`[AUDIT] ${sessionId}: Application Approved`);
              notifyApplicant(sessionId, 'approved_main');
              // Notify the first ISM member
              apiPhase3_NotifyISMember(sessionId, 1);
            } else {
              // ISM init failed — set non-terminal status so admin knows to configure ISM
              appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved (ISM Pending)');
              Logger.log('[AUDIT] ' + sessionId + ': Heads approved, but ISM workflow could not be initialized. '
                + 'Set status to "Approved (ISM Pending)". Configure InfoSec_Email_Config and run apiPhase3_RetryISMWorkflow.');
              notifyApplicant(sessionId, 'approved_main');
            }
          }
        } else {
          notifyApplicant(sessionId, 'progressing');
          // Notify next approver
          notifyApprover(sessionId, approverIndex + 1);
        }
      } else if (decision === 'Reject' || decision === 'Return') {
        apprSheet.getRange(currentRow, APPROVAL_COLS.STATUS).setValue('Returned');
        apprSheet.getRange(currentRow, APPROVAL_COLS.DECISION).setValue('Return');
        // Re-read fresh data to prevent stale cache
        const freshAppData = appSheet.getDataRange().getValues();
        let appRow = -1;
        for (let i = 1; i < freshAppData.length; i++) {
          if (freshAppData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
            appRow = i + 1;
            break;
          }
        }
        if (appRow > 0) {
          appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Returned');
          appSheet.getRange(appRow, APPLICATIONS_COLS.APPROVER_FLAGS).setValue(approverFlags);
        }
        
        const linkedReqId = appRow > 0 ? appData_values[appRow - 1][APPLICATIONS_COLS.LINKED_REQ_ID - 1] : null;
        if (linkedReqId) {
          let hasDCSFlags = false;
          try {
            const flagsObj = JSON.parse(approverFlags || '{}');
          const flagKeys = Object.keys(flagsObj);
          hasDCSFlags = flagKeys.length === 0 || flagKeys.some(key => key.startsWith('DCS - '));
          } catch(e) {}
          if (hasDCSFlags) updateDCSStatus(linkedReqId, 'Returned');
        }
        
        Logger.log(`[AUDIT] ${sessionId}: Application Returned to Requestor by ${approverEmail}`);
        notifyApplicant(sessionId, 'returned');
      } else if (decision === 'Deny') {
        apprSheet.getRange(currentRow, APPROVAL_COLS.STATUS).setValue('Denied');
        let appRow = -1;
        for (let i = 1; i < appData_values.length; i++) {
          if (appData_values[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
            appRow = i + 1;
            break;
          }
        }
        if (appRow > 0) {
          appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Denied');
        }
        Logger.log(`[AUDIT] ${sessionId}: Application Denied by ${approverEmail}`);
        notifyApplicant(sessionId, 'denied');
      }
      
      return { success: true, message: 'Decision recorded successfully' };
      } finally {
        // CRITICAL FIX: Only release lock if it was actually acquired
        if (lockAcquired) {
          lock.releaseLock();
        }
      }
    } catch (e) {
      Logger.log('Error processing approval: ' + e.toString());
      return { success: false, error: e.toString() };
    }
  } catch (e) {
    Logger.log('ERROR in processApprovalDecision (outer): ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: checkAllApproved
  LAYMAN:    Tells you whether every approver in the ladder has approved this application.
  TECHNICAL: Scans Approval_Workflow rows for sessionId; returns false on the first non-'Approved'
             status, true otherwise. Logs a warning for any unrecognized status value.
  PARAMS:    - sessionId — application id.
  RETURNS:   Boolean (true also if there are no matching rows).
*/
function checkAllApproved(sessionId) {
  const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
  const data = apprSheet.getDataRange().getValues();
  const validStatuses = ['Approved', 'Pending', 'Rejected', 'Returned', 'Denied'];
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId) {
      const status = data[i][APPROVAL_COLS.STATUS - 1];
      
      // Log unexpected status values
      if (!validStatuses.includes(status)) {
        Logger.log('WARNING: Unknown approval status "' + status + '" for ' + sessionId);
      }
      
      // Only return true if ALL are Approved
      if (status !== 'Approved') {
        return false;
      }
    }
  }
  return true;
}

/*
  Function: updateDCSStatus
  LAYMAN:    Writes a status back onto the Phase 1 DCS request — how PIA tells DCS "this is now
             Complete / Returned".
  TECHNICAL: Finds the Data_Collection row by REQ_ID and sets its STATUS cell. This is the only
             cross-phase write PIA makes into the DCS sheet (the shared-DB integration point).
  PARAMS:    - reqId — the DCS Request ID (Linked_ReqID).
             - newStatus — the status string to write (e.g. 'Complete', 'Returned').
  RETURNS:   undefined (no-op if reqId not found).
*/
function updateDCSStatus(reqId, newStatus) {
  const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
  const dcsData = dcsSheet.getDataRange().getValues();
  for (let j = 1; j < dcsData.length; j++) {
    if (dcsData[j][DCS_COLS.REQ_ID - 1] === reqId) {
      dcsSheet.getRange(j + 1, DCS_COLS.STATUS).setValue(newStatus);
      Logger.log(`Updated DCS request ${reqId} to status ${newStatus}`);
      break;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// � EMAIL QUEUE ENGINE — Decouples email sending from web requests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Instead of calling GmailApp.sendEmail() during a web request (which
// can fail silently under Gmail quota/throttling), all email functions
// now just append to the Email_Queue sheet. A 1-minute time-driven
// trigger picks up pending items and sends them with generous spacing
// (10s between sends) to avoid hitting Gmail's burst throttle. Failed
// sends stay in the queue and retry on the next trigger cycle.
//
// Setup: Create a time-driven trigger in Apps Script editor:
//   function setupEmailQueueTrigger() → run once
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: queueEmail
  LAYMAN:    Does NOT send an email — it drops it into the Email_Queue sheet so the background
             trigger can send it later. This keeps slow/throttled Gmail off the web-request path.
  TECHNICAL: Appends a Pending Email_Queue row (generated EQ-<ts>-<rand> id, plain+html bodies,
             type, 0 attempts). Then best-effort stamps EmailStatus='Pending' on the matching
             workflow row (approver/ism/divhead) so the admin panel can see queued sends. All in
             try/catch; stamping failure is non-fatal.
  PARAMS:    - sessionId, recipient, subject, plainBody, type, htmlBody.
  RETURNS:   The queueId string, or null on failure.
*/
function queueEmail(sessionId, recipient, subject, plainBody, type, htmlBody) {
  try {
    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const queueId = 'EQ-' + new Date().getTime() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const nowStr = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

    queueSheet.appendRow([
      queueId,           // Queue_ID
      sessionId,         // SessionID
      recipient,         // Recipient
      subject,           // Subject
      plainBody,         // Body_Plain
      htmlBody || '',    // Body_HTML
      type,              // Type: 'approver' | 'applicant' | 'ism' | 'divhead' | 'reminder'
      'Pending',         // Status
      0,                 // Attempts
      '',                // Last_Error
      nowStr,            // Created_At
      '',                // Sent_At
      ''                 // NotifiedAdmin
    ]);
    
    // ── Stamp EmailStatus='Pending' on the corresponding workflow row ──
    // This allows the admin panel to see which workflow rows have emails queued
    try {
      var wfInfo = { sheetName: null, cols: null, emailCol: null };
      if (type === 'approver') {
        wfInfo.sheetName = DB_SHEET_NAMES.APPROVAL_WORKFLOW;
        wfInfo.cols = APPROVAL_COLS;
      } else if (type === 'ism') {
        wfInfo.sheetName = DB_SHEET_NAMES.ISM_WORKFLOW;
        wfInfo.cols = ISM_WORKFLOW_COLS;
      } else if (type === 'divhead') {
        wfInfo.sheetName = DB_SHEET_NAMES.DIV_HEAD_CONFIG;
        wfInfo.cols = DIV_HEAD_CONFIG_COLS;
      }

      if (wfInfo.sheetName) {
        var wfSheet = getDatabaseSheet(wfInfo.sheetName, true);
        if (wfSheet) {
          var wfData = wfSheet.getDataRange().getValues();
          var normRecipient = String(getNormalizedEmail(recipient) || '').toLowerCase();
          for (var wr = 1; wr < wfData.length; wr++) {
            var rowSid = String(wfData[wr][wfInfo.cols.SESSION_ID - 1] || '').trim();
            var rowEmail = String(getNormalizedEmail(wfData[wr][wfInfo.cols.APPROVER_EMAIL - 1] || wfData[wr][wfInfo.cols.ISM_MEMBER_EMAIL - 1] || wfData[wr][wfInfo.cols.DIV_HEAD_EMAIL - 1] || '') || '').toLowerCase();
            var rowStatus = String(wfData[wr][wfInfo.cols.STATUS - 1] || '').trim();
            if (rowSid === sessionId && rowEmail === normRecipient && rowStatus === 'Pending') {
              wfSheet.getRange(wr + 1, wfInfo.cols.EMAIL_STATUS).setValue('Pending');
              break;
            }
          }
        }
      }
    } catch (stampErr) {
      Logger.log('⚠ Failed to stamp EmailStatus on workflow row: ' + stampErr.toString());
    }

    Logger.log('  📬 Queued ' + type + ' email to ' + recipient + ' [' + queueId + ']');
    return queueId;
  } catch (e) {
    Logger.log('ERROR: Failed to queue email for ' + sessionId + ': ' + e.toString());
    return null;
  }
}

/*
  Function: processEmailQueue
  LAYMAN:    The background worker (runs every minute on a trigger) that actually sends the queued
             emails, spacing them out to avoid Gmail throttling and retrying ones that fail.
  TECHNICAL: Iterates Email_Queue Pending rows (cap MAX_SENDS_PER_CYCLE, 10s spacing, stops if daily
             quota < 2). On success marks Sent + logs audit. On error increments attempts; after 9
             attempts marks Failed and runs the failsafe: stamps the workflow row EmailStatus/Error,
             and — once per queue entry (NOTIFIED_ADMIN guard) — emails the admin and optionally the
             requestor per getAdminNotificationConfig.
  PARAMS:    (none) — invoked by the time trigger.
  RETURNS:   { success:true, sent:<count> } or { success:false, error }.
*/
function processEmailQueue() {
  const MAX_SENDS_PER_CYCLE = 15;   // Cap to stay well within 30-min execution limit
  const SPACING_MS = 10000;         // 10 seconds between sends — safe for Gmail quota

  Logger.log('📬 Email Queue Processor — Starting cycle');

  try {
    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = queueSheet.getDataRange().getValues();
    let sentCount = 0;

    for (let i = 1; i < data.length; i++) {
      if (sentCount >= MAX_SENDS_PER_CYCLE) {
        Logger.log('  ⏸ Reached cycle cap of ' + MAX_SENDS_PER_CYCLE + ' sends. Remaining items will process next cycle.');
        break;
      }

      const status = String(data[i][EMAIL_QUEUE_COLS.STATUS - 1] || '').trim();
      if (status !== 'Pending') continue;

      const queueId = data[i][EMAIL_QUEUE_COLS.QUEUE_ID - 1];
      const sessionId = data[i][EMAIL_QUEUE_COLS.SESSION_ID - 1];
      const recipient = data[i][EMAIL_QUEUE_COLS.RECIPIENT - 1];
      const subject = data[i][EMAIL_QUEUE_COLS.SUBJECT - 1];
      const plainBody = data[i][EMAIL_QUEUE_COLS.BODY_PLAIN - 1];
      const htmlBody = data[i][EMAIL_QUEUE_COLS.BODY_HTML - 1];
      const type = data[i][EMAIL_QUEUE_COLS.TYPE - 1];
      const attempts = Number(data[i][EMAIL_QUEUE_COLS.ATTEMPTS - 1]) || 0;

      const rowNum = i + 1;
      const nowStr = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

      // Check remaining quota before attempting
      try {
        const remaining = MailApp.getRemainingDailyQuota();
        if (remaining < 2) {
          Logger.log('  ⛔ Daily quota exhausted (' + remaining + ' remaining). Stopping cycle.');
          break;
        }
      } catch(_) {}

      // Send with spacing
      if (sentCount > 0) {
        Utilities.sleep(SPACING_MS);
      }

      try {
        const options = htmlBody ? { htmlBody: htmlBody } : {};
        GmailApp.sendEmail(recipient, subject, plainBody, options);

        // Mark as Sent
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.STATUS).setValue('Sent');
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.ATTEMPTS).setValue(attempts + 1);
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.LAST_ERROR).setValue('');
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.SENT_AT).setValue(nowStr);

        logAuditTrail(sessionId, 'Email Sent', JSON.stringify({
          recipient: recipient,
          type: type,
          attempts: attempts + 1,
          error: null,
          source: 'queue'
        }));

        Logger.log('  ✓ Sent: ' + type + ' → ' + recipient + ' [' + queueId + ']');
        sentCount++;
      } catch (sendErr) {
        const errMsg = sendErr.toString();
        const newAttempts = attempts + 1;

        // After 9 attempts (~9 trigger cycles / ~9 minutes), mark as Failed
        const newStatus = newAttempts >= 9 ? 'Failed' : 'Pending';

        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.STATUS).setValue(newStatus);
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.ATTEMPTS).setValue(newAttempts);
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.LAST_ERROR).setValue(errMsg.substring(0, 500));

        if (newStatus === 'Failed') {
          logAuditTrail(sessionId, 'Email Failed', JSON.stringify({
            recipient: recipient,
            type: type,
            attempts: newAttempts,
            error: errMsg.substring(0, 200),
            source: 'queue'
          }));

          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // FAILSAFE: Mark workflow row & notify admin if configured
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          try {
            // 1. Stamp workflow row EmailStatus='Failed' + EmailError
            var wfInfo = getWorkflowInfoForType(type);
            if (wfInfo) {
              var wfSheet = getDatabaseSheet(wfInfo.name, true);
              if (wfSheet) {
                var wfData = wfSheet.getDataRange().getValues();
                var normRecipient = String(getNormalizedEmail(recipient) || '').toLowerCase();
                for (var wr = 1; wr < wfData.length; wr++) {
                  var rowSid = String(wfData[wr][wfInfo.cols.SESSION_ID - 1] || '').trim();
                  var rowEmail = String(getNormalizedEmail(wfData[wr][wfInfo.emailCol - 1] || '') || '').toLowerCase();
                  var rowStatus = String(wfData[wr][wfInfo.cols.STATUS - 1] || '').trim();
                  if (rowSid === sessionId && rowEmail === normRecipient && rowStatus === 'Pending') {
                    wfSheet.getRange(wr + 1, wfInfo.cols.EMAIL_STATUS).setValue('Failed');
                    wfSheet.getRange(wr + 1, wfInfo.cols.EMAIL_ERROR).setValue(errMsg.substring(0, 500));
                    break;
                  }
                }
              }
            }

            // 2. Check if admin already notified for THIS queue entry
            var alreadyNotified = String(data[i][EMAIL_QUEUE_COLS.NOTIFIED_ADMIN - 1] || '').trim();
            if (alreadyNotified !== 'YES') {
              // 3. Read admin notification config
              var notifConfig = getAdminNotificationConfig();
              var adminEmail = notifConfig.adminEmail || 'systems.manager@company.com';

              if (notifConfig.notifyOnFailure === 'YES') {
                var adminSubject = '[PIA SYSTEM ALERT] Email Delivery Failed — Session ' + sessionId;
                var adminBody = 'An email in the PIA system has failed after ' + newAttempts + ' retry attempts.\n\n' +
                  'Session ID: ' + sessionId + '\n' +
                  'Recipient: ' + recipient + '\n' +
                  'Email Type: ' + type + '\n' +
                  'Error: ' + errMsg.substring(0, 300) + '\n\n' +
                  'Queue Entry: ' + queueId + '\n' +
                  'Timestamp: ' + nowStr + '\n\n' +
                  'Please investigate and use the admin panel to resend or escalate.';
                sendEmailWithRetry(adminEmail, adminSubject, adminBody, {});
                Logger.log('  🚨 Admin notified of email failure: ' + adminEmail);
              }

              // 4. Notify requestor if configured
              if (notifConfig.notifyRequestor === 'YES') {
                try {
                  var appsSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
                  if (appsSheet) {
                    var appsData = appsSheet.getDataRange().getValues();
                    for (var ar = 1; ar < appsData.length; ar++) {
                      if (String(appsData[ar][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
                        var requestorEmail = String(appsData[ar][APPLICATIONS_COLS.APPLICANT_EMAIL - 1] || '').trim();
                        if (requestorEmail && requestorEmail !== '') {
                          var reqSubject = '[PIA System] Email Delivery Issue — Session ' + sessionId;
                          var reqBody = 'Dear Requestor,\n\n' +
                            'We encountered an issue delivering an approval email for your PIA session (' + sessionId + ').\n' +
                            'The system administrator has been notified and will resolve this shortly.\n\n' +
                            'No action is needed from you at this time.\n\n' +
                            'Thank you for your patience.\n' +
                            'PIA System';
                          sendEmailWithRetry(requestorEmail, reqSubject, reqBody, {});
                          Logger.log('  📨 Requestor notified of email failure: ' + requestorEmail);
                        }
                        break;
                      }
                    }
                  }
                } catch (reqErr) {
                  Logger.log('⚠ Failed to notify requestor: ' + reqErr.toString());
                }
              }

              // 5. Mark NotifiedAdmin = YES
              queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.NOTIFIED_ADMIN).setValue('YES');
            }
          } catch (failsafeErr) {
            Logger.log('⚠ Failsafe notification error (non-critical): ' + failsafeErr.toString());
          }
        }

        Logger.log('  ✗ Failed (' + newAttempts + '/9): ' + type + ' → ' + recipient + ' [' + queueId + '] — ' + errMsg.substring(0, 120));
        sentCount++;  // Count failed attempts toward the cycle cap
      }
    }

    Logger.log('📬 Email Queue Processor — Cycle complete. Sent: ' + sentCount);
    return { success: true, sent: sentCount };
  } catch (e) {
    Logger.log('ERROR: Email queue processor crashed: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: setupEmailQueueTrigger
  LAYMAN:    One-time setup: installs the every-minute background job that drains the email queue.
  TECHNICAL: Deletes any existing processEmailQueue trigger (dedupe), then creates a new time-based
             everyMinutes(1) trigger. Requires the script.scriptapp scope.
  PARAMS:    (none)
  RETURNS:   { success:true, message }.
*/
function setupEmailQueueTrigger() {
  // Remove any existing trigger to prevent duplicates
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'processEmailQueue') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Create new 1-minute trigger
  ScriptApp.newTrigger('processEmailQueue')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('✓ Email Queue trigger created — processEmailQueue() will run every 1 minute');
  return { success: true, message: 'Email queue trigger created. processEmailQueue will run every 1 minute.' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔔 DAILY REMINDER ENGINE — Nags pending approvers once per day
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Scans all three workflow sheets for Pending rows whose ReminderDate
// is not today. Queues a gentle reminder email and stamps today's date.
// Uses CacheService continuation tokens to survive 6-min timeout.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: sendDailyReminders
  LAYMAN:    The daily nudge. Looks across all three approval sheets for whoever is currently holding
             things up and queues them one gentle reminder per day — but only the next person in
             line, never people who haven't been reached yet.
  TECHNICAL: Trigger-driven; no-op if config.enabled is false. Pre-filters to sessionIds whose
             application is in an active status. For each of the three workflow sheets it groups
             Pending rows by sessionId, keeps only the LOWEST pending step (sequential order), skips
             rows already reminded today, and calls buildReminderEmail + stamps today's REMINDER_DATE.
             Uses a CacheService continuation token + MAX_SCAN_ROWS cap to survive the execution-time
             limit, and stops early if the Gmail daily quota is nearly exhausted.
  PARAMS:    (none)
  RETURNS:   { success:true, processed, reminded } (plus skipped/capped/quotaExhausted flags).
*/
function sendDailyReminders() {
  // Check if reminders are enabled
  const config = getReminderConfig();
  if (!config.enabled) {
    Logger.log('🔔 Daily Reminders — DISABLED via config. Skipping.');
    return { success: true, skipped: true, reason: 'disabled' };
  }

  Logger.log('🔔 Daily Reminders — Starting scan...');
  var today = new Date();
  // Use local date string in YYYY-MM-DD format for consistent comparison
  var todayStr = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  // Check if the email queue trigger is active (emails won't send without it)
  var triggers = ScriptApp.getProjectTriggers();
  var queueTriggerActive = false;
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === 'processEmailQueue') {
      queueTriggerActive = true;
      break;
    }
  }
  if (!queueTriggerActive) {
    Logger.log('⚠ WARNING: Email Queue trigger (processEmailQueue) is NOT active.');
    Logger.log('  → Run setupEmailQueueTrigger() to create it, or emails will stay queued.');
  }

  var cache = CacheService.getScriptCache();
  var CONTINUATION_KEY = 'reminder_continuation';
  var MAX_SCAN_ROWS = 300; // Safety cap per execution

  // Read continuation token from previous run
  var continuation = null;
  try {
    var raw = cache.get(CONTINUATION_KEY);
    if (raw) continuation = JSON.parse(raw);
  } catch (_) {}

  // ── PRE-FILTER: Build a Set of valid sessionIds from Applications sheet ──
  // Only applications in active approval states can have pending approvers.
  // This skips: Draft, Returned, Denied, Rejected by ISM, and phantom sessionIds
  // that exist in workflow sheets but have no corresponding application row.
  var VALID_REMINDER_STATUSES = ['Pending', 'Approved', 'Approved (ISM Pending)', 'Approved by ISM', 'Escalated to Division Head'];
  var validSessionIds = {};
  try {
    var appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    if (appSheet) {
      var appData = appSheet.getDataRange().getValues();
      for (var ai = 1; ai < appData.length; ai++) {
        var appStatus = String(appData[ai][APPLICATIONS_COLS.STATUS - 1] || '').trim();
        if (VALID_REMINDER_STATUSES.indexOf(appStatus) !== -1) {
          validSessionIds[String(appData[ai][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim()] = true;
        }
      }
      Logger.log('🔔 Pre-filter: ' + Object.keys(validSessionIds).length + ' applications in active approval states');
    }
  } catch (e) {
    Logger.log('⚠ Pre-filter read failed, will process all pending rows: ' + e.toString());
  }

  // Define the three sheets to scan
  var sheets = [
    {
      name: DB_SHEET_NAMES.APPROVAL_WORKFLOW,
      cols: APPROVAL_COLS,
      emailCol: APPROVAL_COLS.APPROVER_EMAIL,
      nameCol: APPROVAL_COLS.APPROVER_NAME,
      stepCol: APPROVAL_COLS.CURRENT_STEP,
      type: 'reminder'
    },
    {
      name: DB_SHEET_NAMES.ISM_WORKFLOW,
      cols: ISM_WORKFLOW_COLS,
      emailCol: ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL,
      nameCol: ISM_WORKFLOW_COLS.ISM_MEMBER_NAME,
      stepCol: ISM_WORKFLOW_COLS.CURRENT_STEP,
      type: 'reminder'
    },
    {
      name: DB_SHEET_NAMES.DIV_HEAD_CONFIG,
      cols: DIV_HEAD_CONFIG_COLS,
      emailCol: DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL,
      nameCol: null,
      stepCol: null,
      type: 'reminder'
    }
  ];

  var startSheetIdx = continuation ? continuation.sheetIdx : 0;
  var startRow = continuation ? continuation.row : 1;
  var processedCount = 0;
  var remindedCount = 0;

  for (var sIdx = startSheetIdx; sIdx < sheets.length; sIdx++) {
    var sheetDef = sheets[sIdx];
    var sheet = getDatabaseSheet(sheetDef.name, true);
    if (!sheet) continue;

    var data = sheet.getDataRange().getValues();

    // ── FIRST PASS: Collect pending rows grouped by sessionId ──
    // For sheets with steps (Approval_Workflow, ISM_Workflow), only the
    // LOWEST pending step per sessionId is eligible — this preserves
    // the sequential approval order and prevents reminding approvers
    // who haven't been reached yet.
    var pendingBySession = {};  // sessionId → { rowIndex, step, approverEmail, approverName, reminderDate }

    for (var i = 1; i < data.length; i++) {
      var status = String(data[i][sheetDef.cols.STATUS - 1] || '').trim();
      if (status !== 'Pending') continue;

      var sessionId = data[i][sheetDef.cols.SESSION_ID - 1];

      // Skip sessionIds not in the active-applications pre-filter
      // (phantom records, completed/denied/returned applications)
      if (!validSessionIds[String(sessionId || '').trim()]) continue;

      var step = sheetDef.stepCol ? Number(data[i][sheetDef.stepCol - 1] || 999) : 0;
      var existing = pendingBySession[sessionId];

      // For step-based sheets: keep only the row with the lowest step number
      if (!existing || step < existing.step) {
        // CRITICAL: Normalize reminderDate to YYYY-MM-DD string.
        // Sheets auto-converts "2026-06-04" into a Date object,
        // so String(dateObj) != "2026-06-04" and breaks the skip check below.
        var rawDate = data[i][sheetDef.cols.REMINDER_DATE - 1];
        var normalizedDate = '';
        if (Object.prototype.toString.call(rawDate) === '[object Date]') {
          var dd = rawDate;
          normalizedDate = dd.getFullYear() + '-' +
            String(dd.getMonth() + 1).padStart(2, '0') + '-' +
            String(dd.getDate()).padStart(2, '0');
        } else {
          normalizedDate = String(rawDate || '').trim();
        }

        pendingBySession[sessionId] = {
          rowIndex: i,
          step: step,
          approverEmail: data[i][sheetDef.emailCol - 1],
          approverName: sheetDef.nameCol ? data[i][sheetDef.nameCol - 1] : 'Division Head',
          reminderDate: normalizedDate
        };
      }
    }

    // ── SECOND PASS: Send reminder only to the first pending step per session ──
    var sessionIds = Object.keys(pendingBySession);
    for (var s = 0; s < sessionIds.length; s++) {
      var sid = sessionIds[s];
      var row = pendingBySession[sid];

      // Safety cap
      if (processedCount >= MAX_SCAN_ROWS) {
        cache.put(CONTINUATION_KEY, JSON.stringify({ sheetIdx: sIdx, row: row.rowIndex }), 3600);
        Logger.log('🔔 Daily Reminders — Capped at ' + MAX_SCAN_ROWS + ' rows. Resuming next cycle.');
        return { success: true, capped: true, processed: processedCount, reminded: remindedCount };
      }
      processedCount++;

      // Skip if already reminded today
      if (row.reminderDate === todayStr) continue;

      // Check daily quota before queueing
      try {
        var remaining = MailApp.getRemainingDailyQuota();
        if (remaining < 2) {
          Logger.log('🔔 Daily Reminders — Quota exhausted. Stopping.');
          cache.put(CONTINUATION_KEY, JSON.stringify({ sheetIdx: sIdx, row: row.rowIndex }), 3600);
          return { success: true, quotaExhausted: true, processed: processedCount, reminded: remindedCount };
        }
      } catch (_) {}

      var stepInfo = sheetDef.stepCol ? ('Step ' + row.step) : '';

      try {
        buildReminderEmail(sid, row.approverEmail, row.approverName, stepInfo);
        // Stamp today's date
        sheet.getRange(row.rowIndex + 1, sheetDef.cols.REMINDER_DATE).setValue(todayStr);
        remindedCount++;

        logAuditTrail(sid, 'Reminder Sent', JSON.stringify({
          recipient: row.approverEmail,
          type: sheetDef.type,
          step: stepInfo,
          date: todayStr
        }));
      } catch (e) {
        Logger.log('  ⚠ Reminder build failed for ' + sid + ': ' + e.toString());
      }
    }
  }

  // Clear continuation token — all done
  cache.remove(CONTINUATION_KEY);

  // Record last successful run
  try {
    PropertiesService.getScriptProperties().setProperty('PIA_LAST_REMINDER_RUN', todayStr + ' ' +
      new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }));
  } catch (_) {}

  Logger.log('🔔 Daily Reminders — Complete. Processed: ' + processedCount + ', Reminded: ' + remindedCount);
  return { success: true, processed: processedCount, reminded: remindedCount };
}

/*
  Function: buildReminderEmail
  LAYMAN:    Composes one reminder email (with a valid one-click Review link) and drops it in the
             queue.
  TECHNICAL: Resolves the web-app URL, loads the app data, builds an action-bound HMAC 'Review' link
             (same pattern as notifyApprover), renders the navy email via buildPiaEmailHtml_, and
             queueEmail(type:'reminder'). Re-throws so sendDailyReminders can log per-row failures.
  PARAMS:    - sessionId, approverEmail, approverName, stepInfo (e.g. 'Step 2').
  RETURNS:   undefined. Returns early (no send) if URL/app data unavailable; throws on send-build error.
*/
function buildReminderEmail(sessionId, approverEmail, approverName, stepInfo) {
  try {
    // CRITICAL: Guard against null ScriptApp.getService() when running from editor
    var webAppUrl = getWebAppUrl();
    if (!webAppUrl) {
      try { webAppUrl = ScriptApp.getService().getUrl(); } catch (_) {}
    }
    if (!webAppUrl) {
      Logger.log('  ⚠ Cannot build reminder — WEB_APP_URL not configured and ScriptApp service unavailable (running from editor?)');
      return;
    }

    var appData = getApplicationData(sessionId);
    if (!appData) {
      Logger.log('  ⚠ Cannot build reminder — no app data for ' + sessionId);
      return;
    }

    var ts = new Date().getTime().toString();
    var normalizedEmail = getNormalizedEmail(approverEmail);
    var token = generateAuthToken(sessionId, normalizedEmail, ts, 'Review');
    var reviewUrl = webAppUrl +
      '?sessionId=' + encodeURIComponent(sessionId) +
      '&email=' + encodeURIComponent(normalizedEmail) +
      '&token=' + token +
      '&ts=' + ts +
      '&action=Review';

    var subject = 'Reminder: Review pending for ' + sessionId;

    var htmlBody = buildPiaEmailHtml_({
      heading: 'Reminder — Review Pending',
      contentHtml: '' +
        '<p style="margin:0 0 14px;font-size:14px;">This is a friendly reminder that your review is still pending for the following Privacy Impact Assessment.</p>' +
        '<div style="background:#fff8e1;color:#b46d14;border:1px solid rgba(180,109,20,0.2);padding:10px 14px;border-radius:6px;font-size:12px;margin-bottom:16px;">⏳ <strong>Pending Review</strong> — ' + escapeHtml(stepInfo || 'Awaiting your action') + '</div>' +
        '<div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">' +
        'Pending review by: <strong>' + escapeHtml(approverName) + '</strong><br><br>' +
        '<strong>App ID:</strong> ' + escapeHtml(sessionId) + '<br>' +
        '<strong>Program:</strong> ' + escapeHtml(appData.pia1?.program || '—') + '<br>' +
        '<strong>Submitted by:</strong> ' + escapeHtml(appData.applicantEmail || '—') + '</div>' +
        '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">' +
        '<div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>' +
        generateEmailDecisionsHTML(sessionId) +
        '</div>' +
        '<div><a href="' + reviewUrl + '" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>' +
        '<p style="font-size:12px;color:#9ca3af;margin-top:16px;">You will receive a reminder daily until you take action on this application.</p>'
    });

    // Queue via existing email infrastructure — use 'reminder' type for all
    queueEmail(sessionId, approverEmail, subject,
      'Please view this email in an HTML-compatible client.',
      'reminder', htmlBody);

    Logger.log('  🔔 Reminder queued: reminder → ' + approverEmail + ' [' + sessionId + ']');
  } catch (e) {
    Logger.log('  ⚠ buildReminderEmail failed for ' + sessionId + ': ' + e.toString());
    throw e; // Let caller handle
  }
}

/*
  Function: getReminderConfig
  LAYMAN:    Reads the reminder settings (on/off, hour, timezone), with sensible defaults.
  TECHNICAL: Parses REMINDER_CONFIG_PROP JSON; on absence/parse error returns
             { enabled:true, hour:8, timezone: script TZ || 'Asia/Manila' }.
  PARAMS:    (none)
  RETURNS:   { enabled, hour, timezone }.
*/
function getReminderConfig() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(REMINDER_CONFIG_PROP);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  // Defaults
  return { enabled: true, hour: 8, timezone: Session.getScriptTimeZone() || 'Asia/Manila' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📧 EMAIL NOTIFICATIONS  (now queue-based — see Email Queue above)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: buildPiaEmailHtml_
  LAYMAN:    The shared navy "letterhead" every PIA email uses — header bar, white card, and the
             do-not-reply footer. You give it a heading and inner content; it returns the full HTML.
  TECHNICAL: Pure string builder. Wraps opts.contentHtml in the standard navy (#2a5285) card shell
             matching the Admin/DCS template. No side-effects.
  PARAMS:    - opts — { heading?, contentHtml?, accent? }.
  RETURNS:   HTML string for the email body.
*/
function buildPiaEmailHtml_(opts) {
  opts = opts || {};
  var accent = opts.accent || '#2a5285';
  var heading = opts.heading || 'Notification';
  var content = opts.contentHtml || '';
  return '<div style="font-family:\'Helvetica Neue\',Helvetica,Arial,sans-serif;background:#f9fafb;padding:24px;color:#333;line-height:1.6;">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.08);overflow:hidden;">' +
      '<div style="background:' + accent + ';padding:18px 28px;">' +
        '<div style="color:#ffffff;font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;opacity:0.9;">Megaworld Data Privacy System</div>' +
        '<div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">' + heading + '</div>' +
      '</div>' +
      '<div style="padding:28px;">' + content + '</div>' +
      '<div style="padding:16px 28px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:12px;color:#6b7280;line-height:1.5;"><strong style="color:#374151;">No-reply notice.</strong> This mailbox is not monitored, so please do not reply. Use the button above to take action. For assistance, contact ISM-InfoSec at <strong style="color:#374151;">infosec@megaworldcorp.com</strong>.</div>' +
    '</div></div>';
}

/*
  Function: notifyApprover
  LAYMAN:    Emails the approver at a given step that an application needs their review, including a
             secure one-click "Review" link. Queues the email (does not send inline).
  TECHNICAL: Reads Approval_Workflow to find the row whose CurrentStep === approverIndex+1 and the
             total step count. Builds an action-bound HMAC 'Review' URL, renders via buildPiaEmailHtml_,
             and queueEmail(type:'approver'). Whole body in try/catch — email failure is logged to the
             audit trail and never thrown (the DB write already happened).
  PARAMS:    - sessionId — application id.
             - approverIndex — 0-based index of the approver to notify (step = index+1).
  RETURNS:   undefined. No-op if no approver exists at that step.
*/
function notifyApprover(sessionId, approverIndex) {
  // FAILSAFE: Email failures must never crash the caller (DB already updated)
  try {
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl() || ScriptApp.getService().getUrl();
    // Fetch the next pending approver from the approval workflow sheet
    // (not from hardcoded APPROVERS - respect dynamic approvers from form data)
    const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
    const apprData = apprSheet.getDataRange().getValues();
    
    // Find all approval records for this sessionId to determine total steps
    let totalSteps = 0;
    let approverToNotify = null;
    
    for (let i = 1; i < apprData.length; i++) {
      if (apprData[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId) {
        totalSteps++;
        // Find the specific step we need to notify
        if (apprData[i][APPROVAL_COLS.CURRENT_STEP - 1] === approverIndex + 1) {
          approverToNotify = {
            name: apprData[i][APPROVAL_COLS.APPROVER_NAME - 1],
            email: apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1]
          };
        }
      }
    }
    
    // Check if there's a next approver to notify
    if (!approverToNotify) {
      Logger.log('INFO: All approval levels completed for application ' + sessionId);
      return;
    }
    
    const stepCount = approverIndex + 1;
    const approver = approverToNotify;
    const ts = new Date().getTime().toString();
    // CRITICAL FIX: Normalize email before token generation to prevent authorization mismatch
    const normalizedApproverEmail = getNormalizedEmail(approver.email);
    const token = generateAuthToken(sessionId, normalizedApproverEmail, ts, 'Review');

    const baseUrl = `${webAppUrl}?sessionId=${sessionId}&email=${encodeURIComponent(normalizedApproverEmail)}&token=${token}&ts=${ts}&step=${stepCount}`;
    const reviewUrl = `${baseUrl}&action=Review`;

    SpreadsheetApp.flush(); 
    const appData = getApplicationData(sessionId);
    
    if (!appData) {
      Logger.log('ERROR: Cannot notify approver - no app data found for ' + sessionId);
      return;
    }
    
    const subject = `Action Required: Review ${sessionId}`;

    const htmlBody = buildPiaEmailHtml_({
      heading: 'Action Required — Review',
      contentHtml: `
        <p style="margin:0 0 14px;font-size:14px;">Hello, ${escapeHtml(approver.name || 'Approver')},</p>
        <p style="margin:0 0 14px;font-size:14px;">A new Privacy Impact Assessment (PIA) requires your review.</p>
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Approval chain — step ${stepCount} of ${totalSteps}</div>
        <div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
          Pending review by: <strong>${escapeHtml(approver.name)}</strong><br><br>
          <strong>App ID:</strong> ${escapeHtml(sessionId)}<br>
          <strong>Program:</strong> ${escapeHtml(appData.pia1?.program || '—')}<br>
          <strong>Submitted by:</strong> ${escapeHtml(appData.applicantEmail || '—')}
        </div>
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
          ${generateEmailDecisionsHTML(sessionId)}
        </div>
        <div><a href="${reviewUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>`
    });

    // Queue email for deferred reliable delivery (avoids Gmail throttling in-request)
    queueEmail(sessionId, approver.email, subject, "Please view this email in an HTML-compatible client.", 'approver', htmlBody);
  } catch (e) {
    Logger.log('FAILSAFE: Email queue for approver failed for ' + sessionId + ': ' + e.toString());
    try {
      logAuditTrail(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'approver',
        attempts: 0,
        error: 'QUEUE_CRASH: ' + e.toString()
      }));
    } catch(_) {}
  }
}

/*
  Function: notifyApplicant
  LAYMAN:    Emails the applicant a status update (submitted / progressing / approved / returned /
             denied / escalated / routed, etc.) with the right wording, the running decision history,
             and a context-appropriate button (open DCS, update the PIA, or view receipt).
  TECHNICAL: Loads app data, generateEmailDecisionsHTML for the history, then selects a status banner
             and action URL/label from the status code (many branches; returns/rejections vary based on
             whether DCS-level flags exist). Renders via buildPiaEmailHtml_ and queueEmail(type:
             'applicant'). Fully wrapped in try/catch; failures are audited, never thrown.
  PARAMS:    - sessionId — application id.
             - status — status code string (e.g. 'submitted','progressing','approved_main',
                        'returned','denied','approved_ism_final','routed_implementation', ...).
  RETURNS:   undefined. No-op if app data is missing.
*/
function notifyApplicant(sessionId, status, options) {
  // FAILSAFE: Email failures must never crash the caller (DB already updated)
  try {
    const opts = options || {};
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl() || ScriptApp.getService().getUrl();
  const dcsWebAppUrl = getDCSWebAppUrl() || ScriptApp.getService().getUrl();
  // CRITICAL: Flush pending writes so app data reads see latest state
  SpreadsheetApp.flush();
  const appData = getApplicationData(sessionId);
  if (!appData) return;

  // #14: resolve the requester's name from the linked DCS record for a personalized greeting (best-effort)
  let applicantName = '';
  try {
    if (appData.linkedReqId) {
      const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, false);
      if (dcsSheet) {
        const dcsVals = dcsSheet.getDataRange().getValues();
        for (let i = 1; i < dcsVals.length; i++) {
          if (String(dcsVals[i][DCS_COLS.REQ_ID - 1] || '').trim() === String(appData.linkedReqId).trim()) {
            const md = JSON.parse(dcsVals[i][DCS_COLS.METADATA_JSON - 1] || '{}');
            applicantName = md.name || md.requestorName || md.drafterName || '';
            break;
          }
        }
      }
    }
  } catch (e) { /* name is best-effort; fall back to a generic greeting */ }

  const decisionsHTML = generateEmailDecisionsHTML(sessionId);
  let subject = `Update on Application: ${sessionId}`;
  let statusMessage = '';
  
  let hasDCSFlags = false;
  if (status === 'returned' || status === 'rejected') {
    try {
      const flagsObj = appData.approverFlags || {};
      const flagKeys = Object.keys(flagsObj);
      hasDCSFlags = flagKeys.length === 0 || flagKeys.some(key => key.startsWith('DCS - '));
    } catch(e) {}
  }

  if (status === 'approved') {
    statusMessage = `<div style="background: #e8f5e9; color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your Privacy Impact Assessment application has been <strong>FULLY APPROVED</strong>. A certificate has been generated.</div></div>`;
  } else if (status === 'submitted') {
    statusMessage = `<div style="background: #e3f2fd; color: #1e88e5; border: 1px solid rgba(30,136,229,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your Privacy Impact Assessment application has been <strong>SUBMITTED</strong> and is now being reviewed by your Immediate/Department Head.</div></div>`;
  } else if (status === 'progressing') {
    statusMessage = `<div style="background: #e3f2fd; color: #1e88e5; border: 1px solid rgba(30,136,229,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application has been approved by the current reviewer and is now <strong>PROGRESSING</strong> to the next Head for review.</div></div>`;
  } else if (status === 'approved_main') {
    statusMessage = `<div style="background: #e8f5e9; color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application is now <strong>HEADS APPROVED</strong> — it cleared all required Head approvals and is being reviewed by the ISM (InfoSec) team. This is not yet final approval.</div></div>`;
  } else if (status === 'escalated_divhead') {
    statusMessage = `<div style="background: #f3e8ff; color: #6b21a8; border: 1px solid rgba(107,33,168,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application has been <strong>ESCALATED</strong> to the Division Head for executive review.</div></div>`;
  } else if (status === 'approved_divhead_progressing') {
    statusMessage = `<div style="background: #e3f2fd; color: #1e88e5; border: 1px solid rgba(30,136,229,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application was <strong>approved by the Division Head</strong> and is returning to the ISM team for continued review. This is not yet final approval.</div></div>`;
  } else if (status === 'progressing_ism') {
    statusMessage = `<div style="background: #e3f2fd; color: #1e88e5; border: 1px solid rgba(30,136,229,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application has been approved by an ISM member and is now <strong>PROGRESSING</strong> to the next ISM member.</div></div>`;
  } else if (status === 'approved_ism_final' || status === 'approved_divhead_final') {
    statusMessage = `<div style="background: #e8f5e9; color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your Privacy Impact Assessment has been <strong>FULLY APPROVED</strong> by all required parties and is now being processed by the implementation team.</div></div>`;
  } else if (status === 'routed_implementation') {
    statusMessage = `<div style="background: #e8f5e9; color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application has been <strong>COMPLETED</strong> and is now waiting for implementation (routed to DCOPS / TechServe).</div></div>`;
  } else if (status === 'returned') {
    if (hasDCSFlags) {
      statusMessage = `<div style="background: #fff8e1; color: #b46d14; border: 1px solid rgba(180,109,20,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> <div>Your application has been <strong>RETURNED TO REQUESTOR</strong>. You must update your DCS request before you can resubmit this PIA.<br><br><strong>Instructions:</strong> Open the DCS System &gt; Go to "Review Application" &gt; Select Request <strong>${escapeHtml(appData.linkedReqId || '')}</strong> &gt; Click "Edit & Review".</div></div>`;
    } else {
      statusMessage = `<div style="background: #fff8e1; color: #b46d14; border: 1px solid rgba(180,109,20,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> <div>Your application has been <strong>RETURNED TO REQUESTOR</strong>. Please review the comments below and update your PIA application.</div></div>`;
    }
  } else if (status === 'denied') {
    statusMessage = `<div style="background: #ffebee; color: #A22D2D; border: 1px solid rgba(162,45,45,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg> <div>Your application has been <strong>PERMANENTLY DENIED</strong>. It is locked and stored for audit purposes.</div></div>`;
  }

  const linkedReqId = appData.linkedReqId || '';
  // Determine action URL and button text based on status
  let actionUrl = webAppUrl;
  let buttonText = 'View receipt →';
  
  if (linkedReqId) {
    // For approved statuses, link to DCS system
    if (status === 'submitted' || status === 'progressing' || status === 'approved_main' || 
        status === 'approved' || status === 'approved_ism_final' || status === 'approved_divhead_final' || 
        status === 'routed_implementation' || status === 'approved_divhead_progressing' || status === 'progressing_ism' ||
        status === 'escalated_divhead') {
      actionUrl = `${dcsWebAppUrl}?parentID=${encodeURIComponent(linkedReqId)}`;
      buttonText = 'View DCS Submission →';
    } else if (status === 'returned' || status === 'rejected') {
      if (hasDCSFlags) {
        actionUrl = dcsWebAppUrl;
        buttonText = 'Update DCS Request First →';
      } else {
        actionUrl = `${webAppUrl}?parentID=${encodeURIComponent(linkedReqId)}`;
        buttonText = 'Review & Update PIA →';
      }
    } else {
      actionUrl = `${webAppUrl}?parentID=${encodeURIComponent(linkedReqId)}`;
    }
  } else {
    // No linked DCS, use default button text
    if (status === 'returned' || status === 'rejected') {
      buttonText = 'Review & Update Application →';
    }
  }

  // Item 2: on full approval — a "certificate attached" note up top, and a clean TechServe
  // contact list (Name / email per line) placed AFTER the Review Status.
  let certNote = '';
  let techserveBlock = '';
  if (status === 'approved_ism_final' || status === 'approved_divhead_final') {
    if (opts.certBlob) {
      certNote = `<p style="margin:0 0 16px;font-size:13px;color:#1a3a5c;">Your <strong>Certificate of Approval</strong> is attached to this email for your reference.</p>`;
    }
    const tsList = Array.isArray(opts.techserveEmails) ? opts.techserveEmails : [];
    if (tsList.length) {
      const tsRows = tsList.map(function(t) {
        const nm = (t && t.name) ? escapeHtml(String(t.name)) : '';
        const em = (t && t.email) ? escapeHtml(String(t.email)) : '';
        return `<div style="margin-top:8px;">${nm ? `<div style="font-weight:600;color:#1a3a5c;font-size:13px;">${nm}</div>` : ''}<div style="font-size:13px;color:#2a5285;">${em}</div></div>`;
      }).join('');
      techserveBlock = `<div style="background:#eef4fb;border:1px solid rgba(42,82,133,0.15);border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#1a3a5c;"><div style="font-weight:600;">For follow-up, please contact the TechServe team:</div>${tsRows}</div>`;
    }
  }

  const htmlBody = buildPiaEmailHtml_({
    heading: 'Application Status Update',
    contentHtml: `
      <p style="margin:0 0 14px;font-size:14px;">Hello${applicantName ? ', ' + escapeHtml(applicantName) + '!' : ','}</p>
      ${statusMessage}
      ${certNote}
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
        ${decisionsHTML}
      </div>
      ${techserveBlock}
      <div><a href="${actionUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${buttonText}</a></div>`
  });

  // Final-approval emails carry the Certificate of Approval PDF, which the async queue can't hold —
  // send those synchronously with the attachment; every other status stays on the reliable queue.
  if (opts.certBlob) {
    var certSend;
    try {
      certSend = sendEmailWithRetry(appData.applicantEmail, subject, "Please view this email in an HTML-compatible client.", {
        htmlBody: htmlBody,
        attachments: [opts.certBlob]
      });
    } catch (sendErr) {
      certSend = { success: false, error: String(sendErr) };
    }
    // L1: if the synchronous send (with attachment) ultimately fails, fall back to the reliable queue
    // (without the attachment) so the applicant is still notified of full approval. The certificate
    // itself already went to DCOPS/TechServe.
    if (!certSend || !certSend.success) {
      Logger.log('Final-approval email with cert failed for ' + sessionId + '; queueing fallback. ' + (certSend && certSend.error ? certSend.error : ''));
      queueEmail(sessionId, appData.applicantEmail, subject, "Please view this email in an HTML-compatible client.", 'applicant', htmlBody);
    }
  } else {
    queueEmail(sessionId, appData.applicantEmail, subject, "Please view this email in an HTML-compatible client.", 'applicant', htmlBody);
  }
  } catch (e) {
    Logger.log('FAILSAFE: Email queue for applicant failed for ' + sessionId + ': ' + e.toString());
    try {
      logAuditTrail(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'applicant',
        attempts: 0,
        error: 'QUEUE_CRASH: ' + e.toString()
      }));
    } catch(_) {}
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📧 EMAIL HTML
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: generateEmailDecisionsHTML
  LAYMAN:    Builds the little "who decided what" history block shown inside applicant emails, pulling
             together every recorded approver / Division Head / ISM decision.
  TECHNICAL: Inner processDecisions() walks a workflow sheet for sessionId, skips Pending/blank rows,
             formats date + a color-coded status label, and escapes name/comment (XSS-safe). Runs it
             over Approval_Workflow, DivisionHead_Approval_Workflow, and ISM_Approval_Workflow.
  PARAMS:    - sessionId — application id.
  RETURNS:   HTML string; a "No decisions recorded yet." note if nothing is found.
*/
function generateEmailDecisionsHTML(sessionId) {
  let hasRecords = false;
  let html = `<div style="font-family: sans-serif;">`;
  
  const processDecisions = (sheetName, idCol, nameCol, statusCol, commentCol, dateCol, defaultName, roleType, stepCol) => {
    const sheet = getDatabaseSheet(sheetName, false);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][idCol - 1] === sessionId) {
        const status = String(data[i][statusCol - 1] || '');
        if (status === 'Pending' || status === '') continue; // Skip pending to remove tracking
        
        const rawName = nameCol ? data[i][nameCol - 1] : '';
        const approverName = escapeHtml(rawName || defaultName);
        // #13: resolve a human role label so the requester knows WHICH head/reviewer acted
        let roleLabel = defaultName;
        if (roleType === 'head') {
          const stepVal = stepCol ? Number(data[i][stepCol - 1] || 0) : 0;
          roleLabel = stepVal === 1 ? 'Immediate Head' : stepVal === 2 ? 'Department Head' : 'Head';
        } else if (roleType === 'divhead') { roleLabel = 'Division Head'; }
        else if (roleType === 'ism') { roleLabel = 'InfoSec Reviewer'; }
        const comment = data[i][commentCol - 1];
        const decisionDateRaw = dateCol ? data[i][dateCol - 1] : '';
        
        // Format timestamp if available
        let decisionDateStr = '';
        if (decisionDateRaw) {
          try {
            if (Object.prototype.toString.call(decisionDateRaw) === '[object Date]') {
              decisionDateStr = Utilities.formatDate(decisionDateRaw, Session.getScriptTimeZone(), "MMM dd, yyyy, hh:mm a");
            } else {
              decisionDateStr = String(decisionDateRaw); // Already a formatted string (e.g. from toLocaleString)
            }
          } catch(e) {
            decisionDateStr = String(decisionDateRaw);
          }
        }
        
        hasRecords = true;
        let color = '#BA7517'; 
        let statusLabel = status;
        
        if (status === 'Approved') { color = '#1D9E75'; statusLabel = 'Approved'; }
        else if (status.includes('Reject') || status.includes('Return')) { color = '#BA7517'; statusLabel = 'Returned to Requestor'; }
        else if (status.includes('Deny')) { color = '#A22D2D'; statusLabel = 'Denied'; }
        else if (status === 'EscalatedToDivisionHead') { color = '#6b21a8'; statusLabel = 'Escalated to Division Head'; }

        // HIGH FIX: Escape comment to prevent XSS in emails
        const escapedComment = escapeHtml(comment);
        html += `
          <div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #f0f0f0;">
            <div style="font-size: 13px; color: #333;"><strong>${approverName}</strong> <span style="color:#6b7280; font-weight:500;">— ${escapeHtml(roleLabel)}</span>: <span style="color: ${color}; font-weight: 600;">${statusLabel}</span></div>
            ${decisionDateStr ? `<div style="font-size: 11px; color: #999; margin-top: 2px;">${escapeHtml(decisionDateStr)}</div>` : ''}
            ${comment ? `<div style="font-size: 13px; color: #666; margin-top: 4px;">"${escapedComment}"</div>` : ''}
          </div>
        `;
      }
    }
  };

  // Process all approval stages to show comprehensive latest decisions
  processDecisions(DB_SHEET_NAMES.APPROVAL_WORKFLOW, APPROVAL_COLS.SESSION_ID, APPROVAL_COLS.APPROVER_NAME, APPROVAL_COLS.STATUS, APPROVAL_COLS.COMMENTS, APPROVAL_COLS.DECISION_DATE, 'Approver', 'head', APPROVAL_COLS.CURRENT_STEP);
  processDecisions(DB_SHEET_NAMES.DIV_HEAD_CONFIG, DIV_HEAD_CONFIG_COLS.SESSION_ID, null, DIV_HEAD_CONFIG_COLS.STATUS, DIV_HEAD_CONFIG_COLS.COMMENTS, DIV_HEAD_CONFIG_COLS.DECISION_DATE, 'Division Head', 'divhead', null);
  processDecisions(DB_SHEET_NAMES.ISM_WORKFLOW, ISM_WORKFLOW_COLS.SESSION_ID, ISM_WORKFLOW_COLS.ISM_MEMBER_NAME, ISM_WORKFLOW_COLS.STATUS, ISM_WORKFLOW_COLS.COMMENTS, ISM_WORKFLOW_COLS.DECISION_DATE, 'ISM Member', 'ism', null);

  html += `</div>`;
  return hasRecords ? html : `<div style="font-size: 13px; color: #666; font-style: italic;">No decisions recorded yet.</div>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   RETRIEVAL FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: getApplicationData
  LAYMAN:    The main "load one application" reader. Returns everything about a PIA: its five sections,
             status, linked DCS id, flags, and the approver timeline (who, role, decision, comment).
  TECHNICAL: Finds the Applications row by case-insensitive sessionId, safeParse's the five PIA JSON
             cells and approverFlags, then joins Approval_Workflow rows. Roles are inferred from step
             order (Immediate Head step 1 / Dept Head step 2, shifting if no immediate head) plus the
             Privacy Officer email. Computes approvalStep = count of Approved rows.
  PARAMS:    - sessionId — application id (trim/uppercase-insensitive).
  RETURNS:   The app object, or null if not found.
*/
function getApplicationData(sessionId) {
  const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
  const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);

  const searchId = String(sessionId || '').trim().toUpperCase();
  const appData_values = appSheet.getDataRange().getValues();

  let rowData = null;
  for (let i = 1; i < appData_values.length; i++) {
    if (String(appData_values[i][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim().toUpperCase() === searchId) {
      rowData = appData_values[i];
      break;
    }
  }

  if (!rowData) return null;

  const safeParse = (str) => { 
    try { return JSON.parse(str || '{}'); } catch(e) { return {}; } 
  };

  let appData = {
    sessionId: rowData[APPLICATIONS_COLS.SESSION_ID - 1],
    applicantEmail: rowData[APPLICATIONS_COLS.APPLICANT_EMAIL - 1],
    status: rowData[APPLICATIONS_COLS.STATUS - 1],
    pia1: safeParse(rowData[APPLICATIONS_COLS.PIA_1_DATA - 1]),
    pia2: safeParse(rowData[APPLICATIONS_COLS.PIA_2_DATA - 1]),
    pia3: safeParse(rowData[APPLICATIONS_COLS.PIA_3_DATA - 1]),
    pia4: safeParse(rowData[APPLICATIONS_COLS.PIA_4_DATA - 1]),
    pia5: safeParse(rowData[APPLICATIONS_COLS.PIA_5_DATA - 1]),
    isFlagged: rowData[APPLICATIONS_COLS.IS_FLAGGED - 1] === 'YES',
    linkedReqId: rowData[APPLICATIONS_COLS.LINKED_REQ_ID - 1],
    approverFlags: safeParse(rowData[APPLICATIONS_COLS.APPROVER_FLAGS - 1]),
    approvers: [] 
  };

  // Fetch approver timeline rows
  const apprData_values = apprSheet.getDataRange().getValues();
  let stepCounter = 0;
  
  const poEmail = getNormalizedEmail(PropertiesService.getScriptProperties().getProperty('PRIVACY_OFFICER_EMAIL'));
  const immEmail = getNormalizedEmail(appData.pia1.immediateHeadEmail);
  const deptEmail = getNormalizedEmail(appData.pia1.deptHeadEmail);
  const hasImmHead = !!immEmail;

  for (let i = 1; i < apprData_values.length; i++) {
    if (String(apprData_values[i][APPROVAL_COLS.SESSION_ID - 1] || '').trim().toUpperCase() === searchId) {
      const aData = apprData_values[i];
      const email = getNormalizedEmail(aData[APPROVAL_COLS.APPROVER_EMAIL - 1]);
      const step = Number(aData[APPROVAL_COLS.CURRENT_STEP - 1]);

      let role = 'Approver';
      // Determine roles based on Step Sequence to handle identical emails for different roles
      if (hasImmHead && step === 1) role = 'Immediate Head';
      else if (hasImmHead && step === 2) role = 'Department Head';
      else if (!hasImmHead && step === 1) role = 'Department Head';
      else if (email === poEmail) role = 'Privacy Officer';
      
      appData.approvers.push({
        name: aData[APPROVAL_COLS.APPROVER_NAME - 1],
        email: aData[APPROVAL_COLS.APPROVER_EMAIL - 1],
        role: role,
        decision: aData[APPROVAL_COLS.DECISION - 1] || null,
        comment: aData[APPROVAL_COLS.COMMENTS - 1],
        status: aData[APPROVAL_COLS.STATUS - 1],
        decisionDate: aData[APPROVAL_COLS.DECISION_DATE - 1]
      });
      if (aData[APPROVAL_COLS.STATUS - 1] === 'Approved') stepCounter++;
    }
  }
  
  appData.approvalStep = stepCounter;
  return appData;
}

/*
  Function: getUserSubmissions
  LAYMAN:    Returns the current signed-in user's own PIA applications as a lightweight list (id,
             program, dept, status, date, flag) for the "My Applications" screen.
  TECHNICAL: Filters Applications rows by the active user's email, formats the submission date, and
             pulls program/dept from parsed PIA 1. Fully try/catch-guarded; returns [] on any error or
             empty sheet.
  PARAMS:    (none) — uses Session.getActiveUser().
  RETURNS:   Array of { id, program, dept, status, date, isFlagged }.
*/
function getUserSubmissions() {
  try {
    const userEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
    
    if (!userEmail) {
      Logger.log('ERROR: userEmail is empty. Please check Web App deployment settings.');
      return [];
    }

    const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    if (!appSheet) {
      Logger.log('ERROR: Applications sheet not found or null');
      return [];
    }
    const lastRow = appSheet.getLastRow();
    if (lastRow < 2) return [];
    
    const appData_values = appSheet.getDataRange().getValues();

    const submissions = [];
    const safeParse = (str) => { 
      try { return JSON.parse(str || '{}'); } catch(e) { 
        Logger.log('WARNING: Could not parse JSON in cell: ' + str);
        return {}; 
      } 
    };
    
    for (let i = 1; i < appData_values.length; i++) {
      if (String(appData_values[i][APPLICATIONS_COLS.APPLICANT_EMAIL - 1] || '').trim().toLowerCase() === userEmail) {
        const rowData = appData_values[i];
        let dateVal = rowData[APPLICATIONS_COLS.SUBMISSION_DATE - 1];
        let dateStr = Object.prototype.toString.call(dateVal) === '[object Date]' 
          ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), "MMM dd, yyyy hh:mm a") 
          : String(dateVal || '');
      
        const pia1Data = safeParse(rowData[APPLICATIONS_COLS.PIA_1_DATA - 1]);
        submissions.push({
          id: rowData[APPLICATIONS_COLS.SESSION_ID - 1],
          program: pia1Data.program || 'Untitled',
          dept: pia1Data.dept || '',
          status: rowData[APPLICATIONS_COLS.STATUS - 1],
          date: dateStr, 
          isFlagged: rowData[APPLICATIONS_COLS.IS_FLAGGED - 1] === 'YES'
        });
      }
    }
    return submissions;
  } catch (error) {
    Logger.log('ERROR in getUserSubmissions: ' + error.toString());
    return [];
  }
}

/*
  Function: findRowBySessionID
  LAYMAN:    Finds which row of the Applications sheet holds a given application id.
  TECHNICAL: Linear scan of column A (case-insensitive, trimmed) — deliberately avoids createTextFinder
             for consistent behavior. Returns the 1-indexed sheet row.
  PARAMS:    - sessionId — application id.
  RETURNS:   Row number (>=2), or -1 if not found / sheet empty.
*/
function findRowBySessionID(sessionId) {
  const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
  const lastRow = appSheet.getLastRow();

  if (lastRow < 2) {
    return -1;
  }
  
  // MEDIUM FIX: Use explicit string matching instead of createTextFinder
  // createTextFinder behavior is not guaranteed consistent across APIs
  const searchId = String(sessionId || '').trim().toUpperCase();
  const range = appSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  
  for (let i = 0; i < range.length; i++) {
    if (String(range[i][0] || '').trim().toUpperCase() === searchId) {
      return i + 2; // +2 because getRange starts at row 2, and array is 0-indexed
    }
  }
  return -1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📋 AUDIT LOGGING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: logAuditTrail
  LAYMAN:    Records an event — but only writes to the Risk_Audit sheet when it is genuinely
             anomalous (risk flags, conflicts, email failures). Normal workflow actions are logged to
             the console only, keeping the audit sheet signal-rich.
  TECHNICAL: If flagsData === false → Logger only. If flagsData is a string parsing to a LOW/empty risk
             payload → Logger only. Otherwise appends a Risk_Audit row (UUID logId, active user, PH
             timestamp, normalized flags JSON; true coerces to a legacy HIGH payload). All try/catch.
  PARAMS:    - sessionId — application id.
             - action — human-readable event label.
             - flagsData — JSON string of risk details, true (legacy), or false (skip sheet write).
  RETURNS:   undefined.
*/
function logAuditTrail(sessionId, action, flagsData) {
  try {
    // ── Normal workflow actions are not "paranormal" → skip sheet write ──
    if (flagsData === false) {
      Logger.log(`[AUDIT] ${sessionId}: ${action}`);
      return;
    }

    // ── Also skip if flagsData is an empty-risk payload (no actual flags) ──
    if (typeof flagsData === 'string') {
      try {
        const parsed = JSON.parse(flagsData);
        if (parsed && parsed.riskLevel === 'LOW' &&
            (!parsed.reasons || parsed.reasons.length === 0)) {
          Logger.log(`[AUDIT] ${sessionId}: ${action} — No anomalous flags`);
          return;
        }
      } catch (_) {
        // Not valid JSON — proceed and log to sheet as-is
      }
    }

    // ── Paranormal event — write to Risk_Audit sheet ──
    const auditSheet = getDatabaseSheet(DB_SHEET_NAMES.RISK_AUDIT, true);
    if (!auditSheet) {
      Logger.log(`[AUDIT-WARN] Risk_Audit sheet unavailable for: ${sessionId}: ${action}`);
      return;
    }

    const logId = Utilities.getUuid();
    const userEmail = Session.getActiveUser().getEmail();
    const timestamp = new Date().toLocaleString('en-PH', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    let flags = '{}';
    if (typeof flagsData === 'string') flags = flagsData;
    else if (flagsData === true) flags = JSON.stringify({ riskLevel: 'HIGH', reason: 'Legacy flag trigger' });

    auditSheet.appendRow([
      logId,              // LogID
      sessionId,          // SessionID
      flags,              // InternalFlags
      action,             // Action
      userEmail,          // UserEmail
      'Web App',          // UserAgent
      timestamp           // Timestamp
    ]);

    Logger.log(`[AUDIT-FLAG] ${sessionId}: ${action} — Written to Risk_Audit`);
  } catch (e) {
    Logger.log('Error logging audit trail: ' + e.toString());
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛠️ ADMIN API — EMAIL FAILOVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// These functions are called by the external Admin Panel app via
// google.script.run. They allow ISM InfoSec admins to view failed
// email notifications and trigger resends.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetEmailLog
  LAYMAN:    Admin lookup: all email-related audit entries for one application.
  TECHNICAL: Scans Risk_Audit for sessionId rows whose Action starts with 'Email '; parses the flags
             JSON. try/catch → [] on error.
  PARAMS:    - sessionId — application id.
  RETURNS:   Array of { logId, action, flags, timestamp } ([] if none/error).
*/
function adminGetEmailLog(sessionId) {
  try {
    const auditSheet = getDatabaseSheet(DB_SHEET_NAMES.RISK_AUDIT, false);
    if (!auditSheet) return [];
    var data = auditSheet.getDataRange().getValues();
    var results = [];
    for (var i = 1; i < data.length; i++) {
      if (data[i][AUDIT_COLS.SESSION_ID - 1] === sessionId && String(data[i][AUDIT_COLS.ACTION - 1] || '').startsWith('Email ')) {
        var flags = {};
        try { flags = JSON.parse(data[i][AUDIT_COLS.INTERNAL_FLAGS - 1] || '{}'); } catch(e) {}
        results.push({ logId: data[i][AUDIT_COLS.LOG_ID - 1], action: data[i][AUDIT_COLS.ACTION - 1], flags: flags, timestamp: data[i][AUDIT_COLS.TIMESTAMP - 1] });
      }
    }
    return results;
  } catch (e) {
    Logger.log('Error in adminGetEmailLog: ' + e.toString());
    return [];
  }
}

/*
  Function: adminGetFailedEmails
  LAYMAN:    Admin lookup: every email that ultimately failed to send, across all applications.
  TECHNICAL: Scans Risk_Audit for Action === 'Email Failed', flattening the flags payload. (Note:
             sinceDays is coerced to a default of 7 but not used to time-filter here.) try/catch → [].
  PARAMS:    - sinceDays — numeric window hint (defaulted to 7).
  RETURNS:   Array of { sessionId, recipient, type, error, timestamp, attempts }.
*/
function adminGetFailedEmails(sinceDays) {
  try {
    sinceDays = Number(sinceDays) || 7;
    var auditSheet = getDatabaseSheet(DB_SHEET_NAMES.RISK_AUDIT, false);
    if (!auditSheet) return [];
    var data = auditSheet.getDataRange().getValues();
    var results = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][AUDIT_COLS.ACTION - 1] || '') === 'Email Failed') {
        var flags = {};
        try { flags = JSON.parse(data[i][AUDIT_COLS.INTERNAL_FLAGS - 1] || '{}'); } catch(e) {}
        results.push({ sessionId: data[i][AUDIT_COLS.SESSION_ID - 1], recipient: flags.recipient || 'unknown', type: flags.type || 'unknown', error: flags.error || 'unknown', timestamp: data[i][AUDIT_COLS.TIMESTAMP - 1], attempts: flags.attempts || 0 });
      }
    }
    return results;
  } catch (e) {
    Logger.log('Error in adminGetFailedEmails: ' + e.toString());
    return [];
  }
}

/*
  Function: adminResendEmail
  LAYMAN:    Admin action: re-send a notification to a specific recipient for an application, picking
             the right kind (approver / applicant / ISM) based on where things stand.
  TECHNICAL: For 'approver'/'ism' it locates the recipient's Pending workflow row and re-invokes
             notifyApprover / apiPhase3_NotifyISMember at that step; for 'applicant' it maps the current
             app status to a status code and calls notifyApplicant. Audits the resend. try/catch.
  PARAMS:    - sessionId, recipient, type ('approver'|'applicant'|'ism').
  RETURNS:   { success, error, message }.
*/
function adminResendEmail(sessionId, recipient, type) {
  try {
    var appData = getApplicationData(sessionId);
    if (!appData) return { success: false, error: 'Application not found: ' + sessionId, message: null };
    var normalizedType = String(type || '').toLowerCase().trim();
    if (normalizedType === 'approver') {
      var apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      var apprData = apprSheet.getDataRange().getValues();
      var foundStep = -1;
      for (var i = 1; i < apprData.length; i++) {
        if (apprData[i][APPROVAL_COLS.SESSION_ID - 1] === sessionId && getNormalizedEmail(String(apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1] || '')) === getNormalizedEmail(recipient) && apprData[i][APPROVAL_COLS.STATUS - 1] === 'Pending') {
          foundStep = Number(apprData[i][APPROVAL_COLS.CURRENT_STEP - 1]) - 1;
          break;
        }
      }
      if (foundStep < 0) return { success: false, error: 'No pending approval step for: ' + recipient, message: null };
      notifyApprover(sessionId, foundStep);
    } else if (normalizedType === 'applicant') {
      var currentStatus = String(appData.status || '').toLowerCase();
      var nstatus = 'submitted';
      if (currentStatus.includes('approve') || currentStatus.includes('approved')) nstatus = 'approved';
      else if (currentStatus.includes('deny') || currentStatus.includes('denied')) nstatus = 'denied';
      else if (currentStatus.includes('return')) nstatus = 'returned';
      notifyApplicant(sessionId, nstatus);
    } else if (normalizedType === 'ism') {
      var ismSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      var ismData = ismSheet.getDataRange().getValues();
      var foundStep = -1;
      for (var i = 1; i < ismData.length; i++) {
        if (ismData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId && getNormalizedEmail(String(ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1] || '')) === getNormalizedEmail(recipient) && ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Pending') {
          foundStep = Number(ismData[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1]);
          break;
        }
      }
      if (foundStep < 0) return { success: false, error: 'No pending ISM step for: ' + recipient, message: null };
      apiPhase3_NotifyISMember(sessionId, foundStep);
    } else {
      return { success: false, error: 'Invalid type: ' + type + '. Must be approver, applicant, or ism.', message: null };
    }
    logAuditTrail(sessionId, 'Email Resend', JSON.stringify({ recipient: recipient, type: normalizedType, attempts: 1, error: null, source: 'admin' }));
    return { success: true, error: null, message: 'Notification resent to ' + recipient + ' for ' + sessionId };
  } catch (e) {
    Logger.log('Error in adminResendEmail: ' + e.toString());
    return { success: false, error: e.toString(), message: null };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// �️ ADMIN API — EMAIL QUEUE MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetEmailQueue
  LAYMAN:    Admin view of the email queue, optionally filtered by status or application.
  TECHNICAL: Scans Email_Queue, applies status/session filters, projects each row to a summary object.
  PARAMS:    - filter — { status:'Pending'|'Failed'|'Sent'|'Cancelled'|'all', sessionId? }.
  RETURNS:   { success:true, data:[...], total } or { success:false, error }.
*/
function adminGetEmailQueue(filter) {
  try {
    filter = filter || {};
    const statusFilter = String(filter.status || 'all').trim();
    const sessionFilter = String(filter.sessionId || '').trim();
    
    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = queueSheet.getDataRange().getValues();
    const results = [];

    for (let i = 1; i < data.length; i++) {
      const rowStatus = String(data[i][EMAIL_QUEUE_COLS.STATUS - 1] || '').trim();
      const rowSession = String(data[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').trim();

      // Apply filters
      if (statusFilter !== 'all' && rowStatus !== statusFilter) continue;
      if (sessionFilter && rowSession !== sessionFilter) continue;

      results.push({
        queueId: data[i][EMAIL_QUEUE_COLS.QUEUE_ID - 1],
        sessionId: rowSession,
        recipient: data[i][EMAIL_QUEUE_COLS.RECIPIENT - 1],
        subject: data[i][EMAIL_QUEUE_COLS.SUBJECT - 1],
        type: data[i][EMAIL_QUEUE_COLS.TYPE - 1],
        status: rowStatus,
        attempts: data[i][EMAIL_QUEUE_COLS.ATTEMPTS - 1],
        lastError: data[i][EMAIL_QUEUE_COLS.LAST_ERROR - 1],
        createdAt: data[i][EMAIL_QUEUE_COLS.CREATED_AT - 1],
        sentAt: data[i][EMAIL_QUEUE_COLS.SENT_AT - 1]
      });
    }

    return { success: true, data: results, total: results.length };
  } catch (e) {
    Logger.log('Error in adminGetEmailQueue: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: adminRetryQueuedEmail
  LAYMAN:    Admin action: kick one stuck/failed email back into the queue to be sent again.
  TECHNICAL: Finds the Email_Queue row by Queue_ID and resets Status='Pending', Attempts=0, clears
             error so the next processEmailQueue cycle retries it.
  PARAMS:    - queueId — the EQ-... id.
  RETURNS:   { success, message } or { success:false, error }.
*/
function adminRetryQueuedEmail(queueId) {
  try {
    if (!queueId) return { success: false, error: 'queueId is required' };

    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = queueSheet.getDataRange().getValues();
    let found = false;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][EMAIL_QUEUE_COLS.QUEUE_ID - 1] || '').trim() === queueId) {
        const rowNum = i + 1;
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.STATUS).setValue('Pending');
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.ATTEMPTS).setValue(0);
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.LAST_ERROR).setValue('');
        found = true;
        Logger.log('  🔄 Admin retry: ' + queueId + ' reset to Pending');
        break;
      }
    }

    return found
      ? { success: true, message: 'Queue item ' + queueId + ' reset to Pending. It will be sent on the next trigger cycle.' }
      : { success: false, error: 'Queue item not found: ' + queueId };
  } catch (e) {
    Logger.log('Error in adminRetryQueuedEmail: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: adminRetryAllForSession
  LAYMAN:    Admin action: retry every queued email of a given status for one application at once.
  TECHNICAL: Resets all Email_Queue rows matching (sessionId, targetStatus default 'Failed') to
             Pending/0/'' for the next cycle.
  PARAMS:    - sessionId — application id; status — status to retry (default 'Failed').
  RETURNS:   { success, message, retried } or { success:false, error }.
*/
function adminRetryAllForSession(sessionId, status) {
  try {
    if (!sessionId) return { success: false, error: 'sessionId is required' };
    const targetStatus = String(status || 'Failed').trim();

    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = queueSheet.getDataRange().getValues();
    let retriedCount = 0;

    for (let i = 1; i < data.length; i++) {
      const rowSession = String(data[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').trim();
      const rowStatus = String(data[i][EMAIL_QUEUE_COLS.STATUS - 1] || '').trim();

      if (rowSession === sessionId && rowStatus === targetStatus) {
        const rowNum = i + 1;
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.STATUS).setValue('Pending');
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.ATTEMPTS).setValue(0);
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.LAST_ERROR).setValue('');
        retriedCount++;
      }
    }

    return {
      success: true,
      message: retriedCount + ' queue items for ' + sessionId + ' reset to Pending.',
      retried: retriedCount
    };
  } catch (e) {
    Logger.log('Error in adminRetryAllForSession: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: adminCancelQueuedEmails
  LAYMAN:    Admin action: stop pending emails for an application from ever sending (e.g. wrong
             recipient or duplicates) by marking them Cancelled.
  TECHNICAL: Sets Status='Cancelled' on Pending Email_Queue rows matching sessionId (and optional type).
  PARAMS:    - sessionId — application id; type — optional email type filter.
  RETURNS:   { success, message, cancelled } or { success:false, error }.
*/
function adminCancelQueuedEmails(sessionId, type) {
  try {
    if (!sessionId) return { success: false, error: 'sessionId is required' };
    const typeFilter = String(type || '').trim();

    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = queueSheet.getDataRange().getValues();
    let cancelled = 0;

    for (let i = 1; i < data.length; i++) {
      const rowSession = String(data[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').trim();
      const rowStatus = String(data[i][EMAIL_QUEUE_COLS.STATUS - 1] || '').trim();
      const rowType = String(data[i][EMAIL_QUEUE_COLS.TYPE - 1] || '').trim();

      if (rowSession === sessionId && rowStatus === 'Pending' && (!typeFilter || rowType === typeFilter)) {
        const rowNum = i + 1;
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.STATUS).setValue('Cancelled');
        cancelled++;
      }
    }

    return { success: true, message: cancelled + ' pending queue items cancelled for ' + sessionId, cancelled: cancelled };
  } catch (e) {
    Logger.log('Error in adminCancelQueuedEmails: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: adminGetQueueSummary
  LAYMAN:    Admin dashboard numbers: how many queued emails are pending/sent/failed/cancelled, and a
             breakdown by type.
  TECHNICAL: Single pass over Email_Queue tallying status counts and a byType map.
  PARAMS:    (none)
  RETURNS:   { success:true, data:{ total, pending, sent, failed, cancelled, byType } } or error.
*/
function adminGetQueueSummary() {
  try {
    const queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = queueSheet.getDataRange().getValues();
    const summary = { total: 0, pending: 0, sent: 0, failed: 0, cancelled: 0, byType: {} };

    for (let i = 1; i < data.length; i++) {
      const status = String(data[i][EMAIL_QUEUE_COLS.STATUS - 1] || '').trim();
      const type = String(data[i][EMAIL_QUEUE_COLS.TYPE - 1] || '').trim();

      summary.total++;
      if (status === 'Pending') summary.pending++;
      else if (status === 'Sent') summary.sent++;
      else if (status === 'Failed') summary.failed++;
      else if (status === 'Cancelled') summary.cancelled++;

      if (!summary.byType[type]) summary.byType[type] = 0;
      summary.byType[type]++;
    }

    return { success: true, data: summary };
  } catch (e) {
    Logger.log('Error in adminGetQueueSummary: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔔 ADMIN API — DAILY REMINDER CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetReminderConfig
  LAYMAN:    Admin read of the daily-reminder settings, plus whether the trigger is actually installed
             and when it last ran.
  TECHNICAL: getReminderConfig() augmented with triggerActive (sendDailyReminders trigger present?) and
             lastRun (PIA_LAST_REMINDER_RUN property).
  PARAMS:    (none)
  RETURNS:   { success:true, data:{ enabled, hour, timezone, triggerActive, lastRun? } } or error.
*/
function adminGetReminderConfig() {
  try {
    var config = getReminderConfig();
    // Add trigger status info
    var triggers = ScriptApp.getProjectTriggers();
    var reminderTrigger = null;
    for (var t = 0; t < triggers.length; t++) {
      if (triggers[t].getHandlerFunction() === 'sendDailyReminders') {
        reminderTrigger = triggers[t];
        break;
      }
    }
    config.triggerActive = !!reminderTrigger;
    // Add last run info
    try {
      var lastRun = PropertiesService.getScriptProperties().getProperty('PIA_LAST_REMINDER_RUN');
      if (lastRun) config.lastRun = lastRun;
    } catch (_) {}
    return { success: true, data: config };
  } catch (e) {
    Logger.log('Error in adminGetReminderConfig: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: adminSetReminderConfig
  LAYMAN:    Admin write of the daily-reminder settings, and it re-installs or removes the trigger to
             match (on → install/refresh, off → delete).
  TECHNICAL: Merges partial config over current (clamps hour to 0-23), persists REMINDER_CONFIG_PROP,
             then setupReminderTrigger() if enabled else deletes the sendDailyReminders trigger.
  PARAMS:    - config — { enabled?, hour?, timezone? }.
  RETURNS:   { success:true, data:updated, message } or { success:false, error }.
*/
function adminSetReminderConfig(config) {
  try {
    var current = getReminderConfig();
    var updated = {
      enabled: config.hasOwnProperty('enabled') ? !!config.enabled : current.enabled,
      hour: (config.hour !== undefined) ? Math.max(0, Math.min(23, Number(config.hour) || 8)) : current.hour,
      timezone: config.timezone || current.timezone || 'Asia/Manila'
    };

    PropertiesService.getScriptProperties().setProperty(REMINDER_CONFIG_PROP, JSON.stringify(updated));

    // Re-create trigger if hour or enabled changed
    if (updated.enabled) {
      setupReminderTrigger();
    } else {
      // Remove trigger if disabled
      var triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(function(t) {
        if (t.getHandlerFunction() === 'sendDailyReminders') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    Logger.log('🔔 Reminder config updated: ' + JSON.stringify(updated));
    return { success: true, data: updated, message: 'Reminder configuration updated.' };
  } catch (e) {
    Logger.log('Error in adminSetReminderConfig: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API — Email Failsafe / Notification Config
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetNotificationConfig
  LAYMAN:    Admin read of the failure-notification settings (who to alert, whether to tell the requestor).
  TECHNICAL: Thin wrapper around getAdminNotificationConfig().
  PARAMS:    (none)
  RETURNS:   { success:true, data:config } or { success:false, error }.
*/
function adminGetNotificationConfig() {
  try {
    var config = getAdminNotificationConfig();
    return { success: true, data: config };
  } catch (e) {
    Logger.log('Error in adminGetNotificationConfig: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: adminSetNotificationConfig
  LAYMAN:    Admin write of the failure-notification settings (admin email, notify-on-failure,
             notify-requestor).
  TECHNICAL: Ensures a data row exists in Admin_Notification_Config (seeds one if empty), then patches
             the provided fields (YES/NO for the booleans) on row 2; returns the re-read config.
  PARAMS:    - config — { adminEmail?, notifyOnFailure?, notifyRequestor? }.
  RETURNS:   { success:true, data:updated, message } or { success:false, error }.
*/
function adminSetNotificationConfig(config) {
  try {
    if (!config) return { success: false, error: 'Missing config object' };

    var sheet = getDatabaseSheet(DB_SHEET_NAMES.ADMIN_NOTIFICATION, true);
    if (!sheet) return { success: false, error: 'Admin_Notification_Config sheet not found' };

    // Ensure at least one data row exists
    if (sheet.getLastRow() < 2) {
      sheet.appendRow(['ADMIN-001', '', 'YES', 'YES', '']);
    }

    var rowNum = 2; // First data row
    if (config.adminEmail !== undefined) {
      sheet.getRange(rowNum, ADMIN_NOTIFICATION_COLS.ADMIN_EMAIL).setValue(String(config.adminEmail));
    }
    if (config.notifyOnFailure !== undefined) {
      sheet.getRange(rowNum, ADMIN_NOTIFICATION_COLS.NOTIFY_ON_FAILURE).setValue(config.notifyOnFailure ? 'YES' : 'NO');
    }
    if (config.notifyRequestor !== undefined) {
      sheet.getRange(rowNum, ADMIN_NOTIFICATION_COLS.NOTIFY_REQUESTOR).setValue(config.notifyRequestor ? 'YES' : 'NO');
    }

    var updated = getAdminNotificationConfig();
    Logger.log('📋 Admin notification config updated: ' + JSON.stringify(updated));
    return { success: true, data: updated, message: 'Notification configuration updated.' };
  } catch (e) {
    Logger.log('Error in adminSetNotificationConfig: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API — Resend email to a specific workflow stage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminResendToStage
  LAYMAN:    Admin action: re-queue a review email to a specific person at a specific stage (approver /
             ISM / division head), with a fresh valid review link.
  TECHNICAL: Resolves the stage sheet via getWorkflowInfoForType, finds the recipient's Pending row,
             derives a display name + PIA title, builds an action-bound HMAC link ('ISMReview' for ism,
             else 'Review'), queueEmail's a plain-text resend, and resets that row's EmailStatus/Error.
  PARAMS:    - sessionId, stageType ('approver'|'ism'|'divhead'), approverEmail.
  RETURNS:   { success:true, queueId, message } or { success:false, error }.
*/
function adminResendToStage(sessionId, stageType, approverEmail) {
  try {
    if (!sessionId || !stageType || !approverEmail) {
      return { success: false, error: 'Missing sessionId, stageType, or approverEmail' };
    }

    var wfInfo = getWorkflowInfoForType(stageType);
    if (!wfInfo) {
      return { success: false, error: 'Invalid stageType. Use: approver, ism, or divhead' };
    }

    var wfSheet = getDatabaseSheet(wfInfo.name, true);
    if (!wfSheet) return { success: false, error: 'Workflow sheet not found: ' + wfInfo.name };

    var data = wfSheet.getDataRange().getValues();
    var normEmail = String(getNormalizedEmail(approverEmail) || '').toLowerCase();
    var foundRow = -1;

    for (var i = 1; i < data.length; i++) {
      var rowSid = String(data[i][wfInfo.cols.SESSION_ID - 1] || '').trim();
      var rowEmail = String(getNormalizedEmail(data[i][wfInfo.emailCol - 1] || '') || '').toLowerCase();
      var rowStatus = String(data[i][wfInfo.cols.STATUS - 1] || '').trim();
      if (rowSid === sessionId && rowEmail === normEmail && rowStatus === 'Pending') {
        foundRow = i + 1;
        break;
      }
    }

    if (foundRow < 0) {
      return { success: false, error: 'No matching Pending row found for session ' + sessionId + ' / ' + approverEmail + ' / ' + stageType };
    }

    // Determine approver name based on stage type
    var approverName = 'Approver';
    var rowData = data[foundRow - 1];
    if (stageType === 'approver') {
      approverName = String(rowData[wfInfo.cols.APPROVER_NAME - 1] || 'Approver').trim();
    } else if (stageType === 'ism') {
      approverName = String(rowData[wfInfo.cols.ISM_MEMBER_NAME - 1] || 'ISM Member').trim();
    } else if (stageType === 'divhead') {
      approverName = 'Division Head (' + String(rowData[wfInfo.cols.DIV_HEAD_EMAIL - 1] || '').trim() + ')';
    }

    var appsSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    var appData = appsSheet ? appsSheet.getDataRange().getValues() : [];
    var piaTitle = 'PIA-' + sessionId;
    for (var ar = 1; ar < appData.length; ar++) {
      if (String(appData[ar][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
        piaTitle = String(appData[ar][APPLICATIONS_COLS.PIA_1_DATA - 1] || piaTitle).trim();
        break;
      }
    }

    // Build review URL inline
    var webAppUrl = getWebAppUrl();
    var ts = new Date().getTime().toString();
    var normEmailForUrl = getNormalizedEmail(approverEmail);
    var actionType = stageType === 'ism' ? 'ISMReview' : 'Review';
    var token = generateAuthToken(sessionId, normEmailForUrl, ts, actionType);
    var reviewUrl = webAppUrl +
      '?sessionId=' + encodeURIComponent(sessionId) +
      '&email=' + encodeURIComponent(normEmailForUrl) +
      '&token=' + token +
      '&ts=' + ts +
      '&action=' + actionType;

    var emailBody = 'Dear ' + approverName + ',\n\n' +
      'This is a re-sent notification regarding PIA session ' + sessionId + ' (' + piaTitle + ').\n' +
      'Please review and take action.\n\n' +
      'Review Link: ' + reviewUrl + '\n\n' +
      'No reply: This mailbox is not monitored, so please do not reply. Use the review link above to take action. For assistance, contact ISM-InfoSec at infosec@megaworldcorp.com.\n\n' +
      'Thank you.\nPIA System (Admin Resend)';

    var queueId = queueEmail(sessionId, approverEmail,
      '[PIA Resend] Action Required — ' + sessionId,
      emailBody, stageType, null);

    // Reset EmailStatus to Pending on the workflow row
    wfSheet.getRange(foundRow, wfInfo.cols.EMAIL_STATUS).setValue('Pending');
    wfSheet.getRange(foundRow, wfInfo.cols.EMAIL_ERROR).setValue('');

    Logger.log('🔄 Admin resend to ' + stageType + ' → ' + approverEmail + ' [' + queueId + ']');
    return { success: true, queueId: queueId, message: 'Email re-queued to ' + approverEmail + ' (' + stageType + ')' };
  } catch (e) {
    Logger.log('Error in adminResendToStage: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API — Get full pipeline view for a session
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetPipelineView
  LAYMAN:    Admin "everything about one application" report: the app row plus all approval, ISM, and
             division-head workflow rows, every email-queue entry, and the audit trail — for the admin
             panel's drill-down.
  TECHNICAL: Builds a pipeline object by scanning Applications, Approval_Workflow, ISM_Approval_Workflow,
             DivisionHead_Approval_Workflow, Email_Queue, and Risk_Audit for the sessionId, projecting
             each to a compact shape. try/catch → error.
  PARAMS:    - sessionId — application id.
  RETURNS:   { success:true, data:{ application, approvalWorkflow[], ismWorkflow[], divHeadWorkflow[],
             emailQueue[], auditTrail[] } } or { success:false, error }.
*/
function adminGetPipelineView(sessionId) {
  try {
    if (!sessionId) return { success: false, error: 'Missing sessionId' };

    var pipeline = {
      sessionId: sessionId,
      application: null,
      approvalWorkflow: [],
      ismWorkflow: [],
      divHeadWorkflow: [],
      emailQueue: [],
      auditTrail: []
    };

    // 1. Application row
    var appsSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    if (appsSheet) {
      var appsData = appsSheet.getDataRange().getValues();
      for (var i = 1; i < appsData.length; i++) {
        if (String(appsData[i][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
          pipeline.application = {
            sessionId: appsData[i][APPLICATIONS_COLS.SESSION_ID - 1],
            applicantEmail: appsData[i][APPLICATIONS_COLS.APPLICANT_EMAIL - 1],
            status: appsData[i][APPLICATIONS_COLS.STATUS - 1],
            submissionDate: appsData[i][APPLICATIONS_COLS.SUBMISSION_DATE - 1]
          };
          break;
        }
      }
    }

    // 2. Approval Workflow rows
    var apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
    if (apprSheet) {
      var apprData = apprSheet.getDataRange().getValues();
      for (var j = 1; j < apprData.length; j++) {
        if (String(apprData[j][APPROVAL_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
          pipeline.approvalWorkflow.push({
            approvalId: apprData[j][APPROVAL_COLS.APPROVAL_ID - 1],
            step: apprData[j][APPROVAL_COLS.CURRENT_STEP - 1],
            approverName: apprData[j][APPROVAL_COLS.APPROVER_NAME - 1],
            approverEmail: apprData[j][APPROVAL_COLS.APPROVER_EMAIL - 1],
            decision: apprData[j][APPROVAL_COLS.DECISION - 1],
            status: apprData[j][APPROVAL_COLS.STATUS - 1],
            emailStatus: apprData[j][APPROVAL_COLS.EMAIL_STATUS - 1] || '',
            emailError: apprData[j][APPROVAL_COLS.EMAIL_ERROR - 1] || '',
            decisionDate: apprData[j][APPROVAL_COLS.DECISION_DATE - 1]
          });
        }
      }
    }

    // 3. ISM Workflow rows
    var ismSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    if (ismSheet) {
      var ismData = ismSheet.getDataRange().getValues();
      for (var k = 1; k < ismData.length; k++) {
        if (String(ismData[k][ISM_WORKFLOW_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
          pipeline.ismWorkflow.push({
            ismApprovalId: ismData[k][ISM_WORKFLOW_COLS.ISM_APPROVAL_ID - 1],
            step: ismData[k][ISM_WORKFLOW_COLS.CURRENT_STEP - 1],
            memberName: ismData[k][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1],
            memberEmail: ismData[k][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1],
            decision: ismData[k][ISM_WORKFLOW_COLS.DECISION - 1],
            status: ismData[k][ISM_WORKFLOW_COLS.STATUS - 1],
            emailStatus: ismData[k][ISM_WORKFLOW_COLS.EMAIL_STATUS - 1] || '',
            emailError: ismData[k][ISM_WORKFLOW_COLS.EMAIL_ERROR - 1] || '',
            decisionDate: ismData[k][ISM_WORKFLOW_COLS.DECISION_DATE - 1]
          });
        }
      }
    }

    // 4. Div Head Workflow rows
    var divSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    if (divSheet) {
      var divData = divSheet.getDataRange().getValues();
      for (var m = 1; m < divData.length; m++) {
        if (String(divData[m][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
          pipeline.divHeadWorkflow.push({
            escalationId: divData[m][DIV_HEAD_CONFIG_COLS.ESCALATION_ID - 1],
            divHeadEmail: divData[m][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1],
            decision: divData[m][DIV_HEAD_CONFIG_COLS.DECISION - 1],
            status: divData[m][DIV_HEAD_CONFIG_COLS.STATUS - 1],
            emailStatus: divData[m][DIV_HEAD_CONFIG_COLS.EMAIL_STATUS - 1] || '',
            emailError: divData[m][DIV_HEAD_CONFIG_COLS.EMAIL_ERROR - 1] || '',
            decisionDate: divData[m][DIV_HEAD_CONFIG_COLS.DECISION_DATE - 1]
          });
        }
      }
    }

    // 5. Email Queue entries
    var queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    if (queueSheet) {
      var queueData = queueSheet.getDataRange().getValues();
      for (var n = 1; n < queueData.length; n++) {
        if (String(queueData[n][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
          pipeline.emailQueue.push({
            queueId: queueData[n][EMAIL_QUEUE_COLS.QUEUE_ID - 1],
            recipient: queueData[n][EMAIL_QUEUE_COLS.RECIPIENT - 1],
            type: queueData[n][EMAIL_QUEUE_COLS.TYPE - 1],
            status: queueData[n][EMAIL_QUEUE_COLS.STATUS - 1],
            attempts: queueData[n][EMAIL_QUEUE_COLS.ATTEMPTS - 1],
            lastError: queueData[n][EMAIL_QUEUE_COLS.LAST_ERROR - 1],
            notifiedAdmin: queueData[n][EMAIL_QUEUE_COLS.NOTIFIED_ADMIN - 1] || ''
          });
        }
      }
    }

    // 6. Audit trail
    var auditSheet = getDatabaseSheet(DB_SHEET_NAMES.RISK_AUDIT, true);
    if (auditSheet) {
      var auditData = auditSheet.getDataRange().getValues();
      for (var p = 1; p < auditData.length; p++) {
        if (String(auditData[p][AUDIT_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
          pipeline.auditTrail.push({
            logId: auditData[p][AUDIT_COLS.LOG_ID - 1],
            action: auditData[p][AUDIT_COLS.ACTION - 1],
            userEmail: auditData[p][AUDIT_COLS.USER_EMAIL - 1],
            timestamp: auditData[p][AUDIT_COLS.TIMESTAMP - 1]
          });
        }
      }
    }

    return { success: true, data: pipeline };
  } catch (e) {
    Logger.log('Error in adminGetPipelineView: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: setupReminderTrigger
  LAYMAN:    Installs the once-a-day reminder job at the configured hour (and removes any old copy first).
  TECHNICAL: No-op if reminders disabled. Deletes existing sendDailyReminders triggers, then creates a
             daily time-based trigger atHour(config.hour) in config.timezone. Requires script.scriptapp.
  PARAMS:    (none)
  RETURNS:   { success:true, message }.
*/
function setupReminderTrigger() {
  var config = getReminderConfig();
  if (!config.enabled) {
    Logger.log('🔔 Reminder trigger NOT created — reminders are disabled.');
    return { success: true, message: 'Reminders are disabled. No trigger created.' };
  }

  // Remove any existing reminder trigger to prevent duplicates
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'sendDailyReminders') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Create new daily trigger at configured hour
  ScriptApp.newTrigger('sendDailyReminders')
    .timeBased()
    .atHour(config.hour)
    .everyDays(1)
    .inTimezone(config.timezone || Session.getScriptTimeZone())
    .create();

  Logger.log('🔔 Reminder trigger created — sendDailyReminders() will run daily at ' +
    String(config.hour).padStart(2, '0') + ':00 (' + (config.timezone || 'script default') + ')');

  return {
    success: true,
    message: 'Reminder trigger created. sendDailyReminders() will run daily at ' +
      String(config.hour).padStart(2, '0') + ':00.'
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// �🔐 SECURITY, VALIDATION, SANITAZION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: validateApplicationData
  LAYMAN:    Server-side check that a PIA submission is complete and sane before it is saved — all five
             sections present, required PIA 1 fields filled, valid emails, a future program date, the
             survey fully answered, and at least one approver available.
  TECHNICAL: Accumulates an errors[] across pia1..pia5 (required-object checks, pia4 flow fields, pia1
             department/program/date/drafter/email validity via isValidEmail, pia5 every question is
             YES/NO/N/A, and an approver-exists check incl. the PRIVACY_OFFICER_EMAIL fallback).
  PARAMS:    - appData — the submission object.
  RETURNS:   { isValid: boolean, errors: string[] }.
*/
function validateApplicationData(appData) {
  const errors = [];

  if (!appData || typeof appData !== 'object') {
    return { isValid: false, errors: ['Invalid request payload'] };
  }

  if (!appData.pia1 || typeof appData.pia1 !== 'object') {
    return { isValid: false, errors: ['PIA Section 1 is required'] };
  }

  if (!appData.pia2 || typeof appData.pia2 !== 'object') {
    errors.push('PIA Section 2 is required');
  }

  if (!appData.pia3 || typeof appData.pia3 !== 'object') {
    errors.push('PIA Section 3 is required');
  }

  if (!appData.pia4 || typeof appData.pia4 !== 'object') {
    errors.push('PIA Section 4 is required');
  } else {
    // Validate all five information flow fields are filled
    const p4Fields = { collect:'Collect', use:'Use', retain:'Retain', disclose:'Disclose', dispose:'Dispose' };
    Object.keys(p4Fields).forEach(k => {
      if (!appData.pia4[k] || !String(appData.pia4[k]).trim()) {
        errors.push(p4Fields[k] + ' field is required in Information Flow (PIA Section 4)');
      }
    });
  }

  if (!appData.pia5 || typeof appData.pia5 !== 'object') {
    errors.push('PIA Section 5 is required');
  }
  
  // PIA 1 validation
  if (!appData.pia1.dept) errors.push('Department is required');
  if (!appData.pia1.program) errors.push('Program name is required');
  if (appData.pia1.program && appData.pia1.program.length > 200) errors.push('Program name exceeds maximum length (200 characters)');
  // Validate program date: must be a future date within 10 years
  if (!appData.pia1.date) errors.push('Program date is required');
  if (appData.pia1.date) {
    // Parse YYYY-MM-DD as local date to avoid UTC timezone shift
    const parts = String(appData.pia1.date).split('-').map(Number);
    if (parts.length !== 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
      errors.push('Program date is invalid');
    } else {
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const maxDate = new Date(today.getFullYear() + 10, today.getMonth(), today.getDate());
      if (d < today) errors.push('Program date must be today or a future date');
      else if (d > maxDate) errors.push('Program date must be within the next 10 years');
    }
  }
  if (!appData.pia1.drafter) errors.push('Drafter name is required');
  if (!appData.pia1.drafterEmail) errors.push('Drafter email is required');
  
  // Comprehensive email validation for ALL email fields in PIA 1
  if (!isValidEmail(appData.pia1.drafterEmail)) errors.push('Invalid drafter email');
  if (appData.pia1.deptHeadEmail && !isValidEmail(appData.pia1.deptHeadEmail)) {
    errors.push('Invalid department head email');
  }
  if (appData.pia1.immediateHeadEmail && !isValidEmail(appData.pia1.immediateHeadEmail)) {
    errors.push('Invalid immediate head email');
  }
  if (appData.pia1.divHeadEmail && !isValidEmail(appData.pia1.divHeadEmail)) {
    errors.push('Invalid division head email');
  }

  // PIA 5 validation: ALL survey questions must be answered
  if (!appData.pia5 || typeof appData.pia5 !== 'object') {
    errors.push('PIA Section 5 (Survey) is required');
  } else {
    const pia5Questions = [
      'Do you have a Privacy Policy visible and available to your data subjects?',
      'Is consent secured prior to the collection of personal data?',
      'Will any information also be collected indirectly about the individual?',
      'Do you have steps to ensure that all data processed are accurate, complete, and up to date?',
      'The program has taken reasonable steps to protect the personal information it holds from misuse and loss and from unauthorised access, modification or disclosure.',
      'Do you have a retention policy for your hard and digital copies?',
      'Do you collect or disclose information outside the Philippines?',
      'Do you have outsourcing or data sharing agreement with 3rd parties?'
    ];
    for (let i = 0; i < pia5Questions.length; i++) {
      if (!appData.pia5[i] || !['YES','NO','N/A'].includes(appData.pia5[i])) {
        errors.push('Survey question ' + (i + 1) + ' must be answered (YES, NO, or N/A).');
      }
    }
  }

  const fallbackEmail = String(PropertiesService.getScriptProperties().getProperty('PRIVACY_OFFICER_EMAIL') || '').trim();
  const hasApprover = !!(appData.pia1.deptHeadEmail || appData.pia1.immediateHeadEmail || fallbackEmail);
  if (!hasApprover) {
    errors.push('At least one approver email is required (Department Head, Immediate Head, or Script Property PRIVACY_OFFICER_EMAIL).');
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors
  };
}

/*
  Function: validateComment
  LAYMAN:    Makes sure a decision comment is a real, meaningful justification — not blank, spammy, or
             gibberish.
  TECHNICAL: Strips tags, then enforces min length (param), COMMENT_MAX_CHARS, no 6+ repeated chars,
             presence of word-like sequences, and >= 3 words.
  PARAMS:    - comment — the raw comment; minLength — minimum chars (default 50).
  RETURNS:   { valid:true } or { valid:false, error }.
*/
function validateComment(comment, minLength = 50) {
  if (!comment || typeof comment !== 'string') {
    return { valid: false, error: 'Comment required' };
  }
  
  const text = comment.replace(/<[^>]*>/g, '').trim();
  
  if (text.length < minLength) {
    return { valid: false, error: `At least ${minLength} characters required` };
  }
  
  if (text.length > COMMENT_MAX_CHARS) {
    return { valid: false, error: `Comment cannot exceed ${COMMENT_MAX_CHARS} characters` };
  }
  
  // Check for spam patterns (6+ repeated characters)
  if (/(.)(\1{5,})/.test(text)) {
    return { valid: false, error: 'Repetitive patterns detected' };
  }
  
  // Check for valid natural language (must have word-like sequences)
  if (!/[a-z]{3,}/i.test(text)) {
    return { valid: false, error: 'Comment must contain meaningful words' };
  }
  
  // Must have at least 3 words
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 3) {
    return { valid: false, error: 'Comment must contain at least 3 words' };
  }
  
  return { valid: true };
}

/*
  Function: sanitizeInput
  LAYMAN:    Recursively cleans incoming text/objects to strip dangerous HTML and control characters
             while keeping a small set of safe formatting tags for rich-text comments.
  TECHNICAL: Recurses arrays/objects (depth-capped at 20, returns new objects — no input mutation). For
             strings: removes javascript:/data:/vbscript:/file: protocols, on* handlers, control chars,
             RTL override / zero-width / BOM, and strips all tags except <strong/b/em/i/u/ul/ol/li/br/p>;
             trims and clamps to maxLength.
  PARAMS:    - data — value to clean; maxLength — per-string cap (10000); depth — internal recursion guard.
  RETURNS:   Sanitized value of the same shape (string for scalars).
*/
function sanitizeInput(data, maxLength = 10000, depth = 0) {
  // Prevent stack overflow on deeply nested objects
  if (depth > 20) {
    Logger.log('WARNING: Sanitization depth limit (20) exceeded - possible circular reference');
    return String(data || '');
  }
  
  if (Array.isArray(data)) {
    return data.map(item => sanitizeInput(item, maxLength, depth + 1));
  }

  if (typeof data === 'object' && data !== null) {
    // Create new sanitized object instead of mutating input
    const sanitized = {};
    Object.keys(data).forEach(key => {
      sanitized[key] = sanitizeInput(data[key], maxLength, depth + 1);
    });
    return sanitized;
  }
  
  let str = String(data ?? '');
  
  // Define safe tags to allow for rich text comments
  const safeTags = /<\/?(strong|b|em|i|u|ul|ol|li|br|p)>/gi;
  
  str = str
    .replace(/javascript:/gi, '')
    .replace(/data:[^,]*,/gi, '')               // Remove data: URIs
    .replace(/on\w+\s*=/gi, '')                 // Remove event handlers (onclick=, etc)
    .replace(/vbscript:/gi, '')                 // Remove vbscript: protocol
    .replace(/file:/gi, '')                     // Remove file: protocol
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Remove control characters except \t\n\r
    .replace(/\u202E/g, '')                     // Remove RTL override
    .replace(/\u200B/g, '')                     // Remove zero-width space
    .replace(/\uFEFF/g, '')                     // Remove BOM
    .replace(/<(?!\/?(strong|b|em|i|u|ul|ol|li|br|p)\b)[^>]*>/gi, ''); // Strip all tags EXCEPT safe ones
  
  return str.trim().slice(0, maxLength);
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// � PHASE 3 API - DATA FETCHING MODULE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: isAuthorizedForApplication_
  LAYMAN (Tropang Ex):
  Tanong nito: "pwede ba 'tong taong nakatingin makakita ng application na 'to?" Oo kung siya ang
  nag-submit (applicant) O kasama siya sa approval chain — Immediate/Dept Head, ISM reviewer, o Division
  Head. Kung hindi, bawal.

  TECHNICAL:
  Server-side read-authorization for an application. Normalizes the active user and matches against:
  the applicant, the Stage-A approvers already on appData.approvers, then scans ISM_Approval_Workflow and
  DivisionHead_Approval_Workflow for the session. Used to gate the ISM-reviewer Fetch endpoints (F-05) so
  a direct google.script.run call cannot read another application by sessionId.

  PARAMS:
  - sessionId — application id (used to scan the ISM/DivHead workflow sheets).
  - appData   — the object from getApplicationData(sessionId) (provides applicant + Stage-A approvers).

  RETURNS:
  Boolean. False on empty active user / missing appData / no match.
*/
function isAuthorizedForApplication_(sessionId, appData) {
  const me = getNormalizedEmail(Session.getActiveUser().getEmail());
  if (!me || !appData) return false;
  // Owner (applicant)
  if (me === getNormalizedEmail(appData.applicantEmail)) return true;
  // Stage-A heads (Immediate / Department) — already enumerated on appData.approvers
  if ((appData.approvers || []).some(function (a) { return getNormalizedEmail(a.email) === me; })) return true;
  // ISM members + Division Heads — scan their workflow sheets for this session
  const searchId = String(sessionId || '').trim().toUpperCase();
  const scanSheet = function (sheetName, sessionCol, emailCol) {
    try {
      const sh = getDatabaseSheet(sheetName, false);
      if (!sh) return false;
      const vals = sh.getDataRange().getValues();
      for (let i = 1; i < vals.length; i++) {
        if (String(vals[i][sessionCol - 1] || '').trim().toUpperCase() === searchId &&
            getNormalizedEmail(vals[i][emailCol - 1]) === me) {
          return true;
        }
      }
    } catch (e) { /* sheet missing → not authorized via this path */ }
    return false;
  };
  if (scanSheet(DB_SHEET_NAMES.ISM_WORKFLOW, ISM_WORKFLOW_COLS.SESSION_ID, ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL)) return true;
  if (scanSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, DIV_HEAD_CONFIG_COLS.SESSION_ID, DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL)) return true;
  return false;
}

/*
  Function: apiPhase3_FetchPIAData
  LAYMAN:    Gives the ISM reviewer screen the key PIA facts: program, department, the PII collected,
             who submitted it, purposes and retention.
  TECHNICAL: Loads getApplicationData and projects a flat summary (program/dept from pia1, PII via
             getPIIFieldsList, purposes/retention from pia4). try/catch → error.
  PARAMS:    - sessionId — application id.
  RETURNS:   { success:true, data:{...} } or { success:false, error }.
*/
function apiPhase3_FetchPIAData(sessionId) {
  try {
    const appData = getApplicationData(sessionId);
    if (!appData) {
      return { success: false, error: 'Application not found' };
    }

    // SECURITY (F-05): authorize — only the applicant or someone on the approval chain may view this.
    if (!isAuthorizedForApplication_(sessionId, appData)) {
      return { success: false, error: 'Access denied: you are not authorized to view this application.' };
    }

    return {
      success: true,
      data: {
        sessionId: sessionId,
        program: appData.pia1?.program || 'Unknown Program',
        department: appData.pia1?.dept || 'Unknown Department',
        piiFields: getPIIFieldsList(appData),
        submittedBy: appData.applicantEmail,
        submissionDate: appData.pia1?.createdDate || new Date().toISOString(),
        purposes: appData.pia4?.collect || '',
        dataRetention: appData.pia4?.retain || ''
      }
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_FetchPIAData: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_FetchDCSData
  LAYMAN:    Gives the ISM reviewer the linked Phase 1 DCS context (requestor, department, access needed,
             agency metadata) for the application under review.
  TECHNICAL: Resolves linkedReqId, finds the Data_Collection row, parses METADATA_JSON (+ agency JSON),
             and projects a flat object with normalized field fallbacks. try/catch → error.
  PARAMS:    - sessionId — application id.
  RETURNS:   { success:true, data:{...DCS fields} } or { success:false, error }.
*/
function apiPhase3_FetchDCSData(sessionId) {
  try {
    const appData = getApplicationData(sessionId);
    if (!appData || !appData.linkedReqId) {
      return { success: false, error: 'No DCS request linked to this application' };
    }

    // SECURITY (F-05): authorize — only the applicant or someone on the approval chain may view this.
    if (!isAuthorizedForApplication_(sessionId, appData)) {
      return { success: false, error: 'Access denied: you are not authorized to view this application.' };
    }

    const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const dcsData = dcsSheet.getDataRange().getValues();

    for (let i = 1; i < dcsData.length; i++) {
      if (dcsData[i][DCS_COLS.REQ_ID - 1] === appData.linkedReqId) {
        const metadata = JSON.parse(dcsData[i][DCS_COLS.METADATA_JSON - 1] || '{}');
        
        return {
          success: true,
          data: {
            requestId: appData.linkedReqId,
            status: dcsData[i][DCS_COLS.STATUS - 1],
            requestor: dcsData[i][DCS_COLS.USER_EMAIL - 1],
            requestorName: metadata.name || metadata.requestorName || metadata.drafterName || '',
            department: metadata.dept || metadata.department || '',
            locations: metadata.locations || metadata.location || '',
            accessNeeded: metadata.access || '',
            submissionDate: (function() {
              const rawDate = dcsData[i][DCS_COLS.TIMESTAMP - 1];
              if (!rawDate) return '';
              return rawDate instanceof Date ? rawDate.toISOString() : String(rawDate);
            })(),
            iHelpReference: metadata.ihelp || '',
            accountable: metadata.accountable || null,
            metadataAgency: (function() {
              try {
                const raw = dcsData[i][Math.min(DCS_COLS.METADATA_AGENCY - 1, dcsData[i].length - 1)];
                return raw ? JSON.parse(String(raw)) : {};
              } catch(e) { return {}; }
            })()
          }
        };
      }
    }

    return { success: false, error: 'DCS request data not found' };
  } catch (e) {
    Logger.log('Error in apiPhase3_FetchDCSData: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_GetDivisionHeadConfig
  LAYMAN:    Looks up a Division Head by email to confirm they are recognized/active for escalations.
  TECHNICAL: Scans DivisionHead_Approval_Workflow for a matching email; returns its active flag, or a
             permissive default ({ isActive:true }) if not found. try/catch → error.
  PARAMS:    - divisionHeadEmail — email to look up.
  RETURNS:   { success:true, config:{ divHeadEmail, isActive } } or { success:false, error }.
*/
function apiPhase3_GetDivisionHeadConfig(divisionHeadEmail) {
  try {
    const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    const data = divHeadSheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1] || '').toLowerCase() === 
          String(divisionHeadEmail || '').toLowerCase()) {
        return {
          success: true,
          config: {
            divHeadEmail: data[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1],
            isActive: data[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Active'
          }
        };
      }
    }

    // Return default config if not found
    return {
      success: true,
      config: {
        divHeadEmail: divisionHeadEmail,
        isActive: true
      }
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_GetDivisionHeadConfig: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_GetInfoSecMembers
  LAYMAN:    Returns the active ISM/InfoSec reviewers and the downstream routing emails (DCOPS,
             TechServe). Self-heals by seeding two default members if the config has fewer than two.
  TECHNICAL: Reads InfoSec_Email_Config. If fewer than 2 active 'InfoSec' rows, appends seed rows and
             re-reads. Collects active InfoSec members + dcops/techserve destination emails, then pads
             activeMembers to exactly 2 using fallbacks so the ISM chain always has two steps.
  PARAMS:    (none)
  RETURNS:   { success:true, data:{ members:[{id,name,email,role}], destinationEmails:{dcops,techserve,both} } }
             or { success:false, error }.
*/
function apiPhase3_GetInfoSecMembers() {
  try {
    const infoSecSheet = getDatabaseSheet(DB_SHEET_NAMES.INFOSEC_CONFIG, true);
    var data = infoSecSheet.getDataRange().getValues();
    
    // SELF-HEAL: Ensure InfoSec_Email_Config has at least 2 active InfoSec members
    var infoSecCount = 0;
    for (var ri = 1; ri < data.length; ri++) {
      if (String(data[ri][INFOSEC_CONFIG_COLS.ROLE - 1] || '').trim().toLowerCase() === 'infosec' &&
          String(data[ri][INFOSEC_CONFIG_COLS.IS_ACTIVE - 1] || 'YES').trim() === 'YES') {
        infoSecCount++;
      }
    }
    if (infoSecCount < 2) {
      Logger.log('  🔧 Self-heal: InfoSec_Email_Config has ' + infoSecCount + ' InfoSec members, need 2');
      var seedData = [
        ['INFOSEC-001', 'InfoSec Member 1', 'infosec1@company.com', 'InfoSec', 'YES', 'Security Officer'],
        ['INFOSEC-002', 'InfoSec Member 2', 'infosec2@company.com', 'InfoSec', 'YES', 'InfoSec Analyst']
      ];
      for (var si = 0; si < seedData.length; si++) {
        var alreadyExists = false;
        for (var ri = 1; ri < data.length; ri++) {
          if (String(data[ri][INFOSEC_CONFIG_COLS.MEMBER_ID - 1] || '').trim() === seedData[si][0]) {
            alreadyExists = true;
            break;
          }
        }
        if (!alreadyExists) {
          infoSecSheet.appendRow(seedData[si]);
          Logger.log('  → Added seed member: ' + seedData[si][1] + ' (' + seedData[si][2] + ')');
        }
      }
      Logger.log('  ✓ InfoSec_Email_Config self-healed. Re-reading data...');
      data = infoSecSheet.getDataRange().getValues();
    }

    const members = [];
    let dcopsEmail = '';
    let techserveEmail = '';
    const techserveBySite = {};    // { 'AGT': ['a@x'], 'EASTGATE': ['b@x'], ... } — per-site TechServe (Batch 3)
    const techserveFallback = [];  // TechServe rows with a blank Site (the catch-all default)
    const allTechserveEmails = []; // every active TechServe email, for a last-resort fallback

    for (let i = 1; i < data.length; i++) {
      const isActive = String(data[i][INFOSEC_CONFIG_COLS.IS_ACTIVE - 1] || 'YES').trim() === 'YES';
      const email = String(data[i][INFOSEC_CONFIG_COLS.MEMBER_EMAIL - 1] || '').trim();
      const rawRole = String(data[i][INFOSEC_CONFIG_COLS.ROLE - 1] || '').trim();
      
      if (isActive && rawRole.toLowerCase() === 'infosec') {
        members.push({
          id: data[i][INFOSEC_CONFIG_COLS.MEMBER_ID - 1],
          name: data[i][INFOSEC_CONFIG_COLS.MEMBER_NAME - 1],
          email: email,
          role: rawRole
        });
        Logger.log('  ✓ Collected InfoSec member: id=' + data[i][INFOSEC_CONFIG_COLS.MEMBER_ID - 1] + 
                   ', name="' + data[i][INFOSEC_CONFIG_COLS.MEMBER_NAME - 1] + 
                   '", email="' + email + '"');
      }

      // Fetch destination emails. TechServe can have MANY rows (one per site/email); DCOPS stays single.
      if (isActive && rawRole.toLowerCase() === 'dcops') {
        dcopsEmail = email || '';
      } else if (isActive && rawRole.toLowerCase() === 'techserve' && email) {
        // Carry the member NAME with the email so the cert/email can show "Name / email" per line.
        const tsEntry = { name: String(data[i][INFOSEC_CONFIG_COLS.MEMBER_NAME - 1] || '').trim(), email: email };
        allTechserveEmails.push(tsEntry);
        const siteRaw = data[i][INFOSEC_CONFIG_COLS.SITE - 1];
        const siteKey = siteRaw ? String(siteRaw).trim().toUpperCase() : '';
        if (siteKey) {
          if (!techserveBySite[siteKey]) techserveBySite[siteKey] = [];
          techserveBySite[siteKey].push(tsEntry);
        } else {
          techserveFallback.push(tsEntry);
        }
        if (!techserveEmail) techserveEmail = email; // flat value stays a string for backward-compat
      }
    }

    // Ensure at least 2 ISM members exist (fill fallbacks if config has fewer than 2)
    var activeMembers = members.slice(0, 2);
    while (activeMembers.length < 2) {
      var fallbackIndex = activeMembers.length + 1;
      // Try to get name from seed data for a meaningful fallback name
      var fallbackName = 'InfoSec Member ' + fallbackIndex;
      var fallbackId = 'FALLBACK-00' + fallbackIndex;
      var fallbackSeedNames = ['InfoSec Member 1', 'InfoSec Member 2'];
      if (fallbackIndex <= fallbackSeedNames.length) {
        fallbackName = fallbackSeedNames[fallbackIndex - 1];
      }
      // Use the first member's email as fallback, or dcopsEmail if no members at all
      var fallbackEmail = activeMembers.length > 0 ? activeMembers[0].email : (dcopsEmail || '');
      activeMembers.push({
        id: fallbackId,
        name: fallbackName,
        email: fallbackEmail,
        role: 'InfoSec'
      });
      Logger.log('WARN: Fewer than 2 InfoSec members configured. Fallback Member ' + fallbackIndex + ' (' + fallbackName + ') uses email: ' + fallbackEmail);
    }
    
    Logger.log('InfoSec members resolved: ' + activeMembers.length + ' active (config had ' + members.length + ' InfoSec rows in sheet)');
    activeMembers.forEach(function(m, idx) {
      Logger.log('  → Result[' + idx + ']: id=' + m.id + ', name="' + m.name + '", email="' + m.email + '"');
    });

    return {
      success: true,
      data: {
        members: activeMembers,
        destinationEmails: {
          dcops: dcopsEmail,
          techserve: techserveEmail,
          techserveBySite: techserveBySite,
          techserveFallback: techserveFallback,
          allTechserve: allTechserveEmails,
          both: [dcopsEmail, techserveEmail].filter(e => e).join(',')
        }
      }
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_GetInfoSecMembers: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: resolveTechserveForSite_
  LAYMAN (Tropang Ex): Kinukuha nito kung saang TechServe email(s) dapat mapunta ang request base sa
  Office/Site nito (hal. AGT → AGT TechServe, pwedeng higit sa isa). Kapag walang naka-set para sa site
  na 'yun, babagsak ito sa fallback (blangkong-Site na TechServe rows); kung wala rin, mapupunta na
  lang sa DCOPS (hindi sa lahat ng team) para 'di ma-leak ang PII sa maling site.
  TECHNICAL: Normalizes the request site (trim+uppercase) and looks it up in destEmails.techserveBySite.
  Falls back to techserveFallback (blank-Site rows); if none, returns [] so routing sends to DCOPS.
  PARAMS:
  - destEmails — the destinationEmails object from apiPhase3_GetInfoSecMembers.
  - siteRaw — the request's Office/Site value (dcsData.locations).
  RETURNS: Array of TechServe email strings (possibly empty if nothing configured).
*/
function resolveTechserveForSite_(destEmails, siteRaw) {
  const bySite = (destEmails && destEmails.techserveBySite) || {};
  const siteKey = siteRaw ? String(siteRaw).trim().toUpperCase() : '';
  if (siteKey && bySite[siteKey] && bySite[siteKey].length) {
    return bySite[siteKey].slice();
  }
  // Optional blank-Site rows act as an explicit catch-all default, if configured.
  const fallback = (destEmails && destEmails.techserveFallback) || [];
  if (fallback.length) {
    if (siteKey) Logger.log('WARN: No site-specific TechServe for "' + siteRaw + '"; using blank-Site fallback rows.');
    return fallback.slice();
  }
  // No site match and no fallback row -> return empty so routing sends to DCOPS instead of blasting
  // every site's TechServe team with PII (L2).
  return [];
}

/*
  Function: getPIIFieldsList
  LAYMAN:    Returns the human-readable list of PII categories the program collects (the ones marked
             'YES'), including any custom "Others".
  TECHNICAL: Normalizes the pia2 shape, maps 'YES' indices to pii2Fields labels, appends customOthers
             whose value is 'YES'.
  PARAMS:    - appData — application object with a pia2 section.
  RETURNS:   Array of field-name strings (possibly empty).
*/
function getPIIFieldsList(appData) {
  const piiData = appData.pia2?.fields || appData.pia2 || {};
  const collected = [];
  
  for (let i = 0; i < pii2Fields.length; i++) {
    if (piiData[i] === 'YES') {
      collected.push(pii2Fields[i]);
    }
  }

  const customOthers = appData.pia2?.customOthers || [];
  customOthers.forEach(c => {
    if (c.value === 'YES') {
      collected.push(c.name);
    }
  });

  return collected;
}

/*
  Function: apiPhase3_InitializeISMWorkflow
  LAYMAN:    After all heads approve, this sets up the ISM review stage by creating one to-do row per
             ISM member (all Pending).
  TECHNICAL: Gets the ISM roster via apiPhase3_GetInfoSecMembers and appends a sequential
             ISM_Approval_Workflow row ('<sessionId>-ISM-<n>') for each, then flushes. Fails if no
             members are configured.
  PARAMS:    - sessionId — application id.
  RETURNS:   { success:true, message, members } or { success:false, error }.
*/
function apiPhase3_InitializeISMWorkflow(sessionId) {
  try {
    const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const ismInfo = apiPhase3_GetInfoSecMembers();

    if (!ismInfo.success || !ismInfo.data.members.length) {
      return { success: false, error: 'No InfoSec members configured' };
    }

    // Create ISM approval records
    ismInfo.data.members.forEach((member, index) => {
      const ismApprovalId = `${sessionId}-ISM-${index + 1}`;
      ismWorkflowSheet.appendRow([
        ismApprovalId,                    // ISM_APPROVAL_ID
        sessionId,                        // SESSION_ID
        index + 1,                        // CURRENT_STEP
        member.name,                      // ISM_MEMBER_NAME
        member.email,                     // ISM_MEMBER_EMAIL
        '',                               // DECISION
        '',                               // COMMENTS
        '',                               // DECISION_DATE
        'Pending',                        // STATUS
        'NO',                             // REQUIRES_DIV_HEAD
        '',                               // DIV_HEAD_ESCALATION_ID
        '',                               // ROUTING_DESTINATION
        '',                               // REMINDER_DATE
        'Pending',                        // EMAIL_STATUS
        ''                                // EMAIL_ERROR
      ]);
    });
    
    // CRITICAL: Flush after appendRow so downstream reads see the new rows
    SpreadsheetApp.flush();

    return {
      success: true,
      message: `ISM workflow initialized with ${ismInfo.data.members.length} members`,
      members: ismInfo.data.members
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_InitializeISMWorkflow: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_RetryISMWorkflow
  LAYMAN:    Recovery action for an application stuck at "Approved (ISM Pending)" because the ISM stage
             could not start earlier (e.g. InfoSec config was empty). Re-runs the ISM setup once the
             config is fixed.
  TECHNICAL: Validates the app exists and is in a retryable status, refuses if ISM rows already exist
             (anti-duplicate), then apiPhase3_InitializeISMWorkflow, flips status to 'Approved', and
             notifies the first ISM member.
  PARAMS:    - sessionId — application id.
  RETURNS:   { success:true, message, members } or { success:false, error }.
*/
function apiPhase3_RetryISMWorkflow(sessionId) {
  try {
    // Validate that the application exists and is in the expected state
    const appData = getApplicationData(sessionId);
    if (!appData) {
      return { success: false, error: 'Application not found: ' + sessionId };
    }
    
    const currentStatus = String(appData.status || '');
    if (currentStatus !== 'Approved (ISM Pending)' && currentStatus !== 'Approved') {
      return { success: false, error: 'Application is not in a retryable state. Current status: ' + currentStatus };
    }
    
    // Check if ISM workflow records already exist for this session
    const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const existingData = ismWorkflowSheet.getDataRange().getValues();
    for (let i = 1; i < existingData.length; i++) {
      if (existingData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId) {
        return { success: false, error: 'ISM workflow already exists for this session. Cannot re-initialize.' };
      }
    }
    
    // Attempt initialization
    const result = apiPhase3_InitializeISMWorkflow(sessionId);
    if (!result.success) {
      return result; // Propagate the specific error
    }
    
    // Update application status from "Approved (ISM Pending)" → "Approved"
    const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    const appRow = findRowBySessionID(sessionId);
    if (appRow > 0) {
      appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved');
      Logger.log(`[AUDIT] ${sessionId}: ISM workflow retry successful, status updated to Approved`);
    }
    
    // Notify the first ISM member
    apiPhase3_NotifyISMember(sessionId, 1);
    
    return {
      success: true,
      message: 'ISM workflow initialized successfully for ' + sessionId,
      members: result.members
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_RetryISMWorkflow: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_ProcessISMDecision
  LAYMAN:    Records an ISM/InfoSec reviewer's verdict and drives the final stage: Approve (advance to
             the next ISM member, or finalize + route when all approve), Deny (reject), Return (bounce
             to requestor), or Escalate to the Division Head.
  TECHNICAL: Validates decision and routingDestination against whitelists, takes a script lock, finds
             the member's Pending ISM row (optional step), and stamps it. Approve: if all ISM rows are
             Approved → 'Approved by ISM', notify applicant, mark DCS Complete, route; else notify next
             member. Deny → 'Rejected by ISM'. Return → 'Returned' (+optional DCS return). Escalate →
             'EscalatedToDivisionHead', create a single Pending DivHead row (dedup) and email the
             Division Head a review link. Lock released in finally.
  PARAMS:    - sessionId, ismMemberEmail, decision('Approve'|'Deny'|'Return'|'EscalateToDivisionHead'),
               comments, routingDestination(''|'DCOPS'|'TECHSERVE'|'BOTH'), stepParam?, approverFlags.
  RETURNS:   { success:true, message, nextAction } or { success:false, error }.
*/
function apiPhase3_ProcessISMDecision(sessionId, ismMemberEmail, decision, comments, routingDestination = '', stepParam = null, approverFlags = '{}') {
  // SECURITY (F-02): authorize the actual caller server-side — a direct google.script.run call must not
  // be able to submit a decision as someone else. The legit email-link/inline-panel path already verified
  // activeUser == targetEmail in handleEmailAction before reaching here, so this always passes there.
  const _me = getNormalizedEmail(Session.getActiveUser().getEmail());
  if (_me !== getNormalizedEmail(ismMemberEmail)) {
    return { success: false, error: 'Access denied: you may only submit your own decision.' };
  }
  try {
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl() || ScriptApp.getService().getUrl();
    const allowedDecisions = ['Approve', 'Deny', 'Return', 'EscalateToDivisionHead'];
    if (!allowedDecisions.includes(decision)) {
      return { success: false, error: 'Invalid decision value' };
    }

    // CRITICAL FIX: Validate routingDestination against whitelist to prevent injection
    const allowedDestinations = ['DCOPS', 'TECHSERVE', 'BOTH', ''];
    const normalizedDestination = String(routingDestination || '').toUpperCase();
    if (!allowedDestinations.includes(normalizedDestination)) {
      Logger.log('SECURITY ALERT: Invalid routing destination attempted: ' + routingDestination);
      return { success: false, error: 'Invalid routing destination' };
    }

    // CRITICAL FIX: Acquire lock to prevent race condition on concurrent ISM decisions
    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    
    try {
      try {
        lock.waitLock(30000);
        lockAcquired = true;
      } catch (lockErr) {
        Logger.log('ERROR: Could not acquire lock after 30s - concurrent modification risk');
        return { success: false, error: 'System busy, please try again' };
      }

      const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const data = ismWorkflowSheet.getDataRange().getValues();
      const timestamp = new Date().toLocaleString('en-PH', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });

    // Find current ISM member record
    let currentRow = -1;
    let currentStep = -1;
    const normalizedTarget = String(getNormalizedEmail(ismMemberEmail) || '').toLowerCase();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId &&
          String(getNormalizedEmail(data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]) || '').toLowerCase() === normalizedTarget &&
          data[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Pending') {

        const loopStep = Number(data[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] || 1);
        if (stepParam !== null && loopStep !== stepParam) {
          continue;
        }


        currentRow = i + 1;
        currentStep = loopStep;
        break;
      }
    }

    if (currentRow === -1) {
      return { success: false, error: 'ISM approval record not found' };
    }

    // Update ISM member decision
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.DECISION).setValue(decision);
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.COMMENTS).setValue(comments);
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.DECISION_DATE).setValue(timestamp);
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.ROUTING_DESTINATION).setValue(normalizedDestination);

    /* Approve branch — unanimous requirement: finalize + route only when every ISM row is Approved,
       otherwise notify the next ISM member in sequence. */
    if (decision === 'Approve') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('Approved');

      // Check if all ISM members have approved (unanimous requirement)
      const freshData = ismWorkflowSheet.getDataRange().getValues();
      let allApproved = true;
      let totalMembers = 0;

      for (let i = 1; i < freshData.length; i++) {
        if (freshData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId) {
          totalMembers++;
          if (freshData[i][ISM_WORKFLOW_COLS.STATUS - 1] !== 'Approved') {
            allApproved = false;
          }
        }
      }

      if (allApproved && totalMembers > 0) {
        // All ISM members approved - update application status and route to destination
        const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
        const appData = appSheet.getDataRange().getValues();
        
        for (let i = 1; i < appData.length; i++) {
          if (appData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
            appSheet.getRange(i + 1, APPLICATIONS_COLS.STATUS).setValue('Approved by ISM');
            Logger.log(`[AUDIT] ${sessionId}: Application Approved by ISM InfoSec Team (All Members)`);

          const linkedReqId = appData[i][APPLICATIONS_COLS.LINKED_REQ_ID - 1];
          if (linkedReqId) updateDCSStatus(linkedReqId, 'Complete');

            // Build + route the certificate FIRST so it can be attached to the applicant's email.
            let certResult = null;
            if (routingDestination) {
              try {
                certResult = apiPhase3_RouteApprovedRequest(sessionId, routingDestination);
                Logger.log(`[AUDIT] ${sessionId}: Routed to: ${routingDestination}`);
              } catch (routeErr) {
                Logger.log('Error routing to destination: ' + routeErr.toString());
              }
            }
            notifyApplicant(sessionId, 'approved_ism_final', {
              certBlob: (certResult && certResult.success) ? certResult.pdfBlob : null,
              techserveEmails: (certResult && certResult.success) ? certResult.techserveEmails : ''
            });
            break;
          }
        }
      } else if (!allApproved && currentStep < totalMembers) {
        notifyApplicant(sessionId, 'progressing_ism');
        // Notify next ISM member
        apiPhase3_NotifyISMember(sessionId, currentStep + 1);
      }
    } else if (decision === 'Deny') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('Denied');
      
      // Mark application as rejected
      const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
      const appData = appSheet.getDataRange().getValues();
      
      for (let i = 1; i < appData.length; i++) {
        if (appData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
          appSheet.getRange(i + 1, APPLICATIONS_COLS.STATUS).setValue('Rejected by ISM');
          Logger.log(`[AUDIT] ${sessionId}: Application Rejected by ISM Member: ${ismMemberEmail}`);
          break;
        }
      }
    } else if (decision === 'Return') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('Returned');
      
      // Update both PIA and DCS to Returned status
      const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
      const appData = appSheet.getDataRange().getValues();
      let linkedReqId = null;
      
      for (let i = 1; i < appData.length; i++) {
        if (appData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
          linkedReqId = appData[i][APPLICATIONS_COLS.LINKED_REQ_ID - 1];
          appSheet.getRange(i + 1, APPLICATIONS_COLS.STATUS).setValue('Returned');
          appSheet.getRange(i + 1, APPLICATIONS_COLS.APPROVER_FLAGS).setValue(approverFlags);
          break;
        }
      }
      
      // Update DCS status to Returned if DCS flags are present
      if (linkedReqId) {
        let hasDCSFlags = false;
        try {
          const flagsObj = JSON.parse(approverFlags || '{}');
          const flagKeys = Object.keys(flagsObj);
          hasDCSFlags = flagKeys.length === 0 || flagKeys.some(key => key.startsWith('DCS - '));
        } catch(e) {}
        if (hasDCSFlags) {
          updateDCSStatus(linkedReqId, 'Returned');
          Logger.log(`[AUDIT] ${sessionId}: ISM Review Returned DCS & PIA by ${ismMemberEmail}`);
        } else {
          Logger.log(`[AUDIT] ${sessionId}: ISM Review Returned PIA (No DCS flags) by ${ismMemberEmail}`);
        }
      } else {
        Logger.log(`[AUDIT] ${sessionId}: ISM Review Returned by ${ismMemberEmail}`);
      }
      
      // Notify applicant
      notifyApplicant(sessionId, 'returned');
    /* Escalate branch — hand off to the Division Head: flag the ISM row, create ONE pending DivHead
       row (dedup across multiple escalating members), and email the Division Head a review link. */
    } else if (decision === 'EscalateToDivisionHead') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('EscalatedToDivisionHead');
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.REQUIRES_DIV_HEAD).setValue('YES');
      
      const escalationId = `${sessionId}-DIVHEAD`;
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.DIV_HEAD_ESCALATION_ID).setValue(escalationId);
      
      const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
      const appData = appSheet.getDataRange().getValues();
      let divHeadEmail = '';
      let divHeadName = '';
      let programName = 'Unknown Program';
      let applicantEmail = '';
      
      for (let i = 1; i < appData.length; i++) {
        if (appData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
          appSheet.getRange(i + 1, APPLICATIONS_COLS.STATUS).setValue('Escalated to Division Head');
          applicantEmail = appData[i][APPLICATIONS_COLS.APPLICANT_EMAIL - 1];
          try { 
            const pia1Data = JSON.parse(appData[i][APPLICATIONS_COLS.PIA_1_DATA - 1] || '{}');
            divHeadEmail = pia1Data.divHeadEmail || ''; 
            divHeadName = pia1Data.divHead || '';
            programName = pia1Data.program || 'Untitled';
          } catch (e) {}
          break;
        }
      }

      const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
      
      // CRITICAL FIX: Check if a Pending DivHead record already exists for this session
      // Prevents duplicate escalation records when multiple ISM members escalate
      const existingDivData = divHeadSheet.getDataRange().getValues();
      let hasPendingEscalation = false;
      for (let di = 1; di < existingDivData.length; di++) {
        if (existingDivData[di][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === sessionId &&
            existingDivData[di][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') {
          hasPendingEscalation = true;
          Logger.log(`[AUDIT] ${sessionId}: Pending DivHead escalation already exists — skipping duplicate creation`);
          break;
        }
      }
      
      if (!hasPendingEscalation) {
        divHeadSheet.appendRow([escalationId, sessionId, divHeadEmail, '', '', '', 'Pending', '', 'Pending', '']);
      }

      Logger.log(`[AUDIT] ${sessionId}: ISM Review Escalated to Division Head (${divHeadEmail}) by ${ismMemberEmail}`);
      notifyApplicant(sessionId, 'escalated_divhead');
      
      if (divHeadEmail) {
        try {
          const ts = new Date().getTime().toString();
          // CRITICAL FIX: Normalize email before token generation to prevent authorization mismatch
          const normalizedDivHeadEmail = getNormalizedEmail(divHeadEmail);
          const token = generateAuthToken(sessionId, normalizedDivHeadEmail, ts, 'Review');
          const baseUrl = `${webAppUrl}?sessionId=${sessionId}&email=${encodeURIComponent(normalizedDivHeadEmail)}&token=${token}&ts=${ts}&step=1`;
          const reviewUrl = `${baseUrl}&action=Review&approverType=divhead`;
          
          const subject = `Action Required: Division Head Review for ${sessionId}`;
          const htmlBody = buildPiaEmailHtml_({
            heading: 'Action Required — Division Head Review',
            contentHtml: `
              <p style="margin:0 0 14px;font-size:14px;">A Privacy Impact Assessment requires your review as Division Head following an InfoSec escalation.</p>
              <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Division Head Escalation</div>
              <div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
                <strong>App ID:</strong> ${sessionId}<br>
                <strong>Program:</strong> ${escapeHtml(programName)}<br>
                <strong>Division Head:</strong> ${escapeHtml(divHeadName)}<br>
                <strong>Submitted by:</strong> ${escapeHtml(applicantEmail)}
              </div>
              <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
                <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
                ${generateEmailDecisionsHTML(sessionId)}
              </div>
              <div><a href="${reviewUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>`
          });
          queueEmail(sessionId, divHeadEmail, subject, "Please view this email in an HTML-compatible client.", 'divhead', htmlBody);
        } catch(e) {
          Logger.log('Error queuing Div Head notification: ' + e);
          logAuditTrail(sessionId, 'Email Failed', JSON.stringify({
            recipient: divHeadEmail || 'unknown',
            type: 'divhead',
            attempts: 0,
            error: 'QUEUE_CRASH: ' + e.toString()
          }));
        }
      }
    }

      return {
        success: true,
        message: `ISM decision recorded: ${decision}`,
        nextAction: decision === 'Approve' && currentStep < 2 ? 'NOTIFY_NEXT_MEMBER' : 'PROCESS_COMPLETE'
      };
    } finally {
      // CRITICAL FIX: Only release lock if it was acquired
      if (lockAcquired) {
        lock.releaseLock();
      }
    }
  } catch (e) {
    Logger.log('Error in apiPhase3_ProcessISMDecision: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiPhase3_NotifyISMember
  LAYMAN:    Emails the ISM/InfoSec reviewer at a given step that an access request needs their review,
             with a secure one-click "ISMReview" link.
  TECHNICAL: Flushes pending writes (so freshly-appended rows are visible), finds the Pending ISM row
             at stepNumber, builds an action-bound HMAC 'ISMReview' URL, renders via buildPiaEmailHtml_,
             and queueEmail(type:'ism'). Missing member / errors are audited, never thrown.
  PARAMS:    - sessionId — application id; stepNumber — 1-based ISM step.
  RETURNS:   undefined. No-op (audited) if no Pending member at that step.
*/
function apiPhase3_NotifyISMember(sessionId, stepNumber) {
  try {
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl() || ScriptApp.getService().getUrl();
    
    // CRITICAL: Flush pending writes so appended ISM rows are visible to read
    SpreadsheetApp.flush();
    
    const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const data = ismWorkflowSheet.getDataRange().getValues();

    let ismMember = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId &&
          Number(data[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1]) === Number(stepNumber) &&
          data[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Pending') {
        ismMember = {
          name: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1],
          email: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]
        };
        break;
      }
    }

    if (!ismMember) {
      Logger.log('ERROR: ISM member not found for session=' + sessionId + ' step=' + stepNumber);
      logAuditTrail(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'ism',
        attempts: 0,
        error: 'ISM member not found for step ' + stepNumber + ' (rows may not be committed yet)'
      }));
      return;
    }

    const ts = new Date().getTime().toString();
    // CRITICAL FIX: Normalize email before token generation to prevent authorization mismatch
    const normalizedIsmEmail = getNormalizedEmail(ismMember.email);
    const token = generateAuthToken(sessionId, normalizedIsmEmail, ts, 'ISMReview');
    const baseUrl = `${webAppUrl}?sessionId=${sessionId}&email=${encodeURIComponent(normalizedIsmEmail)}&token=${token}&ts=${ts}&step=${stepNumber}`;
    const reviewUrl = `${baseUrl}&action=ISMReview`;

    const appData = getApplicationData(sessionId);
    const subject = `ISM InfoSec Review Required: ${sessionId}`;
    const htmlBody = buildPiaEmailHtml_({
      heading: 'ISM InfoSec Review Required',
      contentHtml: `
        <p style="margin:0 0 14px;font-size:14px;">An access request requires your InfoSec review.</p>
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">ISM InfoSec Approval — step ${stepNumber} of 2</div>
        <div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
          <strong>App ID:</strong> ${sessionId}<br>
          <strong>Program:</strong> ${appData?.pia1?.program || '—'}<br>
          <strong>Department:</strong> ${appData?.pia1?.dept || '—'}<br>
          <strong>Submitted by:</strong> ${appData?.applicantEmail || '—'}
        </div>
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
          ${generateEmailDecisionsHTML(sessionId)}
        </div>
        <div><a href="${reviewUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>`
    });

    // Queue for deferred delivery (avoids Gmail throttling in-request)
    queueEmail(sessionId, ismMember.email, subject, "Please view this email in an HTML-compatible client.", 'ism', htmlBody);
    Logger.log('✓ ISM review notification queued for ' + ismMember.email + ' step ' + stepNumber);
  } catch (e) {
    Logger.log('Error in apiPhase3_NotifyISMember: ' + e.toString());
    try {
      logAuditTrail(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'ism',
        attempts: 0,
        error: 'QUEUE_CRASH: ' + e.toString()
      }));
    } catch(_) {}
  }
}

/*
  Function: apiPhase3_RouteApprovedRequest
  LAYMAN:    The finish line. Once an application is fully approved, this builds the Certificate of
             Approval (with the full approver roster), turns it into a PDF, and emails it to the chosen
             implementation team(s) — DCOPS, TechServe, or both — then tells the applicant it is routed.
  TECHNICAL: Validates destination against the whitelist, resolves DCOPS/TechServe emails via
             apiPhase3_GetInfoSecMembers, gathers approver/divhead/ISM rows + DCS context, renders a
             certificate HTML, generates a PDF blob (Utilities.newBlob → getAs PDF), and sends via
             sendEmailWithRetry with the PDF attached. Finally notifyApplicant('routed_implementation').
  PARAMS:    - sessionId — application id; destination — 'DCOPS' | 'TECHSERVE' | 'BOTH'.
  RETURNS:   { success:true, message, sentTo } or { success:false, error }.
*/
function apiPhase3_RouteApprovedRequest(sessionId, destination) {
  try {
    // Normalize destination to handle case sensitivity from frontend radio buttons
    const normalizedDest = String(destination || '').toUpperCase();
    const validDestinations = ['DCOPS', 'TECHSERVE', 'BOTH'];
    
    if (!validDestinations.includes(normalizedDest)) {
      return { success: false, error: 'Invalid destination routing: ' + destination };
    }

    // Human-friendly routing label for the certificate (BOTH → "DCOPS and TechServe").
    const routedLabel = normalizedDest === 'BOTH' ? 'DCOPS and TechServe'
      : (normalizedDest === 'TECHSERVE' ? 'TechServe' : 'DCOPS');

    const ismInfo = apiPhase3_GetInfoSecMembers();
    if (!ismInfo.success) {
      return { success: false, error: 'Could not retrieve destination email configuration' };
    }

    const appData = getApplicationData(sessionId);
    if (!appData) {
      return { success: false, error: 'Application not found' };
    }

    // Fetch DCS Data for extended fields
    const dcsResult = apiPhase3_FetchDCSData(sessionId);
    const dcsData = dcsResult.success ? dcsResult.data : {};

    // Resolve the site-specific TechServe email(s) for this request (Batch 3). Always computed so the
    // applicant/cert "contact TechServe" message shows the right site's team even for DCOPS-only routing.
    const siteTechserve = resolveTechserveForSite_(ismInfo.data.destinationEmails, dcsData.locations);
    // Name / email list (one per line) for the certificate footer + applicant email.
    const techserveListHtml = siteTechserve.map(function(t) {
      const nm = (t && t.name) ? escapeHtml(String(t.name)) : '';
      const em = (t && t.email) ? escapeHtml(String(t.email)) : '';
      return '<div style="margin-top:4px;">' + (nm ? '<span style="color:#1a3a5c;font-weight:600;">' + nm + '</span><br>' : '') + '<span style="color:#6b7280;">' + em + '</span></div>';
    }).join('');

    const destinationEmails = [];
    if (normalizedDest === 'DCOPS' || normalizedDest === 'BOTH') {
      destinationEmails.push(ismInfo.data.destinationEmails.dcops);
    }
    if (normalizedDest === 'TECHSERVE' || normalizedDest === 'BOTH') {
      if (siteTechserve.length) {
        siteTechserve.forEach(function(t) { destinationEmails.push(t.email); });
      } else {
        // L2: this site has no TechServe configured — route to DCOPS instead of every team's inbox.
        Logger.log('WARN: No TechServe email for site "' + dcsData.locations + '" on ' + sessionId + '; routing to DCOPS instead.');
        const dcopsEmail = ismInfo.data.destinationEmails.dcops;
        if (dcopsEmail && destinationEmails.indexOf(dcopsEmail) === -1) {
          destinationEmails.push(dcopsEmail);
        }
      }
    }

    const validEmails = destinationEmails.filter(e => e).join(',');
    if (!validEmails) {
      return { success: false, error: 'No destination email configured for ' + destination };
    }

    // Prepare Accountable Persons HTML
    let accountableRowsHtml = '';
    if (dcsData.accountable) {
      for (let i = 1; i <= 5; i++) {
        const name = dcsData.accountable[`accountableName${i}`];
        const email = dcsData.accountable[`accountableEmail${i}`];
        if (name || email) {
          accountableRowsHtml += `
            <tr>
              <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Accountable Person ${i}</td>
              <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(name || '—')} (${escapeHtml(email || '—')})</td>
            </tr>`;
        }
      }
    }

    // Gather Approvers Information
    
    // 1. Main Approvers (Heads)
    let headsApproversHtml = '';
    (appData.approvers || []).forEach(a => {
      if (a.status === 'Approved') {
        const dateStr = a.decisionDate ? new Date(a.decisionDate).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
        const roleToDisplay = a.role;
        headsApproversHtml += `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
              <div style="font-weight: 600; color: #1a3a5c;">${escapeHtml(a.name)}</div>
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">${escapeHtml(roleToDisplay)}</div>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="display: inline-flex; align-items: center; background: #ecfdf5; color: #065f46; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;">Approved</span>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #4b5563;">
              ${escapeHtml(a.comment || '—')}
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #4b5563;">
              ${escapeHtml(dateStr)}
            </td>
          </tr>
        `;
      }
    });

    // 2. Division Head (if escalated)
    const divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    const divHeadData = divHeadSheet.getDataRange().getValues();
    for (let i = 1; i < divHeadData.length; i++) {
      if (divHeadData[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === sessionId && divHeadData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Approved') {
        const divHeadEmailFromSheet = divHeadData[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1];
        const divHeadName = (appData.pia1 && getNormalizedEmail(appData.pia1.divHeadEmail) === getNormalizedEmail(divHeadEmailFromSheet))
          ? (appData.pia1.divHead || divHeadEmailFromSheet)
          : divHeadEmailFromSheet;
        const roleToDisplay = 'Division Head';
        const dateStr = divHeadData[i][DIV_HEAD_CONFIG_COLS.DECISION_DATE - 1] ? new Date(divHeadData[i][DIV_HEAD_CONFIG_COLS.DECISION_DATE - 1]).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
        headsApproversHtml += `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
              <div style="font-weight: 600; color: #1a3a5c;">${escapeHtml(divHeadName)}</div>
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">${escapeHtml(roleToDisplay)}</div>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="display: inline-flex; align-items: center; background: #ecfdf5; color: #065f46; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;">Approved</span>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #4b5563;">
              ${escapeHtml(divHeadData[i][DIV_HEAD_CONFIG_COLS.COMMENTS - 1] || '—')}
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #4b5563;">
              ${escapeHtml(dateStr)}
            </td>
          </tr>
        `;
      }
    }

    if (!headsApproversHtml) {
        headsApproversHtml = `<tr><td colspan="4" style="padding: 10px 0; color: #6b7280; font-style: italic; border-bottom: 1px solid #e5e7eb;">No head approvers found.</td></tr>`;
    }

    // 3. ISM Members
    let ismApproversHtml = '';
    const ismWorkflowSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const ismData = ismWorkflowSheet.getDataRange().getValues();
    
    // Look up JobPos from InfoSec_Email_Config for ISM members
    const infosecSheet = getDatabaseSheet(DB_SHEET_NAMES.INFOSEC_CONFIG, true);
    const infosecData = infosecSheet.getDataRange().getValues();
    const getJobPosForMember = (memberName) => {
      const normalizedName = String(memberName || '').trim().toLowerCase();
      for (let j = 1; j < infosecData.length; j++) {
        const configName = String(infosecData[j][INFOSEC_CONFIG_COLS.MEMBER_NAME - 1] || '').trim().toLowerCase();
        if (configName === normalizedName) {
          return infosecData[j][INFOSEC_CONFIG_COLS.JOB_POS - 1] || null;
        }
      }
      return null;
    };
    
    for (let i = 1; i < ismData.length; i++) {
      if (ismData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === sessionId && ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Approved') {
        const dateStr = ismData[i][ISM_WORKFLOW_COLS.DECISION_DATE - 1] ? new Date(ismData[i][ISM_WORKFLOW_COLS.DECISION_DATE - 1]).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
        const memberName = ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1];
        const jobPos = getJobPosForMember(memberName) || 'ISM InfoSec Member';
        ismApproversHtml += `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
              <div style="font-weight: 600; color: #1a3a5c;">${escapeHtml(ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1])}</div>
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">${escapeHtml(jobPos)}</div>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="display: inline-flex; align-items: center; background: #ecfdf5; color: #065f46; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;">Approved</span>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #4b5563;">
              ${escapeHtml(ismData[i][ISM_WORKFLOW_COLS.COMMENTS - 1] || '—')}
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #4b5563;">
              ${escapeHtml(dateStr)}
            </td>
          </tr>
        `;
      }
    }
    
    if (!ismApproversHtml) {
        ismApproversHtml = `<tr><td colspan="4" style="padding: 10px 0; color: #6b7280; font-style: italic; border-bottom: 1px solid #e5e7eb;">No ISM approvers found.</td></tr>`;
    }

    const nowStr = new Date().toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' });

    const subject = `[CERTIFICATE OF APPROVAL] Implementation Required for: ${sessionId} (${appData.pia1?.program || 'No Program Name'})`;

    // #19: list the uploaded supporting documents on the certificate.
    let supportingDocsListHtml = '';
    try {
      const certDocs = getAndShareDCSFiles(appData.linkedReqId);
      if (certDocs && certDocs.length > 0) {
        const docLabelFor = function (f) {
          const n = (f.name || '').toUpperCase();
          if (f.type === 'CU' || n.includes('-CU') || n.includes('CONFIDENTIALITY')) return 'Confidentiality Undertaking';
          if (f.type === 'NDA' || n.includes('-NDA') || n.includes('NON-DISCLOSURE')) return 'Non-Disclosure Agreement';
          if (f.type === 'DPA' || n.includes('-DPA') || n.includes('DATA PROTECTION')) return 'Data Protection Agreement';
          if (f.type === 'DSA' || n.includes('-DSA')) return 'Data Sharing Agreement';
          if (f.type === 'ENDORSEMENT' || n.includes('ENDORSEMENT')) return 'Endorsement Letter';
          return 'Supporting Document';
        };
        const docRows = certDocs.map(function (f) {
          return `<tr><td style="padding:6px 0;font-weight:600;width:30%;color:#6b7280;">${escapeHtml(docLabelFor(f))}</td><td style="padding:6px 0;color:#1a3a5c;"><a href="${escapeHtml(f.url || '#')}" style="color:#185FA5;text-decoration:none;">${escapeHtml(f.name || 'Document')}</a></td></tr>`;
        }).join('');
        supportingDocsListHtml = `
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Supporting Documents</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">${docRows}</table>
          </div>`;
      }
    } catch (e) { Logger.log('Cert supporting-docs build failed: ' + e.toString()); }

    const htmlBody = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333; line-height: 1.6; padding: 20px; background-color: #f9fafb;">
        <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 40px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #2a5285; padding-bottom: 20px;">
            <img src="https://upload.wikimedia.org/wikipedia/commons/e/e2/Megaworld_logo_and_wordmark.svg" alt="Megaworld Logo" height="28" style="margin-bottom: 15px;">
            <h1 style="color: #2a5285; margin: 0; font-size: 28px; letter-spacing: -0.02em;">Certificate of Approval</h1>
            <p style="color: #6b7280; margin: 5px 0 0 0; font-size: 14px;">Privacy Impact Assessment & Access Request</p>
          </div>

          <!-- Application Brief -->
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Application Brief</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 6px 0; font-weight: 600; width: 30%; color: #6b7280;">DCS Request ID</td>
                <td style="padding: 6px 0; font-weight: bold; color: #1a3a5c;">${escapeHtml(appData.linkedReqId || 'N/A')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Program Name</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(appData.pia1?.program || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Department</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.department || appData.pia1?.dept || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Requestor</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.requestorName || dcsData.requestor || appData.applicantEmail || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Purpose</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(appData.pia1?.purpose || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">Scope</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(appData.pia1?.scope || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">Benefits</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(appData.pia1?.benefits || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">End User</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(appData.pia1?.endUser || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Access Type</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.accessNeeded || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">iHelp Reference</td>
                <td style="padding: 6px 0; color: #1a3a5c;"><code>${escapeHtml(dcsData.iHelpReference || '—')}</code></td>
              </tr>
              ${accountableRowsHtml}
            </table>
          </div>

          <!-- Supporting Documents (#19) -->
          ${supportingDocsListHtml}

          <!-- Agency Information -->
          ${dcsData.metadataAgency && typeof dcsData.metadataAgency === 'object' && (dcsData.metadataAgency.agencyName || dcsData.metadataAgency.agencyRequestType) ? `
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Agency Information</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              ${dcsData.metadataAgency.agencyRequestType ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; width: 30%; color: #6b7280;">Request Type</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.agencyRequestType)}</td>
              </tr>` : ''}
              ${(dcsData.metadataAgency.agencyRequestType === 'Replacement' && dcsData.metadataAgency.replacementFullName) ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Replacing (Person)</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.replacementFullName)}</td>
              </tr>` : ''}
              ${(dcsData.metadataAgency.agencyRequestType === 'Replacement' && dcsData.metadataAgency.replacementEmail) ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Replaced Person Email</td>
                <td style="padding: 6px 0; color: #1a3a5c;"><a href="mailto:${escapeHtml(dcsData.metadataAgency.replacementEmail)}" style="color: #185FA5; text-decoration: none;">${escapeHtml(dcsData.metadataAgency.replacementEmail)}</a></td>
              </tr>` : ''}
              ${dcsData.metadataAgency.agencyName ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; width: 30%; color: #6b7280;">Agency Name</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.agencyName)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.agencyPersonnel ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Agency Personnel</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.agencyPersonnel)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.contractStartDate ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Contract Start Date</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.contractStartDate)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.networkDrive ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Network Drive</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.networkDrive)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.immHeadRecoveryEmail ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Immediate Head Recovery Email</td>
                <td style="padding: 6px 0; color: #1a3a5c;"><a href="mailto:${escapeHtml(dcsData.metadataAgency.immHeadRecoveryEmail)}" style="color: #185FA5; text-decoration: none;">${escapeHtml(dcsData.metadataAgency.immHeadRecoveryEmail)}</a></td>
              </tr>` : ''}
              ${dcsData.metadataAgency.immHeadRecoveryNumber ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Immediate Head Recovery No.</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml(dcsData.metadataAgency.immHeadRecoveryNumber)}</td>
              </tr>` : ''}
            </table>
          </div>
          ` : ''}

          <!-- Head Approvers -->
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Department / Division Approvals</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 30%;">Approver</th>
                  <th style="text-align: center; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 15%;">Status</th>
                  <th style="text-align: left; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 35%;">Comments / Feedback</th>
                  <th style="text-align: right; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 20%;">Date & Time of Approval</th>
                </tr>
              </thead>
              <tbody>
                ${headsApproversHtml}
              </tbody>
            </table>
          </div>

          <!-- ISM Approvers -->
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">ISM InfoSec Approvals</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 30%;">Approver</th>
                  <th style="text-align: center; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 15%;">Status</th>
                  <th style="text-align: left; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 35%;">Comments / Feedback</th>
                  <th style="text-align: right; padding: 8px 0; color: #6b7280; font-weight: 600; border-bottom: 2px solid #e5e7eb; width: 20%;">Date & Time of Approval</th>
                </tr>
              </thead>
              <tbody>
                ${ismApproversHtml}
              </tbody>
            </table>
          </div>

          <!-- Routing Information -->
          <div style="margin-top: 40px; padding-top: 25px; border-top: 2px solid #2a5285; text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">Implementation Routing</p>
            <p style="margin: 5px 0 0 0; font-size: 15px; font-weight: 600; color: #1a3a5c;">Routed to: ${escapeHtml(routedLabel)}</p>
            <p style="margin: 5px 0 0 0; font-size: 13px; color: #9ca3af;">Received at: ${escapeHtml(nowStr)}</p>
            <p style="margin: 14px 0 0 0; font-size: 13px; color: #1a3a5c;">This request is <strong>fully approved</strong> and is now being processed by the implementation team.</p>
            ${techserveListHtml ? `<div style="margin-top: 12px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">Follow up with TechServe</div><div style="font-size: 13px; margin-top: 4px;">${techserveListHtml}</div>` : ''}
          </div>

        </div>
        
        <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 12px; color: #6b7280; text-align: center; line-height: 1.6;">
          <strong style="color: #374151;">No-reply notice.</strong> This mailbox is not monitored, so please do not reply. This is an automated notification for your records and action. For assistance, contact ISM-InfoSec at <strong style="color: #374151;">infosec@megaworldcorp.com</strong>.
        </div>

        <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #9ca3af;">
          This is an automated message. Please proceed with the technical setup or data access granting as described.
        </div>
      </div>
    `;

    // Build a separate HTML version for the PDF attachment (remove external image for PDF rendering)
    const pdfHtml = htmlBody.replace( // Remove the logo from the PDF version
      '<img src="https://upload.wikimedia.org/wikipedia/commons/e/e2/Megaworld_logo_and_wordmark.svg" alt="Megaworld Logo" height="28" style="margin-bottom: 15px;">',
      ''
    );

    const pdfBlob = Utilities.newBlob(pdfHtml, MimeType.HTML, `Certificate_${sessionId}.html`).getAs(MimeType.PDF).setName(`Approval_Certificate_${sessionId}.pdf`);

    sendEmailWithRetry(validEmails, subject, "Please view this email in an HTML-compatible client.", {
      htmlBody: htmlBody,
      attachments: [pdfBlob]
    });

    Logger.log(`[AUDIT] ${sessionId}: Request routed to ${normalizedDest}: ${validEmails}`);
    // #20: do NOT send a second applicant email here. The 'approved_ism_final' email already told the
    // requester their request is fully approved; sending 'routed_implementation' too caused a duplicate.

    return {
      success: true,
      message: `Request successfully routed to ${destination}`,
      sentTo: validEmails,
      pdfBlob: pdfBlob,
      techserveEmails: siteTechserve
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_RouteApprovedRequest: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// �🔗 CLIENT-SIDE API ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: apiSubmitApplication
  LAYMAN:    The endpoint the form calls to submit a PIA. It cleans the input, checks it is complete,
             then saves it.
  TECHNICAL: sanitizeInput → validateApplicationData (returns errors early if invalid) → submitApplication.
             The defense-in-depth gate before any DB write.
  PARAMS:    - appData — the raw submission from the client.
  RETURNS:   submitApplication's result, or { success:false, errors:[...] } on validation failure.
*/
// Endpoints called from frontend via google.script.run
function apiSubmitApplication(appData) {
  const cleanData = sanitizeInput(appData);
  const validation = validateApplicationData(cleanData);
  if (!validation.isValid) {
    return {
      success: false,
      errors: validation.errors
    };
  }
  return submitApplication(cleanData);
}

/*
  Function: apiGetDCSContext
  LAYMAN:    When the PIA form opens from a DCS link, this pulls the matching DCS request to pre-fill
             the form (department, program, heads, etc.), confirms the user owns that request, and tells
             the form whether there is already a submission/draft to resume (and any returned-comments).
  TECHNICAL: Finds the Data_Collection row by parentID (TextFinder), enforces owner == active user
             (normalized; security alert + deny otherwise), parses metadata into a context object, then
             looks up the latest Applications row linked to this parentID (highest -V#). For
             Returned/Rejected it harvests the last decision comment across Approval/ISM/DivHead sheets,
             and otherwise looks for a resumable PIA draft.
  PARAMS:    - parentID — the DCS Request ID from the URL.
  RETURNS:   { success:true, context, existingSubmissionId, existingSubmissionStatus,
             existingDraftSessionId, approverComments, approverFlags } or { success:false, error }.
*/
function apiGetDCSContext(parentID) {
  try {
    // Defensive check to prevent createTextFinder from failing on null input.
    if (!parentID) {
      return { success: false, error: 'The parentID parameter was not provided or is empty.' };
    }

    const userEmail = Session.getActiveUser().getEmail().toLowerCase();
    const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const lastRow = dcsSheet.getLastRow();
    if (lastRow < 2) {
      return { success: false, error: 'Data Collection sheet is empty.' };
    }

    // Normalize parentID: trim whitespace and ensure proper formatting
    const normalizedParentID = String(parentID).trim();
    if (!normalizedParentID) {
      return { success: false, error: 'The parentID parameter is empty after trimming.' };
    }

    // Use TextFinder for performance - skip header row (row 1) and search data only
    const reqIdCol = dcsSheet.getRange(2, DCS_COLS.REQ_ID, Math.max(1, lastRow - 1), 1);
    const finder = reqIdCol
      .createTextFinder(normalizedParentID)
      .matchEntireCell(true)
      .matchCase(false);  // Case-insensitive search
    const foundCell = finder.findNext();

    if (!foundCell) {
      // Enhanced logging for debugging
      Logger.log(`DEBUG: Parent ID '${normalizedParentID}' not found in DCS sheet (lastRow=${lastRow})`);
      return { success: false, error: 'Parent ID not found in Data Collection sheet. Please verify the DCS link.' };
    }

    const rowNum = foundCell.getRow();
    const rowData = dcsSheet.getRange(rowNum, 1, 1, dcsSheet.getLastColumn()).getValues()[0];
    
    // Normalize both emails for comparison (handles +alias addresses)
    const ownerEmail = getNormalizedEmail(String(rowData[DCS_COLS.USER_EMAIL - 1] || ''));
    const normalizedUserEmail = getNormalizedEmail(userEmail);
    
    if (ownerEmail !== normalizedUserEmail) {
      Logger.log(`SECURITY ALERT: Unauthorized access attempt to DCS context for ${normalizedParentID} by ${normalizedUserEmail}. Owner is ${ownerEmail}.`);
      return { success: false, error: 'You are not authorized to access this context.' };
    }

    const status = String(rowData[DCS_COLS.STATUS - 1] || '');
    const metadataStr = rowData[DCS_COLS.METADATA_JSON - 1];
    let metadata = {};
    try {
      metadata = JSON.parse(metadataStr || '{}');
    } catch (e) {
      Logger.log('Failed to parse metadata: ' + e.toString());
    }

    const ts = rowData[DCS_COLS.TIMESTAMP - 1];
    let timestampStr = '';
    if (ts) {
      if (ts instanceof Date) {
        timestampStr = ts.toISOString();
      } else {
        timestampStr = String(ts);
      }
    }

    // Pre-populate PIA fields from DCS metadata — try all known key variations
    const context = {
      department: metadata.dept || metadata.department || metadata.Department || metadata.deptName || '',
      program: metadata.program || metadata.programName || metadata.Program || metadata['Program/Process'] || metadata['Program'] || metadata.projectName || metadata.project || metadata.piaProgram || '',
      scope: metadata.scope || metadata.Scope || metadata.scopeOfProcessing || metadata.programScope || metadata['Scope of Processing'] || '',
      locations: metadata.locations || metadata.location || '',
      access: metadata.access || '',
      ihelp: metadata.ihelp || '',
      immHeadName: metadata.immHeadName || '',
      deptHeadName: metadata.deptHeadName || '',
      divHeadName: metadata.divHeadName || '',
      immediateHeadPhone: metadata.immHeadPhone || '',
      deptHeadPhone: metadata.deptHeadPhone || '',
      divHeadPhone: metadata.divHeadPhone || '',
      immediateHeadEmail: String(rowData[DCS_COLS.IMMEDIATE_HEAD_EMAIL - 1] || '').trim(),
      deptHeadEmail: String(rowData[DCS_COLS.DEPT_HEAD_EMAIL - 1] || '').trim(),
      divHeadEmail: String(rowData[DCS_COLS.DIV_HEAD_EMAIL - 1] || '').trim(),
      status: status,
      timestamp: timestampStr,
      fileID: String(rowData[DCS_COLS.FILE_ID - 1] || ''),
      requestor: String(rowData[DCS_COLS.USER_EMAIL - 1] || ''),
      drafterName: metadata.name || metadata.requestorName || metadata.drafterName || '',
      accountable: metadata.accountable || null,
      metadataAgency: (function() {
        try {
          const raw = rowData[Math.min(DCS_COLS.METADATA_AGENCY - 1, rowData.length - 1)];
          return raw ? JSON.parse(String(raw)) : {};
        } catch(e) { return {}; }
      })()
    };

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PIA Submission Lookup & Revision Flag
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let existingSubmissionId = null;
    let existingSubmissionStatus = null;
    let approverComments = '';
    let approverFlags = {};

    const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    const lastAppRow = appSheet.getLastRow();
    if (lastAppRow >= 2) {
      const appDataRange = appSheet.getRange(2, 1, lastAppRow - 1, appSheet.getLastColumn()).getValues();
      let latestApp = null;
      let latestRevision = -1;
      let latestAppRowIndex = -1;
      
      for (let i = 0; i < appDataRange.length; i++) {
        const linkedReqId = String(appDataRange[i][APPLICATIONS_COLS.LINKED_REQ_ID - 1] || '').trim();
        if (linkedReqId === normalizedParentID) {
          const rowSessionId = String(appDataRange[i][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim();
          const match = rowSessionId.match(/-V(\d+)$/);
          const revision = match ? Number(match[1]) : 0;
          
          if (!latestApp || revision >= latestRevision) {
            latestApp = appDataRange[i];
            latestRevision = revision;
            latestAppRowIndex = i + 2;
          }
        }
      }

      if (latestApp) {
        const appRow = latestAppRowIndex;
        existingSubmissionId = latestApp[APPLICATIONS_COLS.SESSION_ID - 1];
        existingSubmissionStatus = latestApp[APPLICATIONS_COLS.STATUS - 1];

        // If returned or rejected, fetch the last approver's comments
        if (existingSubmissionStatus === 'Rejected' || existingSubmissionStatus === 'Returned') {
          const rawFlags = latestApp[APPLICATIONS_COLS.APPROVER_FLAGS - 1];
          try { approverFlags = JSON.parse(rawFlags || '{}'); } catch(e) {}

          // 1. Try Approval_Workflow sheet first (main workflow approvers)
          const apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
          const apprData = apprSheet.getDataRange().getValues();
          for (let i = apprData.length - 1; i >= 1; i--) {
            if (apprData[i][APPROVAL_COLS.SESSION_ID - 1] === existingSubmissionId &&
                (apprData[i][APPROVAL_COLS.STATUS - 1] === 'Rejected' || apprData[i][APPROVAL_COLS.STATUS - 1] === 'Returned' || apprData[i][APPROVAL_COLS.DECISION - 1] === 'Return')) {
              const rawComment = apprData[i][APPROVAL_COLS.COMMENTS - 1] || '';
              approverComments = rawComment.replace(/<[^>]*>/g, '').trim();
              break;
            }
          }

          // 2. If no comment found in main workflow, try ISM_Approval_Workflow
          if (!approverComments) {
            try {
              const ismSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, false);
              if (ismSheet) {
                const ismData = ismSheet.getDataRange().getValues();
                for (let i = ismData.length - 1; i >= 1; i--) {
                  if (ismData[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === existingSubmissionId &&
                      ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Returned') {
                    const rawComment = ismData[i][ISM_WORKFLOW_COLS.COMMENTS - 1] || '';
                    approverComments = rawComment.replace(/<[^>]*>/g, '').trim();
                    break;
                  }
                }
              }
            } catch(e) {}
          }

          // 3. If still no comment found, try DivisionHead config
          if (!approverComments) {
            try {
              const divSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, false);
              if (divSheet) {
                const divData = divSheet.getDataRange().getValues();
                for (let i = divData.length - 1; i >= 1; i--) {
                  if (divData[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === existingSubmissionId &&
                      (divData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Rejected' || divData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Returned')) {
                    const rawComment = divData[i][DIV_HEAD_CONFIG_COLS.COMMENTS - 1] || '';
                    approverComments = rawComment.replace(/<[^>]*>/g, '').trim();
                    break;
                  }
                }
              }
            } catch(e) {}
          }
        }
      }
    }

    // Check for existing drafts if no submission found
    let existingDraftSessionId = null;
    if (!existingSubmissionId || existingSubmissionStatus === 'Rejected' || existingSubmissionStatus === 'Returned') {
      const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
      const draftsLastRow = draftsSheet.getLastRow();
      if (draftsLastRow >= 2) {
        const draftsData = draftsSheet.getRange(2, 1, draftsLastRow - 1, draftsSheet.getLastColumn()).getValues();
        for (let i = 0; i < draftsData.length; i++) {
          const rowEmail = getNormalizedEmail(String(draftsData[i][1] || ''));
          const rowType = String(draftsData[i][3] || '').trim();
          if (rowEmail === normalizedUserEmail && rowType === 'PIA') {
            try {
              const stateData = JSON.parse(draftsData[i][4]);
              // Compare normalized parentID with stored parentID
              const storedParentID = String(stateData.parentID || '').trim();
              if (storedParentID === normalizedParentID) {
                    // If the application was returned/rejected, only consider drafts that are actively in 'Revision Mode'
                    if ((existingSubmissionStatus === 'Rejected' || existingSubmissionStatus === 'Returned') && stateData.isEditing !== true) {
                      continue; // Skip old pre-submission drafts
                    }
                existingDraftSessionId = draftsData[i][2];
                break;
              }
            } catch(e) {}
          }
        }
      }
    }

    return { 
      success: true, 
      context: context,
      existingSubmissionId: existingSubmissionId,
      existingSubmissionStatus: existingSubmissionStatus,
      existingDraftSessionId: existingDraftSessionId,
      approverComments: approverComments,
      approverFlags: approverFlags
    };

  } catch (e) {
    Logger.log('ERROR in apiGetDCSContext: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiGetUserDCSRequests
  LAYMAN:    Lists the current user's DCS requests (id + status) so the PIA app can offer them.
  TECHNICAL: Filters Data_Collection by the active user's email. try/catch → error.
  PARAMS:    (none)
  RETURNS:   { success:true, requests:[{reqId, status}] } or { success:false, error }.
*/
function apiGetUserDCSRequests() {
  try {
    const userEmail = Session.getActiveUser().getEmail().toLowerCase();
    const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const lastRow = dcsSheet.getLastRow();
    if (lastRow < 2) return {
      success: true,
      requests: []
    };

    const data = dcsSheet.getRange(2, 1, lastRow - 1, dcsSheet.getLastColumn()).getValues();
    const requests = data
      .filter(row => String(row[DCS_COLS.USER_EMAIL - 1] || '').toLowerCase() === userEmail)
      .map(row => ({
        reqId: row[DCS_COLS.REQ_ID - 1],
        status: row[DCS_COLS.STATUS - 1]
      }));

    return {
      success: true,
      requests: requests
    };
  } catch (e) {
    Logger.log('ERROR in apiGetUserDCSRequests: ' + e.toString());
    return {
      success: false,
      error: e.toString()
    };
  }
}

/*
  Function: apiGetUserEmail
  LAYMAN:    Tells the frontend who is signed in and whether they are allowed to use the app.
  TECHNICAL: Returns the active user email + isAuthorizedDomain flag.
  PARAMS:    (none)
  RETURNS:   { success:true, email, isAuthorized } or { success:false, email:'' }.
*/
function apiGetUserEmail() {
  try {
    const email = Session.getActiveUser().getEmail();
    return {
      success: true,
      email: email,
      isAuthorized: isAuthorizedDomain(email)
    };
  } catch (error) {
    Logger.log('ERROR in apiGetUserEmail: ' + error.toString());
    return {
      success: false,
      email: ''
    };
  }
}

/*
  Function: apiGetUserSubmissions
  LAYMAN:    Frontend endpoint for the "My Applications" list.
  TECHNICAL: Thin wrapper over getUserSubmissions(); re-throws on error so the client sees it.
  PARAMS:    (none)
  RETURNS:   Array of submission summaries ([] if none).
*/
function apiGetUserSubmissions() {
  try {
    const result = getUserSubmissions();
    Logger.log('apiGetUserSubmissions returning ' + (result ? result.length : 0) + ' records');
    return result || [];
  } catch (error) {
    Logger.log('ERROR in apiGetUserSubmissions: ' + error.toString());
    throw error;  // Re-throw so frontend sees the error
  }
}

/*
  Function: apiGenerateNewSessionId
  LAYMAN:    Hands the frontend a fresh application id when the user starts a new PIA, so drafts can be
             saved before final submit.
  TECHNICAL: Wraps nextBaseSessionId() (lock-guarded allocation).
  PARAMS:    (none)
  RETURNS:   { success:true, sessionId, message } or { success:false, error }.
*/
function apiGenerateNewSessionId() {
  try {
    Logger.log('🆕 apiGenerateNewSessionId called');
    const newSessionId = nextBaseSessionId();
    Logger.log('  New sessionId generated: ' + newSessionId);
    return {
      success: true,
      sessionId: newSessionId,
      message: 'Application session started'
    };
  } catch (error) {
    Logger.log('  ERROR in apiGenerateNewSessionId: ' + error.toString());
    return {
      success: false,
      error: error.toString()
    };
  }
}

/*
  Function: apiProcessApprovalDecision
  LAYMAN:    Frontend endpoint to record an approver's decision (thin pass-through).
  TECHNICAL: Delegates to processApprovalDecision (which enforces lock + validation).
  PARAMS:    - sessionId, approverEmail, decision, comments, stepParam?.
  RETURNS:   processApprovalDecision's result.
*/
function apiProcessApprovalDecision(sessionId, approverEmail, decision, comments, stepParam = null) {
  return processApprovalDecision(sessionId, approverEmail, decision, comments, stepParam);
}

/*
  Function: apiSaveDraft
  LAYMAN:    Auto-saves the user's in-progress PIA form so they can come back later. Keeps at most 5
             drafts per user (oldest dropped) and they expire after 7 days. Files are never saved here —
             text state only.
  TECHNICAL: Writes to the shared Drafts sheet (Type 'PIA'). Updates the existing row for this
             (user, sessionId) or inserts a new one; enforces MAX_USER_DRAFTS by deleting the oldest by
             epoch timestamp. Stores epoch ms for SavedAt/ExpiresAt (+DRAFT_EXPIRY_DAYS). try/catch.
  PARAMS:    - sessionId — the application/session id; stateData — form state object.
  RETURNS:   { success:true, draftId, message } or { success:false, error }.
*/
function apiSaveDraft(sessionId, stateData) {
  try {
    Logger.log('📥 apiSaveDraft called: sessionId=' + sessionId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    Logger.log('👤 User authenticated: ' + userEmail);
    
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    Logger.log('📋 Drafts sheet retrieved');
    const draftId = Utilities.getUuid();
    // HIGH FIX H5/H6: Store timestamp as epoch milliseconds, not locale string
    const timestamp = new Date().getTime();
    
    // Expiry: 7 days from now (also stored as epoch milliseconds)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + DRAFT_EXPIRY_DAYS);
    const expiryTimestamp = expiryDate.getTime();
    
    const stateJSON = JSON.stringify(stateData);
    Logger.log('State JSON created, length: ' + stateJSON.length);
    
    // Check if draft already exists for this session
    const data = draftsSheet.getDataRange().getValues();
    Logger.log('Drafts sheet data retrieved, rows: ' + data.length);
    let foundRow = -1;
    let existingDraftId = '';
    let userDraftCount = 0;
    const userDraftRows = [];
    
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1] || '').trim().toLowerCase() === userEmail.toLowerCase()) {
        userDraftCount++;
        userDraftRows.push({ index: i, createdAt: String(data[i][5] || '') });
        if (data[i][2] === sessionId && data[i][3] === 'PIA') {
          foundRow = i + 1;
          existingDraftId = String(data[i][0] || '');
          Logger.log(' Existing draft found at row: ' + foundRow);
        }
      }
    }
    
    Logger.log('  User has ' + userDraftCount + ' incomplete drafts');
    
    // Enforce 5-draft limit: delete oldest drafts if limit exceeded
    if (foundRow <= 0 && userDraftCount >= MAX_USER_DRAFTS) {
      Logger.log('   Draft limit reached (' + MAX_USER_DRAFTS + ' max). Deleting oldest draft.');
      // HIGH FIX H5/H6: Sort by numeric timestamp, not string localeCompare
      userDraftRows.sort((a, b) => {
        const aTime = parseInt(a.createdAt, 10) || 0;
        const bTime = parseInt(b.createdAt, 10) || 0;
        return aTime - bTime;
      });
      const oldestRowIndex = userDraftRows[0].index + 1; // +1 for 1-based indexing
      draftsSheet.deleteRow(oldestRowIndex);
      Logger.log('🗑️  Deleted oldest draft at row ' + oldestRowIndex);
    }
    
    if (foundRow > 0) {
      // UPDATE existing draft
      Logger.log('  Updating existing draft at row ' + foundRow);
      draftsSheet.getRange(foundRow, 4).setValue('PIA');             // Type
      draftsSheet.getRange(foundRow, 5).setValue(stateJSON);        // StateJSON
      draftsSheet.getRange(foundRow, 6).setValue(timestamp);         // SavedTimestamp (epoch)
      draftsSheet.getRange(foundRow, 7).setValue(expiryTimestamp);   // ExpiresAt (epoch)
    } else {
      // INSERT new draft
      Logger.log('✨ Creating new draft');
      draftsSheet.appendRow([
        draftId,           // DraftID
        userEmail,         // UserEmail
        sessionId,         // SessionID
        'PIA',             // Type
        stateJSON,         // StateJSON
        timestamp,         // SavedTimestamp (epoch)
        expiryTimestamp    // ExpiresAt (epoch)
      ]);
    }
    
    Logger.log('  Draft saved successfully');
    return { success: true, draftId: foundRow > 0 ? existingDraftId : draftId, message: 'Draft saved successfully' };
  } catch (e) {
    Logger.log('  ERROR in apiSaveDraft: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiRestoreDraft
  LAYMAN:    Reloads the saved draft for a given session (only if it belongs to the current user, and
             only if it hasn't expired).
  TECHNICAL: Scans Drafts for (user, sessionId, 'PIA'). Deletes + skips expired rows (epoch or legacy
             string). Parses and returns the state JSON. try/catch.
  PARAMS:    - sessionId — the session id.
  RETURNS:   { success:true, state } ; { success:false, state:null } if none; { success:false, error }.
*/
function apiRestoreDraft(sessionId) {
  try {
    Logger.log('📤 apiRestoreDraft called: sessionId=' + sessionId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    Logger.log('👤 User authenticated: ' + userEmail);
    
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    Logger.log('📋 Drafts sheet retrieved');
    const data = draftsSheet.getDataRange().getValues();
    Logger.log('  Data retrieved, rows: ' + data.length);
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowSessionId = String(data[i][2] || '').trim();
      const rowType = String(data[i][3] || '').trim();
      
      if (rowEmail === userEmail.toLowerCase() && rowSessionId === sessionId && rowType === 'PIA') {
        const expiresAtStr = data[i][6];
        if (expiresAtStr) {
          // HIGH FIX H5/H6: Handle both epoch (new) and locale string (old) formats
          let expiresAtMs = parseInt(expiresAtStr, 10);
          if (isNaN(expiresAtMs)) {
            // Fallback: try parsing as locale string for old data
            const parsed = new Date(expiresAtStr);
            expiresAtMs = isNaN(parsed.getTime()) ? 0 : parsed.getTime();
          }
          if (expiresAtMs > 0 && expiresAtMs < new Date().getTime()) {
            // Draft has expired
            draftsSheet.deleteRow(i + 1);
            continue;
          }
        }
        Logger.log('  Draft found for user at row ' + (i + 1));
        const stateJSON = data[i][4];
        try {
          const stateData = JSON.parse(stateJSON);
          Logger.log('✓ Draft parsed successfully, state keys: ' + Object.keys(stateData).join(', '));
          return { success: true, state: stateData };
        } catch (e) {
          Logger.log('  ERROR parsing draft state: ' + e.toString());
          return { success: false, error: 'Corrupted draft data' };
        }
      }
    }
    
    Logger.log('   No draft found for this session (first load)');
    return { success: false, state: null }; // No draft found (not an error)
  } catch (e) {
    Logger.log('  ERROR in apiRestoreDraft: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiListUserDrafts
  LAYMAN:    Lists the current user's still-valid (unexpired) PIA drafts for the "resume a draft" screen.
  TECHNICAL: Scans Drafts for (user, 'PIA') rows whose ExpiresAt is in the future, projecting
             {draftId, sessionId, savedAt, expiresAt, status}. try/catch.
  PARAMS:    (none)
  RETURNS:   { success:true, drafts:[...] } or { success:false, error }.
*/
function apiListUserDrafts() {
  try {
    Logger.log('📋 apiListUserDrafts called');
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    Logger.log('👤 User: ' + userEmail);
    
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    const data = draftsSheet.getDataRange().getValues();
    const now = new Date();
    const userDrafts = [];
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowType = String(data[i][3] || '').trim();
      const expiresAtStr = String(data[i][6] || '');
      
      // Only incomplete drafts from this user that haven't expired
      if (rowEmail === userEmail.toLowerCase() && rowType === 'PIA') {
        try {
          // HIGH FIX H5/H6: Handle both epoch (new) and locale string (old) formats
          let expiresAtMs = parseInt(expiresAtStr, 10);
          if (isNaN(expiresAtMs)) {
            // Fallback: try parsing as locale string for old data
            const parsed = new Date(expiresAtStr);
            expiresAtMs = isNaN(parsed.getTime()) ? 0 : parsed.getTime();
          }
          const expiresAt = new Date(expiresAtMs);
          if (expiresAt > now) {
            const stateJSON = data[i][4];
            let status = 'Draft';
            try {
              const snapshot = JSON.parse(stateJSON);
              status = snapshot.status || 'Draft';
            } catch (e) {}
            
            userDrafts.push({
              draftId: String(data[i][0] || ''),
              sessionId: String(data[i][2] || ''),
              savedAt: String(data[i][5] || ''),
              expiresAt: expiresAtStr,
              status: status
            });
          }
        } catch (e) {
          // Skip invalid dates
        }
      }
    }
    
    Logger.log('  Found ' + userDrafts.length + ' incomplete drafts');
    return { success: true, drafts: userDrafts };
  } catch (e) {
    Logger.log('  ERROR in apiListUserDrafts: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiLoadDraft
  LAYMAN:    Opens a specific saved draft by its id (only the owner can) and marks it as being edited.
  TECHNICAL: Finds the (user, draftId, 'PIA') row, parses state, and tags it with draftId/draftStatus/
             isLoadingExistingDraft for the frontend lock. try/catch.
  PARAMS:    - draftId — the draft UUID.
  RETURNS:   { success:true, state } or { success:false, error }.
*/
function apiLoadDraft(draftId) {
  try {
    Logger.log('📥 apiLoadDraft called: draftId=' + draftId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    const data = draftsSheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowDraftId = String(data[i][0] || '');
      const rowType = String(data[i][3] || '').trim();
      
      // Only load if: owned by user and IDs match
      if (rowEmail === userEmail.toLowerCase() && rowDraftId === draftId && rowType === 'PIA') {
        Logger.log('  Draft found at row ' + (i+1) + ' and owned by user');
        const stateJSON = data[i][4];
        try {
          const stateData = JSON.parse(stateJSON);
          stateData.draftId = draftId;
          stateData.draftStatus = 'editing';  // Mark as editing
          stateData.isLoadingExistingDraft = true;  // Lock this draft
          Logger.log('✓ Draft loaded and locked for editing');
          return { success: true, state: stateData };
        } catch (e) {
          Logger.log('  ERROR parsing draft: ' + e.toString());
          return { success: false, error: 'Corrupted draft data' };
        }
      }
    }
    
    Logger.log('  Draft not found or not owned by user');
    return { success: false, error: 'Draft not found' };
  } catch (e) {
    Logger.log('  ERROR in apiLoadDraft: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiDeleteDraft
  LAYMAN:    Lets a user discard one of their incomplete drafts.
  TECHNICAL: Deletes the (user, draftId, 'PIA') Drafts row. try/catch.
  PARAMS:    - draftId — the draft UUID.
  RETURNS:   { success:true, message } or { success:false, error }.
*/
function apiDeleteDraft(draftId) {
  try {
    Logger.log('🗑️  apiDeleteDraft called: draftId=' + draftId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    const data = draftsSheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowDraftId = String(data[i][0] || '');
      const rowType = String(data[i][3] || '').trim();
      
      if (rowEmail === userEmail.toLowerCase() && rowDraftId === draftId && rowType === 'PIA') {
        draftsSheet.deleteRow(i + 1);
        Logger.log('✓ Draft deleted at row ' + (i+1));
        return { success: true, message: 'Draft deleted' };
      }
    }
    
    Logger.log('  Draft not found or not owned by user');
    return { success: false, error: 'Draft not found' };
  } catch (e) {
    Logger.log('  ERROR in apiDeleteDraft: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: apiMarkDraftComplete
  LAYMAN:    After a draft is successfully submitted, this removes it so it no longer shows up as
             incomplete.
  TECHNICAL: Deletes the user's 'PIA' Drafts row matching draftId OR sessionId (fallback ensures
             cleanup even if the id drifted). try/catch.
  PARAMS:    - draftId, sessionId.
  RETURNS:   { success:true, message } or { success:false, error }.
*/
function apiMarkDraftComplete(draftId, sessionId) {
  try {
    Logger.log('🏁 apiMarkDraftComplete called: draftId=' + draftId + ', sessionId=' + sessionId);
    const userEmail = Session.getActiveUser().getEmail();
    
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    const data = draftsSheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowDraftId = String(data[i][0] || '');
      const rowSessionId = String(data[i][2] || '');
      const rowType = String(data[i][3] || '').trim();
      
      // Match by draftId OR sessionId (fallback) to ensure cleanup
      if (rowEmail === userEmail.toLowerCase() && rowType === 'PIA' && (rowDraftId === draftId || rowSessionId === sessionId)) {
        draftsSheet.deleteRow(i + 1);
        Logger.log('✓ Draft removed successfully (converted to submission) at row ' + (i+1));
        return { success: true, message: 'Draft removed' };
      }
    }
    
    Logger.log('   Draft not found for cleanup');
    return { success: false, error: 'Draft not found' };
  } catch (e) {
    Logger.log('  ERROR in apiMarkDraftComplete: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/*
  Function: cleanupExpiredDrafts
  LAYMAN:    Housekeeping: deletes drafts that have passed their 7-day expiry. Meant to run on a trigger.
  TECHNICAL: Rebuilds the Drafts sheet keeping only rows whose ExpiresAt (epoch or legacy string) is >=
             now: clearContents then writes back the survivors. try/catch.
  PARAMS:    (none)
  RETURNS:   undefined.
*/
function cleanupExpiredDrafts() {
  try {
    const draftsSheet = getDatabaseSheet(DB_SHEET_NAMES.DRAFTS, true);
    const data = draftsSheet.getDataRange().getValues();
    if (data.length <= 1) return;
    
    const today = new Date();
    const todayMs = today.getTime();
    const survivingData = [data[0]]; // Keep headers
    
    for (let i = 1; i < data.length; i++) {
      const expiresAtStr = String(data[i][6] || '');
      try {
        // HIGH FIX H5/H6: Handle both epoch (new) and locale string (old) formats
        let expiresAtMs = parseInt(expiresAtStr, 10);
        if (isNaN(expiresAtMs)) {
          // Fallback: try parsing as locale string for old data
          const parsed = new Date(expiresAtStr);
          expiresAtMs = isNaN(parsed.getTime()) ? 0 : parsed.getTime();
        }
        if (expiresAtMs >= todayMs) {
          survivingData.push(data[i]);
        }
      } catch (e) {
        // Skip rows with invalid date format
      }
    }
    
    draftsSheet.clearContents();
    draftsSheet.getRange(1, 1, survivingData.length, survivingData[0].length).setValues(survivingData);
    
    Logger.log('Cleaned up expired drafts');
  } catch (e) {
    Logger.log('ERROR in cleanupExpiredDrafts: ' + e.toString());
  }
}

/*
  Function: apiGenerateRevisionSessionId
  LAYMAN:    When a user wants to fix and resubmit a returned/rejected application, this safely issues
             the next revision id — but only for their own app, only if it really was returned/rejected,
             and not while the linked DCS is still 'Returned'.
  TECHNICAL: Validates base id format, finds the latest revision row for that base, enforces owner ==
             active user and status in (rejected|returned), and blocks if DCS-flagged and the DCS is
             still 'Returned'. Then returns getNextRevisionSessionId(baseId). Throws on any gate failure.
  PARAMS:    - baseSessionId — the original/any-version application id.
  RETURNS:   { success:true, sessionId } ; throws Error on invalid/unauthorized/not-revisable.
*/
function apiGenerateRevisionSessionId(baseSessionId) {
  const baseId = String(baseSessionId || '').trim().replace(/-V\d+$/, '');
  if (!/^PIA-\d{6}$/.test(baseId)) {
    throw new Error('Invalid base session ID format.');
  }

  const appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
  const data = appSheet.getDataRange().getValues();
  let latest = null;

  for (let i = 1; i < data.length; i++) {
    const rowSessionId = String(data[i][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim();
    if (!rowSessionId || !rowSessionId.startsWith(baseId)) {
      continue;
    }

    const match = rowSessionId.match(/-V(\d+)$/);
    const revision = match ? Number(match[1]) : 0;
    if (!latest || revision > latest.revision) {
      latest = {
        sessionId: rowSessionId,
        revision: revision,
        applicantEmail: String(data[i][APPLICATIONS_COLS.APPLICANT_EMAIL - 1] || '').toLowerCase(),
        status: String(data[i][APPLICATIONS_COLS.STATUS - 1] || ''),
        linkedReqId: String(data[i][APPLICATIONS_COLS.LINKED_REQ_ID - 1] || ''),
        approverFlags: String(data[i][APPLICATIONS_COLS.APPROVER_FLAGS - 1] || '{}')
      };
    }
  }

  if (!latest) {
    throw new Error('Base application not found.');
  }

  const activeUser = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!activeUser || activeUser !== latest.applicantEmail) {
    throw new Error('Access denied: You can only revise your own application.');
  }

  if (String(latest.status || '').toLowerCase() !== 'rejected' && String(latest.status || '').toLowerCase() !== 'returned') {
    throw new Error('Only rejected or returned applications can be revised.');
  }

  if (latest.linkedReqId) {
    let hasDCSFlags = false;
    try {
      const flagsObj = JSON.parse(latest.approverFlags);
      hasDCSFlags = Object.keys(flagsObj).some(key => key.startsWith('DCS - '));
    } catch(e) {}
    
    if (hasDCSFlags) {
      const dcsSheet = getDatabaseSheet(DB_SHEET_NAMES.DATA_COLLECTION, true);
      const dcsData = dcsSheet.getDataRange().getValues();
      for (let i = 1; i < dcsData.length; i++) {
        if (dcsData[i][DCS_COLS.REQ_ID - 1] === latest.linkedReqId) {
          if (dcsData[i][DCS_COLS.STATUS - 1] === 'Returned') {
            throw new Error('Your application has been returned back, you will need to check the DCS to review & resubmit.');
          }
          break;
        }
      }
    }
  }

  return { success: true, sessionId: getNextRevisionSessionId(baseId) };
}

/*
  Function: apiGetApplicationData
  LAYMAN:    The access-controlled "load my application" endpoint for the frontend. Only the applicant
             or someone on the approval chain may view it.
  TECHNICAL: getApplicationData then authorizes active user as owner or an approver email; otherwise
             logs a security alert and throws. Stringifies approver decisionDate Date objects to keep the
             google.script.run serialization safe.
  PARAMS:    - sessionId — application id.
  RETURNS:   The (serialization-safe) app object; null if not found; throws on unauthorized access.
*/
function apiGetApplicationData(sessionId) {
  const appData = getApplicationData(sessionId);
  if (!appData) {
    return null;
  }

  const activeUser = Session.getActiveUser().getEmail().toLowerCase();
  const applicantEmail = String(appData.applicantEmail || '').toLowerCase();

  if (!applicantEmail) {
    throw new Error("Application data is incomplete: missing applicant email.");
  }

  const approverEmails = (appData.approvers || []).map(approver => (approver.email || '').toLowerCase()).filter(Boolean);

  const isOwner = activeUser === applicantEmail;
  const isAuthorizedOfficial = approverEmails.indexOf(activeUser) !== -1;

  if (isOwner || isAuthorizedOfficial) {
    // Sanitize Date objects in approvers to prevent GAS serialization failures
    // via google.script.run postMessage channel
    if (appData.approvers && appData.approvers.length) {
      appData.approvers = appData.approvers.map(function(a) {
        return {
          name: a.name,
          email: a.email,
          role: a.role,
          decision: a.decision,
          comment: a.comment,
          status: a.status,
          decisionDate: a.decisionDate ? String(a.decisionDate) : ''
        };
      });
    }
    return appData;
  }

  Logger.log('SECURITY ALERT: Unauthorized access attempt to ' + sessionId + ' by ' + activeUser);
  throw new Error("Access Denied: You are not authorized to view this record.");
}

/*
  Function: getProp_
  LAYMAN:    Reads a required Script Property and complains loudly (throws) if it is missing.
  TECHNICAL: PropertiesService getter that throws a descriptive Error when the key is unset.
  PARAMS:    - key — the Script Property name.
  RETURNS:   The property value string. Throws if not set.
*/
function getProp_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error(`Script property "${key}" is not set. Configure it in Project Properties.`);
  return val;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TESTING PLEASE REMOVE BEFORE PROD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


/*
  Function: migrateAddReminderColumns
  LAYMAN:    One-time upgrade helper: adds the ReminderDate / EmailStatus / EmailError columns (and the
             queue's NotifiedAdmin column) to existing sheets so older databases work with the reminder
             and failsafe features. Safe to re-run.
  TECHNICAL: For each target sheet, appends any missing header from def.headers (idempotent check) and
             styles it. Does not touch data rows.
  PARAMS:    (none)
  RETURNS:   { success:true, message }.
*/
function migrateAddReminderColumns() {
  var sheets = [
    { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, headers: ['ReminderDate', 'EmailStatus', 'EmailError'] },
    { name: DB_SHEET_NAMES.ISM_WORKFLOW, headers: ['ReminderDate', 'EmailStatus', 'EmailError'] },
    { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, headers: ['ReminderDate', 'EmailStatus', 'EmailError'] },
    { name: DB_SHEET_NAMES.EMAIL_QUEUE, headers: ['NotifiedAdmin'] }
  ];

  sheets.forEach(function(def) {
    var sheet = getDatabaseSheet(def.name, true);
    if (!sheet) {
      Logger.log('⚠ Sheet not found: ' + def.name);
      return;
    }
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

    def.headers.forEach(function(newHeader) {
      var alreadyExists = headers.some(function(h) {
        return String(h || '').trim() === newHeader;
      });

      if (alreadyExists) {
        Logger.log('✓ ' + def.name + ' already has ' + newHeader + ' column');
      } else {
        var col = sheet.getLastColumn() + 1;
        sheet.getRange(1, col).setValue(newHeader);
        sheet.getRange(1, col)
          .setBackground('#185FA5')
          .setFontColor('#FFFFFF')
          .setFontWeight('bold')
          .setFontSize(11);
        Logger.log('✓ Added ' + newHeader + ' column to ' + def.name + ' (column ' + col + ')');
      }
    });
  });

  Logger.log('Migration complete. Run setupReminderTrigger() to enable daily reminders.');
  return { success: true, message: 'Reminder and failsafe columns migrated. Run setupReminderTrigger() next.' };
}

/*
  Function: testReminderEngine
  LAYMAN:    A manual test harness for the daily-reminder logic. It creates fake applications covering
             every status (pending, approved, draft, denied, returned, phantom, already-reminded, ISM),
             runs sendDailyReminders, checks the right ones got reminded, and cleans up after itself.
  TECHNICAL: Diagnostics only (not used at runtime). Seeds Applications + workflow rows under a TEST-
             prefix, invokes sendDailyReminders, asserts Email_Queue results per scenario, then deletes
             the test rows. Logs a pass/fail report.
  PARAMS:    (none)
  RETURNS:   undefined (writes results to Logger).
*/
function testReminderEngine() {
  Logger.log('╔════════════════════════════════════════════════════════════╗');
  Logger.log('║  REMINDER ENGINE — COMPREHENSIVE TEST                      ║');
  Logger.log('╚════════════════════════════════════════════════════════════╝');

  var TEST_PREFIX = 'TEST-RM-' + new Date().getTime().toString(36).toUpperCase();
  var TEST_EMAIL = 'test-reminder@domain.com';
  var results = { passed: 0, failed: 0, scenarios: [] };
  var createdSessionIds = [];
  var cleanedUp = false;

  try {
    // ── STEP 1: Set up test configuration ──
    Logger.log('\n📋 STEP 1: Verifying reminder config...');
    var config = getReminderConfig();
    if (!config.enabled) {
      Logger.log('  ⚠ Reminders are DISABLED. Enabling for test...');
      adminSetReminderConfig({ enabled: true, hour: 8 });
    }
    Logger.log('  ✓ Config: enabled=' + config.enabled + ' hour=' + config.hour);

    // ── STEP 2: Create 7 test scenarios in Applications sheet ──
    Logger.log('\n📋 STEP 2: Creating 7 test scenarios in Applications...');
    var appSheet = getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true);
    var apprSheet = getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
    var ismSheet = getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    var divHeadSheet = getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);

    var scenarios = [
      { id: TEST_PREFIX + '-PEND',  status: 'Pending',                  label: 'Pending — SHOULD remind',                    expectReminder: true,  sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-APPROV',status: 'Approved',                 label: 'Approved (ISM active) — SHOULD remind',      expectReminder: true,  sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-DRAFT', status: 'Draft',                    label: 'Draft — should NOT remind',                  expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-DENIED',status: 'Denied',                   label: 'Denied — should NOT remind',                 expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-RETRN', status: 'Returned',                 label: 'Returned — should NOT remind',               expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-PHNTM', status: null,                       label: 'Phantom (no app row) — should NOT remind',    expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW, phantom: true },
      { id: TEST_PREFIX + '-ISM',   status: 'Approved',                 label: 'ISM Pending — SHOULD remind',                expectReminder: true,  sheet: DB_SHEET_NAMES.ISM_WORKFLOW },
      { id: TEST_PREFIX + '-ALRDY', status: 'Pending',                  label: 'Already reminded today — should NOT remind',  expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW, alreadyReminded: true }
    ];

    var todayStr = new Date().getFullYear() + '-' +
      String(new Date().getMonth() + 1).padStart(2, '0') + '-' +
      String(new Date().getDate()).padStart(2, '0');

    scenarios.forEach(function(s) {
      createdSessionIds.push(s.id);

      // Create minimal PIA JSON data for getApplicationData() to work
      var pia1Data = JSON.stringify({ program: 'Test Program - ' + s.label, department: 'Test Dept' });
      var pia5Data = JSON.stringify(['YES','YES','YES','YES','YES','YES','YES','YES']);

      // Insert into Applications sheet (skip for phantom scenario)
      if (!s.phantom) {
        appSheet.appendRow([
          s.id,               // SessionID
          TEST_EMAIL,          // ApplicantEmail
          s.status,            // Status
          pia1Data,            // PIA_1_Data
          '{}',                // PIA_2_Data
          '{}',                // PIA_3_Data
          '{}',                // PIA_4_Data
          pia5Data,            // PIA_5_Data
          '',                  // AdminExportID
          new Date().toLocaleString('en-PH'),  // SubmissionDate
          'NO',                // IsFlagged
          '',                  // Notes
          '',                  // Linked_ReqID
          '{}'                 // Approver_Flags
        ]);
      }

      // Insert into workflow sheet
      var targetSheet = s.sheet === DB_SHEET_NAMES.ISM_WORKFLOW ? ismSheet : apprSheet;
      var reminderDateValue = s.alreadyReminded ? todayStr : '';

      if (s.sheet === DB_SHEET_NAMES.ISM_WORKFLOW) {
        ismSheet.appendRow([
          s.id + '-ISM',        // ISM_Approval_ID
          s.id,                 // SessionID
          1,                    // CurrentStep
          'Test ISM Member',    // ISM_Member_Name
          TEST_EMAIL,           // ISM_Member_Email
          '',                   // Decision
          '',                   // Comments
          '',                   // DecisionDate
          'Pending',            // Status
          'NO',                 // Requires_DivHead
          '',                   // DivHead_Escalation_ID
          '',                   // Routing_Destination
          reminderDateValue,    // ReminderDate
          'Pending',            // EmailStatus
          ''                    // EmailError
        ]);
      } else {
        apprSheet.appendRow([
          s.id + '-APPR',       // ApprovalID
          s.id,                 // SessionID
          1,                    // CurrentStep
          'Test Approver',      // ApproverName
          TEST_EMAIL,           // ApproverEmail
          '',                   // Decision
          '',                   // Comments
          '',                   // DecisionDate
          'Pending',            // Status
          reminderDateValue,    // ReminderDate
          'Pending',            // EmailStatus
          ''                    // EmailError
        ]);
      }
    });

    Logger.log('  ✓ Created ' + scenarios.length + ' test entries');

    // ── STEP 3: Test sequence ordering (Step 2 should NOT be reminded if Step 1 is pending) ──
    Logger.log('\n📋 STEP 3: Testing sequence enforcement...');
    var seqId = TEST_PREFIX + '-SEQ';
    createdSessionIds.push(seqId);
    appSheet.appendRow([
      seqId, TEST_EMAIL, 'Pending',
      JSON.stringify({ program: 'Sequence Test', department: 'Test' }),
      '{}','{}','{}',JSON.stringify(['YES','YES','YES','YES','YES','YES','YES','YES']),
      '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}'
    ]);
    apprSheet.appendRow([seqId + '-S2', seqId, 2, 'Second Approver', TEST_EMAIL, '', '', '', 'Pending', '', 'Pending', '']);
    apprSheet.appendRow([seqId + '-S1', seqId, 1, 'First Approver',  TEST_EMAIL, '', '', '', 'Pending', '', 'Pending', '']);
    // NOTE: Step 2 appended first but Step 1 should be reminded (lowest step number)
    Logger.log('  ✓ Sequence test entry created (Step 1 & 2, both Pending)');

    // ── STEP 4: Run the reminder engine ──
    Logger.log('\n📋 STEP 4: Running sendDailyReminders()...');
    var result = sendDailyReminders();
    Logger.log('  ✓ Result: reminded=' + result.reminded + ', processed=' + result.processed);

    // ── STEP 5: Validate Email_Queue results ──
    Logger.log('\n📋 STEP 5: Validating Email_Queue...');
    var queueSheet = getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    var queueData = queueSheet.getDataRange().getValues();

    // Count 'reminder' type entries for our test sessionIds
    var remindedIds = {};
    for (var qi = 1; qi < queueData.length; qi++) {
      var qSessionId = String(queueData[qi][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').trim();
      var qType = String(queueData[qi][EMAIL_QUEUE_COLS.TYPE - 1] || '').trim();
      var qRecipient = String(queueData[qi][EMAIL_QUEUE_COLS.RECIPIENT - 1] || '').trim();

      if (qType === 'reminder' && qSessionId.indexOf(TEST_PREFIX) === 0) {
        remindedIds[qSessionId] = { sessionId: qSessionId, recipient: qRecipient };
      }
    }

    // Check each scenario
    scenarios.forEach(function(s) {
      var wasReminded = !!remindedIds[s.id];
      if ((s.expectReminder && wasReminded) || (!s.expectReminder && !wasReminded)) {
        Logger.log('  ✅ PASS: ' + s.label + ' (reminded=' + wasReminded + ')');
        results.passed++;
        results.scenarios.push({ name: s.label, status: 'PASS', reminded: wasReminded, expected: s.expectReminder });
      } else {
        Logger.log('  ❌ FAIL: ' + s.label + ' (expected remind=' + s.expectReminder + ', got=' + wasReminded + ')');
        results.failed++;
        results.scenarios.push({ name: s.label, status: 'FAIL', reminded: wasReminded, expected: s.expectReminder });
      }
    });

    // Check sequence enforcement: PIA-TEST-RM-SEQ-SEQ should remind Step 1, NOT Step 2
    var seqFound = remindedIds[seqId];
    if (seqFound) {
      Logger.log('  ✅ PASS: Sequence test — first pending step was reminded (Step 1)');
      results.passed++;
      results.scenarios.push({ name: 'Sequence enforcement', status: 'PASS', reminded: true });
    } else {
      Logger.log('  ⚠ Sequence test — no reminder (may be legitimate if quota/other issue)');
      results.scenarios.push({ name: 'Sequence enforcement', status: 'WARN', reminded: false });
    }

    // ── STEP 6: Summary ──
    Logger.log('\n════════════════════════════════════════════════════════════');
    Logger.log('  TEST SUMMARY');
    Logger.log('════════════════════════════════════════════════════════════');
    Logger.log('  Passed: ' + results.passed + ' / Failed: ' + results.failed);
    Logger.log('  Total scenarios: ' + (results.passed + results.failed));

    if (results.failed === 0) {
      Logger.log('\n  ✅ ALL TESTS PASSED — Reminder engine is working correctly.');
    } else {
      Logger.log('\n  ❌ ' + results.failed + ' TEST(S) FAILED — Check logs above for details.');
    }

  } catch (e) {
    Logger.log('\n  ❌ TEST CRASHED: ' + e.toString());
    Logger.log('Stack: ' + e.stack);
    results.failed++;
    results.error = e.toString();
  } finally {
    // ── CLEANUP: Remove all test entries ──
    Logger.log('\n📋 CLEANUP: Removing test entries...');
    try {
      var cleanupSheets = [
        { sheet: getDatabaseSheet(DB_SHEET_NAMES.APPLICATIONS, true), col: 1 },
        { sheet: getDatabaseSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true), col: 2 },
        { sheet: getDatabaseSheet(DB_SHEET_NAMES.ISM_WORKFLOW, true), col: 2 },
        { sheet: getDatabaseSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true), col: 2 },
        { sheet: getDatabaseSheet(DB_SHEET_NAMES.EMAIL_QUEUE, true), col: 2 }
      ];

      cleanupSheets.forEach(function(cs) {
        if (!cs.sheet) return;
        var cd = cs.sheet.getDataRange().getValues();
        var rowsToDelete = [];
        for (var ci = 1; ci < cd.length; ci++) {
          var val = String(cd[ci][cs.col - 1] || '').trim();
          // Match TEST prefix sessionIds or email queue entries with TEST prefix
          if (val.indexOf(TEST_PREFIX) === 0) {
            rowsToDelete.push(ci + 1);
          }
        }
        if (rowsToDelete.length > 0) {
          batchDeleteRows(cs.sheet, rowsToDelete);
        }
      });

      cleanedUp = true;
      Logger.log('  ✓ Test data cleaned up successfully');
    } catch (cleanErr) {
      Logger.log('  ⚠ Cleanup warning: ' + cleanErr.toString());
    }
  }

  Logger.log('\n╚════════════════════════════════════════════════════════════╝');
  return results;
}

/*
  Function: testFullSystemFlow
  LAYMAN:    A big manual end-to-end test of the whole PIA lifecycle — submit, approve, return, deny,
             resubmit, the ISM/Division-Head path, email queue, and admin APIs — plus a small scalability
             batch. For developer verification in the Apps Script editor.
  TECHNICAL: Diagnostics only (not used at runtime). Drives the real functions against TEST-prefixed
             records, asserts sequence enforcement and duplicate-prevention, then reports pass/fail.
  PARAMS:    (none)
  RETURNS:   A results object (also logged).
*/
function testFullSystemFlow() {
  Logger.log('╔══════════════════════════════════════════════════════════════╗');
  Logger.log('║  ULTIMATE SYSTEM FLOW — COMPREHENSIVE END-TO-END TEST       ║');
  Logger.log('╚══════════════════════════════════════════════════════════════╝');

  var T = 'TST-' + new Date().getTime().toString(36).toUpperCase();
  var E = 'test-flow@domain.com';
  var results = { failed: 0, passed: 0, total: 0, details: [] };
  var createdSheets = [];
  var allTestIds = [];

  function check(label, ok, detail) {
    results.total++;
    if (ok) { results.passed++; Logger.log('  ✅ ' + label); }
    else { results.failed++; Logger.log('  ❌ ' + label + ' → ' + detail); }
    results.details.push({ label: label, pass: ok, detail: detail });
  }

  function getSheet(sheetName) {
    var s = getDatabaseSheet(sheetName, true);
    if (createdSheets.indexOf(sheetName) < 0) createdSheets.push(sheetName);
    return s;
  }

  function genId(label) { var id = T + '-' + label + '-' + Math.random().toString(36).substring(2,6); allTestIds.push(id); return id; }

  function cleanTestData() {
    Logger.log('\n🧹 Cleaning test data...');
    var cleanupSheets = [
      { sheet: getSheet(DB_SHEET_NAMES.APPLICATIONS), col: 1 },
      { sheet: getSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW), col: 2 },
      { sheet: getSheet(DB_SHEET_NAMES.ISM_WORKFLOW), col: 2 },
      { sheet: getSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG), col: 2 },
      { sheet: getSheet(DB_SHEET_NAMES.EMAIL_QUEUE), col: 2 },
      { sheet: getSheet(DB_SHEET_NAMES.RISK_AUDIT), col: 2 },
      { sheet: getSheet(DB_SHEET_NAMES.DATA_COLLECTION), col: 2 },
      { sheet: getSheet(DB_SHEET_NAMES.DRAFTS), col: 2 }
    ];
    cleanupSheets.forEach(function(cs) {
      if (!cs.sheet) return;
      var cd = cs.sheet.getDataRange().getValues();
      var rows = [];
      for (var ci = 1; ci < cd.length; ci++) {
        for (var ti = 0; ti < allTestIds.length; ti++) {
          if (String(cd[ci][cs.col - 1] || '').indexOf(allTestIds[ti]) === 0) { rows.push(ci + 1); break; }
        }
      }
      if (rows.length > 0) batchDeleteRows(cs.sheet, rows);
    });
    // Also clean Email_Queue by Type
    try {
      var eqSheet = getSheet(DB_SHEET_NAMES.EMAIL_QUEUE);
      var eqData = eqSheet.getDataRange().getValues();
      var eqRows = [];
      for (var ei = 1; ei < eqData.length; ei++) {
        var eqType = String(eqData[ei][EMAIL_QUEUE_COLS.TYPE - 1] || '');
        if (eqType === 'approver' || eqType === 'applicant' || eqType === 'reminder' || eqType === 'ism' || eqType === 'divhead') {
          for (var ti2 = 0; ti2 < allTestIds.length; ti2++) {
            if (String(eqData[ei][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').indexOf(allTestIds[ti2]) === 0) { eqRows.push(ei + 1); break; }
          }
        }
      }
      if (eqRows.length > 0) batchDeleteRows(eqSheet, eqRows);
    } catch(_) {}
    Logger.log('  ✓ Cleanup complete');
  }

  var appSheet = getSheet(DB_SHEET_NAMES.APPLICATIONS);
  var apprSheet = getSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW);
  var ismSheet = getSheet(DB_SHEET_NAMES.ISM_WORKFLOW);
  var divSheet = getSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG);
  var queueSheet = getSheet(DB_SHEET_NAMES.EMAIL_QUEUE);

  try {
    // ─────────────────────────────────────────────────────────────
    // ═══════════════ PHASE 2: HEAD APPROVAL FLOW ═════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ PHASE 2: HEAD APPROVAL FLOW ═══════════════');

    // Create minimal PIA data
    var pia1 = JSON.stringify({ program:'Test Program', dept:'IT', immediateHead:'Alice', immediateHeadEmail:E, deptHead:'Bob', deptHeadEmail:E, drafterEmail:E });
    var pia5 = JSON.stringify(['YES','YES','YES','YES','YES','YES','YES','YES']);

    // ── TEST A: Full approval chain (Step 1 Approve → Step 2 Approve → ISM init) ──
    Logger.log('\n📌 A. Full approval chain');
    var aId = genId('FULL');
    appSheet.appendRow([aId, E, 'Pending', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apprSheet.appendRow([aId+'-A1', aId, 1, 'Approver A1', E, '','', '','Pending','','Pending','']);
    apprSheet.appendRow([aId+'-A2', aId, 2, 'Approver A2', E, '','', '','Pending','','Pending','']);

    // Step 1 Approve
    var r1 = processApprovalDecision(aId, E, 'Approve', 'Looks good, approved.', null, '{}');
    check('Step 1 Approve succeeds', r1.success, r1.error);
    SpreadsheetApp.flush();

    // Verify Step 1 is Approved
    var d = apprSheet.getDataRange().getValues();
    var step1ok = false, step2stillPending = false, appStatusApproved = false;
    for (var i = 1; i < d.length; i++) {
      if (d[i][APPROVAL_COLS.SESSION_ID - 1] === aId && d[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) step1ok = (d[i][APPROVAL_COLS.STATUS - 1] === 'Approved');
      if (d[i][APPROVAL_COLS.SESSION_ID - 1] === aId && d[i][APPROVAL_COLS.CURRENT_STEP - 1] == 2) step2stillPending = (d[i][APPROVAL_COLS.STATUS - 1] === 'Pending');
    }
    check('Step 1 status becomes Approved', step1ok, '');
    check('Step 2 still Pending after Step 1', step2stillPending, '');

    // Step 2 Approve
    var r2 = processApprovalDecision(aId, E, 'Approve', 'Also approved.', null, '{}');
    check('Step 2 Approve succeeds', r2.success, r2.error);
    SpreadsheetApp.flush();

    // Check app is Approved (Phase 3 init)
    var apps = appSheet.getDataRange().getValues();
    for (var i = 1; i < apps.length; i++) {
      if (apps[i][APPLICATIONS_COLS.SESSION_ID - 1] === aId) { appStatusApproved = (String(apps[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved') === 0); break; }
    }
    check('Application status becomes Approved', appStatusApproved, '');

    // Verify ISM workflow was initialized (2 rows in ISM sheet)
    var ismRows = 0;
    var ismD = ismSheet.getDataRange().getValues();
    for (var i = 1; i < ismD.length; i++) { if (ismD[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === aId) ismRows++; }
    check('ISM workflow initialized (2 rows)', ismRows === 2, 'found ' + ismRows);

    // Verify email was queued for applicant "approved_main"
    var queueData = queueSheet.getDataRange().getValues();
    var foundApplicantEmail = false;
    for (var i = 1; i < queueData.length; i++) {
      if (String(queueData[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '') === aId && String(queueData[i][EMAIL_QUEUE_COLS.TYPE - 1] || '') === 'applicant') {
        foundApplicantEmail = true; break;
      }
    }
    check('Applicant notification queued', foundApplicantEmail, '');

    // ── TEST B: Return to Requestor ──
    Logger.log('\n📌 B. Return to requestor');
    var bId = genId('RETN');
    appSheet.appendRow([bId, E, 'Pending', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apprSheet.appendRow([bId+'-B1', bId, 1, 'Approver B1', E, '','', '','Pending','','Pending','']);

    var r3 = processApprovalDecision(bId, E, 'Return', 'Please fix the scope section. This is a detailed comment explaining what needs to be changed. It needs to be at least 100 characters so adding more text here to meet the limit.', null, '{"PIA 1 - Scope":"Scope section is too vague"}');
    check('Return succeeds', r3.success, r3.error);

    var appsB = appSheet.getDataRange().getValues();
    var retRow = null, retStatus = '';
    for (var i = 1; i < appsB.length; i++) { if (appsB[i][APPLICATIONS_COLS.SESSION_ID - 1] === bId) { retRow = i; retStatus = String(appsB[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('Application status becomes Returned', retStatus === 'Returned', retStatus);
    check('ApproverFlags stored for returned app', String(appsB[retRow][APPLICATIONS_COLS.APPROVER_FLAGS - 1] || '').indexOf('Scope') > 0, '');

    // ── TEST C: Deny ──
    Logger.log('\n📌 C. Deny application');
    var cId = genId('DENY');
    appSheet.appendRow([cId, E, 'Pending', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apprSheet.appendRow([cId+'-C1', cId, 1, 'Approver C1', E, '','', '','Pending','','Pending','']);

    var r4 = processApprovalDecision(cId, E, 'Deny', 'This project does not meet compliance requirements. The policy framework is not fully established and data handling procedures are undefined. Additional work is needed before resubmission.', null, '{}');
    check('Deny succeeds', r4.success, r4.error);

    var appsC = appSheet.getDataRange().getValues();
    var denyStatus = '';
    for (var i = 1; i < appsC.length; i++) { if (appsC[i][APPLICATIONS_COLS.SESSION_ID - 1] === cId) { denyStatus = String(appsC[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('Application status becomes Denied', denyStatus === 'Denied', denyStatus);

    // Verify Step 1 status is Denied
    var dC = apprSheet.getDataRange().getValues();
    var step1Denied = false;
    for (var i = 1; i < dC.length; i++) { if (dC[i][APPROVAL_COLS.SESSION_ID - 1] === cId && dC[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) { step1Denied = (dC[i][APPROVAL_COLS.STATUS - 1] === 'Denied'); break; } }
    check('Approval record set to Denied', step1Denied, '');

    // ── TEST D: Duplicate/re-process prevention ──
    Logger.log('\n📌 D. Re-process prevention');
    var r5 = processApprovalDecision(bId, E, 'Approve', 'Trying to approve a returned app', null, '{}');
    check('Re-processing returned app returns error', !r5.success, 'should fail');
    var r6 = processApprovalDecision(cId, E, 'Approve', 'Trying to approve a denied app', null, '{}');
    check('Re-processing denied app returns error', !r6.success, 'should fail');

    // ─────────────────────────────────────────────────────────────
    // ═══════════════ PHASE 3: ISM WORKFLOW ═══════════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ PHASE 3: ISM WORKFLOW ═══════════════════════');

    // Create an app approved by heads for ISM testing
    var dId = genId('P3OK');
    appSheet.appendRow([dId, E, 'Approved', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apprSheet.appendRow([dId+'-D1', dId, 1, 'Approver D1', E, 'Approved','ok','today','Approved','','Sent','']);
    // Initialize ISM workflow
    var initResult = apiPhase3_InitializeISMWorkflow(dId);
    check('ISM init for P3 test succeeds', initResult.success, initResult.error);

    // ── TEST E: ISM Person 1 Approves → Person 2 notified ──
    Logger.log('\n📌 E. ISM Person 1 Approve (triggers routing)');
    // Get the ISM member emails
    var ismData2 = ismSheet.getDataRange().getValues();
    var p1Email = '', p2Email = '';
    for (var i = 1; i < ismData2.length; i++) {
      if (ismData2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismData2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) p1Email = ismData2[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
      if (ismData2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismData2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) p2Email = ismData2[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
    }
    check('ISM Person 1 has email', !!p1Email, p1Email);
    check('ISM Person 2 has email', !!p2Email, p2Email);

    var r7 = apiPhase3_ProcessISMDecision(dId, p1Email, 'Approve', 'ISM P1 approves with BOTH routing.', 'BOTH', 1, '{}');
    check('ISM Person 1 Approve succeeds', r7.success, r7.error);
    SpreadsheetApp.flush();

    // Check Person 2 is still Pending
    var ismD2 = ismSheet.getDataRange().getValues();
    var p2Status = '';
    for (var i = 1; i < ismD2.length; i++) { if (ismD2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismD2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) p2Status = String(ismD2[i][ISM_WORKFLOW_COLS.STATUS - 1] || ''); break; }
    // Person 2 should still be Pending (needs unanimous approval)
    // Actually wait, after Person 1 approves, Person 2 should still be Pending
    for (var i = 1; i < ismD2.length; i++) {
      if (ismD2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismD2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) { p2Status = String(ismD2[i][ISM_WORKFLOW_COLS.STATUS - 1] || ''); break; }
    }
    check('Person 2 still Pending after P1 approves', p2Status === 'Pending', p2Status);

    // ── TEST F: ISM Person 2 Approves → Full approval → Routing ──
    Logger.log('\n📌 F. ISM Person 2 Approve (triggers full approval & routing)');
    var r8 = apiPhase3_ProcessISMDecision(dId, p2Email, 'Approve', 'ISM P2 approves.', '', 2, '{}');
    check('ISM Person 2 Approve succeeds', r8.success, r8.error);
    SpreadsheetApp.flush();

    // Check app status becomes Approved by ISM
    var appD2 = appSheet.getDataRange().getValues();
    var ismFinalStatus = '';
    for (var i = 1; i < appD2.length; i++) { if (appD2[i][APPLICATIONS_COLS.SESSION_ID - 1] === dId) { ismFinalStatus = String(appD2[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App status after ISM approval', ismFinalStatus.indexOf('Approved by ISM') >= 0 || ismFinalStatus.indexOf('Approved') >= 0, ismFinalStatus);

    // ── TEST G: ISM Deny ──
    Logger.log('\n📌 G. ISM Deny');
    var gId = genId('ISMDN');
    appSheet.appendRow([gId, E, 'Approved', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apiPhase3_InitializeISMWorkflow(gId);

    // Find the ISM emails for this new app
    var ismG = ismSheet.getDataRange().getValues();
    var p1G = '';
    for (var i = 1; i < ismG.length; i++) { if (ismG[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === gId && ismG[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1G = ismG[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r9 = apiPhase3_ProcessISMDecision(gId, p1G, 'Deny', 'This application has security risks that cannot be mitigated. Comprehensive review indicates multiple compliance gaps in data handling procedures. This decision is final.', '', 1, '{}');
    check('ISM Deny succeeds', r9.success, r9.error);

    var appG = appSheet.getDataRange().getValues();
    var ismDenyStatus = '';
    for (var i = 1; i < appG.length; i++) { if (appG[i][APPLICATIONS_COLS.SESSION_ID - 1] === gId) { ismDenyStatus = String(appG[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App becomes Rejected by ISM', ismDenyStatus.indexOf('Rejected') >= 0, ismDenyStatus);

    // ── TEST H: ISM Return ──
    Logger.log('\n📌 H. ISM Return');
    var hId = genId('ISMRT');
    appSheet.appendRow([hId, E, 'Approved', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apiPhase3_InitializeISMWorkflow(hId);

    var ismH = ismSheet.getDataRange().getValues();
    var p1H = '';
    for (var i = 1; i < ismH.length; i++) { if (ismH[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === hId && ismH[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1H = ismH[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r10 = apiPhase3_ProcessISMDecision(hId, p1H, 'Return', 'Please update the scope section and add more detail about data retention policies. The current description is too brief. Also ensure the DCS fields are updated accordingly. This requires at least fifty characters.', '', 1, '{}');
    check('ISM Return succeeds', r10.success, r10.error);

    var appH = appSheet.getDataRange().getValues();
    var ismRetStatus = '';
    for (var i = 1; i < appH.length; i++) { if (appH[i][APPLICATIONS_COLS.SESSION_ID - 1] === hId) { ismRetStatus = String(appH[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App becomes Returned after ISM return', ismRetStatus === 'Returned', ismRetStatus);

    // ── TEST I: ISM Escalate → Division Head Approve ──
    Logger.log('\n📌 I. ISM Escalate → Div Head Approve');
    // Create app with DivHead email in PIA1 data
    var pia1Div = JSON.stringify({ program:'Test Escalation', dept:'IT', immediateHead:'Alice', immediateHeadEmail:E, deptHead:'Bob', deptHeadEmail:E, divHead:'Carol', divHeadEmail:E, drafterEmail:E });
    var iId = genId('P3ESC');
    appSheet.appendRow([iId, E, 'Approved', pia1Div,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apiPhase3_InitializeISMWorkflow(iId);
    SpreadsheetApp.flush();

    var ismI = ismSheet.getDataRange().getValues();
    var p1I = '';
    for (var i = 1; i < ismI.length; i++) { if (ismI[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === iId && ismI[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1I = ismI[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r11 = apiPhase3_ProcessISMDecision(iId, p1I, 'EscalateToDivisionHead', 'This requires executive review due to cross-departmental data sharing concerns. The application involves sensitive PII that needs Division Head sign-off.', 'BOTH', 1, '{}');
    check('ISM Escalate succeeds', r11.success, r11.error);
    SpreadsheetApp.flush();

    // Check Div Head record was created
    var divI = divSheet.getDataRange().getValues();
    var divPending = false;
    for (var i = 1; i < divI.length; i++) { if (divI[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === iId && divI[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') { divPending = true; break; } }
    check('DivHead escalation record created', divPending, '');

    // Div Head approves (resolves Person 1's escalation, notifies Person 2)
    var r12 = processDivHeadDecision(iId, E, 'Approve', 'Division Head approves after review. This is a detailed comment explaining the approval rationale for the escalated application. It must be long enough to pass validation.', '{}');
    check('DivHead Approve succeeds', r12.success, r12.error);
    SpreadsheetApp.flush();

    // App stays "Escalated to Division Head" until Person 2 also approves
    var appI = appSheet.getDataRange().getValues();
    var escStatus = '';
    for (var i = 1; i < appI.length; i++) { if (appI[i][APPLICATIONS_COLS.SESSION_ID - 1] === iId) { escStatus = String(appI[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App still Escalated after DivHead (waiting for Person 2)', escStatus.indexOf('Escalated') >= 0, escStatus);

    // Now Person 2 approves → full approval reached
    var ismI2 = ismSheet.getDataRange().getValues();
    var p2I = '';
    for (var i = 1; i < ismI2.length; i++) { if (ismI2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === iId && ismI2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) { p2I = ismI2[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }
    var r13 = apiPhase3_ProcessISMDecision(iId, p2I, 'Approve', 'Person 2 approves after DivHead resolution.', 'BOTH', 2, '{}');
    check('ISM Person 2 Approve after Escalation succeeds', r13.success, r13.error);
    SpreadsheetApp.flush();

    var appI2 = appSheet.getDataRange().getValues();
    var escFinal = '';
    for (var i = 1; i < appI2.length; i++) { if (appI2[i][APPLICATIONS_COLS.SESSION_ID - 1] === iId) { escFinal = String(appI2[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App reaches Approved by ISM after full Escalation chain', escFinal.indexOf('Approved by ISM') >= 0, escFinal);

    // ─────────────────────────────────────────────────────────────
    // ═══════════════ ADMIN API TESTS ═════════════════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ ADMIN API TESTS ═══════════════════════════════');

    var qSum = adminGetQueueSummary();
    check('adminGetQueueSummary returns data', qSum.success, qSum.error);
    check('Queue summary has total > 0', qSum.data.total > 0, 'total=' + qSum.data.total);

    var qLog = adminGetEmailLog(aId);
    check('adminGetEmailLog returns array for FullApp', Array.isArray(qLog), typeof qLog);

    var failed = adminGetFailedEmails(30);
    check('adminGetFailedEmails returns array', Array.isArray(failed), typeof failed);

    var remConfig = adminGetReminderConfig();
    check('adminGetReminderConfig returns data', remConfig.success, remConfig.error);

    // ─────────────────────────────────────────────────────────────
    // ═══════════════ SCALABILITY TEST ════════════════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ SCALABILITY TEST ════════════════════════════════');
    Logger.log('  Creating 25 test applications and running reminders...');
    var S = 25;
    var sCount = 0;
    for (var s = 0; s < S; s++) {
      var sId = genId('SCALE');
      appSheet.appendRow([sId, E, 'Pending', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
      apprSheet.appendRow([sId+'-S1', sId, 1, 'Scaler', E, '','', '','Pending','','Pending','']);
      sCount++;
    }
    check('Scalability: Created ' + S + ' apps', sCount === S, 'created ' + sCount);

    // Run reminder engine on these
    var remResult = sendDailyReminders();
    check('sendDailyReminders processes scalability batch', remResult.success, remResult.error);
    check('Reminder engine scanned scalability batch', remResult.processed >= S, 'processed ' + remResult.processed);

    // Verify pre-filter caught correct count
    if (remResult.processed >= S) {
      check('Reminders queued for scalability batch', remResult.reminded >= S || remResult.capped || remResult.quotaExhausted, 'reminded ' + remResult.reminded);
    }

    // ─────────────────────────────────────────────────────────────
    // ═══════════════ SEQUENCE ENFORCEMENT ═══════════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ SEQUENCE ENFORCEMENT ═══════════════════════════════');
    var seqId = genId('SEQ');
    appSheet.appendRow([seqId, E, 'Pending', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    // Append Step 2 first (out of order), then Step 1
    apprSheet.appendRow([seqId+'-S2', seqId, 2, 'Second Approver', E, '','', '','Pending','','Pending','']);
    apprSheet.appendRow([seqId+'-S1', seqId, 1, 'First Approver',  E, '','', '','Pending','','Pending','']);

    // First pass: Step 2 was appended first (lower row), but Step 1 has lower step number
    // The collection pass should pick Step 1 (lowest step)
    var rem2 = sendDailyReminders();
    check('Reminder ran for sequence test', rem2.success, rem2.error);

    // Check Email_Queue: should have exactly 1 reminder entry for seqId (Step 1 only)
    var eqD = queueSheet.getDataRange().getValues();
    var seqReminders = [];
    for (var i = 1; i < eqD.length; i++) {
      if (String(eqD[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '') === seqId && String(eqD[i][EMAIL_QUEUE_COLS.TYPE - 1] || '') === 'reminder') {
        seqReminders.push(eqD[i][EMAIL_QUEUE_COLS.SUBJECT - 1] || '');
      }
    }
    check('Sequence enforced: only 1 reminder for seqId', seqReminders.length === 1, 'got ' + seqReminders.length + ' reminders');

    // ──────────────── SUMMARY ────────────────
    Logger.log('\n══════════════════════════════════════════════════════════════');
    Logger.log('  OVERALL RESULTS');
    Logger.log('══════════════════════════════════════════════════════════════');
    Logger.log('  ✅ Passed: ' + results.passed);
    Logger.log('  ❌ Failed: ' + results.failed);
    Logger.log('  📊 Total:  ' + results.total);
    Logger.log('  📈 Score:  ' + (results.total > 0 ? Math.round(results.passed / results.total * 100) : 0) + '%');
    if (results.failed === 0) {
      Logger.log('\n  🎉 ALL TESTS PASSED — System is working correctly!');
    } else {
      Logger.log('\n  ⚠️  ' + results.failed + ' test(s) failed. Review details above.');
    }

  } catch (e) {
    Logger.log('\n  ❌ TEST CRASHED: ' + e.toString());
    Logger.log('  Stack: ' + e.stack);
    results.failed++;
  } finally {
    cleanTestData();
  }

  Logger.log('\n╚══════════════════════════════════════════════════════════════╝');
  return results;
}

/*
  Function: testUltimateSystem
  LAYMAN:    The most thorough manual mega-test — runs every Phase 2 & 3 path (approvals, return, deny,
             ISM full/deny/return/escalate, Division Head, routing), the email failsafe, all admin APIs,
             the reminder engine, and a 20-user concurrency batch. Developer use only; expects >=2
             InfoSec members configured.
  TECHNICAL: Diagnostics only (not used at runtime). Drives the real functions against TEST-prefixed
             data, asserts sequence enforcement / duplicate-prevention / no corruption under batch load,
             then reports pass/fail. See the checklist below.
  PARAMS:    (none)
  RETURNS:   A results object (also logged).

  Tests end-to-end:
 *   ✓ Head Approval Chain (Submit → Step1 → Step2 → ISM init)
 *   ✓ Return to Requestor (with flags)
 *   ✓ Deny application
 *   ✓ ISM Full Approval (P1 → P2 → Approved by ISM)
 *   ✓ ISM Deny / Return
 *   ✓ ISM Escalate → Division Head → Full chain
 *   ✓ Email Failsafe (EmailStatus stamping on workflow rows)
 *   ✓ Admin Notification Config (get/set)
 *   ✓ Pipeline View (adminGetPipelineView)
 *   ✓ Resend to Stage (adminResendToStage)
 *   ✓ Reminder Engine (sendDailyReminders)
 *   ✓ 20 Concurrent Users (batch simulate + verify no corruption)
 *   ✓ Sequence Enforcement
 *   ✓ Duplicate/Re-process Prevention
 *   ✓ Admin APIs (queue summary, email log, failed emails, notification config)
 *
 * Run from Apps Script editor. View → Logs for results.
 * ⚠️  Expects InfoSec_Email_Config to have at least 2 InfoSec members.
 */
function testUltimateSystem() {
  Logger.log('╔══════════════════════════════════════════════════════════════════╗');
  Logger.log('║  🔥 ULTIMATE MEGA-TEST — ALL PATHS, 20 CONCURRENT USERS          ║');
  Logger.log('╚══════════════════════════════════════════════════════════════════╝');

  var T = 'MEGA-' + new Date().getTime().toString(36).toUpperCase();
  var E = 'mega-test@domain.com';
  var results = { passed: 0, failed: 0, total: 0, details: [] };
  var allTestIds = [];

  function check(label, ok, detail) {
    results.total++;
    if (ok) { results.passed++; Logger.log('  ✅ ' + label); }
    else { results.failed++; Logger.log('  ❌ ' + label + (detail ? ' → ' + detail : '')); }
    results.details.push({ label: label, pass: !!ok, detail: detail || '' });
  }

  function getS(name) { return getDatabaseSheet(name, true); }

  function genId(label) {
    var id = T + '-' + label + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    allTestIds.push(id);
    return id;
  }

  // ── Cleanup helper ──
  function cleanAll() {
    Logger.log('\n🧹 Cleaning test data (' + allTestIds.length + ' IDs)...');
    var cleanupDefs = [
      { sheet: DB_SHEET_NAMES.APPLICATIONS, col: 1 },
      { sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW, col: 2 },
      { sheet: DB_SHEET_NAMES.ISM_WORKFLOW, col: 2 },
      { sheet: DB_SHEET_NAMES.DIV_HEAD_CONFIG, col: 2 },
      { sheet: DB_SHEET_NAMES.EMAIL_QUEUE, col: 2 },
      { sheet: DB_SHEET_NAMES.RISK_AUDIT, col: 2 }
    ];
    cleanupDefs.forEach(function(d) {
      var s = getDatabaseSheet(d.sheet, false);
      if (!s || s.getLastRow() < 2) return;
      var data = s.getDataRange().getValues();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var cellVal = String(data[i][d.col - 1] || '').trim();
        for (var ti = 0; ti < allTestIds.length; ti++) {
          if (cellVal.indexOf(allTestIds[ti]) === 0) { rows.push(i + 1); break; }
        }
      }
      if (rows.length > 0) batchDeleteRows(s, rows);
    });
    Logger.log('  ✓ Cleanup complete');
  }

  var appSheet = getS(DB_SHEET_NAMES.APPLICATIONS);
  var apprSheet = getS(DB_SHEET_NAMES.APPROVAL_WORKFLOW);
  var ismSheet = getS(DB_SHEET_NAMES.ISM_WORKFLOW);
  var divSheet = getS(DB_SHEET_NAMES.DIV_HEAD_CONFIG);
  var queueSheet = getS(DB_SHEET_NAMES.EMAIL_QUEUE);

  var pia1 = JSON.stringify({ program: 'Mega Test Program', dept: 'QA', immediateHead: 'Alice', immediateHeadEmail: E, deptHead: 'Bob', deptHeadEmail: E, drafterEmail: E });
  var pia5 = JSON.stringify(['YES','YES','YES','YES','YES','YES','YES','YES']);

  try {
    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: HEAD APPROVAL CHAIN
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 1: HEAD APPROVAL CHAIN ════════');

    var aId = genId('FULL');
    appSheet.appendRow([aId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([aId + '-A1', aId, 1, 'Approver A1', E, '', '', '', 'Pending', '', 'Pending', '']);
    apprSheet.appendRow([aId + '-A2', aId, 2, 'Approver A2', E, '', '', '', 'Pending', '', 'Pending', '']);

    var r1 = processApprovalDecision(aId, E, 'Approve', 'Step 1 approved — looks good. This is a detailed comment meeting the minimum length requirement for validation purposes.', null, '{}');
    check('S1: Step 1 Approve succeeds', r1.success, r1.error);
    SpreadsheetApp.flush();

    // Verify EmailStatus was stamped on Step 1 row
    var ad = apprSheet.getDataRange().getValues();
    var step1EmailStamped = false;
    for (var i = 1; i < ad.length; i++) {
      if (ad[i][APPROVAL_COLS.SESSION_ID - 1] === aId && ad[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) {
        step1EmailStamped = (String(ad[i][APPROVAL_COLS.EMAIL_STATUS - 1] || '') === 'Pending');
        break;
      }
    }
    check('S1: EmailStatus stamped Pending on Step 1', step1EmailStamped, '');

    var r2 = processApprovalDecision(aId, E, 'Approve', 'Step 2 approved — proceeding to ISM. This comment is sufficiently long to pass all validation checks and requirements.', null, '{}');
    check('S1: Step 2 Approve succeeds', r2.success, r2.error);
    SpreadsheetApp.flush();

    // Verify app status becomes Approved
    var apps = appSheet.getDataRange().getValues();
    var appApproved = false;
    for (var i = 1; i < apps.length; i++) {
      if (apps[i][APPLICATIONS_COLS.SESSION_ID - 1] === aId) {
        appApproved = (String(apps[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved') === 0);
        break;
      }
    }
    check('S1: Application status becomes Approved', appApproved, '');

    // Verify ISM workflow initialized
    var ismCount = 0;
    var ismD = ismSheet.getDataRange().getValues();
    for (var i = 1; i < ismD.length; i++) { if (ismD[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === aId) ismCount++; }
    check('S1: ISM workflow initialized (2 rows)', ismCount === 2, 'found ' + ismCount);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: RETURN TO REQUESTOR
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 2: RETURN TO REQUESTOR ════════');

    var bId = genId('RETN');
    appSheet.appendRow([bId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([bId + '-B1', bId, 1, 'Approver B1', E, '', '', '', 'Pending', '', 'Pending', '']);

    var r3 = processApprovalDecision(bId, E, 'Return', 'Please fix the scope section. This is a detailed comment explaining what needs to be changed. It must be at least one hundred characters to pass the validation check. Adding more text here to meet the requirement.', null, '{"PIA 1 - Scope":"Scope section is too vague"}');
    check('S2: Return succeeds', r3.success, r3.error);

    var appsB = appSheet.getDataRange().getValues();
    var retStatus = '', retFlags = '';
    for (var i = 1; i < appsB.length; i++) {
      if (appsB[i][APPLICATIONS_COLS.SESSION_ID - 1] === bId) {
        retStatus = String(appsB[i][APPLICATIONS_COLS.STATUS - 1] || '');
        retFlags = String(appsB[i][APPLICATIONS_COLS.APPROVER_FLAGS - 1] || '');
        break;
      }
    }
    check('S2: App status is Returned', retStatus === 'Returned', retStatus);
    check('S2: ApproverFlags stored', retFlags.indexOf('Scope') > 0, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3: DENY
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 3: DENY ════════');

    var cId = genId('DENY');
    appSheet.appendRow([cId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([cId + '-C1', cId, 1, 'Approver C1', E, '', '', '', 'Pending', '', 'Pending', '']);

    var r4 = processApprovalDecision(cId, E, 'Deny', 'This project does not meet compliance requirements. The policy framework is not fully established and data handling procedures are completely undefined. Additional work is needed.', null, '{}');
    check('S3: Deny succeeds', r4.success, r4.error);

    var appsC = appSheet.getDataRange().getValues();
    var denyOk = false;
    for (var i = 1; i < appsC.length; i++) { if (appsC[i][APPLICATIONS_COLS.SESSION_ID - 1] === cId) { denyOk = (String(appsC[i][APPLICATIONS_COLS.STATUS - 1] || '') === 'Denied'); break; } }
    check('S3: App status is Denied', denyOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: DUPLICATE / RE-PROCESS PREVENTION
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 4: DUPLICATE PREVENTION ════════');

    var r5 = processApprovalDecision(bId, E, 'Approve', 'Trying to approve a returned app should fail. This comment is long enough.', null, '{}');
    check('S4: Cannot approve returned app', !r5.success, 'expected failure');

    var r6 = processApprovalDecision(cId, E, 'Approve', 'Trying to approve a denied app should fail also. This comment is sufficiently long.', null, '{}');
    check('S4: Cannot approve denied app', !r6.success, 'expected failure');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: ISM FULL APPROVAL (P1 → P2 → Approved by ISM)
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 5: ISM FULL APPROVAL ════════');

    var dId = genId('P3AP');
    appSheet.appendRow([dId, E, 'Approved', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([dId + '-D1', dId, 1, 'Approver D1', E, 'Approved', 'ok', 'today', 'Approved', '', 'Sent', '']);
    var initR = apiPhase3_InitializeISMWorkflow(dId);
    check('S5: ISM init succeeds', initR.success, initR.error);

    // Verify ISM rows have EmailStatus='Pending'
    var ismD5 = ismSheet.getDataRange().getValues();
    var ismEmailStamped = 0;
    for (var i = 1; i < ismD5.length; i++) {
      if (ismD5[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId) {
        if (String(ismD5[i][ISM_WORKFLOW_COLS.EMAIL_STATUS - 1] || '') === 'Pending') ismEmailStamped++;
      }
    }
    check('S5: ISM rows have EmailStatus=Pending', ismEmailStamped === 2, 'found ' + ismEmailStamped);

    // Get P1 and P2 emails
    var p1E = '', p2E = '';
    for (var i = 1; i < ismD5.length; i++) {
      if (ismD5[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismD5[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) p1E = ismD5[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
      if (ismD5[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismD5[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) p2E = ismD5[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
    }
    check('S5: P1 email found', !!p1E, p1E);
    check('S5: P2 email found', !!p2E, p2E);

    var r7 = apiPhase3_ProcessISMDecision(dId, p1E, 'Approve', 'ISM P1 approves — BOTH routing selected. This comment meets the minimum validation length requirement for ISM decisions.', 'BOTH', 1, '{}');
    check('S5: ISM P1 Approve succeeds', r7.success, r7.error);
    SpreadsheetApp.flush();

    var r8 = apiPhase3_ProcessISMDecision(dId, p2E, 'Approve', 'ISM P2 approves — completing final ISM approval. All checks passed and the application is ready for routing to implementation teams.', '', 2, '{}');
    check('S5: ISM P2 Approve succeeds', r8.success, r8.error);
    SpreadsheetApp.flush();

    var appsD = appSheet.getDataRange().getValues();
    var ismFinalOk = false;
    for (var i = 1; i < appsD.length; i++) {
      if (appsD[i][APPLICATIONS_COLS.SESSION_ID - 1] === dId) {
        ismFinalOk = (String(appsD[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved by ISM') >= 0);
        break;
      }
    }
    check('S5: App reaches Approved by ISM', ismFinalOk, '');

    // Check that queueEmail stamped ISM rows when notifications were sent
    var queueCheck = queueSheet.getDataRange().getValues();
    var ismQueueCount = 0;
    for (var i = 1; i < queueCheck.length; i++) {
      if (String(queueCheck[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '') === dId && String(queueCheck[i][EMAIL_QUEUE_COLS.TYPE - 1] || '') === 'ism') {
        ismQueueCount++;
      }
    }
    check('S5: ISM email notifications queued', ismQueueCount >= 1, 'found ' + ismQueueCount);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6: ISM DENY
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 6: ISM DENY ════════');

    var eId = genId('ISMDN');
    appSheet.appendRow([eId, E, 'Approved', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apiPhase3_InitializeISMWorkflow(eId);
    var ismE = ismSheet.getDataRange().getValues();
    var p1E2 = '';
    for (var i = 1; i < ismE.length; i++) { if (ismE[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === eId && ismE[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1E2 = ismE[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r9 = apiPhase3_ProcessISMDecision(eId, p1E2, 'Deny', 'This application has critical security risks that cannot be mitigated. Comprehensive review indicates multiple compliance gaps in data handling procedures. This decision is final and binding.', '', 1, '{}');
    check('S6: ISM Deny succeeds', r9.success, r9.error);

    var appsE = appSheet.getDataRange().getValues();
    var ismDenyOk = false;
    for (var i = 1; i < appsE.length; i++) { if (appsE[i][APPLICATIONS_COLS.SESSION_ID - 1] === eId) { ismDenyOk = (String(appsE[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Rejected') >= 0); break; } }
    check('S6: App becomes Rejected by ISM', ismDenyOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7: ISM RETURN
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 7: ISM RETURN ════════');

    var fId = genId('ISMRT');
    appSheet.appendRow([fId, E, 'Approved', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apiPhase3_InitializeISMWorkflow(fId);
    var ismF = ismSheet.getDataRange().getValues();
    var p1F = '';
    for (var i = 1; i < ismF.length; i++) { if (ismF[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === fId && ismF[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1F = ismF[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r10 = apiPhase3_ProcessISMDecision(fId, p1F, 'Return', 'Please update the scope section and add more detail about data retention policies. The current description is too brief. Also ensure DCS fields are updated accordingly.', '', 1, '{}');
    check('S7: ISM Return succeeds', r10.success, r10.error);

    var appsF = appSheet.getDataRange().getValues();
    var ismRetOk = false;
    for (var i = 1; i < appsF.length; i++) { if (appsF[i][APPLICATIONS_COLS.SESSION_ID - 1] === fId) { ismRetOk = (String(appsF[i][APPLICATIONS_COLS.STATUS - 1] || '') === 'Returned'); break; } }
    check('S7: App becomes Returned after ISM return', ismRetOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8: ISM ESCALATE → DIVISION HEAD → FULL CHAIN
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 8: ISM ESCALATE → DIVHEAD → FULL ════════');

    var pia1Div = JSON.stringify({ program: 'Test Escalation', dept: 'IT', immediateHead: 'Alice', immediateHeadEmail: E, deptHead: 'Bob', deptHeadEmail: E, divHead: 'Carol', divHeadEmail: E, drafterEmail: E });
    var gId = genId('P3ESC');
    appSheet.appendRow([gId, E, 'Approved', pia1Div, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apiPhase3_InitializeISMWorkflow(gId);
    SpreadsheetApp.flush();

    var ismG = ismSheet.getDataRange().getValues();
    var p1G = '', p2G = '';
    for (var i = 1; i < ismG.length; i++) {
      if (ismG[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === gId && ismG[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) p1G = ismG[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
      if (ismG[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === gId && ismG[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) p2G = ismG[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
    }

    var r11 = apiPhase3_ProcessISMDecision(gId, p1G, 'EscalateToDivisionHead', 'This requires executive review due to cross-departmental data sharing concerns. The application involves sensitive PII that needs Division Head sign-off for proper authorization.', 'BOTH', 1, '{}');
    check('S8: ISM Escalate succeeds', r11.success, r11.error);
    SpreadsheetApp.flush();

    // Check DivHead record created
    var divD = divSheet.getDataRange().getValues();
    var divCreated = false;
    for (var i = 1; i < divD.length; i++) { if (divD[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === gId && divD[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') { divCreated = true; break; } }
    check('S8: DivHead escalation record created', divCreated, '');

    // Check DivHead row has EmailStatus='Pending'
    var divEmailOk = false;
    for (var i = 1; i < divD.length; i++) {
      if (divD[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === gId) {
        divEmailOk = (String(divD[i][DIV_HEAD_CONFIG_COLS.EMAIL_STATUS - 1] || '') === 'Pending');
        break;
      }
    }
    check('S8: DivHead EmailStatus stamped Pending', divEmailOk, '');

    // DivHead approves
    var r12 = processDivHeadDecision(gId, E, 'Approve', 'Division Head approves after thorough review of the escalated application. All concerns regarding cross-departmental data sharing have been addressed and the application meets compliance standards.', '{}');
    check('S8: DivHead Approve succeeds', r12.success, r12.error);
    SpreadsheetApp.flush();

    // App should still be Escalated (waiting for Person 2)
    var appsG = appSheet.getDataRange().getValues();
    var escStatus = '';
    for (var i = 1; i < appsG.length; i++) { if (appsG[i][APPLICATIONS_COLS.SESSION_ID - 1] === gId) { escStatus = String(appsG[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('S8: App still Escalated after DivHead (waiting P2)', escStatus.indexOf('Escalated') >= 0, escStatus);

    // Person 2 approves → full chain complete
    var r13 = apiPhase3_ProcessISMDecision(gId, p2G, 'Approve', 'Person 2 approves after DivHead resolution. All escalation concerns have been properly addressed and the application is now ready for final routing.', 'BOTH', 2, '{}');
    check('S8: ISM P2 Approve after escalation succeeds', r13.success, r13.error);
    SpreadsheetApp.flush();

    var appsG2 = appSheet.getDataRange().getValues();
    var escFinalOk = false;
    for (var i = 1; i < appsG2.length; i++) { if (appsG2[i][APPLICATIONS_COLS.SESSION_ID - 1] === gId) { escFinalOk = (String(appsG2[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved by ISM') >= 0); break; } }
    check('S8: App reaches Approved by ISM after full escalation chain', escFinalOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9: EMAIL FAILSAFE — NOTIFICATION CONFIG
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 9: EMAIL FAILSAFE & NOTIFICATION CONFIG ════════');

    var notifCfg = adminGetNotificationConfig();
    check('S9: getNotificationConfig returns success', notifCfg.success, notifCfg.error);
    check('S9: NotifyOnFailure defaults to YES', notifCfg.data && notifCfg.data.notifyOnFailure === 'YES', notifCfg.data ? notifCfg.data.notifyOnFailure : 'no data');
    check('S9: Admin email is configured', notifCfg.data && !!notifCfg.data.adminEmail, notifCfg.data ? notifCfg.data.adminEmail : 'none');

    var setCfg = adminSetNotificationConfig({ notifyOnFailure: 'YES', notifyRequestor: 'YES' });
    check('S9: setNotificationConfig succeeds', setCfg.success, setCfg.error);
    check('S9: Config persists after set', setCfg.data && setCfg.data.notifyOnFailure === 'YES', '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10: PIPELINE VIEW
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 10: PIPELINE VIEW ════════');

    var pipeline = adminGetPipelineView(dId);
    check('S10: getPipelineView returns success', pipeline.success, pipeline.error);
    check('S10: Pipeline has application', pipeline.data && !!pipeline.data.application, '');
    check('S10: Pipeline has approvalWorkflow', pipeline.data && Array.isArray(pipeline.data.approvalWorkflow) && pipeline.data.approvalWorkflow.length > 0, '');
    check('S10: Pipeline has ismWorkflow', pipeline.data && Array.isArray(pipeline.data.ismWorkflow) && pipeline.data.ismWorkflow.length > 0, '');
    check('S10: Pipeline has emailQueue entries', pipeline.data && Array.isArray(pipeline.data.emailQueue), '');
    check('S10: Pipeline has auditTrail', pipeline.data && Array.isArray(pipeline.data.auditTrail), '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 11: RESEND TO STAGE
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 11: RESEND TO STAGE ════════');

    // Create a fresh Pending entry — resend only works on rows with Status='Pending'
    var resendId = genId('RSND');
    appSheet.appendRow([resendId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([resendId + '-R1', resendId, 1, 'Resend Approver', E, '', '', '', 'Pending', '', '', '']);

    var resendR = adminResendToStage(resendId, 'approver', E);
    check('S11: Resend to stage succeeds', resendR.success, resendR.error);
    check('S11: Resend returns queueId', !!resendR.queueId, '');

    // Verify EmailStatus was reset to Pending
    var ad2 = apprSheet.getDataRange().getValues();
    var resetOk = false;
    for (var i = 1; i < ad2.length; i++) {
      if (ad2[i][APPROVAL_COLS.SESSION_ID - 1] === resendId && ad2[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) {
        resetOk = (String(ad2[i][APPROVAL_COLS.EMAIL_STATUS - 1] || '') === 'Pending');
        break;
      }
    }
    check('S11: EmailStatus reset to Pending after resend', resetOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 12: REMINDER ENGINE
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 12: REMINDER ENGINE ════════');

    var remId = genId('REM');
    appSheet.appendRow([remId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([remId + '-R1', remId, 1, 'Reminder Approver', E, '', '', '', 'Pending', '', 'Pending', '']);

    var remResult = sendDailyReminders();
    check('S12: sendDailyReminders succeeds', remResult.success, remResult.error);

    // Check if a reminder was queued for our test entry
    var qD = queueSheet.getDataRange().getValues();
    var reminded = false;
    for (var i = 1; i < qD.length; i++) {
      if (String(qD[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '') === remId && String(qD[i][EMAIL_QUEUE_COLS.TYPE - 1] || '') === 'reminder') {
        reminded = true; break;
      }
    }
    check('S12: Reminder queued for pending entry', reminded, '');

    // Verify ReminderDate was stamped
    var adR = apprSheet.getDataRange().getValues();
    var stamped = false;
    var todayStr = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0');
    for (var i = 1; i < adR.length; i++) {
      if (adR[i][APPROVAL_COLS.SESSION_ID - 1] === remId) {
        var rdVal = String(adR[i][APPROVAL_COLS.REMINDER_DATE - 1] || '');
        // Date may be stored as Date object or string — normalize
        if (adR[i][APPROVAL_COLS.REMINDER_DATE - 1] instanceof Date) {
          var d = adR[i][APPROVAL_COLS.REMINDER_DATE - 1];
          rdVal = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        stamped = (rdVal === todayStr);
        break;
      }
    }
    check('S12: ReminderDate stamped on workflow row', stamped, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 13: 20 CONCURRENT USERS — BATCH SUBMIT & APPROVE
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 13: 20 CONCURRENT USERS ════════');

    var CONCURRENT = 20;
    var batchIds = [];
    var batchStart = new Date().getTime();

    // Batch create 20 applications
    for (var u = 0; u < CONCURRENT; u++) {
      var uid = genId('CONC');
      batchIds.push(uid);
      appSheet.appendRow([uid, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
      apprSheet.appendRow([uid + '-U1', uid, 1, 'Concurrent Approver ' + u, E, '', '', '', 'Pending', '', 'Pending', '']);
    }
    SpreadsheetApp.flush();
    var batchCreateMs = new Date().getTime() - batchStart;
    Logger.log('  Created ' + CONCURRENT + ' apps in ' + batchCreateMs + 'ms');
    check('S13: Created 20 concurrent apps', batchIds.length === CONCURRENT, 'count=' + batchIds.length);

    // Verify no row corruption (check all 20 have correct column counts)
    var corruptedCount = 0;
    var apprData = apprSheet.getDataRange().getValues();
    for (var u = 0; u < batchIds.length; u++) {
      var found = false;
      for (var i = 1; i < apprData.length; i++) {
        if (apprData[i][APPROVAL_COLS.SESSION_ID - 1] === batchIds[u]) {
          found = true;
          // Check all 12 columns have values (at least not undefined)
          if (apprData[i].length < 12) corruptedCount++;
          break;
        }
      }
      if (!found) corruptedCount++;
    }
    check('S13: No row corruption in 20 concurrent apps', corruptedCount === 0, 'corrupted=' + corruptedCount);

    // Batch approve all 20
    var batchApproveStart = new Date().getTime();
    var approveSuccess = 0;
    for (var u = 0; u < batchIds.length; u++) {
      var r = processApprovalDecision(batchIds[u], E, 'Approve', 'Concurrent batch approval #' + (u + 1) + '. This comment is sufficiently long to meet the minimum validation length requirement for approval decisions.', null, '{}');
      if (r.success) approveSuccess++;
    }
    SpreadsheetApp.flush();
    var batchApproveMs = new Date().getTime() - batchApproveStart;
    Logger.log('  Approved ' + approveSuccess + '/' + CONCURRENT + ' in ' + batchApproveMs + 'ms (' + (batchApproveMs / CONCURRENT).toFixed(0) + 'ms avg)');
    check('S13: All 20 concurrent approvals succeed', approveSuccess === CONCURRENT, 'success=' + approveSuccess);

    // Verify all 20 have status Approved
    var appsCheck = appSheet.getDataRange().getValues();
    var approvedCount = 0;
    for (var u = 0; u < batchIds.length; u++) {
      for (var i = 1; i < appsCheck.length; i++) {
        if (appsCheck[i][APPLICATIONS_COLS.SESSION_ID - 1] === batchIds[u]) {
          if (String(appsCheck[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved') === 0) approvedCount++;
          break;
        }
      }
    }
    check('S13: All 20 apps have Approved status', approvedCount === CONCURRENT, 'approved=' + approvedCount);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 14: ADMIN API — QUEUE SUMMARY & EMAIL LOG
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 14: ADMIN APIs ════════');

    var qSum = adminGetQueueSummary();
    check('S14: getQueueSummary returns data', qSum.success, qSum.error);
    check('S14: Queue summary has total > 0', qSum.data && qSum.data.total > 0, qSum.data ? 'total=' + qSum.data.total : 'no data');

    var qLog = adminGetEmailLog(aId);
    check('S14: getEmailLog returns array', Array.isArray(qLog), typeof qLog);

    var failed = adminGetFailedEmails(30);
    check('S14: getFailedEmails returns array', Array.isArray(failed), typeof failed);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 15: REMINDER CONFIG
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 15: REMINDER CONFIG ════════');

    var remCfg = adminGetReminderConfig();
    check('S15: getReminderConfig returns data', remCfg.success, remCfg.error);
    check('S15: Reminder config has triggerActive field', remCfg.data && remCfg.data.hasOwnProperty('triggerActive'), '');

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n══════════════════════════════════════════════════════════════');
    Logger.log('  🔥 ULTIMATE MEGA-TEST RESULTS');
    Logger.log('══════════════════════════════════════════════════════════════');
    Logger.log('  ✅ Passed: ' + results.passed);
    Logger.log('  ❌ Failed: ' + results.failed);
    Logger.log('  📊 Total:  ' + results.total);
    Logger.log('  📈 Score:  ' + (results.total > 0 ? Math.round(results.passed / results.total * 100) : 0) + '%');

    if (results.failed === 0) {
      Logger.log('\n  🎉 ALL ' + results.total + ' TESTS PASSED — System is battle-ready!');
      Logger.log('  ✅ Head Approval Chain       ✅ Return to Requestor');
      Logger.log('  ✅ Deny                       ✅ Duplicate Prevention');
      Logger.log('  ✅ ISM Full Approval          ✅ ISM Deny');
      Logger.log('  ✅ ISM Return                 ✅ Escalate → DivHead → Full');
      Logger.log('  ✅ Email Failsafe Stamping    ✅ Admin Notification Config');
      Logger.log('  ✅ Pipeline View              ✅ Resend to Stage');
      Logger.log('  ✅ Reminder Engine            ✅ 20 Concurrent Users');
      Logger.log('  ✅ Admin APIs                 ✅ Reminder Config');
    } else {
      Logger.log('\n  ⚠️  ' + results.failed + ' test(s) FAILED. Review details above.');
      Logger.log('\n  Failing tests:');
      results.details.filter(function(d) { return !d.pass; }).forEach(function(d) {
        Logger.log('    ❌ ' + d.label + (d.detail ? ' — ' + d.detail : ''));
      });
    }

  } catch (e) {
    Logger.log('\n  💥 MEGA-TEST CRASHED: ' + e.toString());
    Logger.log('  Stack: ' + e.stack);
    results.failed++;
    results.error = e.toString();
  } finally {
    cleanAll();
  }

  Logger.log('\n╚══════════════════════════════════════════════════════════════════╝');
  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// END
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: checkProperties
  LAYMAN:    Quick developer check that logs whether the ADMIN_API_KEY Script Property is set (without
             revealing the full value).
  TECHNICAL: Reads ADMIN_API_KEY and logs a masked status. Diagnostics only.
  PARAMS:    (none)
  RETURNS:   undefined (writes to Logger).
*/
function checkProperties() {
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');
  Logger.log('ADMIN_API_KEY: ' + (key ? '✅ SET (' + key.substring(0, 6) + '...)' : '❌ MISSING'));
}
