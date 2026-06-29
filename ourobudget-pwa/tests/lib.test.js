const assert = require("assert");
const { num, DOC_VERSION, computeBreakdown, migrateDoc } = require("../lib.js");

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

// --- computeBreakdown: over budget ---
{
  const check = {
    income: 1000,
    allocations: { cat_a: 700 },
    customCategories: [{ id: "x", name: "Extra", amount: 500 }],
  };
  const cats = [{ id: "cat_a", name: "A" }];
  const b = computeBreakdown(check, cats);
  assert.strictEqual(b.budgeted, 1200);
  assert.strictEqual(b.over, 200, "over income by 200");
  assert.strictEqual(b.unallocated, null, "no unallocated when over budget");
  assert.strictEqual(b.segments[0].pct, 70, "700/1000 = 70%");
  assert.strictEqual(b.segments[1].pct, 50, "500/1000 = 50% (sums past 100)");
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
    checks: [{ id: "chk_1", income: 0, allocations: {}, repeat: false, customCategories: [] }],
  };
  const before = JSON.parse(JSON.stringify(doc.categories.items));
  const { doc: m, changed } = migrateDoc(doc);
  assert.deepStrictEqual(m.categories.items, before, "categories unchanged by migration");
  assert.strictEqual(changed, false, "already-current doc reports no change");
}

console.log("All lib.js tests passed.");
