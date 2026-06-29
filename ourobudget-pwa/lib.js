/* OuroBudget pure helpers — plain JS, no JSX, no browser-only globals.
   Loaded as a global <script> in the browser AND require()-able in Node for tests. */

function num(v) {
  var n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

var DOC_VERSION = 2;

function computeBreakdown(check, categoryItems) {
  var income = num(check && check.income);
  var segments = [];
  (categoryItems || []).forEach(function (c) {
    var amt = num(((check && check.allocations) || {})[c.id]);
    if (amt > 0) segments.push({ name: c.name, amt: amt });
  });
  (((check && check.customCategories) || [])).forEach(function (c) {
    var amt = num(c.amount);
    if (amt > 0) segments.push({ name: c.name || "Other", amt: amt });
  });

  var budgeted = segments.reduce(function (s, x) { return s + x.amt; }, 0);
  var empty = budgeted <= 0;
  var incomeZeroFallback = income <= 0 && budgeted > 0;
  var pctBase = incomeZeroFallback ? budgeted : income;
  var barDenom = Math.max(income, budgeted) || 1; // budgeted > 0 whenever rendered
  var leftover = income - budgeted;

  segments.forEach(function (s) {
    s.pct = pctBase > 0 ? Math.round((s.amt / pctBase) * 100) : 0;
    s.width = (s.amt / barDenom) * 100;
  });

  var unallocated = null;
  if (income > 0 && leftover > 0) {
    unallocated = {
      amt: leftover,
      pct: Math.round((leftover / income) * 100),
      width: (leftover / barDenom) * 100,
    };
  }
  var over = (income > 0 && budgeted > income) ? budgeted - income : 0;

  return {
    income: income,
    budgeted: budgeted,
    leftover: leftover,
    segments: segments,
    unallocated: unallocated,
    over: over,
    incomeZeroFallback: incomeZeroFallback,
    empty: empty,
  };
}

function migrateDoc(doc) {
  if (!doc || typeof doc !== "object") return { doc: doc, changed: false };
  var changed = false;

  if (typeof doc.budgetTitle !== "string") { doc.budgetTitle = ""; changed = true; }

  if (!doc.categories || !Array.isArray(doc.categories.items)) {
    doc.categories = {
      updatedAt: (doc.categories && doc.categories.updatedAt) || "",
      items: [],
    };
    changed = true;
  }
  // NOTE: categories.items contents are intentionally left untouched —
  // user renames/removals always win; defaults are seeded only on first run.

  if (Array.isArray(doc.checks)) {
    doc.checks.forEach(function (c) {
      if (typeof c.repeat !== "boolean") { c.repeat = false; changed = true; }
      if (!c.allocations || typeof c.allocations !== "object") { c.allocations = {}; changed = true; }
      if (!Array.isArray(c.customCategories)) { c.customCategories = []; changed = true; }
    });
  }

  if (doc.version !== DOC_VERSION) { doc.version = DOC_VERSION; changed = true; }

  return { doc: doc, changed: changed };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { num: num, DOC_VERSION: DOC_VERSION, computeBreakdown: computeBreakdown, migrateDoc: migrateDoc };
}
