# 🧪 TEST GUIDE — RARS (DCS + PIA) Session Changes

> **Para sa tester (tropa):** Sundin mo ito step-by-step. Bawat item may **(1) ano 'to**,
> **(2) ano dati / ano binago** (kung change), **(3) steps**, at **(4) ✅ Expected** (kung anong
> dapat mangyari — may mag-upload ba sa Drive, may email ba, saang page mapupunta, etc.).
> Kung may **hindi tumugma sa ✅**, i-screenshot at sabihin kay Kai.

---

## ⚠️ BASAHIN MUNA — Setup & Rules (importante, wag laktawan)

1. **Gumamit ng BAGONG test request** (fresh transaction) para sa buong test. Wag yung luma.
   - **Bakit:** Ang mga link sa lumang email ay **"frozen"** — naka-save na sila sa oras na
     na-send. Kahit i-update ang settings, hindi na gagana ang lumang link. Bagong request
     lang ang totoong test.
2. **Mag-login sa TAMANG account** kada role:
   - Applicant email = yung nag-submit ng DCS/PIA.
   - Approver / InfoSec links = buksan habang naka-login sa **eksaktong** approver account na
     nakalagay sa request. Maling account = hindi gagana ang link.
3. **Review links may 14-day expiry.** Gumamit lang ng **bagong-generate** na link.
4. Kung may makita kang **GAS error page** (gray na "Script error"), mag **hard refresh**
   (Ctrl+Shift+R) o dagdagan ang URL ng `?cb=1` — minsan naka-cache lang.
5. **Domain-gated** ang lahat — dapat `@megaworldcorp` (o ang naka-set na domain) ang account.

---

# PART A — DCS FORM (Applicant side, Phase 1)

## A1. Downloadable forms — relabeled by audience
**Ano 'to:** Sa **Step 1 (Guide screen)** ng DCS, may mga downloadable na form templates
(NDA, DPA, DSA, CU, OJT CU). Bawat isa may maliit na label kung **para kanino**.

**Dati → Ngayon:** Dati walang malinaw na "para kanino" ang bawat form. Ngayon may audience
label na bawat isa.

**Steps:**
1. Buksan ang DCS app → **New Request** → pumunta sa **Step 1 (Guide)**.
2. Tingnan ang listahan ng downloadable forms.

**✅ Expected — eto dapat ang mga label:**
| Form | Label dapat |
|---|---|
| Non-Disclosure Agreement (NDA) | **For employees / internal personnel** |
| Data Protection Agreement (DPA) | **For employees** *(naka-bold, navy color)* |
| Data Sharing Agreement (DSA) | **For external / third-party data sharing** |
| Confidentiality Undertaking (CU) | **For agency personnel** |
| OJT Confidentiality Undertaking | **For OJT / interns** |

✅ Ang DPA label dapat mas **bold/navy** kaysa sa iba (in-emphasize).
✅ Pag click sa download link → bubukas ang form file (Google Drive/Docs link). Kung
   "Link not set" o `#` ang lumabas, sabihin kay Kai (admin config issue, hindi bug ng code).

---

## A2. Dropdown copy — "This is a standard request"
**Ano 'to:** Sa form, may dropdown kung ang request ba ay may kasamang Agency/OJT o standard lang.

**Dati → Ngayon:** Dati `"No — standard request"`. Ngayon `"This is a standard request"`
(mas malinaw, hindi mukhang sagot sa tanong).

**Steps:**
1. Sa DCS form (Step 2), hanapin ang dropdown para sa involvement/type ng request.

**✅ Expected:** Ang default/first option ay nakasaad **"This is a standard request"** — wala
nang `"No — standard request"`.

---

## A3. Context-aware Endorsement Letter label (School vs Agency)
**Ano 'to:** May upload field para sa **Endorsement Letter**. Ang pangalan ng label nagbabago
depende kung **OJT** o **Agency** ang request.

**Dati → Ngayon:** Dati pareho lang ang tawag. Ngayon:
- Kung **OJT/intern** ang request → **"School Endorsement Letter"**
- Kung **Agency** ang request → **"Agency Endorsement Letter"**
- At ito ay **live na nag-uupdate** — pag pinalitan mo ang dropdown, agad magbabago ang label
  (hindi mo kailangan i-refresh).

