# Unified Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse shared + custom categories into one global, recurrence-capable category type where presence on a check is "is the category id a key in that check's `allocations`," and removal offers per-check vs. everywhere.

**Architecture:** Pure math in `lib.js` gains a presence filter (a category shows/sums on a check only when its id keys that check's `allocations`) and drops all `customCategories` handling; `migrateDoc` promotes existing custom categories into the global list (v4). `app.jsx` renders only present categories, replaces the two-tier custom UI with global add + a per-row remove-confirm (this check / everywhere).

**Tech Stack:** React + Tailwind + in-browser Babel (no build step). Pure helpers in `lib.js` (browser global + Node `require`). Node `assert` tests in `tests/lib.test.js`. IndexedDB storage. Service worker `sw.js` cache-first.

## Global Constraints

- No build step, no bundler, no new dependencies. Logic lives in `lib.js` (pure) and `app.jsx` (React).
- `lib.js` stays dual-environment: top-level `function`/`var` + the `if (typeof module !== "undefined" && module.exports)` guard. No `import`/`export`. No browser/app globals (no `money`, `prettyDate`, `document`, `window`) — only `num`, other `lib.js` helpers, standard JS/`Date`.
- Dates are ISO `YYYY-MM-DD`; parse with `new Date(iso + "T00:00:00")`.
- `DOC_VERSION` becomes `4`. Migration is non-destructive and idempotent.
- **Presence rule:** a category shows/sums on a check iff its id is a key in `check.allocations`.
- `customCategories` is removed from the app model, the seed, and all reads. `migrateDoc` retains it only to promote and clear old data.
- Test runner (Bash tool): `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js` — expected final line `All lib.js tests passed.`
- Bump `sw.js` `CACHE` to `ouro-pwa-v6` as the final step.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

- **Modify `lib.js`** — `computeBreakdown` (presence filter, drop custom loop), `checkBudgeted` (drop custom sum), `migrateDoc` (v4 promotion), bump `DOC_VERSION`.
- **Modify `tests/lib.test.js`** — rewrite the two custom-category tests to the presence model, update the migrate-version test to v4, add presence + v4-promotion tests.
- **Modify `app.jsx`** — `BudgetSection` render (present-only + global add), `BudgetRow` (remove-confirm), actions (`addCategory`, `removeCategoryHere`, `removeCategoryEverywhere`; retire `addCustom`/`updateCustom`/`removeCustom`; rename `removeCategory`), `buildSeed` + `addCheck` (drop `customCategories`).
- **Modify `sw.js`** — cache bump.

---

## Task 1: `lib.js` presence model — `computeBreakdown` + `checkBudgeted`

**Files:**
- Modify: `lib.js` (`computeBreakdown` ~L89-99; `checkBudgeted` ~L77-85)
- Test: `tests/lib.test.js`

**Interfaces:**
- Consumes: `effectiveAllocation`, `num` (existing).
- Produces (same signatures, changed behavior):
  - `checkBudgeted(check, rules, windowEndIso)` — sum of `effectiveAllocation` over `Object.keys(check.allocations)` only. No `customCategories`.
  - `computeBreakdown(check, categoryItems, rules, windowEndIso)` — a shared category contributes a segment only when `c.id` is a key in `check.allocations` AND its effective amount > 0. No `customCategories` segments.

- [ ] **Step 1: Rewrite the two custom-dependent tests and add presence tests**

In `tests/lib.test.js`, **replace** the entire "computeBreakdown: over budget" block (currently lines 25-39, from `// --- computeBreakdown: over budget ---` through its closing `}`) with this two-shared-category version:

```js
// --- computeBreakdown: over budget (two present shared categories) ---
{
  const check = {
    income: 1000,
    allocations: { cat_a: 700, cat_b: 500 },
  };
  const cats = [{ id: "cat_a", name: "A" }, { id: "cat_b", name: "B" }];
  const b = computeBreakdown(check, cats);
  assert.strictEqual(b.budgeted, 1200);
  assert.strictEqual(b.over, 200, "over income by 200");
  assert.strictEqual(b.unallocated, null, "no unallocated when over budget");
  assert.strictEqual(b.segments[0].pct, 70, "700/1000 = 70%");
  assert.strictEqual(b.segments[1].pct, 50, "500/1000 = 50% (sums past 100)");
}

// --- computeBreakdown: a category in the list but absent from allocations is hidden (presence) ---
{
  const check = { income: 1000, allocations: { cat_a: 200 }, recurringOverrides: {} };
  const cats = [{ id: "cat_a", name: "A" }, { id: "cat_b", name: "B" }];
  const b = computeBreakdown(check, cats);
  assert.strictEqual(b.segments.length, 1, "only the present category is shown");
  assert.strictEqual(b.segments[0].name, "A", "absent cat_b is not a segment");
}

// --- computeBreakdown: a recurring category removed from a check (absent key) stays hidden ---
{
  const rules2 = [{ id: "r", categoryId: "cat_b", amount: 100,
    firstDue: "2026-01-01", endDate: null, freq: { unit: "week", interval: 1 } }];
  const check = { payDate: "2026-01-01", income: 1000, allocations: { cat_a: 200 }, recurringOverrides: {} };
  const cats = [{ id: "cat_a", name: "A" }, { id: "cat_b", name: "B" }];
  const b = computeBreakdown(check, cats, rules2, "2026-01-15");
  assert.ok(!b.segments.some((s) => s.name === "B"), "removed (absent) recurring category stays hidden");
}
```

Then **replace** the "checkBudgeted with rules" block (currently lines 141-149, from `// --- checkBudgeted with rules ---` through the `assert.strictEqual(checkBudgeted(...` line) with this custom-free version plus a presence assertion:

```js
// --- checkBudgeted with rules (present categories only) ---
var cbRules = [{ id: "rec_f", categoryId: "cat_food", amount: 100,
  firstDue: "2026-01-01", endDate: null, freq: { unit: "week", interval: 1 } }];
var cbCheck = { payDate: "2026-01-01",
  allocations: { cat_food: 999, cat_gas: 25 },
  recurringOverrides: {} };
// food derived: weekly $100 x2 = 200; gas 25 => 225
assert.strictEqual(checkBudgeted(cbCheck, cbRules, "2026-01-15"), 225, "budgeted sums present categories (derived + stored)");
// a rule for a category NOT keyed in allocations does not add to the total
var pbCheck = { payDate: "2026-01-01", allocations: { cat_gas: 25 }, recurringOverrides: {} };
assert.strictEqual(checkBudgeted(pbCheck, cbRules, "2026-01-15"), 25, "absent recurring category is not budgeted");
```

(The "computeBreakdown with rules" block just below it already passes `customCategories: []` and keeps both categories keyed in `allocations`, so it stays valid — leave it unchanged.)

- [ ] **Step 2: Run tests to verify the rewritten ones fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — the new "over budget" still passes only if custom logic is gone; before the impl change, the presence tests fail (e.g. "only the present category is shown" — currently cat_b with no allocation yields amt 0 and is already skipped, but the recurring-absent test fails because a rule for absent `cat_b` currently derives $100 and shows a "B" segment). Confirm at least the "removed (absent) recurring category stays hidden" assertion fails.

- [ ] **Step 3: Add the presence filter to `computeBreakdown`**

In `lib.js`, replace the shared-category loop and the customCategories loop:

```js
  (categoryItems || []).forEach(function (c) {
    var amt = effectiveAllocation(check, c.id, rules, windowEndIso);
    if (amt > 0) segments.push({ name: c.name, amt: amt });
  });
  (((check && check.customCategories) || [])).forEach(function (c) {
    var amt = num(c.amount);
    if (amt > 0) segments.push({ name: c.name || "Other", amt: amt });
  });
```

with (presence filter; custom loop deleted):

```js
  var allocs = (check && check.allocations) || {};
  (categoryItems || []).forEach(function (c) {
    if (!Object.prototype.hasOwnProperty.call(allocs, c.id)) return;
    var amt = effectiveAllocation(check, c.id, rules, windowEndIso);
    if (amt > 0) segments.push({ name: c.name, amt: amt });
  });
```

- [ ] **Step 4: Drop the customCategories sum from `checkBudgeted`**

In `lib.js`, remove this line from `checkBudgeted`:

```js
  ((check && check.customCategories) || []).forEach(function (c) { sum += num(c.amount); });
```

so the function body is:

```js
function checkBudgeted(check, rules, windowEndIso) {
  var sum = 0;
  var allocs = (check && check.allocations) || {};
  Object.keys(allocs).forEach(function (catId) {
    sum += effectiveAllocation(check, catId, rules, windowEndIso);
  });
  return sum;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: category presence via allocations keys; drop customCategories from math"
```

---

## Task 2: `migrateDoc` v4 — promote custom categories into the global list

**Files:**
- Modify: `lib.js` (`DOC_VERSION` ~L87; `migrateDoc` ~L135-165)
- Test: `tests/lib.test.js`

**Interfaces:**
- Produces: `migrateDoc(doc)` also promotes each check's `customCategories` entries into `doc.categories.items` (by id) and sets that check's `allocations[id] = num(amount)`, then clears `customCategories = []`. `DOC_VERSION` is `4`.

- [ ] **Step 1: Update the version test and add a v4-promotion test**

In `tests/lib.test.js`, in the "migrateDoc v3" block, change the two hardcoded `3`s:

```js
assert.strictEqual(mig.doc.version, 3, "version bumped to 3");
assert.strictEqual(DOC_VERSION, 3, "DOC_VERSION is 3");
```

to:

```js
assert.strictEqual(mig.doc.version, 4, "version bumped to 4");
assert.strictEqual(DOC_VERSION, 4, "DOC_VERSION is 4");
```

Then add, before the final `console.log(...)`:

```js
// --- migrateDoc v4: promote custom categories into the global list (presence preserved) ---
{
  const doc = {
    version: 3, budgetTitle: "", recurring: [],
    categories: { items: [{ id: "cat_food", name: "Food" }] },
    accounts: [],
    checks: [
      { id: "chk_1", allocations: { cat_food: 100 }, repeat: false, recurringOverrides: {},
        customCategories: [{ id: "cust_x", name: "Vacation", amount: 40 }] },
      { id: "chk_2", allocations: { cat_food: 0 }, repeat: false, recurringOverrides: {},
        customCategories: [] },
    ],
  };
  const { doc: m, changed } = migrateDoc(doc);
  assert.strictEqual(changed, true, "promotion reports change");
  assert.ok(m.categories.items.some((c) => c.id === "cust_x" && c.name === "Vacation"),
    "custom promoted into the global list");
  assert.strictEqual(m.checks[0].allocations.cust_x, 40, "promoted amount set on its own check");
  assert.ok(!("cust_x" in m.checks[1].allocations),
    "promoted category is absent from other checks (placement preserved)");
  assert.deepStrictEqual(m.checks[0].customCategories, [], "customCategories cleared after promotion");
  assert.strictEqual(m.version, 4, "version is 4");
  const again = migrateDoc(m);
  assert.strictEqual(again.changed, false, "second v4 migration is a no-op");
}
```

Note: the existing "already-current" fixture (the `budgetTitle: "My Budget"` block) uses `version: DOC_VERSION` and already has `customCategories: []`, so it will still report `changed === false` under v4 — do NOT modify it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: FAIL — `DOC_VERSION is 4` (still 3) and the promotion assertions fail.

- [ ] **Step 3: Bump `DOC_VERSION`**

In `lib.js`, change `var DOC_VERSION = 3;` to `var DOC_VERSION = 4;`.

- [ ] **Step 4: Add the promotion block to `migrateDoc`**

In `lib.js`, immediately AFTER the existing `doc.checks.forEach(...)` loop (the one that defaults `repeat`/`allocations`/`customCategories`/`recurringOverrides`) and BEFORE the `if (doc.version !== DOC_VERSION)` line, insert:

```js
  // v4: promote per-check custom categories into the global list.
  // Presence is "id is a key in the check's allocations", so a promoted
  // category shows only on the check it came from.
  if (Array.isArray(doc.checks) && doc.categories && Array.isArray(doc.categories.items)) {
    doc.checks.forEach(function (c) {
      if (!Array.isArray(c.customCategories) || c.customCategories.length === 0) return;
      c.customCategories.forEach(function (cc) {
        if (!cc || !cc.id) return;
        if (!doc.categories.items.some(function (it) { return it.id === cc.id; })) {
          doc.categories.items.push({ id: cc.id, name: cc.name || "Other" });
        }
        if (!c.allocations || typeof c.allocations !== "object") c.allocations = {};
        c.allocations[cc.id] = num(cc.amount);
      });
      c.customCategories = [];
      changed = true;
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 6: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: migrate docs to v4, promoting custom categories to the global list"
```

---

## Task 3: `app.jsx` — unify category UI (present-only render, global add, remove-confirm)

**Files:**
- Modify: `app.jsx` — `buildSeed` (~L44-60), `BudgetRow` (~L366-391), `BudgetSection` category block (~L454-493), actions (`removeCategory` ~L795-811, add new actions, `addCheck` ~L853-867, retire `addCustom`/`updateCustom`/`removeCustom` ~L874-876)

**Interfaces:**
- Consumes: lib globals `recurringRuleFor`, `effectiveAllocation`, `checkWindowEnd`; existing actions `renameCategory`, `setAllocation`, `setOverride`, `revertOverride`, `setRecurring`, `removeRecurring`.
- Produces (app-internal actions): `addCategory(name)`, `removeCategoryHere(checkId, catId)`, `removeCategoryEverywhere(catId)`.

No automated test (React-in-browser); the controller runs browser verification after review. Do NOT start/drive the preview server.

- [ ] **Step 1: Drop `customCategories` from the seed**

In `buildSeed`, remove `customCategories: [],` from the seeded check object (leave `allocations: alloc()`, `repeat`, `recurringOverrides: {}`, etc.).

- [ ] **Step 2: Drop `customCategories` from `addCheck`**

In the `addCheck` action, change the pushed check object's line
`allocations: alloc, customCategories: [], repeat: inherit,`
to
`allocations: alloc, recurringOverrides: {}, repeat: inherit,`
(If `recurringOverrides: {}` is already present elsewhere in that object, do not duplicate it — ensure the pushed check has `allocations`, `recurringOverrides: {}`, `repeat`, and no `customCategories`.)

- [ ] **Step 3: Replace `BudgetRow` with a per-row remove-confirm**

Replace the whole `BudgetRow` function with:

```js
function BudgetRow({ label, renamable, onRename, amount, onAmount, onRemoveHere, onRemoveEverywhere, rule, overridden, onOpenRecurrence, onRevert }) {
  const [confirming, setConfirming] = useState(false);
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
      {(onRemoveHere || onRemoveEverywhere) && (
        confirming ? (
          <span className="flex items-center gap-1 text-xs">
            <button onClick={() => { onRemoveHere(); setConfirming(false); }}
              className="rounded-full px-2 py-0.5 border border-brand-border text-brand-text2 hover:border-brand-accent">This check</button>
            <button onClick={() => { onRemoveEverywhere(); setConfirming(false); }}
              className="rounded-full px-2 py-0.5 border border-brand-border text-brand-danger hover:border-brand-danger">Everywhere</button>
            <button onClick={() => setConfirming(false)} title="Cancel"
              className="text-brand-muted hover:text-brand-text text-sm leading-none px-1">×</button>
          </span>
        ) : (
          <button onClick={() => setConfirming(true)}
            className="text-brand-muted hover:text-brand-accentd text-lg leading-none px-1" title="Remove">×</button>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 4: Render present categories only, drop the custom block, wire global add**

In `BudgetSection`, replace the entire category-list `<div className="mt-3"> ... </div>` block (the one containing both `doc.categories.items.map(...)` and `(check.customCategories || []).map(...)`) with:

```js
      <div className="mt-3">
        {doc.categories.items.filter((c) => c.id in (check.allocations || {})).map((c) => {
          const rule = recurringRuleFor(doc.recurring, c.id);
          const overridden = !!(rule && check.recurringOverrides && (c.id in check.recurringOverrides));
          const amt = effectiveAllocation(check, c.id, doc.recurring, windowEnd);
          return (
            <React.Fragment key={c.id}>
              <BudgetRow label={c.name} renamable
                onRename={(name) => actions.renameCategory(c.id, name)}
                amount={amt}
                onAmount={(v) => rule ? actions.setOverride(check.id, c.id, v) : actions.setAllocation(check.id, c.id, v)}
                onRemoveHere={() => actions.removeCategoryHere(check.id, c.id)}
                onRemoveEverywhere={() => actions.removeCategoryEverywhere(c.id)}
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
      </div>
```

Then change the "+ Add category" button's handler from
`onClick={() => { actions.addCustom(check.id, newCat.trim() || "Other"); setNewCat(""); }}`
to
`onClick={() => { actions.addCategory(newCat.trim() || "Other"); setNewCat(""); }}`.

- [ ] **Step 5: Rework the category actions**

In the `actions` object: **rename** `removeCategory` to `removeCategoryEverywhere` (keep its body — it already prunes `categories.items`, `d.recurring`, and each check's `allocations` + `recurringOverrides`). Then **add** these two actions next to it:

```js
    addCategory: (name) => mutate((d) => {
      const id = uid("cat");
      d.categories = { updatedAt: nowIso(), items: [...d.categories.items, { id, name }] };
      d.checks = d.checks.map((c) => ({ ...c, allocations: { ...c.allocations, [id]: 0 }, updatedAt: nowIso() }));
      return d;
    }),
    removeCategoryHere: (checkId, catId) => mutate((d) => {
      d.checks = d.checks.map((c) => {
        if (c.id !== checkId) return c;
        let next = c;
        if (c.allocations && catId in c.allocations) {
          const a = { ...c.allocations }; delete a[catId];
          next = { ...next, allocations: a };
        }
        if (c.recurringOverrides && catId in c.recurringOverrides) {
          const o = { ...next.recurringOverrides }; delete o[catId];
          next = { ...next, recurringOverrides: o };
        }
        return { ...next, updatedAt: nowIso() };
      });
      return d;
    }),
```

Finally, **delete** the now-unused `addCustom`, `updateCustom`, and `removeCustom` actions.

- [ ] **Step 6: Confirm no stale references remain**

Search `app.jsx` for leftover references and confirm ZERO remain:

Run: `grep -nE "customCategories|addCustom|updateCustom|removeCustom|actions\.removeCategory\b" "app.jsx"`
Expected: no output (all custom-category handling and the old `removeCategory` name are gone from `app.jsx`).

- [ ] **Step 7: Sanity-check the lib suite still passes (require graph intact)**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.` (You did not edit `lib.js` here; this just confirms nothing broke.)

- [ ] **Step 8: Commit**

```bash
git add app.jsx
git commit -m "feat: unify categories in UI (global add, present-only render, per-check vs everywhere removal)"
```

---

## Task 4: Cache bump + full integration verification

**Files:**
- Modify: `sw.js` (L6)

- [ ] **Step 1: Bump the cache string**

Change `const CACHE = "ouro-pwa-v5";` to `const CACHE = "ouro-pwa-v6";` (change only the version).

- [ ] **Step 2: Run the full lib suite**

Run: `export PATH="/c/Program Files/nodejs:$PATH" && node tests/lib.test.js`
Expected: PASS — `All lib.js tests passed.`

- [ ] **Step 3: Commit**

```bash
git add sw.js
git commit -m "chore: bump service-worker cache to ouro-pwa-v6"
```

- [ ] **Step 4: Controller browser verification (performed by the controller, not the implementer)**

Stop + start the `ourobudget` preview; clear caches + unregister SW + reload so fresh `lib.js`/`app.jsx` load. Then confirm:
- Existing custom "Food" migrated to a global category (present on its original check, with a ↻).
- `+ Add category` → new category shows on ALL checks with a ↻.
- `×` → inline **[This check] · [Everywhere] · cancel**; "This check" removes only here (present + recurrence intact on other checks); "Everywhere" removes from all checks and prunes the recurrence.
- A recurrence on a freshly-added category derives correctly.
- No console errors.

---

## Self-Review Notes

- **Spec coverage:** unified global list + presence rule → Tasks 1, 3; drop customCategories → Tasks 1, 3; migration v4 promotion → Task 2; global add → Task 3; per-check vs everywhere removal → Task 3; test rewrites (over-budget, checkBudgeted, migrate-version) → Tasks 1-2; cache v6 → Task 4.
- **Types consistent:** `checkBudgeted(check, rules, windowEndIso)`, `computeBreakdown(check, categoryItems, rules, windowEndIso)`, `effectiveAllocation(check, categoryId, rules, windowEndIso)`, `addCategory(name)`, `removeCategoryHere(checkId, catId)`, `removeCategoryEverywhere(catId)` — used identically across tasks.
- **No placeholders:** every code step shows full code; every test step shows real assertions.
