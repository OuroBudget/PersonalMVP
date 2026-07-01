/* OuroBudget pure helpers — plain JS, no JSX, no browser-only globals.
   Loaded as a global <script> in the browser AND require()-able in Node for tests. */

function num(v) {
  var n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

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

function checkBudgeted(check, rules, windowEndIso) {
  var sum = 0;
  var allocs = (check && check.allocations) || {};
  Object.keys(allocs).forEach(function (catId) {
    sum += effectiveAllocation(check, catId, rules, windowEndIso);
  });
  return sum;
}

var DOC_VERSION = 4;

function computeBreakdown(check, categoryItems, rules, windowEndIso) {
  var income = num(check && check.income);
  var segments = [];
  var allocs = (check && check.allocations) || {};
  (categoryItems || []).forEach(function (c) {
    if (!Object.prototype.hasOwnProperty.call(allocs, c.id)) return;
    var amt = effectiveAllocation(check, c.id, rules, windowEndIso);
    if (amt > 0) segments.push({ name: c.name, amt: amt });
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

  if (!Array.isArray(doc.recurring)) { doc.recurring = []; changed = true; }

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
      if (!c.recurringOverrides || typeof c.recurringOverrides !== "object") { c.recurringOverrides = {}; changed = true; }
    });
  }

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

  if (doc.version !== DOC_VERSION) { doc.version = DOC_VERSION; changed = true; }

  return { doc: doc, changed: changed };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { num: num, DOC_VERSION: DOC_VERSION, computeBreakdown: computeBreakdown, migrateDoc: migrateDoc, stepDate: stepDate, countOccurrencesInWindow: countOccurrencesInWindow, recurringRuleFor: recurringRuleFor, effectiveAllocation: effectiveAllocation, checkBudgeted: checkBudgeted };
}