**Steps:**
1. Sa DCS form, piliin sa dropdown na ang request ay **may Agency**.
2. Pumunta sa Agency section → tingnan ang label ng Endorsement Letter upload card.
3. Balik sa dropdown, palitan papuntang **OJT** (kung applicable) → tingnan ulit ang label.
4. I-check din ang **Summary/Review page (Step 3)** bago mag-submit.

**✅ Expected:**
- Agency mode → label = **"…Agency Endorsement Letter…"** (upload card **at** sa summary).
- OJT mode → label = **"…School Endorsement Letter…"** (upload card **at** sa summary).
- Pag pinalit ang dropdown, **agad** nagbabago ang salita (Agency ⇄ School) — no refresh needed.
- Pareho dapat sa **3 states** ng upload card: fresh (bagong upload), required, at retained
  (dating naka-upload na).

---

## A4. Removed "Pending Immediate Head" filter option
**Ano 'to:** Sa **"My Applications / Review Applications"** list, may dropdown filter para sa status.

**Dati → Ngayon:** Dati may option na **"Pending Immediate Head"** sa filter — pero hindi ito
kailanman natatamaan (unreachable, kasi sa DCS walang ganung stored status). Inalis na.

**Steps:**
1. DCS app → **Review Applications** → buksan ang **status filter dropdown**.

**✅ Expected:** **WALA** nang "Pending Immediate Head" sa choices. Yung ibang status filters
(All, Pending, Complete, etc.) nandiyan pa rin at gumagana.

---

# PART B — DCS SUBMIT → PROCEED TO PHASE 2

## B1. Submit DCS — Drive upload + confirmation email
**Ano 'to:** Pag na-submit ang DCS, naa-upload ang files sa Drive at may confirmation email.

**Steps:**
1. Kumpletuhin ang isang **bagong** DCS request, mag-attach ng required files (NDA/DPA/etc.).
2. I-submit.

**✅ Expected:**
- Mapupunta sa **Success page** na may **DCS Request ID** (hal. `DCS-000123`).
- Ang mga **naka-attach na file ay naka-upload sa admin Drive folder** (i-confirm kay Kai/admin
  na nandoon ang files sa folder).
- Ang applicant ay **makakatanggap ng email**: subject ≈
  **"[Megaworld] DCS request DCS-xxxxxx submitted — Proceed to Phase 2"**, na may
  **"Proceed to Phase 2 →"** button at navy na design.
- ✅ Ang timestamp sa email dapat **Manila time** (tama ang oras, hindi mali ng ilang oras).

---

## B2. 🐞 "Proceed to Phase 2" — FIXED crash
**Ano 'to:** Yung "Proceed to Phase 2" button na nagdadala sa applicant sa PIA form (Phase 2).

**Dati → Ngayon:** **Dati nagka-crash/error** ang Phase 2 page (`Unexpected token '...'`).
Sanhi: may halimbawang code (`<?…?>`) na nakasulat sa loob ng **comments** ng HTML file —
binabasa pala ito ng Google Apps Script kahit comment lang, kaya nag-eerror. **Inalis na** ang
mga halimbawang yun sa comments. Ngayon dapat bumukas nang maayos.

**Steps:**
1. Galing sa DCS confirmation email **o** sa Success page, i-click ang **"Proceed to Phase 2"**.
   (Ang link ay may `?parentID=<DCS ReqID>`.)

**✅ Expected:**
- Bubukas ang **PIA form (Phase 2)** nang **WALANG error page**. Dati dito nag-crash.
- Naka-load ang assessment wizard, handa nang sagutan.
- ⚠️ Importante itong i-test kasi ang bug ay lumalabas **lang** sa `?parentID=` path (yung
  galing sa button) — hindi sa plain na URL.

---

# PART C — PIA APPROVAL FLOW (Heads → InfoSec)

> I-submit muna ang PIA form para magkaroon ng request sa approval ladder. Ladder:
> **Immediate Head → Dept Head → InfoSec ×2 → (routing) → optional Division Head**.

## C1. 📧 Honest status wording sa applicant emails
**Ano 'to:** Habang umaakyat ang request sa approval ladder, tumatanggap ang applicant ng
**"Update on Application"** emails kada step.

