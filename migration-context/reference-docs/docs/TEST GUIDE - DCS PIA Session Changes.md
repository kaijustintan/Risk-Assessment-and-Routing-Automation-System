# 🧪 TEST GUIDE — RARS (DCS · PIA · Admin) Changes

> **Para sa tester:** Sundin step-by-step. Bawat item: **(1) ano 'to**, **(2) ano dati / ano binago**,
> **(3) steps**, **(4) ✅ Expected**. Kung hindi tumugma sa ✅ → screenshot + sabihin kay Kai (isama
> kung anong account ang ginamit).
>
> May **bagong PART E — SECURITY** na nangangailangan ng **2nd test account** + **browser console**.
> Hiwalay na minarkahan kung sino dapat tester.

Updated: 2026-06-23.

---

## ⚠️ BASAHIN MUNA — Setup & Rules (wag laktawan)

1. **Fresh test request** para sa bawat run. Lumang transaction = lumang frozen email links.
2. **Tamang account kada role.** Para sa security tests (Part E), kailangan **DALAWANG** `@megaworldcorp.com`
   account: (a) ang biktima/approver, (b) isang **ordinaryong account na hindi approver/hindi INFOSEC**
   (ang "attacker"). Confirmed na meron kayo nito.
3. **Totoong, binabantayang inbox.** ⚠️ *(Lesson learned:)* ang email ay padala sa account na nakalagay
   sa form (applicant + heads). Gumamit ng inbox na **talagang chineck** ng tester. Kung "walang email":
   check muna ang **Spam** AT ang **"All Mail"** + **Filters** (baka may "Skip the Inbox" filter — yan ang
   dating dahilan ng "walang email").
4. **Deployment requirement:** lahat ng test dito ay valid **LANG** kung na-deploy na ni Kai ang bagong
   version ng bawat app (PIA `pia_code.js`, Admin `admin_code.js`, DCS `index.html` + `Code.js`).
5. GAS error page? **Hard refresh** (Ctrl+Shift+R) o `?cb=1`.
6. Review links: **14-day expiry** — gumamit ng bagong-generate lang.

---

# PART A — DCS FORM (Applicant side)

## A1. Downloadable forms — restructured to 7, by audience
**Ano 'to:** Sa **Step 1 (Guide)**, may downloadable form templates.

**Dati → Ngayon:** **Dati 5 forms** (NDA, DPA, DSA, CU, OJT CU). **Ngayon 7 forms** na may mas
descriptive na pangalan + bawat DPA ay per-entity:

**✅ Expected — eto dapat ang 7 forms (sa ganitong grupo):**
| Form (display name) | Audience |
|---|---|
| **Non-Disclosure Agreement for Employee** | employees |
| **Data Sharing Agreement** | external / third-party |
| **DPA for Megaworld Employee** | DPA (Megaworld) |
| **DPA for Luxury Global Employee** | DPA (Luxury Global) |
| **DPA for Global One Employee** | DPA (Global One) |
| **Confidentiality Undertaking for Agency** | agency personnel |
| **Confidentiality Undertaking for OJT** | OJT / interns |

✅ **Bawat link bumubukas ng tamang form file.** Kung "Link not set" (`#`) → hindi pa naka-set ang link
sa config (sabihin kay Kai — admin config, hindi bug).

## A1b. Confidentiality Undertaking — natatanging icon + kulay
**Ano 'to:** Visual distinction ng forms.

**Dati → Ngayon:** **Dati** ang 2 CU forms ay kamukha ng iba (CU Agency = asul gaya ng DPA, CU OJT = pula
gaya ng NDA). **Ngayon** ang **2 CU forms** ay may **amber/dilaw na kulay + "person-with-check" icon** —
distinct na sila.

**✅ Expected:** Ang CU Agency at CU OJT ay parehong **amber** na may icon ng **taong may check ✓** —
iba sa NDA (pulang padlock), DPA (asul na shield), DSA (berdeng share).

## A2. Dropdown copy
**✅ Expected:** Ang involvement dropdown default option = **"This is a standard request"** (hindi na
"No — standard request").

