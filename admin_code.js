/**
 * Admin SPA System - Server-side Google Apps Script
 * 
 * Fetches data from multiple sheets and serves an admin view.
 * 
 * Script Properties Required:
 *   SPREADSHEET_ID  - ID of the Google Spreadsheet containing all PIA sheets
 *   SHEET_PREFIX    - Prefix for sheet names (e.g., "PIA System Database - ")
 *   ALLOWED_DOMAIN  - (optional) Domain to restrict access to, e.g.
 *   DOMAIN          - (optional) Domain for authorization check, e.g. "companycorp.com"
 *                     Required when ENABLED_DOMAIN_CHECK is true.
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

// ─── Domain Authorization Configuration ───────────────────────────────────────
// DOMAIN Script Property — e.g. "companycorp.com" (no leading @)
// Set in Project Settings → Script Properties.
const ENABLED_DOMAIN_CHECK = true;

function getPrefix() {
  return PropertiesService.getScriptProperties().getProperty('SHEET_PREFIX') || 'PIA System Database - ';
}

// ─── doGet() - Serve Admin View ────────────────────────────────────────────────
function doGet(e) {
  // One-time setup: visit ?setup=domain to configure ALLOWED_DOMAIN
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

  // Auto-configure ALLOWED_DOMAIN if not set and user is a known admin
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

// ─── doPost() - Handle POST Requests ───────────────────────────────────────────
function doPost(e) {
  // ── Admin API: detect JSON payloads and route to handleAdminApi_ ──
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

// ─── Access Control ────────────────────────────────────────────────────────────
function checkAccess_(email) {
  // 1. SPREADSHEET_ID must be set, or deny immediately
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

// ─── Script Properties Helper ──────────────────────────────────────────────────
function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

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

/**
 * submitDCS() — Defense-in-depth: re-validates domain authorization even when
 * called programmatically (e.g., via google.script.run or a POST request).
 * This is a second layer of protection on the backend submission path.
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

var ADMIN_API_KEY = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY') || '';

/**
 * Main dispatcher for Admin API requests.
 * Called from doPost() when a JSON payload with an apiKey is detected.
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

      // ── Reminder Engine ──
      case 'getReminderConfig':
        return adminApi_getReminderConfig();
      case 'setReminderConfig':
        return adminApi_setReminderConfig(params.config);
      case 'setupReminderTrigger':
        return adminApi_setupReminderTrigger();
      case 'sendDailyReminders':
        return adminApi_sendDailyReminders();

      default:
        return { success: false, error: 'Unknown admin API action: ' + action };
    }
  } catch (e) {
    Logger.log('[ADMIN_API] Unhandled error in handleAdminApi_: ' + e.toString());
    return { success: false, error: 'Internal server error: ' + e.toString() };
  }
}

// ─── Email Queue (Risk_Audit sheet as queue) ───────────────────────────────────

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

function adminApi_getFailedEmails(sinceDays) {
  return adminGetFailedEmails(sinceDays);
}

function adminApi_getEmailLog(sessionId) {
  return adminGetEmailLog(sessionId);
}

function adminApi_resendEmail(sessionId, recipient, type) {
  return adminResendEmail(sessionId, recipient, type);
}

// ─── Queue Entry Actions ──────────────────────────────────────────────────────

function adminApi_retryQueuedEmail(queueId) {
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

function adminApi_retryAllForSession(sessionId, status) {
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

function adminApi_cancelQueuedEmails(sessionId, type) {
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

function adminApi_setNotificationConfig(config) {
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

// ─── Reminder Engine ──────────────────────────────────────────────────────────

function adminApi_getReminderConfig() {
  try {
    var sysSheet;
    try { sysSheet = getSheet_(SHEET_NAMES.SYSTEM_CONFIG); } catch(e) { return { success: false, error: e.message }; }
    var rows = sheetToObjects_(sysSheet);
    var config = { enabled: false, hour: 9, timezone: 'Asia/Manila', triggerActive: false, lastRun: '' };
    for (var i = 0; i < rows.length; i++) {
      var key = String(rows[i].Configuration_Key || '').trim();
      var val = String(rows[i].Value || '').trim();
      if (key === 'REMINDER_ENABLED') config.enabled = val.toUpperCase() === 'YES';
      if (key === 'REMINDER_HOUR') config.hour = parseInt(val, 10) || 9;
      if (key === 'REMINDER_TIMEZONE') config.timezone = val || 'Asia/Manila';
      if (key === 'REMINDER_LAST_RUN') config.lastRun = val;
    }
    // Check if trigger exists
    try {
      var triggers = ScriptApp.getProjectTriggers();
      for (var j = 0; j < triggers.length; j++) {
        if (triggers[j].getHandlerFunction() === 'adminApi_sendDailyReminders') {
          config.triggerActive = true;
          break;
        }
      }
    } catch(e) {}
    return { success: true, data: config };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function adminApi_setReminderConfig(config) {
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
    if (config.enabled !== undefined) updates['REMINDER_ENABLED'] = config.enabled ? 'YES' : 'NO';
    if (config.hour !== undefined) updates['REMINDER_HOUR'] = String(config.hour);
    if (config.timezone !== undefined) updates['REMINDER_TIMEZONE'] = String(config.timezone);
    var changed = false;
    for (var i = 1; i < data.length; i++) {
      var k = String(data[i][keyIdx]).trim();
      if (updates[k] !== undefined) { data[i][valIdx] = updates[k]; changed = true; }
    }
    if (changed) sysSheet.getDataRange().setValues(data);
    return { success: true, message: 'Reminder config updated.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function adminApi_setupReminderTrigger() {
  try {
    // Remove existing
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'adminApi_sendDailyReminders') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
    // Get config
    var configResult = adminApi_getReminderConfig();
    var cfg = (configResult && configResult.success) ? configResult.data : { hour: 9, timezone: 'Asia/Manila' };
    var hour = cfg.hour || 9;
    // Create new time-based trigger
    ScriptApp.newTrigger('adminApi_sendDailyReminders')
      .timeBased()
      .atHour(hour)
      .nearMinute(0)
      .inTimezone(cfg.timezone || 'Asia/Manila')
      .everyDays(1)
      .create();
    return { success: true, message: 'Reminder trigger created for ' + hour + ':00 ' + (cfg.timezone || 'Asia/Manila') + '.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

function adminApi_sendDailyReminders() {
  try {
    var ss = getSpreadsheet_();
    // Find apps with pending approval workflow
    var appSheet = ss.getSheetByName(SHEET_NAMES.APPLICATIONS);
    if (!appSheet) return { success: false, error: 'Applications sheet not found.' };
    var apps = sheetToObjects_(appSheet);
    var notified = 0;
    for (var i = 0; i < apps.length; i++) {
      var app = apps[i];
      var status = String(app.Status || '').toLowerCase();
      if (status.indexOf('pending') === -1 && status.indexOf('in progress') === -1) continue;
      var sessionId = String(app.SessionID || '');
      if (!sessionId) continue;
      // Notify applicant
      try { notifyApplicant(sessionId, app.Status); notified++; } catch(e) {}
      // Avoid quota: max 20 per run
      if (notified >= 20) break;
    }
    // Log last run
    var sysSheet;
    try { sysSheet = getSheet_(SHEET_NAMES.SYSTEM_CONFIG); } catch(e) {}
    if (sysSheet) {
      var data = sysSheet.getDataRange().getValues();
      var header = data[0];
      var keyIdx = header.indexOf('Configuration_Key');
      var valIdx = header.indexOf('Value');
      var found = false;
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][keyIdx]).trim() === 'REMINDER_LAST_RUN') {
          data[r][valIdx] = new Date().toISOString();
          found = true;
          break;
        }
      }
      if (found) sysSheet.getDataRange().setValues(data);
      else sysSheet.appendRow(['REMINDER_LAST_RUN', new Date().toISOString()]);
    }
    return { success: true, notified: notified, message: 'Reminders sent to ' + notified + ' applicants.' };
  } catch (e) { return { success: false, error: e.toString() }; }
}

// ─── Sheet Helpers ─────────────────────────────────────────────────────────────
function getSpreadsheet_() {
  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('SPREADSHEET_ID not set in Script Properties.');
  return SpreadsheetApp.openById(ssId);
}

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

/**
 * Simple ping / health-check for the frontend to call first.
 */
