# Unified Categories — Design

**Date:** 2026-07-01
**Feature:** Unify shared + custom categories; per-check removal; recurrence on every category
**Status:** Approved for planning
**Builds on:** 2026-07-01-recurring-allocations (same branch `feature/recurring-allocations`, not yet merged)

## Problem

OuroBudget currently has **two kinds of category**:

- **Shared** (`doc.categories.items`): a global list. Every check keys them in
  `allocations`. Recurrence-capable. The `×` deletes them **globally** (from all
  checks at once).
- **Custom** (`check.customCategories`): per-check. The `×` removes them from
  only that check. **Not** recurrence-capable.

Two user-facing problems fall out of this split:

1. Removing a shared category from one check removes it from **every** check
   (and drops its recurrence). A user cleaning up a `$0` off-period row can't do
   so without nuking the category everywhere.
2. Newly-added categories are custom, so they have **no recurrence** option.

## Solution

Collapse the two types into **one global category list** (`doc.categories.items`);
`customCategories` is eliminated. A category's **presence on a check** is simply
whether its id is a key in that check's `allocations`:

- key present → the category renders on that check (amount / recurrence-derived
  value / override).
- key absent → it does not show on that check.

This needs **no new data field** — `checkBudgeted` already sums over `allocations`
keys. Recurrence rules already key off `categoryId`, so every category becomes
recurrence-capable the moment it is global (solves problem 2). Per-check removal
becomes "delete this check's key" (solves problem 1).

## Goals

- One unified, global, recurrence-capable category type.
- `×` offers **Remove from this check** (per-check, non-destructive to others and
  to the recurrence) or **Delete everywhere** (global).
- `+ Add category` creates a global category present on all checks at `$0`.
- Migrate existing custom categories into the global list, preserving where they
  currently appear. Non-destructive.

## Non-Goals

- Sinking-fund smoothing, debt section, "Other Expenses" (separate specs).
- A "re-add a removed category to this check" affordance (YAGNI for now; a
  removed category can be re-created via `+ Add category`).
- Un-hiding automatically when a recurrence would land on a removed check
  (removal wins — see Edge Cases).

## Data Model

### Categories — single global list

`doc.categories.items = [{ id, name }]`, seeded with the defaults, and appended to
by `+ Add category`. There is no other category collection.

### Presence — via `allocations` keys

A category `c` shows on a check iff `c.id in check.allocations`.

- Seed / default categories: keyed in every check → shown everywhere (unchanged).
- `+ Add category "X"`: append `{id: uid("cat"), name:"X"}` to
  `doc.categories.items`, and set `allocations[id] = 0` on **every** check.
- Remove **this check**: delete `allocations[id]` (and `recurringOverrides[id]`)
  from that check only.
- Remove **everywhere**: remove from `doc.categories.items`, delete the key from
  every check's `allocations` and `recurringOverrides`, and remove any
  `doc.recurring` rule for it.

### `customCategories` — removed

Eliminated from the model, the seed, and all reads. Migration promotes existing
entries into the global list (below).

## Migration (`migrateDoc`, v3 → v4)

Non-destructive, idempotent. In addition to all existing v2/v3 steps:

- For each check, for each `customCategories` entry `{id, name, amount}`:
  - add `{id, name}` to `doc.categories.items` if that id is not already present;
  - set that check's `allocations[id] = num(amount)` (present on **only** this
    check — preserves current placement).
- Set each check's `customCategories = []` (cleared after promotion).
- Bump `DOC_VERSION` → 4 (the existing `doc.version !== DOC_VERSION` block handles
  the field write).

Custom ids are unique per creation, so no id collisions occur; two same-named
customs on different checks become two distinct global categories (preserves data
exactly rather than guessing a merge). Old JSON backups migrate on import
(`replaceAll` runs `migrateDoc`).

## Behaviors / UX

- **+ Add category "X"** → global add; appears on all checks at `$0`; shows the
  `↻` recurrence button immediately.
