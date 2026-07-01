const assert = require("assert");
const { num, DOC_VERSION, computeBreakdown, migrateDoc, stepDate, countOccurrencesInWindow, recurringRuleFor, effectiveAllocation, checkBudgeted } = require("../lib.js");

// --- num ---
assert.strictEqual(num("12.5"), 12.5, "num parses decimals");
assert.strictEqual(num("abc"), 0, "num falls back to 0");
assert.strictEqual(num(undefined), 0, "num handles undefined");

// --- computeBreakdown: normal, income partly allocated ---
{
  const check = { income: 1000, allocations: { cat_food: 250 }, customCategories: [] };
  const cats = [{ id: "cat_food", name: "Food" }];
  const b = computeBreakdown(check, cats);
  assert.strictEqual(b.empty, false, "not empty");
  assert.strictEqual(b.income, 1000);
  assert.strictEqual(b.budgeted, 250);
  assert.strictEqual(b.segments.length, 1);
  assert.strictEqual(b.segments[0].pct, 25, "250 is 25% of 1000 income");
  assert.ok(b.unallocated, "has unallocated remainder");
  assert.strictEqual(b.unallocated.pct, 75, "leftover 750 is 75% of income");
  assert.strictEqual(b.over, 0, "not over budget");
  assert.strictEqual(b.incomeZeroFallback, false);
}

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

// --- computeBreakdown: income zero, fallback to share of budgeted ---
{
  const check = { income: 0, allocations: { cat_a: 300 }, customCategories: [] };
  const cats = [{ id: "cat_a", name: "A" }];
  const b = computeBreakdown(check, cats);
  assert.strictEqual(b.incomeZeroFallback, true);
  assert.strictEqual(b.segments[0].pct, 100, "100% of budgeted when income is 0");
  assert.strictEqual(b.unallocated, null);
  assert.strictEqual(b.over, 0, "no over-budget line in the zero-income fallback state");
}

// --- computeBreakdown: nothing budgeted -> empty ---
{
  const b = computeBreakdown({ income: 500, allocations: {}, customCategories: [] }, []);
  assert.strictEqual(b.empty, true, "empty when nothing budgeted");
}

// --- migrateDoc: adds missing fields ---
{
  const doc = {
    categories: { items: [{ id: "cat_food", name: "Food" }] },
    accounts: [],
    checks: [{ id: "chk_1", income: 0, allocations: {} }],
  };
  const { doc: m, changed } = migrateDoc(doc);
  assert.strictEqual(changed, true, "changed because fields were missing");
  assert.strictEqual(m.budgetTitle, "", "budgetTitle defaulted to empty string");
  assert.strictEqual(m.version, DOC_VERSION, "version bumped");
  assert.strictEqual(m.checks[0].repeat, false, "repeat defaulted to false");
  assert.deepStrictEqual(m.checks[0].customCategories, [], "customCategories defaulted to []");
}

// --- migrateDoc: categories present but items missing -> rebuilt, updatedAt preserved ---
{
  const doc = { categories: { updatedAt: "x" }, accounts: [], checks: [] };
  const { doc: m, changed } = migrateDoc(doc);
  assert.deepStrictEqual(m.categories.items, [], "items rebuilt to empty array");
  assert.strictEqual(m.categories.updatedAt, "x", "existing updatedAt preserved");
  assert.strictEqual(changed, true, "reports changed");
}

// --- migrateDoc: user categories are never touched (precedence) ---
{
  const doc = {
    budgetTitle: "My Budget",
    version: DOC_VERSION,
    categories: { items: [{ id: "cat_food", name: "Groceries" }] }, // renamed default
    accounts: [],
    recurring: [],
    checks: [{ id: "chk_1", income: 0, allocations: {}, repeat: false, customCategories: [], recurringOverrides: {} }],
  };
  const before = JSON.parse(JSON.stringify(doc.categories.items));
  const { doc: m, changed } = migrateDoc(doc);
  assert.deepStrictEqual(m.categories.items, before, "categories unchanged by migration");
  assert.strictEqual(changed, false, "already-current doc reports no change");
}

// --- stepDate ---
assert.strictEqual(stepDate("2026-01-15", "day", 14), "2026-01-29", "day step");
assert.strictEqual(stepDate("2026-01-01", "week", 2), "2026-01-15", "week step");
assert.strictEqual(stepDate("2026-01-31", "month", 1), "2026-02-28", "month-end clamp");
assert.strictEqual(stepDate("2026-03-31", "month", 1), "2026-04-30", "month-end clamp 30");
assert.strictEqual(stepDate("2026-01-15", "month", 3), "2026-04-15", "quarter step");
assert.strictEqual(stepDate("2024-02-29", "year", 1), "2025-02-28", "leap-year clamp");
assert.strictEqual(stepDate("2026-06-01", "year", 1), "2027-06-01", "year step");

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

// --- computeBreakdown with rules ---
var bd = computeBreakdown(
  { payDate: "2026-01-01", income: 500, allocations: { cat_food: 999, cat_gas: 25 },
    customCategories: [], recurringOverrides: {} },
  [{ id: "cat_food", name: "Food" }, { id: "cat_gas", name: "Gas" }],
  cbRules, "2026-01-15");
var foodSeg = bd.segments.find(function (s) { return s.name === "Food"; });
assert.strictEqual(foodSeg.amt, 200, "breakdown food segment uses derived amount");
assert.strictEqual(bd.budgeted, 225, "breakdown budgeted = 200 + 25");

// --- migrateDoc v3 ---
var pre = { version: 2, budgetTitle: "", categories: { items: [] },
  accounts: [], checks: [{ id: "chk_1", allocations: {}, customCategories: [], repeat: false }] };
var mig = migrateDoc(pre);
assert.strictEqual(mig.changed, true, "migration reports change");
assert.ok(Array.isArray(mig.doc.recurring), "recurring array added");
assert.deepStrictEqual(mig.doc.checks[0].recurringOverrides, {}, "recurringOverrides added");
assert.strictEqual(mig.doc.version, 4, "version bumped to 4");
assert.strictEqual(DOC_VERSION, 4, "DOC_VERSION is 4");
// idempotent
var again = migrateDoc(mig.doc);
assert.strictEqual(again.changed, false, "second migration is a no-op");

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

console.log("All lib.js tests passed.");
