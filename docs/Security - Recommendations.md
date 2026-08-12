# 🛡️ RARS: Security Recommendations (future hardening backlog)

> **Status:** advisory only. **Walang code na binago** dito, listahan ito ng mga
> mungkahi para palakasin pa ang seguridad ng RARS (DCS + PIA + Admin), naka-priority
> ayon sa epekto kumpara sa effort. Layman muna, technical sunod.
>
> Para sa kasalukuyang naka-implement nang security measures, tingnan ang chat audit /
> CLAUDE.md §5b at §8b. Ito ay ang **hindi pa** ginagawa.

Last reviewed: 2026-06-23.

---

## Priority legend
- 🔴 **High**, malaking epekto, gawin agad kung kaya.
- 🟡 **Medium**, mahalaga, pero hindi urgent.
- 🟢 **Low**, nice-to-have / polish.
- Tag: **[config]** = settings/ops lang, walang code. **[code]** = kailangan ng code change.

---

## 🔴 1. Verify secret strength, `SYSTEM_SECRET` + `ADMIN_API_KEY` **[config]**

**Ano:** Dalawang master key ang nasa likod ng system:
- **`SYSTEM_SECRET`** (PIA project), ang lihim na "pumipirma" sa lahat ng approve/deny tokens
  (HMAC-SHA256). Kung mahina/nahulaan → kayang **mag-peke ng approval** ang attacker.
- **`ADMIN_API_KEY`** (Admin + PIA projects), password sa programmatic admin JSON API.

> ⚠️ Ang tunay na property name ay **`SYSTEM_SECRET`** (hindi `HMAC_SECRET`, yan ay misnomer
> sa lumang docs). Hanapin sa **PIA** project → Project Settings → Script Properties.

**Bakit:** Buong token security (authn ng decisions) ay nakasalalay sa lakas ng `SYSTEM_SECRET`.
Kahit perpekto ang code, mahina ang secret = mabu-brute-force.

**Gawin:**
1. Buksan ang Script Properties ng PIA (para sa `SYSTEM_SECRET`) at Admin (para sa `ADMIN_API_KEY`).
2. Tingnan ang value. **Mahina** = maikli, salita, o nahuhulaan (`test`, `changeme`, `secret123`,
   `< 20 chars`). **Matibay** = **≥32 random characters**, halong letra/numero/symbol, walang kahulugan.
3. Kung mahina: i-generate ng matibay (`openssl rand -base64 32`, o password manager), i-paste, Save.

> 🚨 **Babala sa `SYSTEM_SECRET`:** kapag pinalitan, **mama-matay agad ang LAHAT ng existing
> approve/deny links** sa naipadala nang email (naka-sign sa lumang secret). Palitan lang sa quiet
> window o tanggapin na kailangang i-re-trigger ang pending. `ADMIN_API_KEY` ay safe palitan anytime.

**Effort:** ~5 min check. **Status:** ☐ Hindi pa na-verify.

---

## 🔴 2. Approver chain: gawing HR/directory-sourced (prevention, hindi detection lang) **[code]**

**Ano:** Ang Immediate / Dept / Division Head emails ay **inilalagay mismo ng applicant sa PIA1**
(text input). Wala itong central na master list.

**Bakit (integrity gap, pinakamalaki):** Pwedeng ilagay ng drafter ang **sarili niya o kaibigan**
bilang approver. Ngayon, **na-de-detect lang** (`analyzeApplicationRisk` nag-fa-flag pag
`drafter_email == head_email`, `pia_code.js` ~3602), **hindi napi-prevent**.

> ⚠️ **Mas malala pa:** dahil **maraming email account** ang pwedeng meron ang isang tao, ang
> detection na `drafter == head` ay **madaling ma-bypass**, gagamit lang siya ng ibang account
> bilang "head" at hindi na magma-match ang strings. So **detection-only = mahina talaga.**

**Gawin (future):** I-source ang head-chain mula sa **Google Workspace org unit / HR directory**
(Admin SDK Directory API) sa halip na free-text input, para ang reporting line ay galing sa
authoritative source, hindi sa applicant.

> 🛑 **WAG muna i-implement ngayon.** Kailangan nito ng **manually-maintained na master list** ng
> tamang reporting lines (HR org chart) na **wala pa** sa ngayon. Naka-record dito bilang backlog.

**Effort:** Malaki (bagong data source + integration + maintenance). **Status:** ☐ Deferred (no HR data yet).

