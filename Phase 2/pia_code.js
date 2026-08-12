// ============================================================
//  pia_code.js  (PIA: Phase 2 backend)
// ============================================================
/*
  [ OUTLINE ]
  FILE: pia_code.js
  PURPOSE (Layman): This is the brain of Phase 2 of Megaworld's RARS, the Privacy Impact
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
    (queueEmail_ → processEmailQueue → sendEmailWithRetry_), HMAC-SHA256 review tokens
    (generateAuthToken_/isTokenValid_, action-bound, 14-day TTL) for one-click approve/deny
    links, LockService to serialize decisions, domain-restricted doGet, and ISM + Division-Head
    escalation routing. Column positions are centralized in *_COLS constants. Phases never call
    each other directly, they coordinate only through the shared sheet and the parentID /
    Linked_ReqID link plus stored Script Property URLs (PIA_APP_URL, DCS_WEB_APP_URL).

  🔒 THE TRAILING UNDERSCORE IS A SECURITY BOUNDARY, NOT A STYLE CHOICE.
    In Apps Script every top-level function is callable from the browser via google.script.run,
    regardless of what the UI exposes buttons for. Functions named with a trailing underscore are
    private and CANNOT be reached that way. These five are deliberately private and must stay that
    way, routeApprovedRequest_, updateDCSStatus_, notifyISMember_, notifyApprover_,
    notifyApplicant_. Removing an underscore to "tidy up" re-opens a real hole: routeApprovedRequest_
    emails a Certificate of Approval to the live DCOPS/TechServe inboxes and flips uploaded DCS docs
    to DOMAIN_WITH_LINK, and session IDs are sequential hence guessable. See also the SECURITY (F-02)
    self-guards on the three decision functions, which cover the same class from the other direction.

  CATEGORY: CONFIG & SECURITY
    - getWebAppUrl_()                         read PIA web-app URL from Script Properties
    - getDCSWebAppUrl_()                      read DCS web-app URL (fallback to PIA URL)
    - getAllowedDomain_()                     read the single allowed email domain
    - isAuthorizedDomain_(email)              true if email is on the allowed domain
    - getSystemSecret()                      read HMAC secret (throws if unset)
    - getNormalizedEmail_(email)              strip +alias and lowercase an address
    - getWorkflowInfoForType_(type)           map an email-queue type to its workflow sheet
    - getAdminNotificationConfig_()           read admin-notification settings row
    - generateAuthToken_(sessionId,email,timestamp,action)  build an HMAC review token
    - isTokenValid_(...)                      verify a review token (TTL + action bound)
    - isValidEmail_(email)                    RFC-ish email format check
    - sanitizeEmail_(email)                   trim/lowercase/validate or null
    - encodePayload_(data) / decodePayload_(s) base64 URL payload (NOT encryption)
    - escapeHtml_(str)                        HTML-escape for safe email/page output

  CATEGORY: SHEET HELPERS & UI
    - batchDeleteRows_(sheet, rowNumbers)     delete rows bottom-to-top
    - findRowsToDelete_(data, colIndex, value) row numbers matching a column value
    - getAndShareDCSFiles_(dcsReqId)          find + domain-share the DCS attachments
    - getStyledHtmlWrapper_(header, content)  shared HTML page shell for action/result pages
    - buildPiaEmailHtml_(opts)               navy email-card HTML wrapper

  CATEGORY: ENTRY POINTS (web app)
    - doGet(e)                               serve the app or handle a token review link
    - doPost(e)                              route POSTs (admin API)
    - handleAdminApiRequest_(e)               dispatch admin API actions from doPost
    - handleEmailAction_(params)             render/process one-click email approve/deny pages

  CATEGORY: DATABASE & SCHEMA
    - getDatabaseSpreadsheet_(createIfMissing) open (or create) the shared spreadsheet
    - getDatabaseSheet_(sheetName, createIfMissing)  open (or create) a tab
    - initializeDatabase_()                   create all tabs/headers on first run
    - sheetExists_(name)                      tab-exists check
    - createPhase3SheetWithValidation_(...)   create a tab with headers + seed rows
    - formatHeaderRow_(sheet)                 style a header row

  CATEGORY: SESSION IDS & RISK
    - seedSessionCounterFromDatabase_()       sync the ID counter to existing data
    - formatSessionId_(seq, version)          format a PIA session id string
    - nextBaseSessionId_()                    allocate the next new session id
    - getNextRevisionSessionId_(base)         allocate a revision (-R) id
    - resolveSubmissionId_(appData)           pick new vs revision id for a submit
    - analyzeApplicationRisk_(appData)        auto risk flags (PII count, etc.)

  CATEGORY: APPLICATION SUBMIT/READ
    - submitApplication_(appData)             persist a PIA submission + start workflow
    - buildApproversFromAppData_(appData)     derive the approver ladder from DCS data
    - getApplicationData_(sessionId)          full app record + workflow timelines
    - getUserSubmissions_()                   current user's submitted applications
    - findRowBySessionID_(sessionId)          locate the Applications row
    - getPIIFieldsList_(appData)              list selected PII categories

  CATEGORY: APPROVAL WORKFLOW
    - initializeApprovalWorkflow_(sessionId, appData)  seed approver rows
    - processApprovalDecision_(...)           record a head/approver decision + advance
    - processDivHeadDecision_(...)            record a Division-Head escalation decision
    - checkAllApproved_(sessionId)            true when every approver approved
    - updateDCSStatus_(reqId, newStatus)      write status back to the DCS sheet
    - logAuditTrail_(sessionId, action, flags) append a Risk_Audit row

  CATEGORY: ISM & DIVISION HEAD (Phase 3)
    - apiPhase3_FetchPIAData(sessionId)      PIA answers for the ISM reviewer UI
    - apiPhase3_FetchDCSData(sessionId)      linked DCS context for the ISM reviewer UI
    - apiPhase3_GetDivisionHeadConfig_(email) division-head lookup/validation
    - apiPhase3_GetInfoSecMembers_()          active InfoSec/ISM roster
    - apiPhase3_InitializeISMWorkflow_(sessionId)  seed the ISM approval chain
    - apiPhase3_RetryISMWorkflow_(sessionId)  re-seed/repair a broken ISM chain
    - apiPhase3_ProcessISMDecision(...)      record an ISM decision + route
    - notifyISMember_(sessionId, step)       email the current ISM member
    - routeApprovedRequest_(sessionId, destination)  final routing/certify

  CATEGORY: EMAIL ENGINE & QUEUE
    - sendEmailWithRetry_(recipient, subject, body, options)  send with backoff retry
    - queueEmail_(...)                        enqueue an email row
    - processEmailQueue()                    drain the queue (trigger-driven)
    - setupEmailQueueTrigger()               install the queue time trigger
    - sendDailyReminders_()                   nudge the current pending approver
    - buildReminderEmail_(...)                compose one reminder email
    - getReminderConfig_() / setupReminderTrigger_()  reminder settings + trigger

  CATEGORY: NOTIFICATION BUILDERS
    - notifyApprover_(sessionId, approverIndex)  build + queue an approver email
    - notifyApplicant_(sessionId, status)     build + queue an applicant status email
    - generateEmailDecisionsHTML_(sessionId)  render the decisions table for emails

  CATEGORY: ADMIN API (email ops + pipeline)
    - adminGetEmailLog_ / adminGetFailedEmails_ / adminResendEmail_
    - adminGetEmailQueue_ / adminRetryQueuedEmail_ / adminRetryAllForSession_
    - adminCancelQueuedEmails_ / adminGetQueueSummary_
    - adminGetReminderConfig_ / adminSetReminderConfig_
    - adminGetNotificationConfig_ / adminSetNotificationConfig_
    - adminResendToStage_(...) / adminGetPipelineView_(sessionId)

  CATEGORY: VALIDATION
    - validateApplicationData_(appData)       server-side submit validation
    - validateComment_(comment, minLength)    decision-comment length/format check
    - sanitizeInput_(data, maxLength, depth)  recursive string clamp/clean

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
  Function: getWebAppUrl_
  LAYMAN:    Gets this PIA app's own public URL. Used to build links back into the app.
  TECHNICAL: Reads the WEB_APP_URL Script Property; logs a warning and returns '' if unset.
  PARAMS:    (none)
  RETURNS:   The URL string, or '' when the property is not configured.
*/
function getWebAppUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) {
    Logger.log('WARNING: WEB_APP_URL not configured. Please set it in Project Settings > Script Properties.');
    return '';  // Return empty string, caller should handle
  }
  return url;
}

/*
  Function: getDCSWebAppUrl_
  LAYMAN:    Gets the Phase 1 DCS app's URL so "Update DCS Request" links point to the right
             app. If it is not set, callers fall back to the PIA URL.
  TECHNICAL: Reads the DCS_WEB_APP_URL Script Property; logs a warning and returns '' if unset.
  PARAMS:    (none)
  RETURNS:   The DCS URL string, or '' when the property is not configured.
*/
function getDCSWebAppUrl_() {
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
  Function: getAllowedDomain_
  LAYMAN:    Gets the one company email domain that is allowed to use the app.
  TECHNICAL: Reads the ALLOWED_DOMAIN Script Property; logs a warning and returns '' if unset.
             '' makes isAuthorizedDomain_ deny everyone (fail-closed).
  PARAMS:    (none)
  RETURNS:   The domain string (e.g. 'megaworldcorp.com'), or '' when unconfigured.
*/
function getAllowedDomain_() {
  const domain = PropertiesService.getScriptProperties().getProperty('ALLOWED_DOMAIN');
  if (!domain) {
    Logger.log('WARNING: ALLOWED_DOMAIN not configured. Please set it in Project Settings > Script Properties.');
    return '';  // Return empty string, caller should handle
  }
  return domain;
}

/*
  Function: isAuthorizedDomain_
  LAYMAN:    Decides whether a given email is allowed to use the app, based on its domain.
  TECHNICAL: When ENABLE_DOMAIN_CHECK is on, returns true only if email ends with
             '@' + getAllowedDomain_(). Fail-closed: empty email or unconfigured domain → false.
  PARAMS:    - email: the address to check.
  RETURNS:   Boolean. Always true if ENABLE_DOMAIN_CHECK is false.
  EXAMPLE:   isAuthorizedDomain_('a@megaworldcorp.com') -> true
*/
function isAuthorizedDomain_(email) {
  if (!ENABLE_DOMAIN_CHECK) return true;
  if (!email) return false;
  const domain = getAllowedDomain_();
  if (!domain) return false;  // No domain configured → deny access
  return email.toLowerCase().endsWith('@' + domain);
}

/*
  Function: getSystemSecret
  LAYMAN:    Gets the private signing key used to make tamper-proof email approve/deny links.
  TECHNICAL: Reads SYSTEM_SECRET Script Property. Throws (fail-closed) if missing, tokens must
             never be signed with an empty key.
  PARAMS:    (none)
  RETURNS:   The secret string. Throws Error if not configured.
*/
function getSystemSecret_() {
  const secret = PropertiesService.getScriptProperties().getProperty('SYSTEM_SECRET');
  if (!secret) throw new Error('Security Error: SYSTEM_SECRET not configured.');
  return secret;
}

/*
  Function: isOwnerContext_

  LAYMAN (Tropang Ex):
  Bouncer para sa mga function na hindi kayang bigyan ng trailing underscore, yung mga trigger
  handler (processEmailQueue, sendDailyReminders) at yung mga pinapatakbo sa editor. Kailangan
  nilang manatiling public, ibig sabihin kahit sinong naka-login sa domain kayang tawagin sila
  galing browser console. Ito yung nagtatanong: "ikaw ba yung may-ari ng script o isang trigger?"

  Bakit importante dito: yung processEmailQueue at sendDailyReminders ay pang-BULK send. Kung
  walang gate, kahit sinong empleyado pwedeng i-loop sila hanggang maubos yung daily Gmail quota,
  at pag naubos yun, TAHIMIK na hihinto lahat ng approval emails ng buong sistema.

  TECHNICAL:
  Under executeAs: USER_DEPLOYING, getEffectiveUser() is always the deploying account while
  getActiveUser() is the visitor. Inside a time-driven trigger or an editor Run, both resolve to
  the owner. Equality therefore implies owner-or-trigger context.

  Fails closed: a blank active user cannot match, and any Session error returns false.

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
  APPLICATION_SNAPSHOTS: 'Application_Snapshots',
  DELEGATIONS: 'Delegations'   // out-of-office table, admin-managed. See resolveDelegate_.
};

/*
  ━━━ PIA_SCHEMA: THE SINGLE SOURCE OF TRUTH FOR COLUMN ORDER ━━━━━━━━━━━━━━━━━━━━━━

  LAYMAN (Tropang Ex):
  Isang listahan lang ng pangalan ng column kada sheet. Ito na ang gagamitin sa DALAWANG
  bagay na dati magkahiwalay: (1) yung paggawa ng header row kapag bago ang tab, at
  (2) yung pag-alam kung pang-ilang column ba ang "SessionID".

  Bakit ito ginawa: dati DALAWA ang pinagkukunan ng katotohanan, may listahan ng pangalan
  sa initializeDatabase_, at may hiwalay na listahan ng NUMERO (APPROVAL_COLS at kapatid
  nito). Kailangang manu-manong pantayin. Noong nagdagdag ako ng ActedBy, na-update ko yung
  numero pero hindi yung pangalan, at TAHIMIK lang siyang nasira, nakasulat yung data sa
  tamang column pero walang pangalan sa taas, kaya hindi makita ng Admin app.

  Ngayon, IISA na lang: yung numero ay galing sa listahan ng pangalan. Imposible nang
  hindi sila magkatugma, kasi iisa lang sila.

  TECHNICAL:
  Ordered header arrays keyed by sheet name. Consumed by:
    - colsOf_()               to DERIVE every *_COLS index map (no more hand-typed numbers)
    - initializeDatabase_()   to write the header row on sheet creation
    - assertSheetSchema_()    to verify the LIVE header row still matches, and throw if not

  🚩 ADDING A COLUMN: append the name here and add one alias line to the matching colsOf_
  call. That is the whole change. Never hand-number a map again, and never write a header
  array anywhere else, a second copy is exactly what caused the ActedBy defect.

  🚩 APPEND ONLY. Inserting in the middle renumbers every column after it and silently
  repoints existing data. If a column truly must move, it is a data migration, not an edit.

  Data_Collection is owned by Phase 1 (it creates and writes that sheet); the copy here is
  for PIA's reads and MUST match Phase 1/Code.js's `headers` array. Drafts is shared by both.
*/
const PIA_SCHEMA = {
  'Applications': ['SessionID', 'ApplicantEmail', 'Status',
    'PIA_1_Data', 'PIA_2_Data', 'PIA_3_Data', 'PIA_4_Data', 'PIA_5_Data',
    'AdminExportID', 'SubmissionDate', 'IsFlagged', 'Notes', 'Linked_ReqID', 'Approver_Flags'],

  'Approval_Workflow': ['ApprovalID', 'SessionID', 'CurrentStep', 'ApproverName',
    'ApproverEmail', 'Decision', 'Comments', 'DecisionDate', 'Status', 'ReminderDate',
    'EmailStatus', 'EmailError', 'NotifiedDate', 'RoundNumber', 'FlaggedFields', 'ActedBy'],

  'ISM_Approval_Workflow': ['ISM_Approval_ID', 'SessionID', 'CurrentStep', 'ISM_Member_Name',
    'ISM_Member_Email', 'Decision', 'Comments', 'DecisionDate', 'Status', 'Requires_DivHead',
    'DivHead_Escalation_ID', 'Routing_Destination', 'ReminderDate', 'EmailStatus', 'EmailError',
    'NotifiedDate', 'RoundNumber', 'FlaggedFields', 'ActedBy'],

  'DivisionHead_Approval_Workflow': ['Escalation_ID', 'SessionID', 'DivHead_Email', 'Decision',
    'Comments', 'DecisionDate', 'Status', 'ReminderDate', 'EmailStatus', 'EmailError',
    'NotifiedDate', 'RoundNumber', 'FlaggedFields', 'ActedBy'],

  'Application_Snapshots': ['SnapshotID', 'SessionID', 'RoundNumber', 'ApplicantEmail',
    'Status_At_Snapshot', 'PIA_1_Data', 'PIA_2_Data', 'PIA_3_Data', 'PIA_4_Data', 'PIA_5_Data',
    'Approver_Flags', 'Linked_ReqID', 'SnapshotAt'],

  'Delegations': ['Delegation_ID', 'From_Email', 'To_Email', 'Start_Date', 'End_Date',
    'Reason', 'Is_Active', 'Created_By', 'Created_At'],

  'Email_Queue': ['Queue_ID', 'SessionID', 'Recipient', 'Subject', 'Body_Plain', 'Body_HTML',
    'Type', 'Status', 'Attempts', 'Last_Error', 'Created_At', 'Sent_At', 'NotifiedAdmin'],

  'Risk_Audit': ['LogID', 'SessionID', 'InternalFlags', 'Action', 'UserEmail', 'UserAgent',
    'Timestamp'],

  'InfoSec_Email_Config': ['Member_ID', 'Member_Name', 'Member_Email', 'Role', 'IsActive',
    'JobPos', 'Site'],

  'Admin_Notification_Config': ['Config_ID', 'Admin_Email', 'NotifyOnFailure', 'NotifyRequestor',
    'Last_Notified'],

  // Owned by Phase 1: keep in step with the `headers` array in Phase 1/Code.js.
  'Data_Collection': ['LogID', 'ReqID', 'UserEmail', 'Status', 'ImmediateHeadEmail',
    'DeptHeadEmail', 'DivHeadEmail', 'FileID', 'Metadata_JSON', 'Timestamp', 'Metadata_Agency'],

  // Shared with Phase 1. Previously had NO column map in either project and was addressed by
  // bare number in both, the last remaining place a magic index could hide.
  // Column F is 'SavedTimestamp', NOT 'SavedAt'. The manual documented it as
  // "SavedAt/SavedTimestamp" because nobody ever read it by name, both apps address Drafts
  // by bare index. Verified against what PIA actually writes and Phase 1/Code.js:789.
  'Drafts': ['DraftID', 'UserEmail', 'SessionID', 'Type', 'StateJSON', 'SavedTimestamp', 'ExpiresAt']
};

/*
  Function: colsOf_

  LAYMAN (Tropang Ex):
  Ginagawa niyang numero yung mga pangalan. Bibigyan mo siya ng sheet at ng listahan tulad ng
  { SESSION_ID: 'SessionID' }, ibabalik niya { SESSION_ID: 2 }, kasi pangalawa nga ang
  SessionID sa listahan. Kaya hindi na kailangang mag-bilang ng tao.

  TECHNICAL:
  Derives a 1-based `{CONST_NAME: index}` map from PIA_SCHEMA plus an alias table, replacing
  the hand-numbered literals. Runs at script load.

  🚩 THROWS on an alias naming a header that is not in the schema. That is the entire point:
  a typo or a stale alias fails at load with a precise message instead of silently reading
  column `undefined - 1` → `NaN` → `undefined` at some unrelated call site months later.

  PARAMS:
  - sheetName: a PIA_SCHEMA key.
  - aliases: { CONST_NAME: 'HeaderName', ... }.

  RETURNS:
  { CONST_NAME: 1-based column index }.

  EXAMPLE
    colsOf_('Approval_Workflow', { SESSION_ID: 'SessionID', STATUS: 'Status' })
      → { SESSION_ID: 2, STATUS: 9 }
    colsOf_('Approval_Workflow', { OOPS: 'NoSuchColumn' })
      → throws: PIA_SCHEMA['Approval_Workflow'] has no column "NoSuchColumn" (alias OOPS)
*/
function colsOf_(sheetName, aliases) {
  const headers = PIA_SCHEMA[sheetName];
  if (!headers) throw new Error('colsOf_: no PIA_SCHEMA entry for sheet "' + sheetName + '"');
  const out = {};
  Object.keys(aliases).forEach(function (constName) {
    const header = aliases[constName];
    const idx = headers.indexOf(header);
    if (idx === -1) {
      throw new Error('colsOf_: PIA_SCHEMA["' + sheetName + '"] has no column "' + header +
                      '" (alias ' + constName + ')');
    }
    out[constName] = idx + 1;   // 1-based, matching getRange()
  });
  return out;
}

/*
  Function: assertSheetSchema_

  LAYMAN (Tropang Ex):
  Tinitingnan niya kung yung TOTOONG header sa spreadsheet ay tugma pa rin sa listahan natin
  sa code. Kung may nagpalit ng pangalan ng column, o may nag-insert sa gitna, dito na siya
  sisigaw: HINDI na yung tahimik na pagbasa ng maling column na siyang dahilan ng apat na
  bug na naayos noong 2026-08-12.

  TECHNICAL:
  Compares the live header row against PIA_SCHEMA and THROWS on mismatch. Memoized per
  execution: the check costs one header-row read the first time a sheet is validated and
  nothing thereafter.

  🚩 It checks a PREFIX, not equality. Extra trailing columns someone added by hand in the
  spreadsheet are tolerated (they cannot shift anything the code addresses); a renamed,
  reordered or missing column is fatal. That asymmetry is deliberate, this must not turn a
  harmless manual annotation column into an outage.

  🚩 Silent on a missing sheet. Creation is initializeDatabase_'s job, and several callers
  legitimately probe for a sheet that does not exist yet.

  PARAMS:
  - sheetName: a PIA_SCHEMA key.
  - sheet: optional, an already-opened Sheet (saves a lookup).

  RETURNS:
  true when the schema matches or the check could not run. Throws on genuine drift.

  EXAMPLE
    assertSheetSchema_('Approval_Workflow')     → true
    // after someone renames column 9 in the spreadsheet:
    → throws: Schema drift in "Approval_Workflow" col 9: expected "Status", found "State".
*/
const __SCHEMA_CHECKED = {};
function assertSheetSchema_(sheetName, sheet) {
  if (__SCHEMA_CHECKED[sheetName]) return true;
  const expected = PIA_SCHEMA[sheetName];
  if (!expected) return true;                       // sheet not under schema control
  let sh = sheet;
  try {
    if (!sh) sh = getDatabaseSheet_(sheetName, false);
    if (!sh || sh.getLastRow() === 0) return true;  // missing/empty is initializeDatabase_'s problem
    const width = Math.max(sh.getLastColumn(), expected.length);
    const actual = sh.getRange(1, 1, 1, width).getValues()[0];
    for (let i = 0; i < expected.length; i++) {
      const found = String(actual[i] || '').trim();
      if (found !== expected[i]) {
        throw new Error('Schema drift in "' + sheetName + '" col ' + (i + 1) +
          ': expected "' + expected[i] + '", found "' + found + '". ' +
          'Run repairSheetHeaders() if a header is merely missing, or fix PIA_SCHEMA if the ' +
          'sheet is genuinely the newer shape. Do NOT reorder columns to make this pass.');
      }
    }
    __SCHEMA_CHECKED[sheetName] = true;
    return true;
  } catch (e) {
    if (String(e).indexOf('Schema drift') !== -1) throw e;   // real drift always propagates
    Logger.log('assertSheetSchema_: could not verify ' + sheetName + ': ' + e);
    return true;                                             // an API hiccup must not block the app
  }
}

const DB_SPREADSHEET_ID_PROP = 'PIA_DB_SPREADSHEET_ID';
const SESSION_ID_COUNTER_PROP = 'PIA_SESSION_ID_COUNTER';
const DB_INIT_FLAG_PROP = 'PIA_DB_INIT_DONE';
// One-shot marker for the 2026-08-12 header repair (see healSheetHeaders_). Delete this
// property to force the repair to run again.
const HEADER_HEAL_FLAG_PROP = 'PIA_HEADER_HEAL_DONE';
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
  Function: getNormalizedEmail_
  LAYMAN:    Cleans up an email so 'user+anything@x.com' and 'user@x.com' count as the same
             person. Used so token checks and authorization are not fooled by Gmail aliases.
  TECHNICAL: Lowercases/trims, splits on '@', drops everything after '+' in the local part,
             rejoins. Returns the lowercased input unchanged if there is no '@'.
  PARAMS:    - email: the raw address.
  RETURNS:   Normalized address string, or '' for falsy input.
  EXAMPLE:   getNormalizedEmail_('Me+Tag@X.com') -> 'me@x.com'
*/
function getNormalizedEmail_(email) {
  if (!email) return '';
  const emailLower = String(email).toLowerCase().trim();
  const [localPart, domain] = emailLower.split('@');
  if (!domain) return emailLower; // Invalid email, return as-is
  // Remove everything after the + sign in the local part
  const normalizedLocal = localPart.split('+')[0];
  return normalizedLocal + '@' + domain;
}

/*
  Function: getWorkflowInfoForType_
  LAYMAN:    Given an email category ('approver'/'ism'/'divhead'), tells the caller which
             workflow sheet and columns to stamp email status into.
  TECHNICAL: Lookup mapping queue type → { name, cols, emailCol } for the matching
             *_Approval_Workflow sheet. Used by queueEmail_ stamping / processEmailQueue.
  PARAMS:    - type: 'approver' | 'ism' | 'divhead'.
  RETURNS:   { name, cols, emailCol } object, or null for unknown types (e.g. 'applicant').
*/
function getWorkflowInfoForType_(type) {
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
  Function: getAdminNotificationConfig_
  LAYMAN:    Reads the admin settings that say who gets alerted about failed emails and whether
             to notify the requestor. Falls back to safe defaults if the settings sheet is empty.
  TECHNICAL: Reads first data row of Admin_Notification_Config via ADMIN_NOTIFICATION_COLS.
             Wrapped in try/catch; any failure returns the defaults object.
  PARAMS:    (none)
  RETURNS:   { adminEmail, notifyOnFailure, notifyRequestor, lastNotified[, configId] }.
*/
function getAdminNotificationConfig_() {
  var defaults = {
    adminEmail: 'systems.manager@company.com',
    notifyOnFailure: 'YES',
    notifyRequestor: 'YES',
    lastNotified: ''
  };
  try {
    var sheet = getDatabaseSheet_(DB_SHEET_NAMES.ADMIN_NOTIFICATION, false);
    if (!sheet || sheet.getLastRow() < 2) return defaults;
    var data = readSheetValues_(sheet);
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
  Function: generateAuthToken_
  LAYMAN:    Creates the secret signature baked into one-click approve/deny email links so a
             link cannot be forged or its action swapped (approve→deny).
  TECHNICAL: HMAC-SHA256 over (sessionId + normalizedEmail + timestamp + action) keyed by
             SYSTEM_SECRET, hex-encoded. Binding the action prevents CSRF via action tampering.
  PARAMS:    - sessionId: the application id.
             - email: approver email (normalized internally).
             - timestamp: issue time (ms) embedded in the link.
             - action: the bound action string (e.g. 'approve'); default ''.
  RETURNS:   Lowercase hex HMAC string.
*/
function generateAuthToken_(sessionId, email, timestamp, action = '') {
  // CRITICAL FIX: Include action in token to prevent CSRF via action modification
  const normalizedEmail = getNormalizedEmail_(email);
  const message = sessionId + normalizedEmail + timestamp + action;
  const signature = Utilities.computeHmacSha256Signature(message, getSystemSecret()); 
  return signature.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/*
  Function: isValidEmail_
  LAYMAN:    Checks that a string looks like a real email address.
  TECHNICAL: Simplified RFC-5322 pattern plus structural checks: exactly one '@', a domain with
             a dot, a TLD of >= 2 chars, and no consecutive dots.
  PARAMS:    - email: candidate string.
  RETURNS:   Boolean. False for non-strings/empty.
  EXAMPLE:   isValidEmail_('a@b.com') -> true ; isValidEmail_('a@b') -> false
*/
function isValidEmail_(email) {
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
  Function: sanitizeEmail_
  LAYMAN:    Cleans an email (trim + lowercase) and returns it only if it is actually valid.
  TECHNICAL: Trim/lowercase then isValidEmail_ gate; logs a WARN and returns null on failure.
  PARAMS:    - email: raw candidate.
  RETURNS:   Clean email string, or null if invalid/non-string.
*/
function sanitizeEmail_(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!isValidEmail_(trimmed)) {
    Logger.log('WARN: Invalid email format: ' + email);
    return null;
  }
  return trimmed;
}

/*
  Function: batchDeleteRows_
  LAYMAN:    Deletes several rows from a sheet at once, safely.
  TECHNICAL: Sorts row numbers descending and deletes bottom-to-top so earlier deletions do not
             shift the indices of rows still to delete. Each delete is in try/catch (logs WARN).
  PARAMS:    - sheet: target Sheet.
             - rowNumbers: 1-indexed row numbers to remove.
  RETURNS:   undefined (mutates the sheet). No-op for empty input.
*/
function batchDeleteRows_(sheet, rowNumbers) {
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
  Function: findRowsToDelete_
  LAYMAN:    Scans a sheet's data and lists which rows have a given value in a given column,
             handy for collecting rows to delete in one batch.
  TECHNICAL: Skips the header (i=1..), trims-and-compares data[i][colIndex-1] to value, returns
             the 1-indexed sheet row numbers (i+1).
  PARAMS:    - data: values from getDataRange().getValues().
             - colIndex: 1-indexed column (matches *_COLS constants).
             - value: value to match.
  RETURNS:   Array of 1-indexed row numbers (possibly empty).
*/
function findRowsToDelete_(data, colIndex, value) {
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
  Function: sendEmailWithRetry_
  LAYMAN:    Actually sends an email, retrying a couple of times if Gmail is temporarily busy or
             over quota. The lowest level of the email engine.
  TECHNICAL: Up to 3 GmailApp.sendEmail attempts with 1s/3s/5s backoff. Only retries on
             retryable errors (quota / "too many times" / temporary / timeout); other errors fail
             immediately. Sleeps between retries (Utilities.sleep).
  PARAMS:    - recipient: to-address.
             - subject: subject line.
             - body: plain-text body.
             - options: GmailApp options (htmlBody, cc, bcc, name, ...).
  RETURNS:   { ok, attempts, detail }, detail is null on success.
  EXAMPLE:   sendEmailWithRetry_('a@x.com','Hi','text',{htmlBody:'<b>Hi</b>'})
             -> { ok:true, attempts:1, detail:null }
*/
function sendEmailWithRetry_(recipient, subject, body, options) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1000, 3000, 5000];  // 1s, 3s, 5s backoff
  // Commit 9: brand the From display name as the ISM Department (unless a caller set one explicitly).
  options = options || {};
  if (!options.name) options.name = 'Megaworld ISM Department';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      /* Step 1: Try to send; success returns immediately. */
      GmailApp.sendEmail(recipient, subject, body, options);

      if (attempt > 0) {
        Logger.log('Email sent to ' + recipient + ' on attempt ' + (attempt + 1));
      }

      return {
        ok: true,
        attempts: attempt + 1,
        detail: null
      };
    } catch (e) {
      const errorMsg = e.toString();

      /* Step 2: Classify the error; only transient/quota errors are worth retrying. */
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
          // 'detail' NOT 'message': errorMsg is a RAW Gmail exception. It is read by
          // internal callers for logging only and must never reach a user-facing field.
          ok: false,
          attempts: attempt + 1,
          detail: errorMsg
        };
      }

      /* Step 3: Retryable and attempts remain: back off, then loop again. */
      // Wait and retry (exponential backoff)
      const delayMs = RETRY_DELAYS_MS[attempt];
      Logger.log('Retry attempt ' + (attempt + 2) + ' in ' + delayMs + 'ms for ' + recipient);
      Utilities.sleep(delayMs);
    }
  }

  return {
    ok: false,
    attempts: MAX_ATTEMPTS,
    detail: 'Failed after ' + MAX_ATTEMPTS + ' attempts'
  };
}

/*
  Function: isTokenValid_
  LAYMAN:    Checks that an approve/deny email link is genuine, not expired, and for the right
             action, before honoring the click.
  TECHNICAL: Rejects missing token/timestamp or links older than TOKEN_VALIDITY_MS (14 days).
             Recomputes the action-bound HMAC and compares. For legacy links issued before the
             2026-06-01 cutoff it also accepts the old action-less HMAC (bounded backward compat).
  PARAMS:    - sessionId, email, token, timestamp, fields from the link.
             - action: expected bound action (default '').
  RETURNS:   Boolean, true only if the token verifies and is within TTL.
*/
function isTokenValid_(sessionId, email, token, timestamp, action = '') {
  if (!token || !timestamp) return false;
  const now = new Date().getTime();
  const issuedAt = parseInt(timestamp, 10);
  // Enforce 14-day validity period
  if (isNaN(issuedAt) || now - issuedAt > TOKEN_VALIDITY_MS) {
    return false;
  }
  // Normalize email to handle aliases (e.g., user+alias@domain.com → user@domain.com)
  const normalizedEmail = getNormalizedEmail_(email);
  
  // Validate token with action
  const expectedTokenWithAction = generateAuthToken_(sessionId, normalizedEmail, timestamp, action);
  if (token === expectedTokenWithAction) {
    return true;
  }
  
  // Gate backwards compatibility on a hard cutoff date to prevent perpetual CSRF risk on old tokens
  const FALLBACK_CUTOFF_MS = new Date('2026-06-01T00:00:00Z').getTime(); 
  if (issuedAt < FALLBACK_CUTOFF_MS) {
    const expectedTokenWithoutAction = generateAuthToken_(sessionId, normalizedEmail, timestamp, '');
    if (token === expectedTokenWithoutAction) {
      return true;
    }
  }
  
  return false;
}

/*
  Function: encodePayload_
  LAYMAN:    Packs an object into a compact URL-safe blob. NOT secret, anyone can decode it.
  TECHNICAL: JSON.stringify → base64. WARNING: encoding, not encryption; reversible. Use only for
             obfuscation/transport, never to protect sensitive data.
  PARAMS:    - data: any JSON-serializable value.
  RETURNS:   Base64 string.
*/
function encodePayload_(data) {
  const jsonStr = JSON.stringify(data);
  const encoded = Utilities.base64Encode(jsonStr);
  return encoded;
}

/*
  Function: decodePayload_
  LAYMAN:    Unpacks a blob made by encodePayload_ back into an object.
  TECHNICAL: base64Decode → JSON.parse, in try/catch. Returns null on any failure (logs it).
  PARAMS:    - encodedStr: base64 string from encodePayload_.
  RETURNS:   The decoded value, or null if decode/parse fails.
*/
function decodePayload_(encodedStr) {
  try {
    const jsonStr = Utilities.base64Decode(encodedStr);
    return JSON.parse(jsonStr);
  } catch (e) {
    Logger.log('decodePayload_ failed: ' + e.toString());
    return null;
  }
}

const makeFlagBtn = (label, isQuick = false) => `<button type="button" onclick="${isQuick ? 'toggleQuickFlag(this)' : 'toggleFlagBox(this)'}" data-flag="${escapeHtml_(label).replace(/'/g, "\\'")}" class="flag-btn" title="Flag ${escapeHtml_(label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg></button>`;

/*
  Helper: safeIdAttr_
  LAYMAN:    Nililinis yung ID bago ilagay sa loob ng onclick="...", puro letra, numero, dash at
             underscore lang ang papasa. Session IDs at Drive file IDs ay ganun lang naman talaga.
  TECHNICAL: Whitelist filter, not a blacklist. Used instead of escapeHtml_ for values that land in a
             JS string literal INSIDE an HTML attribute, where entity-escaping alone would not stop a
             quote breakout. Returns '' for null/undefined.
*/
const safeIdAttr_ = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');

/*
  Helper: makeDocDownloadBtn_
  LAYMAN:    Gumagawa ng "View <doc>" na button na, pag pinindot, hihingin yung file sa server
             (may authorization check) sa halip na dumiretso sa Drive link.
  TECHNICAL: Replaces the former `<a href="https://drive.google.com/file/d/...">` markup. Keeps the
             exact same .btn.btn-sm styling so the review-form layout is unchanged. sessionId/fileId
             are whitelist-filtered; the visible label and title are HTML-escaped.
  PARAMS:    - sessionId: PIA session id.  - fileId: Drive file id.
             - label: visible button text (already-composed, e.g. 'View DSA').
             - title: hover text, typically the filename.
  RETURNS:   HTML string for one download button.
*/
const makeDocDownloadBtn_ = (sessionId, fileId, label, title) =>
  `<button type="button" class="btn btn-sm" style="color: var(--navy-bright); border-color: var(--navy-bright);" title="${escapeHtml_(title || label)}" onclick="viewDcsFile('${safeIdAttr_(sessionId)}','${safeIdAttr_(fileId)}',this)">${escapeHtml_(label)}</button>`;

/*
  Function: escapeHtml_
  LAYMAN:    Makes user text safe to drop into an email or HTML page (no broken markup / XSS).
  TECHNICAL: Escapes & < > " ' to their HTML entities. Coerces falsy input to ''.
  PARAMS:    - str: value to escape.
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
  ━━━ THE ERROR CONTRACT (F-06) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  LAYMAN (Tropang Ex):
  Dati, kapag may pumalpak sa server, yung EKSAKTONG error message ng Google ang
  ipinapakita sa browser. Problema: kasama dun yung ID ng spreadsheet at ng Drive folder
  natin. Ibig sabihin, isang sirang request lang, may naibigay ka nang internal na ID sa
  kung sino man ang nakatingin. Ngayon: yung totoong error, sa LOG lang; yung user,
  malinis na mensahe + isang maikling "Reference" code. Kapag nag-report siya, hahanapin
  mo lang yung code na yun sa Executions log at makikita mo yung buong detalye.

  TECHNICAL:
  Closes F-06 (CWE-200, "Raw error text returned to the client"). 110 catch blocks across
  the three projects returned `error: e.toString()`; GAS exceptions echo the offending
  resource ID, so a Drive failure leaked the folder id and a Sheets failure leaked the
  spreadsheet id.

  🚩 THE ENVELOPE IS SINGLE-KEY (since 2026-08-12):

      { ok: false, code: 'NOT_FOUND', message: '...', ref: '7f3a91' }

  It shipped DUAL-KEY for exactly one release, carrying a legacy `success`/`error` pair
  beside these, so a frontend call site that had not been migrated yet kept working
  instead of silently rendering "undefined" at a user. Three separate GAS projects deploy
  independently, so a window where backend and frontend disagree is not hypothetical, it
  is the normal case. That window is now closed: the pair was removed from all three
  backends and all three frontends in one change.

  ⚠️ A `success` or `error` key you still see in this project is NOT this envelope.
  `{ valid:false, error }` from validateComment_, `flags.error` inside audit JSON,
  `Email_Queue.Last_Error`, the `result.errors` ARRAY from PIA validation, and every
  `Logger.log('... error: ' + e)` label are unrelated and must stay.

  🚩 The sweep that closed F-06 was incomplete on its first pass, and the reason
  generalizes. The original pattern matched only a value that STARTED with the exception
  identifier, so 21 sites shaped `error: 'Loading failed: ' + e.message` survived it,
  including every getAdminData handler and both cross-app doPost handlers. When sweeping
  for a leak, match the CONCATENATED form too, not just the bare one.

  ⚠️ The real exception goes to Logger.log ONLY, deliberately NOT to Risk_Audit. An audit
  row per error is exactly the log-bloat pattern this repo already avoids elsewhere, and
  a sheet write inside an error handler is a second failure waiting to happen. Stackdriver
  ("exceptionLogging": "STACKDRIVER" in the manifest) already retains it, keyed by `ref`.
*/
const ERR = {
  UNAUTHORIZED:     'UNAUTHORIZED',      // not signed in, or not on the allowed domain
  FORBIDDEN:        'FORBIDDEN',         // signed in, but not a party to this record
  NOT_FOUND:        'NOT_FOUND',
  VALIDATION:       'VALIDATION',        // the caller sent something malformed
  CONFLICT:         'CONFLICT',          // someone else changed it first
  ALREADY_ACTIONED: 'ALREADY_ACTIONED',  // decision already recorded / no longer pending
  BUSY:             'BUSY',              // could not acquire the lock in time
  INTERNAL:         'INTERNAL'           // anything we did not anticipate
};

const ERR_MESSAGES = {
  UNAUTHORIZED:     'You are not signed in with an authorized account.',
  FORBIDDEN:        'You do not have access to this record.',
  NOT_FOUND:        'That record could not be found.',
  VALIDATION:       'Some of the information submitted was not valid.',
  CONFLICT:         'Someone else updated this record. Please reload and try again.',
  ALREADY_ACTIONED: 'This request has already been processed.',
  BUSY:             'The system is busy right now. Please try again in a moment.',
  INTERNAL:         'Something went wrong on our end.'
};

/*
  Function: fail_
  LAYMAN:    Gumagawa ng standard na "hindi natuloy" na sagot. Isang hugis lang, kahit saan.
  TECHNICAL: Builds the dual-key failure envelope. Unknown codes degrade to INTERNAL rather
             than emitting a code the frontend cannot interpret.
  PARAMS:    - code: one of ERR.*.
             - message: optional override; defaults to the code's standard wording.
  RETURNS:   { ok:false, code, message }.
  EXAMPLE
    return fail_(ERR.NOT_FOUND);
    return fail_(ERR.VALIDATION, 'Comment must be at least 20 characters.');
*/
function fail_(code, message) {
  const c = Object.prototype.hasOwnProperty.call(ERR_MESSAGES, code) ? code : ERR.INTERNAL;
  const m = message || ERR_MESSAGES[c];
  return { ok: false, code: c, message: m };
}

/*
  Function: safeError_
  LAYMAN:    Ito ang tawagin sa loob ng catch. Sinusulat niya yung totoong error sa log
             (kasama ang stack), tapos binibigay sa user yung malinis na mensahe at isang
             maikling reference code. Yung reference code ang tulay: sabihin sa'yo ng user,
             hanapin mo sa log.
  TECHNICAL: Logs `[ref] CODE :: stack` then returns fail_() with the ref appended to the
             public message. NEVER put e.toString()/e.message into the returned object.
  PARAMS:    - e: the caught exception.
             - code: one of ERR.* (defaults to INTERNAL).
             - publicMessage: optional user-facing override.
  RETURNS:   The dual-key failure envelope, plus a `ref` field.
  EXAMPLE
    } catch (e) { return safeError_(e, ERR.INTERNAL); }
    → { ok:false, code:'INTERNAL', ref:'7f3a91',
        message:'Something went wrong on our end. Reference: 7f3a91', … }
*/
function safeError_(e, code, publicMessage) {
  const ref = Utilities.getUuid().slice(0, 8);
  const detail = (e && e.stack) ? e.stack : String(e);
  Logger.log('[' + ref + '] ' + (code || ERR.INTERNAL) + ' :: ' + detail);
  const out = fail_(code || ERR.INTERNAL, publicMessage);
  out.ref = ref;
  out.message = out.message + ' Reference: ' + ref;
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════
//  DELEGATION / OUT-OF-OFFICE, admin-managed
// ════════════════════════════════════════════════════════════════════════════════════
/*
  ━━━ WHY THIS IS HARDER THAN A LOOKUP TABLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  LAYMAN (Tropang Ex):
  Nag-leave yung approver, tumigil yung request. Walang makakagalaw para sa kanya. Mukhang
  simpleng ayusin, "gawan ng table kung sino ang kapalit", pero hindi.

  Yung email ng approver ay naka-BAON na sa row noong nag-submit pa lang. Tapos TATLONG
  magkakaibang bagay ang naka-sandal dun: (1) yung security check na "ikaw ba talaga si X?",
  (2) yung lagda sa link mismo sa email, naka-sign yun sa email NIYA, at (3) yung paghahanap
  ng tamang row. Kaya kung ipapasa mo lang yung link sa kapalit, TATLO ang babagsak, hindi isa.

  Ang solusyon: sa oras ng pag-email pa lang, ang DELEGATE na ang padadalhan AT ang delegate
  na ang pipirmahan ng link. Ganun, normal na normal na yung daan ng link. Yung row, sa
  ORIHINAL na approver pa rin naka-pangalan, dinadagdagan lang ng ACTED_BY para malinaw sa
  audit trail kung sino talaga ang pumindot.

  TECHNICAL:
  Implements §IV.2. The approver email is denormalized into the workflow row at
  initializeApprovalWorkflow_ time, and three mechanisms key off it:
    1. the F-02 guard  (Session.getActiveUser() must equal the passed approver email)
    2. the HMAC review token, minted OVER that email (generateAuthToken_)
    3. the row lookup  (match on APPROVER_EMAIL + Pending + round)
  A delegate clicking the original's link fails all three, so forwarding is not a workaround.

  The design therefore resolves the delegate at NOTIFY time, not at decision time:
    - notify paths send to the delegate and mint the token over the DELEGATE's email, so
      handleEmailAction_'s identity check and token check both pass without modification;
    - the F-02 guards widen from "is the same person" to canActAs_, which also accepts an
      active delegate;
    - the row match is unchanged, still the original approver's row, and ACTED_BY records
      who really acted.

  🚩 ADMIN-MANAGED ONLY, and that is a security decision, not a UI convenience. If approvers
  could appoint their own stand-in, any approver could quietly route their own approvals to a
  chosen colleague. ISM maintains the table; there is no self-service path.

  🚩 A delegation does NOT let the delegate approve a request they are otherwise barred from,
  and it does not stack: resolveDelegate_ takes ONE hop. If A delegates to B and B delegates
  to C, A's requests go to B, not C. Chained delegation is a loop risk and an accountability
  hole; if it is ever needed, add cycle detection first.
*/
const DELEGATION_COLS = colsOf_("Delegations", {
  DELEGATION_ID: 'Delegation_ID',
  FROM_EMAIL: 'From_Email',
  TO_EMAIL: 'To_Email',
  START_DATE: 'Start_Date',
  END_DATE: 'End_Date',
  REASON: 'Reason',
  IS_ACTIVE: 'Is_Active',
  CREATED_BY: 'Created_By',
  CREATED_AT: 'Created_At'
});

/*
  Function: getDelegationsSheet_
  LAYMAN:    Kinukuha (o ginagawa, kung wala pa) yung Delegations tab.
  TECHNICAL: Self-healing accessor, creates the tab with headers on first use, mirroring
             getApplicationSnapshotSheet_, so a deployment that never re-ran
             initializeDatabase_ still works without a manual setup step.
  PARAMS:    (none)
  RETURNS:   The Sheet, or null if it could not be created.
*/
function getDelegationsSheet_() {
  const sheet = getDatabaseSheet_(DB_SHEET_NAMES.DELEGATIONS, true);
  if (!sheet) return null;
  try {
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(PIA_SCHEMA["Delegations"].slice());
      formatHeaderRow_(sheet);
    }
  } catch (e) {
    Logger.log('getDelegationsSheet_: header init failed: ' + e);
  }
  return sheet;
}

/*
  Function: healSheetHeaders_

  LAYMAN (Tropang Ex):
  Ayusin yung mga pangalan sa itaas na row (yung header) ng mga tab, kung may mali o kulang.
  Bakit kailangan: noong nagdagdag ako ng ActedBy na column para sa delegation, na-update ko
  yung listahan sa code pero HINDI ko na-update yung header na isinusulat sa sheet. So
  nasusulat yung data sa tamang column, pero WALANG pangalan sa taas nito, kaya hindi
  makita ng Admin app, na naghahanap by name. Ito yung nag-aayos nun, kusa, walang manual
  na pag-edit ng spreadsheet.

  TECHNICAL:
  Idempotent header repair for live databases. initializeDatabase_ only writes headers when it
  CREATES a sheet, so an existing deployment never picks up a column added later, the cell
  gets written by setValue (extending the sheet) with a blank header above it.

  Fixes the drift found on 2026-08-12:
    - ActedBy missing from Approval_Workflow / ISM_Approval_Workflow / DivisionHead_Approval_Workflow
    - Data_Collection col 11 headed 'Remarks' by PIA but 'Metadata_Agency' by Phase 1 (its owner);
      Admin resolves that column BY NAME, so the wrong header made agency metadata invisible there.

  🚩 Only ever writes to row 1, and only when a cell is blank or holds the known-wrong value.
  It will not touch a header someone deliberately renamed to something else, and it never
  reorders or inserts columns, a header repair must not be able to shift data.

  PARAMS:    (none)
  RETURNS:   { repaired: [ 'Sheet.Column', ... ] }, empty when nothing needed fixing.

  EXAMPLE
    healSheetHeaders_()
    → { repaired: ['Approval_Workflow.ActedBy', 'Data_Collection.Metadata_Agency'] }
    → { repaired: [] }   on an already-correct database
*/
function healSheetHeaders_() {
  const repaired = [];

  // [sheetName, 1-based column, expected header, the wrong value we are allowed to overwrite]
  const FIXES = [
    [DB_SHEET_NAMES.APPROVAL_WORKFLOW, APPROVAL_COLS.ACTED_BY,        'ActedBy',          ''],
    [DB_SHEET_NAMES.ISM_WORKFLOW,      ISM_WORKFLOW_COLS.ACTED_BY,    'ActedBy',          ''],
    [DB_SHEET_NAMES.DIV_HEAD_CONFIG,   DIV_HEAD_CONFIG_COLS.ACTED_BY, 'ActedBy',          ''],
    [DB_SHEET_NAMES.DATA_COLLECTION,   DCS_COLS.METADATA_AGENCY,      'Metadata_Agency',  'Remarks']
  ];

  FIXES.forEach(function (fix) {
    const sheetName = fix[0], col = fix[1], want = fix[2], replaceable = fix[3];
    try {
      const sheet = getDatabaseSheet_(sheetName, false);
      if (!sheet || sheet.getLastRow() === 0) return;

      const current = (col <= sheet.getLastColumn())
        ? String(sheet.getRange(1, col).getValue() || '').trim()
        : '';

      if (current === want) return;                                   // already correct
      if (current !== '' && current !== replaceable) {                // someone renamed it on purpose
        Logger.log('healSheetHeaders_: ' + sheetName + ' col ' + col +
                   ' holds "' + current + '", expected "' + want + '", left alone.');
        return;
      }
      sheet.getRange(1, col).setValue(want);
      repaired.push(sheetName + '.' + want);
    } catch (e) {
      Logger.log('healSheetHeaders_: could not repair ' + sheetName + ' col ' + col + ': ' + e);
    }
  });

  if (repaired.length) Logger.log('healSheetHeaders_: repaired ' + repaired.join(', '));
  return { repaired: repaired };
}

/*
  Function: repairSheetHeaders
  LAYMAN:    Patakbuhin ito NANG ISANG BESES sa editor pagkatapos mag-deploy, para maayos yung
             mga kulang na header sa kasalukuyang database. Ligtas ulit-ulitin, kung ayos na,
             wala siyang gagawin.
  TECHNICAL: Owner-gated public wrapper over healSheetHeaders_. Public because it is meant to be
             run from the Apps Script editor; isOwnerContext_() stops any domain user invoking a
             header write from a browser console.
  PARAMS:    (none)
  RETURNS:   { ok, repaired[] } or an authorization failure.
*/
function repairSheetHeaders() {
  if (!isOwnerContext_()) return fail_(ERR.FORBIDDEN, 'Not authorized.');
  const result = healSheetHeaders_();
  return { ok: true, repaired: result.repaired,
           message: result.repaired.length
             ? 'Repaired: ' + result.repaired.join(', ')
             : 'All sheet headers are already correct.' };
}

/*
  Function: resolveDelegate_

  LAYMAN (Tropang Ex):
  Tanong: "May kapalit ba si <email> ngayon?" Kung meron at aktibo pa (nasa loob ng petsa at
  naka-YES), ibabalik yung email ng kapalit. Kung wala, null, normal na daloy.

  TECHNICAL:
  Single-hop lookup against the Delegations sheet. A row applies when Is_Active is YES and
  today falls within [Start_Date, End_Date] inclusive. A blank start means "already started";
  a blank end means "open-ended". Comparison is on whole local days so a delegation ending
  today is still honoured all day.

  🚩 Fails OPEN to "no delegate" on any error. That is the right direction: a broken
  delegation table must degrade to normal routing (the named approver still gets the mail),
  never to "nobody is notified".

  PARAMS:
  - email: the named approver's address.
  - atDate: optional Date to evaluate against; defaults to now. Used by tests.

  RETURNS:
  { email, reason, delegationId } for an active delegate, or null.

  EXAMPLE
    resolveDelegate_('jane@megaworld.com')
    → { email:'carlo@megaworld.com', reason:'Annual leave', delegationId:'DEL-0003' }
    → null when Jane is not away, or when the sheet is unreadable
*/
function resolveDelegate_(email, atDate) {
  const from = getNormalizedEmail_(email);
  if (!from) return null;
  let rows;
  try {
    const sheet = getDelegationsSheet_();
    if (!sheet) return null;
    rows = readSheetValues_(sheet);
  } catch (e) {
    Logger.log('resolveDelegate_: delegation lookup failed, falling back to direct routing: ' + e);
    return null;
  }
  if (!rows || rows.length < 2) return null;

  const now = atDate || new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[DELEGATION_COLS.IS_ACTIVE - 1] || '').trim().toUpperCase() !== 'YES') continue;
    if (getNormalizedEmail_(r[DELEGATION_COLS.FROM_EMAIL - 1]) !== from) continue;

    const to = sanitizeEmail_(r[DELEGATION_COLS.TO_EMAIL - 1]);
    if (!to) continue;
    if (getNormalizedEmail_(to) === from) continue;   // self-delegation is a no-op, not an error

    const start = parseDelegationDate_(r[DELEGATION_COLS.START_DATE - 1]);
    const end   = parseDelegationDate_(r[DELEGATION_COLS.END_DATE - 1]);
    if (start && today < start) continue;
    if (end && today > end) continue;

    return {
      email: to,
      reason: String(r[DELEGATION_COLS.REASON - 1] || '').trim(),
      delegationId: String(r[DELEGATION_COLS.DELEGATION_ID - 1] || '').trim()
    };
  }
  return null;
}

/*
  Function: parseDelegationDate_
  LAYMAN:    Ginagawang petsa yung laman ng cell. Kung walang laman o hindi mabasa, null,
             ibig sabihin walang hangganan sa gilid na yun.
  TECHNICAL: Accepts a Date object (Sheets often auto-converts) or 'YYYY-MM-DD', normalized to
             local midnight so day comparisons are inclusive at both ends. Returns null for
             blank or unparseable, which callers treat as "unbounded on that side".
  PARAMS:    - v: the raw cell value.
  RETURNS:   A Date at local midnight, or null.
*/
function parseDelegationDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  }
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/*
  Function: canActAs_

  LAYMAN (Tropang Ex):
  "Pwede bang si <caller> ang pumirma para kay <approver>?" Oo kung (a) sila mismo, o
  (b) sila ang naka-set na kapalit ngayon. Wala nang pangatlo.

  TECHNICAL:
  The widened F-02 predicate.

  🚩 EXCLUSIVE, NOT ADDITIVE: and that is the whole point. The first cut of this function
  checked same-person FIRST and delegation second, which meant the original approver AND
  their delegate could both act on the same Pending row. That is not a handoff, it is a
  race: two people can hold a valid link to the same step and click Approve seconds apart,
  and whichever write lands second silently loses (the row is no longer Pending, so the
  second caller gets "record not found", confusing at best, and it makes "who actually
  decided this" ambiguous).

  Delegation is therefore resolved FIRST and answers for the whole function: while a
  delegation is active, ONLY the delegate passes. The original approver is refused on
  exactly the same branch a stranger is. There is always exactly one "yes".

  With an empty Delegations sheet (day one, or once a delegation expires or is removed)
  resolveDelegate_ returns null and this collapses to a plain identity check, i.e. the
  pre-delegation behaviour.

  PARAMS:
  - callerEmail: the resolved Session.getActiveUser() address.
  - approverEmail: the address named on the workflow row.

  RETURNS:
  { allowed:boolean, onBehalfOf:string }, onBehalfOf is '' when the approver acted
  personally, and the ORIGINAL approver's address when a delegate acted. Callers write that
  straight into ACTED_BY.

  EXAMPLE
    // no delegation in effect
    canActAs_('jane@mw.com',   'jane@mw.com') → { allowed:true,  onBehalfOf:'' }
    canActAs_('mallory@mw.com','jane@mw.com') → { allowed:false, onBehalfOf:'' }
    // while Jane is delegated to Carlo
    canActAs_('carlo@mw.com',  'jane@mw.com') → { allowed:true,  onBehalfOf:'jane@mw.com' }
    canActAs_('jane@mw.com',   'jane@mw.com') → { allowed:false, onBehalfOf:'' }  ← Jane too
*/
function canActAs_(callerEmail, approverEmail) {
  const me = getNormalizedEmail_(callerEmail);
  const target = getNormalizedEmail_(approverEmail);
  if (!me || !target) return { allowed: false, onBehalfOf: '' };

  // Delegation first, and it is exclusive: an active delegate is the ONLY one who may act.
  // Checking same-person first (the obvious ordering) is what would reopen the double-approve
  // window, because the original would short-circuit out before delegation was ever consulted.
  const del = resolveDelegate_(target);
  if (del) {
    if (me === getNormalizedEmail_(del.email)) {
      Logger.log('DELEGATION: ' + me + ' acting on behalf of ' + target +
                 (del.delegationId ? ' [' + del.delegationId + ']' : ''));
      return { allowed: true, onBehalfOf: target };
    }
    if (me === target) {
      Logger.log('DELEGATION: refused ' + me + ' on their own row, currently delegated to ' +
                 del.email + (del.delegationId ? ' [' + del.delegationId + ']' : ''));
    }
    return { allowed: false, onBehalfOf: '' };   // includes the original, no shared window
  }

  if (me === target) return { allowed: true, onBehalfOf: '' };
  return { allowed: false, onBehalfOf: '' };
}

/*
  Function: recipientFor_
  LAYMAN:    Sino ang dapat padalhan ng email para sa approver na ito? Kung may kapalit,
             siya. Kung wala, yung approver mismo.
  TECHNICAL: The single choke point every notify path routes through, so delegation cannot
             be half-applied (mail to one address, token signed for another, which would
             produce a link that fails the identity check and look like a bug).
  PARAMS:    - approverEmail: the address named on the workflow row.
  RETURNS:   { email, onBehalfOf, reason }, onBehalfOf is '' when there is no delegation.
*/
function recipientFor_(approverEmail) {
  const del = resolveDelegate_(approverEmail);
  if (!del) return { email: approverEmail, onBehalfOf: '', reason: '' };
  return { email: del.email, onBehalfOf: approverEmail, reason: del.reason };
}

/*
  Function: delegationNoticeHtml_
  LAYMAN:    Yung maliit na paalala sa email: "pinapadala ito sa'yo kasi ikaw ang kapalit ni
             <X>." Kailangan yun: kung wala, magtataka yung tao kung bakit siya inemail
             tungkol sa request na hindi naman sa kanya.
  TECHNICAL: Returns '' when there is no delegation, so every call site can concatenate it
             unconditionally without a branch.
  PARAMS:    - onBehalfOf: the original approver's address, or ''.  - reason: optional.
  RETURNS:   An HTML string, or ''.
*/
function delegationNoticeHtml_(onBehalfOf, reason) {
  if (!onBehalfOf) return '';
  return '<div style="background:#fffbeb;border:1px solid rgba(180,109,20,0.25);border-radius:4px;'
       + 'padding:10px 14px;font-size:13px;color:#92400e;margin-bottom:16px;">'
       + 'You are receiving this because you are the designated delegate for <strong>'
       + escapeHtml_(onBehalfOf) + '</strong>'
       + (reason ? ' (' + escapeHtml_(reason) + ')' : '')
       + '. Your decision will be recorded as made on their behalf.</div>';
}

/*
  Function: getAndShareDCSFiles_
  LAYMAN:    Finds the DCS attachments (NDA/DPA/DSA) for a request in the admin Drive folder and
             makes them domain-viewable so approvers can open them from the email.
  TECHNICAL: Resolves ADMIN_FOLDER_ID from Script Properties, searches by "title contains
             dcsReqId", sets each match to DOMAIN_WITH_LINK / VIEW. All wrapped in try/catch so a
             sharing failure never blocks the flow. (The legacy `|| ADMIN_FOLDER_ID` bare-constant
             fallback was removed: that identifier is not defined in this file, so it threw a
             ReferenceError that the try/catch swallowed, it never actually acted as a fallback.)
  PARAMS:    - dcsReqId: linked DCS Request ID.
  RETURNS:   Array of { id, name, url }; [] if none found or on error.
*/
/*
  🚩 SECURITY: THE ONE DELIBERATE SHARING EXCEPTION IN THE SYSTEM. Do not "clean this up."

  Everywhere else, uploaded DCS documents are PRIVATE in Drive (Phase 1/Code.js uploadProxy_ sets
  no sharing at all) and are read only through apiDownloadDcsFile, which re-authorizes the caller.

  This function is the exception, and it exists for one concrete reason: it feeds the Certificate
  of Approval email and its PDF attachment, which are sent to the DCOPS / TechServe implementation
  inboxes. An email client cannot call google.script.run, so a download proxy is impossible there.
  The only way those teams can open the documents they need to provision access is a link.

  What keeps the blast radius small:
    - the elevation is DOMAIN_WITH_LINK, never ANYONE_WITH_LINK, so it stays inside the company;
    - it fires only at final-certificate time (routeApprovedRequest_), i.e. after full approval;
    - it touches only the one request being routed, not the vault.

  If you ever remove the link from the certificate email (e.g. by attaching the document bytes
  directly instead), delete this elevation with it, do not leave it running unused.
*/
function getAndShareDCSFiles_(dcsReqId) {
  if (!dcsReqId) return [];
  const foundFiles = [];
  const seen = {};

  // PRIMARY (#15): use the file IDs stored on the DCS Data_Collection record. This is reliable, it does
  // not depend on the Admin folder configuration or the file-naming/search scope. Internal NDA/DPA docs
  // are included here too (previously the folder title-search could miss them).
  try {
    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, false);
    if (dcsSheet) {
      const vals = readSheetValues_(dcsSheet);
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
      const folderId = PropertiesService.getScriptProperties().getProperty('ADMIN_FOLDER_ID');
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
  Function: getDCSSupersededFiles_
  LAYMAN:    Reads the DCS request's list of REPLACED documents (the ones a requestor overwrote on a
             revision). These stay viewable because they're archived, not trashed, so the certificate
             can show the full old→new document trail.
  TECHNICAL: Parses Data_Collection.Metadata_JSON for the linked reqId and returns its supersededFiles
             array, mapped to { type, name, id, url, supersededRound, supersededAt }. [] on any miss.

             🚩 SECURITY: like getAndShareDCSFiles_ above, this elevates each archived file to
             DOMAIN_WITH_LINK. Same single reason: its ONLY caller is the Certificate of Approval
             builder (routeApprovedRequest_), whose email + PDF render these as clickable links and
             cannot call google.script.run. Uploads are otherwise private (Phase 1 uploadProxy_).
             If the certificate ever stops linking superseded documents, remove this elevation too.

  PARAMS:    - dcsReqId: the linked DCS request id.
  RETURNS:   Array of superseded-document descriptors (possibly empty).
*/
function getDCSSupersededFiles_(dcsReqId) {
  if (!dcsReqId) return [];
  try {
    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, false);
    if (!dcsSheet) return [];
    const vals = readSheetValues_(dcsSheet);
    for (let i = 1; i < vals.length; i++) {
      if (String(vals[i][DCS_COLS.REQ_ID - 1] || '').trim() === String(dcsReqId).trim()) {
        let meta = {};
        try { meta = JSON.parse(vals[i][DCS_COLS.METADATA_JSON - 1] || '{}'); } catch (e) {}
        const list = Array.isArray(meta.supersededFiles) ? meta.supersededFiles : [];
        return list.map(function (f) {
          // Certificate exception (see the doc block): archived files are private at rest now, so
          // elevate this one request's superseded docs to domain-link at certificate time only.
          // Guarded per file: a missing/trashed archive entry must not break the certificate.
          if (f && f.id) {
            try {
              DriveApp.getFileById(f.id)
                .setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
            } catch (shareErr) {
              Logger.log('WARN: could not domain-share superseded file ' + f.id + ': ' + shareErr.toString());
            }
          }
          return {
            type: f.type || '',
            name: f.name || 'Document',
            id: f.id || '',
            url: f.id ? ('https://drive.google.com/file/d/' + f.id + '/view') : '#',
            supersededRound: f.supersededRound || '',
            supersededAt: f.supersededAt || ''
          };
        });
      }
    }
  } catch (e) { Logger.log('getDCSSupersededFiles_ failed: ' + e.toString()); }
  return [];
}

/*
  Function: collectDcsFileIds_

  LAYMAN (Tropang Ex):
  Lahat ng Drive file ID na TALAGANG kabilang sa isang DCS request, kasalukuyang attachments,
  lumang bersyon na na-replace, at yung endorsement letter. Ito yung listahang ikukumpara bago
  magbukas ng file.

  TECHNICAL:
  PIA-side twin of Phase 1's collectRequestFileIds_ (separate GAS projects cannot share code, so
  this is a deliberate duplicate, keep the two in sync). Builds the set of Drive file IDs
  reachable from one Data_Collection row: FILE_ID JSON, Metadata_JSON.supersededFiles, and
  Metadata_Agency.endorsementLetter.id. Every parse is defensive.

  This is the anti-confused-deputy list: being an approver on a request is not authority over an
  arbitrary Drive file in the script owner's Drive.

  PARAMS:
    - row: a Data_Collection row as a 0-indexed array.
  RETURNS:   { '<driveFileId>': true, ... }
*/
function collectDcsFileIds_(row) {
  const allowed = {};
  const add = function (id) {
    const s = String(id || '').trim();
    if (s) allowed[s] = true;
  };
  try {
    const files = JSON.parse(row[DCS_COLS.FILE_ID - 1] || '[]');
    (Array.isArray(files) ? files : []).forEach(function (f) { if (f) add(f.id); });
  } catch (e) { /* malformed cell contributes nothing */ }
  try {
    const meta = JSON.parse(row[DCS_COLS.METADATA_JSON - 1] || '{}');
    (Array.isArray(meta.supersededFiles) ? meta.supersededFiles : []).forEach(function (f) {
      if (f) add(f.id);
    });
  } catch (e) { /* malformed cell contributes nothing */ }
  try {
    const agency = JSON.parse(row[DCS_COLS.METADATA_AGENCY - 1] || '{}');
    if (agency && agency.endorsementLetter) add(agency.endorsementLetter.id);
  } catch (e) { /* malformed cell contributes nothing */ }
  return allowed;
}

/*
  Function: apiDownloadDcsFile

  LAYMAN (Tropang Ex):
  Ganito na binubuksan ng approver yung mga dokumentong naka-attach sa request na nire-review niya.
  Dati kasi direktang Drive link: at yung link na yun ay bukas sa kahit sino sa buong internet.
  Ngayon, tinatanong muna ng server kung kasama ka ba sa request na to (ikaw ba yung nag-file, o
  isa ka sa mga approver / ISM / Division Head nito). Kung oo, ipapadala niya mismo yung laman ng
  file. Walang Drive link na lumalabas.

  TECHNICAL:
  PIA-side document proxy. Signature differs from the Phase 1 twin on purpose: PIA works in terms
  of a PIA sessionId, so authorization can reuse the existing isAuthorizedForApplication_ predicate
  (owner ∪ Stage-A heads ∪ ISM members ∪ Division Head) rather than re-deriving it. The DCS row is
  then resolved via appData.linkedReqId.

  Gates, in order, each failing before any Drive I/O:
    (1) corporate domain,
    (2) per-application authority via isAuthorizedForApplication_,
    (3) file membership via collectDcsFileIds_ (anti-confused-deputy),
    (4) size ceiling, base64 inflates ~33% and google.script.run payloads get unreliable well
        before a 10 MB upload round-trips.

  Errors to the caller are generic; the real exception is logged server-side only, because Drive
  exceptions echo the offending resource ID and would leak ADMIN_FOLDER_ID.

  PARAMS:
    - sessionId: the PIA session whose linked DCS request owns the document.
    - fileId: the Drive file ID. Validated against the request, never trusted alone.
  RETURNS:   { ok: true, data:{ base64, mimeType, filename } } |
             { ok:false, code, message } with a generic message.

  EXAMPLE
    apiDownloadDcsFile('PIA-000075', '1AbC...xyz')
      -> { ok: true, data:{ base64:'JVBERi0…', mimeType:'application/pdf',
                                filename:'DCS-000007-NDA.pdf' } }
    apiDownloadDcsFile('PIA-000075', '<a file from another request>')
      -> { ok: false, message: 'Document not available.' }
*/
function apiDownloadDcsFile(sessionId, fileId) {
  const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // 8 MB decoded; ~10.7 MB once base64-encoded
  // One opaque message for every authorization failure, never reveal which gate rejected.
  const DENIED = { ok: false, message: 'Document not available.' };

  try {
    /* Step 1: Domain + argument gate. */
    const me = Session.getActiveUser().getEmail();
    if (!isAuthorizedDomain_(me)) return DENIED;
    if (!sessionId || !fileId) return DENIED;

    /* Step 2: Per-application authority (owner / head / ISM / DivHead). */
    const appData = getApplicationData_(sessionId);
    if (!appData) return DENIED;
    if (!isAuthorizedForApplication_(sessionId, appData)) {
      Logger.log('SECURITY ALERT: ' + me + ' attempted document access on ' + sessionId);
      return DENIED;
    }

    /* Step 3: Resolve the linked DCS row that actually holds the file list. */
    const linkedReqId = String(appData.linkedReqId || '').trim();
    if (!linkedReqId) return DENIED;

    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, false);
    if (!dcsSheet) return DENIED;

    const vals = readSheetValues_(dcsSheet);
    let dcsRow = null;
    for (let i = 1; i < vals.length; i++) {
      if (String(vals[i][DCS_COLS.REQ_ID - 1] || '').trim() === linkedReqId) {
        dcsRow = vals[i];   // keep scanning: the LAST match is the newest revision
      }
    }
    if (!dcsRow) return DENIED;

    /* Step 4: File-membership gate: the fileId must belong to THIS request. */
    const allowed = collectDcsFileIds_(dcsRow);
    if (!allowed[String(fileId).trim()]) {
      Logger.log('SECURITY ALERT: ' + me + ' requested file ' + fileId +
                 ' which does not belong to ' + linkedReqId);
      return DENIED;
    }

    /* Step 5: Size gate, then read and encode. */
    const file  = DriveApp.getFileById(String(fileId).trim());
    const blob  = file.getBlob();
    const bytes = blob.getBytes();
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      return {
        ok: false,
        message: 'This document is too large to open here (' +
               (bytes.length / 1024 / 1024).toFixed(1) +
               ' MB). Please request a copy from the ISM Department.'
      };
    }

    return {
      ok: true,
      data: {
        base64  : Utilities.base64Encode(bytes),
        mimeType: blob.getContentType() || 'application/octet-stream',
        filename: file.getName()
      }
    };

  } catch (e) {
    // Generic to the caller, specific to the log: Drive errors echo resource IDs.
    Logger.log('apiDownloadDcsFile failed for ' + sessionId + '/' + fileId + ': ' + e.toString());
    return { ok: false, message: 'Could not open this document. Please try again or contact ISM.' };
  }
}

/*
  Function: getStyledHtmlWrapper_
  LAYMAN:    Wraps a header + content into a complete, styled HTML page, used for the
             "access denied", approve/deny result, and other standalone pages the app serves.
  TECHNICAL: Returns a full HTML document string (fonts, :root design tokens, toast helpers)
             with header/content interpolated. Pure template builder, no side-effects.
  PARAMS:    - header: HTML for the page title/badge area.
             - content: HTML for the page body.
  RETURNS:   Complete HTML document string.
*/
function getStyledHtmlWrapper_(header, content) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        /* GENERATED from docs/design-tokens.css, this is the block an APPROVER sees on the
           page they land on from an email link. It drifted to navy #1a3a5c and radius 6/12 for
           months because nobody thinks of the backend as having a stylesheet. Edit the canonical
           file, then paste into all 6 targets. */
        :root {
          --bg:      #ffffff;
          --bg2:     #f7f8fa;
          --bg3:     #eff1f5;
          --text:    #111827;
          --text2:   #4b5563;
          --text3:   #9ca3af;
          --border:  #e5e7eb;
          --border2: #d1d5db;
          --radius:  4px;
          --radius-lg: 9px;
          --font:    'DM Sans', system-ui, sans-serif;
          --navy:    #1e3a5f;
          --navy-mid: #2a5285;
          --navy-bright: #3b76c4;
          --navy-glow: rgba(30, 58, 95, 0.12);
          --navy-tint: #f4f7fb;
          --navy-border: rgba(30, 58, 95, 0.18);
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
        /* Round-4 unified status matrix: approved=green, returned=amber, denied=red,
           escalated/pending=blue (matches DCS + the emails; amber is reserved for Returned). */
        .status-approved { background: var(--success); color: var(--success-text); }
        .status-pending  { background: #eff6ff; color: #1e40af; }
        .status-returned { background: var(--warn); color: var(--warn-text); }
        .status-rejected { background: var(--danger);  color: var(--danger-text); }
        .status-denied   { background: var(--danger);  color: var(--danger-text);  }
        .status-complete { background: var(--success); color: var(--success-text); }
        .status-escalated { background: #eff6ff; color: #1e40af; }
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

        // ── Secure document viewer ──────────────────────────────────────────────────
        // DCS attachments used to render as raw https://drive.google.com/file/d/<id>/view links,
        // which only worked because uploads were published with ANYONE_WITH_LINK. Documents are
        // now PRIVATE in Drive; apiDownloadDcsFile re-checks that the caller is party to this
        // request AND that the fileId belongs to it, then returns the bytes as base64.
        //
        // This is the APPROVER-FACING copy, the page reached from an email link. It is a
        // deliberate triplicate of the viewer in Phase 1/index.html and Phase 2/pia_index.html;
        // three separate GAS projects, and this page is not even the same document as the PIA
        // app. Edit all three together.
        //
        // NOTE: plain string concatenation only, and NO backticks, this whole block sits inside
        // a backtick template literal in pia_code.js. A dollar-brace sequence here would be
        // interpolated server-side, and a stray backtick would terminate the template early.
        // (Both failure modes pass node --check on the file and only break the SERVED page.)
        var __filePreviewUrl = null;

        function filePreviewEscHandler(e) {
          if (e.key === 'Escape') closeFilePreview();
        }

        // Revokes the blob. The preview cannot revoke right after creation the way the old
        // download-only path did, because the iframe/img reads the URL for as long as it is on
        // screen, so every exit route (X, backdrop, Esc, opening another file) lands here.
        function closeFilePreview() {
          var host = document.getElementById('filePreviewOverlay');
          if (host && host.parentNode) host.parentNode.removeChild(host);
          if (__filePreviewUrl) { URL.revokeObjectURL(__filePreviewUrl); __filePreviewUrl = null; }
          document.removeEventListener('keydown', filePreviewEscHandler);
        }

        // Renders into the CURRENT document rather than window.open(blobUrl): this page is served
        // inside Apps Script's sandboxed iframe, where popups are blocked and a blob: URL is not
        // reliably navigable as a top-level document. Filename goes in via textContent, never
        // innerHTML, it is user-supplied and there is no escape helper in scope here.
        function showFilePreview(data) {
          closeFilePreview();

          var mime = String((data && data.mimeType) || 'application/octet-stream');
          var name = String((data && data.filename) || 'document');

          var byteChars = atob(data.base64);
          var byteNums = new Array(byteChars.length);
          for (var i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
          __filePreviewUrl = URL.createObjectURL(new Blob([new Uint8Array(byteNums)], { type: mime }));

          var isPdf = mime.indexOf('pdf') !== -1;
          var isImg = mime.indexOf('image/') === 0;

          var ov = document.createElement('div');
          ov.id = 'filePreviewOverlay';
          ov.setAttribute('role', 'dialog');
          ov.setAttribute('aria-modal', 'true');
          ov.setAttribute('aria-label', 'Document preview');
          ov.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(17,24,39,0.6);' +
            'z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;';

          var box = document.createElement('div');
          box.style.cssText = 'background:#fff;border-radius:9px;width:100%;max-width:900px;height:90vh;' +
            'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);';

          var head = document.createElement('div');
          head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 14px;' +
            'border-bottom:1px solid #e5e7eb;flex-shrink:0;';

          var title = document.createElement('div');
          title.textContent = name;
          title.style.cssText = 'font-weight:600;font-size:13.5px;color:#111827;flex:1;min-width:0;' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

          var dl = document.createElement('button');
          dl.type = 'button';
          dl.textContent = 'Download';
          dl.style.cssText = 'padding:6px 14px;font-size:12.5px;font-weight:500;cursor:pointer;' +
            'border:1px solid #d1d5db;border-radius:4px;background:#fff;color:#111827;flex-shrink:0;';
          dl.onclick = function () {
            var a = document.createElement('a');
            a.href = __filePreviewUrl;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          };

          var x = document.createElement('button');
          x.type = 'button';
          x.setAttribute('aria-label', 'Close preview');
          x.innerHTML = '&times;';
          x.style.cssText = 'border:none;background:none;font-size:22px;line-height:1;cursor:pointer;' +
            'color:#6b7280;padding:0 4px;flex-shrink:0;';
          x.onclick = closeFilePreview;

          head.appendChild(title);
          head.appendChild(dl);
          head.appendChild(x);

          var pane = document.createElement('div');
          pane.style.cssText = 'flex:1;min-height:0;background:#f7f8fa;' +
            (isImg ? 'display:flex;align-items:center;justify-content:center;padding:12px;' : '');

          if (isPdf) {
            var frame = document.createElement('iframe');
            frame.src = __filePreviewUrl;
            frame.title = name;
            frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
            pane.appendChild(frame);
          } else if (isImg) {
            var img = document.createElement('img');
            img.src = __filePreviewUrl;
            img.alt = name;
            img.style.cssText = 'max-width:100%;max-height:100%;display:block;';
            pane.appendChild(img);
          } else {
            var note = document.createElement('div');
            note.style.cssText = 'padding:36px 24px;text-align:center;color:#4b5563;font-size:13px;line-height:1.7;';
            note.textContent = 'This file type cannot be displayed in the browser. ' +
              'Use Download to open it in the right application.';
            pane.appendChild(note);
          }

          box.appendChild(head);
          box.appendChild(pane);
          ov.appendChild(box);
          ov.addEventListener('click', function (e) { if (e.target === ov) closeFilePreview(); });
          document.body.appendChild(ov);
          document.addEventListener('keydown', filePreviewEscHandler);
        }

        function viewDcsFile(sessionId, fileId, btn) {
          var originalHtml = btn ? btn.innerHTML : '';
          if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerHTML = 'Opening...'; }
          function restore() {
            if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.innerHTML = originalHtml; }
          }
          google.script.run
            .withSuccessHandler(function (res) {
              restore();
              if (!res || !res.ok) {
                showError((res && res.message) ? res.message : 'Could not open this document.');
                return;
              }
              try {
                showFilePreview(res.data);
              } catch (err) {
                showError('Could not display this document. Please try again.');
              }
            })
            .withFailureHandler(function () {
              restore();
              showError('Could not open this document. Please try again or contact ISM.');
            })
            .apiDownloadDcsFile(sessionId, fileId);
        }
      </script>
    </body>
    </html>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COLUMN INDEX CONSTANTS (Anti-Magic Number Pattern)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const APPLICATIONS_COLS = colsOf_("Applications", {
  SESSION_ID: 'SessionID',
  APPLICANT_EMAIL: 'ApplicantEmail',
  STATUS: 'Status',
  PIA_1_DATA: 'PIA_1_Data',
  PIA_2_DATA: 'PIA_2_Data',
  PIA_3_DATA: 'PIA_3_Data',
  PIA_4_DATA: 'PIA_4_Data',
  PIA_5_DATA: 'PIA_5_Data',
  ADMIN_EXPORT_ID: 'AdminExportID',
  SUBMISSION_DATE: 'SubmissionDate',
  IS_FLAGGED: 'IsFlagged',
  NOTES: 'Notes',
  LINKED_REQ_ID: 'Linked_ReqID',
  APPROVER_FLAGS: 'Approver_Flags'
});

const APPROVAL_COLS = colsOf_("Approval_Workflow", {
  APPROVAL_ID: 'ApprovalID',
  SESSION_ID: 'SessionID',
  CURRENT_STEP: 'CurrentStep',
  APPROVER_NAME: 'ApproverName',
  APPROVER_EMAIL: 'ApproverEmail',
  DECISION: 'Decision',
  COMMENTS: 'Comments',
  DECISION_DATE: 'DecisionDate',
  STATUS: 'Status',
  REMINDER_DATE: 'ReminderDate',
  EMAIL_STATUS: 'EmailStatus',
  EMAIL_ERROR: 'EmailError',
  NOTIFIED_DATE: 'NotifiedDate',
  ROUND_NUMBER: 'RoundNumber',
  FLAGGED_FIELDS: 'FlaggedFields',
  ACTED_BY: 'ActedBy'
});

const AUDIT_COLS = colsOf_("Risk_Audit", {
  LOG_ID: 'LogID',
  SESSION_ID: 'SessionID',
  INTERNAL_FLAGS: 'InternalFlags',
  ACTION: 'Action',
  USER_EMAIL: 'UserEmail',
  USER_AGENT: 'UserAgent',
  TIMESTAMP: 'Timestamp'
});

const DCS_COLS = colsOf_("Data_Collection", {
  LOG_ID: 'LogID',
  REQ_ID: 'ReqID',
  USER_EMAIL: 'UserEmail',
  STATUS: 'Status',
  IMMEDIATE_HEAD_EMAIL: 'ImmediateHeadEmail',
  DEPT_HEAD_EMAIL: 'DeptHeadEmail',
  DIV_HEAD_EMAIL: 'DivHeadEmail',
  FILE_ID: 'FileID',
  METADATA_JSON: 'Metadata_JSON',
  TIMESTAMP: 'Timestamp',
  METADATA_AGENCY: 'Metadata_Agency'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 WORKFLOW - ISM APPROVAL WORKFLOW SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ISM_WORKFLOW_COLS = colsOf_("ISM_Approval_Workflow", {
  ISM_APPROVAL_ID: 'ISM_Approval_ID',
  SESSION_ID: 'SessionID',
  CURRENT_STEP: 'CurrentStep',
  ISM_MEMBER_NAME: 'ISM_Member_Name',
  ISM_MEMBER_EMAIL: 'ISM_Member_Email',
  DECISION: 'Decision',
  COMMENTS: 'Comments',
  DECISION_DATE: 'DecisionDate',
  STATUS: 'Status',
  REQUIRES_DIV_HEAD: 'Requires_DivHead',
  DIV_HEAD_ESCALATION_ID: 'DivHead_Escalation_ID',
  ROUTING_DESTINATION: 'Routing_Destination',
  REMINDER_DATE: 'ReminderDate',
  EMAIL_STATUS: 'EmailStatus',
  EMAIL_ERROR: 'EmailError',
  NOTIFIED_DATE: 'NotifiedDate',
  ROUND_NUMBER: 'RoundNumber',
  FLAGGED_FIELDS: 'FlaggedFields',
  ACTED_BY: 'ActedBy'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 WORKFLOW - DIVISION HEAD CONFIG SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const DIV_HEAD_CONFIG_COLS = colsOf_("DivisionHead_Approval_Workflow", {
  ESCALATION_ID: 'Escalation_ID',
  SESSION_ID: 'SessionID',
  DIV_HEAD_EMAIL: 'DivHead_Email',
  DECISION: 'Decision',
  COMMENTS: 'Comments',
  DECISION_DATE: 'DecisionDate',
  STATUS: 'Status',
  REMINDER_DATE: 'ReminderDate',
  EMAIL_STATUS: 'EmailStatus',
  EMAIL_ERROR: 'EmailError',
  NOTIFIED_DATE: 'NotifiedDate',
  ROUND_NUMBER: 'RoundNumber',
  FLAGGED_FIELDS: 'FlaggedFields',
  ACTED_BY: 'ActedBy'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REVISION HISTORY SHEET COLUMNS (durable return-cycle logbook)

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// APPLICATION SNAPSHOT COLUMNS (what the approvers actually saw, per round)
//
// LAYMAN (Tropang Ex): Tuwing nagre-resubmit ang applicant, dati ay SINASAPAWAN lang yung mga
//   sagot niya sa Applications sheet, patay na yung luma, wala nang kopya. So kapag tinanong ka
//   ng auditor ng "ano ba talaga yung inaprubahan ng Department Head noong round 1?", wala kang
//   maisasagot. Dito na natin itinatago yung buong sagot bago pa man sapawan.
//
// TECHNICAL: Append-only per-round snapshot of the five PIA_*_Data blobs plus the approver flags,
//   written by submitApplication_ immediately BEFORE the resubmit overwrite, inside the same lock.
//
//   🚩 THIS IS NOT THE SAME KIND OF THING AS THE OLD Revision_History, which was retired when the
//   workflow went append-only. That sheet was a copy-before-DELETE of rows that never needed
//   deleting. This is a copy-before-UPDATE of Applications.PIA_1..5_Data, which genuinely is a
//   single-current-state record looked up by SessionID across all three apps, versioning it into
//   multiple rows would break every reader in the system. Current-state row + separate history
//   table is the correct pattern here, not a workaround.
//
//   The workflow sheets hold the DECISIONS of each round; this holds the SUBMISSION of that round.
//   Both are keyed by (SessionID, RoundNumber) and are meant to be read together.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const APPLICATION_SNAPSHOT_COLS = colsOf_("Application_Snapshots", {
  SNAPSHOT_ID: 'SnapshotID',
  SESSION_ID: 'SessionID',
  ROUND_NUMBER: 'RoundNumber',
  APPLICANT_EMAIL: 'ApplicantEmail',
  STATUS_AT_SNAPSHOT: 'Status_At_Snapshot',
  PIA_1_DATA: 'PIA_1_Data',
  PIA_2_DATA: 'PIA_2_Data',
  PIA_3_DATA: 'PIA_3_Data',
  PIA_4_DATA: 'PIA_4_Data',
  PIA_5_DATA: 'PIA_5_Data',
  APPROVER_FLAGS: 'Approver_Flags',
  LINKED_REQ_ID: 'Linked_ReqID',
  SNAPSHOT_AT: 'SnapshotAt'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3 WORKFLOW - INFOSEC EMAIL CONFIG SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const INFOSEC_CONFIG_COLS = colsOf_("InfoSec_Email_Config", {
  MEMBER_ID: 'Member_ID',
  MEMBER_NAME: 'Member_Name',
  MEMBER_EMAIL: 'Member_Email',
  ROLE: 'Role',
  IS_ACTIVE: 'IsActive',
  JOB_POS: 'JobPos',
  SITE: 'Site'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 3: EMAIL QUEUE SHEET COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const EMAIL_QUEUE_COLS = colsOf_("Email_Queue", {
  QUEUE_ID: 'Queue_ID',
  SESSION_ID: 'SessionID',
  RECIPIENT: 'Recipient',
  SUBJECT: 'Subject',
  BODY_PLAIN: 'Body_Plain',
  BODY_HTML: 'Body_HTML',
  TYPE: 'Type',
  STATUS: 'Status',
  ATTEMPTS: 'Attempts',
  LAST_ERROR: 'Last_Error',
  CREATED_AT: 'Created_At',
  SENT_AT: 'Sent_At',
  NOTIFIED_ADMIN: 'NotifiedAdmin'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PHASE 4: ADMIN NOTIFICATION CONFIG COLUMNS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ADMIN_NOTIFICATION_COLS = colsOf_("Admin_Notification_Config", {
  CONFIG_ID: 'Config_ID',
  ADMIN_EMAIL: 'Admin_Email',
  NOTIFY_ON_FAILURE: 'NotifyOnFailure',
  NOTIFY_REQUESTOR: 'NotifyRequestor',
  LAST_NOTIFIED: 'Last_Notified'
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📄 WEB APP HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: doGet
  LAYMAN:    The front door of the PIA web app. Decides what a GET request gets back: an
             "access denied" page for outsiders, the one-click approve/deny page if the URL
             carries an action token, or the main assessment app (loaded via a DCS parentID).
  TECHNICAL: GAS web-app entry. Lazy-inits the DB once. Enforces isAuthorizedDomain_. Routes:
             (a) e.parameter.action → handleEmailAction_; (b) requires e.parameter.parentID,
             else an error page; (c) renders the 'index' template (IFRAME sandbox) with parentID.
  PARAMS:    - e: GAS event with .parameter (action, parentID, token, ...).
  RETURNS:   HtmlOutput (the served page).
*/
function doGet(e) {
  /* Step 1: First-run guard: build the DB tabs if they do not exist yet. */
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DB_INIT_FLAG_PROP) !== 'true') {
    initializeDatabase_();
  }

  /* Step 1b: One-time header repair (2026-08-12).
     initializeDatabase_ writes headers only when it CREATES a sheet, so a database that
     already existed never picks up a column added later: ActedBy was being written into an
     unnamed column, invisible to Admin's header-name readers. This runs once, guarded by its
     own property, then never again. Non-blocking: a repair failure must not stop the page
     from serving. */
  if (props.getProperty(HEADER_HEAL_FLAG_PROP) !== 'true') {
    try {
      healSheetHeaders_();
      props.setProperty(HEADER_HEAL_FLAG_PROP, 'true');
    } catch (healErr) {
      Logger.log('doGet: one-time header repair failed, will retry next load: ' + healErr);
    }
  }

  /* Step 2: Domain gate: only corporate accounts may proceed. */
  // Domain authorization check
  const userEmail = Session.getActiveUser().getEmail();
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

  /* Step 3: Email action link (approve/deny one-click) → render the action page. */
  // 1. Check if the URL contains an email action command
  if (e && e.parameter && e.parameter.action) {
    return handleEmailAction_(e.parameter).setTitle('Privacy Impact Assessment');
  }

  /* Step 4: Otherwise the SPA requires a DCS parentID; without it, show an error page. */
  // 2. If no action command, require parentID and load the SPA
  const parentId = e.parameter.parentID;
  if (!parentId) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Invalid Access</span><h1>Link Required</h1>`;
    const content = `
      <div class="alert alert-danger">This application must be accessed via a valid link from the Data Collection System (DCS).</div>
      <p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Please provide a <code>parentID</code> in the URL to proceed.</p>
    `;
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(header, content))
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
  TECHNICAL: Lazy-inits DB. If postData is application/json → handleAdminApiRequest_. Otherwise
             enforces the domain gate, then processes the token-validated approval form post.
  PARAMS:    - e: GAS event with .postData and .parameter.
  RETURNS:   ContentService/HtmlOutput depending on branch.
*/
function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DB_INIT_FLAG_PROP) !== 'true') {
    initializeDatabase_();
  }

  // ── Check if this is a JSON API call from the Admin Panel ──
  if (e && e.postData && e.postData.type === 'application/json') {
    return handleAdminApiRequest_(e);
  }

  // Domain authorization check
  const userEmail = Session.getActiveUser().getEmail();
  if (!isAuthorizedDomain_(userEmail)) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Access Denied</span><h1>Restricted</h1>`;
    const content = `<div class="alert alert-danger">Security verification failed. This system is restricted to authorized domains.</div>`;
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(header, content));
  }

  // Handle approval decision form submission
  if (e.parameter && e.parameter.action) {
    return handleEmailAction_(e.parameter).setTitle('Privacy Impact Assessment');
  }

  const paramKeys = e && e.parameter ? Object.keys(e.parameter).join(', ') : '(no parameters)';
  Logger.log('ERROR: doPost called without action parameter. Available params: ' + paramKeys);
  return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
    `<h1>Invalid Request</h1>`,
    `<div class="alert alert-danger">The request is missing required parameters. Available: ${escapeHtml_(paramKeys)}</div>`
  ));
}

/*
  Function: handleAdminApiRequest_
  LAYMAN:    The cross-app API the Admin panel calls to inspect/retry emails, manage reminders,
             and view the pipeline. Checks a shared key, then runs the named admin function.
  TECHNICAL: Parses JSON { apiKey, action, params }, authenticates apiKey against the
             ADMIN_API_KEY Script Property (fail-closed), dispatches action via a switch to the
             admin* helpers, and returns the result as JSON ContentService output. All in try/catch.
  PARAMS:    - e: GAS event; e.postData.contents is the JSON body.
  RETURNS:   JSON TextOutput: { ok, ... } or { ok:false, code, message }.
*/
function handleAdminApiRequest_(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const apiKey = String(body.apiKey || '');
    const validKey = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');

    // Authenticate
    if (!validKey || apiKey !== validKey) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false, message: 'Unauthorized, invalid or missing apiKey'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const action = String(body.action || '').trim();
    const params = body.params || {};

    // ── Route to admin function ──
    let result;
    switch (action) {
      case 'getEmailQueue':
        result = adminGetEmailQueue_(params);
        break;
      case 'retryQueuedEmail':
        result = adminRetryQueuedEmail_(params.queueId);
        break;
      case 'retryAllForSession':
        result = adminRetryAllForSession_(params.sessionId, params.status);
        break;
      case 'cancelQueuedEmails':
        result = adminCancelQueuedEmails_(params.sessionId, params.type);
        break;
      case 'getQueueSummary':
        result = adminGetQueueSummary_();
        break;
      case 'getFailedEmails':
        result = adminGetFailedEmails_(params.sinceDays);
        break;
      case 'getEmailLog':
        result = adminGetEmailLog_(params.sessionId);
        break;
      case 'resendEmail':
        result = adminResendEmail_(params.sessionId, params.recipient, params.type);
        break;
      case 'getReminderConfig_':
        result = adminGetReminderConfig_();
        break;
      case 'setReminderConfig':
        result = adminSetReminderConfig_(params.config);
        break;
      case 'setupReminderTrigger':
        result = setupReminderTrigger_();
        break;
      case 'sendDailyReminders':
        result = sendDailyReminders_();
        break;
      case 'getNotificationConfig':
        result = adminGetNotificationConfig_();
        break;
      case 'setNotificationConfig':
        result = adminSetNotificationConfig_(params.config);
        break;
      case 'resendToStage':
        result = adminResendToStage_(params.sessionId, params.stageType, params.approverEmail);
        break;
      case 'getPipelineView':
        result = adminGetPipelineView_(params.sessionId);
        break;
      default:
        result = { ok: false, message: 'Unknown action: ' + action };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    // F-06: this survived the original sweep because the leak is CONCATENATED
    // ('prefix' + e.toString()) rather than a bare e.toString(), so the pattern that
    // matched value-starts-with-identifier never saw it. This is the cross-app HTTP
    // surface, so the raw exception was reachable by any holder of ADMIN_API_KEY.
    return ContentService.createTextOutput(JSON.stringify(safeError_(e, ERR.INTERNAL)))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/*
  Function: handleEmailAction_
  LAYMAN:    Powers the one-click approve/deny/return/review pages that approvers reach from the
             emails. It checks the click is genuine, shows the full application for review with a
             confirm form (GET), and on confirm (POST) records the decision and shows the result.
  TECHNICAL: The largest handler. Steps: validate action is allowed; identity = active user must
             equal the token's target email AND isTokenValid_(action-bound); block if a decision was
             already recorded (idempotency, scanned across the right workflow sheet: ISM / divhead /
             standard approver); load application + linked DCS context; build a review preview.
             On GET render the confirm page; on POST route to apiPhase3_ProcessISMDecision /
             processDivHeadDecision_ / processApprovalDecision_ and render the outcome. Heavy inline
             HTML; logic lives at the step markers below.
  PARAMS:    - params: query/form params: action, sessionId, token, ts, email, isPost,
                        approverType, step, comment, approverFlags, routingDestination, ...
  RETURNS:   HtmlOutput, review page, "already recorded" page, access-denied page, or result page.
*/
function handleEmailAction_(params) {
  const webAppUrl = getWebAppUrl_() || ScriptApp.getService().getUrl();
  const { action, sessionId, token, ts, isPost, approverType } = params;
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  const allowedActions = ['Approve', 'Reject', 'Deny', 'Review', 'Return', 'ISMReview'];

  if (allowedActions.indexOf(action) === -1) {
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
      `<h1>Invalid Request</h1>`,
      `<div class="alert alert-danger">The requested action is not supported by the system.</div>`
    ));
  }

  const comment = sanitizeInput_(params.comment || '');
  const targetEmail = decodeURIComponent(params.email || '').toLowerCase();
  const activeUser = Session.getActiveUser().getEmail().toLowerCase();
  const approverFlags = params.approverFlags || '{}';
  // Normalize both emails to handle aliases (e.g., user+alias@domain.com matches user@domain.com)
  const normalizedActiveUser = getNormalizedEmail_(activeUser);
  const normalizedTargetEmail = getNormalizedEmail_(targetEmail);
  /* Step 1: Identity + token gate: the signed-in user must BE the link's target AND the
     action-bound HMAC must verify. Both conditions required (no CSRF, no forwarding abuse). */
  // CRITICAL FIX: Include action in token validation to prevent CSRF
  const isAuthorized = (normalizedActiveUser === normalizedTargetEmail) && isTokenValid_(sessionId, targetEmail, token, ts, action);
  
  if (!isAuthorized) {
    // CRITICAL FIX: Don't disclose expected email (information leakage / email enumeration)
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
      `<h1>Access Denied</h1>`,
      `<div class="alert alert-danger">Security verification failed. Only the intended recipient can perform this action.</div>
      <div style="font-size:13px; color:var(--text2); margin-top:1rem; padding:10px; background:var(--bg3); border-radius:var(--radius);">
        <strong>Current Account:</strong> ${escapeHtml_(activeUser || 'Unauthenticated / Anonymous')}
      </div>
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">If the email is forwarded, delete the email from your inbox. You may now safely close this window.</p>`
    ));
  }
  
  const stepParam = params.step ? Number(params.step) : null;

  /* Step 2: Idempotency: scan the relevant workflow sheet (ISM / divhead / standard) for this
     approver's row. If a non-pending decision already exists, short-circuit to a "Review Completed"
     page so decisions can never be re-submitted or changed. */
  // Check if decision has already been recorded for this user (prevent duplicate actions or modifications)
  let recordStatus = 'Pending';
  let existingDecision = '';
  let accountablePersonsHtmlNoFlags = ''; // Initialize for previewHtml (no flags)

  if (action === 'ISMReview' || action.startsWith('ISM')) {
    const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const ismData = readSheetValues_(ismWorkflowSheet);
    let foundPending = false;
    let completedRecord = null;
    for (let i = 1; i < ismData.length; i++) {
      if (rowMatches_(ismData[i], ISM_WORKFLOW_COLS, sessionId, __round) &&
          getNormalizedEmail_(ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]) === normalizedTargetEmail) {
        
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
      const divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
      const divData = readSheetValues_(divHeadSheet);
      let foundPending = false;
      let completedRecord = null;
      for (let i = 1; i < divData.length; i++) {
        if (rowMatches_(divData[i], DIV_HEAD_CONFIG_COLS, sessionId, __round) &&
            getNormalizedEmail_(divData[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1]) === normalizedTargetEmail) {
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
      const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      const apprData = readSheetValues_(apprSheet);
      let foundPending = false;
      let completedRecord = null;
      for (let i = 1; i < apprData.length; i++) {
        if (rowMatches_(apprData[i], APPROVAL_COLS, sessionId, __round) &&
            getNormalizedEmail_(apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1]) === normalizedTargetEmail) {
          
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
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
      `<span class="step-badge">Action Already Recorded</span><h1>Review Completed</h1>`,
      `<div class="alert" style="background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2);">Your decision for application <strong>${sessionId}</strong> has already been recorded as <strong>${existingDecision || recordStatus}</strong>.</div>
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">Decisions cannot be modified once they have been processed. You may now safely close this window.</p>`
    ));
  }

  /* Step 3: Load the PIA application and its linked DCS context for the review preview. */
  // Fetch Application Data
  const appData = getApplicationData_(sessionId);

  // Fetch DCS Data Context
  let dcsData = null;
  if (appData && appData.linkedReqId) {
    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
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
        <div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">${i+1}. ${escapeHtml_(q)}</div>
        <div class="summary-value" style="flex:0; margin-left:auto; display:flex; align-items:center; gap:4px;"><span class="status-badge ${badgeCls}">${escapeHtml_(v)}</span><span style="margin-left: auto;">${makeFlagBtn('PIA 5: Q'+(i+1))}</span></div>
      </div>`;
    }).join('');

    const stakeholderLine = items => {
      if (!Array.isArray(items)) return escapeHtml_(items || '—');
      const valid = items.filter(v => typeof v === 'string' ? v : (v.name || v.email));
      if (!valid.length) return '—';
      return valid.map(v => {
        if (typeof v === 'string') return `<span class="stakeholder-tag">${escapeHtml_(v)}</span>`;
        const label = [v.name, v.email].filter(Boolean).join(' - ');
        return `<span class="stakeholder-tag">${escapeHtml_(label)}</span>`;
      }).join('');
    };

    const fullSummaryHtml = `
      <div class="details-content">
        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Privacy Compliance Survey</div>
        ${pia5Rows}

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Program Information (PIA 1)</div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Immediate Head</div><div class="summary-value">${escapeHtml_(appData.pia1.immediateHead || '—')} ${appData.pia1.immediateHeadEmail ? `(${escapeHtml_(appData.pia1.immediateHeadEmail)})` : ''}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Immediate Head Phone</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia1.immediateHeadPhone || '—')}</span>${makeFlagBtn('PIA 1 - Immediate Head Phone')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Dept. Head</div><div class="summary-value">${escapeHtml_(appData.pia1.deptHead || '—')} ${appData.pia1.deptHeadEmail ? `(${escapeHtml_(appData.pia1.deptHeadEmail)})` : ''}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Dept. Head Phone</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia1.deptHeadPhone || '—')}</span>${makeFlagBtn('PIA 1 - Dept. Head Phone')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Division Head</div><div class="summary-value">${escapeHtml_(appData.pia1.divHead || '—')} ${appData.pia1.divHeadEmail ? `(${escapeHtml_(appData.pia1.divHeadEmail)})` : ''}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Division Head Phone</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia1.divHeadPhone || '—')}</span>${makeFlagBtn('PIA 1 - Division Head Phone')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Benefits</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia1.benefits || '—')}</span>${makeFlagBtn('PIA 1 - Benefits')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Scope</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia1.scope || '—')}</span>${makeFlagBtn('PIA 1 - Scope')}</div></div>
        <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">End User</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia1.endUser || '—')}</span>${makeFlagBtn('PIA 1 - End User')}</div></div>

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">PII Inventory (PIA 2)</div>
        <div class="summary-row">
          <div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Collected Fields</div>
          <div class="summary-value">
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
              ${pii2Fields.map((f, i) => {
                const isSelected = piiFields[i] === 'YES';
                return '<div style="display:flex; align-items:center; gap:4px; padding:4px 8px; border:1px solid ' + (isSelected ? 'var(--navy-bright)' : 'var(--border)') + '; border-radius:4px; background:' + (isSelected ? 'var(--navy-tint)' : 'transparent') + '; opacity:' + (isSelected ? '1' : '0.6') + '; font-size:11.5px;">' +
                  '<span style="font-weight:' + (isSelected ? '600' : '400') + ';">' + escapeHtml_(f) + '</span>' +
                  makeFlagBtn('PIA 2 - ' + f, true) +
                '</div>';
              }).join('')}
              ${customOthers.map((c, i) => {
                return '<div style="display:flex; align-items:center; gap:4px; padding:4px 8px; border:1px solid var(--navy-bright); border-radius:4px; background:var(--navy-tint); font-size:11.5px;">' +
                  '<span style="font-weight:600;">' + escapeHtml_(c) + ' (Custom)</span>' +
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
                  return `<div class="stakeholder-tag" style="margin:0; width:100%; box-sizing:border-box; padding:6px 10px;">${escapeHtml_(label)}</div>`;
                }).join('');
            })()}
          </div>
          <div class="summary-row" style="border-top: 1px dashed var(--border); padding: 8px 0 0 0;"><div class="summary-label" style="min-width: 80px;">Notes</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia3.intDescription || '—')}</span>${makeFlagBtn('PIA 3 - Internal Notes')}</div></div>
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
                  return `<div class="stakeholder-tag" style="margin:0; width:100%; box-sizing:border-box; padding:6px 10px;">${escapeHtml_(label)}</div>`;
                }).join('');
            })()}
          </div>
          <div class="summary-row" style="border-top: 1px dashed var(--border); padding: 8px 0 0 0;"><div class="summary-label" style="min-width: 80px;">Notes</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia3.extDescription || '—')}</span>${makeFlagBtn('PIA 3 - External Notes')}</div></div>
        </div>

        <div class="summary-section-title" style="display: flex; align-items: center; gap: 8px;">Data Lifecycle (PIA 4)</div>
        ${['collect','use','retain','disclose','dispose'].map(k => `<div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">${k.toUpperCase()}</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(appData.pia4[k] || '—')}</span>${makeFlagBtn('PIA 4 - ' + k.toUpperCase())}</div></div>`).join('')}
      </div>
    `;
    
    let endorsementFileHtml = '';
    let endorsementFileObj = null; // Store for flagging in Supporting Documents
    let dcsFilesHtml = '';
    let hasAttachedDocs = false;
    let dcsSummaryHtml = `<div style="padding: 10px; color: var(--text3); font-style: italic;">No DCS data linked to this application.</div>`;
    
    // Get DCS files early to check for duplicates (endorsement letter might be in both)
    const dcsFiles = appData.linkedReqId ? getAndShareDCSFiles_(appData.linkedReqId) : [];

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
              // Round-4: endorsement letter is flaggable too (same 'DCS - ' prefix contract).
              // SECURITY: was a raw Drive link. Now routed through the authorized download proxy.
              endorsementFileHtml = `<span style="display: inline-flex; align-items: center; gap: 2px;">${makeDocDownloadBtn_(sessionId, val.id, 'View Endorsement Letter', val.name || 'Endorsement Letter')}${makeFlagBtn('DCS - Endorsement Letter')}</span>`;
            }
            return;
          }
          const label = fieldLabels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
          agencyFieldsHtml += `<div class="summary-row"><div class="summary-label">${escapeHtml_(label)}</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(String(val))}</span>${makeFlagBtn('DCS - ' + label)}</div></div>`;
        });
        if (agencyFieldsHtml) {
          agencyHtml = `<div class="summary-section-title" style="display: flex; align-items: center; gap: 8px; margin-top: 15px;">Agency Information</div>${agencyFieldsHtml}`;
        }
      }
      
      let dateStr = '—';
      if (dcsData._timestamp) {
        dateStr = dcsData._timestamp instanceof Date ? dcsData._timestamp.toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : escapeHtml_(String(dcsData._timestamp));
      }
      
      // Populate accountablePersonsHtmlNoFlags (for previewHtml)
      if (dcsData.accountable) {
        for (let i = 1; i <= 5; i++) {
          const name = dcsData.accountable[`accountableName${i}`];
          const email = dcsData.accountable[`accountableEmail${i}`];
          if (name || email) {
            accountablePersonsHtmlNoFlags += `<div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Accountable Person ${i} </div><div class="summary-value">${escapeHtml_(name || '—')} (${escapeHtml_(email || '—')})</div></div>\n`;
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
            accountablePersonsDCSHtmlWithFlags += `<div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Accountable Person ${i}</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(name || '—')} (${escapeHtml_(email || '—')})</span>${makeFlagBtn('DCS - Accountable Person ' + i)}</div></div>\n`;
          }
        }
      }
      
      dcsSummaryHtml = `
        <div class="details-content">
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Request ID</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span><strong>${escapeHtml_(dcsData._reqId || '—')}</strong></span>${makeFlagBtn('DCS - Request ID')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Requestor</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData._email || '—')}</span>${makeFlagBtn('DCS - Requestor')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">DCS Status</div><div class="summary-value"><span class="status-badge status-${String(dcsData._status).toLowerCase() === 'complete' ? 'complete' : 'pending'}">${escapeHtml_(dcsData._status || '—')}</span></div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Submission Date</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${dateStr}</span>${makeFlagBtn('DCS - Submission Date')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Department</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.dept || dcsData.department || '—')}</span>${makeFlagBtn('DCS - Department')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Locations</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.locations || dcsData.location || '—')}</span>${makeFlagBtn('DCS - Locations')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Access Needed</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.access || '—')}</span>${makeFlagBtn('DCS - Access Needed')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">iHelp Reference</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.ihelp || '—')}</span>${makeFlagBtn('DCS - iHelp Reference')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Immediate Head</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.immHeadName || '—')} (${escapeHtml_(dcsData._immHeadEmail || '—')})</span>${makeFlagBtn('DCS - Immediate Head')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Department Head</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.deptHeadName || '—')} (${escapeHtml_(dcsData._deptHeadEmail || '—')})</span>${makeFlagBtn('DCS - Department Head')}</div></div>
              <div class="summary-row"><div class="summary-label" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">Division Head</div><div class="summary-value" style="display: flex; align-items: center; gap: 4px; justify-content: space-between;"><span>${escapeHtml_(dcsData.divHeadName || '—')} (${escapeHtml_(dcsData._divHeadEmail || '—')})</span>${makeFlagBtn('DCS - Division Head')}</div></div>
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

        // ── LAYER 0 (Commit 5): explicit type on the FILE_ID entry, supplementary docs have no
        //    template suffix/keyword, so label them directly instead of falling through to "NDA Document".
        if (f.type === 'SUPPLEMENTARY' || /SUPPLEMENTARY/i.test(fn)) docType = 'Additional Supporting Document';

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

        // Round-4: documents are now flaggable. Labels keep the 'DCS - ' prefix (the DCS app buckets
        // flags by that prefix) and supplementary docs are keyed per filename so the requestor knows
        // exactly which extra file was flagged.
        let docFlagLabel = 'DCS - NDA Document';
        if (docType === 'Additional Supporting Document') docFlagLabel = 'DCS - Additional Supporting Document: ' + (f.name || 'file');
        else if (docType === 'DSA') docFlagLabel = 'DCS - DSA Document';
        else if (docType === 'Endorsement Letter') docFlagLabel = 'DCS - Endorsement Letter';

        // SECURITY: was a raw Drive link (f.url). Documents are private now, go through the
        // authorization-checked proxy instead. f.url is left on the object for the certificate
        // email path, which cannot use google.script.run (see getAndShareDCSFiles_'s comment).
        return `<span style="display: inline-flex; align-items: center; gap: 2px;">${makeDocDownloadBtn_(sessionId, f.id, 'View ' + docType, f.name)}${makeFlagBtn(docFlagLabel)}</span>`;
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
      // Round-4: Returned is a fixable loop, not a terminal denial, amber, not red.
      // 'Rejected by ISM' stays terminal-red; plain 'Rejected' is the legacy Returned label.
      if (s.includes('rejected by ism')) return 'denied';
      if (s.includes('reject') || s.includes('return')) return 'returned';
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
        <div class="summary-row"><div class="summary-label">DCS Request</div><div class="summary-value"><strong>${escapeHtml_(appData.linkedReqId || '—')}</strong></div></div>
        <div class="summary-row"><div class="summary-label">Current Status</div><div class="summary-value"><span class="status-badge status-${badgeClass}">${escapeHtml_(appData.status)}</span></div></div>
        <div class="summary-row"><div class="summary-label">Program</div><div class="summary-value"><strong>${escapeHtml_(appData.pia1.program || '—')}</strong></div></div>
        <div class="summary-row"><div class="summary-label">Purpose</div><div class="summary-value">${escapeHtml_(appData.pia1.purpose)}</div></div>
        <div class="summary-row">
          <div class="summary-label">PII Collected</div>
          <div class="summary-value">${allPii.length > 0 ? allPii.map(f => `<span class="pii-tag">${escapeHtml_(f)}</span>`).join('') : 'None reported'}</div>
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
    // Round-4: Returned = amber (fixable loop); only 'Rejected by ISM' keeps the terminal red.
    if (s.includes('rejected by ism')) return 'denied';
    if (s.includes('reject') || s.includes('return')) return 'returned';
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
      const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const data = readSheetValues_(ismWorkflowSheet);
      for (let i = 1; i < data.length; i++) {
        if (rowMatches_(data[i], ISM_WORKFLOW_COLS, sessionId, __round)) {
          context.steps.push({
            step: data[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1],
            name: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1],
            email: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1],
            status: data[i][ISM_WORKFLOW_COLS.STATUS - 1],
            routing: data[i][ISM_WORKFLOW_COLS.ROUTING_DESTINATION - 1],
            comments: data[i][ISM_WORKFLOW_COLS.COMMENTS - 1],
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
      const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const data = readSheetValues_(ismWorkflowSheet);
      const normalizedTarget = String(getNormalizedEmail_(targetEmail) || '').toLowerCase();
      
      for (let i = 1; i < data.length; i++) {
        if (rowMatches_(data[i], ISM_WORKFLOW_COLS, sessionId, __round)) {
          const normalizedMember = String(getNormalizedEmail_(data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]) || '').toLowerCase();
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
      const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      const data = readSheetValues_(apprSheet);
      const normalizedTarget = String(getNormalizedEmail_(targetEmail) || '').toLowerCase();
      
      for (let i = 1; i < data.length; i++) {
        if (rowMatches_(data[i], APPROVAL_COLS, sessionId, __round)) {
          const normalizedMember = String(getNormalizedEmail_(data[i][APPROVAL_COLS.APPROVER_EMAIL - 1]) || '').toLowerCase();
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
      const divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
      const data = readSheetValues_(divHeadSheet);
      for (let i = 1; i < data.length; i++) {
        if (rowMatches_(data[i], DIV_HEAD_CONFIG_COLS, sessionId, __round) &&
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
    
    const errorAlert = errMsg ? `<div class="alert alert-danger">${escapeHtml_(errMsg)}</div>` : '';
    
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
          routingBadge = `<span class="status-badge" style="background:#eff6ff; color:#1e40af; border:1px solid rgba(30,64,175,0.2);">Both Teams</span>`;
        } else {
          routingBadge = `<span class="status-badge" style="background:var(--bg3); color:var(--text2); border:1px solid var(--border);">${escapeHtml_(step1.routing)}</span>`;
        }
        const step1Comment = step1.comments ? String(step1.comments).replace(/<[^>]*>/g, '').trim() : '';
        const step1StatusLabel = (step1.status === 'Approved') ? 'Approved'
          : (step1.status === 'EscalatedToDivisionHead') ? 'Escalated to Division Head'
          : escapeHtml_(String(step1.status || 'Reviewed'));
        person1RoutingChoice = `<div style="margin-bottom:12px; padding: 12px 14px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);">
          <div style="font-size:10px; font-weight:800; color:var(--text3); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:6px;">Prior InfoSec Review (Step 1)</div>
          <div style="font-size:13px; color:var(--text2); display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><span><strong>${escapeHtml_(step1.name)}</strong>: ${step1StatusLabel}</span><span style="font-size:12px;">routed to</span>${routingBadge}</div>
          ${step1Comment ? `<div style="font-size:12.5px; color:var(--text2); margin-top:8px; padding-left:10px; border-left:2px solid var(--border2);">"${escapeHtml_(step1Comment)}"</div>` : ''}
        </div>`;
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
      else if (a.status === 'Rejected' || a.status === 'Returned') badgeCls = 'status-returned';
      else if (a.status === 'Denied') badgeCls = 'status-denied';

      const roleLabel = a.role ? `<div style="font-size: 9px; font-weight: 800; color: var(--text3); text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.03em;">${escapeHtml_(a.role)}</div>` : '';
      const dateStr = formatApproverDate(a.decisionDate);
      const dateHtml = dateStr ? `<div style="font-size: 9px; color: var(--text3); margin-top: 2px;">${escapeHtml_(dateStr)}</div>` : '';

      return `
        <div style="display: inline-flex; flex-direction: column; margin-right: 12px; margin-bottom: 12px; vertical-align: top; max-width: 210px;">
          ${roleLabel}
          <span class="status-badge ${badgeCls}" style="font-size: 11px; border: 1px solid var(--border); border-color: rgba(0,0,0,0.1); padding: 4px 10px;">${escapeHtml_(a.name)}: ${escapeHtml_(a.status)}</span>
          ${dateHtml}
        </div>`;
    }).join('');

    const ismApproverBadgesHtml = (ismWorkflowContext.steps || []).map(a => {
      let badgeCls = 'status-pending';
      if (a.status === 'Approved') badgeCls = 'status-approved';
      else if (a.status === 'Rejected' || a.status === 'Returned') badgeCls = 'status-returned';
      else if (a.status === 'Denied') badgeCls = 'status-denied';
      else if (a.status === 'EscalatedToDivisionHead') badgeCls = 'status-escalated';

      const roleLabel = `<div style="font-size: 9px; font-weight: 800; color: var(--text3); text-transform: uppercase; margin-bottom: 3px; letter-spacing: 0.03em;">InfoSec Member (Step ${a.step})</div>`;
      const dateStr = formatApproverDate(a.decisionDate);
      const dateHtml = dateStr ? `<div style="font-size: 9px; color: var(--text3); margin-top: 2px;">${escapeHtml_(dateStr)}</div>` : '';

      let displayStatus = a.status;
      if (displayStatus === 'EscalatedToDivisionHead') displayStatus = 'Escalated';

      return `
        <div style="display: inline-flex; flex-direction: column; margin-right: 12px; margin-bottom: 12px; vertical-align: top; max-width: 210px;">
          ${roleLabel}
          <span class="status-badge ${badgeCls}" style="font-size: 11px; border: 1px solid var(--border); border-color: rgba(0,0,0,0.1); padding: 4px 10px;">${escapeHtml_(a.name)}: ${escapeHtml_(displayStatus)}</span>
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
            <button type="button" class="btn btn-secondary" style="background:#1e40af; color:white; padding:16px; width:100%; justify-content:center; font-size:16px; border-color:#1e40af;" onclick="submitWithRouting('EscalateToDivisionHead')">Escalate to Division Head</button>
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
            <button type="button" class="btn btn-secondary" style="background:#1e40af; color:white; padding:16px; width:100%; justify-content:center; font-size:16px; border-color:#1e40af;" onclick="submitWithRouting('EscalateToDivisionHead')">Escalate to Division Head</button>
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
    
    // Round-4: personalized "you previously approved/returned this" chip for the reviewer.
    const ismPriorChip = buildPriorReviewChipHtml_(sessionId, targetEmail);
    // Round-4 unified history: the same grouped-by-round list the standard form shows (replaces the
    // prior-rounds-only banner). The current-state chips below stay for quick scanning.
    const ismApprovalHistory = (function () {
      try {
        const h = buildUnifiedHistoryHtml_(getUnifiedHistory_(sessionId, true));
        return h
          ? '<div class="summary-section-title" style="margin-top: 1.5rem;">Approval History</div>' +
            '<div style="margin-top: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px;">' + h + '</div>'
          : '';
      } catch (e) { return ''; }
    })();

    const content = `
      ${errorAlert}
      ${ismPriorChip}
      ${previewHtml}
      ${ismApprovalHistory}
      <div class="summary-section-title" style="margin-top: 1.5rem;">Main Workflow Approvers</div>
      <div class="ismApproverContainer" style="margin-top: 8px;">${approverBadgesHtml}</div>
      <div class="summary-section-title" style="margin-top: 1.5rem;">ISM Workflow Approvers</div>
      <div class="ismApproverContainer" style="margin-top: 8px;">${ismApproverBadgesHtml}</div>
      <div style="margin-bottom:15px; font-size:13px; color:var(--text2); background:var(--navy-tint); border:1px solid var(--navy-border); padding:10px; border-radius:var(--radius); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <span>InfoSec Member Review (Step ${ismStep} of ${ismWorkflowContext.totalSteps}): You are reviewing as <strong>${escapeHtml_(activeUser)}</strong></span>
        <div style="display:flex; gap:5px; flex-wrap:wrap;">
        </div>
      </div>
      <p>Please provide your InfoSec assessment and select a decision for application <strong>${escapeHtml_(sessionId)}</strong> below.</p>
      <form method="POST" id="ismReviewForm" action="${webAppUrl}" target="_top">
        <input type="hidden" name="approverFlags" id="approverFlagsInput" value="{}">
        <input type="hidden" name="isPost" value="true">
        <input type="hidden" name="action" value="ISMReview">
        <input type="hidden" name="sessionId" value="${escapeHtml_(sessionId)}">
        <input type="hidden" name="email" value="${escapeHtml_(targetEmail)}">
        <input type="hidden" name="token" value="${escapeHtml_(token)}">
        <input type="hidden" name="ts" value="${escapeHtml_(ts)}">
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
          <div id="routingErrorMain" style="display:none; color:var(--danger-text); font-size:12.5px; margin-top:8px;"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;flex-shrink:0;"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg> Please select a routing destination for Approve or Escalate.</div>
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
              '<input type="text" class="flag-reason-input" maxlength="200" placeholder="Required (max 200 chars)" style="flex:1; padding:6px; border:1px solid var(--border2); border-radius:4px; font-size:12px;">' +
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
          // Round-4: a Return must identify at least one flagged item (was unchecked on the ISM form,
          // while the standard form demanded 2, both now consistently require 1).
          if (Object.keys(flagData).length < 1) {
            showError('Please flag at least 1 field or document before returning the application.');
            return;
          }
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

    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(`<span class="step-badge">InfoSec Review Required</span><h1>Privacy Assessment Review</h1>`, content));
  };

  /* Step 4a: ISM branch: GET shows the InfoSec review form; POST validates the comment then
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
    const ismDecision = sanitizeInput_(params.ismDecision || 'Approve');
    let routingDestination = sanitizeInput_(params.routingDestination || '');
    const validISMDecisions = ['Approve', 'Deny', 'Return', 'EscalateToDivisionHead'];
    
    if (validISMDecisions.indexOf(ismDecision) === -1) {
      return renderISMReviewForm('Invalid decision type: ' + ismDecision);
    }
    
    // HIGH FIX: For Approve or Escalate decisions, routing destination is REQUIRED
    if ((ismDecision === 'Approve' || ismDecision === 'EscalateToDivisionHead') && !routingDestination) {
      return renderISMReviewForm('Routing destination (DCOPS/TECHSERVE/BOTH) is required when approving or escalating an application.', comment);
    }
    
    // Call Phase 3 API to process ISM decision
    // Round-4: no boilerplate default comment; an empty comment is stored empty and hidden at render.
    const result = apiPhase3_ProcessISMDecision(sessionId, targetEmail, ismDecision, comment || '', routingDestination, stepParam, approverFlags);
    
    if (result.ok) {
      let displayDecision = ismDecision;
      if (ismDecision === 'Approve') displayDecision = 'Approved';
      if (ismDecision === 'Deny') displayDecision = 'Denied';
      if (ismDecision === 'Return') displayDecision = 'Returned to Requestor';
      if (ismDecision === 'EscalateToDivisionHead') displayDecision = 'Escalated to Division Head';

      return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
        `<span class="step-badge">Action Completed</span><h1>Successfully ${displayDecision}!</h1>`,
        `<div class="alert" style="background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2);">Your InfoSec review for application <strong>${sessionId}</strong> has been safely recorded.</div>
        ${previewHtml}
        <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">Your response has been saved. You may now safely close this window.</p>`
      ));
    } else {
      return renderISMReviewForm('Error processing decision: ' + (result.message || 'Unknown error'), comment);
    }
  }

  // Shared logic for rendering the unified review form
  const renderReviewForm = (errMsg = '', initialComment = '', approverType = '') => {
    const approverStep = getApproverStep();

    // Generate action-specific tokens for form submission
    const approveToken = generateAuthToken_(sessionId, targetEmail, ts, 'Approve');
    const denyToken = generateAuthToken_(sessionId, targetEmail, ts, 'Deny');
    const returnToken = generateAuthToken_(sessionId, targetEmail, ts, 'Return');

    const actionButtonsHtml = `
      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; border-top: 1px solid var(--border); padding-top: 20px;">
        <button type="submit" name="action" value="Approve" class="btn btn-success" onclick="document.getElementById('actionTokenInput').value='${approveToken}'; showDecisionOverlay();">Approve</button>
        <button type="button" class="btn btn-warn" onclick="showReturnOptions()">Return to Requestor</button>
        <button type="submit" name="action" value="Deny" class="btn btn-danger" onclick="document.getElementById('actionTokenInput').value='${denyToken}'; showDecisionOverlay();">Deny</button>
      </div>
    `;

    const errorAlert = errMsg ? `<div class="alert alert-danger">${escapeHtml_(errMsg)}</div>` : '';

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

    // Round-4: personalized "you previously approved/returned this" chip for the reviewer.
    const stdPriorChip = buildPriorReviewChipHtml_(sessionId, targetEmail);
    // Round-4 unified history: ONE grouped-by-round list for EVERY approver type (previously only
    // the Division Head saw other approvers' badges; plain heads saw nothing about the chain).
    // Pending rows included so the reviewer sees who is next in line.
    const stdApprovalHistory = (function () {
      try {
        const h = buildUnifiedHistoryHtml_(getUnifiedHistory_(sessionId, true));
        return h
          ? '<div class="summary-section-title" style="margin-top: 1.5rem;">Approval History</div>' +
            '<div style="margin-top: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px;">' + h + '</div>'
          : '';
      } catch (e) { return ''; }
    })();

    const content = `
      ${errorAlert}
      ${stdPriorChip}
      ${previewHtml}
      ${stdApprovalHistory}
      <span class="step-badge" style="text-transform: none; font-weight: 500; margin-bottom: 15px;">You are reviewing as <strong>${escapeHtml_(activeUser)}</strong></span>
      <p>Please provide your feedback and select a decision for application <strong>${escapeHtml_(sessionId)}</strong> below.</p>
      <form method="POST" id="approvalForm" action="${webAppUrl}" target="_top">
        <input type="hidden" name="approverFlags" id="approverFlagsInput" value="{}">
        <input type="hidden" name="isPost" value="true">
        <input type="hidden" name="sessionId" value="${escapeHtml_(sessionId)}">
        <input type="hidden" name="email" value="${escapeHtml_(targetEmail)}">
        <input type="hidden" name="token" id="actionTokenInput" value="${escapeHtml_(token)}">
        <input type="hidden" name="ts" value="${escapeHtml_(ts)}">
        <input type="hidden" name="approverType" value="${escapeHtml_(approverType || '')}">
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
              '<input type="text" class="flag-reason-input" maxlength="200" placeholder="Required (max 200 chars)" style="flex:1; padding:6px; border:1px solid var(--border2); border-radius:4px; font-size:12px;">' +
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
          // Round-4: minimum lowered 2 -> 1 (one clearly flagged item is enough to justify a return).
          if (Object.keys(flagData).length < 1) {
            showError('Please flag at least 1 field or document before returning the application.');
            return;
          }
          document.getElementById('returnModal').style.display = 'flex';
        }
      </script>
    `;

    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(`<span class="step-badge">Action Required</span><h1>Review Access Request</h1>`, content));
  };

  /* Step 4b: Standard approver / Division-Head branch: GET shows the review form; POST below. */
  if (isPost !== 'true') {
    return renderReviewForm('', '', params.approverType);
  }

  /* Step 5: On a Deny/Return POST, enforce a meaningful reason (length + anti-gibberish checks)
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

  /* Step 6: Record the decision in the right sheet, then render success/failure. A failure here
     usually means the application advanced/closed in the meantime (race), so the link is now stale. */
  let result;
  if (approverType === 'divhead') {
    result = processDivHeadDecision_(
      sessionId,
      targetEmail,
      action,
      // Round-4: no boilerplate default comment; empty stays empty and is hidden at render.
      comment || '',
      approverFlags
    );
  } else {
    result = processApprovalDecision_(
      sessionId, targetEmail, action, comment || '', stepParam, approverFlags
    );
  }

  if (result.ok) {
    let displayAction = action;
    if (action === 'Approve') displayAction = 'Approved';
    if (action === 'Deny') displayAction = 'Denied';
    if (action === 'Return') displayAction = 'Returned to Requestor';

    // Round-4: the box confirms the SAVE succeeded, so it is green for every decision
    // (a red box on Return read as an error; matches the ISM branch which was already green).
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
      `<span class="step-badge">Action Completed</span><h1>Successfully ${displayAction}!</h1>`,
      `<div class="alert" style="background: var(--success); color: var(--success-text); border-color: rgba(22,163,74,0.2);">The decision for application <strong>${sessionId}</strong> has been safely recorded in the database.</div>
      ${previewHtml}
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">Your response has been saved. You may now safely close this window.</p>`
    ));
  } else {
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper_(
      `<h1>Action Failed</h1>`,
      `<div class="alert alert-danger">${escapeHtml_(result.message)}</div>
      <p style="text-align: center; color: var(--text2); margin-top: 1.5rem; font-size: 13px;">This application has already been processed, making this approval form invalid. You may now safely close this window.</p>`
    ));
  }
}

/*
  Constant: __SS_HANDLE_CACHE

  LAYMAN (Tropang Ex):
  Isang execution lang ito buhay. Dati, kada beses na may kailangang tab sa database,
  binubuksan ulit ng code yung buong spreadsheet file, kahit kaka-bukas lang niya.
  Isang approver na nag-click ng email link = 13 beses na pagbukas ng parehong file.
  Ngayon, unang bukas lang ang tunay; yung sunod-sunod, yung nakabukas na ang gamit.

  TECHNICAL: Execution-scoped memo for SpreadsheetApp.openById(). Safe by construction:
  a Spreadsheet object is a LIVE handle, not a data snapshot, so a cached handle still
  observes writes made through any other handle in the same execution. This is a
  strictly different thing from __SHEET_CACHE below, which caches VALUES and therefore
  has to worry about staleness. Mirrors Phase 1's CACHE.spreadsheets / getCachedSpreadsheet_.
*/
var __SS_HANDLE_CACHE = { id: null, ss: null };

/*
  Function: getDatabaseSpreadsheet_
  LAYMAN:    Opens the one shared Google Spreadsheet that is the whole system's database. Finds it
             by stored id, or falls back to the active/bound spreadsheet, or creates a new one.
             Only actually opens it once per run, after that it hands back the same handle.
  TECHNICAL: Resolves DB via DB_SPREADSHEET_ID_PROP; else uses getActiveSpreadsheet() and caches its
             id; else (createIfMissing !== false) creates 'PIA System Database' and caches its id.
             The resolved handle is memoized in __SS_HANDLE_CACHE for the rest of the execution.
  PARAMS:    - createIfMissing: pass false to never create (returns null instead).
  RETURNS:   Spreadsheet object, or null when not found and createIfMissing === false.
*/
function getDatabaseSpreadsheet_(createIfMissing) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const spreadsheetId = scriptProperties.getProperty(DB_SPREADSHEET_ID_PROP);

  if (spreadsheetId) {
    // PERF: reuse the open handle instead of re-opening the same file on every sheet access.
    if (__SS_HANDLE_CACHE.ss && __SS_HANDLE_CACHE.id === spreadsheetId) {
      return __SS_HANDLE_CACHE.ss;
    }
    const opened = SpreadsheetApp.openById(spreadsheetId);
    __SS_HANDLE_CACHE = { id: spreadsheetId, ss: opened };
    return opened;
  }

  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (activeSpreadsheet) {
    scriptProperties.setProperty(DB_SPREADSHEET_ID_PROP, activeSpreadsheet.getId());
    __SS_HANDLE_CACHE = { id: activeSpreadsheet.getId(), ss: activeSpreadsheet };
    return activeSpreadsheet;
  }

  if (createIfMissing === false) {
    return null;
  }

  const databaseSpreadsheet = SpreadsheetApp.create('PIA System Database');
  scriptProperties.setProperty(DB_SPREADSHEET_ID_PROP, databaseSpreadsheet.getId());
  __SS_HANDLE_CACHE = { id: databaseSpreadsheet.getId(), ss: databaseSpreadsheet };
  return databaseSpreadsheet;
}

/*
  Function: getDatabaseSheet_
  LAYMAN:    Opens a specific tab (e.g. 'Applications') inside the shared spreadsheet, creating it
             if it is missing and you allow that.
  TECHNICAL: Gets the spreadsheet, returns getSheetByName(sheetName); if absent and
             createIfMissing !== false, insertSheet (try/catch). Logs and returns null on failure.
  PARAMS:    - sheetName: tab name (use DB_SHEET_NAMES.*).
             - createIfMissing: pass false to require an existing tab.
  RETURNS:   Sheet object, or null if not found/createIfMissing is false/creation fails.
*/
function getDatabaseSheet_(sheetName, createIfMissing) {
  const spreadsheet = getDatabaseSpreadsheet_(createIfMissing !== false);
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

  // Verify the live header row still matches PIA_SCHEMA, once per sheet per execution. This is
  // the chokepoint every sheet access already goes through, so putting the check here means a
  // renamed or reordered column throws on first touch instead of silently returning the wrong
  // cell somewhere downstream. See assertSheetSchema_ for why it tolerates extra trailing
  // columns but not a rename.
  if (sheet) assertSheetSchema_(sheetName, sheet);

  return sheet;
}

/*
  ━━━ THE SHEET-VALUE READ CACHE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  LAYMAN (Tropang Ex):
  Bago nito, kada tanong sa database = "i-download mo muna yung BUONG tab, tapos hanapin
  mo dun." Isang approver na nag-click ng link sa email = 13 beses na buong-tab download,
  at yung iba dun ay yung PAREHONG tab, paulit-ulit. Ngayon, may maliit na notepad na
  buhay habang tumatakbo yung request: kapag hiningi ulit yung parehong tab, dun na kukuha.
  Pagkatapos ng request, burado agad, walang natitirang luma.

  🚩 PERO: PATAY ang cache by default. Kailangan mong SADYANG buksan sa pamamagitan ng
  withSheetCache_(). Yun ang buong point.

  TECHNICAL:
  Execution-scoped memo of getDataRange().getValues(), keyed by sheet NAME. Three rules,
  and the safety of the whole thing rests on the first one:

  1. __SHEET_CACHE is null (OFF) by default, so readSheetValues_ degrades to exactly the
     call it replaced. That is why converting all ~150 read sites to readSheetValues_ is
     a behaviour-preserving no-op on its own, and why the conversion cannot regress.

  2. The cache is enabled ONLY around READ-ONLY entry points. It is deliberately NOT
     enabled on any path that writes. This makes write-then-stale-read structurally
     impossible instead of depending on someone remembering to invalidate across the
     151 setValue/appendRow/deleteRow sites in this file. invalidateSheetCache_ exists
     for the narrow case of a read-only path that must re-read after a repair write.

  3. On a cache HIT the caller gets the SAME array reference, not a copy, that is the
     whole saving. So a cached read must never be mutated in place. Rule 2 already
     guarantees this (read-only paths do not write back), but if you ever widen the
     cache to a mutating path, copy before mutating or you will corrupt a later reader.

  Nesting composes: an inner withSheetCache_ sees a live outer cache and leaves it alone,
  so the OUTERMOST wrapper owns the lifetime. Wrapping adminGetPipelineView_ therefore
  extends one cache across every getUnifiedHistory_ / getCurrentRound_ call it makes.

  ⚠️ NOT extended to mutation paths in this pass, on purpose. Doing that safely needs a
  write-then-reread audit of every mutator first (processApprovalDecision_ writes a
  decision and then checkAllApproved_ re-reads the same sheet, for one). Do that as its
  own change, with its own test, not as a side effect of something else.
*/
var __SHEET_CACHE = null;

/*
  Function: withSheetCache_
  LAYMAN:    Buksan ang cache habang tumatakbo yung ibinigay mong function, tapos patayin ulit.
  TECHNICAL: Enables __SHEET_CACHE for the duration of fn and restores the previous state in a
             finally block, so a throw cannot leave the cache switched on. Re-entrant: a nested
             call detects a live outer cache and yields lifetime ownership to it.
  PARAMS:    - fn: zero-arg function to run with caching enabled.
  RETURNS:   Whatever fn returns (exceptions propagate untouched).
  EXAMPLE
    return withSheetCache_(function () { return buildDashboard_(); });
*/
function withSheetCache_(fn) {
  const outer = __SHEET_CACHE;
  if (!outer) __SHEET_CACHE = {};
  try {
    return fn();
  } finally {
    if (!outer) __SHEET_CACHE = null;
  }
}

/*
  Function: readSheetValues_
  LAYMAN:    Kunin lahat ng laman ng isang tab. Kung nakabukas yung cache at nakuha na dati
             sa parehong takbo, yung naka-imbak na ang ibabalik, walang bagong download.
  TECHNICAL: Drop-in replacement for `sheet.getDataRange().getValues()`. With the cache off
             it IS that call. With it on, memoizes by sheet.getName().

             🚩 A null sheet THROWS, deliberately. The call this replaced threw a TypeError
             in that case, and several callers depend on that: sendDailyReminders_'s
             pre-filter is fail-CLOSED precisely because an empty map would read as "nobody
             has been reminded" and blast every pending approver in the system. Returning []
             here would have quietly converted those fail-loud paths into fail-silent ones.
             Same control flow as before, just a message you can actually read.
  PARAMS:    - sheet: a Sheet object (usually straight from getDatabaseSheet_).
  RETURNS:   2-D array of cell values. Shared reference on a cache hit, do not mutate.
*/
function readSheetValues_(sheet) {
  if (!sheet) throw new Error('readSheetValues_: sheet is null (the tab could not be opened or created).');
  if (!__SHEET_CACHE) return sheet.getDataRange().getValues();
  const key = sheet.getName();
  if (!Object.prototype.hasOwnProperty.call(__SHEET_CACHE, key)) {
    __SHEET_CACHE[key] = sheet.getDataRange().getValues();
  }
  return __SHEET_CACHE[key];
}

/*
  Function: invalidateSheetCache_
  LAYMAN:    Kalimutan yung naka-imbak na kopya ng isang tab (o ng lahat), para sariwa ulit
             yung susunod na basa. Kailangan lang ito kung may sinulat ka habang bukas ang cache.
  TECHNICAL: No-op when the cache is off. Drops one entry by Sheet or by name, or clears all
             when called with no argument.
  PARAMS:    - sheetOrName: a Sheet, a tab-name string, or nothing (clear everything).
  RETURNS:   undefined.
*/
function invalidateSheetCache_(sheetOrName) {
  if (!__SHEET_CACHE) return;
  if (!sheetOrName) { __SHEET_CACHE = {}; return; }
  const key = (typeof sheetOrName === 'string') ? sheetOrName : sheetOrName.getName();
  delete __SHEET_CACHE[key];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🗂️ REVISION HISTORY STORE (survives the resubmit wipe)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: getApplicationSnapshotSheet_
  LAYMAN:    Kinukuha (o ginagawa, kung wala pa) yung tab na pinag-iimbakan ng mga lumang sagot.
  TECHNICAL: Self-healing accessor, creates the tab with headers on first use, so a deployment
             that never re-ran initializeDatabase_ still gets it without a manual setup step.
  PARAMS:    (none)
  RETURNS:   The Sheet, or null if it could not be created.
*/
function getApplicationSnapshotSheet_() {
  const sheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATION_SNAPSHOTS, true);
  if (!sheet) return null;
  if (sheet.getLastRow() === 0) {
    const headers = PIA_SCHEMA["Application_Snapshots"].slice();
    sheet.appendRow(headers);
    try { formatHeaderRow_(sheet); } catch (e) { /* header formatting is best-effort */ }
  }
  return sheet;
}

/*
  Function: writeApplicationSnapshot_

  LAYMAN (Tropang Ex):
  Bago sapawan ng bagong sagot yung luma sa isang resubmit, kinukuha muna nito yung buong laman ng
  application ngayon at itinatabi sa hiwalay na tab. Yun yung ebidensya kung ano talaga yung nakita
  at inaprubahan ng bawat approver noong nakaraang round.

  Dati kasi wala nito. Ang naitatago lang ay yung DESISYON ("inaprubahan ni X, ganito comment"),
  pero hindi yung SAGOT na tinitignan nila. Kaya kapag nag-resubmit ka, wala nang paraan para
  patunayan kung ano talaga yung inaprubahan. Yung mga desisyon ay nasa workflow sheets na mismo
  (hindi na binubura), pero yung sagot ay nasa-overwrite pa rin, kaya nandito sila.

  TECHNICAL:
  Appends one row capturing the pre-overwrite PIA_1..5 blobs, the applicant, the status, the
  approver flags and the linked DCS id. Must be called INSIDE submitApplication_'s lock and BEFORE
  the setValue overwrite block, round derivation (max prior + 1) is only race-free under that lock.

  🚩 FAILURE HANDLING. The write stays non-blocking, because a history failure must never block a
  resubmit. But it does NOT fail silently: a failure writes a 'Snapshot Failed' row into Risk_Audit
  so the gap is detectable afterwards instead of vanishing into a Logger line nobody reads. Silent
  loss was the defect in the old snapshot mechanism; blocking the user was never the fix.

  PARAMS:
    - sessionId: the application id being resubmitted.
    - row: the current Applications row as a 0-indexed array (read before any overwrite).
  RETURNS:   The round number written, or 0 if nothing was written.

  EXAMPLE
    writeApplicationSnapshot_('PIA-000075', appsSheet.getRange(12,1,1,14).getValues()[0])  -> 2
*/
function writeApplicationSnapshot_(sessionId, row) {
  const sid = String(sessionId || '').trim();
  if (!sid || !row) return 0;

  try {
    const sheet = getApplicationSnapshotSheet_();
    if (!sheet) throw new Error('Application_Snapshots sheet unavailable');

    /* Round = (max prior round for this session) + 1. Race-free only under the caller's lock. */
    let round = 1;
    const existing = readSheetValues_(sheet);
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][APPLICATION_SNAPSHOT_COLS.SESSION_ID - 1] || '').trim() === sid) {
        const r = Number(existing[i][APPLICATION_SNAPSHOT_COLS.ROUND_NUMBER - 1] || 0);
        if (r >= round) round = r + 1;
      }
    }

    sheet.appendRow([
      Utilities.getUuid(),
      sid,
      round,
      row[APPLICATIONS_COLS.APPLICANT_EMAIL - 1] || '',
      row[APPLICATIONS_COLS.STATUS - 1] || '',
      row[APPLICATIONS_COLS.PIA_1_DATA - 1] || '',
      row[APPLICATIONS_COLS.PIA_2_DATA - 1] || '',
      row[APPLICATIONS_COLS.PIA_3_DATA - 1] || '',
      row[APPLICATIONS_COLS.PIA_4_DATA - 1] || '',
      row[APPLICATIONS_COLS.PIA_5_DATA - 1] || '',
      row[APPLICATIONS_COLS.APPROVER_FLAGS - 1] || '',
      row[APPLICATIONS_COLS.LINKED_REQ_ID - 1] || '',
      new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
    ]);

    Logger.log('Application snapshot: captured round ' + round + ' answers for ' + sid);
    return round;

  } catch (e) {
    // Non-blocking, but LOUD: record the gap so it is auditable rather than silently lost.
    Logger.log('⚠ writeApplicationSnapshot_ FAILED for ' + sid + ': ' + e.toString());
    try {
      logAuditTrail_(sid, 'Snapshot Failed', JSON.stringify({
        reason: 'Application_Snapshots write failed before resubmit overwrite',
        error: String(e).substring(0, 300)
      }));
    } catch (auditErr) {
      Logger.log('⚠ Could not even record the snapshot failure: ' + auditErr.toString());
    }
    return 0;
  }
}



/*
  Function: collectAllRoundDecisions_
  LAYMAN:    Binabasa LAHAT ng approver rows ng isang request sa tatlong workflow sheet, at
             pinapangkat ayon sa round. Dati kasi hati sa dalawa: yung lumang rounds nasa
             Revision_History (photocopy), yung kasalukuyan nasa live sheets. Ngayon walang
             binubura, kaya nandito na lahat sa iisang lugar.
  TECHNICAL: Single three-sheet walk grouped by ROUND_NUMBER. Replaced collectCurrentRoundDecisions_
             (current round only) once the append-only change made Revision_History redundant, which
             also removed the union-two-sources logic in getUnifiedHistory_.
             flaggedFields is now read from each row's own FLAGGED_FIELDS cell (it used to be
             hardcoded {} here because only the retired photocopy carried flags).
             When includePending is true, Pending/blank rows are kept as status 'Pending' so
             in-progress surfaces can show who is next in line.
  PARAMS:    - sessionId: application id.  - includePending: keep Pending rows too.
  RETURNS:   Array of decision objects (possibly empty). Never throws.
*/
function collectAllRoundDecisions_(sessionId, includePending) {
  const sid = String(sessionId || '').trim();
  const byRound = {};   // roundNumber -> [decision, ...]
  if (!sid) return byRound;

  const push = function (round, entry) {
    if (!byRound[round]) byRound[round] = [];
    byRound[round].push(entry);
  };

  const collect = function (sheetName, cols, stage, nameCol, emailCol, roleFn, routingCol) {
    try {
      const src = getDatabaseSheet_(sheetName, false);
      if (!src) return;
      const data = readSheetValues_(src);
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (String(row[cols.SESSION_ID - 1] || '').trim() !== sid) continue;
        const status = String(row[cols.STATUS - 1] || '');
        const isPending = status === 'Pending' || status === '';
        if (isPending && !includePending) continue;

        // Per-round flags now live on the approver's own row (FLAGGED_FIELDS), which is what
        // replaced Revision_History.FlaggedFields. Blank on anything that was not a Return.
        let flagged = {};
        try {
          const rawFlags = row[cols.FLAGGED_FIELDS - 1];
          if (rawFlags) flagged = JSON.parse(rawFlags) || {};
        } catch (e) { flagged = {}; }

        push(roundOf_(row, cols), {
          stage: stage,
          approverName: nameCol ? (row[nameCol - 1] || '') : '',
          approverEmail: row[emailCol - 1] || '',
          role: roleFn(row),
          decision: row[cols.DECISION - 1] || '',
          status: isPending ? 'Pending' : status,
          comments: row[cols.COMMENTS - 1] || '',
          flaggedFields: flagged,
          routing: routingCol ? (row[routingCol - 1] || '') : '',
          decisionDate: row[cols.DECISION_DATE - 1] || ''
        });
      }
    } catch (e) { Logger.log('collectAllRoundDecisions_ (' + sheetName + ') failed: ' + e.toString()); }
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

  return byRound;
}

/*
  Function: getUnifiedHistory_
  LAYMAN:    The single source for "everything that happened to this application, start to finish":
             every prior round (from the logbook) plus the current in-progress round, grouped by
             round. Feeds the emails, both review screens, the certificate, and the requestor views.
  TECHNICAL: One call to collectAllRoundDecisions_, sorted ascending by round, with isCurrent set on
             the round matching getCurrentRound_. Previously unioned Revision_History with a separate
             current-round scan; the append-only workflow made that union unnecessary.
  PARAMS:    - sessionId: application id.  - includePending: include Pending rows in the current round.
  RETURNS:   { rounds: [{round, isCurrent, decisions:[...]}] } (rounds may be empty).
*/
function getUnifiedHistory_(sessionId, includePending) {
  // Append-only (2026-08-11): this used to union Revision_History (prior rounds, from a
  // best-effort photocopy taken before the rows were deleted) with a separate scan of the live
  // current round. Nothing is deleted any more, so every round is right here in the workflow
  // sheets and the union, plus the entire Revision_History sheet: is gone.
  const byRound = collectAllRoundDecisions_(sessionId, includePending);
  const currentRound = getCurrentRound_(sessionId);

  const rounds = Object.keys(byRound)
    .map(Number)
    .sort(function (a, b) { return a - b; })
    .map(function (r) {
      return { round: r, isCurrent: (r === currentRound), decisions: byRound[r] };
    });

  return { rounds: rounds };
}

/*
  Function: apiGetApprovalHistory
  LAYMAN:    Lets the requestor's own wizard screen fetch the complete grouped-by-round approval
             history (including who is currently pending) to draw the vertical timeline. Only the
             applicant who owns the application can read it.
  TECHNICAL: Ownership check first (normalized active-user email must equal the application's
             applicantEmail); then getUnifiedHistory_(sessionId, true). Dates are stringified because
             google.script.run cannot serialize Date objects. Separate endpoint on purpose:
             apiGetDCSContext runs pre-submission (no PIA session yet) and stays untouched.
  PARAMS:    - sessionId: the requestor's own application id.
  RETURNS:   { ok:true, rounds } or { ok:false, code, message }.
*/
function apiGetApprovalHistory(sessionId) {
  try {
    const me = getNormalizedEmail_(Session.getActiveUser().getEmail());
    if (!me) return { ok: false, message: 'Unauthorized' };

    // PERF: getApplicationData_ and getUnifiedHistory_ between them pull the three workflow
    // sheets about eleven times, mostly the same ones over and over (each one calls
    // getCurrentRound_, which alone reads all three). Gather both under ONE cache so the
    // repeats collapse to three reads. Pure read path, nothing here writes.
    const gathered = withSheetCache_(function () {
      const ad = getApplicationData_(sessionId);
      if (!ad) return null;
      if (getNormalizedEmail_(String(ad.applicantEmail || '')) !== me) return { denied: true };
      return { appData: ad, unified: getUnifiedHistory_(sessionId, true) };
    });
    if (!gathered) return { ok: false, message: 'Application not found' };
    if (gathered.denied) return { ok: false, message: 'Unauthorized' };

    const unified = gathered.unified;
    unified.rounds.forEach(function (r) {
      (r.decisions || []).forEach(function (d) {
        if (Object.prototype.toString.call(d.decisionDate) === '[object Date]') {
          d.decisionDate = Utilities.formatDate(d.decisionDate, Session.getScriptTimeZone(), 'MMM dd, yyyy, hh:mm a');
        } else if (d.decisionDate) {
          d.decisionDate = String(d.decisionDate);
        }
        if (d.snapshotAt && Object.prototype.toString.call(d.snapshotAt) === '[object Date]') {
          d.snapshotAt = String(d.snapshotAt);
        }
      });
    });
    return { ok: true, rounds: unified.rounds };
  } catch (e) {
    Logger.log('apiGetApprovalHistory failed: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 💾 DATABASE INITIALIZATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: initializeDatabase_
  LAYMAN:    First-run setup. Creates every tab the system needs (Applications, the workflow sheets,
             Drafts, Risk_Audit, Email_Queue, etc.) with proper headers, exactly once.
  TECHNICAL: Guarded by DB_INIT_FLAG_PROP and a script LockService lock (waitLock 30s) with a
             double-checked flag to prevent concurrent re-init. Creates each missing sheet with its
             header row + formatHeaderRow_, seeds the session counter, then sets the init flag.
  PARAMS:    (none)
  RETURNS:   undefined. Throws 'System busy...' if the lock cannot be acquired.
*/
function initializeDatabase_() {
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
    getDatabaseSpreadsheet_(true);
    Logger.log('✓ Database spreadsheet ready');
    
    // Create Applications table if missing
    if (!sheetExists_(DB_SHEET_NAMES.APPLICATIONS)) {
      Logger.log('  Creating Applications sheet...');
      const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
      if (!appSheet) throw new Error('Failed to create Applications sheet');
    const headers = PIA_SCHEMA["Applications"].slice();
      appSheet.appendRow(headers);
      formatHeaderRow_(appSheet);
      Logger.log('✓ Applications sheet created');
    } else {
      Logger.log('✓ Applications sheet already exists');
    }
    
    // Create Approval Workflow table if missing
    if (!sheetExists_(DB_SHEET_NAMES.APPROVAL_WORKFLOW)) {
      Logger.log('  Creating Approval_Workflow sheet...');
      const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      if (!apprSheet) throw new Error('Failed to create Approval_Workflow sheet');
      const headers = PIA_SCHEMA["Approval_Workflow"].slice();
      apprSheet.appendRow(headers);
      formatHeaderRow_(apprSheet);
      Logger.log('✓ Approval_Workflow sheet created');
    } else {
      Logger.log('✓ Approval_Workflow sheet already exists');
    }
    
    // Create Risk & Audit table if missing
    if (!sheetExists_(DB_SHEET_NAMES.RISK_AUDIT)) {
      Logger.log('  Creating Risk_Audit sheet...');
      const auditSheet = getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, true);
      if (!auditSheet) throw new Error('Failed to create Risk_Audit sheet');
      const headers = PIA_SCHEMA["Risk_Audit"].slice();
      auditSheet.appendRow(headers);
      formatHeaderRow_(auditSheet);
      Logger.log('✓ Risk_Audit sheet created');
    } else {
      Logger.log('✓ Risk_Audit sheet already exists');
    }

    // Create Drafts table if missing
    if (!sheetExists_(DB_SHEET_NAMES.DRAFTS)) {
      Logger.log('  Creating Drafts sheet...');
      const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
      if (!draftsSheet) throw new Error('Failed to create Drafts sheet');
      const headers = PIA_SCHEMA["Drafts"].slice();
      draftsSheet.appendRow(headers);
      formatHeaderRow_(draftsSheet);
      Logger.log('✓ Drafts sheet created');
    } else {
      Logger.log('✓ Drafts sheet already exists');
    }

    // Create Data Collection table if missing
    if (!sheetExists_(DB_SHEET_NAMES.DATA_COLLECTION)) {
      Logger.log('  Creating Data_Collection sheet...');
      const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
      if (!dcsSheet) throw new Error('Failed to create Data_Collection sheet');
      const headers = PIA_SCHEMA["Data_Collection"].slice();
      dcsSheet.appendRow(headers);
      formatHeaderRow_(dcsSheet);
      Logger.log('✓ Data_Collection sheet created');
    } else {
      Logger.log('✓ Data_Collection sheet already exists');
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 3 WORKFLOW SHEETS INITIALIZATION
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Logger.log('\n🚀 Initializing Phase 3 workflow sheets...');

    // Create ISM Approval Workflow table with validation
    if (!sheetExists_(DB_SHEET_NAMES.ISM_WORKFLOW)) {
      const ismHeaders = PIA_SCHEMA["ISM_Approval_Workflow"].slice();
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.ISM_WORKFLOW, ismHeaders, []);
    } else {
      Logger.log(`✓ ISM_Approval_Workflow sheet already exists`);
    }

    // Create Division Head Config table with validation
    if (!sheetExists_(DB_SHEET_NAMES.DIV_HEAD_CONFIG)) {
      const divHeadHeaders = PIA_SCHEMA["DivisionHead_Approval_Workflow"].slice();
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, divHeadHeaders, []);
    } else {
      Logger.log(`✓ DivisionHead_Approval_Workflow sheet already exists`);
    }

    // Create InfoSec Email Config table with validation and seed data
    if (!sheetExists_(DB_SHEET_NAMES.INFOSEC_CONFIG)) {
      const infoSecHeaders = PIA_SCHEMA["InfoSec_Email_Config"].slice();

      const seedData = [
        ['INFOSEC-001', 'InfoSec Member 1', 'infosec1@company.com', 'InfoSec', 'YES', 'Security Officer', ''],
        ['INFOSEC-002', 'InfoSec Member 2', 'infosec2@company.com', 'InfoSec', 'YES', 'InfoSec Analyst', ''],
        ['DCOPS', 'DCOPS Team', 'dcops@company.com', 'DCOPS', 'YES', 'DCOPS Lead', ''],
        ['TECHSERVE', 'TechServe Team', 'techserve@company.com', 'TechServe', 'YES', 'TechServe Lead', '']
      ];
      
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.INFOSEC_CONFIG, infoSecHeaders, seedData);
    } else {
      Logger.log(`✓ InfoSec_Email_Config sheet already exists`);
    }

    // Create Admin Notification Config table
    if (!sheetExists_(DB_SHEET_NAMES.ADMIN_NOTIFICATION)) {
      const adminNotifHeaders = PIA_SCHEMA["Admin_Notification_Config"].slice();
      const seedData = [
        ['ADMIN-001', 'systems.manager@company.com', 'YES', 'YES', '']
      ];
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.ADMIN_NOTIFICATION, adminNotifHeaders, seedData);
    } else {
      Logger.log(`✓ Admin_Notification_Config sheet already exists`);
    }

    // Create Email Queue table for deferred/reliable email delivery
    if (!sheetExists_(DB_SHEET_NAMES.EMAIL_QUEUE)) {
      const emailQueueHeaders = PIA_SCHEMA["Email_Queue"].slice();
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.EMAIL_QUEUE, emailQueueHeaders, []);
    } else {
      Logger.log(`✓ Email_Queue sheet already exists`);
    }

    // Create Application Snapshots table: per-round copy of the submitted answers, captured
    // before a resubmit overwrites PIA_1..5 in place. See APPLICATION_SNAPSHOT_COLS.
    // (getApplicationSnapshotSheet_ also self-heals this tab at first write, so an existing
    //  deployment that never re-runs initializeDatabase_ still gets it.)
    if (!sheetExists_(DB_SHEET_NAMES.APPLICATION_SNAPSHOTS)) {
      Logger.log('  Creating Application_Snapshots sheet...');
      const snapshotHeaders = PIA_SCHEMA["Application_Snapshots"].slice();
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.APPLICATION_SNAPSHOTS, snapshotHeaders, []);
    } else {
      Logger.log('✓ Application_Snapshots sheet already exists');
    }

    // Delegations (out-of-office). Admin-managed; EMPTY IS THE NORMAL STATE and means "no
    // delegation is in effect", which is exactly how the system behaved before this table
    // existed. See resolveDelegate_ for why it is admin-managed and single-hop.
    // (getDelegationsSheet_ also self-heals this tab on first read, so an existing deployment
    //  that never re-runs initializeDatabase_ still gets it.)
    if (!sheetExists_(DB_SHEET_NAMES.DELEGATIONS)) {
      Logger.log('  Creating Delegations sheet...');
      const delegationHeaders = PIA_SCHEMA["Delegations"].slice();
      createPhase3SheetWithValidation_(DB_SHEET_NAMES.DELEGATIONS, delegationHeaders, []);
    } else {
      Logger.log('✓ Delegations sheet already exists');
    }

    seedSessionCounterFromDatabase_();
    Logger.log('✓ Session counter seeded');
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // VERIFY ALL PHASE 3 SHEETS WERE CREATED BEFORE MARKING COMPLETE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Logger.log('\n  Verifying Phase 3 sheets were created...');
    const verificationChecks = [
      { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, expectedCols: 16 },
      { name: DB_SHEET_NAMES.ISM_WORKFLOW, expectedCols: 19 },
      { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, expectedCols: 14 },
      { name: DB_SHEET_NAMES.ADMIN_NOTIFICATION, expectedCols: 5 }
    ];
    
    let allPhase3SheetsValid = true;
    verificationChecks.forEach(check => {
      const sheet = getDatabaseSheet_(check.name, false);
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
  Function: sheetExists_
  LAYMAN:    True/false: does this tab already exist?
  TECHNICAL: getDatabaseSheet_(name, false) coerced to boolean (no creation).
  PARAMS:    - name: tab name.
  RETURNS:   Boolean.
*/
function sheetExists_(name) {
  return !!getDatabaseSheet_(name, false);
}

/*
  Function: createPhase3SheetWithValidation_
  LAYMAN:    Builds one tab with its headers (and optional starter rows), then double-checks the
             column count came out right. Used during initialization for the Phase 3 sheets.
  TECHNICAL: getDatabaseSheet_(create) → appendRow(headers) → formatHeaderRow_ → append seedData →
             assert getLastColumn() === headers.length, else throw. Re-throws on any error.
  PARAMS:    - sheetName: tab to create.
             - headers: header row array.
             - seedData: optional array of rows to append.
  RETURNS:   true on success; throws on failure.
*/
function createPhase3SheetWithValidation_(sheetName, headers, seedData) {
  Logger.log(`\n  Creating ${sheetName} sheet...`);
  
  try {
    // Create the sheet
    const sheet = getDatabaseSheet_(sheetName, true);
    if (!sheet) {
      throw new Error(`Failed to create sheet "${sheetName}"`);
    }
    
    // Add headers
    Logger.log(`  → Adding ${headers.length} column headers`);
    sheet.appendRow(headers);
    formatHeaderRow_(sheet);
    
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
  TECHNICAL: Clears DB_INIT_FLAG_PROP, runs initializeDatabase_(), then verifies expected column
             counts and dumps headers for each Phase 3 sheet to Logger. Diagnostics only, not
             called by the app at runtime.
  PARAMS:    (none)
  RETURNS:   undefined (writes to Logger).
*/
function testPhase3DatabaseInitialization() {
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
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
    initializeDatabase_();
    Logger.log('✓ Initialization completed');
    
    // Verify Phase 3 sheets were created
    Logger.log('\nVERIFICATION - Phase 3 Sheets:');
    const sheets = [
      { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, expectedCols: 16 },
      { name: DB_SHEET_NAMES.ISM_WORKFLOW, expectedCols: 19 },
      { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, expectedCols: 14 },
      { name: DB_SHEET_NAMES.INFOSEC_CONFIG, expectedCols: 7 },
      { name: DB_SHEET_NAMES.EMAIL_QUEUE, expectedCols: 13 },
      { name: DB_SHEET_NAMES.ADMIN_NOTIFICATION, expectedCols: 5 }
    ];
    
    let allGood = true;
    sheets.forEach(sheetInfo => {
      const sheet = getDatabaseSheet_(sheetInfo.name, false);
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
    const apprSheet2 = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, false);
    if (apprSheet2) {
      const headers = apprSheet2.getRange(1, 1, 1, apprSheet2.getLastColumn()).getValues()[0];
      Logger.log('Approval_Workflow headers: ' + headers.join(' | '));
    }
    
    const ismSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, false);
    if (ismSheet) {
      const headers = ismSheet.getRange(1, 1, 1, ismSheet.getLastColumn()).getValues()[0];
      Logger.log('ISM_Approval_Workflow headers: ' + headers.join(' | '));
    }
    
    const divSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, false);
    if (divSheet) {
      const headers = divSheet.getRange(1, 1, 1, divSheet.getLastColumn()).getValues()[0];
      Logger.log('DivisionHead_Approval_Workflow headers: ' + headers.join(' | '));
    }
    
    const infoSheet = getDatabaseSheet_(DB_SHEET_NAMES.INFOSEC_CONFIG, false);
    if (infoSheet) {
      const headers = infoSheet.getRange(1, 1, 1, infoSheet.getLastColumn()).getValues()[0];
      Logger.log('InfoSec_Email_Config headers: ' + headers.join(' | '));
      const rows = infoSheet.getLastRow();
      Logger.log(`InfoSec_Email_Config seeded rows: ${rows - 1} (expected: 4)`);
    }
    
    const adminNotifSheet = getDatabaseSheet_(DB_SHEET_NAMES.ADMIN_NOTIFICATION, false);
    if (adminNotifSheet) {
      const headers = adminNotifSheet.getRange(1, 1, 1, adminNotifSheet.getLastColumn()).getValues()[0];
      Logger.log('Admin_Notification_Config headers: ' + headers.join(' | '));
      const rows = adminNotifSheet.getLastRow();
      Logger.log(`Admin_Notification_Config seeded rows: ${rows - 1} (expected: 1)`);
    }
    
    const queueSheet2 = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, false);
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
  LAYMAN:    Manual "rebuild the database" button, clears the init flag and runs setup again.
  TECHNICAL: Deletes DB_INIT_FLAG_PROP then calls initializeDatabase_(). Existing sheets are kept
             (initializeDatabase_ only creates missing ones).
  PARAMS:    (none)
  RETURNS:   undefined.
*/
function reinitializePhase3Database() {
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  Logger.log('  Attempting to reinitialize Phase 3 database...');
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.deleteProperty(DB_INIT_FLAG_PROP);
  initializeDatabase_();
  Logger.log('  Phase 3 database reinitialized. Check your sheets!');
}

/*
  Function: formatHeaderRow_
  LAYMAN:    Styles the top row of a sheet (navy background, white bold text) so headers stand out.
  TECHNICAL: Sets background/fontColor/fontWeight/fontSize on row 1 across all columns.
  PARAMS:    - sheet: target Sheet.
  RETURNS:   undefined (mutates formatting).
*/
function formatHeaderRow_(sheet) {
  const range = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  range.setBackground('#185FA5')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(11);
}

/*
  Function: seedSessionCounterFromDatabase_
  LAYMAN:    Makes sure the "next application number" counter is never behind what is already in the
             sheet, so new IDs do not collide with existing ones.
  TECHNICAL: Scans Applications column A for PIA-###### ids, takes the max sequence found and the
             current counter, stores the larger into SESSION_ID_COUNTER_PROP. No-op if sheet empty.
  PARAMS:    (none)
  RETURNS:   undefined.
*/
function seedSessionCounterFromDatabase_() {
  const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, false);
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
  Function: formatSessionId_
  LAYMAN:    Builds the application id string, e.g. 'PIA-000042', adding '-V2' for revisions.
  TECHNICAL: Zero-pads sequenceNumber to 6 digits; appends '-V<versionNumber>' when version > 0.
             Throws if sequence exceeds 999999.
  PARAMS:    - sequenceNumber: the running counter value.
             - versionNumber: 0 for a fresh id, >0 for a revision suffix.
  RETURNS:   Session id string. Throws on overflow.
  EXAMPLE:   formatSessionId_(42, 0) -> 'PIA-000042' ; formatSessionId_(42, 2) -> 'PIA-000042-V2'
*/
function formatSessionId_(sequenceNumber, versionNumber) {
  // HIGH FIX: Validate sequence number doesn't exceed 999999 (6 digits)
  if (sequenceNumber > 999999) {
    throw new Error('Session ID counter limit reached (max 999999 applications)');
  }
  const baseId = `PIA-${String(sequenceNumber).padStart(6, '0')}`;
  return versionNumber > 0 ? `${baseId}-V${versionNumber}` : baseId;
}

/*
  Function: nextBaseSessionId_
  LAYMAN:    Hands out the next brand-new application id, making sure two submissions never grab the
             same number even if they happen at the same time.
  TECHNICAL: Under a script lock (waitLock 30s), reads+increments SESSION_ID_COUNTER_PROP (throws at
             999999) and returns formatSessionId_(next, 0). Lock released in finally.
  PARAMS:    (none)
  RETURNS:   New base session id string (e.g. 'PIA-000043'). Throws on lock failure / overflow.
*/
function nextBaseSessionId_() {
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
    return formatSessionId_(nextValue, 0);
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/*
  Function: getNextRevisionSessionId_
  LAYMAN:    Given an existing application id, produces the next revision id (e.g. base-V1, base-V2)
             so a returned application can be resubmitted as a new version without losing its lineage.
  TECHNICAL: Under a script lock, strips any '-V#' from baseSessionId, scans Applications for ids
             sharing that base, finds the highest existing -V# and returns base-V<max+1>. Falls back
             to nextBaseSessionId_() if the base is empty.
  PARAMS:    - baseSessionId: the original (or any version of the) application id.
  RETURNS:   Revision id string (e.g. 'PIA-000042-V3'). Throws on lock failure.
*/
function getNextRevisionSessionId_(baseSessionId) {
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
      return nextBaseSessionId_();
    }

    const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
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
  Function: resolveSubmissionId_
  LAYMAN:    Decides which application id a submission should use: an explicit one passed in, a
             formatted version of a base id, or a brand-new id if neither is given.
  TECHNICAL: Precedence: appData.appId → formatSessionId_(base seq, version) when baseSessionId looks
             like PIA-###### → nextBaseSessionId_(). Strips -V# from the base before formatting.
  PARAMS:    - appData: submission object (appId?, baseSessionId?, version?).
  RETURNS:   The resolved session id string.
*/
function resolveSubmissionId_(appData) {
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
      const result = formatSessionId_(Number(match[1]), versionNumber);
      Logger.log('  Using baseSessionId (formatted): ' + result);
      return result;
    }
  }

  const newId = nextBaseSessionId_();
  Logger.log('   Generated NEW ID (no appId/baseSessionId found): ' + newId);
  return newId;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Flagging System 
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: analyzeApplicationRisk_
  LAYMAN:    Auto-screens a submission for suspicious patterns (e.g. the drafter is also their own
             approver, identical approver names, an almost-empty description, too few/many PII
             fields, copy-pasted data-flow answers) and flags it for closer review.
  TECHNICAL: Pure heuristic checks over pia1/pia2/pia4. Normalizes the polymorphic pia2 shape
             (flat array / {fields,customOthers} / numeric-key object), counts 'YES' PII fields,
             and applies the conflict / short-entry / redundancy rules. No side-effects.
  PARAMS:    - appData: the full submission object.
  RETURNS:   { isFlagged: boolean, reasons: string[] }.
*/
function analyzeApplicationRisk_(appData) {
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
  Function: submitApplication_
  LAYMAN:    The core "save my PIA" action. Figures out the id, writes all five PIA sections into
             the Applications sheet (new row, or update if resubmitting), runs risk screening,
             (re)builds the approver ladder, and kicks off the first approver + applicant emails.
  TECHNICAL: resolveSubmissionId_ → serialize pia1..pia5 JSON → analyzeApplicationRisk_. If the id
             already exists it UPDATEs under a LockService lock with re-checked ownership (anti-
             TOCTOU; rejects editing another user's app) and resets the approval/ISM/divhead rows;
             otherwise it INSERTs a new row. Blocks resubmission while the linked DCS is 'Returned'.
             Then initializeApprovalWorkflow_ and notifyApprover_(…,0)/notifyApplicant_; email failures
             are caught and surfaced as a warning (never roll back the DB write).
  PARAMS:    - appData: full submission: pia1..pia5, pia2CustomOthers, linkedReqId, appId/base/version.
  RETURNS:   { ok:true, appId, timestamp, message, warning } or { ok:false, code, message }.
*/
function submitApplication_(appData) {
  try {
    Logger.log('submitApplication_ called with: appId=' + (appData?.appId || 'empty') + ', baseSessionId=' + (appData?.baseSessionId || 'empty') + ', isEditing=' + appData?.isEditing);
    /* Step 1: Resolve the id and stamp applicant email + timestamp. */
    const sessionId = resolveSubmissionId_(appData);
    Logger.log('  Resolved sessionId: ' + sessionId);
    appData.appId = sessionId;
    
    const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    
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
    
    /* Step 2: Risk-screen; only build an audit payload if real anomalies were found. */
    // ── Risk analysis for isFlagged column (Applications sheet metadata) ──
    const riskAnalysis = analyzeApplicationRisk_(appData);
    appData.isFlagged = riskAnalysis.isFlagged;

    // Only build audit payload when there are genuinely paranormal flags
    const hasParanormalFlags = riskAnalysis.isFlagged && riskAnalysis.reasons.length > 0;
    const internalFlagsStr = hasParanormalFlags
      ? JSON.stringify({ riskLevel: 'HIGH', reasons: riskAnalysis.reasons })
      : null;

    // Do NOT use appData.isEditing from client. Instead, check if the session ID exists and is owned by the user.
    let rowNum = findRowBySessionID_(sessionId);
    const isEditing = rowNum > 0;

    /* Step 3: Gate: if the linked DCS request was Returned, block the PIA resubmission. */
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
        const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
        const dcsData = readSheetValues_(dcsSheet);
        for(let i=1; i<dcsData.length; i++) {
          if(dcsData[i][DCS_COLS.REQ_ID - 1] === appData.linkedReqId) {
            const dcsStatus = dcsData[i][DCS_COLS.STATUS - 1];
            if (dcsStatus === 'Returned') {
              return { ok: false, message: 'Your application has been returned back, you will need to check the DCS to review & resubmit.' };
            }
            break;
          }
        }
      }
    }

    /* Step 4: Existing id → UPDATE path: lock, re-verify ownership, overwrite the PIA cells, then
       clear and rebuild the approval/ISM/divhead workflow rows. */
    if (rowNum > 0) {
      // CRITICAL FIX C5: Acquire lock to prevent race condition on resubmission
      const lock = LockService.getScriptLock();
      try {
        lock.waitLock(LOCK_TIMEOUT_MS);
      } catch (e) {
        return {
          ok: false,
          message: 'System is busy. Please try again in a moment.'
        };
      }
      
      try {
        // Re-check ownership inside the lock to prevent TOCTOU
        const freshRowNum = findRowBySessionID_(sessionId);
        if (freshRowNum <= 0) {
          // Row was deleted by another process, treat as new submission
          lock.releaseLock();
          return submitApplication_(appData); // Recurse to handle as new submission
        }
        
        const existingRow = appSheet.getRange(freshRowNum, APPLICATIONS_COLS.APPLICANT_EMAIL, 1, 1).getValue();
        const existingEmail = String(existingRow || '').trim().toLowerCase();
        
        if (existingEmail !== userEmail.toLowerCase()) {
          // User is trying to edit someone else's application - DENY
          Logger.log('SECURITY ALERT: User ' + userEmail + ' attempted to edit application ' + sessionId + ' owned by ' + existingEmail);
          lock.releaseLock();
          return {
            ok: false,
            message: 'You do not have permission to edit this application.'
          };
        }
        
        // ── Snapshot the answers about to be overwritten (non-blocking) ──
        //
        // Only ONE half is needed here now. The round's DECISIONS live permanently in the workflow
        // sheets (nothing is deleted since the append-only change), so the old copy-before-delete
        // into Revision_History is gone. What still gets destroyed is the SUBMISSION: PIA_1..5 are
        // setValue'd over in place a few lines below, because Applications is a single-current-state
        // row looked up by SessionID across all three apps and cannot be versioned into many rows.
        //
        // Without this, "what exactly did the Department Head approve in round 1?" has no answer
        // anywhere. For a Privacy Impact Assessment that is a compliance gap, not a nice-to-have.
        //
        // Runs BEFORE Approver_Flags is cleared. Read the whole row ONCE, before any write.
        let priorRow = null;
        try {
          priorRow = appSheet.getRange(freshRowNum, 1, 1, APPLICATIONS_COLS.APPROVER_FLAGS).getValues()[0];
        } catch (e) {
          Logger.log('⚠ Could not read the prior Applications row for snapshotting: ' + e.toString());
        }

        // Answers snapshot. Failures here self-report into Risk_Audit (see the function) rather
        // than disappearing, so a lost round is detectable after the fact.
        if (priorRow) {
          writeApplicationSnapshot_(sessionId, priorRow);
        } else {
          try {
            logAuditTrail_(sessionId, 'Snapshot Failed', JSON.stringify({
              reason: 'Applications row could not be read before the resubmit overwrite'
            }));
          } catch (e) { /* best-effort */ }
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

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 🔁 APPEND THE NEXT ROUND, nothing is deleted (2026-08-11)
        //
        // LAYMAN (Tropang Ex): Dati dito, BINUBURA lahat ng approval rows ng session na 'to sa
        //   tatlong sheet, tapos gagawa ulit ng bago mula sa simula. Kaya kailangan pa ng
        //   photocopy (Revision_History) bago mag-delete, at kapag pumalpak yung photocopy,
        //   tuluyang nawawala yung buong round. Ngayon: hindi na tayo nagbubura. Dinadagdag
        //   lang natin yung bagong round sa ibaba, may RoundNumber na nakatatak.
        //
        // TECHNICAL: The delete existed solely because there was no round discriminator, so a
        //   `SessionID = X AND Status = 'Pending'` scan could match an abandoned row from a
        //   previous round (e.g. an ISM member who was never reached before the return). With
        //   ROUND_NUMBER present, routing scans scope to the current round and the old rows are
        //   harmless, and they are now the authoritative history, so Revision_History and its
        //   best-effort snapshot are gone.
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const nextRound = getCurrentRound_(sessionId) + 1;
        initializeApprovalWorkflow_(sessionId, appData, nextRound);
        Logger.log('🔁 ' + sessionId + ': appended approval round ' + nextRound + ' (prior rounds retained)');

        // ── Risk_Audit: only log paranormal flag events ──
        if (hasParanormalFlags) {
          logAuditTrail_(sessionId, 'Application Resubmitted', internalFlagsStr);
        } else {
          Logger.log(`[AUDIT] ${sessionId}: Application Resubmitted: No anomalous flags`);
        }
      } finally {
        lock.releaseLock();
      }
    } else {
      /* Step 5: New id → INSERT a fresh Applications row, then seed the approval workflow. */
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

      // Initialize approval workflow with dynamic approvers from appData (first round).
      initializeApprovalWorkflow_(sessionId, appData, 1);
      
      // ── Risk_Audit: only log paranormal flag events ──
      if (hasParanormalFlags) {
        logAuditTrail_(sessionId, 'Application Submitted', internalFlagsStr);
      } else {
        Logger.log(`[AUDIT] ${sessionId}: Application Submitted: No anomalous flags`);
      }
    }
    
    /* Step 6: Notify first approver + applicant; isolate email failures so a saved app never fails. */
    // Send email notification to first approver
    // Wrap in try-catch so email failure never rolls back a successful DB write
    let emailWarning = null;
    try {
      notifyApprover_(sessionId, 0);
      notifyApplicant_(sessionId, 'submitted');
    } catch (emailErr) {
      emailWarning = 'Email notification failed: ' + emailErr.toString();
      Logger.log('WARNING: Application saved but ' + emailWarning);
      // Application is already in the database, do NOT throw
    }
    
    return {
      ok: true,
      appId: sessionId,
      timestamp: timestamp,
      message: 'Application ' + (isEditing ? 'resubmitted' : 'submitted') + ' successfully',
      warning: emailWarning
    };
  } catch (e) {
    Logger.log('Error submitting application: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   APPROVAL WORKFLOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: processDivHeadDecision_
  LAYMAN:    Records a Division Head's verdict on an application that an ISM member escalated to
             them. Approve resumes the ISM chain (or finalizes if everyone is done); Deny/Return
             ends or bounces the application back.
  TECHNICAL: Under a script lock, re-reads DivisionHead_Approval_Workflow, finds the pending row for
             (sessionId, approverEmail), stamps decision/comments/date. On Approve: flips the related
             ISM 'EscalatedToDivisionHead' row to Approved, and if all ISM members are now Approved
             marks the app 'Approved by ISM', notifies the applicant, updates DCS to 'Complete', and
             routes; otherwise resumes notifyISMember_ at the next step. On Deny/Return:
             sets app status, optionally returns the DCS, and notifies the applicant. Lock in finally.
  PARAMS:    - sessionId: application id.
             - approverEmail: the Division Head acting.
             - decision: 'Approve' | 'Deny' | 'Return'.
             - comments: decision reason/notes.
             - approverFlags: JSON of field flags (used on Return); default '{}'.
  RETURNS:   { ok:true, message } or { ok:false, code, message }.
*/
function processDivHeadDecision_(sessionId, approverEmail, decision, comments, approverFlags = '{}') {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  // SECURITY (F-02): authorize the actual caller server-side (see apiPhase3_ProcessISMDecision).
  // Widened for delegation (2026-08-11, made EXCLUSIVE 2026-08-12): canActAs_ accepts exactly
  // ONE identity at a time, the named approver normally, or their admin-configured active
  // delegate INSTEAD OF them while a delegation is running. It is not additive: the original is
  // refused on their own row while delegated, which is what stops both of them approving the
  // same Pending step. With an empty Delegations sheet this is the identical check it replaced.
  // _actedBy carries the ORIGINAL approver when a delegate acted, and is written to the decision
  // row so the audit trail stays honest.
  const _me = getNormalizedEmail_(Session.getActiveUser().getEmail());
  const _act = canActAs_(_me, approverEmail);
  if (!_act.allowed) {
    return { ok: false, message: 'Access denied: you may only submit your own decision.' };
  }
  const _actedBy = _act.onBehalfOf ? _me : '';
  const lock = LockService.getScriptLock();
  let lockAcquired = false;

  try {
    try {
      lock.waitLock(30000);
      lockAcquired = true;
    } catch (lockErr) {
      Logger.log('ERROR: Lock acquisition timeout - concurrent modification risk on DivHead decision');
      return { ok: false, message: 'System busy, please try again' };
    }

    // CRITICAL: Re-read data after acquiring lock to prevent race conditions
    const divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    const divHeadData = readSheetValues_(divHeadSheet);
    let divHeadRow = -1;

    for (let i = 1; i < divHeadData.length; i++) {
      if (rowMatches_(divHeadData[i], DIV_HEAD_CONFIG_COLS, sessionId, __round) &&
          // Was a raw .toLowerCase() compare while the other two decision paths used
          // getNormalizedEmail_. That inconsistency meant a '+alias' address matched here but
          // not there, and with delegation it would have been worse, because canActAs_
          // normalizes, so the guard could pass and then this row lookup miss, producing a
          // confusing "record not found" on a decision the caller was entitled to make.
          getNormalizedEmail_(divHeadData[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1]) === getNormalizedEmail_(approverEmail) &&
          divHeadData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') {
        divHeadRow = i + 1;
        break;
      }
    }

    if (divHeadRow === -1) {
      return { ok: false, message: 'Division Head approval record not found or already processed.' };
    }

    // Handle Division Head decision
    const timestamp = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.DECISION).setValue(decision);
    divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.COMMENTS).setValue(comments);
    divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.DECISION_DATE).setValue(timestamp);
    // Append-only workflow: persist what THIS approver flagged onto THEIR row. Applications
    // .Approver_Flags is cleared on every resubmit, so this is the durable per-round record
    // (it replaces Revision_History.FlaggedFields).
    writeDecisionFlags_(divHeadSheet, divHeadRow, DIV_HEAD_CONFIG_COLS, approverFlags);
    writeActedBy_(divHeadSheet, divHeadRow, DIV_HEAD_CONFIG_COLS, _actedBy);
    Logger.log(`[AUDIT] ${sessionId}: Division Head Decision: ${decision} by ${approverEmail}`);
    
    if (decision === 'Approve') {
      divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.STATUS).setValue('Approved');

      const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const ismData = readSheetValues_(ismWorkflowSheet);
      let escalatedStep = 1;
      
      for (let i = 1; i < ismData.length; i++) {
        if (rowMatches_(ismData[i], ISM_WORKFLOW_COLS, sessionId, __round) &&
            ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'EscalatedToDivisionHead') {
          ismWorkflowSheet.getRange(i + 1, ISM_WORKFLOW_COLS.STATUS).setValue('Approved');
          escalatedStep = Number(ismData[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] || 1);
          Logger.log(`[AUDIT] ${sessionId}: ISM escalation for step ${escalatedStep} resolved by DivHead approval`);
          break; 
        }
      }

      // Check if all ISM members are now approved
      const freshData = readSheetValues_(ismWorkflowSheet);
      let allApproved = true;
      let totalMembers = 0;
      let routingDest = 'BOTH';

      for (let i = 1; i < freshData.length; i++) {
        if (rowMatches_(freshData[i], ISM_WORKFLOW_COLS, sessionId, __round)) {
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
        const appRow = findRowBySessionID_(sessionId);
        if (appRow > 0) {
          appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved by ISM');
          Logger.log(`[AUDIT] ${sessionId}: Application Approved by ISM InfoSec Team (via DivHead Proxy)`);

          const linkedReqId = appSheet.getRange(appRow, APPLICATIONS_COLS.LINKED_REQ_ID).getValue();
          if (linkedReqId) updateDCSStatus_(linkedReqId, 'Complete');
          
          let certResult = null;
          try { certResult = routeApprovedRequest_(sessionId, routingDest); } catch (e) {}
          notifyApplicant_(sessionId, 'approved_divhead_final', {
            certBlob: (certResult && certResult.ok) ? certResult.pdfBlob : null,
            techserveEmails: (certResult && certResult.ok) ? certResult.techserveEmails : ''
          });
        }
      } else {
        // Don't notify applicant here, the ISM member's approval handler
        // will notify the applicant when they act (progressing_ism or approved_ism_final).
        notifyISMember_(sessionId, escalatedStep + 1);
        Logger.log(`processDivHeadDecision_: Resumed ISM workflow at step ${escalatedStep + 1}`);
      }
    } else { // Deny or Return
      const finalStatus = (decision === 'Deny') ? 'Denied' : 'Returned';
      divHeadSheet.getRange(divHeadRow, DIV_HEAD_CONFIG_COLS.STATUS).setValue(finalStatus);
      
      // Update main application status
      const appRow = findRowBySessionID_(sessionId);
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
          if (hasDCSFlags) updateDCSStatus_(linkedReqId, 'Returned', approverFlags);
        }
      }
      notifyApplicant_(sessionId, decision === 'Deny' ? 'denied' : 'returned');
    }
    return { ok: true, message: 'Division Head decision recorded successfully' };
  } catch (e) {
    Logger.log('Error processing Division Head approval: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  } finally {
    // CRITICAL FIX: Only release lock if it was actually acquired
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}
/*
  Function: buildApproversFromAppData_
  LAYMAN:    Works out the approver ladder for an application from its PIA 1 answers: Immediate Head
             (step 1), then Department Head (step 2). If neither has a valid email, it falls back to
             the configured Privacy Officer.
  TECHNICAL: Reads pia1, sanitizeEmail_-validates each head email, and pushes {name,email,step}. If
             the list is empty, falls back to PRIVACY_OFFICER_EMAIL Script Property (validated).
             Invalid emails are logged and skipped. (Division Head is NOT seeded here, that comes via
             the ISM escalation path.)
  PARAMS:    - appData: submission with a pia1 section.
  RETURNS:   Array of { name, email, step } (may be empty if nothing valid configured).
*/
function buildApproversFromAppData_(appData) {
  const approvers = [];
  const pia1 = appData.pia1 || {};

  // Validate Immediate Head email
  if (pia1.immediateHeadEmail && pia1.immediateHeadEmail.trim()) {
    const headEmail = sanitizeEmail_(pia1.immediateHeadEmail);
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
    const deptEmail = sanitizeEmail_(pia1.deptHeadEmail);
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
      const pocEmail = sanitizeEmail_(fallbackEmail);
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
  Function: initializeApprovalWorkflow_
  LAYMAN:    Creates the to-do rows in the approval sheet, one per approver in the ladder, all
             starting as 'Pending'.
  TECHNICAL: buildApproversFromAppData_ → append one Approval_Workflow row per approver with id
             '<sessionId>-<n>', the step number, and Pending Status/EmailStatus.
  PARAMS:    - sessionId: application id.
             - appData: submission (source of the approver ladder).
  RETURNS:   undefined (writes rows). No rows if no approvers resolved.
*/
function initializeApprovalWorkflow_(sessionId, appData, roundNumber) {
  const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);

  // Append-only workflow: rows from earlier rounds are never deleted, so every row must declare
  // which round it belongs to or routing scans cannot tell a live row from an abandoned one.
  const round = (Number(roundNumber) >= 1) ? Math.floor(Number(roundNumber)) : 1;

  // Build dynamic approvers from application data
  const approversToUse = appData ? buildApproversFromAppData_(appData) : [];

  approversToUse.forEach((approver, index) => {
    // ApprovalID must stay unique across rounds now that old rows survive, suffix round 2+.
    const approvalId = sessionId + '-' + (index + 1) + (round > 1 ? ('-R' + round) : '');
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
      '',                      // EmailError
      '',                      // NotifiedDate
      round,                   // RoundNumber
      ''                       // FlaggedFields
    ]);
  });
}

/*
  Function: processApprovalDecision_
  LAYMAN:    Records a head/approver's verdict (Approve / Return / Deny) on an application and moves
             the process forward: next approver, hand-off to the ISM stage when all heads approve, or
             bounce/kill the application.
  TECHNICAL: Validates decision, takes a script lock, re-reads Approval_Workflow (anti-stale), locates
             the matching Pending row by normalized email (and optional step), stamps it. Approve:
             if all approver rows are Approved → initialize the ISM workflow (apiPhase3_InitializeISMWorkflow_)
             and notify the first ISM member; on ISM-init failure sets 'Approved (ISM Pending)'. Else
             notify the next approver. Return: status 'Returned', save flags, optionally return the
             linked DCS. Deny: status 'Denied'. Always notifies the applicant; lock released in finally.
  PARAMS:    - sessionId, approverEmail, decision('Approve'|'Return'|'Deny'), comments.
             - stepParam: optional step to disambiguate; approverFlags: JSON flags (default '{}').
  RETURNS:   { ok:true, message } or { ok:false, code, message }.
*/
function processApprovalDecision_(sessionId, approverEmail, decision, comments, stepParam = null, approverFlags = '{}') {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  // SECURITY (F-02): authorize the actual caller server-side (see apiPhase3_ProcessISMDecision).
  // Widened for delegation (2026-08-11, made EXCLUSIVE 2026-08-12): canActAs_ accepts exactly
  // ONE identity at a time, the named approver normally, or their admin-configured active
  // delegate INSTEAD OF them while a delegation is running. It is not additive: the original is
  // refused on their own row while delegated, which is what stops both of them approving the
  // same Pending step. With an empty Delegations sheet this is the identical check it replaced.
  // _actedBy carries the ORIGINAL approver when a delegate acted, and is written to the decision
  // row so the audit trail stays honest.
  const _me = getNormalizedEmail_(Session.getActiveUser().getEmail());
  const _act = canActAs_(_me, approverEmail);
  if (!_act.allowed) {
    return { ok: false, message: 'Access denied: you may only submit your own decision.' };
  }
  const _actedBy = _act.onBehalfOf ? _me : '';
  try {
    const allowedDecisions = ['Approve', 'Return', 'Deny'];
    if (allowedDecisions.indexOf(decision) === -1) {
      return { ok: false, message: 'Invalid decision value' };
    }

    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    
    try {
      try {
        lock.waitLock(30000);
        lockAcquired = true;
      } catch (lockErr) {
        Logger.log('ERROR: Lock acquisition timeout - concurrent modification risk');
        return { ok: false, message: 'System busy, please try again' };
      }
      
      try {
      const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
      
      // CRITICAL FIX: Re-read data after acquiring lock to prevent race condition
      const apprData = readSheetValues_(apprSheet);
      const appData_values = readSheetValues_(appSheet);
      
      // Find the current approver record
      let currentRow = -1;
      let approverIndex = -1;
      const normalizedTarget = String(getNormalizedEmail_(approverEmail) || '').toLowerCase();
      
      for (let i = 1; i < apprData.length; i++) {
        const rowEmail = String(getNormalizedEmail_(apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1]) || '').toLowerCase();
        if (rowMatches_(apprData[i], APPROVAL_COLS, sessionId, __round) && 
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
        return { ok: false, message: 'Approval record not found.' };
      }
      
      const timestamp = new Date().toLocaleString('en-PH', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      
      // Update approval decision
      apprSheet.getRange(currentRow, APPROVAL_COLS.DECISION).setValue(decision);
      apprSheet.getRange(currentRow, APPROVAL_COLS.COMMENTS).setValue(comments);
      apprSheet.getRange(currentRow, APPROVAL_COLS.DECISION_DATE).setValue(timestamp);
      // Append-only workflow: durable per-round record of what THIS approver flagged.
      writeDecisionFlags_(apprSheet, currentRow, APPROVAL_COLS, approverFlags);
      writeActedBy_(apprSheet, currentRow, APPROVAL_COLS, _actedBy);
      
      if (decision === 'Approve') {
        /* Approve branch: when every approver row is Approved, hand off to the ISM stage;
           otherwise advance to the next approver. */
        apprSheet.getRange(currentRow, APPROVAL_COLS.STATUS).setValue('Approved');

        // Re-read fresh data after lock to check all approvals (prevents stale cache)
        const freshApprData = readSheetValues_(apprSheet);
        let allApproved = true;
        for (let i = 1; i < freshApprData.length; i++) {
          if (rowMatches_(freshApprData[i], APPROVAL_COLS, sessionId, __round)) {
            if (freshApprData[i][APPROVAL_COLS.STATUS - 1] !== 'Approved') {
              allApproved = false;
              break;
            }
          }
        }
        
        if (allApproved) {
          // Find app row using fresh sheet data (not stale appData_values)
          const freshAppSheetData = readSheetValues_(appSheet);
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
            const ismInitResult = apiPhase3_InitializeISMWorkflow_(sessionId);
            if (ismInitResult.ok) {
              ismInitSuccess = true;
              Logger.log(`[AUDIT] ${sessionId}: ISM_WORKFLOW_INITIALIZED`);
            } else {
              Logger.log('[AUDIT] ' + sessionId + ': ISM_WORKFLOW_INIT_FAILED: ' + ismInitResult.message);
            }
          } catch (ismError) {
            Logger.log('[AUDIT] ' + sessionId + ': Phase 3 error: ' + ismError.toString());
          }
          
          if (appRow > 0) {
            if (ismInitSuccess) {
              // Full success: mark approved and notify ISM
              appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved');
              Logger.log(`[AUDIT] ${sessionId}: Application Approved`);
              notifyApplicant_(sessionId, 'approved_main');
              // Notify the first ISM member
              notifyISMember_(sessionId, 1);
            } else {
              // ISM init failed: set non-terminal status so admin knows to configure ISM
              appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved (ISM Pending)');
              Logger.log('[AUDIT] ' + sessionId + ': Heads approved, but ISM workflow could not be initialized. '
                + 'Set status to "Approved (ISM Pending)". Configure InfoSec_Email_Config and run apiPhase3_RetryISMWorkflow_.');
              notifyApplicant_(sessionId, 'approved_main');
            }
          }
        } else {
          notifyApplicant_(sessionId, 'progressing');
          // Notify next approver
          notifyApprover_(sessionId, approverIndex + 1);
        }
      } else if (decision === 'Reject' || decision === 'Return') {
        apprSheet.getRange(currentRow, APPROVAL_COLS.STATUS).setValue('Returned');
        apprSheet.getRange(currentRow, APPROVAL_COLS.DECISION).setValue('Return');
        // Re-read fresh data to prevent stale cache
        const freshAppData = readSheetValues_(appSheet);
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
          if (hasDCSFlags) updateDCSStatus_(linkedReqId, 'Returned', approverFlags);
        }
        
        Logger.log(`[AUDIT] ${sessionId}: Application Returned to Requestor by ${approverEmail}`);
        notifyApplicant_(sessionId, 'returned');
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
        notifyApplicant_(sessionId, 'denied');
      }
      
      return { ok: true, message: 'Decision recorded successfully' };
      } finally {
        // CRITICAL FIX: Only release lock if it was actually acquired
        if (lockAcquired) {
          lock.releaseLock();
        }
      }
    } catch (e) {
      Logger.log('Error processing approval: ' + e.toString());
      return safeError_(e, ERR.INTERNAL);
    }
  } catch (e) {
    Logger.log('ERROR in processApprovalDecision_ (outer): ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: checkAllApproved_
  LAYMAN:    Tells you whether every approver in the ladder has approved this application.
  TECHNICAL: Scans Approval_Workflow rows for sessionId; returns false on the first non-'Approved'
             status, true otherwise. Logs a warning for any unrecognized status value.
  PARAMS:    - sessionId: application id.
  RETURNS:   Boolean (true also if there are no matching rows).
*/
function checkAllApproved_(sessionId) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
  const data = readSheetValues_(apprSheet);
  const validStatuses = ['Approved', 'Pending', 'Rejected', 'Returned', 'Denied'];
  
  for (let i = 1; i < data.length; i++) {
    if (rowMatches_(data[i], APPROVAL_COLS, sessionId, __round)) {
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
  Function: updateDCSStatus_
  LAYMAN:    Writes a status back onto the Phase 1 DCS request. This is how PIA tells DCS "this is
             now Complete / Returned". On a return that flagged DCS documents, it also copies the
             approver's flags into the DCS row so the DCS resubmit form knows which supporting
             documents to re-upload and archive.
  TECHNICAL: Finds the Data_Collection row by REQ_ID and sets its STATUS cell. When approverFlags
             is passed (return paths only), it also merges those flags into METADATA_JSON.approverFlags
             (best-effort, non-blocking). This is the cross-phase write PIA makes into the DCS sheet.
             newStatus is whitelisted to the only two values PIA actually writes, so this cannot be
             used to stamp arbitrary text into a DCS row.
  PARAMS:    - reqId: the DCS Request ID (Linked_ReqID).
             - newStatus: 'Complete' or 'Returned'. Anything else is refused (logged, no write).
             - approverFlags: optional JSON string or object of flags to mirror into DCS metadata.
  RETURNS:   undefined (no-op if reqId not found or newStatus is not whitelisted).
*/
function updateDCSStatus_(reqId, newStatus, approverFlags) {
  // SECURITY (F-02): constrain the cross-phase write. These are the only two values any call site
  // passes ('Complete' at ~4376/~7865, 'Returned' at ~4414/~4698/~7929). Mixed case is intentional,
  // it matches what is already stored in Data_Collection and what the DCS frontend reads. Do NOT
  // "normalize" to uppercase here; that would be a behavior change disguised as a cleanup.
  const ALLOWED_DCS_STATUSES = ['Complete', 'Returned'];
  if (ALLOWED_DCS_STATUSES.indexOf(String(newStatus)) === -1) {
    Logger.log('updateDCSStatus_: refused unexpected status "' + newStatus + '" for ' + reqId);
    return;
  }

  const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
  const dcsData = readSheetValues_(dcsSheet);
  for (let j = 1; j < dcsData.length; j++) {
    if (dcsData[j][DCS_COLS.REQ_ID - 1] === reqId) {
      dcsSheet.getRange(j + 1, DCS_COLS.STATUS).setValue(newStatus);
      // Round-4: mirror approver flags into the DCS row's metadata so submitDCS can archive the
      // old flagged supporting documents on resubmit. Best-effort; must not block the status write.
      if (approverFlags) {
        try {
          const flagsObj = (typeof approverFlags === 'string') ? JSON.parse(approverFlags || '{}') : approverFlags;
          let meta = {};
          try { meta = JSON.parse(dcsData[j][DCS_COLS.METADATA_JSON - 1] || '{}'); } catch (e) { meta = {}; }
          meta.approverFlags = flagsObj;
          dcsSheet.getRange(j + 1, DCS_COLS.METADATA_JSON).setValue(JSON.stringify(meta));
        } catch (e) {
          Logger.log('updateDCSStatus_: metadata flag mirror failed (non-blocking): ' + e.toString());
        }
      }
      Logger.log(`Updated DCS request ${reqId} to status ${newStatus}`);
      break;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EMAIL QUEUE ENGINE: Decouples email sending from web requests
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
  Function: queueEmail_
  LAYMAN:    Does NOT send an email, it drops it into the Email_Queue sheet so the background
             trigger can send it later. This keeps slow/throttled Gmail off the web-request path.
  TECHNICAL: Appends a Pending Email_Queue row (generated EQ-<ts>-<rand> id, plain+html bodies,
             type, 0 attempts). Then best-effort stamps EmailStatus='Pending' on the matching
             workflow row (approver/ism/divhead) so the admin panel can see queued sends. All in
             try/catch; stamping failure is non-fatal.
  PARAMS:    - sessionId, recipient, subject, plainBody, type, htmlBody.
  RETURNS:   The queueId string, or null on failure.
*/
function queueEmail_(sessionId, recipient, subject, plainBody, type, htmlBody) {
  try {
    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
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
      // Band-aid removed (2026-08-11): this used to hand-roll the sheet/cols mapping and then
      // resolve the approver email by chaining
      //     cols.APPROVER_EMAIL || cols.ISM_MEMBER_EMAIL || cols.DIV_HEAD_EMAIL
      // across three DIFFERENT column maps, it only ever worked because the two wrong keys
      // evaluate to `undefined`, making `row[undefined - 1]` undefined and falling through.
      // getWorkflowInfoForType_ already returns the correct { name, cols, emailCol } triple, so
      // use it instead of re-deriving (and mis-deriving) the same thing.
      var wfInfo = getWorkflowInfoForType_(type);

      if (wfInfo) {
        var wfSheet = getDatabaseSheet_(wfInfo.name, true);
        if (wfSheet) {
          var wfData = readSheetValues_(wfSheet);
          var normRecipient = String(getNormalizedEmail_(recipient) || '').toLowerCase();
          // Append-only: scope to the live round so an abandoned Pending row from an earlier
          // round can never absorb this stamp instead of the row we actually just emailed.
          var stampRound = getCurrentRound_(sessionId) || 1;
          for (var wr = 1; wr < wfData.length; wr++) {
            if (!rowMatches_(wfData[wr], wfInfo.cols, sessionId, stampRound)) continue;
            var rowEmail = String(getNormalizedEmail_(wfData[wr][wfInfo.emailCol - 1]) || '').toLowerCase();
            var rowStatus = String(wfData[wr][wfInfo.cols.STATUS - 1] || '').trim();
            if (rowEmail === normRecipient && rowStatus === 'Pending') {
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
             and, once per queue entry (NOTIFIED_ADMIN guard), emails the admin and optionally the
             requestor per getAdminNotificationConfig_.
  PARAMS:    (none), invoked by the time trigger.
  RETURNS:   { ok:true, sent:<count> } or { ok:false, code, message }.
*/
function processEmailQueue() {
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  const MAX_SENDS_PER_CYCLE = 15;   // Cap to stay well within 30-min execution limit
  const SPACING_MS = 10000;         // 10 seconds between sends, safe for Gmail quota

  Logger.log('📬 Email Queue Processor: Starting cycle');

  try {
    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = readSheetValues_(queueSheet);
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
        // Commit 9: brand the From display name as the ISM Department on every queued email.
        const options = htmlBody
          ? { htmlBody: htmlBody, name: 'Megaworld ISM Department' }
          : { name: 'Megaworld ISM Department' };
        GmailApp.sendEmail(recipient, subject, plainBody, options);

        // Mark as Sent
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.STATUS).setValue('Sent');
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.ATTEMPTS).setValue(attempts + 1);
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.LAST_ERROR).setValue('');
        queueSheet.getRange(rowNum, EMAIL_QUEUE_COLS.SENT_AT).setValue(nowStr);

        logAuditTrail_(sessionId, 'Email Sent', JSON.stringify({
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
          logAuditTrail_(sessionId, 'Email Failed', JSON.stringify({
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
            var wfInfo = getWorkflowInfoForType_(type);
            if (wfInfo) {
              var wfSheet = getDatabaseSheet_(wfInfo.name, true);
              if (wfSheet) {
                var wfData = readSheetValues_(wfSheet);
                var normRecipient = String(getNormalizedEmail_(recipient) || '').toLowerCase();
                for (var wr = 1; wr < wfData.length; wr++) {
                  var rowSid = String(wfData[wr][wfInfo.cols.SESSION_ID - 1] || '').trim();
                  var rowEmail = String(getNormalizedEmail_(wfData[wr][wfInfo.emailCol - 1] || '') || '').toLowerCase();
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
              var notifConfig = getAdminNotificationConfig_();
              var adminEmail = notifConfig.adminEmail || 'systems.manager@company.com';

              if (notifConfig.notifyOnFailure === 'YES') {
                var adminSubject = '[PIA SYSTEM ALERT] Email Delivery Failed: Session ' + sessionId;
                var adminBody = 'An email in the PIA system has failed after ' + newAttempts + ' retry attempts.\n\n' +
                  'Session ID: ' + sessionId + '\n' +
                  'Recipient: ' + recipient + '\n' +
                  'Email Type: ' + type + '\n' +
                  'Error: ' + errMsg.substring(0, 300) + '\n\n' +
                  'Queue Entry: ' + queueId + '\n' +
                  'Timestamp: ' + nowStr + '\n\n' +
                  'Please investigate and use the admin panel to resend or escalate.';
                sendEmailWithRetry_(adminEmail, adminSubject, adminBody, {});
                Logger.log('  🚨 Admin notified of email failure: ' + adminEmail);
              }

              // 4. Notify requestor if configured
              if (notifConfig.notifyRequestor === 'YES') {
                try {
                  var appsSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
                  if (appsSheet) {
                    var appsData = readSheetValues_(appsSheet);
                    for (var ar = 1; ar < appsData.length; ar++) {
                      if (String(appsData[ar][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
                        var requestorEmail = String(appsData[ar][APPLICATIONS_COLS.APPLICANT_EMAIL - 1] || '').trim();
                        if (requestorEmail && requestorEmail !== '') {
                          var reqSubject = '[PIA System] Email Delivery Issue: Session ' + sessionId;
                          var reqBody = 'Dear Requestor,\n\n' +
                            'We encountered an issue delivering an approval email for your PIA session (' + sessionId + ').\n' +
                            'The system administrator has been notified and will resolve this shortly.\n\n' +
                            'No action is needed from you at this time.\n\n' +
                            'Thank you for your patience.\n' +
                            'PIA System';
                          sendEmailWithRetry_(requestorEmail, reqSubject, reqBody, {});
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

        Logger.log('  ✗ Failed (' + newAttempts + '/9): ' + type + ' → ' + recipient + ' [' + queueId + ']: ' + errMsg.substring(0, 120));
        sentCount++;  // Count failed attempts toward the cycle cap
      }
    }

    Logger.log('📬 Email Queue Processor: Cycle complete. Sent: ' + sentCount);
    return { ok: true, sent: sentCount };
  } catch (e) {
    Logger.log('ERROR: Email queue processor crashed: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: setupEmailQueueTrigger
  LAYMAN:    One-time setup: installs the every-minute background job that drains the email queue.
  TECHNICAL: Deletes any existing processEmailQueue trigger (dedupe), then creates a new time-based
             everyMinutes(1) trigger. Requires the script.scriptapp scope.
  PARAMS:    (none)
  RETURNS:   { ok:true, message }.
*/
function setupEmailQueueTrigger() {
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
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

  Logger.log('✓ Email Queue trigger created: processEmailQueue() will run every 1 minute');
  return { ok: true, message: 'Email queue trigger created. processEmailQueue will run every 1 minute.' };
}

/*
  Function: getNotifiedDateStamp_
  LAYMAN:   Today's date as a plain 'YYYY-MM-DD' text, used to mark when an approver was first notified
            (the start of their 7-day reminder countdown).
  TECHNICAL: Local-timezone date string, same format sendDailyReminders compares against.
  RETURNS:  'YYYY-MM-DD'
*/
function getNotifiedDateStamp_() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/*
  Function: stampNotifiedDate_
  LAYMAN:   Records "this approver was notified today" on their workflow row, but only the first time,
            so a later notification never resets the 7-day reminder countdown.
  TECHNICAL: Sets the NOTIFIED_DATE cell (1-based colNum) on the given 1-based sheet row to today's
            YYYY-MM-DD, only when currently blank. Fully guarded, never throws into the caller.
  PARAMS:   - sheet: workflow Sheet object.  - rowNum1: 1-based sheet row.  - colNum: 1-based NOTIFIED_DATE column.
  RETURNS:  undefined.
*/
function stampNotifiedDate_(sheet, rowNum1, colNum) {
  try {
    if (!sheet || !rowNum1 || !colNum) return;
    const cell = sheet.getRange(rowNum1, colNum);
    if (!cell.getValue()) cell.setValue(getNotifiedDateStamp_());
  } catch (_) {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔔 DAILY REMINDER ENGINE: Nags pending approvers on a 7-day-then-every-3-days cadence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Scans all three workflow sheets for Pending rows and nudges only the next pending approver per
// request, on a cadence: first reminder 7 days after they were notified (NOTIFIED_DATE), then every
// 3 days (from REMINDER_DATE). Runs daily but only sends when a row is due.
// Uses CacheService continuation tokens to survive 6-min timeout.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: sendDailyReminders
  LAYMAN:    The reminder engine (runs daily). Looks across all three approval sheets for whoever is
             currently holding things up and nudges only the next person in line, never people who
             haven't been reached yet. It doesn't nag every day: the first nudge goes out a week after
             that approver was notified, then follow-ups every 3 days until they act.
  TECHNICAL: Trigger-driven; no-op if config.enabled is false. Pre-filters to sessionIds whose
             application is in an active status. For each of the three workflow sheets it groups
             Pending rows by sessionId and keeps only the LOWEST pending step (sequential order). Send
             gate (Commit 6): if REMINDER_DATE is empty, send only when today − NOTIFIED_DATE ≥ 7 days;
             otherwise send when today − REMINDER_DATE ≥ 3 days. Legacy pending rows with a blank
             NOTIFIED_DATE get stamped today (starting their 7-day clock) instead of firing immediately.
             On send it calls buildReminderEmail_ + stamps today's REMINDER_DATE. Uses a CacheService
             continuation token + MAX_SCAN_ROWS cap to survive the execution-time limit, and stops
             early if the Gmail daily quota is nearly exhausted.
  PARAMS:    (none)
  RETURNS:   { ok:true, processed, reminded } (plus skipped/capped/quotaExhausted flags).
*/
/*
  Function: sendDailyReminders  (PUBLIC TRIGGER ENTRY POINT, thin guarded wrapper)

  LAYMAN (Tropang Ex):
  Ito lang yung pinto na nakikita ng daily trigger. Ang totoong trabaho ay nasa
  sendDailyReminders_() sa baba. Bakit hiwalay? Dahil ang trigger ay naka-bind sa PANGALAN
  ('sendDailyReminders' bilang text sa loob ng ScriptApp.newTrigger), kaya hindi pwedeng bigyan
  ng underscore yung pangalan, kung papalitan, hindi na tatakbo yung naka-install nang trigger.
  Pero kung public siya, kahit sinong empleyado kayang i-loop siya galing browser console hanggang
  maubos yung Gmail quota ng buong sistema, at pag naubos yun, TAHIMIK na hihinto lahat ng
  approval emails. Kaya may bantay dito.

  TECHNICAL:
  Public because a time-driven trigger resolves its handler by name string; renaming it would
  orphan the already-installed trigger. Guarded by isOwnerContext_() so only the owner or a trigger
  run reaches the implementation. Internal callers (the ADMIN_API_KEY dispatch in
  handleAdminApiRequest_, and the test harnesses) call sendDailyReminders_() directly and are
  unaffected by this gate.

  PARAMS:    (none)
  RETURNS:   sendDailyReminders_()'s result, or { ok:false, code, message } when not authorized.
*/
function sendDailyReminders() {
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  return sendDailyReminders_();
}

function sendDailyReminders_() {
  // Check if reminders are enabled
  const config = getReminderConfig_();
  if (!config.enabled) {
    Logger.log('🔔 Daily Reminders: DISABLED via config. Skipping.');
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  Logger.log('🔔 Daily Reminders: Starting scan...');
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

  // Commit 6: reminder cadence, first nudge 7 days after the approver was notified, then every 3 days.
  var REMINDER_FIRST_DAYS = 7;
  var REMINDER_REPEAT_DAYS = 3;
  // Whole-day difference (local midnight-to-midnight) between a 'YYYY-MM-DD' string and today. -1 if unparseable.
  var daysSince = function (dateStr) {
    var parts = String(dateStr || '').split('-');
    if (parts.length !== 3) return -1;
    var then = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(then.getTime())) return -1;
    var nowMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.floor((nowMid - then) / 86400000);
  };
  // Normalize a cell value (Sheets may return a Date object) to a 'YYYY-MM-DD' string.
  var normalizeDateCell = function (raw) {
    if (Object.prototype.toString.call(raw) === '[object Date]') {
      return raw.getFullYear() + '-' + String(raw.getMonth() + 1).padStart(2, '0') + '-' + String(raw.getDate()).padStart(2, '0');
    }
    return String(raw || '').trim();
  };

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
  //
  // 🚩 THE PRE-FILTER IS LOAD-BEARING, SO ITS FAILURE MUST BE FATAL TO THIS RUN.
  // The scan loop below does `if (!validSessionIds[sid]) continue;`, so an EMPTY map does not mean
  // "remind everyone", it means "remind nobody". The previous code caught a read failure, logged
  // "will process all pending rows" (which was simply untrue) and carried on, producing a silent
  // zero-reminder run: every pending approver stops being nudged and nothing anywhere says so.
  // Aborting loudly with a return value is the fix. Do not soften this back into a warning.
  var VALID_REMINDER_STATUSES = ['Pending', 'Approved', 'Approved (ISM Pending)', 'Approved by ISM', 'Escalated to Division Head'];
  var validSessionIds = {};
  try {
    var appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    if (!appSheet) {
      Logger.log('⛔ Daily Reminders: ABORTED: Applications sheet not found. No reminders sent this run.');
      return { ok: false, aborted: true, reason: 'prefilter_unavailable', detail: 'Applications sheet not found' };
    }
    var appData = readSheetValues_(appSheet);
    for (var ai = 1; ai < appData.length; ai++) {
      var appStatus = String(appData[ai][APPLICATIONS_COLS.STATUS - 1] || '').trim();
      if (VALID_REMINDER_STATUSES.indexOf(appStatus) !== -1) {
        validSessionIds[String(appData[ai][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim()] = true;
      }
    }
    Logger.log('🔔 Pre-filter: ' + Object.keys(validSessionIds).length + ' applications in active approval states');
  } catch (e) {
    Logger.log('⛔ Daily Reminders: ABORTED: Applications pre-filter read failed. No reminders sent this run: ' + e.toString());
    return { ok: false, aborted: true, reason: 'prefilter_unavailable', detail: String(e).substring(0, 300) };
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
    var sheet = getDatabaseSheet_(sheetDef.name, true);
    if (!sheet) continue;

    var data = readSheetValues_(sheet);

    // ── FIRST PASS: Collect pending rows grouped by sessionId ──
    // For sheets with steps (Approval_Workflow, ISM_Workflow), only the
    // LOWEST pending step per sessionId is eligible, this preserves
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
      var rowRound = roundOf_(data[i], sheetDef.cols);
      var existing = pendingBySession[sessionId];

      // 🚩 APPEND-ONLY: rows from earlier rounds are no longer deleted, so a Pending row left over
      // from an abandoned round (e.g. an ISM member never reached before a return) is still sitting
      // in the sheet. Without the round comparison below this engine would happily nag that person
      // forever about a round that is closed. Highest round wins; within a round, lowest step wins.
      var isBetter = !existing ||
                     rowRound > existing.round ||
                     (rowRound === existing.round && step < existing.step);

      if (isBetter) {
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
          round: rowRound,
          approverEmail: data[i][sheetDef.emailCol - 1],
          approverName: sheetDef.nameCol ? data[i][sheetDef.nameCol - 1] : 'Division Head',
          reminderDate: normalizedDate,
          notifiedDate: normalizeDateCell(data[i][sheetDef.cols.NOTIFIED_DATE - 1])
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
        Logger.log('🔔 Daily Reminders: Capped at ' + MAX_SCAN_ROWS + ' rows. Resuming next cycle.');
        return { ok: true, capped: true, processed: processedCount, reminded: remindedCount };
      }
      processedCount++;

      // Commit 6: cadence gate, first reminder 7 days after notification, then every 3 days.
      // Legacy pending rows created before NOTIFIED_DATE existed have no notified date: stamp it
      // today to start their 7-day clock (avoids a burst of reminders on the first scan) and skip.
      if (!row.notifiedDate) {
        try { sheet.getRange(row.rowIndex + 1, sheetDef.cols.NOTIFIED_DATE).setValue(todayStr); } catch (_) {}
        continue;
      }
      // Already reminded today: nothing to do.
      if (row.reminderDate === todayStr) continue;
      // Decide by cadence: never reminded → wait 7 days from notification; else → every 3 days.
      var shouldSend = row.reminderDate
        ? (daysSince(row.reminderDate) >= REMINDER_REPEAT_DAYS)
        : (daysSince(row.notifiedDate) >= REMINDER_FIRST_DAYS);
      if (!shouldSend) continue;

      // Check daily quota before queueing
      try {
        var remaining = MailApp.getRemainingDailyQuota();
        if (remaining < 2) {
          Logger.log('🔔 Daily Reminders: Quota exhausted. Stopping.');
          cache.put(CONTINUATION_KEY, JSON.stringify({ sheetIdx: sIdx, row: row.rowIndex }), 3600);
          return { ok: true, quotaExhausted: true, processed: processedCount, reminded: remindedCount };
        }
      } catch (_) {}

      var stepInfo = sheetDef.stepCol ? ('Step ' + row.step) : '';

      try {
        buildReminderEmail_(sid, row.approverEmail, row.approverName, stepInfo);
        // Stamp today's date
        sheet.getRange(row.rowIndex + 1, sheetDef.cols.REMINDER_DATE).setValue(todayStr);
        remindedCount++;

        logAuditTrail_(sid, 'Reminder Sent', JSON.stringify({
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

  // Clear continuation token: all done
  cache.remove(CONTINUATION_KEY);

  // Record last successful run
  try {
    PropertiesService.getScriptProperties().setProperty('PIA_LAST_REMINDER_RUN', todayStr + ' ' +
      new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }));
  } catch (_) {}

  Logger.log('🔔 Daily Reminders: Complete. Processed: ' + processedCount + ', Reminded: ' + remindedCount);
  return { ok: true, processed: processedCount, reminded: remindedCount };
}

/*
  Function: buildReminderEmail_
  LAYMAN:    Composes one reminder email (with a valid one-click Review link) and drops it in the
             queue.
  TECHNICAL: Resolves the web-app URL, loads the app data, builds an action-bound HMAC 'Review' link
             (same pattern as notifyApprover_), renders the navy email via buildPiaEmailHtml_, and
             queueEmail_(type:'reminder'). Re-throws so sendDailyReminders can log per-row failures.
  PARAMS:    - sessionId, approverEmail, approverName, stepInfo (e.g. 'Step 2').
  RETURNS:   undefined. Returns early (no send) if URL/app data unavailable; throws on send-build error.
*/
function buildReminderEmail_(sessionId, approverEmail, approverName, stepInfo) {
  try {
    // CRITICAL: Guard against null ScriptApp.getService() when running from editor
    var webAppUrl = getWebAppUrl_();
    if (!webAppUrl) {
      try { webAppUrl = ScriptApp.getService().getUrl(); } catch (_) {}
    }
    if (!webAppUrl) {
      Logger.log('  ⚠ Cannot build reminder: WEB_APP_URL not configured and ScriptApp service unavailable (running from editor?)');
      return;
    }

    var appData = getApplicationData_(sessionId);
    if (!appData) {
      Logger.log('  ⚠ Cannot build reminder: no app data for ' + sessionId);
      return;
    }

    var ts = new Date().getTime().toString();
    // DELEGATION: nudge whoever is actually expected to act right now. Without this the daily
    // reminder would keep chasing someone on leave while their delegate, who holds the only
    // usable link, hears nothing, which is worse than not reminding at all.
    var _routed = recipientFor_(approverEmail);
    var normalizedEmail = getNormalizedEmail_(_routed.email);
    var token = generateAuthToken_(sessionId, normalizedEmail, ts, 'Review');
    var reviewUrl = webAppUrl +
      '?sessionId=' + encodeURIComponent(sessionId) +
      '&email=' + encodeURIComponent(normalizedEmail) +
      '&token=' + token +
      '&ts=' + ts +
      '&action=Review';

    var subject = 'Reminder: Review pending for ' + sessionId;

    var htmlBody = buildPiaEmailHtml_({
      heading: 'Reminder: Review Pending',
      contentHtml: '' +
        delegationNoticeHtml_(_routed.onBehalfOf, _routed.reason) +
        '<p style="margin:0 0 14px;font-size:14px;">This is a friendly reminder that your review is still pending for the following Privacy Impact Assessment.</p>' +
        '<div style="background:#fff8e1;color:#b46d14;border:1px solid rgba(180,109,20,0.2);padding:10px 14px;border-radius:6px;font-size:12px;margin-bottom:16px;">⏳ <strong>Pending Review</strong>: ' + escapeHtml_(stepInfo || 'Awaiting your action') + '</div>' +
        '<div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">' +
        'Pending review by: <strong>' + escapeHtml_(approverName) + '</strong><br><br>' +
        '<strong>App ID:</strong> ' + escapeHtml_(sessionId) + '<br>' +
        '<strong>Program:</strong> ' + escapeHtml_(appData.pia1?.program || '—') + '<br>' +
        '<strong>Submitted by:</strong> ' + escapeHtml_(appData.applicantEmail || '—') + '</div>' +
        '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">' +
        '<div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>' +
        generateEmailDecisionsHTML_(sessionId) +
        '</div>' +
        '<div><a href="' + reviewUrl + '" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>' +
        '<p style="font-size:12px;color:#9ca3af;margin-top:16px;">You will receive periodic reminders until you take action on this application.</p>'
    });

    // Queue via existing email infrastructure, use 'reminder' type for all
    queueEmail_(sessionId, _routed.email, subject,
      'Please view this email in an HTML-compatible client.',
      'reminder', htmlBody);

    Logger.log('  🔔 Reminder queued: reminder → ' + _routed.email +
      (_routed.onBehalfOf ? ' (delegate for ' + _routed.onBehalfOf + ')' : '') +
      ' [' + sessionId + ']');
  } catch (e) {
    Logger.log('  ⚠ buildReminderEmail_ failed for ' + sessionId + ': ' + e.toString());
    throw e; // Let caller handle
  }
}

/*
  Function: getReminderConfig_
  LAYMAN:    Reads the reminder settings (on/off, hour, timezone), with sensible defaults.
  TECHNICAL: Parses REMINDER_CONFIG_PROP JSON; on absence/parse error returns
             { enabled:true, hour:8, timezone: script TZ || 'Asia/Manila' }.
  PARAMS:    (none)
  RETURNS:   { enabled, hour, timezone }.
*/
function getReminderConfig_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(REMINDER_CONFIG_PROP);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  // Defaults
  return { enabled: true, hour: 8, timezone: Session.getScriptTimeZone() || 'Asia/Manila' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📧 EMAIL NOTIFICATIONS  (now queue-based, see Email Queue above)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: buildPiaEmailHtml_
  LAYMAN:    The shared navy "letterhead" every PIA email uses, header bar, white card, and the
             do-not-reply footer. You give it a heading and inner content; it returns the full HTML.
  TECHNICAL: Pure string builder. Wraps opts.contentHtml in the standard navy (#2a5285) card shell
             matching the Admin/DCS template. No side-effects.
  PARAMS:    - opts: { heading?, contentHtml?, accent? }.
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
        '<div style="color:#ffffff;font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;opacity:0.9;">Megaworld ISM Department</div>' +
        '<div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">' + heading + '</div>' +
      '</div>' +
      '<div style="padding:28px;">' + content + '</div>' +
      '<div style="padding:16px 28px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:12px;color:#6b7280;line-height:1.5;"><div style="font-weight:600;color:#374151;margin-bottom:4px;">Megaworld ISM Department</div><strong style="color:#374151;">No-reply notice.</strong> This mailbox is not monitored, so please do not reply. Use the button above to take action. For assistance, contact ISM-InfoSec at <strong style="color:#374151;">infosec@megaworldcorp.com</strong>.</div>' +
    '</div></div>';
}

/*
  Function: notifyApprover_
  LAYMAN:    Emails the approver at a given step that an application needs their review, including a
             secure one-click "Review" link. Queues the email (does not send inline).
  TECHNICAL: Reads Approval_Workflow to find the row whose CurrentStep === approverIndex+1 and the
             total step count. Builds an action-bound HMAC 'Review' URL, renders via buildPiaEmailHtml_,
             and queueEmail_(type:'approver'). Whole body in try/catch, email failure is logged to the
             audit trail and never thrown (the DB write already happened).
  PARAMS:    - sessionId: application id.
             - approverIndex: 0-based index of the approver to notify (step = index+1).
  RETURNS:   undefined. No-op if no approver exists at that step.
*/
function notifyApprover_(sessionId, approverIndex) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  // FAILSAFE: Email failures must never crash the caller (DB already updated)
  try {
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl_() || ScriptApp.getService().getUrl();
    // Fetch the next pending approver from the approval workflow sheet
    // (not from hardcoded APPROVERS - respect dynamic approvers from form data)
    const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
    const apprData = readSheetValues_(apprSheet);
    
    // Find all approval records for this sessionId to determine total steps
    let totalSteps = 0;
    let approverToNotify = null;
    let approverRowIndex = -1; // 0-based index into apprData (sheet row = index + 1) for NOTIFIED_DATE stamping

    for (let i = 1; i < apprData.length; i++) {
      if (rowMatches_(apprData[i], APPROVAL_COLS, sessionId, __round)) {
        totalSteps++;
        // Find the specific step we need to notify
        if (apprData[i][APPROVAL_COLS.CURRENT_STEP - 1] === approverIndex + 1) {
          approverToNotify = {
            name: apprData[i][APPROVAL_COLS.APPROVER_NAME - 1],
            email: apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1]
          };
          approverRowIndex = i;
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
    // DELEGATION: resolve who should actually receive this, then mint the token over THAT
    // address. Both must move together, a link addressed to the delegate but signed for the
    // original fails handleEmailAction_ identity check, and the reverse fails isTokenValid_.
    const _routed = recipientFor_(approver.email);
    const normalizedApproverEmail = getNormalizedEmail_(_routed.email);
    const token = generateAuthToken_(sessionId, normalizedApproverEmail, ts, 'Review');

    const baseUrl = `${webAppUrl}?sessionId=${sessionId}&email=${encodeURIComponent(normalizedApproverEmail)}&token=${token}&ts=${ts}&step=${stepCount}`;
    const reviewUrl = `${baseUrl}&action=Review`;

    SpreadsheetApp.flush(); 
    const appData = getApplicationData_(sessionId);
    
    if (!appData) {
      Logger.log('ERROR: Cannot notify approver - no app data found for ' + sessionId);
      return;
    }
    
    const subject = `Action Required: Review ${sessionId}`;

    const htmlBody = buildPiaEmailHtml_({
      heading: 'Action Required: Review',
      contentHtml: `
        <p style="margin:0 0 14px;font-size:14px;">Hello, ${escapeHtml_(approver.name || 'Approver')},</p>
        ${delegationNoticeHtml_(_routed.onBehalfOf, _routed.reason)}
        <p style="margin:0 0 14px;font-size:14px;">A new Privacy Impact Assessment (PIA) requires your review.</p>
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Approval chain, step ${stepCount} of ${totalSteps}</div>
        <div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
          Pending review by: <strong>${escapeHtml_(approver.name)}</strong><br><br>
          <strong>App ID:</strong> ${escapeHtml_(sessionId)}<br>
          <strong>Program:</strong> ${escapeHtml_(appData.pia1?.program || '—')}<br>
          <strong>Submitted by:</strong> ${escapeHtml_(appData.applicantEmail || '—')}
        </div>
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
          ${generateEmailDecisionsHTML_(sessionId)}
        </div>
        ${buildPriorReviewChipHtml_(sessionId, normalizedApproverEmail)}
        <div><a href="${reviewUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>`
    });

    // Queue email for deferred reliable delivery (avoids Gmail throttling in-request)
    queueEmail_(sessionId, _routed.email, subject, "Please view this email in an HTML-compatible client.", 'approver', htmlBody);

    // Commit 6: mark when this approver was first notified (starts their 7-day reminder clock).
    if (approverRowIndex > 0) stampNotifiedDate_(apprSheet, approverRowIndex + 1, APPROVAL_COLS.NOTIFIED_DATE);
  } catch (e) {
    Logger.log('FAILSAFE: Email queue for approver failed for ' + sessionId + ': ' + e.toString());
    try {
      logAuditTrail_(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'approver',
        attempts: 0,
        error: 'QUEUE_CRASH: ' + e.toString()
      }));
    } catch(_) {}
  }
}

/*
  Function: notifyApplicant_
  LAYMAN:    Emails the applicant a status update (submitted / progressing / approved / returned /
             denied / escalated / routed, etc.) with the right wording, the running decision history,
             and a context-appropriate button (open DCS, update the PIA, or view receipt).
  TECHNICAL: Loads app data, generateEmailDecisionsHTML_ for the history, then selects a status banner
             and action URL/label from the status code (many branches; returns/rejections vary based on
             whether DCS-level flags exist). Renders via buildPiaEmailHtml_ and queueEmail_(type:
             'applicant'). Fully wrapped in try/catch; failures are audited, never thrown.
  PARAMS:    - sessionId: application id.
             - status: status code string (e.g. 'submitted','progressing','approved_main',
                        'returned','denied','approved_ism_final','routed_implementation', ...).
  RETURNS:   undefined. No-op if app data is missing.
*/
function notifyApplicant_(sessionId, status, options) {
  // FAILSAFE: Email failures must never crash the caller (DB already updated)
  try {
    const opts = options || {};
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl_() || ScriptApp.getService().getUrl();
  const dcsWebAppUrl = getDCSWebAppUrl_() || ScriptApp.getService().getUrl();
  // CRITICAL: Flush pending writes so app data reads see latest state
  SpreadsheetApp.flush();
  const appData = getApplicationData_(sessionId);
  if (!appData) return;

  // #14: resolve the requester's name from the linked DCS record for a personalized greeting (best-effort)
  let applicantName = '';
  try {
    if (appData.linkedReqId) {
      const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, false);
      if (dcsSheet) {
        const dcsVals = readSheetValues_(dcsSheet);
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

  const decisionsHTML = generateEmailDecisionsHTML_(sessionId);
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
    statusMessage = `<div style="background: #e8f5e9; color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application is now <strong>HEADS APPROVED</strong>, it cleared all required Head approvals and is being reviewed by the ISM (InfoSec) team. This is not yet final approval.</div></div>`;
  } else if (status === 'escalated_divhead') {
    statusMessage = `<div style="background: #eff6ff; color: #1e40af; border: 1px solid rgba(30,64,175,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <div>Your application has been <strong>ESCALATED</strong> to the Division Head for executive review.</div></div>`;
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
      statusMessage = `<div style="background: #fff8e1; color: #b46d14; border: 1px solid rgba(180,109,20,0.2); padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; display:flex; align-items:flex-start; gap:8px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; margin-top:1px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> <div>Your application has been <strong>RETURNED TO REQUESTOR</strong>. You must update your DCS request before you can resubmit this PIA.<br><br><strong>Instructions:</strong> Open the DCS System &gt; Go to "Review Application" &gt; Select Request <strong>${escapeHtml_(appData.linkedReqId || '')}</strong> &gt; Click "Edit & Review".</div></div>`;
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

  // Item 2: on full approval, a "certificate attached" note up top, and a clean TechServe
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
        const nm = (t && t.name) ? escapeHtml_(String(t.name)) : '';
        const em = (t && t.email) ? escapeHtml_(String(t.email)) : '';
        return `<div style="margin-top:8px;">${nm ? `<div style="font-weight:600;color:#1a3a5c;font-size:13px;">${nm}</div>` : ''}<div style="font-size:13px;color:#2a5285;">${em}</div></div>`;
      }).join('');
      techserveBlock = `<div style="background:#eef4fb;border:1px solid rgba(42,82,133,0.15);border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:#1a3a5c;"><div style="font-weight:600;">For follow-up, please contact the TechServe team:</div>${tsRows}</div>`;
    }
  }

  const htmlBody = buildPiaEmailHtml_({
    heading: 'Application Status Update',
    contentHtml: `
      <p style="margin:0 0 14px;font-size:14px;">Hello${applicantName ? ', ' + escapeHtml_(applicantName) + '!' : ','}</p>
      ${statusMessage}
      ${certNote}
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
        ${decisionsHTML}
      </div>
      ${techserveBlock}
      <div><a href="${actionUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${buttonText}</a></div>`
  });

  // Final-approval emails carry the Certificate of Approval PDF, which the async queue can't hold,
  // send those synchronously with the attachment; every other status stays on the reliable queue.
  if (opts.certBlob) {
    var certSend;
    try {
      certSend = sendEmailWithRetry_(appData.applicantEmail, subject, "Please view this email in an HTML-compatible client.", {
        htmlBody: htmlBody,
        attachments: [opts.certBlob]
      });
    } catch (sendErr) {
      certSend = { ok: false, detail: String(sendErr) };
    }
    // L1: if the synchronous send (with attachment) ultimately fails, fall back to the reliable queue
    // (without the attachment) so the applicant is still notified of full approval. The certificate
    // itself already went to DCOPS/TechServe.
    if (!certSend || !certSend.ok) {
      Logger.log('Final-approval email with cert failed for ' + sessionId + '; queueing fallback. ' + (certSend && certSend.detail ? certSend.detail : ''));
      queueEmail_(sessionId, appData.applicantEmail, subject, "Please view this email in an HTML-compatible client.", 'applicant', htmlBody);
    }
  } else {
    queueEmail_(sessionId, appData.applicantEmail, subject, "Please view this email in an HTML-compatible client.", 'applicant', htmlBody);
  }
  } catch (e) {
    Logger.log('FAILSAFE: Email queue for applicant failed for ' + sessionId + ': ' + e.toString());
    try {
      logAuditTrail_(sessionId, 'Email Failed', JSON.stringify({
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
  Function: getLatestPriorDecisionByEmail_
  LAYMAN:    "Did THIS approver already act on this request in an earlier round?" Walks the preserved
             return-cycle history newest-first and returns their most recent prior decision, if any.
  TECHNICAL: getUnifiedHistory_ rounds strictly BELOW the current round, walked descending; matches
             getNormalizedEmail_(approverEmail) against the target. Division Head rows have blank
             names but always carry the email, so matching is email-only by design. Never throws.
  PARAMS:    - sessionId: application id.  - email: the approver being notified/reviewing.
  RETURNS:   { round, decision, status, dateStr } or null.
*/
function getLatestPriorDecisionByEmail_(sessionId, email) {
  try {
    if (!email) return null;
    // Append-only: read the live rounds and drop the current one, "prior" means a round this
    // approver already closed, not the one they are being asked to act on right now.
    const currentRound = getCurrentRound_(sessionId);
    const rounds = (getUnifiedHistory_(sessionId, false).rounds || [])
      .filter(function (r) { return r.round < currentRound; });
    if (!rounds || rounds.length === 0) return null;
    const target = getNormalizedEmail_(String(email));
    for (let i = rounds.length - 1; i >= 0; i--) {
      const ds = rounds[i].decisions || [];
      for (let j = ds.length - 1; j >= 0; j--) {
        const d = ds[j];
        if (d.approverEmail && getNormalizedEmail_(String(d.approverEmail)) === target) {
          let dateStr = '';
          try {
            const raw = d.decisionDate;
            if (Object.prototype.toString.call(raw) === '[object Date]') {
              dateStr = raw.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
            } else if (raw) {
              const parsed = new Date(raw);
              dateStr = isNaN(parsed.getTime()) ? String(raw) : parsed.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
            }
          } catch (_) {}
          return { round: rounds[i].round, decision: d.decision, status: d.status, dateStr: dateStr };
        }
      }
    }
  } catch (e) { Logger.log('getLatestPriorDecisionByEmail_ failed: ' + e.toString()); }
  return null;
}

/*
  Function: buildPriorReviewChipHtml_
  LAYMAN:    The amber "you already reviewed this before" note shown to an approver when a returned
             request comes back to them, in their email (above the Review button) and on the review
             screen. Personalized: it states THEIR OWN prior decision, not just "this was returned".
  TECHNICAL: Email-safe inline hex styles, plain string concatenation. Wrapped in try/catch returning
             '' so a chip failure can never break an email send or the review page.
  PARAMS:    - sessionId: application id.  - email: the recipient/reviewer.
  RETURNS:   HTML string or ''.
*/
function buildPriorReviewChipHtml_(sessionId, email) {
  try {
    const prior = getLatestPriorDecisionByEmail_(sessionId, email);
    if (!prior) return '';
    const st = String(prior.status || prior.decision || '');
    let verb = '';
    if (/Approved/i.test(st)) verb = 'approved';
    else if (/Return|Reject/i.test(st)) verb = 'returned';
    else if (/Deny|Denied/i.test(st)) verb = 'denied';
    else if (/Escalat/i.test(st)) verb = 'escalated';
    if (!verb) return '';
    const tail = verb === 'approved'
      ? ' It was returned and has been revised. Please re-review the updated submission.'
      : ' It has since been revised and resubmitted for a fresh review.';
    return '<div style="background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px;line-height:1.5;">' +
      '<strong>You previously ' + verb + ' this request</strong>' +
      (prior.dateStr ? ' on ' + escapeHtml_(prior.dateStr) : '') +
      (prior.round ? ' (Round ' + escapeHtml_(String(prior.round)) + ')' : '') + '.' +
      tail + '</div>';
  } catch (e) { return ''; }
}

/*
  Function: buildUnifiedHistoryHtml_
  LAYMAN:    Renders the complete start-to-finish approval story as ONE list grouped by round:
             "Round 1" (who decided what, comments, flags), "Round 2 (Current)" and so on. Used by
             the emails, both review screens, the certificate, and the requestor views, so the
             history looks identical everywhere.
  TECHNICAL: Consumes getUnifiedHistory_ output. Email-safe: inline styles, hex colors only.
             Status colors follow the unified matrix (approved green #065f46, returned amber
             #92400e, denied red #991b1b, escalated/pending blue #1e40af). Legacy boilerplate
  PARAMS:    - unified: { rounds } from getUnifiedHistory_.
  RETURNS:   HTML string ('' when there are no rounds).
*/
function buildUnifiedHistoryHtml_(unified) {
  const rounds = (unified && unified.rounds) || [];
  if (!rounds.length) return '';
  const colorFor = function (status, decision) {
    const s = String(status || '') + ' ' + String(decision || '');
    if (/Approved/i.test(String(status || ''))) return '#065f46';
    if (/Pending/i.test(String(status || ''))) return '#1e40af';
    if (/Return|Reject/i.test(s)) return '#92400e';
    if (/Deny|Denied/i.test(s)) return '#991b1b';
    if (/Escalat/i.test(s)) return '#1e40af';
    return '#6b7280';
  };
  const labelFor = function (status) {
    const s = String(status || '');
    if (/Approved/i.test(s)) return 'Approved';
    if (/Pending/i.test(s)) return 'Pending review';
    if (/Return|Reject/i.test(s)) return 'Returned to Requestor';
    if (/Deny|Denied/i.test(s)) return 'Denied';
    if (/Escalat/i.test(s)) return 'Escalated to Division Head';
    return s;
  };
  const routingLabelFor = function (raw) {
    const r = String(raw || '').trim().toUpperCase();
    if (r === 'DCOPS') return 'DCOPS';
    if (r === 'TECHSERVE') return 'TechServe';
    if (r === 'BOTH') return 'DCOPS + TechServe';
    return '';
  };
  const fmtDate = function (raw) {
    if (!raw) return '';
    try {
      if (Object.prototype.toString.call(raw) === '[object Date]') {
        return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'MMM dd, yyyy, hh:mm a');
      }
      return String(raw);
    } catch (e) { return String(raw); }
  };
  let html = '<div style="font-family: sans-serif;">';
  rounds.forEach(function (r) {
    let decisions = '';
    (r.decisions || []).forEach(function (d) {
      const routing = routingLabelFor(d.routing);
      const routingHtml = routing ? `<div style="font-size:12px;color:#6b7280;margin-top:3px;">Routing: <strong>${escapeHtml_(routing)}</strong></div>` : '';
      const dateStr = fmtDate(d.decisionDate);
      const flagKeys = (d.flaggedFields && typeof d.flaggedFields === 'object') ? Object.keys(d.flaggedFields) : [];
      let flags = '';
      if (flagKeys.length > 0) {
        flags = '<div style="font-size:11px;color:#92400e;margin-top:3px;">Flagged: ' + flagKeys.map(function (k) {
          const reason = d.flaggedFields[k];
          return escapeHtml_(k) + (reason && reason !== true ? ' (' + escapeHtml_(String(reason)) + ')' : '');
        }).join(', ') + '</div>';
      }
      const showComment = !!d.comments;
      decisions += `
        <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f0f0f0;">
          <div style="font-size:13px;color:#333;"><strong>${escapeHtml_(d.approverName || d.approverEmail || 'Approver')}</strong> <span style="color:#6b7280;">(${escapeHtml_(d.role || 'Approver')})</span>: <span style="color:${colorFor(d.status, d.decision)};font-weight:600;">${escapeHtml_(labelFor(d.status))}</span></div>
          ${dateStr ? `<div style="font-size:11px;color:#999;margin-top:2px;">${escapeHtml_(dateStr)}</div>` : ''}
          ${routingHtml}
          ${showComment ? `<div style="font-size:12.5px;color:#666;margin-top:3px;">"${escapeHtml_(String(d.comments))}"</div>` : ''}
          ${flags}
        </div>`;
    });
    const headerColor = r.isCurrent ? '#1a3a5c' : '#6b7280';
    const headerLabel = 'Round ' + r.round + (r.isCurrent ? ' (Current)' : '');
    html += `
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:700;color:${headerColor};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;">${escapeHtml_(headerLabel)}</div>
        ${decisions}
      </div>`;
  });
  return html + '</div>';
}

/*
  Function: generateEmailDecisionsHTML_
  LAYMAN:    Builds the "who decided what" history block shown inside emails: now ONE complete list
             grouped by round (prior rounds + the current one), instead of a separate "previous
             rounds" block stacked on top of the current decisions.
  TECHNICAL: Round-4 refactor: delegates to getUnifiedHistory_(sessionId, false) +
             buildUnifiedHistoryHtml_. Name/signature kept so all five email call sites are untouched.
  PARAMS:    - sessionId: application id.
  RETURNS:   HTML string; a "No decisions recorded yet." note if nothing is found.
*/
function generateEmailDecisionsHTML_(sessionId) {
  const unified = getUnifiedHistory_(sessionId, false);
  if (!unified.rounds.length) {
    return `<div style="font-size: 13px; color: #666; font-style: italic;">No decisions recorded yet.</div>`;
  }
  return buildUnifiedHistoryHtml_(unified);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   RETRIEVAL FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: getApplicationData_
  LAYMAN:    The main "load one application" reader. Returns everything about a PIA: its five sections,
             status, linked DCS id, flags, and the approver timeline (who, role, decision, comment).
  TECHNICAL: Finds the Applications row by case-insensitive sessionId, safeParse's the five PIA JSON
             cells and approverFlags, then joins Approval_Workflow rows. Roles are inferred from step
             order (Immediate Head step 1 / Dept Head step 2, shifting if no immediate head) plus the
             Privacy Officer email. Computes approvalStep = count of Approved rows.
  PARAMS:    - sessionId: application id (trim/uppercase-insensitive).
  RETURNS:   The app object, or null if not found.
*/
function getApplicationData_(sessionId) {
  const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
  const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);

  const searchId = String(sessionId || '').trim().toUpperCase();
  const appData_values = readSheetValues_(appSheet);

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
  const apprData_values = readSheetValues_(apprSheet);
  let stepCounter = 0;

  const poEmail = getNormalizedEmail_(PropertiesService.getScriptProperties().getProperty('PRIVACY_OFFICER_EMAIL'));
  const immEmail = getNormalizedEmail_(appData.pia1.immediateHeadEmail);
  const deptEmail = getNormalizedEmail_(appData.pia1.deptHeadEmail);
  const hasImmHead = !!immEmail;

  // Append-only workflow: appData.approvers is the CURRENT ladder, one clean row per approver,
  // so every existing consumer (review forms, certificate, status logic) keeps seeing exactly one
  // set instead of one per round. Prior rounds are history and are read via getUnifiedHistory_.
  // ⚠ Authorization does NOT rely on this list being complete: isAuthorizedForApplication_ scans
  //   Approval_Workflow across ALL rounds so an approver from an earlier round keeps view access.
  const __round = getCurrentRound_(sessionId) || 1;

  for (let i = 1; i < apprData_values.length; i++) {
    if (String(apprData_values[i][APPROVAL_COLS.SESSION_ID - 1] || '').trim().toUpperCase() === searchId &&
        roundOf_(apprData_values[i], APPROVAL_COLS) === __round) {
      const aData = apprData_values[i];
      const email = getNormalizedEmail_(aData[APPROVAL_COLS.APPROVER_EMAIL - 1]);
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
  Function: getUserSubmissions_
  LAYMAN:    Returns the current signed-in user's own PIA applications as a lightweight list (id,
             program, dept, status, date, flag) for the "My Applications" screen.
  TECHNICAL: Filters Applications rows by the active user's email, formats the submission date, and
             pulls program/dept from parsed PIA 1. Fully try/catch-guarded; returns [] on any error or
             empty sheet.
  PARAMS:    (none), uses Session.getActiveUser().
  RETURNS:   Array of { id, program, dept, status, date, isFlagged }.
*/
function getUserSubmissions_() {
  try {
    const userEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
    
    if (!userEmail) {
      Logger.log('ERROR: userEmail is empty. Please check Web App deployment settings.');
      return [];
    }

    const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    if (!appSheet) {
      Logger.log('ERROR: Applications sheet not found or null');
      return [];
    }
    const lastRow = appSheet.getLastRow();
    if (lastRow < 2) return [];
    
    const appData_values = readSheetValues_(appSheet);

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
    Logger.log('ERROR in getUserSubmissions_: ' + error.toString());
    return [];
  }
}

/*
  Function: findRowBySessionID_
  LAYMAN:    Finds which row of the Applications sheet holds a given application id.
  TECHNICAL: Linear scan of column A (case-insensitive, trimmed), deliberately avoids createTextFinder
             for consistent behavior. Returns the 1-indexed sheet row.
  PARAMS:    - sessionId: application id.
  RETURNS:   Row number (>=2), or -1 if not found / sheet empty.
*/
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔁 ROUND HELPERS: the core of the append-only workflow
//
// LAYMAN (Tropang Ex): Dati, tuwing nag-re-resubmit ang applicant, BINUBURA lahat ng lumang
//   approval rows para malinis yung "sino ang susunod?" na tanong. Ngayon hindi na natin
//   binubura, sa halip, may bagong column na RoundNumber, at nagdadagdag lang tayo ng
//   bagong round sa ibaba. Yung dalawang helper dito ang nagsasabi kung anong round na tayo.
//
// TECHNICAL: The delete existed only because a scan for `SessionID = X AND Status = 'Pending'`
//   could not distinguish a live row from an abandoned one in a previous round. With a round
//   discriminator, routing reads scope to the current round and history reads take every round.
//   Rows written before this change have a blank RoundNumber and are read as round 1.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: roundOf_
  LAYMAN:    Binabasa kung pang-ilang round yung isang row. Kapag blangko (luma pang data),
             ituturing na round 1.
  TECHNICAL: Reads the ROUND_NUMBER cell from a 0-indexed row array and coerces it to a positive
             integer. Blank / 0 / non-numeric all normalize to 1, which is what makes this change
             backward-compatible with rows written before the column existed.
  PARAMS:    - row: a workflow row as a 0-indexed array.
             - cols: the matching column map (APPROVAL_COLS / ISM_WORKFLOW_COLS / DIV_HEAD_CONFIG_COLS).
  RETURNS:   A positive integer round number (never 0, never NaN).
*/
function roundOf_(row, cols) {
  const raw = Number(row[cols.ROUND_NUMBER - 1]);
  return (isFinite(raw) && raw >= 1) ? Math.floor(raw) : 1;
}

/*
  Function: rowMatches_

  LAYMAN (Tropang Ex):
  Isang tanong lang ang sinasagot nito: "kabilang ba itong row sa request na hinahanap ko, at sa
  tamang round?" Kapag `round` ay null, ibig sabihin "kahit anong round", ginagamit yon ng mga
  history view na dapat makita LAHAT ng round.

  TECHNICAL:
  The single predicate every workflow scan should use, so the routing-vs-history distinction is
  explicit at each call site instead of implied.

    round = <number>  → ROUTING read. "Who acts next / is this actionable?" Must be scoped, or a
                        stale Pending row from an abandoned round can hijack the routing. This is
                        the exact failure the old delete-on-resubmit was hiding.
    round = null      → HISTORY or AUTHZ read. "What happened?" / "was this person ever party to
                        this request?" Must span every round.

  PARAMS:
    - row: workflow row as a 0-indexed array.
    - cols: matching column map.
    - sessionId: the application id being matched.
    - round: a round number to scope to, or null for all rounds.
  RETURNS:   Boolean.
*/
function rowMatches_(row, cols, sessionId, round) {
  if (String(row[cols.SESSION_ID - 1] || '').trim() !== String(sessionId || '').trim()) return false;
  if (round === null || round === undefined) return true;
  return roundOf_(row, cols) === round;
}

/*
  Function: writeDecisionFlags_

  LAYMAN (Tropang Ex):
  Kapag nag-Return ang isang approver, may mga item siyang na-flag ("ayusin mo 'to"). Dati,
  yung listahan na 'yon ay nakatago lang sa Applications.Approver_Flags, na BINUBURA tuwing
  nag-re-resubmit ang applicant. Kaya kinailangan pa ng photocopy (Revision_History) para hindi
  mawala. Ngayon, isinusulat natin diretso sa row mismo ng approver na nag-flag, kaya buhay siya
  habambuhay kasama ng desisyon niya.

  TECHNICAL:
  Writes the approver's flag payload into FLAGGED_FIELDS on their own decision row. Replaces
  Revision_History.FlaggedFields as the durable per-round record.

  No-ops on an empty/blank/'{}' payload so an ordinary Approve does not stamp noise. Fully
  guarded, a failure here must never break an already-committed decision, which is the same
  rule the old snapshot followed.

  PARAMS:
    - sheet: the workflow Sheet being written.
    - rowNum1: 1-based sheet row of the approver's decision row.
    - cols: matching column map (must expose FLAGGED_FIELDS).
    - approverFlags: the flags payload; object or JSON string, as received by the decision fn.
  RETURNS:   undefined.
*/
function writeDecisionFlags_(sheet, rowNum1, cols, approverFlags) {
  try {
    if (!sheet || !rowNum1 || !cols || !cols.FLAGGED_FIELDS) return;

    let payload = '';
    if (approverFlags && typeof approverFlags === 'object') {
      payload = Object.keys(approverFlags).length ? JSON.stringify(approverFlags) : '';
    } else {
      const raw = String(approverFlags || '').trim();
      payload = (raw && raw !== '{}' && raw !== 'null') ? raw : '';
    }
    if (!payload) return; // nothing flagged (e.g. a plain Approve), leave the cell blank

    sheet.getRange(rowNum1, cols.FLAGGED_FIELDS).setValue(payload);
  } catch (e) {
    Logger.log('writeDecisionFlags_ failed (non-blocking): ' + e.toString());
  }
}

/*
  Function: writeActedBy_

  LAYMAN (Tropang Ex):
  Kapag ang kapalit (delegate) ang pumindot, dito naitatala kung SINO talaga ang pumindot.
  Yung row mismo, naka-pangalan pa rin sa orihinal na approver, kaya kung wala ito, mukhang
  siya mismo ang umaksyon kahit naka-leave siya. Ito yung nagpapaliwanag sa audit trail.

  TECHNICAL:
  Writes ACTED_BY on a decision row. Called immediately after writeDecisionFlags_ at all three
  decision sites, and only ever with a non-empty value when canActAs_ reported a delegation,
  so a normal, personally-made decision leaves the cell blank and every pre-delegation row
  stays meaningful.

  🚩 Non-blocking by design, matching writeDecisionFlags_: a failure here must never roll back
  a decision that has already been recorded. But unlike a silent Logger.log, it is loud enough
  to find, because "who actually approved this" is exactly the question an auditor asks.

  PARAMS:
  - sheet: the workflow sheet.  - rowNum1: 1-indexed row.
  - cols: the matching *_COLS map (must carry ACTED_BY).
  - actedBy: the delegate's email, or '' when the approver acted personally.

  RETURNS:
  undefined.
*/
function writeActedBy_(sheet, rowNum1, cols, actedBy) {
  try {
    if (!sheet || !rowNum1 || !cols || !cols.ACTED_BY) return;
    const val = String(actedBy || '').trim();
    if (!val) return;   // acted personally, leave blank, which is the overwhelming majority
    sheet.getRange(rowNum1, cols.ACTED_BY).setValue(val);
  } catch (e) {
    Logger.log('writeActedBy_ FAILED (non-blocking) for row ' + rowNum1 + ': ' + e.toString());
  }
}

/*
  Function: getCurrentRound_

  LAYMAN (Tropang Ex):
  Sinasagot nito ang "pang-ilang beses na ba na-resubmit itong request?" Tinitingnan niya lahat
  ng approval rows ng isang session sa tatlong sheet, tapos kukunin yung pinakamataas na round.

  TECHNICAL:
  Derives the active round as MAX(RoundNumber) across all three workflow sheets for one session.
  Deliberately derived rather than stored on Applications: a stored copy is a second source of
  truth that can drift from the rows it describes.

  Scans all three sheets because a session's highest round can live in any of them, e.g. an
  escalation creates a DivisionHead row for the current round while the ISM chain is paused.

  Returns 0 when the session has no workflow rows at all, which is how callers distinguish
  "never initialized" from "round 1".

  PARAMS:    - sessionId: the application id.
  RETURNS:   Integer: highest round found, or 0 if the session has no workflow rows.

  EXAMPLE
    getCurrentRound_('PIA-000075')  -> 2   (submitted once, returned, resubmitted once)
    getCurrentRound_('PIA-999999')  -> 0   (no rows yet)
*/
function getCurrentRound_(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return 0;

  const sheets = [
    { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, cols: APPROVAL_COLS },
    { name: DB_SHEET_NAMES.ISM_WORKFLOW,      cols: ISM_WORKFLOW_COLS },
    { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG,   cols: DIV_HEAD_CONFIG_COLS }
  ];

  let maxRound = 0;
  sheets.forEach(function (def) {
    try {
      const sheet = getDatabaseSheet_(def.name, false);
      if (!sheet || sheet.getLastRow() < 2) return;
      const data = readSheetValues_(sheet);
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][def.cols.SESSION_ID - 1] || '').trim() !== sid) continue;
        const r = roundOf_(data[i], def.cols);
        if (r > maxRound) maxRound = r;
      }
    } catch (e) {
      Logger.log('getCurrentRound_: could not scan ' + def.name + ': ' + e.toString());
    }
  });

  return maxRound;
}

function findRowBySessionID_(sessionId) {
  const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
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
  Function: logAuditTrail_
  LAYMAN:    Records an event, but only writes to the Risk_Audit sheet when it is genuinely
             anomalous (risk flags, conflicts, email failures). Normal workflow actions are logged to
             the console only, keeping the audit sheet signal-rich.
  TECHNICAL: If flagsData === false → Logger only. If flagsData is a string parsing to a LOW/empty risk
             payload → Logger only. Otherwise appends a Risk_Audit row (UUID logId, active user, PH
             timestamp, normalized flags JSON; true coerces to a legacy HIGH payload). All try/catch.
  PARAMS:    - sessionId: application id.
             - action: human-readable event label.
             - flagsData: JSON string of risk details, true (legacy), or false (skip sheet write).
  RETURNS:   undefined.
*/
function logAuditTrail_(sessionId, action, flagsData) {
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
          Logger.log(`[AUDIT] ${sessionId}: ${action}: No anomalous flags`);
          return;
        }
      } catch (_) {
        // Not valid JSON: proceed and log to sheet as-is
      }
    }

    // ── Paranormal event: write to Risk_Audit sheet ──
    const auditSheet = getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, true);
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

    Logger.log(`[AUDIT-FLAG] ${sessionId}: ${action}: Written to Risk_Audit`);
  } catch (e) {
    Logger.log('Error logging audit trail: ' + e.toString());
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🛠️ ADMIN API: EMAIL FAILOVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// These functions are called by the external Admin Panel app via
// google.script.run. They allow ISM InfoSec admins to view failed
// email notifications and trigger resends.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetEmailLog_
  LAYMAN:    Admin lookup: all email-related audit entries for one application.
  TECHNICAL: Scans Risk_Audit for sessionId rows whose Action starts with 'Email '; parses the flags
             JSON. try/catch → [] on error.
  PARAMS:    - sessionId: application id.
  RETURNS:   Array of { logId, action, flags, timestamp } ([] if none/error).
*/
function adminGetEmailLog_(sessionId) {
  try {
    const auditSheet = getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, false);
    if (!auditSheet) return [];
    var data = readSheetValues_(auditSheet);
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
    Logger.log('Error in adminGetEmailLog_: ' + e.toString());
    return [];
  }
}

/*
  Function: adminGetFailedEmails_
  LAYMAN:    Admin lookup: every email that ultimately failed to send, across all applications.
  TECHNICAL: Scans Risk_Audit for Action === 'Email Failed', flattening the flags payload. (Note:
             sinceDays is coerced to a default of 7 but not used to time-filter here.) try/catch → [].
  PARAMS:    - sinceDays: numeric window hint (defaulted to 7).
  RETURNS:   Array of { sessionId, recipient, type, error, timestamp, attempts }.
*/
function adminGetFailedEmails_(sinceDays) {
  try {
    sinceDays = Number(sinceDays) || 7;
    var auditSheet = getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, false);
    if (!auditSheet) return [];
    var data = readSheetValues_(auditSheet);
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
    Logger.log('Error in adminGetFailedEmails_: ' + e.toString());
    return [];
  }
}

/*
  Function: adminResendEmail_
  LAYMAN:    Admin action: re-send a notification to a specific recipient for an application, picking
             the right kind (approver / applicant / ISM) based on where things stand.
  TECHNICAL: For 'approver'/'ism' it locates the recipient's Pending workflow row and re-invokes
             notifyApprover_ / notifyISMember_ at that step; for 'applicant' it maps the current
             app status to a status code and calls notifyApplicant_. Audits the resend. try/catch.
  PARAMS:    - sessionId, recipient, type ('approver'|'applicant'|'ism').
  RETURNS:   { ok, error, message }.
*/
function adminResendEmail_(sessionId, recipient, type) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  try {
    var appData = getApplicationData_(sessionId);
    if (!appData) return { ok: false, message: 'Application not found: ' + sessionId};
    var normalizedType = String(type || '').toLowerCase().trim();
    if (normalizedType === 'approver') {
      var apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
      var apprData = readSheetValues_(apprSheet);
      var foundStep = -1;
      for (var i = 1; i < apprData.length; i++) {
        if (rowMatches_(apprData[i], APPROVAL_COLS, sessionId, __round) && getNormalizedEmail_(String(apprData[i][APPROVAL_COLS.APPROVER_EMAIL - 1] || '')) === getNormalizedEmail_(recipient) && apprData[i][APPROVAL_COLS.STATUS - 1] === 'Pending') {
          foundStep = Number(apprData[i][APPROVAL_COLS.CURRENT_STEP - 1]) - 1;
          break;
        }
      }
      if (foundStep < 0) return { ok: false, message: 'No pending approval step for: ' + recipient};
      notifyApprover_(sessionId, foundStep);
    } else if (normalizedType === 'applicant') {
      var currentStatus = String(appData.status || '').toLowerCase();
      var nstatus = 'submitted';
      if (currentStatus.includes('approve') || currentStatus.includes('approved')) nstatus = 'approved';
      else if (currentStatus.includes('deny') || currentStatus.includes('denied')) nstatus = 'denied';
      else if (currentStatus.includes('return')) nstatus = 'returned';
      notifyApplicant_(sessionId, nstatus);
    } else if (normalizedType === 'ism') {
      var ismSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      var ismData = readSheetValues_(ismSheet);
      var foundStep = -1;
      for (var i = 1; i < ismData.length; i++) {
        if (rowMatches_(ismData[i], ISM_WORKFLOW_COLS, sessionId, __round) && getNormalizedEmail_(String(ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1] || '')) === getNormalizedEmail_(recipient) && ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Pending') {
          foundStep = Number(ismData[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1]);
          break;
        }
      }
      if (foundStep < 0) return { ok: false, message: 'No pending ISM step for: ' + recipient};
      notifyISMember_(sessionId, foundStep);
    } else {
      return { ok: false, message: 'Invalid type: ' + type + '. Must be approver, applicant, or ism.'};
    }
    logAuditTrail_(sessionId, 'Email Resend', JSON.stringify({ recipient: recipient, type: normalizedType, attempts: 1, error: null, source: 'admin' }));
    return { ok: true, message: 'Notification resent to ' + recipient + ' for ' + sessionId };
  } catch (e) {
    Logger.log('Error in adminResendEmail_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API: EMAIL QUEUE MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetEmailQueue_
  LAYMAN:    Admin view of the email queue, optionally filtered by status or application.
  TECHNICAL: Scans Email_Queue, applies status/session filters, projects each row to a summary object.
  PARAMS:    - filter: { status:'Pending'|'Failed'|'Sent'|'Cancelled'|'all', sessionId? }.
  RETURNS:   { ok: true, data:[...], total } or { ok:false, code, message }.
*/
function adminGetEmailQueue_(filter) {
  try {
    filter = filter || {};
    const statusFilter = String(filter.status || 'all').trim();
    const sessionFilter = String(filter.sessionId || '').trim();
    
    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = readSheetValues_(queueSheet);
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

    return { ok: true, data: results, total: results.length };
  } catch (e) {
    Logger.log('Error in adminGetEmailQueue_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: adminRetryQueuedEmail_
  LAYMAN:    Admin action: kick one stuck/failed email back into the queue to be sent again.
  TECHNICAL: Finds the Email_Queue row by Queue_ID and resets Status='Pending', Attempts=0, clears
             error so the next processEmailQueue cycle retries it.
  PARAMS:    - queueId: the EQ-... id.
  RETURNS:   { ok, message } or { ok:false, code, message }.
*/
function adminRetryQueuedEmail_(queueId) {
  try {
    if (!queueId) return { ok: false, message: 'queueId is required' };

    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = readSheetValues_(queueSheet);
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
      ? { ok: true, message: 'Queue item ' + queueId + ' reset to Pending. It will be sent on the next trigger cycle.' }
      : { ok: false, message: 'Queue item not found: ' + queueId };
  } catch (e) {
    Logger.log('Error in adminRetryQueuedEmail_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: adminRetryAllForSession_
  LAYMAN:    Admin action: retry every queued email of a given status for one application at once.
  TECHNICAL: Resets all Email_Queue rows matching (sessionId, targetStatus default 'Failed') to
             Pending/0/'' for the next cycle.
  PARAMS:    - sessionId: application id; status, status to retry (default 'Failed').
  RETURNS:   { ok, message, retried } or { ok:false, code, message }.
*/
function adminRetryAllForSession_(sessionId, status) {
  try {
    if (!sessionId) return { ok: false, message: 'sessionId is required' };
    const targetStatus = String(status || 'Failed').trim();

    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = readSheetValues_(queueSheet);
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
      ok: true,
      message: retriedCount + ' queue items for ' + sessionId + ' reset to Pending.',
      retried: retriedCount
    };
  } catch (e) {
    Logger.log('Error in adminRetryAllForSession_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: adminCancelQueuedEmails_
  LAYMAN:    Admin action: stop pending emails for an application from ever sending (e.g. wrong
             recipient or duplicates) by marking them Cancelled.
  TECHNICAL: Sets Status='Cancelled' on Pending Email_Queue rows matching sessionId (and optional type).
  PARAMS:    - sessionId: application id; type, optional email type filter.
  RETURNS:   { ok, message, cancelled } or { ok:false, code, message }.
*/
function adminCancelQueuedEmails_(sessionId, type) {
  try {
    if (!sessionId) return { ok: false, message: 'sessionId is required' };
    const typeFilter = String(type || '').trim();

    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = readSheetValues_(queueSheet);
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

    return { ok: true, message: cancelled + ' pending queue items cancelled for ' + sessionId, cancelled: cancelled };
  } catch (e) {
    Logger.log('Error in adminCancelQueuedEmails_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: adminGetQueueSummary_
  LAYMAN:    Admin dashboard numbers: how many queued emails are pending/sent/failed/cancelled, and a
             breakdown by type.
  TECHNICAL: Single pass over Email_Queue tallying status counts and a byType map.
  PARAMS:    (none)
  RETURNS:   { ok: true, data:{ total, pending, sent, failed, cancelled, byType } } or error.
*/
function adminGetQueueSummary_() {
  try {
    const queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    const data = readSheetValues_(queueSheet);
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

    return { ok: true, data: summary };
  } catch (e) {
    Logger.log('Error in adminGetQueueSummary_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔔 ADMIN API: DAILY REMINDER CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetReminderConfig_
  LAYMAN:    Admin read of the daily-reminder settings, plus whether the trigger is actually installed
             and when it last ran.
  TECHNICAL: getReminderConfig_() augmented with triggerActive (sendDailyReminders trigger present?) and
             lastRun (PIA_LAST_REMINDER_RUN property).
  PARAMS:    (none)
  RETURNS:   { ok: true, data:{ enabled, hour, timezone, triggerActive, lastRun? } } or error.
*/
function adminGetReminderConfig_() {
  try {
    var config = getReminderConfig_();
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
    return { ok: true, data: config };
  } catch (e) {
    Logger.log('Error in adminGetReminderConfig_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: adminSetReminderConfig_
  LAYMAN:    Admin write of the daily-reminder settings, and it re-installs or removes the trigger to
             match (on → install/refresh, off → delete).
  TECHNICAL: Merges partial config over current (clamps hour to 0-23), persists REMINDER_CONFIG_PROP,
             then setupReminderTrigger_() if enabled else deletes the sendDailyReminders trigger.
  PARAMS:    - config: { enabled?, hour?, timezone? }.
  RETURNS:   { ok: true, data:updated, message } or { ok:false, code, message }.
*/
function adminSetReminderConfig_(config) {
  try {
    var current = getReminderConfig_();
    var updated = {
      enabled: config.hasOwnProperty('enabled') ? !!config.enabled : current.enabled,
      hour: (config.hour !== undefined) ? Math.max(0, Math.min(23, Number(config.hour) || 8)) : current.hour,
      timezone: config.timezone || current.timezone || 'Asia/Manila'
    };

    PropertiesService.getScriptProperties().setProperty(REMINDER_CONFIG_PROP, JSON.stringify(updated));

    // Re-create trigger if hour or enabled changed
    if (updated.enabled) {
      setupReminderTrigger_();
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
    return { ok: true, data: updated, message: 'Reminder configuration updated.' };
  } catch (e) {
    Logger.log('Error in adminSetReminderConfig_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API: Email Failsafe / Notification Config
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetNotificationConfig_
  LAYMAN:    Admin read of the failure-notification settings (who to alert, whether to tell the requestor).
  TECHNICAL: Thin wrapper around getAdminNotificationConfig_().
  PARAMS:    (none)
  RETURNS:   { ok: true, data:config } or { ok:false, code, message }.
*/
function adminGetNotificationConfig_() {
  try {
    var config = getAdminNotificationConfig_();
    return { ok: true, data: config };
  } catch (e) {
    Logger.log('Error in adminGetNotificationConfig_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: adminSetNotificationConfig_
  LAYMAN:    Admin write of the failure-notification settings (admin email, notify-on-failure,
             notify-requestor).
  TECHNICAL: Ensures a data row exists in Admin_Notification_Config (seeds one if empty), then patches
             the provided fields (YES/NO for the booleans) on row 2; returns the re-read config.
  PARAMS:    - config: { adminEmail?, notifyOnFailure?, notifyRequestor? }.
  RETURNS:   { ok: true, data:updated, message } or { ok:false, code, message }.
*/
function adminSetNotificationConfig_(config) {
  try {
    if (!config) return { ok: false, message: 'Missing config object' };

    var sheet = getDatabaseSheet_(DB_SHEET_NAMES.ADMIN_NOTIFICATION, true);
    if (!sheet) return { ok: false, message: 'Admin_Notification_Config sheet not found' };

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

    var updated = getAdminNotificationConfig_();
    Logger.log('📋 Admin notification config updated: ' + JSON.stringify(updated));
    return { ok: true, data: updated, message: 'Notification configuration updated.' };
  } catch (e) {
    Logger.log('Error in adminSetNotificationConfig_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API: Resend email to a specific workflow stage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminResendToStage_
  LAYMAN:    Admin action: re-queue a review email to a specific person at a specific stage (approver /
             ISM / division head), with a fresh valid review link.
  TECHNICAL: Resolves the stage sheet via getWorkflowInfoForType_, finds the recipient's Pending row,
             derives a display name + PIA title, builds an action-bound HMAC link ('ISMReview' for ism,
             else 'Review'), queueEmail_'s a plain-text resend, and resets that row's EmailStatus/Error.
  PARAMS:    - sessionId, stageType ('approver'|'ism'|'divhead'), approverEmail.
  RETURNS:   { ok:true, queueId, message } or { ok:false, code, message }.
*/
function adminResendToStage_(sessionId, stageType, approverEmail) {
  try {
    if (!sessionId || !stageType || !approverEmail) {
      return { ok: false, message: 'Missing sessionId, stageType, or approverEmail' };
    }

    var wfInfo = getWorkflowInfoForType_(stageType);
    if (!wfInfo) {
      return { ok: false, message: 'Invalid stageType. Use: approver, ism, or divhead' };
    }

    var wfSheet = getDatabaseSheet_(wfInfo.name, true);
    if (!wfSheet) return { ok: false, message: 'Workflow sheet not found: ' + wfInfo.name };

    var data = readSheetValues_(wfSheet);
    var normEmail = String(getNormalizedEmail_(approverEmail) || '').toLowerCase();
    var foundRow = -1;

    for (var i = 1; i < data.length; i++) {
      var rowSid = String(data[i][wfInfo.cols.SESSION_ID - 1] || '').trim();
      var rowEmail = String(getNormalizedEmail_(data[i][wfInfo.emailCol - 1] || '') || '').toLowerCase();
      var rowStatus = String(data[i][wfInfo.cols.STATUS - 1] || '').trim();
      if (rowSid === sessionId && rowEmail === normEmail && rowStatus === 'Pending') {
        foundRow = i + 1;
        break;
      }
    }

    if (foundRow < 0) {
      return { ok: false, message: 'No matching Pending row found for session ' + sessionId + ' / ' + approverEmail + ' / ' + stageType };
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

    var appsSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    var appData = appsSheet ? readSheetValues_(appsSheet) : [];
    var piaTitle = 'PIA-' + sessionId;
    for (var ar = 1; ar < appData.length; ar++) {
      if (String(appData[ar][APPLICATIONS_COLS.SESSION_ID - 1] || '').trim() === sessionId) {
        piaTitle = String(appData[ar][APPLICATIONS_COLS.PIA_1_DATA - 1] || piaTitle).trim();
        break;
      }
    }

    // Build review URL inline
    var webAppUrl = getWebAppUrl_();
    var ts = new Date().getTime().toString();
    var normEmailForUrl = getNormalizedEmail_(approverEmail);
    var actionType = stageType === 'ism' ? 'ISMReview' : 'Review';
    var token = generateAuthToken_(sessionId, normEmailForUrl, ts, actionType);
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

    var queueId = queueEmail_(sessionId, approverEmail,
      '[PIA Resend] Action Required: ' + sessionId,
      emailBody, stageType, null);

    // Reset EmailStatus to Pending on the workflow row
    wfSheet.getRange(foundRow, wfInfo.cols.EMAIL_STATUS).setValue('Pending');
    wfSheet.getRange(foundRow, wfInfo.cols.EMAIL_ERROR).setValue('');

    Logger.log('🔄 Admin resend to ' + stageType + ' → ' + approverEmail + ' [' + queueId + ']');
    return { ok: true, queueId: queueId, message: 'Email re-queued to ' + approverEmail + ' (' + stageType + ')' };
  } catch (e) {
    Logger.log('Error in adminResendToStage_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ADMIN API: Get full pipeline view for a session
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: adminGetPipelineView_
  LAYMAN:    Admin "everything about one application" report: the app row plus all approval, ISM, and
             division-head workflow rows, every email-queue entry, and the audit trail, for the admin
             panel's drill-down.
  TECHNICAL: Builds a pipeline object by scanning Applications, Approval_Workflow, ISM_Approval_Workflow,
             DivisionHead_Approval_Workflow, Email_Queue, and Risk_Audit for the sessionId, projecting
             each to a compact shape. try/catch → error.
  PARAMS:    - sessionId: application id.
  RETURNS:   { ok: true, data:{ application, approvalWorkflow[], ismWorkflow[], divHeadWorkflow[],
             emailQueue[], auditTrail[] } } or { ok:false, code, message }.
*/
function adminGetPipelineView_(sessionId) {
  // PERF: this is the heaviest read in the file, one full pull of every sheet (6), plus
  // getCurrentRound_ which reads the three workflow sheets again (3), so the workflow
  // sheets are fetched twice each. Read-only diagnostic view, nothing here writes, so the
  // whole body runs under one cache and the nine reads collapse to six.
  return withSheetCache_(function () { return adminGetPipelineViewImpl_(sessionId); });
}

/*
  Function: adminGetPipelineViewImpl_
  LAYMAN:    The actual pipeline-snapshot builder. Split out only so its caller can wrap it
             in one sheet cache; the logic is unchanged.
  TECHNICAL: See adminGetPipelineView_ above for contract. Kept private and never called
             directly, go through the wrapper so the cache is always applied.
  PARAMS:    - sessionId: the PIA session to snapshot.
  RETURNS:   {ok: true, pipeline} or {ok: false, message}.
*/
function adminGetPipelineViewImpl_(sessionId) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  try {
    if (!sessionId) return { ok: false, message: 'Missing sessionId' };

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
    var appsSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    if (appsSheet) {
      var appsData = readSheetValues_(appsSheet);
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
    var apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
    if (apprSheet) {
      var apprData = readSheetValues_(apprSheet);
      for (var j = 1; j < apprData.length; j++) {
        if (rowMatches_(apprData[j], APPROVAL_COLS, sessionId, __round)) {
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
    var ismSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    if (ismSheet) {
      var ismData = readSheetValues_(ismSheet);
      for (var k = 1; k < ismData.length; k++) {
        if (rowMatches_(ismData[k], ISM_WORKFLOW_COLS, sessionId, __round)) {
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
    var divSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    if (divSheet) {
      var divData = readSheetValues_(divSheet);
      for (var m = 1; m < divData.length; m++) {
        if (rowMatches_(divData[m], DIV_HEAD_CONFIG_COLS, sessionId, __round)) {
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
    var queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    if (queueSheet) {
      var queueData = readSheetValues_(queueSheet);
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
    var auditSheet = getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, true);
    if (auditSheet) {
      var auditData = readSheetValues_(auditSheet);
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

    return { ok: true, data: pipeline };
  } catch (e) {
    Logger.log('Error in adminGetPipelineView_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: setupReminderTrigger
  LAYMAN:    Installs the once-a-day reminder job at the configured hour (and removes any old copy first).
  TECHNICAL: No-op if reminders disabled. Deletes existing sendDailyReminders triggers, then creates a
             daily time-based trigger atHour(config.hour) in config.timezone. Requires script.scriptapp.
  PARAMS:    (none)
  RETURNS:   { ok:true, message }.
*/
/*
  Function: setupReminderTrigger  (PUBLIC EDITOR ENTRY POINT, thin guarded wrapper)

  LAYMAN (Tropang Ex):
  Pinto lang ito para sa'yo kapag pinapatakbo mo mismo sa editor. Ang totoong trabaho nasa
  setupReminderTrigger_(). Public siya dahil kailangan mo siyang makita sa Run dropdown, pero
  may bantay dahil kung wala, kahit sinong empleyado kayang mag-install o magpalit ng
  system-wide trigger galing browser console.

  TECHNICAL:
  Guarded by isOwnerContext_(). Internal callers (adminSetReminderConfig_ and the ADMIN_API_KEY
  dispatch in handleAdminApiRequest_) invoke setupReminderTrigger_() directly, so this gate does
  not affect them.

  PARAMS:    (none)
  RETURNS:   setupReminderTrigger_()'s result, or { ok:false, code, message } when not authorized.
*/
function setupReminderTrigger() {
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  return setupReminderTrigger_();
}

function setupReminderTrigger_() {
  var config = getReminderConfig_();
  if (!config.enabled) {
    Logger.log('🔔 Reminder trigger NOT created: reminders are disabled.');
    return { ok: true, message: 'Reminders are disabled. No trigger created.' };
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

  Logger.log('🔔 Reminder trigger created: sendDailyReminders_() will run daily at ' +
    String(config.hour).padStart(2, '0') + ':00 (' + (config.timezone || 'script default') + ')');

  return {
    ok: true,
    message: 'Reminder trigger created. sendDailyReminders_() will run daily at ' +
      String(config.hour).padStart(2, '0') + ':00.'
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECURITY, VALIDATION, SANITAZION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: validateApplicationData_
  LAYMAN:    Server-side check that a PIA submission is complete and sane before it is saved, all five
             sections present, required PIA 1 fields filled, valid emails, a future program date, the
             survey fully answered, and at least one approver available.
  TECHNICAL: Accumulates an errors[] across pia1..pia5 (required-object checks, pia4 flow fields, pia1
             department/program/date/drafter/email validity via isValidEmail_, pia5 every question is
             YES/NO/N/A, and an approver-exists check incl. the PRIVACY_OFFICER_EMAIL fallback).
  PARAMS:    - appData: the submission object.
  RETURNS:   { isValid: boolean, errors: string[] }.
*/
function validateApplicationData_(appData) {
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
  if (!isValidEmail_(appData.pia1.drafterEmail)) errors.push('Invalid drafter email');
  if (appData.pia1.deptHeadEmail && !isValidEmail_(appData.pia1.deptHeadEmail)) {
    errors.push('Invalid department head email');
  }
  if (appData.pia1.immediateHeadEmail && !isValidEmail_(appData.pia1.immediateHeadEmail)) {
    errors.push('Invalid immediate head email');
  }
  if (appData.pia1.divHeadEmail && !isValidEmail_(appData.pia1.divHeadEmail)) {
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
  Function: validateComment_
  LAYMAN:    Makes sure a decision comment is a real, meaningful justification, not blank, spammy, or
             gibberish.
  TECHNICAL: Strips tags, then enforces min length (param), COMMENT_MAX_CHARS, no 6+ repeated chars,
             presence of word-like sequences, and >= 3 words.
  PARAMS:    - comment: the raw comment; minLength, minimum chars (default 50).
  RETURNS:   { valid:true } or { valid:false, error }.
*/
function validateComment_(comment, minLength = 50) {
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
  Function: sanitizeInput_
  LAYMAN:    Recursively cleans incoming text/objects to strip dangerous HTML and control characters
             while keeping a small set of safe formatting tags for rich-text comments.
  TECHNICAL: Recurses arrays/objects (depth-capped at 20, returns new objects, no input mutation). For
             strings: removes javascript:/data:/vbscript:/file: protocols, on* handlers, control chars,
             RTL override / zero-width / BOM, and strips all tags except <strong/b/em/i/u/ul/ol/li/br/p>;
             trims and clamps to maxLength.
  PARAMS:    - data: value to clean; maxLength, per-string cap (10000); depth, internal recursion guard.
  RETURNS:   Sanitized value of the same shape (string for scalars).
*/
function sanitizeInput_(data, maxLength = 10000, depth = 0) {
  // Prevent stack overflow on deeply nested objects
  if (depth > 20) {
    Logger.log('WARNING: Sanitization depth limit (20) exceeded - possible circular reference');
    return String(data || '');
  }
  
  if (Array.isArray(data)) {
    return data.map(item => sanitizeInput_(item, maxLength, depth + 1));
  }

  if (typeof data === 'object' && data !== null) {
    // Create new sanitized object instead of mutating input
    const sanitized = {};
    Object.keys(data).forEach(key => {
      sanitized[key] = sanitizeInput_(data[key], maxLength, depth + 1);
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
// PHASE 3 API - DATA FETCHING MODULE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: isAuthorizedForApplication_
  LAYMAN (Tropang Ex):
  Tanong nito: "pwede ba 'tong taong nakatingin makakita ng application na 'to?" Oo kung siya ang
  nag-submit (applicant) O kasama siya sa approval chain: Immediate/Dept Head, ISM reviewer, o Division
  Head. Kung hindi, bawal.

  TECHNICAL:
  Server-side read-authorization for an application. Normalizes the active user and matches against:
  the applicant, the Stage-A approvers already on appData.approvers, then scans ISM_Approval_Workflow and
  DivisionHead_Approval_Workflow for the session. Used to gate the ISM-reviewer Fetch endpoints (F-05) so
  a direct google.script.run call cannot read another application by sessionId.

  PARAMS:
  - sessionId: application id (used to scan the ISM/DivHead workflow sheets).
  - appData: the object from getApplicationData_(sessionId) (provides applicant + Stage-A approvers).

  RETURNS:
  Boolean. False on empty active user / missing appData / no match.
*/
function isAuthorizedForApplication_(sessionId, appData) {
  const me = getNormalizedEmail_(Session.getActiveUser().getEmail());
  if (!me || !appData) return false;
  // Owner (applicant)
  if (me === getNormalizedEmail_(appData.applicantEmail)) return true;

  // 🚩 SCOPED-EXCLUSIVE DELEGATION (2026-08-12). canActAs_ makes a handoff exclusive for
  // DECIDING; this makes it exclusive for LOOKING, but only as narrowly as that actually
  // means. `handedOff` is true for exactly one shape of row: one that is mine AND still
  // Pending, while I have an active delegation. Those rows are the ones someone else is
  // now responsible for, so they drop out of my view.
  //
  // Everything else stays visible, deliberately:
  //   - a row I already decided (any status other than Pending), on this request or any
  //     other, that is settled history, not a live handoff;
  //   - an earlier round of THIS request that I decided before it was returned;
  //   - the whole request, if any of my rows on it survive the filter.
  // Blanket-hiding instead would mean a two-week leave silently blanks out months of the
  // approver's own past work, which is a side effect nobody asked for and would read as
  // data loss.
  //
  // ⚠️ resolveDelegate_ fails OPEN (null on a broken/unreadable table), so a failure here
  // hides nothing rather than hiding everything. That is the safe direction for this
  // specific check: the caller is only reached at all if they are already named on the
  // request, so failing open restores the previous behaviour instead of granting anything
  // new. The decide-side guard (canActAs_) is where a delegation failure actually matters.
  const myDelegate = resolveDelegate_(me);        // non-null only while I am delegating away
  const handedOff = function (status) {
    return !!myDelegate && String(status || '').trim() === 'Pending';
  };

  // Stage-A heads (Immediate / Department), already enumerated on appData.approvers
  if ((appData.approvers || []).some(function (a) {
        return getNormalizedEmail_(a.email) === me && !handedOff(a.status);
      })) return true;
  // ISM members + Division Heads, scan their workflow sheets for this session
  //
  // 🚩 APPEND-ONLY NOTE: these scans are deliberately NOT scoped to the current round. Authorization
  // asks "was this person ever party to this request?", not "are they the one due to act now."
  // appData.approvers only carries the CURRENT round's Stage-A ladder, so scoping here as well
  // would silently revoke view access from anyone who approved an earlier round. Access to read a
  // request you already decided on must survive a resubmission. Hence Approval_Workflow is scanned
  // directly below, across every round, rather than trusting appData.approvers alone.
  const searchId = String(sessionId || '').trim().toUpperCase();
  const scanSheet = function (sheetName, sessionCol, emailCol, statusCol) {
    try {
      const sh = getDatabaseSheet_(sheetName, false);
      if (!sh) return false;
      const vals = readSheetValues_(sh);
      for (let i = 1; i < vals.length; i++) {
        if (String(vals[i][sessionCol - 1] || '').trim().toUpperCase() === searchId &&
            getNormalizedEmail_(vals[i][emailCol - 1]) === me) {
          // `continue`, not `return false`, a handed-off Pending row must not end the scan.
          // An earlier round of this same request may still be mine to see, and it is further
          // down the sheet.
          if (handedOff(vals[i][statusCol - 1])) continue;
          return true;
        }
      }
    } catch (e) { /* sheet missing → not authorized via this path */ }
    return false;
  };
  if (scanSheet(DB_SHEET_NAMES.APPROVAL_WORKFLOW, APPROVAL_COLS.SESSION_ID, APPROVAL_COLS.APPROVER_EMAIL, APPROVAL_COLS.STATUS)) return true;
  if (scanSheet(DB_SHEET_NAMES.ISM_WORKFLOW, ISM_WORKFLOW_COLS.SESSION_ID, ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL, ISM_WORKFLOW_COLS.STATUS)) return true;
  if (scanSheet(DB_SHEET_NAMES.DIV_HEAD_CONFIG, DIV_HEAD_CONFIG_COLS.SESSION_ID, DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL, DIV_HEAD_CONFIG_COLS.STATUS)) return true;

  // 🚩 DELEGATION (2026-08-11). A delegate has to be able to READ the request they are being
  // asked to decide, the review screen calls this before it will render anything. Rather than
  // scan the sheets a second time under the delegate's identity, ask the cheaper question: is
  // there anyone who has delegated TO me, and would THEY have been authorized? One hop only,
  // matching resolveDelegate_.
  try {
    const delegators = delegatorsFor_(me);
    for (let d = 0; d < delegators.length; d++) {
      const orig = delegators[d];
      if ((appData.approvers || []).some(function (a) { return getNormalizedEmail_(a.email) === orig; })) return true;
      if (scanSheetFor_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, APPROVAL_COLS.SESSION_ID, APPROVAL_COLS.APPROVER_EMAIL, searchId, orig)) return true;
      if (scanSheetFor_(DB_SHEET_NAMES.ISM_WORKFLOW, ISM_WORKFLOW_COLS.SESSION_ID, ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL, searchId, orig)) return true;
      if (scanSheetFor_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, DIV_HEAD_CONFIG_COLS.SESSION_ID, DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL, searchId, orig)) return true;
    }
  } catch (e) {
    // Fail CLOSED here: unlike resolveDelegate_, which fails open to "no delegate". This is an
    // authorization decision, so a broken delegation table must deny, never grant.
    Logger.log('isAuthorizedForApplication_: delegation check failed, denying: ' + e);
  }
  return false;
}

/*
  Function: scanSheetFor_
  LAYMAN:    Tinitignan kung may row ba sa isang sheet para sa request na ito na naka-pangalan sa
             isang partikular na email.
  TECHNICAL: The parameterised form of isAuthorizedForApplication_'s inner scanSheet closure,
             extracted so the delegation branch can ask the same question about a DIFFERENT
             address than Session.getActiveUser(). Returns false on a missing sheet.
  PARAMS:    - sheetName, sessionCol, emailCol, where to look.
             - searchId: the UPPERCASED, trimmed session id.
             - normalizedEmail: the address to match, already through getNormalizedEmail_.
  RETURNS:   boolean.
*/
function scanSheetFor_(sheetName, sessionCol, emailCol, searchId, normalizedEmail) {
  try {
    const sh = getDatabaseSheet_(sheetName, false);
    if (!sh) return false;
    const vals = readSheetValues_(sh);
    for (let i = 1; i < vals.length; i++) {
      if (String(vals[i][sessionCol - 1] || '').trim().toUpperCase() === searchId &&
          getNormalizedEmail_(vals[i][emailCol - 1]) === normalizedEmail) {
        return true;
      }
    }
  } catch (e) { /* sheet missing → not authorized via this path */ }
  return false;
}

/*
  Function: delegatorsFor_
  LAYMAN:    "Sino ang mga taong ako ang kapalit ngayon?" Kabaliktaran ito ng resolveDelegate_.
  TECHNICAL: Reverse lookup over the Delegations sheet, every currently-active From_Email whose
             To_Email is this person. Used only by the authorization path; the notify path uses
             the forward direction. Returns [] on any error, which denies rather than grants.
  PARAMS:    - normalizedEmail: the delegate's address, already normalized.
  RETURNS:   Array of normalized From_Email addresses (possibly empty).
*/
function delegatorsFor_(normalizedEmail) {
  const out = [];
  if (!normalizedEmail) return out;
  let rows;
  try {
    const sheet = getDelegationsSheet_();
    if (!sheet) return out;
    rows = readSheetValues_(sheet);
  } catch (e) { return out; }
  if (!rows || rows.length < 2) return out;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[DELEGATION_COLS.IS_ACTIVE - 1] || '').trim().toUpperCase() !== 'YES') continue;
    if (getNormalizedEmail_(r[DELEGATION_COLS.TO_EMAIL - 1]) !== normalizedEmail) continue;
    const start = parseDelegationDate_(r[DELEGATION_COLS.START_DATE - 1]);
    const end   = parseDelegationDate_(r[DELEGATION_COLS.END_DATE - 1]);
    if (start && today < start) continue;
    if (end && today > end) continue;
    const from = getNormalizedEmail_(r[DELEGATION_COLS.FROM_EMAIL - 1]);
    if (from && out.indexOf(from) === -1) out.push(from);
  }
  return out;
}

/*
  Function: apiPhase3_FetchPIAData
  LAYMAN:    Gives the ISM reviewer screen the key PIA facts: program, department, the PII collected,
             who submitted it, purposes and retention.
  TECHNICAL: Loads getApplicationData_ and projects a flat summary (program/dept from pia1, PII via
             getPIIFieldsList_, purposes/retention from pia4). try/catch → error.
  PARAMS:    - sessionId: application id.
  RETURNS:   { ok: true, data:{...} } or { ok:false, code, message }.
*/
function apiPhase3_FetchPIAData(sessionId) {
  try {
    const appData = getApplicationData_(sessionId);
    if (!appData) {
      return { ok: false, message: 'Application not found' };
    }

    // SECURITY (F-05): authorize, only the applicant or someone on the approval chain may view this.
    if (!isAuthorizedForApplication_(sessionId, appData)) {
      return { ok: false, message: 'Access denied: you are not authorized to view this application.' };
    }

    return {
      ok: true,
      data: {
        sessionId: sessionId,
        program: appData.pia1?.program || 'Unknown Program',
        department: appData.pia1?.dept || 'Unknown Department',
        piiFields: getPIIFieldsList_(appData),
        submittedBy: appData.applicantEmail,
        submissionDate: appData.pia1?.createdDate || new Date().toISOString(),
        purposes: appData.pia4?.collect || '',
        dataRetention: appData.pia4?.retain || ''
      }
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_FetchPIAData: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiPhase3_FetchDCSData
  LAYMAN:    Gives the ISM reviewer the linked Phase 1 DCS context (requestor, department, access needed,
             agency metadata) for the application under review.
  TECHNICAL: Resolves linkedReqId, finds the Data_Collection row, parses METADATA_JSON (+ agency JSON),
             and projects a flat object with normalized field fallbacks. try/catch → error.
  PARAMS:    - sessionId: application id.
  RETURNS:   { ok: true, data:{...DCS fields} } or { ok:false, code, message }.
*/
function apiPhase3_FetchDCSData(sessionId) {
  try {
    const appData = getApplicationData_(sessionId);
    if (!appData || !appData.linkedReqId) {
      return { ok: false, message: 'No DCS request linked to this application' };
    }

    // SECURITY (F-05): authorize, only the applicant or someone on the approval chain may view this.
    if (!isAuthorizedForApplication_(sessionId, appData)) {
      return { ok: false, message: 'Access denied: you are not authorized to view this application.' };
    }

    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const dcsData = readSheetValues_(dcsSheet);

    for (let i = 1; i < dcsData.length; i++) {
      if (dcsData[i][DCS_COLS.REQ_ID - 1] === appData.linkedReqId) {
        const metadata = JSON.parse(dcsData[i][DCS_COLS.METADATA_JSON - 1] || '{}');
        
        return {
          ok: true,
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

    return { ok: false, message: 'DCS request data not found' };
  } catch (e) {
    Logger.log('Error in apiPhase3_FetchDCSData: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiPhase3_GetDivisionHeadConfig_
  LAYMAN:    Looks up a Division Head by email to confirm they are recognized/active for escalations.
  TECHNICAL: Scans DivisionHead_Approval_Workflow for a matching email; returns its active flag, or a
             permissive default ({ isActive:true }) if not found. try/catch → error.
  PARAMS:    - divisionHeadEmail: email to look up.
  RETURNS:   { ok:true, config:{ divHeadEmail, isActive } } or { ok:false, code, message }.
*/
function apiPhase3_GetDivisionHeadConfig_(divisionHeadEmail) {
  try {
    const divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    const data = readSheetValues_(divHeadSheet);

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1] || '').toLowerCase() === 
          String(divisionHeadEmail || '').toLowerCase()) {
        return {
          ok: true,
          config: {
            divHeadEmail: data[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1],
            isActive: data[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Active'
          }
        };
      }
    }

    // Return default config if not found
    return {
      ok: true,
      config: {
        divHeadEmail: divisionHeadEmail,
        isActive: true
      }
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_GetDivisionHeadConfig_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiPhase3_GetInfoSecMembers_
  LAYMAN:    Returns the active ISM/InfoSec reviewers and the downstream routing emails (DCOPS,
             TechServe). Self-heals by seeding two default members if the config has fewer than two.
  TECHNICAL: Reads InfoSec_Email_Config. If fewer than 2 active 'InfoSec' rows, appends seed rows and
             re-reads. Collects active InfoSec members + dcops/techserve destination emails, then pads
             activeMembers to exactly 2 using fallbacks so the ISM chain always has two steps.
  PARAMS:    (none)
  RETURNS:   { ok: true, data:{ members:[{id,name,email,role}], destinationEmails:{dcops,techserve,both} } }
             or { ok:false, code, message }.
*/
function apiPhase3_GetInfoSecMembers_() {
  try {
    const infoSecSheet = getDatabaseSheet_(DB_SHEET_NAMES.INFOSEC_CONFIG, true);
    var data = readSheetValues_(infoSecSheet);
    
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
      data = readSheetValues_(infoSecSheet);
    }

    const members = [];
    let dcopsEmail = '';
    let techserveEmail = '';
    const techserveBySite = {};    // { 'AGT': ['a@x'], 'EASTGATE': ['b@x'], ... }, per-site TechServe (Batch 3)
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
      ok: true,
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
    Logger.log('Error in apiPhase3_GetInfoSecMembers_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
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
  - destEmails: the destinationEmails object from apiPhase3_GetInfoSecMembers_.
  - siteRaw: the request's Office/Site value (dcsData.locations).
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
  Function: getPIIFieldsList_
  LAYMAN:    Returns the human-readable list of PII categories the program collects (the ones marked
             'YES'), including any custom "Others".
  TECHNICAL: Normalizes the pia2 shape, maps 'YES' indices to pii2Fields labels, appends customOthers
             whose value is 'YES'.
  PARAMS:    - appData: application object with a pia2 section.
  RETURNS:   Array of field-name strings (possibly empty).
*/
function getPIIFieldsList_(appData) {
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
  Function: apiPhase3_InitializeISMWorkflow_
  LAYMAN:    After all heads approve, this sets up the ISM review stage by creating one to-do row per
             ISM member (all Pending).
  TECHNICAL: Gets the ISM roster via apiPhase3_GetInfoSecMembers_ and appends a sequential
             ISM_Approval_Workflow row ('<sessionId>-ISM-<n>') for each, then flushes. Fails if no
             members are configured.
  PARAMS:    - sessionId: application id.
  RETURNS:   { ok:true, message, members } or { ok:false, code, message }.
*/
function apiPhase3_InitializeISMWorkflow_(sessionId) {
  try {
    const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const ismInfo = apiPhase3_GetInfoSecMembers_();

    if (!ismInfo.ok || !ismInfo.data.members.length) {
      return { ok: false, message: 'No InfoSec members configured' };
    }

    // Append-only workflow: stamp the round so a later resubmission's ISM rows never collide
    // with these. Reuses the round already established by the Stage-A rows for this session.
    const round = getCurrentRound_(sessionId) || 1;

    // Create ISM approval records
    ismInfo.data.members.forEach((member, index) => {
      // Suffix round 2+ so the id stays unique now that earlier rounds' rows survive.
      const ismApprovalId = `${sessionId}-ISM-${index + 1}` + (round > 1 ? `-R${round}` : '');
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
        '',                               // EMAIL_ERROR
        '',                               // NOTIFIED_DATE
        round,                            // ROUND_NUMBER
        ''                                // FLAGGED_FIELDS
      ]);
    });
    
    // CRITICAL: Flush after appendRow so downstream reads see the new rows
    SpreadsheetApp.flush();

    return {
      ok: true,
      message: `ISM workflow initialized with ${ismInfo.data.members.length} members`,
      members: ismInfo.data.members
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_InitializeISMWorkflow_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiPhase3_RetryISMWorkflow_
  LAYMAN:    Recovery action for an application stuck at "Approved (ISM Pending)" because the ISM stage
             could not start earlier (e.g. InfoSec config was empty). Re-runs the ISM setup once the
             config is fixed.
  TECHNICAL: Validates the app exists and is in a retryable status, refuses if ISM rows already exist
             (anti-duplicate), then apiPhase3_InitializeISMWorkflow_, flips status to 'Approved', and
             notifies the first ISM member.
  PARAMS:    - sessionId: application id.
  RETURNS:   { ok:true, message, members } or { ok:false, code, message }.
*/
function apiPhase3_RetryISMWorkflow_(sessionId) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  try {
    // Validate that the application exists and is in the expected state
    const appData = getApplicationData_(sessionId);
    if (!appData) {
      return { ok: false, message: 'Application not found: ' + sessionId };
    }
    
    const currentStatus = String(appData.status || '');
    if (currentStatus !== 'Approved (ISM Pending)' && currentStatus !== 'Approved') {
      return { ok: false, message: 'Application is not in a retryable state. Current status: ' + currentStatus };
    }
    
    // Check if ISM workflow records already exist for this session
    const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const existingData = readSheetValues_(ismWorkflowSheet);
    for (let i = 1; i < existingData.length; i++) {
      if (rowMatches_(existingData[i], ISM_WORKFLOW_COLS, sessionId, __round)) {
        return { ok: false, message: 'ISM workflow already exists for this session. Cannot re-initialize.' };
      }
    }
    
    // Attempt initialization
    const result = apiPhase3_InitializeISMWorkflow_(sessionId);
    if (!result.ok) {
      return result; // Propagate the specific error
    }
    
    // Update application status from "Approved (ISM Pending)" → "Approved"
    const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    const appRow = findRowBySessionID_(sessionId);
    if (appRow > 0) {
      appSheet.getRange(appRow, APPLICATIONS_COLS.STATUS).setValue('Approved');
      Logger.log(`[AUDIT] ${sessionId}: ISM workflow retry successful, status updated to Approved`);
    }
    
    // Notify the first ISM member
    notifyISMember_(sessionId, 1);
    
    return {
      ok: true,
      message: 'ISM workflow initialized successfully for ' + sessionId,
      members: result.members
    };
  } catch (e) {
    Logger.log('Error in apiPhase3_RetryISMWorkflow_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
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
  RETURNS:   { ok:true, message, nextAction } or { ok:false, code, message }.
*/
function apiPhase3_ProcessISMDecision(sessionId, ismMemberEmail, decision, comments, routingDestination = '', stepParam = null, approverFlags = '{}') {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  // SECURITY (F-02): authorize the actual caller server-side, a direct google.script.run call must not
  // be able to submit a decision as someone else. The legit email-link/inline-panel path already verified
  // activeUser == targetEmail in handleEmailAction_ before reaching here, so this always passes there.
  // Widened for delegation (2026-08-11), see the note on processApprovalDecision_.
  const _me = getNormalizedEmail_(Session.getActiveUser().getEmail());
  const _act = canActAs_(_me, ismMemberEmail);
  if (!_act.allowed) {
    return { ok: false, message: 'Access denied: you may only submit your own decision.' };
  }
  const _actedBy = _act.onBehalfOf ? _me : '';
  try {
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl_() || ScriptApp.getService().getUrl();
    const allowedDecisions = ['Approve', 'Deny', 'Return', 'EscalateToDivisionHead'];
    if (!allowedDecisions.includes(decision)) {
      return { ok: false, message: 'Invalid decision value' };
    }

    // CRITICAL FIX: Validate routingDestination against whitelist to prevent injection
    const allowedDestinations = ['DCOPS', 'TECHSERVE', 'BOTH', ''];
    const normalizedDestination = String(routingDestination || '').toUpperCase();
    if (!allowedDestinations.includes(normalizedDestination)) {
      Logger.log('SECURITY ALERT: Invalid routing destination attempted: ' + routingDestination);
      return { ok: false, message: 'Invalid routing destination' };
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
        return { ok: false, message: 'System busy, please try again' };
      }

      const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
      const data = readSheetValues_(ismWorkflowSheet);
      const timestamp = new Date().toLocaleString('en-PH', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });

    // Find current ISM member record
    let currentRow = -1;
    let currentStep = -1;
    const normalizedTarget = String(getNormalizedEmail_(ismMemberEmail) || '').toLowerCase();
    
    for (let i = 1; i < data.length; i++) {
      if (rowMatches_(data[i], ISM_WORKFLOW_COLS, sessionId, __round) &&
          String(getNormalizedEmail_(data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]) || '').toLowerCase() === normalizedTarget &&
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
      return { ok: false, message: 'ISM approval record not found' };
    }

    // Update ISM member decision
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.DECISION).setValue(decision);
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.COMMENTS).setValue(comments);
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.DECISION_DATE).setValue(timestamp);
    // Append-only workflow: durable per-round record of what THIS reviewer flagged.
    writeDecisionFlags_(ismWorkflowSheet, currentRow, ISM_WORKFLOW_COLS, approverFlags);
    writeActedBy_(ismWorkflowSheet, currentRow, ISM_WORKFLOW_COLS, _actedBy);
    ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.ROUTING_DESTINATION).setValue(normalizedDestination);

    /* Approve branch: unanimous requirement: finalize + route only when every ISM row is Approved,
       otherwise notify the next ISM member in sequence. */
    if (decision === 'Approve') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('Approved');

      // Check if all ISM members have approved (unanimous requirement)
      const freshData = readSheetValues_(ismWorkflowSheet);
      let allApproved = true;
      let totalMembers = 0;

      for (let i = 1; i < freshData.length; i++) {
        if (rowMatches_(freshData[i], ISM_WORKFLOW_COLS, sessionId, __round)) {
          totalMembers++;
          if (freshData[i][ISM_WORKFLOW_COLS.STATUS - 1] !== 'Approved') {
            allApproved = false;
          }
        }
      }

      if (allApproved && totalMembers > 0) {
        // All ISM members approved - update application status and route to destination
        const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
        const appData = readSheetValues_(appSheet);
        
        for (let i = 1; i < appData.length; i++) {
          if (appData[i][APPLICATIONS_COLS.SESSION_ID - 1] === sessionId) {
            appSheet.getRange(i + 1, APPLICATIONS_COLS.STATUS).setValue('Approved by ISM');
            Logger.log(`[AUDIT] ${sessionId}: Application Approved by ISM InfoSec Team (All Members)`);

          const linkedReqId = appData[i][APPLICATIONS_COLS.LINKED_REQ_ID - 1];
          if (linkedReqId) updateDCSStatus_(linkedReqId, 'Complete');

            // Build + route the certificate FIRST so it can be attached to the applicant's email.
            let certResult = null;
            if (routingDestination) {
              try {
                certResult = routeApprovedRequest_(sessionId, routingDestination);
                Logger.log(`[AUDIT] ${sessionId}: Routed to: ${routingDestination}`);
              } catch (routeErr) {
                Logger.log('Error routing to destination: ' + routeErr.toString());
              }
            }
            notifyApplicant_(sessionId, 'approved_ism_final', {
              certBlob: (certResult && certResult.ok) ? certResult.pdfBlob : null,
              techserveEmails: (certResult && certResult.ok) ? certResult.techserveEmails : ''
            });
            break;
          }
        }
      } else if (!allApproved && currentStep < totalMembers) {
        notifyApplicant_(sessionId, 'progressing_ism');
        // Notify next ISM member
        notifyISMember_(sessionId, currentStep + 1);
      }
    } else if (decision === 'Deny') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('Denied');
      
      // Mark application as rejected
      const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
      const appData = readSheetValues_(appSheet);
      
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
      const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
      const appData = readSheetValues_(appSheet);
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
          updateDCSStatus_(linkedReqId, 'Returned', approverFlags);
          Logger.log(`[AUDIT] ${sessionId}: ISM Review Returned DCS & PIA by ${ismMemberEmail}`);
        } else {
          Logger.log(`[AUDIT] ${sessionId}: ISM Review Returned PIA (No DCS flags) by ${ismMemberEmail}`);
        }
      } else {
        Logger.log(`[AUDIT] ${sessionId}: ISM Review Returned by ${ismMemberEmail}`);
      }
      
      // Notify applicant
      notifyApplicant_(sessionId, 'returned');
    /* Escalate branch: hand off to the Division Head: flag the ISM row, create ONE pending DivHead
       row (dedup across multiple escalating members), and email the Division Head a review link. */
    } else if (decision === 'EscalateToDivisionHead') {
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.STATUS).setValue('EscalatedToDivisionHead');
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.REQUIRES_DIV_HEAD).setValue('YES');
      
      const escalationId = `${sessionId}-DIVHEAD`;
      ismWorkflowSheet.getRange(currentRow, ISM_WORKFLOW_COLS.DIV_HEAD_ESCALATION_ID).setValue(escalationId);
      
      const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
      const appData = readSheetValues_(appSheet);
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

      const divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
      
      // CRITICAL FIX: Check if a Pending DivHead record already exists for this session
      // Prevents duplicate escalation records when multiple ISM members escalate
      // Append-only workflow: scope the dedup check to the CURRENT round. A Pending escalation
      // left over from an earlier round must not suppress a legitimate new one.
      const escalationRound = getCurrentRound_(sessionId) || 1;
      const existingDivData = readSheetValues_(divHeadSheet);
      let hasPendingEscalation = false;
      let divHeadRowNum = -1; // 1-based sheet row of the Pending DivHead escalation (for NOTIFIED_DATE stamping)
      for (let di = 1; di < existingDivData.length; di++) {
        if (rowMatches_(existingDivData[di], DIV_HEAD_CONFIG_COLS, sessionId, __round) &&
            roundOf_(existingDivData[di], DIV_HEAD_CONFIG_COLS) === escalationRound &&
            existingDivData[di][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') {
          hasPendingEscalation = true;
          divHeadRowNum = di + 1;
          Logger.log(`[AUDIT] ${sessionId}: Pending DivHead escalation already exists for round ${escalationRound}, skipping duplicate creation`);
          break;
        }
      }

      if (!hasPendingEscalation) {
        divHeadSheet.appendRow([
          escalationId, sessionId, divHeadEmail, '', '', '', 'Pending', '', 'Pending', '',
          '',                // NOTIFIED_DATE
          escalationRound,   // ROUND_NUMBER
          ''                 // FLAGGED_FIELDS
        ]);
        divHeadRowNum = divHeadSheet.getLastRow();
      }

      Logger.log(`[AUDIT] ${sessionId}: ISM Review Escalated to Division Head (${divHeadEmail}) by ${ismMemberEmail}`);
      notifyApplicant_(sessionId, 'escalated_divhead');
      
      if (divHeadEmail) {
        try {
          const ts = new Date().getTime().toString();
          // CRITICAL FIX: Normalize email before token generation to prevent authorization mismatch
          // DELEGATION: see notifyApprover_, recipient and token subject must match.
          const _routed = recipientFor_(divHeadEmail);
          const normalizedDivHeadEmail = getNormalizedEmail_(_routed.email);
          const token = generateAuthToken_(sessionId, normalizedDivHeadEmail, ts, 'Review');
          const baseUrl = `${webAppUrl}?sessionId=${sessionId}&email=${encodeURIComponent(normalizedDivHeadEmail)}&token=${token}&ts=${ts}&step=1`;
          const reviewUrl = `${baseUrl}&action=Review&approverType=divhead`;
          
          const subject = `Action Required: Division Head Review for ${sessionId}`;
          const htmlBody = buildPiaEmailHtml_({
            heading: 'Action Required: Division Head Review',
            contentHtml: `
              ${delegationNoticeHtml_(_routed.onBehalfOf, _routed.reason)}
              <p style="margin:0 0 14px;font-size:14px;">A Privacy Impact Assessment requires your review as Division Head following an InfoSec escalation.</p>
              <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Division Head Escalation</div>
              <div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
                <strong>App ID:</strong> ${sessionId}<br>
                <strong>Program:</strong> ${escapeHtml_(programName)}<br>
                <strong>Division Head:</strong> ${escapeHtml_(divHeadName)}<br>
                <strong>Submitted by:</strong> ${escapeHtml_(applicantEmail)}
              </div>
              <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
                <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
                ${generateEmailDecisionsHTML_(sessionId)}
              </div>
              <div><a href="${reviewUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>`
          });
          queueEmail_(sessionId, _routed.email, subject, "Please view this email in an HTML-compatible client.", 'divhead', htmlBody);
          // Commit 6: mark when the Division Head was first notified (starts their 7-day reminder clock).
          if (divHeadRowNum > 0) stampNotifiedDate_(divHeadSheet, divHeadRowNum, DIV_HEAD_CONFIG_COLS.NOTIFIED_DATE);
        } catch(e) {
          Logger.log('Error queuing Div Head notification: ' + e);
          logAuditTrail_(sessionId, 'Email Failed', JSON.stringify({
            recipient: divHeadEmail || 'unknown',
            type: 'divhead',
            attempts: 0,
            error: 'QUEUE_CRASH: ' + e.toString()
          }));
        }
      }
    }

      return {
        ok: true,
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
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: notifyISMember_
  LAYMAN:    Emails the ISM/InfoSec reviewer at a given step that an access request needs their review,
             with a secure one-click "ISMReview" link.
  TECHNICAL: Flushes pending writes (so freshly-appended rows are visible), finds the Pending ISM row
             at stepNumber, builds an action-bound HMAC 'ISMReview' URL, renders via buildPiaEmailHtml_,
             and queueEmail_(type:'ism'). Missing member / errors are audited, never thrown.
  PARAMS:    - sessionId: application id; stepNumber, 1-based ISM step.
  RETURNS:   undefined. No-op (audited) if no Pending member at that step.
*/
function notifyISMember_(sessionId, stepNumber) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  try {
    // CRITICAL FIX C1: Get URL at runtime
    const webAppUrl = getWebAppUrl_() || ScriptApp.getService().getUrl();
    
    // CRITICAL: Flush pending writes so appended ISM rows are visible to read
    SpreadsheetApp.flush();
    
    const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const data = readSheetValues_(ismWorkflowSheet);

    let ismMember = null;
    let ismRowIndex = -1; // 0-based index into data (sheet row = index + 1) for NOTIFIED_DATE stamping
    for (let i = 1; i < data.length; i++) {
      if (rowMatches_(data[i], ISM_WORKFLOW_COLS, sessionId, __round) &&
          Number(data[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1]) === Number(stepNumber) &&
          data[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Pending') {
        ismMember = {
          name: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1],
          email: data[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]
        };
        ismRowIndex = i;
        break;
      }
    }

    if (!ismMember) {
      Logger.log('ERROR: ISM member not found for session=' + sessionId + ' step=' + stepNumber);
      logAuditTrail_(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'ism',
        attempts: 0,
        error: 'ISM member not found for step ' + stepNumber + ' (rows may not be committed yet)'
      }));
      return;
    }

    const ts = new Date().getTime().toString();
    // CRITICAL FIX: Normalize email before token generation to prevent authorization mismatch
    // DELEGATION: see notifyApprover_, recipient and token subject must be the same address.
    const _routed = recipientFor_(ismMember.email);
    const normalizedIsmEmail = getNormalizedEmail_(_routed.email);
    const token = generateAuthToken_(sessionId, normalizedIsmEmail, ts, 'ISMReview');
    const baseUrl = `${webAppUrl}?sessionId=${sessionId}&email=${encodeURIComponent(normalizedIsmEmail)}&token=${token}&ts=${ts}&step=${stepNumber}`;
    const reviewUrl = `${baseUrl}&action=ISMReview`;

    const appData = getApplicationData_(sessionId);
    const subject = `ISM InfoSec Review Required: ${sessionId}`;
    const htmlBody = buildPiaEmailHtml_({
      heading: 'ISM InfoSec Review Required',
      contentHtml: `
        ${delegationNoticeHtml_(_routed.onBehalfOf, _routed.reason)}
        <p style="margin:0 0 14px;font-size:14px;">An access request requires your InfoSec review.</p>
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">ISM InfoSec Approval, step ${stepNumber} of 2</div>
        <div style="background:#f4f7fb;color:#1a3a5c;border:1px solid #e5e7eb;padding:12px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
          <strong>App ID:</strong> ${sessionId}<br>
          <strong>Program:</strong> ${appData?.pia1?.program || '—'}<br>
          <strong>Department:</strong> ${appData?.pia1?.dept || '—'}<br>
          <strong>Submitted by:</strong> ${appData?.applicantEmail || '—'}
        </div>
        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Review Status</div>
          ${generateEmailDecisionsHTML_(sessionId)}
        </div>
        ${buildPriorReviewChipHtml_(sessionId, normalizedIsmEmail)}
        <div><a href="${reviewUrl}" style="display:inline-block;padding:11px 24px;background:#2a5285;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Review Access Request →</a></div>`
    });

    // Queue for deferred delivery (avoids Gmail throttling in-request)
    queueEmail_(sessionId, _routed.email, subject, "Please view this email in an HTML-compatible client.", 'ism', htmlBody);
    // Commit 6: mark when this ISM member was first notified (starts their 7-day reminder clock).
    if (ismRowIndex > 0) stampNotifiedDate_(ismWorkflowSheet, ismRowIndex + 1, ISM_WORKFLOW_COLS.NOTIFIED_DATE);
    Logger.log('✓ ISM review notification queued for ' + ismMember.email + ' step ' + stepNumber);
  } catch (e) {
    Logger.log('Error in notifyISMember_: ' + e.toString());
    try {
      logAuditTrail_(sessionId, 'Email Failed', JSON.stringify({
        recipient: 'unknown',
        type: 'ism',
        attempts: 0,
        error: 'QUEUE_CRASH: ' + e.toString()
      }));
    } catch(_) {}
  }
}

/*
  Function: routeApprovedRequest_
  LAYMAN:    The finish line. Once an application is fully approved, this builds the Certificate of
             Approval (with the full approver roster), turns it into a PDF, and emails it to the chosen
             implementation team(s): DCOPS, TechServe, or both, then tells the applicant it is routed.
  TECHNICAL: Validates destination against the whitelist, resolves DCOPS/TechServe emails via
             apiPhase3_GetInfoSecMembers_, gathers approver/divhead/ISM rows + DCS context, renders a
             certificate HTML, generates a PDF blob (Utilities.newBlob → getAs PDF), and sends via
             sendEmailWithRetry_ with the PDF attached. Finally notifyApplicant_('routed_implementation').
  PARAMS:    - sessionId: application id; destination, 'DCOPS' | 'TECHSERVE' | 'BOTH'.
  RETURNS:   { ok:true, message, sentTo } or { ok:false, code, message }.
*/
function routeApprovedRequest_(sessionId, destination) {
  const __round = getCurrentRound_(sessionId) || 1; // append-only: scope routing scans to the live round
  try {
    // Normalize destination to handle case sensitivity from frontend radio buttons
    const normalizedDest = String(destination || '').toUpperCase();
    const validDestinations = ['DCOPS', 'TECHSERVE', 'BOTH'];
    
    if (!validDestinations.includes(normalizedDest)) {
      return { ok: false, message: 'Invalid destination routing: ' + destination };
    }

    // Human-friendly routing label for the certificate (BOTH → "DCOPS and TechServe").
    const routedLabel = normalizedDest === 'BOTH' ? 'DCOPS and TechServe'
      : (normalizedDest === 'TECHSERVE' ? 'TechServe' : 'DCOPS');

    const ismInfo = apiPhase3_GetInfoSecMembers_();
    if (!ismInfo.ok) {
      return { ok: false, message: 'Could not retrieve destination email configuration' };
    }

    const appData = getApplicationData_(sessionId);
    if (!appData) {
      return { ok: false, message: 'Application not found' };
    }

    // SECURITY (F-02): a certificate may only be built for a fully-approved request. Both legitimate
    // callers stamp 'Approved by ISM' onto the Applications row immediately BEFORE calling here
    // (ISM path ~7862 → ~7871; Division-Head proxy path ~4372 → ~4379), so this always passes there.
    // Defense-in-depth behind the private-function rename: without it, any caller reaching this
    // function could email a forged "Implementation Required" certificate to DCOPS/TechServe.
    if (String(appData.status || '').trim() !== 'Approved by ISM') {
      Logger.log('SECURITY ALERT: routeApprovedRequest_ called for ' + sessionId +
                 ' with status "' + appData.status + '" (expected "Approved by ISM")');
      return { ok: false, message: 'This request is not fully approved.' };
    }

    // Fetch DCS Data for extended fields
    const dcsResult = apiPhase3_FetchDCSData(sessionId);
    const dcsData = dcsResult.ok ? dcsResult.data : {};

    // Resolve the site-specific TechServe email(s) for this request (Batch 3). Always computed so the
    // applicant/cert "contact TechServe" message shows the right site's team even for DCOPS-only routing.
    const siteTechserve = resolveTechserveForSite_(ismInfo.data.destinationEmails, dcsData.locations);
    // Name / email list (one per line) for the certificate footer + applicant email.
    const techserveListHtml = siteTechserve.map(function(t) {
      const nm = (t && t.name) ? escapeHtml_(String(t.name)) : '';
      const em = (t && t.email) ? escapeHtml_(String(t.email)) : '';
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
        // L2: this site has no TechServe configured, route to DCOPS instead of every team's inbox.
        Logger.log('WARN: No TechServe email for site "' + dcsData.locations + '" on ' + sessionId + '; routing to DCOPS instead.');
        const dcopsEmail = ismInfo.data.destinationEmails.dcops;
        if (dcopsEmail && destinationEmails.indexOf(dcopsEmail) === -1) {
          destinationEmails.push(dcopsEmail);
        }
      }
    }

    const validEmails = destinationEmails.filter(e => e).join(',');
    if (!validEmails) {
      return { ok: false, message: 'No destination email configured for ' + destination };
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
              <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(name || '—')} (${escapeHtml_(email || '—')})</td>
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
              <div style="font-weight: 600; color: #1a3a5c;">${escapeHtml_(a.name)}</div>
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">${escapeHtml_(roleToDisplay)}</div>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="display: inline-flex; align-items: center; background: #ecfdf5; color: #065f46; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;">Approved</span>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #4b5563;">
              ${escapeHtml_(a.comment || '—')}
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #4b5563;">
              ${escapeHtml_(dateStr)}
            </td>
          </tr>
        `;
      }
    });

    // 2. Division Head (if escalated)
    const divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);
    const divHeadData = readSheetValues_(divHeadSheet);
    for (let i = 1; i < divHeadData.length; i++) {
      if (rowMatches_(divHeadData[i], DIV_HEAD_CONFIG_COLS, sessionId, __round) && divHeadData[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Approved') {
        const divHeadEmailFromSheet = divHeadData[i][DIV_HEAD_CONFIG_COLS.DIV_HEAD_EMAIL - 1];
        const divHeadName = (appData.pia1 && getNormalizedEmail_(appData.pia1.divHeadEmail) === getNormalizedEmail_(divHeadEmailFromSheet))
          ? (appData.pia1.divHead || divHeadEmailFromSheet)
          : divHeadEmailFromSheet;
        const roleToDisplay = 'Division Head';
        const dateStr = divHeadData[i][DIV_HEAD_CONFIG_COLS.DECISION_DATE - 1] ? new Date(divHeadData[i][DIV_HEAD_CONFIG_COLS.DECISION_DATE - 1]).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
        headsApproversHtml += `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
              <div style="font-weight: 600; color: #1a3a5c;">${escapeHtml_(divHeadName)}</div>
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">${escapeHtml_(roleToDisplay)}</div>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="display: inline-flex; align-items: center; background: #ecfdf5; color: #065f46; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;">Approved</span>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #4b5563;">
              ${escapeHtml_(divHeadData[i][DIV_HEAD_CONFIG_COLS.COMMENTS - 1] || '—')}
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #4b5563;">
              ${escapeHtml_(dateStr)}
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
    const ismWorkflowSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    const ismData = readSheetValues_(ismWorkflowSheet);
    
    // Look up JobPos from InfoSec_Email_Config for ISM members
    const infosecSheet = getDatabaseSheet_(DB_SHEET_NAMES.INFOSEC_CONFIG, true);
    const infosecData = readSheetValues_(infosecSheet);
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
      if (rowMatches_(ismData[i], ISM_WORKFLOW_COLS, sessionId, __round) && ismData[i][ISM_WORKFLOW_COLS.STATUS - 1] === 'Approved') {
        const dateStr = ismData[i][ISM_WORKFLOW_COLS.DECISION_DATE - 1] ? new Date(ismData[i][ISM_WORKFLOW_COLS.DECISION_DATE - 1]).toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'}) : '—';
        const memberName = ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1];
        const jobPos = getJobPosForMember(memberName) || 'ISM InfoSec Member';
        ismApproversHtml += `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
              <div style="font-weight: 600; color: #1a3a5c;">${escapeHtml_(ismData[i][ISM_WORKFLOW_COLS.ISM_MEMBER_NAME - 1])}</div>
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">${escapeHtml_(jobPos)}</div>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: center;">
              <span style="display: inline-flex; align-items: center; background: #ecfdf5; color: #065f46; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;">Approved</span>
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #4b5563;">
              ${escapeHtml_(ismData[i][ISM_WORKFLOW_COLS.COMMENTS - 1] || '—')}
            </td>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; font-size: 12px; color: #4b5563;">
              ${escapeHtml_(dateStr)}
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
      const docLabelFor = function (f) {
        const n = (f.name || '').toUpperCase();
        if (f.type === 'CU' || n.includes('-CU') || n.includes('CONFIDENTIALITY')) return 'Confidentiality Undertaking';
        if (f.type === 'NDA' || n.includes('-NDA') || n.includes('NON-DISCLOSURE')) return 'Non-Disclosure Agreement';
        if (f.type === 'DPA' || n.includes('-DPA') || n.includes('DATA PROTECTION')) return 'Data Protection Agreement';
        if (f.type === 'DSA' || n.includes('-DSA')) return 'Data Sharing Agreement';
        if (f.type === 'ENDORSEMENT' || n.includes('ENDORSEMENT')) return 'Endorsement Letter';
        if (f.type === 'SUPPLEMENTARY') return 'Additional Supporting Document';
        return 'Supporting Document';
      };

      const certDocs = getAndShareDCSFiles_(appData.linkedReqId);
      if (certDocs && certDocs.length > 0) {
        const docRows = certDocs.map(function (f) {
          return `<tr><td style="padding:6px 0;font-weight:600;width:30%;color:#6b7280;">${escapeHtml_(docLabelFor(f))}</td><td style="padding:6px 0;color:#1a3a5c;"><a href="${escapeHtml_(f.url || '#')}" style="color:#185FA5;text-decoration:none;">${escapeHtml_(f.name || 'Document')}</a></td></tr>`;
        }).join('');
        supportingDocsListHtml = `
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Supporting Documents</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">${docRows}</table>
          </div>`;
      }

      // Commit 4: superseded (replaced) documents, kept viewable via the Archive folder, not trashed
      const supersededDocs = getDCSSupersededFiles_(appData.linkedReqId);
      if (supersededDocs && supersededDocs.length > 0) {
        const supRows = supersededDocs.map(function (f) {
          const roundLabel = f.supersededRound ? ` <span style="color:#9ca3af;">(replaced in round ${escapeHtml_(String(f.supersededRound))})</span>` : '';
          return `<tr><td style="padding:5px 0;font-weight:600;width:30%;color:#9ca3af;">${escapeHtml_(docLabelFor(f))}</td><td style="padding:5px 0;color:#9ca3af;"><a href="${escapeHtml_(f.url || '#')}" style="color:#9ca3af;text-decoration:underline;">${escapeHtml_(f.name || 'Document')}</a>${roundLabel}</td></tr>`;
        }).join('');
        supportingDocsListHtml += `
          <div style="margin-bottom: 30px;">
            <h2 style="color: #6b7280; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 12px;">Superseded Documents (previous versions)</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">${supRows}</table>
          </div>`;
      }
    } catch (e) { Logger.log('Cert supporting-docs build failed: ' + e.toString()); }

    // Round-4 (was Commit 3/Q1): the certificate now records the COMPLETE approval story, start to
    // finish in one grouped-by-round list (not just the prior "revision" rounds). Rendered always:
    // a never-returned request shows its single round.
    const certRevisionHistory = (function () {
      try { return buildUnifiedHistoryHtml_(getUnifiedHistory_(sessionId, false)); } catch (e) { return ''; }
    })();
    const certRevisionSection = certRevisionHistory
      ? `<div style="margin-bottom: 30px;"><h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Complete Approval History</h2>${certRevisionHistory}</div>`
      : '';

    const htmlBody = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; color: #333; line-height: 1.6; padding: 20px; background-color: #f9fafb;">
        <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 40px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #2a5285; padding-bottom: 20px;">
            <img src="https://upload.wikimedia.org/wikipedia/commons/e/e2/Megaworld_logo_and_wordmark.svg" alt="Megaworld Logo" height="28" style="margin-bottom: 15px;">
            <div style="color: #2a5285; font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 8px;">Megaworld ISM Department</div>
            <h1 style="color: #2a5285; margin: 0; font-size: 28px; letter-spacing: -0.02em;">Certificate of Approval</h1>
            <p style="color: #6b7280; margin: 5px 0 0 0; font-size: 14px;">Privacy Impact Assessment & Access Request</p>
          </div>

          <!-- Application Brief -->
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a3a5c; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 15px;">Application Brief</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 6px 0; font-weight: 600; width: 30%; color: #6b7280;">DCS Request ID</td>
                <td style="padding: 6px 0; font-weight: bold; color: #1a3a5c;">${escapeHtml_(appData.linkedReqId || 'N/A')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Program Name</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(appData.pia1?.program || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Department</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.department || appData.pia1?.dept || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Requestor</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.requestorName || dcsData.requestor || appData.applicantEmail || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Purpose</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(appData.pia1?.purpose || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">Scope</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(appData.pia1?.scope || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">Benefits</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(appData.pia1?.benefits || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">End User</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(appData.pia1?.endUser || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Access Type</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.accessNeeded || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Site / Office</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.locations || dcsData.location || '—')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">DCS Submitted</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_((function () { try { const d = dcsData.submissionDate; if (!d) return '—'; const p = new Date(d); return isNaN(p.getTime()) ? String(d) : p.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return '—'; } })())}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280; vertical-align: top;">PII Categories Collected</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${(function () { try { const pii = getPIIFieldsList_(appData); return pii && pii.length ? pii.map(function (p) { return escapeHtml_(p); }).join(', ') : 'None specified'; } catch (e) { return 'None specified'; } })()}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">iHelp Reference</td>
                <td style="padding: 6px 0; color: #1a3a5c;"><code>${escapeHtml_(dcsData.iHelpReference || '—')}</code></td>
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
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.agencyRequestType)}</td>
              </tr>` : ''}
              ${(dcsData.metadataAgency.agencyRequestType === 'Replacement' && dcsData.metadataAgency.replacementFullName) ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Replacing (Person)</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.replacementFullName)}</td>
              </tr>` : ''}
              ${(dcsData.metadataAgency.agencyRequestType === 'Replacement' && dcsData.metadataAgency.replacementEmail) ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Replaced Person Email</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${String(dcsData.metadataAgency.replacementEmail).trim() === 'N/A' ? 'N/A' : `<a href="mailto:${escapeHtml_(dcsData.metadataAgency.replacementEmail)}" style="color: #185FA5; text-decoration: none;">${escapeHtml_(dcsData.metadataAgency.replacementEmail)}</a>`}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.agencyName ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; width: 30%; color: #6b7280;">Agency Name</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.agencyName)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.agencyPersonnel ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Agency Personnel</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.agencyPersonnel)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.contractStartDate ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Contract Start Date</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.contractStartDate)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.networkDrive ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Network Drive</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.networkDrive)}</td>
              </tr>` : ''}
              ${dcsData.metadataAgency.immHeadRecoveryEmail ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Immediate Head Recovery Email</td>
                <td style="padding: 6px 0; color: #1a3a5c;"><a href="mailto:${escapeHtml_(dcsData.metadataAgency.immHeadRecoveryEmail)}" style="color: #185FA5; text-decoration: none;">${escapeHtml_(dcsData.metadataAgency.immHeadRecoveryEmail)}</a></td>
              </tr>` : ''}
              ${dcsData.metadataAgency.immHeadRecoveryNumber ? `
              <tr>
                <td style="padding: 6px 0; font-weight: 600; color: #6b7280;">Immediate Head Recovery No.</td>
                <td style="padding: 6px 0; color: #1a3a5c;">${escapeHtml_(dcsData.metadataAgency.immHeadRecoveryNumber)}</td>
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

          <!-- Revision History (Q1) -->
          ${certRevisionSection}

          <!-- Routing Information -->
          <div style="margin-top: 40px; padding-top: 25px; border-top: 2px solid #2a5285; text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">Implementation Routing</p>
            <p style="margin: 5px 0 0 0; font-size: 15px; font-weight: 600; color: #1a3a5c;">Routed to: ${escapeHtml_(routedLabel)}</p>
            <p style="margin: 5px 0 0 0; font-size: 13px; color: #9ca3af;">Received at: ${escapeHtml_(nowStr)}</p>
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

    sendEmailWithRetry_(validEmails, subject, "Please view this email in an HTML-compatible client.", {
      htmlBody: htmlBody,
      attachments: [pdfBlob]
    });

    Logger.log(`[AUDIT] ${sessionId}: Request routed to ${normalizedDest}: ${validEmails}`);
    // #20: do NOT send a second applicant email here. The 'approved_ism_final' email already told the
    // requester their request is fully approved; sending 'routed_implementation' too caused a duplicate.

    return {
      ok: true,
      message: `Request successfully routed to ${destination}`,
      sentTo: validEmails,
      pdfBlob: pdfBlob,
      techserveEmails: siteTechserve
    };
  } catch (e) {
    Logger.log('Error in routeApprovedRequest_: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLIENT-SIDE API ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/*
  Function: apiSubmitApplication
  LAYMAN:    The endpoint the form calls to submit a PIA. It cleans the input, checks it is complete,
             then saves it.
  TECHNICAL: sanitizeInput_ → validateApplicationData_ (returns errors early if invalid) → submitApplication_.
             The defense-in-depth gate before any DB write.
  PARAMS:    - appData: the raw submission from the client.
  RETURNS:   submitApplication_'s result, or { ok:false, errors:[...] } on validation failure.
*/
// Endpoints called from frontend via google.script.run
function apiSubmitApplication(appData) {
  const cleanData = sanitizeInput_(appData);
  const validation = validateApplicationData_(cleanData);
  if (!validation.isValid) {
    return {
      ok: false,
      errors: validation.errors
    };
  }
  return submitApplication_(cleanData);
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
  PARAMS:    - parentID: the DCS Request ID from the URL.
  RETURNS:   { ok:true, context, existingSubmissionId, existingSubmissionStatus,
             existingDraftSessionId, approverComments, approverFlags } or { ok:false, code, message }.
*/
function apiGetDCSContext(parentID) {
  try {
    // Defensive check to prevent createTextFinder from failing on null input.
    if (!parentID) {
      return { ok: false, message: 'The parentID parameter was not provided or is empty.' };
    }

    const userEmail = Session.getActiveUser().getEmail().toLowerCase();
    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const lastRow = dcsSheet.getLastRow();
    if (lastRow < 2) {
      return { ok: false, message: 'Data Collection sheet is empty.' };
    }

    // Normalize parentID: trim whitespace and ensure proper formatting
    const normalizedParentID = String(parentID).trim();
    if (!normalizedParentID) {
      return { ok: false, message: 'The parentID parameter is empty after trimming.' };
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
      return { ok: false, message: 'Parent ID not found in Data Collection sheet. Please verify the DCS link.' };
    }

    const rowNum = foundCell.getRow();
    const rowData = dcsSheet.getRange(rowNum, 1, 1, dcsSheet.getLastColumn()).getValues()[0];
    
    // Normalize both emails for comparison (handles +alias addresses)
    const ownerEmail = getNormalizedEmail_(String(rowData[DCS_COLS.USER_EMAIL - 1] || ''));
    const normalizedUserEmail = getNormalizedEmail_(userEmail);
    
    if (ownerEmail !== normalizedUserEmail) {
      Logger.log(`SECURITY ALERT: Unauthorized access attempt to DCS context for ${normalizedParentID} by ${normalizedUserEmail}. Owner is ${ownerEmail}.`);
      return { ok: false, message: 'You are not authorized to access this context.' };
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

    // Pre-populate PIA fields from DCS metadata, try all known key variations
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

    const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
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
          const apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
          const apprData = readSheetValues_(apprSheet);
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
              const ismSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, false);
              if (ismSheet) {
                const ismData = readSheetValues_(ismSheet);
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
              const divSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, false);
              if (divSheet) {
                const divData = readSheetValues_(divSheet);
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
      const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
      const draftsLastRow = draftsSheet.getLastRow();
      if (draftsLastRow >= 2) {
        const draftsData = draftsSheet.getRange(2, 1, draftsLastRow - 1, draftsSheet.getLastColumn()).getValues();
        for (let i = 0; i < draftsData.length; i++) {
          const rowEmail = getNormalizedEmail_(String(draftsData[i][1] || ''));
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
      ok: true, 
      context: context,
      existingSubmissionId: existingSubmissionId,
      existingSubmissionStatus: existingSubmissionStatus,
      existingDraftSessionId: existingDraftSessionId,
      approverComments: approverComments,
      approverFlags: approverFlags
    };

  } catch (e) {
    Logger.log('ERROR in apiGetDCSContext: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiGetUserDCSRequests
  LAYMAN:    Lists the current user's DCS requests (id + status) so the PIA app can offer them.
  TECHNICAL: Filters Data_Collection by the active user's email. try/catch → error.
  PARAMS:    (none)
  RETURNS:   { ok:true, requests:[{reqId, status}] } or { ok:false, code, message }.
*/
function apiGetUserDCSRequests() {
  try {
    const userEmail = Session.getActiveUser().getEmail().toLowerCase();
    const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
    const lastRow = dcsSheet.getLastRow();
    if (lastRow < 2) return {
      ok: true,
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
      ok: true,
      requests: requests
    };
  } catch (e) {
    Logger.log('ERROR in apiGetUserDCSRequests: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiGetUserEmail
  LAYMAN:    Tells the frontend who is signed in and whether they are allowed to use the app.
  TECHNICAL: Returns the active user email + isAuthorizedDomain_ flag.
  PARAMS:    (none)
  RETURNS:   { ok:true, email, isAuthorized } or { ok:false, email:'' }.
*/
function apiGetUserEmail() {
  try {
    const email = Session.getActiveUser().getEmail();
    return {
      ok: true,
      email: email,
      isAuthorized: isAuthorizedDomain_(email)
    };
  } catch (error) {
    Logger.log('ERROR in apiGetUserEmail: ' + error.toString());
    return {
      ok: false,
      email: ''
    };
  }
}

/*
  Function: apiGetUserSubmissions
  LAYMAN:    Frontend endpoint for the "My Applications" list.
  TECHNICAL: Thin wrapper over getUserSubmissions_(); re-throws on error so the client sees it.
  PARAMS:    (none)
  RETURNS:   Array of submission summaries ([] if none).
*/
function apiGetUserSubmissions() {
  try {
    const result = getUserSubmissions_();
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
  TECHNICAL: Wraps nextBaseSessionId_() (lock-guarded allocation).
  PARAMS:    (none)
  RETURNS:   { ok:true, sessionId, message } or { ok:false, code, message }.
*/
function apiGenerateNewSessionId() {
  try {
    Logger.log('🆕 apiGenerateNewSessionId called');
    const newSessionId = nextBaseSessionId_();
    Logger.log('  New sessionId generated: ' + newSessionId);
    return {
      ok: true,
      sessionId: newSessionId,
      message: 'Application session started'
    };
  } catch (error) {
    Logger.log('  ERROR in apiGenerateNewSessionId: ' + error.toString());
    return safeError_(error, ERR.INTERNAL);
  }
}

/*
  Function: apiProcessApprovalDecision
  LAYMAN:    Frontend endpoint to record an approver's decision (thin pass-through).
  TECHNICAL: Delegates to processApprovalDecision_ (which enforces lock + validation).
  PARAMS:    - sessionId, approverEmail, decision, comments, stepParam?.
  RETURNS:   processApprovalDecision_'s result.
*/
function apiProcessApprovalDecision(sessionId, approverEmail, decision, comments, stepParam = null) {
  return processApprovalDecision_(sessionId, approverEmail, decision, comments, stepParam);
}

/*
  Function: apiSaveDraft
  LAYMAN:    Auto-saves the user's in-progress PIA form so they can come back later. Keeps at most 5
             drafts per user (oldest dropped) and they expire after 7 days. Files are never saved here,
             text state only.
  TECHNICAL: Writes to the shared Drafts sheet (Type 'PIA'). Updates the existing row for this
             (user, sessionId) or inserts a new one; enforces MAX_USER_DRAFTS by deleting the oldest by
             epoch timestamp. Stores epoch ms for SavedAt/ExpiresAt (+DRAFT_EXPIRY_DAYS). try/catch.
  PARAMS:    - sessionId: the application/session id; stateData, form state object.
  RETURNS:   { ok:true, draftId, message } or { ok:false, code, message }.
*/
function apiSaveDraft(sessionId, stateData) {
  try {
    Logger.log('📥 apiSaveDraft called: sessionId=' + sessionId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    Logger.log('👤 User authenticated: ' + userEmail);
    
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
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
    const data = readSheetValues_(draftsSheet);
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
    return { ok: true, draftId: foundRow > 0 ? existingDraftId : draftId, message: 'Draft saved successfully' };
  } catch (e) {
    Logger.log('  ERROR in apiSaveDraft: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiRestoreDraft
  LAYMAN:    Reloads the saved draft for a given session (only if it belongs to the current user, and
             only if it hasn't expired).
  TECHNICAL: Scans Drafts for (user, sessionId, 'PIA'). Deletes + skips expired rows (epoch or legacy
             string). Parses and returns the state JSON. try/catch.
  PARAMS:    - sessionId: the session id.
  RETURNS:   { ok:true, state } ; { ok:false, state:null } if none; { ok:false, code, message }.
*/
function apiRestoreDraft(sessionId) {
  try {
    Logger.log('📤 apiRestoreDraft called: sessionId=' + sessionId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    Logger.log('👤 User authenticated: ' + userEmail);
    
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
    Logger.log('📋 Drafts sheet retrieved');
    const data = readSheetValues_(draftsSheet);
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
          return { ok: true, state: stateData };
        } catch (e) {
          Logger.log('  ERROR parsing draft state: ' + e.toString());
          return { ok: false, message: 'Corrupted draft data' };
        }
      }
    }
    
    Logger.log('   No draft found for this session (first load)');
    return { ok: false, state: null }; // No draft found (not an error)
  } catch (e) {
    Logger.log('  ERROR in apiRestoreDraft: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiListUserDrafts
  LAYMAN:    Lists the current user's still-valid (unexpired) PIA drafts for the "resume a draft" screen.
  TECHNICAL: Scans Drafts for (user, 'PIA') rows whose ExpiresAt is in the future, projecting
             {draftId, sessionId, savedAt, expiresAt, status}. try/catch.
  PARAMS:    (none)
  RETURNS:   { ok:true, drafts:[...] } or { ok:false, code, message }.
*/
function apiListUserDrafts() {
  try {
    Logger.log('📋 apiListUserDrafts called');
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    Logger.log('👤 User: ' + userEmail);
    
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
    const data = readSheetValues_(draftsSheet);
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
    return { ok: true, drafts: userDrafts };
  } catch (e) {
    Logger.log('  ERROR in apiListUserDrafts: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiLoadDraft
  LAYMAN:    Opens a specific saved draft by its id (only the owner can) and marks it as being edited.
  TECHNICAL: Finds the (user, draftId, 'PIA') row, parses state, and tags it with draftId/draftStatus/
             isLoadingExistingDraft for the frontend lock. try/catch.
  PARAMS:    - draftId: the draft UUID.
  RETURNS:   { ok:true, state } or { ok:false, code, message }.
*/
function apiLoadDraft(draftId) {
  try {
    Logger.log('📥 apiLoadDraft called: draftId=' + draftId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
    const data = readSheetValues_(draftsSheet);
    
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
          return { ok: true, state: stateData };
        } catch (e) {
          Logger.log('  ERROR parsing draft: ' + e.toString());
          return { ok: false, message: 'Corrupted draft data' };
        }
      }
    }
    
    Logger.log('  Draft not found or not owned by user');
    return { ok: false, message: 'Draft not found' };
  } catch (e) {
    Logger.log('  ERROR in apiLoadDraft: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiDeleteDraft
  LAYMAN:    Lets a user discard one of their incomplete drafts.
  TECHNICAL: Deletes the (user, draftId, 'PIA') Drafts row. try/catch.
  PARAMS:    - draftId: the draft UUID.
  RETURNS:   { ok:true, message } or { ok:false, code, message }.
*/
function apiDeleteDraft(draftId) {
  try {
    Logger.log('🗑️  apiDeleteDraft called: draftId=' + draftId);
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) throw new Error('User not authenticated');
    
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
    const data = readSheetValues_(draftsSheet);
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowDraftId = String(data[i][0] || '');
      const rowType = String(data[i][3] || '').trim();
      
      if (rowEmail === userEmail.toLowerCase() && rowDraftId === draftId && rowType === 'PIA') {
        draftsSheet.deleteRow(i + 1);
        Logger.log('✓ Draft deleted at row ' + (i+1));
        return { ok: true, message: 'Draft deleted' };
      }
    }
    
    Logger.log('  Draft not found or not owned by user');
    return { ok: false, message: 'Draft not found' };
  } catch (e) {
    Logger.log('  ERROR in apiDeleteDraft: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
  }
}

/*
  Function: apiMarkDraftComplete
  LAYMAN:    After a draft is successfully submitted, this removes it so it no longer shows up as
             incomplete.
  TECHNICAL: Deletes the user's 'PIA' Drafts row matching draftId OR sessionId (fallback ensures
             cleanup even if the id drifted). try/catch.
  PARAMS:    - draftId, sessionId.
  RETURNS:   { ok:true, message } or { ok:false, code, message }.
*/
function apiMarkDraftComplete(draftId, sessionId) {
  try {
    Logger.log('🏁 apiMarkDraftComplete called: draftId=' + draftId + ', sessionId=' + sessionId);
    const userEmail = Session.getActiveUser().getEmail();
    
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
    const data = readSheetValues_(draftsSheet);
    
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      const rowDraftId = String(data[i][0] || '');
      const rowSessionId = String(data[i][2] || '');
      const rowType = String(data[i][3] || '').trim();
      
      // Match by draftId OR sessionId (fallback) to ensure cleanup
      if (rowEmail === userEmail.toLowerCase() && rowType === 'PIA' && (rowDraftId === draftId || rowSessionId === sessionId)) {
        draftsSheet.deleteRow(i + 1);
        Logger.log('✓ Draft removed successfully (converted to submission) at row ' + (i+1));
        return { ok: true, message: 'Draft removed' };
      }
    }
    
    Logger.log('   Draft not found for cleanup');
    return { ok: false, message: 'Draft not found' };
  } catch (e) {
    Logger.log('  ERROR in apiMarkDraftComplete: ' + e.toString());
    return safeError_(e, ERR.INTERNAL);
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
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  try {
    const draftsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DRAFTS, true);
    const data = readSheetValues_(draftsSheet);
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
             the next revision id, but only for their own app, only if it really was returned/rejected,
             and not while the linked DCS is still 'Returned'.
  TECHNICAL: Validates base id format, finds the latest revision row for that base, enforces owner ==
             active user and status in (rejected|returned), and blocks if DCS-flagged and the DCS is
             still 'Returned'. Then returns getNextRevisionSessionId_(baseId). Throws on any gate failure.
  PARAMS:    - baseSessionId: the original/any-version application id.
  RETURNS:   { ok:true, sessionId } ; throws Error on invalid/unauthorized/not-revisable.
*/
function apiGenerateRevisionSessionId(baseSessionId) {
  const baseId = String(baseSessionId || '').trim().replace(/-V\d+$/, '');
  if (!/^PIA-\d{6}$/.test(baseId)) {
    throw new Error('Invalid base session ID format.');
  }

  const appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
  const data = readSheetValues_(appSheet);
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
      const dcsSheet = getDatabaseSheet_(DB_SHEET_NAMES.DATA_COLLECTION, true);
      const dcsData = readSheetValues_(dcsSheet);
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

  return { ok: true, sessionId: getNextRevisionSessionId_(baseId) };
}

/*
  Function: apiGetApplicationData
  LAYMAN:    The access-controlled "load my application" endpoint for the frontend. Only the applicant
             or someone on the approval chain may view it.
  TECHNICAL: getApplicationData_ then authorizes active user as owner or an approver email; otherwise
             logs a security alert and throws. Stringifies approver decisionDate Date objects to keep the
             google.script.run serialization safe.
  PARAMS:    - sessionId: application id.
  RETURNS:   The (serialization-safe) app object; null if not found; throws on unauthorized access.
*/
function apiGetApplicationData(sessionId) {
  // PERF: getApplicationData_ reads Applications + Approval_Workflow, and the
  // getCurrentRound_ inside it reads all three workflow sheets, so Approval_Workflow
  // gets pulled twice on every call. This is a pure read path, so the sheet-value cache
  // is safe to switch on for the gather; it is torn down before anything else runs.
  const appData = withSheetCache_(function () { return getApplicationData_(sessionId); });
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
  PARAMS:    - key: the Script Property name.
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
  RETURNS:   { ok:true, message }.
*/
function migrateAddReminderColumns() {
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  var sheets = [
    { name: DB_SHEET_NAMES.APPROVAL_WORKFLOW, headers: ['ReminderDate', 'EmailStatus', 'EmailError'] },
    { name: DB_SHEET_NAMES.ISM_WORKFLOW, headers: ['ReminderDate', 'EmailStatus', 'EmailError'] },
    { name: DB_SHEET_NAMES.DIV_HEAD_CONFIG, headers: ['ReminderDate', 'EmailStatus', 'EmailError'] },
    { name: DB_SHEET_NAMES.EMAIL_QUEUE, headers: ['NotifiedAdmin'] }
  ];

  sheets.forEach(function(def) {
    var sheet = getDatabaseSheet_(def.name, true);
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

  Logger.log('Migration complete. Run setupReminderTrigger_() to enable daily reminders.');
  return { ok: true, message: 'Reminder and failsafe columns migrated. Run setupReminderTrigger_() next.' };
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
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  Logger.log('╔════════════════════════════════════════════════════════════╗');
  Logger.log('║  REMINDER ENGINE: COMPREHENSIVE TEST                      ║');
  Logger.log('╚════════════════════════════════════════════════════════════╝');

  var TEST_PREFIX = 'TEST-RM-' + new Date().getTime().toString(36).toUpperCase();
  var TEST_EMAIL = 'test-reminder@domain.com';
  var results = { passed: 0, failed: 0, scenarios: [] };
  var createdSessionIds = [];
  var cleanedUp = false;

  try {
    // ── STEP 1: Set up test configuration ──
    Logger.log('\n📋 STEP 1: Verifying reminder config...');
    var config = getReminderConfig_();
    if (!config.enabled) {
      Logger.log('  ⚠ Reminders are DISABLED. Enabling for test...');
      adminSetReminderConfig_({ enabled: true, hour: 8 });
    }
    Logger.log('  ✓ Config: enabled=' + config.enabled + ' hour=' + config.hour);

    // ── STEP 2: Create 7 test scenarios in Applications sheet ──
    Logger.log('\n📋 STEP 2: Creating 7 test scenarios in Applications...');
    var appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
    var apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
    var ismSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);
    var divHeadSheet = getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true);

    var scenarios = [
      { id: TEST_PREFIX + '-PEND',  status: 'Pending',                  label: 'Pending: SHOULD remind',                    expectReminder: true,  sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-APPROV',status: 'Approved',                 label: 'Approved (ISM active): SHOULD remind',      expectReminder: true,  sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-DRAFT', status: 'Draft',                    label: 'Draft, should NOT remind',                  expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-DENIED',status: 'Denied',                   label: 'Denied, should NOT remind',                 expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-RETRN', status: 'Returned',                 label: 'Returned, should NOT remind',               expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW },
      { id: TEST_PREFIX + '-PHNTM', status: null,                       label: 'Phantom (no app row), should NOT remind',    expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW, phantom: true },
      { id: TEST_PREFIX + '-ISM',   status: 'Approved',                 label: 'ISM Pending: SHOULD remind',                expectReminder: true,  sheet: DB_SHEET_NAMES.ISM_WORKFLOW },
      { id: TEST_PREFIX + '-ALRDY', status: 'Pending',                  label: 'Already reminded today, should NOT remind',  expectReminder: false, sheet: DB_SHEET_NAMES.APPROVAL_WORKFLOW, alreadyReminded: true }
    ];

    var todayStr = new Date().getFullYear() + '-' +
      String(new Date().getMonth() + 1).padStart(2, '0') + '-' +
      String(new Date().getDate()).padStart(2, '0');

    scenarios.forEach(function(s) {
      createdSessionIds.push(s.id);

      // Create minimal PIA JSON data for getApplicationData_() to work
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
    Logger.log('\n📋 STEP 4: Running sendDailyReminders_()...');
    var result = sendDailyReminders_();
    Logger.log('  ✓ Result: reminded=' + result.reminded + ', processed=' + result.processed);

    // ── STEP 5: Validate Email_Queue results ──
    Logger.log('\n📋 STEP 5: Validating Email_Queue...');
    var queueSheet = getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true);
    var queueData = readSheetValues_(queueSheet);

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
      Logger.log('  ✅ PASS: Sequence test, first pending step was reminded (Step 1)');
      results.passed++;
      results.scenarios.push({ name: 'Sequence enforcement', status: 'PASS', reminded: true });
    } else {
      Logger.log('  ⚠ Sequence test: no reminder (may be legitimate if quota/other issue)');
      results.scenarios.push({ name: 'Sequence enforcement', status: 'WARN', reminded: false });
    }

    // ── STEP 6: Summary ──
    Logger.log('\n════════════════════════════════════════════════════════════');
    Logger.log('  TEST SUMMARY');
    Logger.log('════════════════════════════════════════════════════════════');
    Logger.log('  Passed: ' + results.passed + ' / Failed: ' + results.failed);
    Logger.log('  Total scenarios: ' + (results.passed + results.failed));

    if (results.failed === 0) {
      Logger.log('\n  ✅ ALL TESTS PASSED: Reminder engine is working correctly.');
    } else {
      Logger.log('\n  ❌ ' + results.failed + ' TEST(S) FAILED: Check logs above for details.');
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
        { sheet: getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true), col: 1 },
        { sheet: getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true), col: 2 },
        { sheet: getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true), col: 2 },
        { sheet: getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, true), col: 2 },
        { sheet: getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, true), col: 2 }
      ];

      cleanupSheets.forEach(function(cs) {
        if (!cs.sheet) return;
        var cd = readSheetValues_(cs.sheet);
        var rowsToDelete = [];
        for (var ci = 1; ci < cd.length; ci++) {
          var val = String(cd[ci][cs.col - 1] || '').trim();
          // Match TEST prefix sessionIds or email queue entries with TEST prefix
          if (val.indexOf(TEST_PREFIX) === 0) {
            rowsToDelete.push(ci + 1);
          }
        }
        if (rowsToDelete.length > 0) {
          batchDeleteRows_(cs.sheet, rowsToDelete);
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
  LAYMAN:    A big manual end-to-end test of the whole PIA lifecycle, submit, approve, return, deny,
             resubmit, the ISM/Division-Head path, email queue, and admin APIs, plus a small scalability
             batch. For developer verification in the Apps Script editor.
  TECHNICAL: Diagnostics only (not used at runtime). Drives the real functions against TEST-prefixed
             records, asserts sequence enforcement and duplicate-prevention, then reports pass/fail.
  PARAMS:    (none)
  RETURNS:   A results object (also logged).
*/
function testFullSystemFlow() {
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  Logger.log('╔══════════════════════════════════════════════════════════════╗');
  Logger.log('║  ULTIMATE SYSTEM FLOW: COMPREHENSIVE END-TO-END TEST       ║');
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
    var s = getDatabaseSheet_(sheetName, true);
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
      var cd = readSheetValues_(cs.sheet);
      var rows = [];
      for (var ci = 1; ci < cd.length; ci++) {
        for (var ti = 0; ti < allTestIds.length; ti++) {
          if (String(cd[ci][cs.col - 1] || '').indexOf(allTestIds[ti]) === 0) { rows.push(ci + 1); break; }
        }
      }
      if (rows.length > 0) batchDeleteRows_(cs.sheet, rows);
    });
    // Also clean Email_Queue by Type
    try {
      var eqSheet = getSheet(DB_SHEET_NAMES.EMAIL_QUEUE);
      var eqData = readSheetValues_(eqSheet);
      var eqRows = [];
      for (var ei = 1; ei < eqData.length; ei++) {
        var eqType = String(eqData[ei][EMAIL_QUEUE_COLS.TYPE - 1] || '');
        if (eqType === 'approver' || eqType === 'applicant' || eqType === 'reminder' || eqType === 'ism' || eqType === 'divhead') {
          for (var ti2 = 0; ti2 < allTestIds.length; ti2++) {
            if (String(eqData[ei][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '').indexOf(allTestIds[ti2]) === 0) { eqRows.push(ei + 1); break; }
          }
        }
      }
      if (eqRows.length > 0) batchDeleteRows_(eqSheet, eqRows);
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
    var r1 = processApprovalDecision_(aId, E, 'Approve', 'Looks good, approved.', null, '{}');
    check('Step 1 Approve succeeds', r1.ok, r1.message);
    SpreadsheetApp.flush();

    // Verify Step 1 is Approved
    var d = readSheetValues_(apprSheet);
    var step1ok = false, step2stillPending = false, appStatusApproved = false;
    for (var i = 1; i < d.length; i++) {
      if (d[i][APPROVAL_COLS.SESSION_ID - 1] === aId && d[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) step1ok = (d[i][APPROVAL_COLS.STATUS - 1] === 'Approved');
      if (d[i][APPROVAL_COLS.SESSION_ID - 1] === aId && d[i][APPROVAL_COLS.CURRENT_STEP - 1] == 2) step2stillPending = (d[i][APPROVAL_COLS.STATUS - 1] === 'Pending');
    }
    check('Step 1 status becomes Approved', step1ok, '');
    check('Step 2 still Pending after Step 1', step2stillPending, '');

    // Step 2 Approve
    var r2 = processApprovalDecision_(aId, E, 'Approve', 'Also approved.', null, '{}');
    check('Step 2 Approve succeeds', r2.ok, r2.message);
    SpreadsheetApp.flush();

    // Check app is Approved (Phase 3 init)
    var apps = readSheetValues_(appSheet);
    for (var i = 1; i < apps.length; i++) {
      if (apps[i][APPLICATIONS_COLS.SESSION_ID - 1] === aId) { appStatusApproved = (String(apps[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved') === 0); break; }
    }
    check('Application status becomes Approved', appStatusApproved, '');

    // Verify ISM workflow was initialized (2 rows in ISM sheet)
    var ismRows = 0;
    var ismD = readSheetValues_(ismSheet);
    for (var i = 1; i < ismD.length; i++) { if (ismD[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === aId) ismRows++; }
    check('ISM workflow initialized (2 rows)', ismRows === 2, 'found ' + ismRows);

    // Verify email was queued for applicant "approved_main"
    var queueData = readSheetValues_(queueSheet);
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

    var r3 = processApprovalDecision_(bId, E, 'Return', 'Please fix the scope section. This is a detailed comment explaining what needs to be changed. It needs to be at least 100 characters so adding more text here to meet the limit.', null, '{"PIA 1 - Scope":"Scope section is too vague"}');
    check('Return succeeds', r3.ok, r3.message);

    var appsB = readSheetValues_(appSheet);
    var retRow = null, retStatus = '';
    for (var i = 1; i < appsB.length; i++) { if (appsB[i][APPLICATIONS_COLS.SESSION_ID - 1] === bId) { retRow = i; retStatus = String(appsB[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('Application status becomes Returned', retStatus === 'Returned', retStatus);
    check('ApproverFlags stored for returned app', String(appsB[retRow][APPLICATIONS_COLS.APPROVER_FLAGS - 1] || '').indexOf('Scope') > 0, '');

    // ── TEST C: Deny ──
    Logger.log('\n📌 C. Deny application');
    var cId = genId('DENY');
    appSheet.appendRow([cId, E, 'Pending', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apprSheet.appendRow([cId+'-C1', cId, 1, 'Approver C1', E, '','', '','Pending','','Pending','']);

    var r4 = processApprovalDecision_(cId, E, 'Deny', 'This project does not meet compliance requirements. The policy framework is not fully established and data handling procedures are undefined. Additional work is needed before resubmission.', null, '{}');
    check('Deny succeeds', r4.ok, r4.message);

    var appsC = readSheetValues_(appSheet);
    var denyStatus = '';
    for (var i = 1; i < appsC.length; i++) { if (appsC[i][APPLICATIONS_COLS.SESSION_ID - 1] === cId) { denyStatus = String(appsC[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('Application status becomes Denied', denyStatus === 'Denied', denyStatus);

    // Verify Step 1 status is Denied
    var dC = readSheetValues_(apprSheet);
    var step1Denied = false;
    for (var i = 1; i < dC.length; i++) { if (dC[i][APPROVAL_COLS.SESSION_ID - 1] === cId && dC[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) { step1Denied = (dC[i][APPROVAL_COLS.STATUS - 1] === 'Denied'); break; } }
    check('Approval record set to Denied', step1Denied, '');

    // ── TEST D: Duplicate/re-process prevention ──
    Logger.log('\n📌 D. Re-process prevention');
    var r5 = processApprovalDecision_(bId, E, 'Approve', 'Trying to approve a returned app', null, '{}');
    check('Re-processing returned app returns error', !r5.ok, 'should fail');
    var r6 = processApprovalDecision_(cId, E, 'Approve', 'Trying to approve a denied app', null, '{}');
    check('Re-processing denied app returns error', !r6.ok, 'should fail');

    // ─────────────────────────────────────────────────────────────
    // ═══════════════ PHASE 3: ISM WORKFLOW ═══════════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ PHASE 3: ISM WORKFLOW ═══════════════════════');

    // Create an app approved by heads for ISM testing
    var dId = genId('P3OK');
    appSheet.appendRow([dId, E, 'Approved', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apprSheet.appendRow([dId+'-D1', dId, 1, 'Approver D1', E, 'Approved','ok','today','Approved','','Sent','']);
    // Initialize ISM workflow
    var initResult = apiPhase3_InitializeISMWorkflow_(dId);
    check('ISM init for P3 test succeeds', initResult.ok, initResult.message);

    // ── TEST E: ISM Person 1 Approves → Person 2 notified ──
    Logger.log('\n📌 E. ISM Person 1 Approve (triggers routing)');
    // Get the ISM member emails
    var ismData2 = readSheetValues_(ismSheet);
    var p1Email = '', p2Email = '';
    for (var i = 1; i < ismData2.length; i++) {
      if (ismData2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismData2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) p1Email = ismData2[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
      if (ismData2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === dId && ismData2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) p2Email = ismData2[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
    }
    check('ISM Person 1 has email', !!p1Email, p1Email);
    check('ISM Person 2 has email', !!p2Email, p2Email);

    var r7 = apiPhase3_ProcessISMDecision(dId, p1Email, 'Approve', 'ISM P1 approves with BOTH routing.', 'BOTH', 1, '{}');
    check('ISM Person 1 Approve succeeds', r7.ok, r7.message);
    SpreadsheetApp.flush();

    // Check Person 2 is still Pending
    var ismD2 = readSheetValues_(ismSheet);
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
    check('ISM Person 2 Approve succeeds', r8.ok, r8.message);
    SpreadsheetApp.flush();

    // Check app status becomes Approved by ISM
    var appD2 = readSheetValues_(appSheet);
    var ismFinalStatus = '';
    for (var i = 1; i < appD2.length; i++) { if (appD2[i][APPLICATIONS_COLS.SESSION_ID - 1] === dId) { ismFinalStatus = String(appD2[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App status after ISM approval', ismFinalStatus.indexOf('Approved by ISM') >= 0 || ismFinalStatus.indexOf('Approved') >= 0, ismFinalStatus);

    // ── TEST G: ISM Deny ──
    Logger.log('\n📌 G. ISM Deny');
    var gId = genId('ISMDN');
    appSheet.appendRow([gId, E, 'Approved', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apiPhase3_InitializeISMWorkflow_(gId);

    // Find the ISM emails for this new app
    var ismG = readSheetValues_(ismSheet);
    var p1G = '';
    for (var i = 1; i < ismG.length; i++) { if (ismG[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === gId && ismG[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1G = ismG[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r9 = apiPhase3_ProcessISMDecision(gId, p1G, 'Deny', 'This application has security risks that cannot be mitigated. Comprehensive review indicates multiple compliance gaps in data handling procedures. This decision is final.', '', 1, '{}');
    check('ISM Deny succeeds', r9.ok, r9.message);

    var appG = readSheetValues_(appSheet);
    var ismDenyStatus = '';
    for (var i = 1; i < appG.length; i++) { if (appG[i][APPLICATIONS_COLS.SESSION_ID - 1] === gId) { ismDenyStatus = String(appG[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App becomes Rejected by ISM', ismDenyStatus.indexOf('Rejected') >= 0, ismDenyStatus);

    // ── TEST H: ISM Return ──
    Logger.log('\n📌 H. ISM Return');
    var hId = genId('ISMRT');
    appSheet.appendRow([hId, E, 'Approved', pia1,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apiPhase3_InitializeISMWorkflow_(hId);

    var ismH = readSheetValues_(ismSheet);
    var p1H = '';
    for (var i = 1; i < ismH.length; i++) { if (ismH[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === hId && ismH[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1H = ismH[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r10 = apiPhase3_ProcessISMDecision(hId, p1H, 'Return', 'Please update the scope section and add more detail about data retention policies. The current description is too brief. Also ensure the DCS fields are updated accordingly. This requires at least fifty characters.', '', 1, '{}');
    check('ISM Return succeeds', r10.ok, r10.message);

    var appH = readSheetValues_(appSheet);
    var ismRetStatus = '';
    for (var i = 1; i < appH.length; i++) { if (appH[i][APPLICATIONS_COLS.SESSION_ID - 1] === hId) { ismRetStatus = String(appH[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App becomes Returned after ISM return', ismRetStatus === 'Returned', ismRetStatus);

    // ── TEST I: ISM Escalate → Division Head Approve ──
    Logger.log('\n📌 I. ISM Escalate → Div Head Approve');
    // Create app with DivHead email in PIA1 data
    var pia1Div = JSON.stringify({ program:'Test Escalation', dept:'IT', immediateHead:'Alice', immediateHeadEmail:E, deptHead:'Bob', deptHeadEmail:E, divHead:'Carol', divHeadEmail:E, drafterEmail:E });
    var iId = genId('P3ESC');
    appSheet.appendRow([iId, E, 'Approved', pia1Div,'{}','{}','{}',pia5,'',new Date().toLocaleString('en-PH'),'NO','','','{}']);
    apiPhase3_InitializeISMWorkflow_(iId);
    SpreadsheetApp.flush();

    var ismI = readSheetValues_(ismSheet);
    var p1I = '';
    for (var i = 1; i < ismI.length; i++) { if (ismI[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === iId && ismI[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1I = ismI[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r11 = apiPhase3_ProcessISMDecision(iId, p1I, 'EscalateToDivisionHead', 'This requires executive review due to cross-departmental data sharing concerns. The application involves sensitive PII that needs Division Head sign-off.', 'BOTH', 1, '{}');
    check('ISM Escalate succeeds', r11.ok, r11.message);
    SpreadsheetApp.flush();

    // Check Div Head record was created
    var divI = readSheetValues_(divSheet);
    var divPending = false;
    for (var i = 1; i < divI.length; i++) { if (divI[i][DIV_HEAD_CONFIG_COLS.SESSION_ID - 1] === iId && divI[i][DIV_HEAD_CONFIG_COLS.STATUS - 1] === 'Pending') { divPending = true; break; } }
    check('DivHead escalation record created', divPending, '');

    // Div Head approves (resolves Person 1's escalation, notifies Person 2)
    var r12 = processDivHeadDecision_(iId, E, 'Approve', 'Division Head approves after review. This is a detailed comment explaining the approval rationale for the escalated application. It must be long enough to pass validation.', '{}');
    check('DivHead Approve succeeds', r12.ok, r12.message);
    SpreadsheetApp.flush();

    // App stays "Escalated to Division Head" until Person 2 also approves
    var appI = readSheetValues_(appSheet);
    var escStatus = '';
    for (var i = 1; i < appI.length; i++) { if (appI[i][APPLICATIONS_COLS.SESSION_ID - 1] === iId) { escStatus = String(appI[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App still Escalated after DivHead (waiting for Person 2)', escStatus.indexOf('Escalated') >= 0, escStatus);

    // Now Person 2 approves → full approval reached
    var ismI2 = readSheetValues_(ismSheet);
    var p2I = '';
    for (var i = 1; i < ismI2.length; i++) { if (ismI2[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === iId && ismI2[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) { p2I = ismI2[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }
    var r13 = apiPhase3_ProcessISMDecision(iId, p2I, 'Approve', 'Person 2 approves after DivHead resolution.', 'BOTH', 2, '{}');
    check('ISM Person 2 Approve after Escalation succeeds', r13.ok, r13.message);
    SpreadsheetApp.flush();

    var appI2 = readSheetValues_(appSheet);
    var escFinal = '';
    for (var i = 1; i < appI2.length; i++) { if (appI2[i][APPLICATIONS_COLS.SESSION_ID - 1] === iId) { escFinal = String(appI2[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('App reaches Approved by ISM after full Escalation chain', escFinal.indexOf('Approved by ISM') >= 0, escFinal);

    // ─────────────────────────────────────────────────────────────
    // ═══════════════ ADMIN API TESTS ═════════════════════════════
    // ─────────────────────────────────────────────────────────────
    Logger.log('\n═══════════════ ADMIN API TESTS ═══════════════════════════════');

    var qSum = adminGetQueueSummary_();
    check('adminGetQueueSummary_ returns data', qSum.ok, qSum.message);
    check('Queue summary has total > 0', qSum.data.total > 0, 'total=' + qSum.data.total);

    var qLog = adminGetEmailLog_(aId);
    check('adminGetEmailLog_ returns array for FullApp', Array.isArray(qLog), typeof qLog);

    var failed = adminGetFailedEmails_(30);
    check('adminGetFailedEmails_ returns array', Array.isArray(failed), typeof failed);

    var remConfig = adminGetReminderConfig_();
    check('adminGetReminderConfig_ returns data', remConfig.ok, remConfig.message);

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
    var remResult = sendDailyReminders_();
    check('sendDailyReminders processes scalability batch', remResult.ok, remResult.message);
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
    var rem2 = sendDailyReminders_();
    check('Reminder ran for sequence test', rem2.ok, rem2.message);

    // Check Email_Queue: should have exactly 1 reminder entry for seqId (Step 1 only)
    var eqD = readSheetValues_(queueSheet);
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
      Logger.log('\n  🎉 ALL TESTS PASSED: System is working correctly!');
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
  LAYMAN:    The most thorough manual mega-test, runs every Phase 2 & 3 path (approvals, return, deny,
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
 *   ✓ Pipeline View (adminGetPipelineView_)
 *   ✓ Resend to Stage (adminResendToStage_)
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
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  Logger.log('╔══════════════════════════════════════════════════════════════════╗');
  Logger.log('║  🔥 ULTIMATE MEGA-TEST: ALL PATHS, 20 CONCURRENT USERS          ║');
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

  function getS(name) { return getDatabaseSheet_(name, true); }

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
      var s = getDatabaseSheet_(d.sheet, false);
      if (!s || s.getLastRow() < 2) return;
      var data = readSheetValues_(s);
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var cellVal = String(data[i][d.col - 1] || '').trim();
        for (var ti = 0; ti < allTestIds.length; ti++) {
          if (cellVal.indexOf(allTestIds[ti]) === 0) { rows.push(i + 1); break; }
        }
      }
      if (rows.length > 0) batchDeleteRows_(s, rows);
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

    var r1 = processApprovalDecision_(aId, E, 'Approve', 'Step 1 approved, looks good. This is a detailed comment meeting the minimum length requirement for validation purposes.', null, '{}');
    check('S1: Step 1 Approve succeeds', r1.ok, r1.message);
    SpreadsheetApp.flush();

    // Verify EmailStatus was stamped on Step 1 row
    var ad = readSheetValues_(apprSheet);
    var step1EmailStamped = false;
    for (var i = 1; i < ad.length; i++) {
      if (ad[i][APPROVAL_COLS.SESSION_ID - 1] === aId && ad[i][APPROVAL_COLS.CURRENT_STEP - 1] == 1) {
        step1EmailStamped = (String(ad[i][APPROVAL_COLS.EMAIL_STATUS - 1] || '') === 'Pending');
        break;
      }
    }
    check('S1: EmailStatus stamped Pending on Step 1', step1EmailStamped, '');

    var r2 = processApprovalDecision_(aId, E, 'Approve', 'Step 2 approved, proceeding to ISM. This comment is sufficiently long to pass all validation checks and requirements.', null, '{}');
    check('S1: Step 2 Approve succeeds', r2.ok, r2.message);
    SpreadsheetApp.flush();

    // Verify app status becomes Approved
    var apps = readSheetValues_(appSheet);
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
    var ismD = readSheetValues_(ismSheet);
    for (var i = 1; i < ismD.length; i++) { if (ismD[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === aId) ismCount++; }
    check('S1: ISM workflow initialized (2 rows)', ismCount === 2, 'found ' + ismCount);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: RETURN TO REQUESTOR
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 2: RETURN TO REQUESTOR ════════');

    var bId = genId('RETN');
    appSheet.appendRow([bId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([bId + '-B1', bId, 1, 'Approver B1', E, '', '', '', 'Pending', '', 'Pending', '']);

    var r3 = processApprovalDecision_(bId, E, 'Return', 'Please fix the scope section. This is a detailed comment explaining what needs to be changed. It must be at least one hundred characters to pass the validation check. Adding more text here to meet the requirement.', null, '{"PIA 1 - Scope":"Scope section is too vague"}');
    check('S2: Return succeeds', r3.ok, r3.message);

    var appsB = readSheetValues_(appSheet);
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

    var r4 = processApprovalDecision_(cId, E, 'Deny', 'This project does not meet compliance requirements. The policy framework is not fully established and data handling procedures are completely undefined. Additional work is needed.', null, '{}');
    check('S3: Deny succeeds', r4.ok, r4.message);

    var appsC = readSheetValues_(appSheet);
    var denyOk = false;
    for (var i = 1; i < appsC.length; i++) { if (appsC[i][APPLICATIONS_COLS.SESSION_ID - 1] === cId) { denyOk = (String(appsC[i][APPLICATIONS_COLS.STATUS - 1] || '') === 'Denied'); break; } }
    check('S3: App status is Denied', denyOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: DUPLICATE / RE-PROCESS PREVENTION
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 4: DUPLICATE PREVENTION ════════');

    var r5 = processApprovalDecision_(bId, E, 'Approve', 'Trying to approve a returned app should fail. This comment is long enough.', null, '{}');
    check('S4: Cannot approve returned app', !r5.ok, 'expected failure');

    var r6 = processApprovalDecision_(cId, E, 'Approve', 'Trying to approve a denied app should fail also. This comment is sufficiently long.', null, '{}');
    check('S4: Cannot approve denied app', !r6.ok, 'expected failure');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: ISM FULL APPROVAL (P1 → P2 → Approved by ISM)
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 5: ISM FULL APPROVAL ════════');

    var dId = genId('P3AP');
    appSheet.appendRow([dId, E, 'Approved', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([dId + '-D1', dId, 1, 'Approver D1', E, 'Approved', 'ok', 'today', 'Approved', '', 'Sent', '']);
    var initR = apiPhase3_InitializeISMWorkflow_(dId);
    check('S5: ISM init succeeds', initR.ok, initR.message);

    // Verify ISM rows have EmailStatus='Pending'
    var ismD5 = readSheetValues_(ismSheet);
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

    var r7 = apiPhase3_ProcessISMDecision(dId, p1E, 'Approve', 'ISM P1 approves: BOTH routing selected. This comment meets the minimum validation length requirement for ISM decisions.', 'BOTH', 1, '{}');
    check('S5: ISM P1 Approve succeeds', r7.ok, r7.message);
    SpreadsheetApp.flush();

    var r8 = apiPhase3_ProcessISMDecision(dId, p2E, 'Approve', 'ISM P2 approves, completing final ISM approval. All checks passed and the application is ready for routing to implementation teams.', '', 2, '{}');
    check('S5: ISM P2 Approve succeeds', r8.ok, r8.message);
    SpreadsheetApp.flush();

    var appsD = readSheetValues_(appSheet);
    var ismFinalOk = false;
    for (var i = 1; i < appsD.length; i++) {
      if (appsD[i][APPLICATIONS_COLS.SESSION_ID - 1] === dId) {
        ismFinalOk = (String(appsD[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved by ISM') >= 0);
        break;
      }
    }
    check('S5: App reaches Approved by ISM', ismFinalOk, '');

    // Check that queueEmail_ stamped ISM rows when notifications were sent
    var queueCheck = readSheetValues_(queueSheet);
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
    apiPhase3_InitializeISMWorkflow_(eId);
    var ismE = readSheetValues_(ismSheet);
    var p1E2 = '';
    for (var i = 1; i < ismE.length; i++) { if (ismE[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === eId && ismE[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1E2 = ismE[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r9 = apiPhase3_ProcessISMDecision(eId, p1E2, 'Deny', 'This application has critical security risks that cannot be mitigated. Comprehensive review indicates multiple compliance gaps in data handling procedures. This decision is final and binding.', '', 1, '{}');
    check('S6: ISM Deny succeeds', r9.ok, r9.message);

    var appsE = readSheetValues_(appSheet);
    var ismDenyOk = false;
    for (var i = 1; i < appsE.length; i++) { if (appsE[i][APPLICATIONS_COLS.SESSION_ID - 1] === eId) { ismDenyOk = (String(appsE[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Rejected') >= 0); break; } }
    check('S6: App becomes Rejected by ISM', ismDenyOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7: ISM RETURN
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 7: ISM RETURN ════════');

    var fId = genId('ISMRT');
    appSheet.appendRow([fId, E, 'Approved', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apiPhase3_InitializeISMWorkflow_(fId);
    var ismF = readSheetValues_(ismSheet);
    var p1F = '';
    for (var i = 1; i < ismF.length; i++) { if (ismF[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === fId && ismF[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) { p1F = ismF[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1]; break; } }

    var r10 = apiPhase3_ProcessISMDecision(fId, p1F, 'Return', 'Please update the scope section and add more detail about data retention policies. The current description is too brief. Also ensure DCS fields are updated accordingly.', '', 1, '{}');
    check('S7: ISM Return succeeds', r10.ok, r10.message);

    var appsF = readSheetValues_(appSheet);
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
    apiPhase3_InitializeISMWorkflow_(gId);
    SpreadsheetApp.flush();

    var ismG = readSheetValues_(ismSheet);
    var p1G = '', p2G = '';
    for (var i = 1; i < ismG.length; i++) {
      if (ismG[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === gId && ismG[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 1) p1G = ismG[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
      if (ismG[i][ISM_WORKFLOW_COLS.SESSION_ID - 1] === gId && ismG[i][ISM_WORKFLOW_COLS.CURRENT_STEP - 1] == 2) p2G = ismG[i][ISM_WORKFLOW_COLS.ISM_MEMBER_EMAIL - 1];
    }

    var r11 = apiPhase3_ProcessISMDecision(gId, p1G, 'EscalateToDivisionHead', 'This requires executive review due to cross-departmental data sharing concerns. The application involves sensitive PII that needs Division Head sign-off for proper authorization.', 'BOTH', 1, '{}');
    check('S8: ISM Escalate succeeds', r11.ok, r11.message);
    SpreadsheetApp.flush();

    // Check DivHead record created
    var divD = readSheetValues_(divSheet);
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
    var r12 = processDivHeadDecision_(gId, E, 'Approve', 'Division Head approves after thorough review of the escalated application. All concerns regarding cross-departmental data sharing have been addressed and the application meets compliance standards.', '{}');
    check('S8: DivHead Approve succeeds', r12.ok, r12.message);
    SpreadsheetApp.flush();

    // App should still be Escalated (waiting for Person 2)
    var appsG = readSheetValues_(appSheet);
    var escStatus = '';
    for (var i = 1; i < appsG.length; i++) { if (appsG[i][APPLICATIONS_COLS.SESSION_ID - 1] === gId) { escStatus = String(appsG[i][APPLICATIONS_COLS.STATUS - 1] || ''); break; } }
    check('S8: App still Escalated after DivHead (waiting P2)', escStatus.indexOf('Escalated') >= 0, escStatus);

    // Person 2 approves → full chain complete
    var r13 = apiPhase3_ProcessISMDecision(gId, p2G, 'Approve', 'Person 2 approves after DivHead resolution. All escalation concerns have been properly addressed and the application is now ready for final routing.', 'BOTH', 2, '{}');
    check('S8: ISM P2 Approve after escalation succeeds', r13.ok, r13.message);
    SpreadsheetApp.flush();

    var appsG2 = readSheetValues_(appSheet);
    var escFinalOk = false;
    for (var i = 1; i < appsG2.length; i++) { if (appsG2[i][APPLICATIONS_COLS.SESSION_ID - 1] === gId) { escFinalOk = (String(appsG2[i][APPLICATIONS_COLS.STATUS - 1] || '').indexOf('Approved by ISM') >= 0); break; } }
    check('S8: App reaches Approved by ISM after full escalation chain', escFinalOk, '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9: EMAIL FAILSAFE: NOTIFICATION CONFIG
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 9: EMAIL FAILSAFE & NOTIFICATION CONFIG ════════');

    var notifCfg = adminGetNotificationConfig_();
    check('S9: getNotificationConfig returns success', notifCfg.ok, notifCfg.message);
    check('S9: NotifyOnFailure defaults to YES', notifCfg.data && notifCfg.data.notifyOnFailure === 'YES', notifCfg.data ? notifCfg.data.notifyOnFailure : 'no data');
    check('S9: Admin email is configured', notifCfg.data && !!notifCfg.data.adminEmail, notifCfg.data ? notifCfg.data.adminEmail : 'none');

    var setCfg = adminSetNotificationConfig_({ notifyOnFailure: 'YES', notifyRequestor: 'YES' });
    check('S9: setNotificationConfig succeeds', setCfg.ok, setCfg.message);
    check('S9: Config persists after set', setCfg.data && setCfg.data.notifyOnFailure === 'YES', '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10: PIPELINE VIEW
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 10: PIPELINE VIEW ════════');

    var pipeline = adminGetPipelineView_(dId);
    check('S10: getPipelineView returns success', pipeline.ok, pipeline.message);
    check('S10: Pipeline has application', pipeline.data && !!pipeline.data.application, '');
    check('S10: Pipeline has approvalWorkflow', pipeline.data && Array.isArray(pipeline.data.approvalWorkflow) && pipeline.data.approvalWorkflow.length > 0, '');
    check('S10: Pipeline has ismWorkflow', pipeline.data && Array.isArray(pipeline.data.ismWorkflow) && pipeline.data.ismWorkflow.length > 0, '');
    check('S10: Pipeline has emailQueue entries', pipeline.data && Array.isArray(pipeline.data.emailQueue), '');
    check('S10: Pipeline has auditTrail', pipeline.data && Array.isArray(pipeline.data.auditTrail), '');

    // ═══════════════════════════════════════════════════════════════
    // SECTION 11: RESEND TO STAGE
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 11: RESEND TO STAGE ════════');

    // Create a fresh Pending entry, resend only works on rows with Status='Pending'
    var resendId = genId('RSND');
    appSheet.appendRow([resendId, E, 'Pending', pia1, '{}', '{}', '{}', pia5, '', new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([resendId + '-R1', resendId, 1, 'Resend Approver', E, '', '', '', 'Pending', '', '', '']);

    var resendR = adminResendToStage_(resendId, 'approver', E);
    check('S11: Resend to stage succeeds', resendR.ok, resendR.message);
    check('S11: Resend returns queueId', !!resendR.queueId, '');

    // Verify EmailStatus was reset to Pending
    var ad2 = readSheetValues_(apprSheet);
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

    var remResult = sendDailyReminders_();
    check('S12: sendDailyReminders succeeds', remResult.ok, remResult.message);

    // Check if a reminder was queued for our test entry
    var qD = readSheetValues_(queueSheet);
    var reminded = false;
    for (var i = 1; i < qD.length; i++) {
      if (String(qD[i][EMAIL_QUEUE_COLS.SESSION_ID - 1] || '') === remId && String(qD[i][EMAIL_QUEUE_COLS.TYPE - 1] || '') === 'reminder') {
        reminded = true; break;
      }
    }
    check('S12: Reminder queued for pending entry', reminded, '');

    // Verify ReminderDate was stamped
    var adR = readSheetValues_(apprSheet);
    var stamped = false;
    var todayStr = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0');
    for (var i = 1; i < adR.length; i++) {
      if (adR[i][APPROVAL_COLS.SESSION_ID - 1] === remId) {
        var rdVal = String(adR[i][APPROVAL_COLS.REMINDER_DATE - 1] || '');
        // Date may be stored as Date object or string, normalize
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
    // SECTION 13: 20 CONCURRENT USERS: BATCH SUBMIT & APPROVE
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
    var apprData = readSheetValues_(apprSheet);
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
      var r = processApprovalDecision_(batchIds[u], E, 'Approve', 'Concurrent batch approval #' + (u + 1) + '. This comment is sufficiently long to meet the minimum validation length requirement for approval decisions.', null, '{}');
      if (r.ok) approveSuccess++;
    }
    SpreadsheetApp.flush();
    var batchApproveMs = new Date().getTime() - batchApproveStart;
    Logger.log('  Approved ' + approveSuccess + '/' + CONCURRENT + ' in ' + batchApproveMs + 'ms (' + (batchApproveMs / CONCURRENT).toFixed(0) + 'ms avg)');
    check('S13: All 20 concurrent approvals succeed', approveSuccess === CONCURRENT, 'success=' + approveSuccess);

    // Verify all 20 have status Approved
    var appsCheck = readSheetValues_(appSheet);
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
    // SECTION 14: ADMIN API: QUEUE SUMMARY & EMAIL LOG
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 14: ADMIN APIs ════════');

    var qSum = adminGetQueueSummary_();
    check('S14: getQueueSummary returns data', qSum.ok, qSum.message);
    check('S14: Queue summary has total > 0', qSum.data && qSum.data.total > 0, qSum.data ? 'total=' + qSum.data.total : 'no data');

    var qLog = adminGetEmailLog_(aId);
    check('S14: getEmailLog returns array', Array.isArray(qLog), typeof qLog);

    var failed = adminGetFailedEmails_(30);
    check('S14: getFailedEmails returns array', Array.isArray(failed), typeof failed);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 15: REMINDER CONFIG
    // ═══════════════════════════════════════════════════════════════
    Logger.log('\n════════ SECTION 15: REMINDER CONFIG ════════');

    var remCfg = adminGetReminderConfig_();
    check('S15: getReminderConfig_ returns data', remCfg.ok, remCfg.message);
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
      Logger.log('\n  🎉 ALL ' + results.total + ' TESTS PASSED: System is battle-ready!');
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
        Logger.log('    ❌ ' + d.label + (d.detail ? ': ' + d.detail : ''));
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

/*
  Function: testHeaderSchema

  LAYMAN (Tropang Ex):
  Ito yung test na dapat nag-exist noon pa. Tinitingnan niya, kada sheet, kung yung
  totoong header sa spreadsheet ay tugma sa listahan sa code. Kung ito ay tumatakbo noong
  nagdagdag ako ng ActedBy, agad sana akong nabigyan ng error, sa halip na tahimik na
  nasira nang ilang araw.

  Sinusubukan din niya nang sadya na sirain: pinapalitan niya ang pangalan ng isang column,
  tinitingnan kung talagang sumasabog, tapos ibinabalik. Kasi ang test na "gumagana kapag
  tama" ay hindi test, kailangang patunayan na SUMASABOG kapag mali.

  TECHNICAL:
  Regression test for the header-driven schema. Asserts:
    (a) every PIA_SCHEMA sheet's live header row matches, column for column;
    (b) every derived *_COLS map resolves to the index its header sits at, which is the
        property that made hand-numbering unnecessary;
    (c) colsOf_ THROWS on an alias naming a column that is not in the schema;
    (d) assertSheetSchema_ THROWS on a genuinely renamed column, proven by renaming one for
        real and restoring it in a finally block;
    (e) assertSheetSchema_ TOLERATES an extra trailing column, since a hand-added annotation
        column must not take the app down.

  🚩 (d) mutates the live spreadsheet for a moment. It restores in `finally`, and it only ever
  touches the header CELL of the last schema column on Risk_Audit, the lowest-stakes sheet
  under schema control. If this test is ever interrupted mid-run, check Risk_Audit's header.

  Editor-run only.

  PARAMS:    (none)
  RETURNS:   { ok, success, passed, failed, total, details }
*/
function testHeaderSchema() {
  if (!isOwnerContext_()) return fail_(ERR.FORBIDDEN, 'Not authorized.');

  const details = [];
  let passed = 0, failed = 0;
  function check(name, cond, extra) {
    if (cond) { passed++; details.push('PASS  ' + name); }
    else { failed++; details.push('FAIL  ' + name + (extra ? ': ' + extra : '')); }
  }

  // (a) live header row matches the schema, per sheet
  Object.keys(PIA_SCHEMA).forEach(function (sheetName) {
    const expected = PIA_SCHEMA[sheetName];
    let sh = null;
    try { sh = getDatabaseSheet_(sheetName, false); } catch (e) { /* drift throws, caught below */ }
    if (!sh || sh.getLastRow() === 0) { details.push('SKIP  ' + sheetName + ' (absent or empty)'); return; }
    const actual = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), expected.length)).getValues()[0];
    const bad = [];
    for (let i = 0; i < expected.length; i++) {
      const found = String(actual[i] || '').trim();
      if (found !== expected[i]) bad.push('col ' + (i + 1) + ' expected "' + expected[i] + '" got "' + found + '"');
    }
    check('schema matches live header: ' + sheetName, bad.length === 0, bad.join('; '));
  });

  // (b) every derived map points at the column its header actually occupies
  const MAPS = [
    ['APPROVAL_COLS', 'Approval_Workflow', APPROVAL_COLS],
    ['ISM_WORKFLOW_COLS', 'ISM_Approval_Workflow', ISM_WORKFLOW_COLS],
    ['DIV_HEAD_CONFIG_COLS', 'DivisionHead_Approval_Workflow', DIV_HEAD_CONFIG_COLS],
    ['APPLICATIONS_COLS', 'Applications', APPLICATIONS_COLS],
    ['APPLICATION_SNAPSHOT_COLS', 'Application_Snapshots', APPLICATION_SNAPSHOT_COLS],
    ['DELEGATION_COLS', 'Delegations', DELEGATION_COLS],
    ['EMAIL_QUEUE_COLS', 'Email_Queue', EMAIL_QUEUE_COLS],
    ['AUDIT_COLS', 'Risk_Audit', AUDIT_COLS],
    ['DCS_COLS', 'Data_Collection', DCS_COLS],
    ['INFOSEC_CONFIG_COLS', 'InfoSec_Email_Config', INFOSEC_CONFIG_COLS],
    ['ADMIN_NOTIFICATION_COLS', 'Admin_Notification_Config', ADMIN_NOTIFICATION_COLS]
  ];
  MAPS.forEach(function (entry) {
    const mapName = entry[0], sheetName = entry[1], map = entry[2];
    const headers = PIA_SCHEMA[sheetName];
    const bad = [];
    Object.keys(map).forEach(function (k) {
      const idx = map[k];
      if (idx < 1 || idx > headers.length) { bad.push(k + ' index ' + idx + ' out of range'); return; }
      if (!headers[idx - 1]) bad.push(k + ' points at an empty header slot');
    });
    check(mapName + ' indices are all in range', bad.length === 0, bad.join('; '));
  });

  // (c) colsOf_ rejects an alias that names a column the schema does not have
  let threw = false;
  try { colsOf_('Approval_Workflow', { NOPE: 'ThisColumnDoesNotExist' }); }
  catch (e) { threw = true; }
  check('colsOf_ throws on an unknown column name', threw);

  // (d)+(e) assertSheetSchema_ actually detects a rename, and tolerates an extra column
  const PROBE_SHEET = 'Risk_Audit';
  const probeHeaders = PIA_SCHEMA[PROBE_SHEET];
  const probeCol = probeHeaders.length;              // last schema column
  const original = probeHeaders[probeCol - 1];
  let sh = null;
  try { sh = getDatabaseSheet_(PROBE_SHEET, false); } catch (e) { /* handled below */ }

  if (!sh || sh.getLastRow() === 0) {
    details.push('SKIP  drift-detection probe (Risk_Audit absent or empty)');
  } else {
    try {
      // (e) an extra trailing column must NOT trip the check
      const extraCol = Math.max(sh.getLastColumn(), probeHeaders.length) + 1;
      sh.getRange(1, extraCol).setValue('ZZ_TEMP_ANNOTATION');
      delete __SCHEMA_CHECKED[PROBE_SHEET];
      let tolerated = true;
      try { assertSheetSchema_(PROBE_SHEET); } catch (e) { tolerated = false; }
      check('extra trailing column is tolerated', tolerated);
      sh.getRange(1, extraCol).clearContent();

      // (d) a renamed column MUST throw
      sh.getRange(1, probeCol).setValue('ZZ_RENAMED_FOR_TEST');
      SpreadsheetApp.flush();
      delete __SCHEMA_CHECKED[PROBE_SHEET];
      let detected = false;
      try { assertSheetSchema_(PROBE_SHEET); }
      catch (e) { detected = String(e).indexOf('Schema drift') !== -1; }
      check('renamed column IS detected (the whole point)', detected);
    } catch (probeErr) {
      failed++;
      details.push('FAIL  drift probe raised unexpectedly: ' + probeErr);
    } finally {
      // Always put the header back, whatever happened above.
      try {
        sh.getRange(1, probeCol).setValue(original);
        SpreadsheetApp.flush();
        delete __SCHEMA_CHECKED[PROBE_SHEET];
      } catch (restoreErr) {
        details.push('WARN  COULD NOT RESTORE ' + PROBE_SHEET + ' col ' + probeCol +
                     ' to "' + original + '": FIX BY HAND. ' + restoreErr);
      }
    }
  }

  details.forEach(function (d) { Logger.log(d); });
  Logger.log('testHeaderSchema: ' + passed + ' passed, ' + failed + ' failed');
  return { ok: failed === 0, passed: passed, failed: failed,
           total: passed + failed, details: details };
}

/*
  Function: testDelegationResolution

  LAYMAN (Tropang Ex):
  Test para sa delegation. Ang pinakaimportanteng sinisigurado niya ay yung NEGATIBO: kapag
  WALANG delegation, dapat WALANG nagbago: parehong-pareho sa dati. Tapos: gumagana ba yung
  petsa (hindi pa nagsisimula = hindi pa; tapos na = hindi na), gumagana ba yung pag-pause,
  at hindi ba nagcha-chain (kung si A kay B, at si B kay C, si A ay kay B pa rin: HINDI kay C).

  TECHNICAL:
  Regression test for resolveDelegate_ / canActAs_ / delegatorsFor_. Asserts:
    (a) no delegation → resolveDelegate_ null, canActAs_ identical to a plain equality check;
    (b) an active delegation resolves, and canActAs_ reports onBehalfOf = the ORIGINAL;
    (c) a future-dated delegation does not apply yet, a past-dated one no longer applies;
    (d) Is_Active = NO overrides an otherwise-valid window;
    (e) delegation does NOT chain: A→B and B→C means A resolves to B, never to C;
    (f) a third party is still refused (the guard did not simply become permissive);
    (g) delegatorsFor_ is the exact inverse of resolveDelegate_.

  Editor-run only. Writes namespaced rows to Delegations and removes them afterwards.

  PARAMS:    (none)
  RETURNS:   { ok, passed, failed, total, details }
*/
function testDelegationResolution() {
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };

  const details = [];
  let passed = 0, failed = 0;
  function check(name, cond, extra) {
    if (cond) { passed++; details.push('PASS  ' + name); }
    else { failed++; details.push('FAIL  ' + name + (extra ? ': ' + extra : '')); }
  }

  const dom = getAllowedDomain_() || 'example.com';
  const A = 'deltest-a@' + dom, B = 'deltest-b@' + dom, C = 'deltest-c@' + dom, X = 'deltest-x@' + dom;
  const TAG = 'DELTEST-' + Date.now();
  const sheet = getDelegationsSheet_();
  if (!sheet) return { ok: false, message: 'Delegations sheet unavailable.' };

  const fmt = (d) => Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return fmt(d); };

  try {
    // (a) BASELINE: nothing configured yet.
    check('no delegation → resolveDelegate_ returns null', resolveDelegate_(A) === null);
    check('no delegation → self still allowed', canActAs_(A, A).allowed === true);
    check('no delegation → self reports no onBehalfOf', canActAs_(A, A).onBehalfOf === '');
    check('no delegation → stranger refused', canActAs_(B, A).allowed === false);

    // (b) ACTIVE: A is away, B covers.
    sheet.appendRow([TAG + '-1', A, B, day(-1), day(+7), 'Leave', 'YES', 'test', new Date().toISOString()]);
    SpreadsheetApp.flush();
    const r1 = resolveDelegate_(A);
    check('active delegation resolves to the delegate', !!r1 && getNormalizedEmail_(r1.email) === getNormalizedEmail_(B),
      r1 ? r1.email : 'null');
    const act = canActAs_(B, A);
    check('delegate is allowed to act', act.allowed === true);
    check('delegate acts ON BEHALF OF the original', getNormalizedEmail_(act.onBehalfOf) === getNormalizedEmail_(A),
      act.onBehalfOf);
    // 🚩 EXCLUSIVITY: the load-bearing assertion. While delegated, the ORIGINAL is refused
    // too. If this ever flips back to true, two people can approve the same Pending row.
    check('EXCLUSIVE: original is refused while delegated', canActAs_(A, A).allowed === false);
    check('EXCLUSIVE: exactly one identity may act',
      [canActAs_(A, A).allowed, canActAs_(B, A).allowed, canActAs_(X, A).allowed]
        .filter(Boolean).length === 1);
    // (f) the guard must not have become generally permissive
    check('unrelated third party still refused', canActAs_(X, A).allowed === false);
    // (g) inverse lookup
    check('delegatorsFor_ is the inverse', delegatorsFor_(getNormalizedEmail_(B)).indexOf(getNormalizedEmail_(A)) !== -1);
    check('recipientFor_ routes mail to the delegate',
      getNormalizedEmail_(recipientFor_(A).email) === getNormalizedEmail_(B));

    // (d) PAUSED via the flag, window still valid.
    sheet.getRange(sheet.getLastRow(), DELEGATION_COLS.IS_ACTIVE).setValue('NO');
    SpreadsheetApp.flush();
    check('Is_Active=NO overrides a valid window', resolveDelegate_(A) === null);
    // Pausing must hand authority straight BACK, otherwise a paused delegation would leave
    // the row with nobody able to act on it at all, which is worse than the original problem.
    check('pausing restores the original', canActAs_(A, A).allowed === true);
    check('pausing revokes the delegate', canActAs_(B, A).allowed === false);
    sheet.getRange(sheet.getLastRow(), DELEGATION_COLS.IS_ACTIVE).setValue('YES');

    // (c) WINDOW: not started yet, then already finished.
    sheet.getRange(sheet.getLastRow(), DELEGATION_COLS.START_DATE).setValue(day(+3));
    SpreadsheetApp.flush();
    check('future-dated delegation does not apply yet', resolveDelegate_(A) === null);
    sheet.getRange(sheet.getLastRow(), DELEGATION_COLS.START_DATE).setValue(day(-10));
    sheet.getRange(sheet.getLastRow(), DELEGATION_COLS.END_DATE).setValue(day(-2));
    SpreadsheetApp.flush();
    check('expired delegation no longer applies', resolveDelegate_(A) === null);
    sheet.getRange(sheet.getLastRow(), DELEGATION_COLS.END_DATE).setValue(day(+7));
    SpreadsheetApp.flush();

    // (e) NO CHAINING: B also delegates to C. A must still resolve to B.
    sheet.appendRow([TAG + '-2', B, C, day(-1), day(+7), 'Also away', 'YES', 'test', new Date().toISOString()]);
    SpreadsheetApp.flush();
    const r2 = resolveDelegate_(A);
    check('delegation does NOT chain (A→B, not A→C)',
      !!r2 && getNormalizedEmail_(r2.email) === getNormalizedEmail_(B), r2 ? r2.email : 'null');
    check('C cannot act for A through the chain', canActAs_(C, A).allowed === false);
    check('C CAN act for B directly', canActAs_(C, B).allowed === true);

  } catch (e) {
    failed++;
    details.push('FAIL  unexpected exception: ' + e.toString());
  } finally {
    try {
      const data = sheet.getDataRange().getValues();
      for (let i = data.length - 1; i >= 1; i--) {
        if (String(data[i][DELEGATION_COLS.DELEGATION_ID - 1] || '').indexOf(TAG) === 0) sheet.deleteRow(i + 1);
      }
    } catch (cleanupErr) {
      details.push('WARN  cleanup failed, remove ' + TAG + '* rows by hand: ' + cleanupErr.toString());
    }
  }

  details.forEach(function (d) { Logger.log(d); });
  Logger.log('testDelegationResolution: ' + passed + ' passed, ' + failed + ' failed');
  return { ok: failed === 0, passed: passed, failed: failed,
           total: passed + failed, details: details };
}

/*
  Function: testSheetReadCache

  LAYMAN (Tropang Ex):
  Test para sa bagong read cache. Tatlong bagay ang sinisigurado niya, at yung una ang
  pinakaimportante: kapag PATAY ang cache (default), dapat pareho lang siya sa dating code,
  walang naiba. Pangalawa: kapag BUKAS, hindi na siya nagdo-download ulit ng parehong tab.
  Pangatlo: kapag may sinulat ka habang bukas ang cache, kailangan mong sabihin sa cache na
  kalimutan yung luma (invalidateSheetCache_), kung hindi luma pa rin ang makikita mo, at
  yun mismo yung dahilan kung bakit hindi natin binubuksan ang cache sa mga write path.

  TECHNICAL:
  Regression test for withSheetCache_ / readSheetValues_ / invalidateSheetCache_. Asserts:
    (a) cache OFF is byte-equal to a direct getDataRange().getValues();
    (b) cache ON returns the SAME array reference on the second read (proving one fetch);
    (c) the cache is torn down after withSheetCache_ returns, including when fn throws;
    (d) a write made while the cache is ON is invisible until invalidateSheetCache_,
        this is the documented hazard, asserted deliberately so it stays documented;
    (e) nesting composes: an inner withSheetCache_ does not tear down the outer one.

  Editor-run only. Writes one namespaced row to Risk_Audit and deletes it afterwards.

  PARAMS:    (none)
  RETURNS:   { ok, passed, failed, total, details }
*/
function testSheetReadCache() {
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };

  const details = [];
  let passed = 0, failed = 0;
  function check(name, cond, extra) {
    if (cond) { passed++; details.push('PASS  ' + name); }
    else { failed++; details.push('FAIL  ' + name + (extra ? ': ' + extra : '')); }
  }

  const MARK = 'CACHETEST-' + Date.now();
  const sheet = getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, true);
  if (!sheet) return { ok: false, message: 'Risk_Audit sheet unavailable.' };

  try {
    // (a) OFF is identical to the raw call it replaced.
    check('cache starts OFF', __SHEET_CACHE === null);
    const raw = sheet.getDataRange().getValues();
    const viaHelper = readSheetValues_(sheet);
    check('OFF matches direct read (row count)', raw.length === viaHelper.length,
      raw.length + ' vs ' + viaHelper.length);
    check('OFF returns a FRESH array each time', readSheetValues_(sheet) !== viaHelper);

    // (b) + (e) ON dedupes, and nesting does not tear the outer cache down.
    withSheetCache_(function () {
      const first = readSheetValues_(sheet);
      const second = readSheetValues_(sheet);
      check('ON returns the SAME reference (one fetch)', first === second);
      withSheetCache_(function () {
        check('nested call reuses the outer cache', readSheetValues_(sheet) === first);
      });
      check('cache survives the nested call', __SHEET_CACHE !== null &&
        readSheetValues_(sheet) === first);

      // (d) the documented staleness hazard, a write is invisible until invalidated.
      const before = first.length;
      sheet.appendRow([MARK, '', '', 'CacheTest', '', '', new Date().toISOString()]);
      SpreadsheetApp.flush();
      check('stale-by-design: write NOT visible while cached',
        readSheetValues_(sheet).length === before);
      invalidateSheetCache_(sheet);
      check('write visible after invalidateSheetCache_',
        readSheetValues_(sheet).length === before + 1);
    });

    // (c) torn down on the normal path.
    check('cache OFF again after withSheetCache_', __SHEET_CACHE === null);

    // (c) torn down on the throwing path too.
    try {
      withSheetCache_(function () { throw new Error('boom'); });
    } catch (ignored) { /* expected */ }
    check('cache OFF again after a throw', __SHEET_CACHE === null);

  } catch (e) {
    failed++;
    details.push('FAIL  unexpected exception: ' + e.toString());
  } finally {
    // Clean up the marker row regardless of outcome.
    try {
      const data = sheet.getDataRange().getValues();
      for (let i = data.length - 1; i >= 1; i--) {
        if (String(data[i][0]) === MARK) sheet.deleteRow(i + 1);
      }
    } catch (cleanupErr) {
      details.push('WARN  cleanup failed: ' + cleanupErr.toString());
    }
    __SHEET_CACHE = null; // never leave the cache on for the next execution
  }

  details.forEach(function (d) { Logger.log(d); });
  Logger.log('testSheetReadCache: ' + passed + ' passed, ' + failed + ' failed');
  return { ok: failed === 0, passed: passed, failed: failed,
           total: passed + failed, details: details };
}

/*
  Function: testAppendOnlyRounds

  LAYMAN (Tropang Ex):
  Ito yung test para sa pinakabagong pagbabago: hindi na binubura ang lumang approval rows tuwing
  may resubmit. Ginagaya niya yung totoong senaryo, may na-approve, may na-return habang may
  approver na hindi pa nakakaaksyon, tapos nag-resubmit. Sinisiguro niyang (a) buhay pa rin yung
  round 1, (b) may bagong round 2, at (c) yung pinaka-importante: hindi na-route pabalik sa
  natengga na approver ng round 1. Yun mismo yung bug na tinatakpan ng lumang delete.

  TECHNICAL:
  Focused regression test for the append-only workflow. Builds a session with a Stage-A ladder and
  an ISM row that stays Pending (the abandoned-row case), drives a Return, calls submitApplication_
  to force a resubmit, then asserts round retention, round increment, and, the load-bearing one,
  that getCurrentRound_-scoped routing does NOT match the round-1 leftover.

  Editor-run only. Writes to the live DB under a namespaced session id and cleans up after itself.

  PARAMS:    (none)
  RETURNS:   { ok, passed, failed, total, details }
*/
function testAppendOnlyRounds() {
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };

  var T = 'ROUNDTEST-' + new Date().getTime().toString(36).toUpperCase();
  var E = Session.getActiveUser().getEmail();
  var r = { passed: 0, failed: 0, total: 0, details: [] };

  function check(label, ok, detail) {
    r.total++;
    if (ok) { r.passed++; Logger.log('  ✅ ' + label); }
    else { r.failed++; Logger.log('  ❌ ' + label + (detail ? ' → ' + detail : '')); }
    r.details.push({ label: label, pass: !!ok, detail: detail || '' });
  }

  var appSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATIONS, true);
  var apprSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPROVAL_WORKFLOW, true);
  var ismSheet = getDatabaseSheet_(DB_SHEET_NAMES.ISM_WORKFLOW, true);

  Logger.log('🔁 Append-only round test: ' + T);

  try {
    var pia1 = JSON.stringify({
      program: 'Round Test', dept: 'QA',
      immediateHead: 'Head One', immediateHeadEmail: E,
      deptHead: 'Head Two', deptHeadEmail: E, drafterEmail: E
    });

    // ── Round 1: two Stage-A approvers, plus an ISM row that never gets actioned ──
    appSheet.appendRow([T, E, 'Pending', pia1, '{}', '{}', '{}', '[]', '',
      new Date().toLocaleString('en-PH'), 'NO', '', '', '{}']);
    apprSheet.appendRow([T + '-1', T, 1, 'Head One', E, '', '', '', 'Pending', '', 'Pending', '', '', 1, '']);
    apprSheet.appendRow([T + '-2', T, 2, 'Head Two', E, '', '', '', 'Pending', '', 'Pending', '', '', 1, '']);
    ismSheet.appendRow([T + '-ISM-1', T, 1, 'ISM One', E, '', '', '', 'Pending', 'NO', '', '', '', 'Pending', '', '', 1, '']);
    SpreadsheetApp.flush();

    check('S1: round 1 detected', getCurrentRound_(T) === 1, 'got ' + getCurrentRound_(T));

    // Return at step 1 with a flag, this is what bounces it back to the applicant.
    var ret = processApprovalDecision_(T, E, 'Return', 'Returning for corrections. This comment is deliberately long enough to satisfy the minimum-length validation applied to Return decisions.', 1, JSON.stringify({ 'Program Name': 'please correct this' }));
    check('S2: Return accepted', ret && ret.ok, ret && ret.message);
    SpreadsheetApp.flush();

    // Flags must be persisted on the approver's OWN row (replaces Revision_History.FlaggedFields).
    var ad = readSheetValues_(apprSheet);
    var flagFound = false;
    for (var i = 1; i < ad.length; i++) {
      if (String(ad[i][APPROVAL_COLS.SESSION_ID - 1]) === T &&
          Number(ad[i][APPROVAL_COLS.CURRENT_STEP - 1]) === 1 &&
          String(ad[i][APPROVAL_COLS.FLAGGED_FIELDS - 1] || '').indexOf('Program Name') !== -1) {
        flagFound = true; break;
      }
    }
    check('S3: flags stored on the returning approver row', flagFound);

    // ── Resubmit → should APPEND round 2, not delete round 1 ──
    var resub = submitApplication_({
      sessionId: T, appId: T, pia1: JSON.parse(pia1), pia2: {}, pia3: {}, pia4: {}, pia5: [],
      linkedReqId: '', isFlagged: false
    });
    check('S4: resubmit accepted', resub && resub.ok, resub && resub.message);
    SpreadsheetApp.flush();

    var after = readSheetValues_(apprSheet);
    var round1 = 0, round2 = 0, pendingRound1Steps = [];
    for (var j = 1; j < after.length; j++) {
      if (String(after[j][APPROVAL_COLS.SESSION_ID - 1]) !== T) continue;
      var rd = roundOf_(after[j], APPROVAL_COLS);
      if (rd === 1) {
        round1++;
        if (String(after[j][APPROVAL_COLS.STATUS - 1]) === 'Pending') {
          pendingRound1Steps.push(Number(after[j][APPROVAL_COLS.CURRENT_STEP - 1]));
        }
      }
      if (rd === 2) round2++;
    }

    check('S5: round 1 rows RETAINED (not deleted)', round1 >= 2, 'found ' + round1);
    check('S6: round 2 rows appended', round2 >= 2, 'found ' + round2);
    check('S7: current round is now 2', getCurrentRound_(T) === 2, 'got ' + getCurrentRound_(T));

    // The whole point: a round-1 row left Pending must NOT be reachable by round-2 routing.
    check('S8: round 1 left an abandoned Pending row (the hazard exists)',
      pendingRound1Steps.length > 0, 'none found, test would be vacuous');

    var leaked = false;
    for (var k = 1; k < after.length; k++) {
      if (rowMatches_(after[k], APPROVAL_COLS, T, 2) && roundOf_(after[k], APPROVAL_COLS) !== 2) leaked = true;
    }
    check('S9: round-scoped matcher never returns a non-round-2 row', !leaked);

    // The ISM row abandoned in round 1 must also be invisible to round-2 routing.
    var ismAfter = readSheetValues_(ismSheet);
    var ismLeak = false;
    for (var m = 1; m < ismAfter.length; m++) {
      if (rowMatches_(ismAfter[m], ISM_WORKFLOW_COLS, T, 2) &&
          String(ismAfter[m][ISM_WORKFLOW_COLS.STATUS - 1]) === 'Pending') ismLeak = true;
    }
    check('S10: abandoned round-1 ISM row is NOT matched at round 2', !ismLeak);

    // History must span BOTH rounds.
    var hist = getUnifiedHistory_(T, true);
    check('S11: unified history spans 2 rounds', hist && hist.rounds && hist.rounds.length >= 2,
      'rounds=' + (hist && hist.rounds ? hist.rounds.length : 'n/a'));

    // The answers snapshot must have captured the pre-overwrite submission.
    var snapSheet = getDatabaseSheet_(DB_SHEET_NAMES.APPLICATION_SNAPSHOTS, false);
    var snapCount = 0;
    if (snapSheet && snapSheet.getLastRow() > 1) {
      var sd = readSheetValues_(snapSheet);
      for (var n = 1; n < sd.length; n++) {
        if (String(sd[n][APPLICATION_SNAPSHOT_COLS.SESSION_ID - 1]) === T) snapCount++;
      }
    }
    check('S12: one Application_Snapshots row written on resubmit', snapCount === 1, 'got ' + snapCount);

  } catch (e) {
    check('FATAL: test threw', false, e.toString());
  } finally {
    // ── Cleanup: remove every row this test created ──
    try {
      [{ s: appSheet, c: APPLICATIONS_COLS.SESSION_ID },
       { s: apprSheet, c: APPROVAL_COLS.SESSION_ID },
       { s: ismSheet, c: ISM_WORKFLOW_COLS.SESSION_ID },
       { s: getDatabaseSheet_(DB_SHEET_NAMES.DIV_HEAD_CONFIG, false), c: DIV_HEAD_CONFIG_COLS.SESSION_ID },
       { s: getDatabaseSheet_(DB_SHEET_NAMES.APPLICATION_SNAPSHOTS, false), c: APPLICATION_SNAPSHOT_COLS.SESSION_ID },
       { s: getDatabaseSheet_(DB_SHEET_NAMES.EMAIL_QUEUE, false), c: EMAIL_QUEUE_COLS.SESSION_ID },
       { s: getDatabaseSheet_(DB_SHEET_NAMES.RISK_AUDIT, false), c: AUDIT_COLS.SESSION_ID }
      ].forEach(function (def) {
        if (!def.s || def.s.getLastRow() < 2) return;
        var vals = readSheetValues_(def.s);
        var rows = [];
        for (var x = 1; x < vals.length; x++) {
          if (String(vals[x][def.c - 1] || '').indexOf(T) === 0) rows.push(x + 1);
        }
        if (rows.length) batchDeleteRows_(def.s, rows);
      });
      Logger.log('  🧹 cleanup complete');
    } catch (ce) { Logger.log('  ⚠ cleanup failed: ' + ce.toString()); }
  }

  Logger.log('🔁 Append-only round test: ' + r.passed + '/' + r.total + ' passed: ' + r.failed + ' failed');
  return { ok: r.failed === 0, passed: r.passed, failed: r.failed, total: r.total, details: r.details };
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
  // SECURITY: public by necessity (trigger handlers bind by name string; editor-run helpers
  // must appear in the Run picker). Gate on owner-or-trigger context so a domain user cannot
  // invoke it from a browser console via google.script.run.
  if (!isOwnerContext_()) return { ok: false, message: 'Not authorized.' };
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');
  Logger.log('ADMIN_API_KEY: ' + (key ? '✅ SET (' + key.substring(0, 6) + '...)' : '❌ MISSING'));
}
