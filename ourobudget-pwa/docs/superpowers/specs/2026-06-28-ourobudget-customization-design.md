# OuroBudget — Customization & Update Changes (Design Spec)

**Date:** 2026-06-28
**Scope:** `app.jsx`, `index.html`, `sw.js` (no build step; in-browser Babel)
**Status:** Approved design, pending spec review

---

## 1. Goals

1. Replace the fixed "Bi-Weekly Budget" heading with an **editable budget title** (placeholder "Budget").
2. Make the dashboard breakdown ("Where your money is going:") compute percentages as a **share of the check's income**, with a consistent bar.
3. Let users mark a paycheck amount as **repeatable**, carrying forward to newly added checks.
4. Make **all** budget categories removable — including the four defaults.
5. **Automatically notify** installed-app users when a new version is available, let them refresh, and **persist their data** across the update. On category conflicts during migration, **the user's customizations take precedence.**

Non-goals: no backend/sync, no change to export/import format beyond additive fields, no redesign of existing layout.

---

## 2. Data model changes

The saved document (IndexedDB key `doc`) gains optional, additive fields. All are backward-compatible: old backups import cleanly and receive defaults via migration.

| Field | Location | Type | Default | Purpose |
|---|---|---|---|---|
| `budgetTitle` | top level | string | `""` | Editable budget name; empty shows "Budget" placeholder |
| `repeat` | each `checks[]` item | boolean | `false` | When true, new checks inherit this check's income |
| `version` | top level | number | bumped to `2` | Migration marker |

No category schema change. Categories remain: global `categories.items` (the former "fixed" defaults, now removable) plus per-check `customCategories`.

---

## 3. Feature designs

### 3.1 Editable budget title

- `buildSeed()` adds `budgetTitle: ""`.
- In `BudgetSection`, replace the static `<h2>Bi-Weekly Budget</h2>` with an editable `TextInput` bound to `doc.budgetTitle`, `placeholder="Budget"`, styled to match the existing heading (`text-lg font-medium tracking-tight`).
- New action `setBudgetTitle(name)` mutates `doc.budgetTitle`.

### 3.2 "Where your money is going:" — income-based math

Rename `BreakdownBar`'s eyebrow `"This Check — Where it goes"` → **`"Where your money is going:"`**.

Definitions for the selected check:
- `income = num(check.income)`
- `segments` = categories (global + custom) with amount > 0
- `budgeted = sum(segments.amt)`
- `barDenom = max(income, budgeted)` (so the bar always fits its container)
- `leftover = income - budgeted`

Rendering rules:
- **Empty state** (`budgeted <= 0`): keep the existing "Add some planned amounts…" message.
- **Income set** (`income > 0`):
  - Each segment width = `amt / barDenom`.
  - Percentage label = `Math.round(amt / income * 100)` (a share of income).
  - If `leftover > 0`: append a neutral **"Unallocated"** segment, width `leftover / barDenom`, with its own `Math.round(leftover / income * 100)%` label.
  - If `budgeted > income`: show an **"Over income by $X"** warning line; segment percentages legitimately sum past 100%.
- **Income is 0 but budgeted > 0** (transient edge): fall back to budgeted-share percentages (`amt / budgeted`) and show a subtle note: *"Set this check's income to see each category as a share of income."* This avoids `NaN%` / `Infinity%`.

Rounding: each row rounds independently, so displayed percentages may sum to 99–101%. Accepted as-is (no largest-remainder correction).

### 3.3 Repeatable paycheck

- `buildSeed()` and `addCheck` set `repeat: false` by default.
- In `BudgetSection`, next to the "Income this check" field, add a small checkbox/toggle labeled **"Repeat this amount for new checks"** bound to `check.repeat`, toggled via `updateCheck(check.id, { repeat })`.
- `addCheck` change: after determining the latest live check, if that check's `repeat === true`, the new check copies its `income` and sets `repeat: true`; otherwise `income: 0, repeat: false` (current behavior). Forward-looking only — toggling never retroactively rewrites existing checks.

### 3.4 Removable categories (including defaults)

- The global category rows in `BudgetSection` currently render without a remove control. Add the same `×` remove button used by custom rows.
- New action `removeCategory(id)`:
  - Remove the item from `categories.items`.
  - Clean up that category's key from **every** check's `allocations` (no orphaned allocation data).
  - `updatedAt` refreshed on `categories`.
- Removing a default removes it from all checks (defaults are global/shared by design). All categories may be removed; the user can rebuild via "+ Add category".

---

## 4. Automatic update notification + data persistence

### 4.1 Why data already persists

IndexedDB is independent of the service-worker/Cache Storage. Updating the cached app shell never erases user data. Migration only **adds** fields; it never deletes or rewrites user content.

