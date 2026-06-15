---
description: Make a scoped, design-only change to the DCS frontend (index.html) safely
---

# /design-fix — safe DCS design change

You are making a **design/UI adjustment** to the Megaworld DCS app per a supervisor request.
Read `CLAUDE.md` first if you haven't this session. The change is described as:

$ARGUMENTS

Follow this procedure. Do not skip steps. Smallest safe change that fully solves it.

## 1. Locate before editing
- All UI lives in `index.html`. Screens are built by JS `render*()` functions, NOT static
  HTML — so **search the matching `render*()` function or the CSS block**, don't assume the
  text is in the markup.
- Identify exactly which screen(s) and function(s)/CSS rules are in scope. State them back
  to the user with line numbers before changing anything.

## 2. Confirm scope is design-only
- ✅ In scope: CSS, layout, spacing, colors (via existing `--vars`), copy/labels, icons,
  responsive behavior, render-function markup, client-side display logic.
- ⛔ Out of scope: anything needing NEW server data, a renamed/added `api*` call, or a
  change to `Code.js`/the backend. If the request needs that, STOP and tell the user it
  requires a backend change (owned by the cloud team), and propose a frontend-only
  alternative if one exists.

## 3. Make the change
- Reuse existing design tokens (`--navy*`, `--success/--danger/--warn`, `--radius*`,
  `--dur-*`, DM Sans). Never hardcode a new hex/px when a token exists; if none fits, ask
  before inventing one.
- Touch only what the task requires. Do not refactor or reformat unrelated code.

## 4. Self-check (the §7 checklist in CLAUDE.md)
- Edited the right `render*()` / CSS block?
- Both responsive breakpoints OK (768px and 480px)?
- If a timeline changed — updated BOTH horizontal and vertical variants?
- If a status badge/legend changed — color, label, and legend still agree?
- No `api*` call renamed/removed/invented? `Code.js` untouched?
- Loading / error / success / revision-mode (`state.isEditing`) states still render?

## 5. Report back (per Kai's delivery format)
1. What changed (brief).
2. Files changed (just `index.html` expected).
3. Assumptions validated from the code.
4. What you intentionally did NOT change.
5. Any part that secretly needs backend data you couldn't provide.
6. Reminder: Kai ships this by **manually copy-pasting `index.html` into the live GAS
   editor** — deployment is not automated here. Then remind to commit to git.