## A3. Context-aware Endorsement Letter label
**Dati → Ngayon:** Nagbabago ang label: **OJT → "School Endorsement Letter"**, **Agency → "Agency
Endorsement Letter"**, at **live nag-uupdate** pag pinalitan ang dropdown.

**Steps:** Sa form, piliin **Agency** → tingnan ang Endorsement upload label + sa Summary; palitan papuntang
**OJT** → tingnan ulit.
**✅ Expected:** Agency mode → "Agency Endorsement Letter"; OJT mode → "School Endorsement Letter";
**agad nagbabago** (walang refresh); pareho sa upload card **at** summary.

## A4. Removed "Pending Immediate Head" filter option
**Steps:** DCS → **Review Applications** → status filter dropdown.
**✅ Expected:** **WALA** nang "Pending Immediate Head". Ibang filters gumagana pa rin.

## A5. Terms & Conditions
**Ano 'to:** Bago mag-proceed, kailangang i-agree ang T&C. Bubukas ito sa **modal (iframe ng Google Doc)**
na may **5-second read gate**.

**Dati → Ngayon:** **Dati blangko** ang T&C content. **Ngayon** may aktwal na T&C (naka-host sa Google Doc,
naka-link via `LINK_TC_PAGE`). At ang **inline summary card** ay in-update (kasama na ang CU + RA 10173).

**Steps:**
1. Step 1 (Guide) → i-click ang row na **"I agree to the Terms & Conditions"**.
2. Tingnan ang modal.

**✅ Expected:**
- **May lumalabas na T&C content** sa modal (hindi blangko).
- May **5-second countdown** → pagkatapos, active ang **"I Have Read and Agree"** button.
- Pagka-agree → naka-tick (at locked) ang checkbox, at active na ang **"Proceed to Form"**.
- ✅ Ang inline summary card (Guide) ay may **4 bullets** na binabanggit ang **NDA, DPA, DSA, o CU** + **Data
  Privacy Act (RA 10173)**.
> Kung **blangko** ang modal → hindi naka-set/naka-share nang tama ang Google Doc / `LINK_TC_PAGE` (config
> issue, sabihin kay Kai — hindi bug ng code).

## A6. "Confidentiality Undertaking" wording (Agency/OJT)
**Ano 'to:** Pag Agency/OJT ang request, ang main upload ay isang **Confidentiality Undertaking**.

**Dati → Ngayon:** **Dati** mali ang baybay sa ilang lugar (**"Confidential Undertaking"** — kulang ng
"-iality"). **Ngayon** tama na: **"Confidentiality Undertaking"** sa lahat (upload label, guide text,
validation alert, summary).

**Steps:** Piliin sa dropdown na **Agency** o **OJT** → tingnan ang main upload card label; subukan ding
mag-submit nang walang main file → tingnan ang error alert; tingnan sa Summary.
**✅ Expected:** Lahat nagsasabi ng **"Confidentiality Undertaking"** — walang natirang "Confidential
Undertaking".

---

# PART B — DCS SUBMIT → PROCEED TO PHASE 2

## B1. Submit DCS — Drive upload + confirmation email
**Steps:** Kumpletuhin ang bagong DCS request, mag-attach ng required files, i-submit.
**✅ Expected:**
- **Success page** + **DCS Request ID** (hal. `DCS-000030`).
- Files **naka-upload sa admin Drive folder** (i-confirm kay Kai).
- Applicant **may email**: subject ≈ "**[Megaworld] DCS request … submitted — Proceed to Phase 2**", may
  navy design + "**Proceed to Phase 2 →**" button.
- ✅ Timestamp sa email = **Manila time**.

## B2. 🐞 "Proceed to Phase 2" — crash fix
**Dati → Ngayon:** **Dati nagka-crash** ang Phase 2 (`Unexpected token '...'`, dahil sa `<?…?>` sa loob ng
comments). **Ngayon** bumubukas nang maayos.
**Steps:** Galing sa confirmation email o Success page, i-click ang **"Proceed to Phase 2"** (may `?parentID=`).
**✅ Expected:** Bubukas ang **PIA form nang WALANG error page**. Handa nang sagutan.

