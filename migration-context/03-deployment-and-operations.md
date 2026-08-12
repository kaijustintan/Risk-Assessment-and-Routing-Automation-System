# 03 · Deployment & Operations (the most expensive lessons in this project)

> This is where the project lost the most hours. Two multi-hour outages came from deployment
> mistakes. Read this before touching any deployment. Verbatim deep-dive:
> `reference-docs/docs/manual/part-0-common.md` §0.4 and `CLAUDE.md` §3b.

---

## 1. How shipping actually works (manual, per phase)

- The 3 apps are **separate GAS cloud projects**. This repo is where edits happen; **Kai then
  copy-pastes** each edited file into the matching GAS project and **redeploys that project.**
- **Kai's two-laptop flow:** code on personal laptop → push to GitHub → on the **work laptop**,
  pull, then **manually paste** each file into the GAS web editor → redeploy.
- **No `clasp`, no deploy scripts, no automation.** Don't add any, it's explicitly out of scope.
- Each phase deploys **independently**: a change to PIA does nothing until the PIA project is
  redeployed. A change to DCS `index.html` is live only after the DCS project's new version.
- Owner of all 3 GAS projects: **`<owner-account>@megaworldcorp.com`**.

## 2. 🚨 THE GOLDEN RULE, one deployment per app, always "New version"

**To ship a change:** `Deploy → Manage deployments → ✏️ Edit the ONE existing deployment →
Version → "New version" → Deploy`.

**NEVER click "New deployment."**

Why this is non-negotiable:
- A deployment's `/exec` URL is like a phone number. **"New version" keeps the same number**
  forever. **"New deployment" mints a brand-new number** and **orphans every stored URL** (the
  "Proceed to Phase 2" button + every email link), each now calls a dead line.
- This actually happened: the PIA project accumulated **~8 active deployments** (v0.1–v0.7 +
  "Untitled"), each a separate `/exec` pinned to old code. `PIA_APP_URL` pointed at a stale one →
  **every email link returned "Not Found"** and the "Proceed to Phase 2" button loaded old code.
  The healthy one was **v0.7**. Fix was to point the property at v0.7 and **archive all the others.**

> Kai *does* use "Edit → New version", which is why the ~8-deployment graveyard was a surprising
> root cause (legacy deployments from before the discipline). Keep exactly ONE active deployment
> per app.

## 3. Script-Property → URL map (set ONCE if you follow the golden rule)

Each value = that app's live `/exec`. Cross-app URLs **must be stored** because the separate GAS
projects can't discover each other's URLs (an app's *own* URL is auto-derivable via
`ScriptApp.getService().getUrl()`, used as PIA's fallback in `getWebAppUrl()`).

| Project | Property | Must hold | Feeds |
|---------|----------|-----------|-------|
| **DCS** | `PIA_APP_URL` | live **PIA** `/exec` | "Proceed to Phase 2" button (`generatePhase2Url_`) |
| **DCS** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | DCS self-reference |
| **PIA** | `WEB_APP_URL` | live **PIA** `/exec` | approver "Review Access Request", ISM/approval forms, reminders (`getWebAppUrl`) |
| **PIA** | `DCS_WEB_APP_URL` | live **DCS** `/exec` | applicant "View DCS Submission" (`getDCSWebAppUrl`) |
| **Admin** | `WEB_APP_URL` | live **PIA** `/exec` | manual-resend email CTAs (generic "Open the System", no token) |

> ⚠️ `DCS_WEB_APP_URL` exists in **both** DCS and PIA projects, the **PIA copy** is the one the
> email code reads. The PIA copy is the one historically missed.

**Consistency checks:** `DCS.PIA_APP_URL == PIA.WEB_APP_URL` (both = live PIA), and
`DCS.DCS_WEB_APP_URL == PIA.DCS_WEB_APP_URL` (both = live DCS). If a pair disagrees, a link is about
to break.

**Known live deployment IDs at migration time** (verify before trusting, they change if anyone
breaks the golden rule): PIA = `AKfycbw_vEAn…`, DCS = `AKfycbwpKli…`, Admin = `AKfycbz1V8Ki…`.

> Note: the same shared spreadsheet is referenced under **3 different property names** across the
> projects: DCS `DB_ID`, PIA `PIA_DB_SPREADSHEET_ID`, Admin `SPREADSHEET_ID`. Don't "unify" them.

## 4. Why links die (and how to test correctly)

- **Emails freeze their links at send time.** Updating a Script Property fixes only **future**
  emails; ones already in inboxes stay dead. Re-trigger/resend to test.
- **Review tokens have a 14-day TTL** (`isTokenValid`). Judge only with freshly generated links.
- **`?parentID=` only:** PIA's `doGet` evaluates the `index` template **only** on the `?parentID=`
  path (`createTemplateFromFile('index').evaluate()`), so template bugs surface on "Proceed to
  Phase 2" but not on a bare URL.
- **`/exec` is domain-gated; `/dev` is editor-gated.** Kai can't use `/dev` or Incognito-as-owner
  (the `<owner-account>` is not available to Kai). Test on `/exec` signed in as a domain user.
- **GAS error pages are browser-cached.** Append `?cb=N` (increment N) or hard-refresh to force a
  fresh fetch when retesting a fix. The `…/exec?test=1` trick also bypasses cached error pages.
- **Multi-login gotcha:** `authuser=` in a GAS URL reads the browser's **active** Google account.
  Clicking an approver's tokenized link while signed into a different account fails the identity
  check, open it signed in as the intended approver.

## 5. Manifest scopes (`*_appsscript.json`)

- Only add a scope when code genuinely needs it; **adding a scope forces re-authorization** on the
  next deploy/run. Flag it to Kai.
- Examples: `script.send_mail` for `MailApp`; `script.scriptapp` for time-based triggers (needed by
  PIA's daily reminder trigger).
- All manifests use timezone **`Asia/Manila`** (a stray `Asia/Shanghai` in PIA was fixed, it had
  caused 1-hour-off timestamps).

## 6. Web-upload safety (when generating docx / sharing with Claude web)

- **Never attach `DPS_DB*.xlsx`** (real PII) or the category-dropdown blueprint to any web upload.
- When asking Claude web to make a docx from the manual markdown, tell it to **CONVERT, not
  rewrite**, otherwise it re-derives the factual errors the manual specifically corrected.