- **× on a category row** → inline confirm on that row:
  **[Remove from this check] · [Delete everywhere] · cancel**.
  - *This check* → `removeCategoryHere(checkId, catId)`.
  - *Delete everywhere* → `removeCategoryEverywhere(catId)`.
- **Recurrence** — the `↻` editor and derived amounts are unchanged, now available
  on every category.

## Edge Cases

- **Removed-then-would-recur:** if a category is removed from a check
  (`this check`) and its recurrence would later land an occurrence in that check's
  window, it **stays hidden** there (removal wins; the derived amount is not
  budgeted for that check). Acceptable because users remove `$0` off-period rows,
  not landing checks.
- **Orphaned override:** removing a category from a check also deletes that
  check's `recurringOverrides[catId]` so no orphan remains.
- **Delete everywhere** prunes the `doc.recurring` rule so no orphan rule survives
  (existing behavior).
- **Empty check:** a check with every category removed shows the existing
  "Add some planned amounts…" empty state.

## Code Changes

**`lib.js`** (pure, unit-tested):
- `computeBreakdown(check, categoryItems, rules, windowEndIso)` — include a shared
  category only when `c.id in (check.allocations||{})`; **remove** the
  `customCategories` segment loop.
- `checkBudgeted(check, rules, windowEndIso)` — **remove** the `customCategories`
  summation (it already sums over `allocations` keys = present categories).
- `migrateDoc(doc)` — add the v4 promotion + clear + version bump above.

**`app.jsx`**:
- `BudgetSection` — render `doc.categories.items.filter(c => c.id in
  (check.allocations||{}))`; remove the separate custom-category `.map` block.
- Actions: add `addCategory(name)`, `removeCategoryHere(checkId, catId)`,
  `removeCategoryEverywhere(catId)`; retire `addCustom`/`updateCustom`/
  `removeCustom` and rename/replace the old global `removeCategory`.
- `BudgetRow` — the `×` opens an inline **[This check] · [Everywhere] · cancel**
  confirm (small local `useState` on the row); the two choices call the two remove
  actions.
- `buildSeed` — drop `customCategories` from seeded checks.
- Wire `+ Add category` to `addCategory`.

## Testing

**lib unit tests (`tests/lib.test.js`):**
- `computeBreakdown`: a category present on the check appears; a category in
  `categoryItems` but **absent** from `allocations` does not; no `customCategories`
  segments are produced.
- `checkBudgeted`: sums present categories only; a promoted/custom path no longer
  contributes via `customCategories`.
- `migrateDoc` v4: promotes each `customCategories` entry into `categories.items` +
  sets `allocations[id]` on that check only; clears `customCategories`; bumps to 4;
  idempotent (second run reports no change). Patch the existing "already-current"
  fixture to v4 shape (`customCategories: []`, `version: 4`).

**Existing tests that MUST be rewritten (they encode the old custom-category
behavior that this change removes):**
- The `computeBreakdown` "over budget" test currently uses
  `customCategories: [{ id:"x", name:"Extra", amount:500 }]` to produce a second
  segment and an over-budget total. Rewrite it to use a **second present shared
  category** (e.g. `allocations: { cat_a: 700, cat_b: 500 }`, `categoryItems`
  including `cat_b`) so it still asserts the two-segment / over-income math.
- The Task-4 `checkBudgeted` test currently adds `customCategories:[{amount:10}]`
  into the expected total. Rewrite it so the extra amount is a **second shared
  category present in `allocations`** instead, adjusting the expected sum
  accordingly.
- Any other existing assertion that passes `customCategories` into
  `computeBreakdown`/`checkBudgeted` must be converted to the presence model.

**Browser verification:**
- `+ Add category` → new category shows on all checks with a `↻`.
- Remove **this check** → row gone here; still present on other checks; its
  recurrence still lands where scheduled.
- Delete **everywhere** → gone from all checks; recurrence rule pruned.
- Create a recurrence on a freshly-added category → derives correctly.

## Rollout

- Bump service-worker cache to `ouro-pwa-v6`.
- No new files; logic stays in `lib.js` + `app.jsx`.