---

# PART C — PIA APPROVAL FLOW

> I-submit muna ang PIA. Ladder: **Immediate Head → Dept Head → InfoSec ×2 → (routing) → optional Division Head.**

## C1. 📧 Honest status wording sa applicant emails
**Dati → Ngayon:** **Dati** plain "**APPROVED**" ang intermediate emails (nakakalito). **Ngayon** honest na.
**✅ Expected — kada stage:**
| Kailan | Email dapat magsabi ng |
|---|---|
| Submit ng PIA | **"SUBMITTED"** |
| Approve ng isang Head, may susunod | **"PROGRESSING"** to the next Head |
| Lahat ng Heads clear → ISM na | **"HEADS APPROVED … not yet final approval"** |
| Approve ng isang ISM, may susunod | **"PROGRESSING"** to the next ISM member |
| Escalate sa Division Head | **"ESCALATED"** to the Division Head |
| DivHead approve, balik sa ISM | **"approved by the Division Head … not yet final"** |
| **Tapos na** | **"FULLY APPROVED"** |

✅ **WALANG** plain "APPROVED" habang gitna pa; **"FULLY APPROVED"** lang sa dulo.

## C2. 🔗 "View DCS Submission" → exact request
**Dati → Ngayon:** **Dati** → DCS homepage. **Ngayon** → diretso sa **mismong request details** (`?parentID=`).
**Steps:** Buksan ang applicant "Update on Application" email → i-click **"View DCS Submission →"**.
**✅ Expected:** Bubukas ang **details page ng mismong request**, hindi homepage.

## C3. 🆕 InfoSec reviewer — inline decision panel
**Dati → Ngayon:** **Dati** may "Review & Submit Decision" **pop-up modal**. **Ngayon** wala nang pop-up —
**lahat ng options nakikita agad** inline.
**Steps:** Buksan ang **InfoSec review link** (naka-login bilang tamang InfoSec approver).
**✅ Expected — base:** Nakikita agad ang **Approve / Escalate / Return / Deny** + routing (**DCOPS /
TechServe / Both**). WALANG modal.
**✅ Expected — validations:**
- Remarks **< 50 chars** → i-click decision → **ma-block** (need ≥50 chars).
- **Approve/Escalate na walang routing** → **ma-block** + error.
- Kahit anong valid decision → **"Submitting your decision…"** spinner.
**✅ Expected — Return flow (regression):** I-click **Return to Requestor** → may **confirm box** → gumagana
pa rin (hindi nasira nang inalis ang lumang modal).

## C4. Final certificate — routing label
**Dati → Ngayon:** **Dati "BOTH"**. **Ngayon "DCOPS and TechServe"**; TechServe → "TechServe".
**Steps:** Fully-approve kung saan ang **huling** InfoSec ay pumili ng **Both** → tingnan ang Certificate.
**✅ Expected:** "Routed to: **DCOPS and TechServe**"; applicant may **"FULLY APPROVED"** email; DCS = **COMPLETE**.

---

# PART D — LAHAT NG EMAIL

## D1. Clean footer (no "CAUTION" box)
**Dati → Ngayon:** **Dati** may dilaw na "CAUTION" box. **Ngayon** malinis na gray na "No-reply" notice.
**✅ Expected:** Walang dilaw na "CAUTION"; malinis na no-reply notice (HTML email, certificate, at plain-text).

## D2. Timezone — Asia/Manila
**Dati → Ngayon:** **Dati** Asia/Shanghai (mali ng 1 oras). **Ngayon** Asia/Manila.
**✅ Expected:** Tamang Manila time ang mga timestamp sa email/decision history.

---

# 🔐 PART E — SECURITY (BAGO — attack simulation)

> **Mahalaga:** Ang mga bagong security guard ay pumipigil sa isang ordinaryong empleyado na gumamit ng
> **browser console** para diretsong tawagin ang mga server function (`google.script.run`) at gawin ang
> hindi dapat — basahin ang data ng iba, mag-forge ng approval, mag-delete. I-te-test natin na **(positive)**
> gumagana pa rin ang lehitimong gamit, AT **(negative)** sarado na ang butas.