**Dati → Ngayon:** **Dati**, ang intermediate (gitnang) emails ay sumasabi ng plain
**"APPROVED"** — nakakalito, akala tapos na e hindi pa pala. **Ngayon**, honest na ang wording:
sinasabi kung **anong stage** at na **"not yet final approval."** Plain **"FULLY APPROVED"** lang
ang lalabas kapag **tunay nang tapos**.

**Steps:** Sundan ang request sa bawat approval. Buksan ang applicant email kada step.

**✅ Expected — eto ang dapat sabihin ng email kada stage:**
| Kailan | Email dapat magsabi ng |
|---|---|
| Pagka-submit ng PIA | **"SUBMITTED"** — being reviewed by Immediate/Department Head |
| Pag-approve ng isang Head, may susunod pa | **"PROGRESSING"** to the next Head |
| Pag-clear ng **lahat** ng Heads → papunta na sa ISM | **"HEADS APPROVED … reviewed by the ISM … not yet final approval"** |
| Pag-approve ng isang ISM, may susunod pang ISM | **"PROGRESSING"** to the next ISM member |
| Pag-escalate sa Division Head | **"ESCALATED"** to the Division Head |
| Division Head nag-approve, balik sa ISM | **"approved by the Division Head … returning to the ISM … not yet final approval"** |
| **Tunay nang tapos** (lahat ng ISM approved) | **"FULLY APPROVED"** |

✅ **Pinaka-importante:** **WALANG** email na magsasabi ng plain **"APPROVED"** habang gitna pa
lang. **"FULLY APPROVED"** lang sa dulo.

---

## C2. 🔗 "View DCS Submission" link → opens the EXACT request
**Ano 'to:** Sa applicant na "Update on Application" emails (intermediate/approved statuses),
may button na **"View DCS Submission →"**.

**Dati → Ngayon:** **Dati** dinadala ka nito sa **DCS homepage** — hahanapin mo pa mismo ang
request. **Ngayon** dumiretso na sa **specific request details page** (gamit ang `?parentID=`).

**Steps:**
1. I-submit ang PIA, hintayin ang **"Update on Application"** email.
2. I-click ang **"View DCS Submission →"** button.

**✅ Expected:**
- Bubukas ang **mismong request's details page** (yung details/timeline ng partikular na request),
  **HINDI** ang DCS homepage/landing.
- Makikita ang timeline at status ng tamang request agad.

---

## C3. 🆕 InfoSec (ISM) reviewer screen — inline panel (lahat ng options nakikita agad)
**Ano 'to:** Pag bumukas ang InfoSec reviewer sa review link, dito niya ginagawa ang desisyon:
Approve / Escalate / Return / Deny + routing (DCOPS / TechServe / Both).

**Dati → Ngayon:** **Dati** may **"Review & Submit Decision" button** na magbubukas ng
**pop-up modal** na may steps (Step 1 routing → Step 2 action). **Ngayon** wala nang pop-up —
**lahat ng options nakikita na agad** sa page (inline panel).

**Steps:**
1. Buksan ang **InfoSec review link** (naka-login bilang tamang InfoSec approver).
2. Tingnan ang layout ng decision area.

**✅ Expected — base behavior:**
- Makikita agad sa page ang **Approve / Escalate to Division Head / Return to Requestor / Deny**
  **at** ang routing options (**DCOPS / TechServe / Both**). **WALANG** "Review & Submit Decision"
  na pop-up/modal.

**✅ Expected — validations (subukan lahat):**
- **Remarks < 50 characters:** Magsulat ng kulang sa 50 letra na feedback → i-click ang kahit
  anong decision → **dapat ma-block** ka (may error na kailangan ng at least 50 characters).
- **Approve o Escalate na walang routing:** Wag pumili ng DCOPS/TechServe/Both → i-click
  **Approve** o **Escalate** → **dapat ma-block** + may lumabas na error ("please select a routing").
  *(Note: ang routing ay required LANG sa Approve/Escalate — pwedeng walang routing sa Deny/Return.)*
- **Submitting overlay:** Pag-click ng kahit anong **valid** decision → dapat may lumabas na
  **"Submitting your decision…"** spinner overlay habang pinoproseso.