---

## 🟡 3. Uploaded files: macro / malware handling **[code]**

**Ano:** Ang `uploadProxy` (DCS `Code.js`) tama na ang type validation via **magic-byte check**
(anti-spoof), pero **hindi nagsi-scan ng malware o macros**.

**Bakit:** Pwedeng makalusot ang **macro-enabled `.docx`** na may payload, tapos i-download ng
approver. (Medium lang: internal domain ang scope.)

**Gawin:** Pumili ng isa, (a) i-block ang macro-enabled formats, (b) umasa sa built-in malware
scanning ng Google Drive, o (c) i-convert/preview as PDF bago i-download.

**Effort:** Medium. **Status:** ☐ Hindi pa.

---

## 🟡 4. `ADMIN_API_KEY` rotation **[config]**

**Ano:** Iisang static shared key, walang rotation schedule.

**Bakit:** Kung tumagas, bukas ang admin JSON API. (Bahagyang mababa ang exposure, **verified na ang
Admin web UI ay HINDI humahawak ng key na 'to**; `google.script.run` lang ang ginagamit niya, naka-gate
na ng domain + INFOSEC member check. So server-side secret lang ito na nagbabantay sa REST endpoint.)

**Gawin (rotation steps):**
1. Gumawa ng bagong matibay na key (`openssl rand -base64 32`).
2. **PIA project** → Script Properties → palitan ang `ADMIN_API_KEY`.
3. **Admin project** → ilagay ang **PAREHONG** bagong value (dapat magtugma kung may cross-app call).
4. I-update ang kahit anong external integration na may hawak ng lumang key (mukhang wala pa).
5. **Walang redeploy** kailangan (property read sa runtime); redeploy lang kung may template na
   nag-e-embed ng key, verified, **wala** sa `adminView.html`.
- **Cadence:** quarterly, o agad kapag may umalis na may access.

**Effort:** ~5 min/rotation. **Status:** ☐ No schedule yet.

---

## 🟡 5. Approval token: mas maikling TTL / one-time-use **[code]**

**Ano:** 14-araw na bisa ang approve/deny token. Pwedeng tumagas via browser history / forwarded email.

**Bakit:** Naka-mitigate na (email-match + "already decided" block ≈ effectively one-time), pero
pwede pang higpitan.

**Gawin:** Bawasan ang TTL sa **7 araw**, o tahasang i-invalidate ang token pagkatapos ng desisyon
(true one-time-use).

**Effort:** Maliit (1–2 constant/guard). **Status:** ☐ Deferred, gawin kasabay ng susunod na token work.

---

## 🟢 6. `XFrameOptionsMode.ALLOWALL` sa Admin "Access Denied" page **[code]**

**Ano:** Ang **denied page** lang (`admin_code.js:252`) ang `ALLOWALL`; ang **main Admin view ay
`DEFAULT`** (protektado).

**Bakit:** Limitadong clickjacking risk (denied page lang, may account email lang). Pero walang
dahilan na ALLOWALL.

**Gawin:** Palitan ng `DEFAULT` para consistent. 1-line.

**Effort:** Trivial. **Status:** ☐ Hindi pa.

---

## 🟢 7. PII sa logs **[config/code]**

**Ano:** `Risk_Audit` + `Logger.log` may emails/PII.

**Gawin:** I-review kung sino may access sa logs/sheet; bawasan ang PII sa logs kung hindi kailangan.

**Effort:** Maliit. **Status:** ☐ Hindi pa.

---

## 🟢 8. Shared-computer / multi-login awareness **[ops/training]**

**Ano:** `Session.getActiveUser()` binabasa ang **active browser Google account**, hindi yung sa
inbox. Sa shared PC / multi-login (`authuser=`), pwedeng magkamali ng identity.

**Gawin:** Training/awareness, siguraduhing tamang account ang naka-active kapag nag-a-approve.
UX/ops concern, hindi code.

**Effort:** Ops lang. **Status:** ☐ Ongoing awareness.

---

## 🎯 Suggested order
1. **#1** (verify secret strength), cheapest, highest-impact. Gawin muna.
2. **#4** (API key rotation cadence) at **#6** (XFrame 1-liner), mabilis na wins.
3. **#3** (file scanning) at **#5** (token TTL), kapag may bandwidth.
4. **#2** (HR-sourced approvers), pinakamalaki, pero naghihintay ng HR org data.