## E0. Paano buksan ang console (kailangan sa negative tests)
1. Buksan ang app (DCS/PIA/Admin) sa Chrome.
2. **F12** (o right-click → Inspect) → tab na **"Console"**.
3. ⚠️ **Importanteng gotcha:** kung mag-type ka ng `google.script.run` at sabihin **"undefined"**, ang app
   ay nasa loob ng **sandbox iframe**. Sa taas ng Console, may **dropdown na nakasulat "top"** — palitan ito
   papunta sa **iframe ng app** (yung may "userHtmlFrame"/sandbox URL). Doon available ang `google.script.run`.
4. Format ng command: `google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).<function>(<args>)`

> Gagamitin natin ang **"attacker" account** (ordinaryong @megaworldcorp, hindi approver, hindi INFOSEC) sa
> mga negative test, maliban kung sinabing iba.

## E1. F-04 — DCS: bawal basahin ang request ng iba (IDOR)
**Setup:** Magkaroon ng request ng ibang tao, hal. `DCS-000028` (ni "Maria").
**Positive (owner):** Bilang **may-ari** ng `DCS-000028`, buksan ito sa "Review Applications" → **lumalabas
ang details mo** normally.
**Negative (attacker):** Bilang **ibang account**, sa Console:
```js
google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).apiGetRequestData('DCS-000028')
```
**✅ Expected:** `RESULT: {found:false}` — **walang data** na bumalik (hindi mo makikita ang email, files,
approvers ni Maria). Subukan ding mag-loop ng ibang IDs → lahat `{found:false}` (maliban sa sarili mo).

## E2. F-05 — PIA: ISM reviewer load (positive) + bawal basahin ng non-chain (negative)
**Positive (ISM reviewer) — PINAKA-IMPORTANTENG i-test:** Bilang **tamang ISM reviewer** (o applicant, o
head sa chain), buksan ang **review screen** → dapat **MAY LAMAN** ang "PIA facts" at "DCS context" panels.
> ⚠️ Kung "Access denied" ang lumabas sa lehitimong reviewer → mali ang authz set (sabihin AGAD kay Kai).
**Negative (attacker — non-chain):** Bilang account na **wala sa approval chain**, sa Console:
```js
google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).apiPhase3_FetchPIAData('PIA-000010')
google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).apiPhase3_FetchDCSData('PIA-000010')
```
**✅ Expected:** Pareho → `{success:false, error:'Access denied: you are not authorized to view this application.'}`.

## E3. F-02 — PIA: bawal mag-forge ng approval
**Setup:** May request na naghihintay ng InfoSec decision (may Pending ISM row), hal. `PIA-000010` para kay
`tine@megaworldcorp.com`.
**Positive:** Bilang **tunay na approver**, mag-decide via review link/inline panel → **records normally**.
**Negative (attacker):** Bilang **ibang account**, sa Console (palitan ng totoong approver email + session):
```js
google.script.run.withSuccessHandler(r => console.log('RESULT:', r))
  .apiPhase3_ProcessISMDecision('PIA-000010', 'tine@megaworldcorp.com', 'Approve', 'forged attempt test 50 chars minimum padding here ok', 'BOTH')
```
**✅ Expected:** `{success:false, error:'Access denied: you may only submit your own decision.'}` — AT ang
workflow row ni `PIA-000010` ay **HINDI nagbago** (i-verify sa sheet o sa status: walang nagbagong decision).
(Subukan din ang `processApprovalDecision` para sa heads — parehong block.)

