# Recurring Allocations — Design

**Date:** 2026-07-01
**Feature:** Recurring budget allocations (feature 1 of 3 in the current batch)
**Status:** Approved for planning

## Summary

OuroBudget is today a *planning* app: each biweekly **check** (paycheck) holds
*planned* dollar amounts allocated to shared **categories**. There is no concept
of a logged transaction or actual expense.

This feature lets a user mark a category's planned amount as **recurring** on a
schedule (daily → annually, plus a custom interval). A recurring rule projects
forward and lands on whichever future checks cover each occurrence. The rule is
the single source of truth; each check's amount for a recurring category is
*derived* from the rule. A user can still override any single check, and can
edit an existing allocation to make it recurring.

This is feature 1 of a 3-feature batch. Features 2 (debt section) and 3 (manual
"Other Expenses") are **out of scope** for this spec and will get their own
spec → plan → implementation cycles.

## Goals

- Mark a shared category's amount as recurring with amount + frequency +
  first-due date + optional end date.
- Derive each check's amount for a recurring category from the rule, so editing
  or deleting the rule reflows all non-overridden checks without drift.
- Allow per-check overrides that survive rule edits and can be reverted.
- Keep the change non-destructive: existing per-check numbers are preserved.

## Non-Goals

- Logged/actual transactions (the app stays a planner).
- Recurrence on per-check custom categories (they don't persist across checks).
- Debt accounts or "Other Expenses" (separate specs).
- Retroactively rewriting past checks.

## Data Model

### New top-level list: `doc.recurring`

One rule per recurring category:

```js
{
  id: "rec_…",
  categoryId: "cat_food",                 // references doc.categories.items[].id
  amount: 200,                            // dollars per occurrence
  freq: { unit: "month", interval: 1 },   // unit ∈ day|week|month|year; interval ≥ 1
  firstDue: "2026-07-01",                 // ISO date (YYYY-MM-DD) the schedule starts
  endDate: null,                          // ISO date or null (open-ended)
  createdAt: "…",
  updatedAt: "…"
}
```

Presets map onto `freq`:

| Preset       | freq             |
|--------------|------------------|
| Daily        | `day / 1`        |
| Weekly       | `week / 1`       |
| Biweekly     | `week / 2`       |
| Monthly      | `month / 1`      |
| Quarterly    | `month / 3`      |
| Semi-annual  | `month / 6`      |
| Annual       | `year / 1`       |
| Custom       | any unit + interval |

At most one rule per `categoryId` (creating a rule for a category that already
has one edits the existing rule).

### Per-check overrides: `check.recurringOverrides`

A map `{ [catId]: number }` on each check. Non-destructive: it lives alongside
the existing `check.allocations` map, which is left untouched while a rule is
active.

**Effective amount** for a category on a check:

- Category **has a rule**:
  `catId in check.recurringOverrides ? recurringOverrides[catId] : derived`
- Category **has no rule**: `check.allocations[catId]` (unchanged behavior)

Because `allocations[catId]` is preserved, **deleting a rule cleanly reverts**
the category to its prior stored value.

Recurrence applies only to **shared categories** (`doc.categories.items`).
Per-check custom categories are unaffected.

### Migration (`migrateDoc`)

Non-destructive; bumps `DOC_VERSION` 2 → 3:

- Add `doc.recurring = []` if missing.
- Add `check.recurringOverrides = {}` to each check if missing.
- Nothing existing is altered.

## Derivation Math (pure, in `lib.js`)

### Pay window

For a check, its pay window is `[payDate, nextCheckPayDate)` where checks are
sorted ascending by `payDate`. The **last** check uses `payDate + 14 days`
(`BIWEEKLY_DAYS`) as its window end.

### Occurrences and derived amount

- Occurrences start at `firstDue` and step by `interval × unit`, stopping once
  the due date passes `endDate` (if set).
- Derived amount for a check =
  `amount × (count of occurrences whose due date falls within the check's window)`.

Examples (biweekly, 14-day window):

| Rule            | Derived on a covering check |
|-----------------|-----------------------------|
| Daily $10       | ~$140 (14 occurrences)      |
| Weekly $50      | $100 (2 occurrences)        |
| Biweekly $200   | $200 (1 occurrence)         |
| Monthly $500    | $500 on the covering check, $0 on others |
| Annual $1200    | $1200 once per year, $0 otherwise |

Counting starts from the first occurrence `≥ window start` (computed by stepping
forward from `firstDue`), so even daily rules over long spans stay cheap.

### New / changed pure helpers in `lib.js`

- `stepDate(isoDate, unit, interval)` → ISO date. Handles month-end clamping
  (Jan 31 + 1 month → Feb 28).
- `countOccurrencesInWindow(rule, windowStartIso, windowEndIso)` → integer.
- `effectiveAllocation(check, categoryId, rules, windowEndIso)` → number.
  Applies the effective-amount rule above.
- `checkBudgeted(check, rules, windowEndIso)` → sum of effective amounts across
  shared categories + custom categories. (Moves/updates the existing
  `checkBudgeted` from `app.jsx`; keep it usable in the browser and Node.)
- `computeBreakdown(check, categoryItems, rules, windowEndIso)` → same shape as
  today, but segment amounts use effective amounts.

The app computes each check's `windowEnd` from `sortedChecks` and passes it in,
keeping `lib.js` pure and testable.

## UX

### Making a category recurring

Each shared-category row in the budget section gets a small **↻ button** next to
the amount. Tapping it opens a compact inline editor (popover):

- **Frequency** preset dropdown: Daily · Weekly · Biweekly · Monthly ·
  Quarterly · Semi-annual · Annual · **Custom**. Custom reveals
  "every `[N]` `[days/weeks/months/years]`".
- **Amount** — prefilled from the row's current value.
- **First due** — defaults to the current check's pay date.
- **End date** — optional; blank = forever.
- **Save** creates/updates the global rule; **Remove recurrence** deletes it.
- A one-line human summary reads out the cadence
  ("$500 every month, starting Jul 1" / "… until Dec 1").

### How recurring rows look

- On every check, a recurring category shows its **derived** amount with a small
  **↻ badge** (rule-driven, not typed).
- Typing a number on a single check creates a per-check **override**, shown with
  a subtle "overridden" hint and a **↺ revert** control that clears it back to
  derived.
- Editing or deleting the rule instantly reflows every non-overridden check.

No new top dashboard element for this feature; recurring amounts flow through the
existing "Where your money is going" breakdown and the Budgeted / Left totals via
the updated math.

## Edge Cases

- **Category removed** while a rule references it → rule is ignored and pruned
  (no orphan crash). `removeCategory` also drops any matching `doc.recurring`
  entry and `recurringOverrides` keys.
- **`firstDue` after a check's window** → $0 there (schedule hasn't started).
- **Last check** uses the synthetic `payDate + 14 days` window end.
- **High-frequency rules** stay cheap (count from first occurrence ≥ window
  start).
- **Override of 0** is a real override (category intentionally $0 on that check),
  distinct from "no override → derived."

## Testing

Unit tests in `tests/lib.test.js` (Node `assert`):

- `stepDate` across day/week/month/year incl. month-end clamping.
- `countOccurrencesInWindow`: daily summing, weekly (2/window), monthly (exactly
  one check), annual (once/year), `endDate` cutoff, future `firstDue` (0).
- `effectiveAllocation`: override wins over derived; no-rule falls back to
  `allocations[catId]`; derived when neither.
- `checkBudgeted` / `computeBreakdown` reflect derived amounts and overrides.
- `migrateDoc`: adds `recurring` / `recurringOverrides`, bumps to v3, leaves
  existing data intact.

## Rollout

- Bump the service-worker cache to `ouro-pwa-v5` so installed PWAs pick up the
  update (and surface the in-app update banner).
- No new files loaded in `index.html`; the logic lives in the existing `lib.js`.