**✅ Expected — Return flow (regression check):**
- I-click ang **Return to Requestor** → dapat may lumabas na **confirm box** ("Confirm Return to
  Requestor" / Cancel). Ito ay **dapat gumana pa rin** (hindi nasira nang inalis ang lumang modal).

---

## C4. Final certificate — routing label "DCOPS and TechServe"
**Ano 'to:** Pag fully approved, may **Certificate of Approval** na nagsasaad kung saan
na-route (DCOPS / TechServe / Both).

**Dati → Ngayon:** **Dati** nakasulat na **"BOTH"** (all-caps, technical mukha). **Ngayon**:
- Both → **"DCOPS and TechServe"**
- TechServe → **"TechServe"** (hindi "TECHSERVE")

**Steps:**
1. I-fully-approve ang isang request kung saan ang **huling** InfoSec reviewer ay pumili ng **Both**.
2. Tingnan ang **Certificate of Approval** (sa email/certificate).

**✅ Expected:**
- Sa certificate, ang **"Routed to:"** ay nakasaad **"DCOPS and TechServe"** — **hindi** "BOTH".
- Subukan din ang **TechServe** lang na routing → dapat **"TechServe"**, hindi "TECHSERVE".
- ✅ Ang applicant ay tatanggap ng **"FULLY APPROVED"** email, at ang linked **DCS ay magiging
  COMPLETE**.

---

# PART D — CROSS-CUTTING (lahat ng emails)

## D1. Clean email footers (no "CAUTION" box)
**Ano 'to:** Ang footer (ilalim) ng bawat system email.

**Dati → Ngayon:** **Dati** may **dilaw na "CAUTION" box** sa ilalim ng email (mukhang spam
warning). **Ngayon** malinis na **gray na "No-reply notice"** na lang.

**Steps:**
1. Buksan ang **kahit anong** system email (DCS confirmation, approver notice, applicant update,
   certificate).
2. Tingnan ang **pinakailalim**.

**✅ Expected:**
- **WALANG** dilaw na "CAUTION" box.
- May malinis na gray na **"No-reply"** notice (e.g. "automated message… please do not reply").
- I-check sa HTML email, sa certificate email, **at** sa plain-text version (kung naka-plain text view).

---

## D2. Timezone — Asia/Manila (regression check)
**Ano 'to:** Ang oras na ipinapakita sa mga PIA email/timestamp.

**Dati → Ngayon:** **Dati** naka-set ang PIA sa **Asia/Shanghai** (mali — 1 oras nauuna).
**Ngayon** **Asia/Manila** na.

**Steps:**
1. Mag-trigger ng bagong PIA email (hal. submit o approve).
2. Tingnan ang timestamp / petsa-oras sa email o decision history.

**✅ Expected:** Ang oras ay **tamang Manila time** (PHT). Wala nang 1-oras na pagkakamali.
*(Note: epektibo lang ito kapag na-redeploy ni Kai ang PIA — kung mali pa, sabihin sa kanya.)*

---

# 📋 QUICK CHECKLIST (i-tick habang nagte-test)

**DCS form (Part A)**
- [ ] A1 — 5 downloadable forms may tamang audience labels (DPA naka-emphasis)
- [ ] A2 — dropdown nagsasabi "This is a standard request"
- [ ] A3 — Endorsement label nagbabago: Agency vs School (live + sa summary)
- [ ] A4 — walang "Pending Immediate Head" sa status filter

**DCS submit + Phase 2 (Part B)**
- [ ] B1 — submit → Success page + DCS ID, files nasa Drive, confirmation email (Manila time)
- [ ] B2 — "Proceed to Phase 2" bumubukas nang WALANG error (crash fixed)

**PIA flow (Part C)**
- [ ] C1 — honest status emails (walang plain "APPROVED" hangga't di final; "FULLY APPROVED" sa dulo)
- [ ] C2 — "View DCS Submission" → diretso sa exact request
- [ ] C3 — InfoSec inline panel (lahat nakikita; <50 char blocked; Approve/Escalate walang routing blocked; overlay; Return confirm gumagana)
- [ ] C4 — certificate "Routed to: DCOPS and TechServe" (hindi "BOTH"); "FULLY APPROVED"; DCS COMPLETE

**Lahat ng email (Part D)**
- [ ] D1 — malinis na footer, walang dilaw na "CAUTION"
- [ ] D2 — Manila time ang timestamps

---

**Kung may ✅ na hindi tumugma:** i-screenshot, isulat anong step + anong account ginamit, ipasa
kay Kai. Salamat tropa! 🙏