/**
 * Force (re-)authorization for all required scopes by touching every service
 * the script uses. Run this once from the Apps Script editor when permissions
 * are missing or MailApp silently fails to send. After running, re-deploy
 * the web app so the new scopes take effect for all users.
 *
 * Usage: Select this function in the editor → Run → Review permissions → Allow.
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

/**
 * Simple ping / health-check for the frontend to call first.
 */
function ping() {
  try {
    getSpreadsheet_();
    return { success: true, message: 'Spreadsheet accessible.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

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
function parseMetadata_(jsonStr) {
  if (!jsonStr) return {};
  try {
    if (typeof jsonStr === 'string') return JSON.parse(jsonStr);
    return jsonStr;
  } catch (e) {
    return {};
  }
}

/**
 * Normalize DCS status values for consistent display on the admin dashboard.
 * Spreadsheet values vary in casing — "COMPLETE", "Complete", "completed" all
 * mean the same thing. The canonical display value is "DCS Completed".
 */
function normalizeDcsStatus_(rawStatus) {
  var s = String(rawStatus || '').trim();
  var upper = s.toUpperCase();
  if (upper === 'COMPLETE' || upper === 'COMPLETED') return 'DCS Completed';
  return s || 'Unknown';
}

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

// ─── deleteEntry() ─────────────────────────────────────────────────────────────
// Extracts the requestor email FROM the row before deleting, so we can notify them.
function deleteEntry(reqId, logId, sessionId, sendEmail, ismComment) {
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
        sendEmailWithRetry_(requestorEmail, subject, body, { replyTo: adminEmail });
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

// ─── batchDeleteEntries() — Server-side batch processing ──────────────────────
// Accepts an array of {reqId, logId, sessionId, sendEmail, ismComment} objects.
// Returns a summary: {success, deleted, failed, emailsSent, results[]}.
// This is more efficient than N individual GAS round-trips from the frontend.
function batchDeleteEntries(items) {
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

// ─── CONFIGURATION SETTINGS ────────────────────────────────────────────────────
function getConfigData() {
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

function saveConfigData(sysUpdates, infoUpdates) {
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
        for (var i = 1; i < sysData.length; i++) {
          var k = sysData[i][keyIdx];
          if (sysUpdates[k] !== undefined) {
            sysData[i][valIdx] = sysUpdates[k];
            sysChanged = true;
          }
        }
        if (sysChanged) sysSheet.getDataRange().setValues(sysData);
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

// ─── Utility: Include HTML partials ────────────────────────────────────────────
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── CERTIFICATE ROUTING — Admin API ──────────────────────────────────────────
// These functions let an ISM admin regenerate the Certificate of Approval and
// resend the routing email to DCOPS, TechServe, or Both.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * getStyledHtmlWrapper() — Wraps header + body content in a full HTML page
 * styled with the application's design system (navy palette, DM Sans, cards).
 * 
 * @param {string} headerContent  — HTML for the header area (badge + title).
 * @param {string} bodyContent    — HTML for the main card body.
 * @returns {string} A complete <html> document string.
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

/**
 * Escape a string for safe HTML embedding.
 */
function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send email with retry logic (5 attempts, extended backoff ~75s window).
 * Gmail transient failures (rate limiting, internal queue backup, auth glitches)
 * typically self-resolve within 30-90s. The longer window with bigger gaps
 * gives Gmail breathing room between retries.
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

/**
 * ADMIN API: Get the current routing status for an application.
 * Returns what destination was last used, destination emails, application info,
 * ISM approval state, Division Head escalation state, and routing eligibility.
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

/**
 * ADMIN API: Regenerate the Certificate of Approval and resend the routing email.
 * Can also be used to re-route to a different destination.
 * Returns the delivery status.
 *
 * Idempotency: uses a static cache on the function object to prevent
 * duplicate reroute calls for the same session+destination within 30 seconds.
 * Pass force=true to bypass the cache for admin recovery resends.
 *
 * @param {string} sessionId
 * @param {string} destination — DCOPS, TECHSERVE, or BOTH
 * @param {boolean} [force] — Bypass idempotency cache (admin recovery)
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

/**
 * ADMIN API: Fetch all applications with their current workflow status, ISM approval,
 * Division Head escalation info, and routing eligibility.
 * Used by the Email Routing page to track every application through the pipeline.
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

/**
 * ADMIN API: Generate and return a Certificate of Approval as a PDF base64 blob.
 * The frontend can use this to trigger a download without sending an email.
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

/**
 * Shared helper: Build the certificate HTML body from gathered data.
 * Used by both RerouteApprovedRequest and DownloadCertificate.
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

/**
 * Log an audit trail entry to Risk_Audit sheet.
 * Every email send attempt from notifyApprover/notifyApplicant calls this.
 *
 * @param {string} sessionId — The session/application ID.
 * @param {string} action    — e.g. 'Email Sent', 'Email Failed', 'Email Resend'.
 * @param {Object} flagsObj  — Object with {recipient, type, attempts, error}.
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

/**
 * Get application data from Applications sheet for a session.
 *
 * @param {string} sessionId
 * @returns {Object|null} Row object or null if not found.
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

/**
 * Send a notification email to an approver at a specific step.
 * Try-catch wrapped for fail-safe operation.
 *
 * @param {string} sessionId
 * @param {number} stepIndex — 0-based index into the Approval_Workflow rows for this session.
 * @returns {Object} {success, error}
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

    try {
      sendEmailWithRetry_(approverEmail, subject, body, { replyTo: Session.getActiveUser().getEmail() });
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

/**
 * Send a notification email to the applicant about their application status.
 * Try-catch wrapped for fail-safe operation.
 *
 * @param {string} sessionId
 * @param {string} currentStatus — e.g. 'Pending', 'Approved', 'Denied'.
 * @returns {Object} {success, error}
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

    try {
      sendEmailWithRetry_(applicantEmail, subject, body, { replyTo: Session.getActiveUser().getEmail() });
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

/**
 * Send a notification email to an ISM member at a specific step.
 * Try-catch wrapped for fail-safe operation.
 *
 * @param {string} sessionId
 * @param {number} stepNumber — The step number (1-based) in ISM_Approval_Workflow.
 * @returns {Object} {success, error}
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

    try {
      sendEmailWithRetry_(ismEmail, subject, body, { replyTo: Session.getActiveUser().getEmail() });
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

/**
 * ADMIN API: Fetch all email-related audit log entries for a given session.
 * Returns entries where Action starts with 'Email ' (e.g. 'Email Sent', 'Email Failed', 'Email Resend').
 *
 * @param {string} sessionId — Session / Application ID.
 * @returns {Array<{logId, action, flags: {recipient, type, attempts, error}, timestamp}>}
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

/**
 * ADMIN API: Fetch all 'Email Failed' entries from Risk_Audit within the last N days.
 *
 * @param {number} [sinceDays=7] — How many days back to search (default 7).
 * @returns {Array<{sessionId, recipient, type, error, timestamp, attempts}>}
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

/**
 * ADMIN API: Resend a failed email notification for a given session.
 *
 * @param {string} sessionId  — Session / Application ID.
 * @param {string} recipient  — Email address of the intended recipient.
 * @param {string} type       — 'approver', 'applicant', or 'ism'.
 * @returns {{success: boolean, error: string|null, message: string}}
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

function checkProperties() {
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_API_KEY');
  Logger.log('ADMIN_API_KEY: ' + (key ? '✅ SET (' + key.substring(0, 6) + '...)' : '❌ MISSING'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN API — Self-Test (run from Apps Script editor to verify all endpoints)
// ═══════════════════════════════════════════════════════════════════════════════

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

    // ── 11. getReminderConfig ──
    Logger.log('\n── 11. getReminderConfig ──');
    if (key) {
      var rcResult = adminApi_getReminderConfig();
      assert_('getReminderConfig succeeds', rcResult && rcResult.success, rcResult.error);
    } else {
      results.push('⚠️  Skipped (no API key)');
    }

    // ── 12. getPipelineView (with dummy ID) ──
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