## E4. F-01 / F-03 — Admin: bawal mag-delete / mag-tamper config / mag-promote sarili
**Positive (INFOSEC):** Bilang **INFOSEC-001/002**, gawin sa Admin UI: mag-delete ng test entry, mag-save ng
config link → **gumagana**.
**Negative (attacker — hindi INFOSEC):**
1. Buksan ang **Admin `/exec`** bilang ordinaryong account → makukuha ang **"Access Denied"** page.
2. Sa Console (sa page na 'yon):
```js
// subukang mag-delete:
google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).deleteEntry('DCS-000028', '', 'PIA-000010', false, '')
// subukang i-promote ang sarili:
google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).saveConfigData({}, {'INFOSEC-003': {name:'Attacker', email:'attacker@megaworldcorp.com'}})
```
**✅ Expected:** Pareho → `{success:false, error:'Access restricted to authorized ISM administrators (INFOSEC-001 / INFOSEC-002).'}`
- **WALANG na-delete** (i-verify na nandiyan pa rin ang `DCS-000028`).
- **WALANG INFOSEC-003** na naidagdag sa `InfoSec_Email_Config` sheet.

## E5. F-08 — DCS: gateway lookup naka-bind sa caller
**Negative (attacker):** Sa Console, subukang i-query ang gateway status ng iba:
```js
google.script.run.withSuccessHandler(r => console.log('RESULT:', r)).getGatewayRecord('maria@megaworldcorp.com')
```
**✅ Expected:** Ibinabalik ang **SARILI mong** record (o `NO_DCS_RECORD` kung wala kang request) — **HINDI**
ang reqId/fileId/status ni Maria. (In-ignore ang email argument.)

## E6. 🚨 INFOSEC ADMIN REGRESSION — pinaka-importanteng positive test
**Ano 'to:** Naka-guard na ngayon ang **~17 Admin functions** (lahat dumadaan sa INFOSEC check). Dapat
**hindi nasira** ang lehitimong admin dashboard.
**Steps:** Mag-login bilang **INFOSEC-001/002** → subukan ang **bawat feature** ng Admin:
- Email queue (load, retry, cancel, retry-all)
- Pipeline view
- Settings (load + **save** config/links)
- Delete entry / batch delete
- Routing status + **Reroute** (cert + email)
- **Certificate download**
- Resend email
- Approved applications list
**✅ Expected:** **Lahat gumagana** gaya ng dati. ⚠️ Kung may feature na biglang **"Access restricted"** kahit
INFOSEC ka → may problema sa `checkAccess_` lookup (hal. hindi exact-match ang INFOSEC email sa
`InfoSec_Email_Config` sheet) — sabihin AGAD kay Kai. **Ito ang #1 risk ng security batch.**

---

# 🛠️ PART F — OJT FEEDBACK FIXES (Wave 1 + 2)

> Mga inayos base sa test feedback. Kailangan **na-deploy** ang **DCS `index.html`** + **PIA `pia_code.js`**
> (Edit → New version). Gumamit ng **bagong** transaction + **totoong inbox** (check All Mail/Spam/Filters).

## Wave 1 — emails, approvals, drafts, navigation

**F1. Personalized greeting (#14)**
- Submit PIA → may approver mag-act → buksan ang applicant **"Update on Application"** email.
- ✅ Dapat **"Hello, \<pangalan mo\>!"** (hindi plain "Hello,"). Approver emails din → "Hello, \<approver\>,".

**F2. Approver ROLE sa email (#13)**
- Sa "Review Status" ng email → ✅ bawat approver may **role**: *"… — Immediate Head: Approved"*, *"… —
  Department Head"*, *"… — InfoSec Reviewer"*, *"… — Division Head"* — hindi lang pangalan.

**F3. Isang email na lang sa final approval (#20)**
- Dalhin hanggang **fully approved** (heads + ISM lahat).
- ✅ **ISANG** "FULLY APPROVED" email lang — **wala** nang pangalawang "completed/routed to DCOPS/TechServe" na sunod.

**F4. Spinner sa Head/Dept approve (#12)**
- Buksan ang **Head/Department** review link → magsulat ng comment → **Approve** (o Deny/Return).
- ✅ Lumalabas ang **"Submitting your decision…" spinner** habang pinoproseso (dati mukhang frozen).

**F5. Home redirect after Proceed to Phase 2 (#10)**
- Mula sa request details (o success page) → **"Proceed to Phase 2"**.
- ✅ Bubukas ang PIA sa bagong tab, at ang **DCS tab ay babalik sa Home** — kaya pagbalik mo, **walang stale**
  na "Proceed to Phase 2" / lumang status.

**F6. Draft re-upload warning (#5)**
- Gumawa ng DCS request, mag-attach ng main doc, **i-save as draft**, umalis.
- Balik → **Resume/Load** ang draft → punta sa upload (Section 2).
- ✅ Sa halip na maling green **"✓ \<file\> selected"**, dapat **amber "⚠ \<file\> — please re-upload this file
  (drafts do not store the file itself)."** Pumili ulit ng file → ✅ magiging green "✓ selected."

## Wave 2 — documents, timeline, reviewer docs, certificate

**F7. Clickable document links (#2)**
- Buksan ang details ng isang request → **Documents** section.
- ✅ Ang **NDA/DPA File** at **DSA File** ay **clickable "View ↗" links** na bumubukas sa Drive (hindi na puro text).

**F8. 5-stage progress timeline (#11)**
- Sa request details → **"Overall Progress Timeline"**.
- ✅ Dapat **5 stages** na: *DCS Request → PIA Assessment → **Heads Approval** → ISM Approval → Certification*.
  Ang **Heads Approval** ay hiwalay na ngayon sa ISM Approval, may sariling In Progress/Approved/Returned na status.

**F9. Reviewer sees ALL docs (#15)**
- Buksan ang **InfoSec/Head review link** ng request na may **internal DPA** (o anumang uploaded doc).
- ✅ Sa **"Supporting Documents"** card → **lumalabas na ang DPA/NDA** (dati: "No documents attached" kahit may upload).

**F10. Certificate lists supporting documents (#19)**
- Dalhin ang request hanggang **fully approved** → tingnan ang **Certificate of Approval** (email/PDF).
- ✅ May bagong **"Supporting Documents"** section na naglilista ng bawat uploaded file (label + link).

> **Note (#16):** Ang status badge ay **honest na dati pa** ("PIA Heads Approved — Awaiting ISM review") — walang binago. I-confirm lang na ganoon pa rin ang itsura.

---

# 📋 QUICK CHECKLIST

**DCS Form (A)**
- [ ] A1 — 7 downloadables, tamang names/audience; A1b CU = amber + person-check icon
- [ ] A2 — "This is a standard request"
- [ ] A3 — Endorsement label Agency vs School (live + summary)
- [ ] A4 — walang "Pending Immediate Head" filter
- [ ] A5 — T&C modal may laman, 5s gate gumagana, inline card may CU + RA 10173
- [ ] A6 — "Confidentiality Undertaking" (tamang baybay) sa lahat

**DCS Submit + Phase 2 (B)**
- [ ] B1 — Success + DCS ID, files sa Drive, confirmation email (Manila time)
- [ ] B2 — "Proceed to Phase 2" WALANG crash

**PIA Flow (C)**
- [ ] C1 — honest status emails; C2 deep-link sa exact request
- [ ] C3 — inline panel + <50 char blocked + no-routing blocked + overlay + Return confirm
- [ ] C4 — cert "DCOPS and TechServe"; FULLY APPROVED; DCS COMPLETE

**Emails (D)**
- [ ] D1 — malinis na footer; D2 Manila time

**🔐 Security (E)**
- [ ] E1 — F-04: non-owner → `{found:false}`
- [ ] E2 — F-05: ISM reviewer **may laman** (positive) + non-chain → Access denied
- [ ] E3 — F-02: forged decision → Access denied + row unchanged
- [ ] E4 — F-01/03: delete + self-promote → Access restricted; walang epekto
- [ ] E5 — F-08: gateway → sarili mong record lang
- [ ] **E6 — INFOSEC admin dashboard LAHAT gumagana (kritikal)**

**🛠️ Feedback fixes (F)**
- [ ] F1 greeting by name · F2 approver roles · F3 isang final email · F4 head-approve spinner
- [ ] F5 home redirect on Proceed · F6 draft re-upload warning
- [ ] F7 doc "View ↗" links · F8 5-stage timeline (Heads Approval) · F9 reviewer sees DPA · F10 cert lists docs

---

**Kung may ✅ na hindi tumugma:** screenshot + anong step + anong account → ipasa kay Kai. Salamat! 🙏
