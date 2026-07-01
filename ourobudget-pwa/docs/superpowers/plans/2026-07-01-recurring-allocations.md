# Recurring Allocations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user mark a shared budget category's amount as recurring on a schedule (daily→annually + custom), projecting derived amounts onto whichever checks each occurrence lands on, with per-check overrides.

**Architecture:** Recurring rules are the single source of truth, stored in a new `doc.recurring` list. Per-check amounts for recurring categories are *derived* by pure functions in `lib.js` (amount × occurrences in the check's pay window). A non-destructive `check.recurringOverrides` map holds per-check overrides; the existing `check.allocations` map is preserved untouched so deleting a rule reverts cleanly. The React UI in `app.jsx` reads derived amounts and edits rules through a popover editor.

**Tech Stack:** React + Tailwind + in-browser Babel (no build step). Pure helpers in `lib.js` (browser global + Node `require`). Tests are Node `assert` scripts in `tests/lib.test.js`. Storage is IndexedDB. Service worker `sw.js` cache-first.

## Global Constraints

- No build step, no bundler, no new runtime dependencies. All logic goes in the existing `lib.js` (pure) and `app.jsx` (React).
- `lib.js` must stay dual-environment: top-level `function`/`var` declarations (browser globals) plus the existing `if (typeof module !== "undefined" && module.exports)` export guard. Do not use `import`/`export`.
- `lib.js` helpers must not reference browser-only or app-only globals (no `money`, `prettyDate`, `document`, `window`). Only `num`, other `lib.js` helpers, and standard JS/`Date`/`Intl`.
- Dates are ISO `YYYY-MM-DD` strings. Parse with the existing convention `new Date(iso + "T00:00:00")`.
- `DOC_VERSION` becomes `3`. Migration must be non-destructive.
- Recurrence applies only to **shared** categories (`doc.categories.items`), never per-check `customCategories`.
- At most one recurring rule per `categoryId`.
- Test runner command (Bash tool): `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js` — expected final line `All lib.js tests passed.`
- Bump `sw.js` `CACHE` to `ouro-pwa-v5` as the final step.
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

- **Modify `lib.js`** — add `stepDate`, `countOccurrencesInWindow`, `recurringRuleFor`, `effectiveAllocation`; move+update `checkBudgeted` here; update `computeBreakdown` and `migrateDoc`; bump `DOC_VERSION`; extend the `module.exports` object.
- **Modify `tests/lib.test.js`** — add assertions for every new/changed helper.
- **Modify `app.jsx`** — remove the local `checkBudgeted`; add a `checkWindowEnd` helper; add `describeRecurrence`; add a `RecurrenceEditor` component; extend `BudgetRow`; wire derived amounts + new actions through `Dashboard`, `BreakdownBar`, `BudgetSection`; add actions `setRecurring`, `removeRecurring`, `setOverride`, `revertOverride`; update `removeCategory` to prune rules/overrides.
- **Modify `sw.js`** — bump cache string.

---

## Task 1: `stepDate` — advance an ISO date by a frequency unit

**Files:**
- Modify: `lib.js` (add function near the top, after `num`)
- Test: `tests/lib.test.js`

**Interfaces:**
- Produces: `stepDate(iso: string, unit: "day"|"week"|"month"|"year", interval: number) -> string` (ISO `YYYY-MM-DD`). Month/year stepping clamps to the last valid day (Jan 31 + 1 month → Feb 28).

- [ ] **Step 1: Write the failing tests**

The test file destructures its imports on line 2. First extend that line to include `stepDate`:

```js
const { num, DOC_VERSION, computeBreakdown, migrateDoc, stepDate } = require("../lib.js");
```

Then add these assertions before the final `console.log("All lib.js tests passed.");`:

```js
// --- stepDate ---
assert.strictEqual(stepDate("2026-01-15", "day", 14), "2026-01-29", "day step");
assert.strictEqual(stepDate("2026-01-01", "week", 2), "2026-01-15", "week step");
assert.strictEqual(stepDate("2026-01-31", "month", 1), "2026-02-28", "month-end clamp");
assert.strictEqual(stepDate("2026-03-31", "month", 1), "2026-04-30", "month-end clamp 30");
assert.strictEqual(stepDate("2026-01-15", "month", 3), "2026-04-15", "quarter step");
assert.strictEqual(stepDate("2024-02-29", "year", 1), "2025-02-28", "leap-year clamp");
assert.strictEqual(stepDate("2026-06-01", "year", 1), "2027-06-01", "year step");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — `TypeError: lib.stepDate is not a function`.

- [ ] **Step 3: Implement `stepDate` in `lib.js`**

Add after the `num` function:

```js
function stepDate(iso, unit, interval) {
  var d = new Date(iso + "T00:00:00");
  var n = interval || 1;
  if (unit === "day") {
    d.setDate(d.getDate() + n);
  } else if (unit === "week") {
    d.setDate(d.getDate() + n * 7);
  } else if (unit === "month" || unit === "year") {
    var day = d.getDate();
    d.setDate(1);
    if (unit === "month") d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Export it**

In the `module.exports = { ... }` object at the bottom of `lib.js`, add `stepDate: stepDate,`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — ends with `All lib.js tests passed.`

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: add stepDate helper for recurring schedules"
```

---

## Task 2: `countOccurrencesInWindow` — occurrences of a rule inside a pay window

**Files:**
- Modify: `lib.js`
- Test: `tests/lib.test.js`

**Interfaces:**
- Consumes: `stepDate` (Task 1).
- Produces: `countOccurrencesInWindow(rule, startIso, endIso) -> number`. Counts occurrences whose due date is in `[startIso, endIso)`. `rule = { firstDue, endDate|null, freq:{unit, interval} }`. Occurrences start at `firstDue`, step by `interval × unit`, stop once past `endDate`. Returns 0 for a missing/malformed rule or `firstDue` at/after `endIso`.

- [ ] **Step 1: Write the failing tests**

Extend the destructure on line 2 to add `countOccurrencesInWindow`, then add to `tests/lib.test.js`:

```js
// --- countOccurrencesInWindow ---
var daily = { firstDue: "2026-01-01", endDate: null, freq: { unit: "day", interval: 1 } };
assert.strictEqual(countOccurrencesInWindow(daily, "2026-01-01", "2026-01-15"), 14, "daily over 14-day window");
var weekly = { firstDue: "2026-01-01", endDate: null, freq: { unit: "week", interval: 1 } };
assert.strictEqual(countOccurrencesInWindow(weekly, "2026-01-01", "2026-01-15"), 2, "weekly over biweekly window");
var monthly = { firstDue: "2026-01-10", endDate: null, freq: { unit: "month", interval: 1 } };
assert.strictEqual(countOccurrencesInWindow(monthly, "2026-01-01", "2026-01-15"), 1, "monthly lands in covering window");
assert.strictEqual(countOccurrencesInWindow(monthly, "2026-01-15", "2026-01-29"), 0, "monthly absent from non-covering window");
var annual = { firstDue: "2026-03-01", endDate: null, freq: { unit: "year", interval: 1 } };
assert.strictEqual(countOccurrencesInWindow(annual, "2026-01-01", "2026-01-15"), 0, "annual before its due date");
assert.strictEqual(countOccurrencesInWindow(annual, "2026-03-01", "2026-03-15"), 1, "annual on its due date");
var ended = { firstDue: "2026-01-01", endDate: "2026-01-05", freq: { unit: "day", interval: 1 } };
assert.strictEqual(countOccurrencesInWindow(ended, "2026-01-01", "2026-01-15"), 5, "endDate cutoff (inclusive)");
var future = { firstDue: "2026-06-01", endDate: null, freq: { unit: "day", interval: 1 } };
assert.strictEqual(countOccurrencesInWindow(future, "2026-01-01", "2026-01-15"), 0, "not started yet");
assert.strictEqual(countOccurrencesInWindow(null, "2026-01-01", "2026-01-15"), 0, "null rule");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — `TypeError: lib.countOccurrencesInWindow is not a function`.

- [ ] **Step 3: Implement in `lib.js`**

Add after `stepDate`:

```js
function countOccurrencesInWindow(rule, startIso, endIso) {
  if (!rule || !rule.freq || !rule.firstDue) return 0;
  var unit = rule.freq.unit;
  var interval = rule.freq.interval || 1;
  var cur = rule.firstDue;

  // Fast-forward to the first occurrence on/after startIso.
  if (cur < startIso) {
    if (unit === "day" || unit === "week") {
      var perStepDays = (unit === "day" ? 1 : 7) * interval;
      var ms = new Date(startIso + "T00:00:00") - new Date(cur + "T00:00:00");
      var k = Math.floor(ms / 86400000 / perStepDays);
      if (k > 0) cur = stepDate(cur, "day", k * perStepDays);
      var guardA = 0;
      while (cur < startIso && guardA < 1000) { cur = stepDate(cur, "day", perStepDays); guardA++; }
    } else {
      var guardB = 0;
      while (cur < startIso && guardB < 100000) { cur = stepDate(cur, unit, interval); guardB++; }
    }
  }

  var count = 0, guardC = 0;
  while (cur < endIso && guardC < 100000) {
    if (rule.endDate && cur > rule.endDate) break;
    count++;
    cur = stepDate(cur, unit, interval);
    guardC++;
  }
  return count;
}
```

- [ ] **Step 4: Export it**

Add `countOccurrencesInWindow: countOccurrencesInWindow,` to `module.exports`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: count recurring occurrences within a pay window"
```

---

## Task 3: `recurringRuleFor` + `effectiveAllocation`

**Files:**
- Modify: `lib.js`
- Test: `tests/lib.test.js`

**Interfaces:**
- Consumes: `countOccurrencesInWindow` (Task 2), `num` (existing).
- Produces:
  - `recurringRuleFor(rules, categoryId) -> rule | null` (first rule matching `categoryId`).
  - `effectiveAllocation(check, categoryId, rules, windowEndIso) -> number`. If a rule exists: return `check.recurringOverrides[categoryId]` when that key is present, else `rule.amount × countOccurrencesInWindow(rule, check.payDate, windowEndIso)`. If no rule: return `check.allocations[categoryId]` (via `num`).

- [ ] **Step 1: Write the failing tests**

Extend the destructure on line 2 to add `recurringRuleFor, effectiveAllocation`, then add to `tests/lib.test.js`:

```js
// --- recurringRuleFor / effectiveAllocation ---
var rules = [{ id: "rec_1", categoryId: "cat_food", amount: 100,
  firstDue: "2026-01-01", endDate: null, freq: { unit: "week", interval: 1 } }];
assert.strictEqual(recurringRuleFor(rules, "cat_food").id, "rec_1", "finds rule");
assert.strictEqual(recurringRuleFor(rules, "cat_gas"), null, "no rule -> null");

var chk = { payDate: "2026-01-01", allocations: { cat_food: 999, cat_gas: 25 }, recurringOverrides: {} };
// window [2026-01-01, 2026-01-15): weekly $100 -> 2 occurrences -> $200; allocations ignored for recurring cat
assert.strictEqual(effectiveAllocation(chk, "cat_food", rules, "2026-01-15"), 200, "derived overrides stored allocation");
// no rule -> stored allocation
assert.strictEqual(effectiveAllocation(chk, "cat_gas", rules, "2026-01-15"), 25, "no rule falls back to allocations");

var chkOv = { payDate: "2026-01-01", allocations: { cat_food: 999 }, recurringOverrides: { cat_food: 40 } };
assert.strictEqual(effectiveAllocation(chkOv, "cat_food", rules, "2026-01-15"), 40, "override wins over derived");
var chkOv0 = { payDate: "2026-01-01", allocations: { cat_food: 999 }, recurringOverrides: { cat_food: 0 } };
assert.strictEqual(effectiveAllocation(chkOv0, "cat_food", rules, "2026-01-15"), 0, "override of 0 is honored");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — `TypeError: lib.recurringRuleFor is not a function`.

- [ ] **Step 3: Implement in `lib.js`**

Add after `countOccurrencesInWindow`:

```js
function recurringRuleFor(rules, categoryId) {
  var list = rules || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].categoryId === categoryId) return list[i];
  }
  return null;
}

function effectiveAllocation(check, categoryId, rules, windowEndIso) {
  var rule = recurringRuleFor(rules, categoryId);
  if (rule) {
    var ov = (check && check.recurringOverrides) || {};
    if (Object.prototype.hasOwnProperty.call(ov, categoryId)) return num(ov[categoryId]);
    var count = countOccurrencesInWindow(rule, check && check.payDate, windowEndIso);
    return num(rule.amount) * count;
  }
  return num(((check && check.allocations) || {})[categoryId]);
}
```

- [ ] **Step 4: Export them**

Add `recurringRuleFor: recurringRuleFor,` and `effectiveAllocation: effectiveAllocation,` to `module.exports`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: effective allocation from recurring rules and overrides"
```

---

## Task 4: Move `checkBudgeted` into `lib.js` and update `computeBreakdown`

**Files:**
- Modify: `lib.js`
- Test: `tests/lib.test.js`

**Interfaces:**
- Consumes: `effectiveAllocation` (Task 3), `num` (existing).
- Produces:
  - `checkBudgeted(check, rules, windowEndIso) -> number` — sum of `effectiveAllocation` over every key in `check.allocations`, plus every `check.customCategories[].amount`.
  - `computeBreakdown(check, categoryItems, rules, windowEndIso)` — same return shape as today, but each shared-category segment amount comes from `effectiveAllocation(check, c.id, rules, windowEndIso)`.

Note: `checkBudgeted` currently lives in `app.jsx`; it is being moved here. Task 6 removes the `app.jsx` copy and updates callers.

- [ ] **Step 1: Write the failing tests**

Extend the destructure on line 2 to add `checkBudgeted` (`computeBreakdown` is already imported), then add to `tests/lib.test.js`:

```js
// --- checkBudgeted with rules ---
var cbRules = [{ id: "rec_f", categoryId: "cat_food", amount: 100,
  firstDue: "2026-01-01", endDate: null, freq: { unit: "week", interval: 1 } }];
var cbCheck = { payDate: "2026-01-01",
  allocations: { cat_food: 999, cat_gas: 25 },
  customCategories: [{ id: "c1", name: "Fun", amount: 10 }],
  recurringOverrides: {} };
// food derived: weekly $100 x2 = 200; gas 25; custom 10 => 235
assert.strictEqual(checkBudgeted(cbCheck, cbRules, "2026-01-15"), 235, "budgeted uses derived + custom");

// --- computeBreakdown with rules ---
var bd = computeBreakdown(
  { payDate: "2026-01-01", income: 500, allocations: { cat_food: 999, cat_gas: 25 },
    customCategories: [], recurringOverrides: {} },
  [{ id: "cat_food", name: "Food" }, { id: "cat_gas", name: "Gas" }],
  cbRules, "2026-01-15");
var foodSeg = bd.segments.find(function (s) { return s.name === "Food"; });
assert.strictEqual(foodSeg.amt, 200, "breakdown food segment uses derived amount");
assert.strictEqual(bd.budgeted, 225, "breakdown budgeted = 200 + 25");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — `checkBudgeted is not a function` (or a wrong-arity assertion failure on `computeBreakdown`).

- [ ] **Step 3: Add `checkBudgeted` to `lib.js`**

Add after `effectiveAllocation`:

```js
function checkBudgeted(check, rules, windowEndIso) {
  var sum = 0;
  var allocs = (check && check.allocations) || {};
  Object.keys(allocs).forEach(function (catId) {
    sum += effectiveAllocation(check, catId, rules, windowEndIso);
  });
  ((check && check.customCategories) || []).forEach(function (c) { sum += num(c.amount); });
  return sum;
}
```

- [ ] **Step 4: Update `computeBreakdown` signature and body**

Change the signature line from `function computeBreakdown(check, categoryItems) {` to:

```js
function computeBreakdown(check, categoryItems, rules, windowEndIso) {
```

Replace the shared-category loop that reads `check.allocations` with:

```js
  (categoryItems || []).forEach(function (c) {
    var amt = effectiveAllocation(check, c.id, rules, windowEndIso);
    if (amt > 0) segments.push({ name: c.name, amt: amt });
  });
```

Leave the `customCategories` loop, the `budgeted`/`pctBase`/`barDenom`/`over` math, and the return object exactly as they are.

- [ ] **Step 5: Export `checkBudgeted`**

Add `checkBudgeted: checkBudgeted,` to `module.exports`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 7: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: budgeted/breakdown math uses recurring-derived amounts"
```

---

## Task 5: Migration — `recurring` list, `recurringOverrides`, `DOC_VERSION` 3

**Files:**
- Modify: `lib.js`
- Test: `tests/lib.test.js`

**Interfaces:**
- Produces: `migrateDoc(doc)` also adds `doc.recurring = []` when missing and `check.recurringOverrides = {}` for each check when missing; `DOC_VERSION` is `3`.

- [ ] **Step 1: Write the failing tests**

`migrateDoc` and `DOC_VERSION` are already imported. Add to `tests/lib.test.js`:

```js
// --- migrateDoc v3 ---
var pre = { version: 2, budgetTitle: "", categories: { items: [] },
  accounts: [], checks: [{ id: "chk_1", allocations: {}, customCategories: [], repeat: false }] };
var mig = migrateDoc(pre);
assert.strictEqual(mig.changed, true, "migration reports change");
assert.ok(Array.isArray(mig.doc.recurring), "recurring array added");
assert.deepStrictEqual(mig.doc.checks[0].recurringOverrides, {}, "recurringOverrides added");
assert.strictEqual(mig.doc.version, 3, "version bumped to 3");
assert.strictEqual(DOC_VERSION, 3, "DOC_VERSION is 3");
// idempotent
var again = migrateDoc(mig.doc);
assert.strictEqual(again.changed, false, "second migration is a no-op");
```

Also patch the **existing** "already-current" fixture (currently around L84-90, the block whose assertion is `"already-current doc reports no change"`) so it stays current under v3 — add `recurring: []` to the doc and `recurringOverrides: {}` to its check:

```js
  const doc = {
    budgetTitle: "My Budget",
    version: DOC_VERSION,
    categories: { items: [{ id: "cat_food", name: "Groceries" }] }, // renamed default
    accounts: [],
    recurring: [],
    checks: [{ id: "chk_1", income: 0, allocations: {}, repeat: false, customCategories: [], recurringOverrides: {} }],
  };
```

Without this patch, the v3 migration would add the new fields and flip `changed` to `true`, breaking that existing assertion.

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — `DOC_VERSION is 3` (still 2) and/or `recurring array added`.

- [ ] **Step 3: Bump `DOC_VERSION`**

Change `var DOC_VERSION = 2;` to `var DOC_VERSION = 3;`.

- [ ] **Step 4: Add migration steps in `migrateDoc`**

Immediately after the existing `budgetTitle` block, add:

```js
  if (!Array.isArray(doc.recurring)) { doc.recurring = []; changed = true; }
```

Inside the existing `doc.checks.forEach` loop, add alongside the other per-check defaults:

```js
      if (!c.recurringOverrides || typeof c.recurringOverrides !== "object") { c.recurringOverrides = {}; changed = true; }
```

(The existing `doc.version !== DOC_VERSION` block at the end already handles the version bump.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: migrate docs to v3 with recurring + overrides"
```

---

## Task 6: `app.jsx` data layer — window helper, actions, seed, remove local `checkBudgeted`

**Files:**
- Modify: `app.jsx` (helpers region ~L98-107; `buildSeed` ~L40-61; `Dashboard` ~L227-259; `BreakdownBar` ~L176-225; `BudgetSection` ~L287-293; `actions` object ~L665-707)

**Interfaces:**
- Consumes: `checkBudgeted(check, rules, windowEndIso)`, `computeBreakdown(check, categoryItems, rules, windowEndIso)`, `recurringRuleFor` (all from `lib.js`).
- Produces (app-internal):
  - `checkWindowEnd(checks, check) -> string` — next check's `payDate`, or `addDays(check.payDate, BIWEEKLY_DAYS)` for the last check. `checks` is the sorted list.
  - actions: `setRecurring(categoryId, fields)`, `removeRecurring(categoryId)`, `setOverride(checkId, categoryId, value)`, `revertOverride(checkId, categoryId)`; updated `removeCategory`.

No unit test (React-in-browser); verified via preview in Task 8. This task must leave the app rendering exactly as before (no visible change yet).

- [ ] **Step 1: Remove the local `checkBudgeted` from `app.jsx`**

Delete the existing definition (currently around L102-106):

```js
const checkBudgeted = (chk) => {
  const fixed = Object.values(chk.allocations || {}).reduce((s, v) => s + num(v), 0);
  const custom = (chk.customCategories || []).reduce((s, c) => s + num(c.amount), 0);
  return fixed + custom;
};
```

`checkBudgeted` now comes from `lib.js` as a global.

- [ ] **Step 2: Add `checkWindowEnd` helper**

In the derived-views region (right after `sortedChecks`), add:

```js
const checkWindowEnd = (checks, check) => {
  const idx = checks.findIndex((c) => c.id === check.id);
  const next = checks[idx + 1];
  return next ? next.payDate : addDays(check.payDate, BIWEEKLY_DAYS);
};
```

- [ ] **Step 3: Seed `recurring` and per-check `recurringOverrides`**

In `buildSeed`, add `recurring: [],` to the returned object (next to `categories`/`accounts`), and add `recurringOverrides: {},` inside each seeded check object (next to `allocations`).

- [ ] **Step 4: Update `Dashboard` to pass rules + window**

In `Dashboard`, replace `const budgeted = check ? checkBudgeted(check) : 0;` with:

```js
  const dashChecks = sortedChecks(doc);
  const budgeted = check ? checkBudgeted(check, doc.recurring, checkWindowEnd(dashChecks, check)) : 0;
```

Change the `BreakdownBar` usage `{check && <BreakdownBar doc={doc} check={check} />}` to:

```js
      {check && <BreakdownBar doc={doc} check={check} windowEnd={checkWindowEnd(dashChecks, check)} />}
```

- [ ] **Step 5: Update `BreakdownBar` to accept `windowEnd` and pass rules**

Change `function BreakdownBar({ doc, check }) {` to `function BreakdownBar({ doc, check, windowEnd }) {` and change the `computeBreakdown` call to:

```js
  const b = computeBreakdown(check, doc.categories.items, doc.recurring, windowEnd);
```

- [ ] **Step 6: Update `BudgetSection` budgeted calc**

In `BudgetSection`, replace `const budgeted = checkBudgeted(check);` with:

```js
  const budgeted = checkBudgeted(check, doc.recurring, checkWindowEnd(checks, check));
```

(`checks` is already defined as `sortedChecks(doc)` at the top of `BudgetSection`.)

- [ ] **Step 7: Add the new actions and update `removeCategory`**

In the `actions` object, replace the existing `removeCategory` with this version (adds rule/override pruning):

```js
    removeCategory: (id) => mutate((d) => {
      d.categories = { updatedAt: nowIso(), items: d.categories.items.filter((c) => c.id !== id) };
      d.recurring = (d.recurring || []).filter((r) => r.categoryId !== id);
      d.checks = d.checks.map((c) => {
        let next = c;
        if (c.allocations && id in c.allocations) {
          const a = { ...c.allocations }; delete a[id];
          next = { ...next, allocations: a, updatedAt: nowIso() };
        }
        if (c.recurringOverrides && id in c.recurringOverrides) {
          const o = { ...next.recurringOverrides }; delete o[id];
          next = { ...next, recurringOverrides: o, updatedAt: nowIso() };
        }
        return next;
      });
      return d;
    }),
```

Add these actions (near `setAllocation`):

```js
    setRecurring: (categoryId, fields) => mutate((d) => {
      const list = d.recurring || [];
      const existing = list.find((r) => r.categoryId === categoryId);
      if (existing) {
        d.recurring = list.map((r) => r.categoryId === categoryId
          ? { ...r, ...fields, updatedAt: nowIso() } : r);
      } else {
        d.recurring = [...list, {
          id: uid("rec"), categoryId,
          amount: num(fields.amount),
          freq: fields.freq, firstDue: fields.firstDue, endDate: fields.endDate || null,
          createdAt: nowIso(), updatedAt: nowIso(),
        }];
      }
      return d;
    }),
    removeRecurring: (categoryId) => mutate((d) => {
      d.recurring = (d.recurring || []).filter((r) => r.categoryId !== categoryId);
      d.checks = d.checks.map((c) => {
        if (!c.recurringOverrides || !(categoryId in c.recurringOverrides)) return c;
        const o = { ...c.recurringOverrides }; delete o[categoryId];
        return { ...c, recurringOverrides: o, updatedAt: nowIso() };
      });
      return d;
    }),
    setOverride: (checkId, categoryId, value) => mutate((d) => {
      d.checks = d.checks.map((c) => c.id === checkId
        ? { ...c, recurringOverrides: { ...(c.recurringOverrides || {}), [categoryId]: num(value) }, updatedAt: nowIso() }
        : c);
      return d;
    }),
    revertOverride: (checkId, categoryId) => mutate((d) => {
      d.checks = d.checks.map((c) => {
        if (c.id !== checkId || !c.recurringOverrides || !(categoryId in c.recurringOverrides)) return c;
        const o = { ...c.recurringOverrides }; delete o[categoryId];
        return { ...c, recurringOverrides: o, updatedAt: nowIso() };
      });
      return d;
    }),
```

- [ ] **Step 8: Verify the app still renders unchanged**

Start/confirm the preview server (`ourobudget` in `.claude/launch.json`), clear caches + reload via `preview_eval` (`caches.keys()`→delete, unregister SW, `location.reload()`), then `preview_screenshot`. Expected: the app looks identical to before this task (no recurring UI yet), no console errors via `preview_console_logs` (level `error`).

- [ ] **Step 9: Commit**

```bash
git add app.jsx
git commit -m "feat: wire recurring rules + overrides through app data layer"
```

---

## Task 7: `app.jsx` UI — recurrence editor, ↻ button, derived/override rows

**Files:**
- Modify: `app.jsx` (`BudgetRow` ~L268-285; add `describeRecurrence` + `RecurrenceEditor`; `BudgetSection` category-rows block ~L342-357)

**Interfaces:**
- Consumes: actions from Task 6 (`setRecurring`, `removeRecurring`, `setOverride`, `revertOverride`), `recurringRuleFor`, `effectiveAllocation`, `checkWindowEnd`.
- Produces (app-internal): `describeRecurrence(rule) -> string`; `RecurrenceEditor` component; extended `BudgetRow` props `rule`, `overridden`, `onOpenRecurrence`, `onRevert`.

No unit test; verified via preview.

- [ ] **Step 1: Add `describeRecurrence` helper**

Add near the other `app.jsx` helpers (after `prettyDate`):

```js
const FREQ_PRESETS = [
  { key: "daily", label: "Daily", unit: "day", interval: 1 },
  { key: "weekly", label: "Weekly", unit: "week", interval: 1 },
  { key: "biweekly", label: "Biweekly", unit: "week", interval: 2 },
  { key: "monthly", label: "Monthly", unit: "month", interval: 1 },
  { key: "quarterly", label: "Quarterly", unit: "month", interval: 3 },
  { key: "semiannual", label: "Semi-annual", unit: "month", interval: 6 },
  { key: "annual", label: "Annual", unit: "year", interval: 1 },
];
const matchPreset = (freq) => FREQ_PRESETS.find((p) => p.unit === freq.unit && p.interval === freq.interval);
const describeRecurrence = (rule) => {
  if (!rule || !rule.freq) return "";
  const p = matchPreset(rule.freq);
  const cadence = p ? p.label.toLowerCase()
    : `every ${rule.freq.interval} ${rule.freq.unit}${rule.freq.interval === 1 ? "" : "s"}`;
  let s = `${money(num(rule.amount))} ${cadence}`;
  if (rule.firstDue) s += `, starting ${prettyDate(rule.firstDue)}`;
  if (rule.endDate) s += ` until ${prettyDate(rule.endDate)}`;
  return s;
};
```

- [ ] **Step 2: Add the `RecurrenceEditor` component**

Add above `BudgetSection`:

```js
function RecurrenceEditor({ categoryName, rule, defaultFirstDue, onSave, onRemove, onClose }) {
  const initPreset = rule ? matchPreset(rule.freq) : FREQ_PRESETS[3]; // default Monthly
  const [presetKey, setPresetKey] = useState(initPreset ? initPreset.key : "custom");
  const [customUnit, setCustomUnit] = useState(rule ? rule.freq.unit : "month");
  const [customInterval, setCustomInterval] = useState(rule ? rule.freq.interval : 1);
  const [amount, setAmount] = useState(rule ? rule.amount : 0);
  const [firstDue, setFirstDue] = useState(rule ? rule.firstDue : defaultFirstDue);
  const [endDate, setEndDate] = useState(rule ? (rule.endDate || "") : "");

  const freq = presetKey === "custom"
    ? { unit: customUnit, interval: Math.max(1, num(customInterval) || 1) }
    : (() => { const p = FREQ_PRESETS.find((x) => x.key === presetKey); return { unit: p.unit, interval: p.interval }; })();
  const preview = describeRecurrence({ amount, freq, firstDue, endDate: endDate || null });

  return (
    <div className="mt-2 mb-1 bg-brand-bg border border-brand-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-brand-text">Recurring: {categoryName}</span>
        <button onClick={onClose} className="text-brand-muted text-lg leading-none px-1" title="Close">×</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}
          className="bg-brand-surface border border-brand-border rounded-lg px-2 py-1 text-brand-text">
          {FREQ_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="custom">Custom…</option>
        </select>
        {presetKey === "custom" && (
          <span className="flex items-center gap-1">
            <span className="text-brand-text2">every</span>
            <input type="number" min="1" value={customInterval}
              onChange={(e) => setCustomInterval(e.target.value)}
              className="w-14 bg-brand-surface border border-brand-border rounded-lg px-2 py-1 text-brand-text" />
            <select value={customUnit} onChange={(e) => setCustomUnit(e.target.value)}
              className="bg-brand-surface border border-brand-border rounded-lg px-2 py-1 text-brand-text">
              <option value="day">days</option><option value="week">weeks</option>
              <option value="month">months</option><option value="year">years</option>
            </select>
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          <span className="text-brand-text2">$</span>
          <MoneyInput value={amount} onChange={setAmount}
            className="w-24 text-brand-text border-b border-brand-border focus:border-brand-accent" />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-brand-text2">from</span>
          <input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)}
            className="bg-brand-surface border border-brand-border rounded-lg px-2 py-1 text-brand-text" />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-brand-text2">until</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="bg-brand-surface border border-brand-border rounded-lg px-2 py-1 text-brand-text" />
        </label>
      </div>
      <div className="text-xs text-brand-muted">{preview}</div>
      <div className="flex items-center gap-2">
        <button onClick={() => onSave({ amount: num(amount), freq, firstDue, endDate: endDate || null })}
          className="rounded-full px-3 py-1 text-xs font-medium bg-brand-accent text-white dark:text-[#15240a] hover:bg-brand-accentd">
          Save
        </button>
        {rule && (
          <button onClick={onRemove}
            className="rounded-full px-3 py-1 text-xs border border-brand-border text-brand-danger hover:border-brand-danger">
            Remove recurrence
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Extend `BudgetRow` with recurrence controls**

Replace `BudgetRow` with:

```js
function BudgetRow({ label, renamable, onRename, amount, onAmount, onRemove, rule, overridden, onOpenRecurrence, onRevert }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-brand-border last:border-0">
      {renamable ? (
        <TextInput value={label} onChange={onRename} className="flex-1 text-sm text-brand-text min-w-0" />
      ) : (
        <span className="flex-1 text-sm text-brand-text truncate">{label}</span>
      )}
      {onOpenRecurrence && (
        <button onClick={onOpenRecurrence} title={rule ? "Edit recurrence" : "Make recurring"}
          className={"text-sm leading-none px-1 " + (rule ? "text-brand-accent" : "text-brand-muted hover:text-brand-accentd")}>↻</button>
      )}
      {rule && overridden && (
        <button onClick={onRevert} title="Revert to recurring amount"
          className="text-brand-muted hover:text-brand-accentd text-sm leading-none px-1">↺</button>
      )}
      <span className="text-brand-muted text-sm">$</span>
      <MoneyInput value={amount} onChange={onAmount}
        className="w-24 text-sm text-brand-text border-b border-brand-border focus:border-brand-accent" />
      {onRemove && (
        <button onClick={onRemove}
          className="text-brand-muted hover:text-brand-accentd text-lg leading-none px-1" title="Remove">×</button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the shared-category rows in `BudgetSection`**

At the top of `BudgetSection` (after `const [newCat, setNewCat] = useState("");`) add:

```js
  const [editingCat, setEditingCat] = useState(null); // categoryId whose recurrence editor is open
  const windowEnd = checkWindowEnd(checks, check);
```

Replace the shared-category `.map` block (the `doc.categories.items.map(...)` that renders `<BudgetRow ... />`) with:

```js
        {doc.categories.items.map((c) => {
          const rule = recurringRuleFor(doc.recurring, c.id);
          const overridden = !!(rule && check.recurringOverrides && (c.id in check.recurringOverrides));
          const amt = effectiveAllocation(check, c.id, doc.recurring, windowEnd);
          return (
            <React.Fragment key={c.id}>
              <BudgetRow label={c.name} renamable
                onRename={(name) => actions.renameCategory(c.id, name)}
                amount={amt}
                onAmount={(v) => rule ? actions.setOverride(check.id, c.id, v) : actions.setAllocation(check.id, c.id, v)}
                onRemove={() => actions.removeCategory(c.id)}
                rule={rule} overridden={overridden}
                onOpenRecurrence={() => setEditingCat(editingCat === c.id ? null : c.id)}
                onRevert={() => actions.revertOverride(check.id, c.id)} />
              {editingCat === c.id && (
                <RecurrenceEditor categoryName={c.name} rule={rule} defaultFirstDue={check.payDate}
                  onSave={(fields) => { actions.setRecurring(c.id, fields); setEditingCat(null); }}
                  onRemove={() => { actions.removeRecurring(c.id); setEditingCat(null); }}
                  onClose={() => setEditingCat(null)} />
              )}
            </React.Fragment>
          );
        })}
```

Leave the `customCategories.map(...)` block below it unchanged.

- [ ] **Step 5: Verify in the preview — create a rule and see it land**

Restart the preview server (stop + start `ourobudget`) to force a clean load, then `preview_screenshot`. Then drive it:
1. `preview_eval` to set the selected check's income > 0 (e.g. set the "Income this check" field to `1000` as in prior sessions) so derived amounts show against income.
2. `preview_click`/`preview_eval` the ↻ on the "Food" row → editor opens.
3. Set preset "Monthly", amount `500`, first-due = the check's pay date, Save.
4. `preview_screenshot`: Food row shows `$500` with the ↻ in accent color; the breakdown reflects it.
5. Type a different number in Food on this check → `↺` appears (override); click `↺` → reverts to `$500`.
6. `preview_console_logs` (level `error`): none.

Capture a screenshot showing the recurring Food row + editor for the report.

- [ ] **Step 6: Commit**

```bash
git add app.jsx
git commit -m "feat: recurring-allocation UI (editor, badge, override/revert)"
```

---

## Task 8: Cache bump + full integration verification

**Files:**
- Modify: `sw.js` (L6)

- [ ] **Step 1: Bump the cache string**

Change `const CACHE = "ouro-pwa-v4";` to `const CACHE = "ouro-pwa-v5";`.

- [ ] **Step 2: Run the full test suite**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 3: Full preview smoke test**

Stop + start the `ourobudget` preview server. In the page, via `preview_eval`, clear caches + unregister SW + reload (as in prior sessions) so `lib.js`/`app.jsx` load fresh. Then verify end-to-end:
- Add a second check (`+ Add check`) and confirm a **monthly** recurring item lands on exactly one of the two checks (the covering one) and is `$0`/absent on the other.
- Confirm a **weekly** item shows ~2× on a biweekly check.
- Confirm removing the category deletes its recurrence with no console errors.
- `preview_console_logs` (level `error`): none. Capture a final screenshot.

- [ ] **Step 4: Commit**

```bash
git add sw.js
git commit -m "chore: bump service-worker cache to ouro-pwa-v5"
```

---

## Self-Review Notes

- **Spec coverage:** data model (`doc.recurring`, `recurringOverrides`) → Tasks 5–6; presets + custom + first-due + end date → Tasks 1–3 (math), 7 (UI); derivation math (window, occurrences, summing) → Tasks 1–4; overrides + revert → Tasks 3, 6, 7; edit/delete reflow → Tasks 6–7; category-removal pruning → Task 6; UX (↻ button, badge, editor, summary) → Task 7; migration v3 → Task 5; cache bump v5 → Task 8; tests → Tasks 1–5.
- **Types consistent:** `checkBudgeted(check, rules, windowEndIso)`, `computeBreakdown(check, categoryItems, rules, windowEndIso)`, `effectiveAllocation(check, categoryId, rules, windowEndIso)`, `checkWindowEnd(checks, check)`, `setRecurring(categoryId, {amount, freq:{unit,interval}, firstDue, endDate})` — used identically across tasks.
- **No placeholders:** every code step shows full code; every test step shows real assertions.