### 4.2 `sw.js`

- Bump `const CACHE = "ouro-pwa-v2"` → `"ouro-pwa-v3"`.
- **Remove** the automatic `self.skipWaiting()` in the `install` handler, so an updated worker enters the **waiting** state instead of silently taking over.
- Add a message handler:
  ```js
  self.addEventListener("message", (e) => {
    if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
  });
  ```
- Keep `activate` (old-cache cleanup + `clients.claim()`) unchanged.

### 4.3 `index.html` registration

Extend the existing registration block:
- On `register(reg)`:
  - If `reg.waiting` exists on load → update is already ready → flag it.
  - `reg.addEventListener("updatefound", …)`: track `reg.installing`; on its `statechange` to `installed`, **only if `navigator.serviceWorker.controller` exists** (an update, not a first install) → flag update ready.
- "Flag update ready" = stash `window.__ouroSWReg = reg`, set `window.__ouroUpdateReady = true`, and `window.dispatchEvent(new CustomEvent("ouro-update-ready"))`.
- Add a one-time controller-swap reload:
  ```js
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return; reloaded = true; window.location.reload();
  });
  ```

### 4.4 `app.jsx` — update banner

- New `UpdateBanner` component:
  - State `ready`, initialized from `window.__ouroUpdateReady` (covers the event firing before mount) and updated by a `"ouro-update-ready"` event listener.
  - Renders a dismissible bottom banner/toast: **"A new version is available."** with a **Refresh** button and an × to dismiss.
  - Refresh handler: `const w = window.__ouroSWReg && window.__ouroSWReg.waiting; if (w) w.postMessage({ type: "SKIP_WAITING" }); else window.location.reload();`
    The `controllerchange` listener in `index.html` performs the actual reload once the new worker activates.
- Mounted once at the App root.

### 4.5 Migration (`migrateDoc`) + category precedence

- `const DOC_VERSION = 2;`
- `migrateDoc(doc)` runs in bootstrap after `idbGet()`, before `setDoc`:
  - If `budgetTitle` is undefined → `""`.
  - For each check: ensure `repeat` (default `false`), `allocations` (object), `customCategories` (array).
  - Ensure `categories.items` is an array; **leave its contents exactly as the user has them** — never re-add or rename categories.
  - Set `version = DOC_VERSION`.
  - If anything changed, persist via `idbSet`.
- **Category-conflict precedence:** reconciliation is keyed by category `id`; the user's stored entry always wins. Default categories are seeded **only** on a first-ever run (`buildSeed`). An update will never resurrect a deleted default nor overwrite a renamed one. This is the concrete meaning of "user custom takes precedence."

---

## 5. Components & responsibilities (summary)

| Unit | Responsibility | Depends on |
|---|---|---|
| `migrateDoc(doc)` | Non-destructive forward migration of stored doc | `DOC_VERSION` |
| `setBudgetTitle` / `removeCategory` actions | Mutate title / remove global category + clean allocations | `mutate` |
| `addCheck` (modified) | Inherit income when latest check is repeatable | `updateCheck` data shape |
| `BreakdownBar` (rewritten math) | Income-based percentages + bar + unallocated/over states | `check.income`, segments |
| `BudgetSection` (title field, repeat toggle, category remove) | Editing UI | actions |
| `UpdateBanner` | Surface waiting SW; trigger skipWaiting + reload | `index.html` SW glue |
| `sw.js` (waiting-based) | Cache shell; wait; skipWaiting on message | — |

---

## 6. Manual test checklist

- Title: empty shows "Budget" placeholder; typed value persists across reload; appears in export JSON.
- Breakdown math: with income $1000 and one $250 category → shows 25% and a 75% "Unallocated" segment; bar fills. Budget $1200 vs income $1000 → "Over income by $200", segments sum >100%. Income $0 with amounts → no `NaN%`, fallback note shown. Nothing budgeted → empty-state message.
- Repeat: toggle on, add check → new check pre-fills same income and stays repeatable; toggle off → new check is $0. Existing checks never rewritten.
- Remove category: removing a default deletes its row everywhere and drops its allocations; can remove all four; rebuild via Add category. Reload confirms persistence.
- Update flow: bump CACHE, redeploy/serve → banner appears on next load; Refresh reloads into the new version once; data intact afterward. Dismiss hides it for the session.
- Backward compat: import an old backup (no `budgetTitle`/`repeat`) → loads with defaults, no errors.

---

## 7. Rollout

Bump `CACHE` to `ouro-pwa-v3`. After deploy, installed users get the update notification on their next launch; tapping **Refresh** loads the new version with their data preserved.
