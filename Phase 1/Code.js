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

/**
 * Initializes property cache on first call. Run once per execution.
 * @private
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

/**
 * Returns a named script property or throws a descriptive error.
 * Uses cache to avoid repeated PropertiesService calls.
 * @param {string} key
 * @returns {string}
 */
function getProp_(key) {
  initializePropertyCache_();
  const val = CACHE.properties[key];
  if (!val) throw new Error(`Script property "${key}" is not set. Configure it in Project Properties.`);
  return val;
}

/**
 * Gets or caches a spreadsheet by ID to avoid redundant openById() calls.
 * @param {string} spreadsheetId
 * @returns {Spreadsheet}
 * @private
 */
function getCachedSpreadsheet_(spreadsheetId) {
  if (!CACHE.spreadsheets[spreadsheetId]) {
    CACHE.spreadsheets[spreadsheetId] = SpreadsheetApp.openById(spreadsheetId);
  }
  return CACHE.spreadsheets[spreadsheetId];
}

/**
 * Fetches key-value pairs from the System_Configuration sheet.
 * OPTIMIZED: Uses cached spreadsheet access.
 * @returns {{ success: boolean, config?: Object, error?: string }}
 */
function apiGetSystemConfig() {
  try {
    const ss = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName('System_Configuration');
    if (!sheet) return { success: true, config: {} };

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

/**
 * Checks if the user's email belongs to an authorized corporate domain.
 * @param {string} userEmail
 * @returns {boolean}
 */

const ENABLED_DOMAIN_CHECK = true;
function isAuthorizedDomain(userEmail) {
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
/**
 * HIGH: Email validation helper (RFC-ish compliant)
 * OPTIMIZED: Uses precompiled regex constant.
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = String(email).trim();
  return EMAIL_VALIDATE_REGEX.test(trimmed) && trimmed.length <= 180;
}

function getStyledHtmlWrapper(header, content) {
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

/**
 * doGet — Serves DCS frontend or handles email action callbacks.
 * Implements PIA-style pattern with domain authorization and styled errors.
 */
function doGet(e) {
  const userEmail = Session.getActiveUser().getEmail();
  
  // Domain authorization check
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

  // Serve main DCS frontend
  const output = HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Data Collection System (DCS)');

  if (HtmlService.XFrameOptionsMode && HtmlService.XFrameOptionsMode.SAMEORIGIN) {
    output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.SAMEORIGIN);
  }

  return output;
}

/**
 * doPost — Handles form submissions (approval decisions with comments).
 * Implements PIA-style POST handler pattern for security.
 */
function doPost(e) {
  const userEmail = Session.getActiveUser().getEmail();
  
  // Domain authorization check
  if (!isAuthorizedDomain(userEmail)) {
    const header = `<span class="step-badge" style="background:var(--danger); color:var(--danger-text); border-color:rgba(220,38,38,0.2);">Access Denied</span><h1>Restricted</h1>`;
    const content = `
      <div class="alert alert-danger">Security verification failed. This system is restricted</div>
      <p style="color: var(--text2); line-height: 1.6; font-size: 14px;">Outside of the corporation is strictly access denied. Please switch to your corporate account and try again.</p>
      <p style="color: var(--text3); font-size: 0.85rem; margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1rem;">Current account: <strong>${userEmail || 'Anonymous/Public'}</strong></p>
    `;
    
    return HtmlService.createHtmlOutput(getStyledHtmlWrapper(header, content))
    .setTitle('Access Denied');
  }

  return HtmlService.createHtmlOutput(getStyledHtmlWrapper(
    `<h1>Invalid Request</h1>`,
    `<div class="alert alert-danger">The request is missing required parameters.</div>`
  ));
}




/**
 * Returns the active user's email.
 * Called by the frontend on load to pre-fill the identity context.
 * @returns {{ email: string }}
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

/**
 * Explicitly clears all DCS drafts (legacy and session-based) for the current user.
 * Called when starting a fresh application to ensure a clean slate.
 */
function apiDiscardDrafts() {
  const result = apiMarkDraftComplete();
  if (result.success) {
    try { logDCSAuditTrail('', 'DCS Drafts Discarded', false); } catch (e) {}
  }
  return result;
}

/**
 * Unified completion API for cleaning up draft data.
 * Consolidates legacy and session-based cleanup logic.
 * @param {string} [sessionId] - Optional; if provided, clears specific session. Otherwise clears all DCS drafts for user.
 */
/**
 * Internal draft cleanup — does NOT acquire its own lock.
 * Safe to call from within an already-locked context (e.g. submitDCS).
 * @param {string} sessionId
 * @param {Sheet} sheet
 * @param {string} email
 * @private
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

function apiMarkDraftComplete(sessionId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.DRAFT);
  try {
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    if (!sheet) return { success: false, error: 'Drafts sheet not found' };

    cleanupDraftsForUser_(sessionId, sheet, email);
    
    try { logDCSAuditTrail(sessionId || 'all', 'DCS Draft Completed', false); } catch (e) {}
    return { success: true };
  } catch (err) {
    console.error('apiMarkDraftComplete error:', err.message);
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// 3B. SESSION-BASED DRAFT SYSTEM (Aligned with PIA)
// ============================================================

const DCS_SESSION_ID_COUNTER_PROP = 'DCS_COUNTER';

/**
 * Generates a new DCS session ID.
 * Format: DCS-XXXXXX (e.g., DCS-000001)
 * @returns {string}
 */
function apiGenerateNewSessionId() {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.SESSION);
  
  try {
    const props = PropertiesService.getScriptProperties();
    const rawNum = Number(props.getProperty(DCS_SESSION_ID_COUNTER_PROP) || 0) + 1;
    props.setProperty(DCS_SESSION_ID_COUNTER_PROP, String(rawNum));
    
    const sid = 'DCS-' + String(rawNum).padStart(6, '0');
    try { logDCSAuditTrail(sid, 'DCS Session Generated', false); } catch (e) {}
    return sid;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Saves a DCS draft with session ID.
 * Upserts into Drafts sheet.
 * OPTIMIZED: Uses TextFinder instead of getDataRange() to avoid loading entire sheet.
 * @param {string} sessionId
 * @param {Object} stateData
 * @returns {{ success: boolean, draftId: string, error?: string }}
 */
function apiSaveDraft(sessionId, stateData) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUTS.DRAFT);
  
  try {
    const email = Session.getActiveUser().getEmail();
    const ss    = getCachedSpreadsheet_(getProp_('DB_ID'));
    const sheet = ss.getSheetByName(DRAFTS_SHEET_NAME);
    const now   = new Date();
    const expires = new Date(now.getTime() + DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const stateStr = JSON.stringify(stateData);
    
    if (stateStr.length > 50000) {
      return { success: false, error: 'Draft size exceeds storage limit (50,000 characters). Cannot store large base64 files in StateJSON.' };
    }
    
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

/**
 * Restores a DCS draft by session ID.
 * OPTIMIZED: Reduced cell access calls in loop; only parse JSON for valid drafts.
 * @param {string} sessionId
 * @returns {{ found: boolean, state: Object|null, error?: string }}
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
      
      const expiresAt = new Date(rowExpiresAt);
      if (rowExpiresAt && expiresAt < now) {
        sheet.deleteRow(row);
        continue;
      }
      
      const parsed = rowState ? JSON.parse(rowState) : null;
      try { logDCSAuditTrail(sessionId, 'DCS Draft Restored', false); } catch (e) {}
      return { found: true, state: parsed };
    }
    
    return { found: false, state: null };
  } catch (err) {
    console.error('apiRestoreDraft error:', err.message);
    return { found: false, state: null, error: err.message };
  }
}

/**
 * Lists all DCS drafts for the current user.
 * OPTIMIZED: Uses TextFinder to filter by email; reduces getDataRange() scope and lazy-parses JSON only when needed.
 * @returns {{ drafts: Array }}
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

/**
 * Loads a specific draft by draft ID.
 * OPTIMIZED: Batch cell access to reduce API calls from 4 to 1.
 * @param {string} draftId
 * @returns {{ found: boolean, sessionId: string, state: Object|null, error?: string }}
 */
function apiLoadDraft(draftId) {
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
    console.error('apiLoadDraft error:', err.message);
    return { found: false, sessionId: '', state: null, error: err.message };
  }
}

/**
 * Deletes a draft by draft ID.
 * OPTIMIZED: Uses TextFinder instead of getDataRange() to avoid loading entire sheet.
 * @param {string} draftId
 * @returns {{ success: boolean, error?: string }}
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
        try { logDCSAuditTrail(draftId, 'DCS Draft Deleted', false); } catch (e) {}
        return { success: true };
      }
    }

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
        try { logDCSAuditTrail(draftId, 'DCS Draft Deleted', false); } catch (e) {}
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

/**
 * Receives a base64-encoded file from the client, decodes it,
 * deposits it into the admin-only Drive folder, and returns
 * the file's Drive ID.
 *
 * The employee never gains access to this folder — the script
 * acts on the developer's authority (Execute as: Me).
 *
 * @param {string} base64File  — Base64-encoded file content
 * @param {string} fileName    — Original filename
 * @param {string} fileType    — Type of file (e.g., 'NDA_DPA', 'DSA')
 * @param {string} mimeType    — MIME type string
 * @returns {string} fileId    — Google Drive file ID
 */
function uploadProxy(base64File, originalFileName, fileType, mimeType, reqId) {
  try {
    // ============ VALIDATION ============
    if (!base64File || !originalFileName || !mimeType) {
      throw new Error('uploadProxy: missing required parameter.');
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

    // ============ SET SHARING ============
    // Try ANYONE_WITH_LINK first, fall back to DOMAIN_WITH_LINK if the org
    // restricts external link sharing (throws "Invalid argument" in some domains).
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (sharingErr) {
      try {
        // Fall back to domain-wide sharing if external link sharing is restricted
        file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (domainSharingErr) {
        // If both fail, the file is still accessible to the admin via Drive.
        // Log the warning and continue — the file was created successfully.
        console.warn(
          'uploadProxy: could not set link sharing for [' + fileType + '] file ' + file.getId() +
          '. Error: ' + sharingErr.message
        );
      }
    }

    return file.getId();

  } catch (e) {
    // Catch-all: convert any GAS runtime error (including "Invalid argument")
    // into a descriptive message with context about which file type failed.
    throw new Error(
      'uploadProxy(' + fileType + ', ' + (originalFileName || 'unknown') + '): ' + e.message
    );
  }
}


/**
 * Trashes previously uploaded Drive files to avoid orphaned duplicates during revision.
 * Silently skips files that no longer exist.
 * @param {Array} fileList Array of { type, id, name } objects
 * @private
 */
function trashOldDriveFiles_(fileList) {
  fileList.forEach(function(f) {
    try { DriveApp.getFileById(f.id).setTrashed(true); } catch (e) { /* already gone or inaccessible */ }
  });
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

/**
 * Main DCS submission handler.
 * 1. Validates payload.
 * 2. Acquires a write lock.
 * 3. Uploads NDA/DPA and DSA files via the proxy.
 * 4. Generates a ReqID and appends a row to Data_Collection.
 * 5. Deletes the draft.
 * 6. Sends approval email to Immediate Head.
 *
 * @param {Object} payload
 *   {
 *     formData      : { name, location, dept, access, ihelp,
 *                       immHeadName, immHeadEmail,
 *                       deptHeadName, deptHeadEmail,
 *                       divHeadName, divHeadEmail },
 *     ndaFile       : { base64, fileName, mimeType } | null,
 *     dsaFile       : { base64, fileName, mimeType } | null
 *   }
 * @returns {{ success: boolean, reqId: string }}
 */
function submitDCS(payload, sessionId = '') {
  // --- Re-validate identity on backend (Defense-in-Depth Layer 2) ---
  const email = Session.getActiveUser().getEmail();
  if (!isAuthorizedDomain(email)) {
    return { success: false, error: 'Unauthorized domain. Access denied.' };
  }

  if (!payload || !payload.formData) {
    return { success: false, error: 'Invalid payload.' };
  }

  const form = payload.formData;

  // CRITICAL: Validate required fields on backend
  const requiredFields = ['name', 'dept', 'access', 'immHeadEmail', 'immHeadName', 'deptHeadName', 'deptHeadEmail'];
  for (const field of requiredFields) {
    if (!form[field] || String(form[field]).trim() === '') {
      return { success: false, error: `Missing required field: ${field}` };
    }
  }
  
  // HIGH: Email validation on backend
  if (!isValidEmail(form.immHeadEmail)) {
    return { success: false, error: 'Invalid Immediate Head email address.' };
  }
  if (!isValidEmail(form.deptHeadEmail)) {
    return { success: false, error: 'Invalid Department Head email address.' };
  }
  if (form.divHeadEmail && form.divHeadEmail.trim() && !isValidEmail(form.divHeadEmail)) {
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

  try {
    // Determine NDA/CU type based on agency data presence
    const ndaType = payload.agencyData ? 'CU' : 'NDA';
    if (payload.ndaFile && payload.ndaFile.base64) {
      const id = uploadProxy(payload.ndaFile.base64, payload.ndaFile.fileName, ndaType, payload.ndaFile.mimeType, reqId);
      trashOldDriveFiles_(uploadedIds.filter(function(f) { return f.type === 'NDA' || f.type === 'CU'; }));
      uploadedIds = uploadedIds.filter(f => f.type !== 'NDA' && f.type !== 'CU');
      uploadedIds.push({ type: ndaType, id: id, name: payload.ndaFile.fileName });
    }
    if (payload.dpaFile && payload.dpaFile.base64) {
      const id = uploadProxy(payload.dpaFile.base64, payload.dpaFile.fileName, 'DPA', payload.dpaFile.mimeType, reqId);
      trashOldDriveFiles_(uploadedIds.filter(function(f) { return f.type === 'DPA'; }));
      uploadedIds = uploadedIds.filter(f => f.type !== 'DPA');
      uploadedIds.push({ type: 'DPA', id: id, name: payload.dpaFile.fileName });
    }
    if (payload.dsaFile && payload.dsaFile.base64) {
      const id = uploadProxy(payload.dsaFile.base64, payload.dsaFile.fileName, 'DSA', payload.dsaFile.mimeType, reqId);
      trashOldDriveFiles_(uploadedIds.filter(function(f) { return f.type === 'DSA'; }));
      uploadedIds = uploadedIds.filter(f => f.type !== 'DSA');
      uploadedIds.push({ type: 'DSA', id: id, name: payload.dsaFile.fileName });
    }
  } catch (err) {
    return { success: false, error: 'File upload failed: ' + err.message };
  }

  // Store as JSON string so multiple file IDs fit in one cell
  const combinedFileId = uploadedIds.length > 0 ? JSON.stringify(uploadedIds) : '';

  // --- Build Agency Metadata if agency data is present (BEFORE lock) ---
  let agencyJson = '';
  try {
    if (payload.agencyData) {
      const ad = payload.agencyData;
      // Validate required agency fields
      if (!ad.agencyName || String(ad.agencyName).trim() === '') {
        return { success: false, error: 'Agency Name is required.' };
      }
      if (!ad.agencyPersonnel || String(ad.agencyPersonnel).trim() === '') {
        return { success: false, error: 'Agency Personnel is required.' };
      }
      if (ad.immHeadRecoveryEmail && !isValidEmail(ad.immHeadRecoveryEmail)) {
        return { success: false, error: 'Invalid Immediate Head Recovery Email.' };
      }

      // Upload endorsement letter if provided
      let endorsementFile = null;
      if (ad.endorsementLetterFile && ad.endorsementLetterFile.base64) {
        const eId = uploadProxy(ad.endorsementLetterFile.base64, ad.endorsementLetterFile.fileName, 'ENDORSEMENT', ad.endorsementLetterFile.mimeType, reqId);
        trashOldDriveFiles_(uploadedIds.filter(f => f.type === 'ENDORSEMENT'));
        uploadedIds = uploadedIds.filter(f => f.type !== 'ENDORSEMENT');
        uploadedIds.push({ type: 'ENDORSEMENT', id: eId, name: ad.endorsementLetterFile.fileName });
        endorsementFile = { id: eId, name: ad.endorsementLetterFile.fileName };
      }

      agencyJson = JSON.stringify({
        agencyName: String(ad.agencyName || '').trim(),
        agencyPersonnel: String(ad.agencyPersonnel || '').trim(),
        contractStartDate: ad.contractStartDate || '',
        endorsementLetter: endorsementFile,
        networkDrive: String(ad.networkDrive || '').trim(),
        immHeadRecoveryEmail: String(ad.immHeadRecoveryEmail || '').trim(),
        immHeadRecoveryNumber: String(ad.immHeadRecoveryNumber || '').trim()
      });
    }
  } catch (err) {
    return { success: false, error: 'Agency file upload failed: ' + err.message };
  }
  const finalCombinedFileId = (payload.agencyData && uploadedIds.length > 0) ? JSON.stringify(uploadedIds) : combinedFileId;

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
    riskAnalysis = analyzeDCSRisk(payload, email);
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
    try { logDCSAuditTrail(reqId || 'unknown', 'DCS Request Failed: ' + err.message, false); } catch (e) {}
    return { success: false, error: err.message };
  } finally {
    lock.releaseLock();
  }

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
  }

  return result;
}

/**
 * Generates the secure URL to redirect the user to Phase 2 (PIA).
 * Appends the ReqID as a query parameter. Uses /dev for testing.
 * @param {string} reqId The DCS Request ID.
 * @returns {string} The full URL for Phase 2.
 * @private
 */
function generatePhase2Url_(reqId) {
  const piaAppUrl = getProp_('PIA_APP_URL');
  // The /dev URL is typically only accessible by the script owner and editors.
  // For the redirect to work for all users, the production /exec URL must be used.
  // The base URL from properties should end in /exec.
  // const devUrl = piaAppUrl.replace(/\/exec$/, '/dev'); // Use for owner testing only.
  return `${piaAppUrl}?parentID=${reqId}`;
}

/**
 * Generates a sequential DCS ReqID using a script property counter.
 * Falls back to UUID if properties are unavailable.
 * @returns {string}  e.g. "DCS-000001"
 */
function generateDCSReqId_() {
  const props  = PropertiesService.getScriptProperties();
  const rawNum = Number(props.getProperty('DCS_COUNTER') || 0) + 1;
  props.setProperty('DCS_COUNTER', String(rawNum));
  return 'DCS-' + String(rawNum).padStart(6, '0');
}


// ============================================================
// 14. DCS RISK ANALYSIS & AUDIT LOGGING  (PIA-style Flagging)
// ============================================================

/**
 * Analyzes DCS request data for paranormal/anomalous patterns.
 * Checks for conflict of interest, role duplication, suspicious data,
 * and other risk indicators.
 *
 * @param {Object} dcsData The DCS form data and metadata
 * @param {string} [providedEmail] The authenticated user's email
 * @returns {{ isFlagged: boolean, reasons: string[] }}
 */
function analyzeDCSRisk(dcsData, providedEmail = '') {
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

/**
 * Logs a DCS audit trail entry to the Risk_Audit sheet.
 * Full audit trail — EVERY action is written to the sheet.
 * Paranormal events get a filled InternalFlags column; normal events get '{}'.
 *
 * Behavior:
 *   flagsData = '{riskLevel:"HIGH", reasons:[...]}' → Paranormal event, stores the JSON
 *   flagsData = false                                → Normal workflow action, stores '{}'
 *   flagsData = true                                 → Legacy trigger, stores generic HIGH
 *   flagsData = null / undefined                     → Defaults to '{}' (normal)
 *
 * @param {string} sessionId  Session / Request identifier for the event
 * @param {string} action     Human-readable description of the event
 * @param {*}      flagsData  {string|boolean|null} false/null for normal, JSON string for flagged, true for legacy
 */
function logDCSAuditTrail(sessionId, action, flagsData) {
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

/**
 * Batch audit log — writes multiple entries in a single sheet operation.
 * Reduces sheet API calls by consolidating related audit events.
 *
 * @param {Array<{sessionId: string, action: string, flagsData: *}>} entries
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

/**
 * Fetches all related data for a DCS request in optimized batch.
 * Loads all sheets once and processes in single pass.
 * @param {Spreadsheet} ss
 * @param {string} dcsReqId
 * @param {string} piaSessionId (optional)
 * @returns {Object} Consolidated data with piaRecord, approvals, ismApprovals, divHeadApprovals
 */
function getRequestDataBatch_(ss, dcsReqId, piaSessionId) {
  const batch = {
    piaRecord: null,
    approvals: [],
    ismApprovals: [],
    divHeadApprovals: []
  };

  /**
   * Reads the header row of a sheet to build a column-index map.
   * @param {Sheet} sheet
   * @returns {Object.<string, number>} colName → 0-based index
   */
  function getColIndexMap_(sheet) {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const map = {};
    headers.forEach(function(h, i) { if (h) map[String(h).trim()] = i; });
    return map;
  }

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

/**
 * Finds the PIA record linked to a DCS request ID.
 * @param {Spreadsheet} ss The spreadsheet object.
 * @param {string} dcsReqId The DCS Request ID.
 * @returns {Object|null} An object with PIA status and other details, or null if not found.
 * @private
 */
function getPIARecordByDCSId_(ss, dcsReqId) {
  const sheet = ss.getSheetByName('Applications'); // From db_schema.md
  let piaSessionId = null;
  let piaStatus = null;
  let piaDecision = null;
  let approverFlags = null;
  let approverComments = null;

  if (sheet) {
    // ✅ Fix #2: Use TextFinder.findAll() instead of full sheet load
    // This is more efficient and prevents race conditions with multiple revisions
    const finder = sheet.getRange('B:B')
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

/**
 * Constructs the approval workflow list using DCS metadata and the Approval_Workflow sheet.
 * @private
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

/**
 * Constructs the ISM approvers list.
 * @private
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

/**
 * Constructs the Division Head approvers list.
 * @private
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

/**
 * @param {string} reqId
 * @returns {Object|null}
 * FIX 1: Replaced full sheet load with TextFinder.
 * FIX 2: Consolidated batch queries into getRequestDataBatch_.
 */
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
    
    const metadata = JSON.parse(values[DC_COL.METADATA_JSON - 1] || '{}');
    const files    = JSON.parse(values[DC_COL.FILE_ID - 1] || '[]');
    const status   = values[DC_COL.STATUS - 1];
    
    // ✅ Fix 2: BATCH: Load all related data in one pass
    const batch = getRequestDataBatch_(ss, reqId, null);
    const piaRecord = batch.piaRecord;

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
      divHeadApprovers: batch.divHeadApprovals
    };
    
  } catch (err) {
    console.error('apiGetRequestData error:', err.message);
    return { found: false, error: err.message };
  }
}

/**
 * Retrieves all DCS requests submitted by the current user.
 * Fixes the "missing requests" issue where older entries became 
 * inaccessible after a new submission.
 * FIX 5: Optimized with selective loads instead of loading entire sheets.
 * @returns {{ success: boolean, requests: Array, error?: string }}
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

/**
 * Fetches a returned application for isEditing mode.
 * Validates that the request belongs to the user and is in RETURNED status.
 * @param {string} reqId
 * @returns {Object}
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

/**
 * Returns the status of the most recent DCS request for the
 * current user. Uses the "Latest-Entry" pattern: TextFinder
 * from the bottom of column B upward.
 *
 * @returns {{ found: boolean, reqId: string, status: string, timestamp: string }}
 */
function apiGetStatus() {
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
    console.error('apiGetStatus error:', err.message);
    return { found: false, error: err.message };
  }
}

/**
 * Internal: Finds the most recent row in Data_Collection for
 * the given email and returns it as a values array.
 *
 * @param {Sheet}  sheet
 * @param {string} email
 * @returns {Array|null}
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

/**
 * getGatewayRecord — The "Handshake" function.
 *
 * The PIA app calls this on load to determine whether the current
 * user has a cleared DCS record before rendering the PIA form.
 *
 * Logic:
 *   1. Fetch the user's latest Data_Collection entry.
 *   2. If Status !== "READY_FOR_PIA" → return gated: true.
 *   3. If cleared → return gated: false, plus ReqID and FileID
 *      for embedding in the PIA as Linked_ReqID.
 *
 * Defense-in-Depth Note:
 *   This function MUST be called from the PIA backend's doGet —
 *   never rely solely on a frontend flag. Even if a user directly
 *   navigates to the PIA URL, the backend re-validates here.
 *
 * @param {string} [userEmail] — Optional override; defaults to Session email.
 * @returns {{
 *   gated      : boolean,
 *   reason     : string,
 *   reqId      : string,
 *   fileId     : string,
 *   status     : string
 * }}
 */
function getGatewayRecord(userEmail) {
  try {
    const email = userEmail || Session.getActiveUser().getEmail();
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
    console.error('getGatewayRecord error:', err.message);
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

/**
 * Generates the SHA-256 integrity hash that appears on the
 * PIA approval certificate.
 *
 * The hash binds Phase 1 (DCS ReqID) to Phase 2 (PIA SessionID)
 * so that tampering with either invalidates the certificate.
 *
 * hash = SHA256(dcsReqId + "|" + piaSessionId)
 *
 * @param {string} dcsReqId     — e.g. "DCS-000001"
 * @param {string} piaSessionId — e.g. "PIA-000075"
 * @returns {string}  Hex-encoded SHA-256 digest
 */
function computeIntegrityHash(dcsReqId, piaSessionId) {
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
// 11. ADMIN UTILITIES  (Run manually from the Apps Script editor)
// ============================================================

/**
 * One-time setup: Creates the Data_Collection sheet with the
 * correct headers if it does not already exist.
 * Run this manually after deploying to a new spreadsheet.
 * 
 * Column order: LogID, ReqID, UserEmail, Status, ImmediateHeadEmail, 
 *              DeptHeadEmail, DivHeadEmail, FileID, Metadata_JSON, Timestamp
 */
function setupDataCollectionSheet() {
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
    configSheet.appendRow(['LINK_NDA_TEMPLATE', '#', 'URL for the NDA form']);
    configSheet.appendRow(['LINK_TC_PAGE', 'https://docs.google.com/document/d/REPLACE_WITH_DOC_ID/preview', 'URL for the T&C page embed (Google Docs embed readonly)']);
    Logger.log('System_Configuration sheet initialized.');
  }
}

/**
 * Manually override the Status of a DCS request.
 * Use in the Apps Script editor for admin corrections.
 *
 * @param {string} reqId
 * @param {string} newStatus  — One of STATUS_PENDING | STATUS_READY_FOR_PIA | STATUS_REJECTED
 */
function adminSetStatus(reqId, newStatus) {
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

/**
 * Purges expired draft rows from the Drafts sheet.
 * Schedule this as a daily time-driven trigger:
 *   Edit → Triggers → Add Trigger → purgeExpiredDrafts → Day timer
 */
function purgeExpiredDrafts() {
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

/**
 * Dummy function to force Apps Script to trigger the OAuth authorization prompt
 * for all services listed in appsscript.json.
 * Run this manually from the editor if you encounter permission errors.
 */
function forceAuthorize() {
  SpreadsheetApp.getActiveSpreadsheet();
  const folderId = getProp_('ADMIN_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  const dummy = folder.createFile('DCS_AUTH_TEST.txt', 'Verified');
  Logger.log('Auth check complete for folder: ' + folder.getName() + '. File ID: ' + dummy.getId());
}