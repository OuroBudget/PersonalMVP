# OuroBudget Customization & Update Notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable budget title, income-based breakdown math, repeatable paychecks, fully removable categories, and an automatic "new version available" update flow with non-destructive data migration to the OuroBudget PWA.

**Architecture:** The app is a single-file React app (`app.jsx`) transformed in-browser by Babel, with an offline service worker (`sw.js`) and a static shell (`index.html`). Nontrivial *pure* logic (breakdown math, doc migration) is extracted into a new plain-JS `lib.js` that loads as a global script in the browser and is `require`-able in Node for unit tests. UI, service-worker, and registration wiring are verified manually in a browser.

**Tech Stack:** Plain ES (no transpile) for `lib.js`, React 18 (vendored) + Babel-in-browser for `app.jsx`, Cache Storage + service worker for offline, IndexedDB for data. Node's built-in `assert` for the only automated tests.

## Global Constraints

- **No build step / no bundler.** New browser code is plain `<script>`-loadable JS or Babel-in-browser JSX. (verbatim spec intent)
- **No new runtime dependencies, no CDN, no network calls.** Vendored libs only. Node is used solely as a local test runner for `lib.js`.
- **All paths relative** so the app works at a domain root or sub-path.
- **All data stays in IndexedDB**; migration only *adds* fields, never deletes/rewrites user content.
- **Exact copy strings (use verbatim):**
  - Budget title placeholder: `Budget`
  - Breakdown heading: `Where your money is going:`
  - Repeat toggle label: `Repeat this amount for new checks`
  - Over-budget line: `Over income by ` + amount
  - Income-zero fallback note: `Set this check's income to see each category as a share of income.`
  - Update banner text: `A new version is available.`
  - Service worker cache name: `ouro-pwa-v3`
- **Category precedence:** migration never re-adds or renames a user's categories; defaults are seeded only on first run.
- **Local manual-test server:** `python -m http.server 8000` then open `http://localhost:8000` (service workers are allowed on `localhost` without HTTPS).

---

## Task 0: Initialize git (recommended, optional)

This repo is not currently under version control, so the `git commit` steps below need a repo. If the user declines git, skip every "Commit" step in this plan.

**Files:** none (repo metadata)

- [ ] **Step 1: Initialize and make a baseline commit**

```bash
cd "C:/Users/gying/OneDrive - Radford University/Desktop/Business/Product/Dev/ourobudget-pwa"
git init
git add -A
git commit -m "chore: baseline before customization changes"
```

Expected: a new repo with one commit. If the user does not want git, do not run this and ignore later commit steps.

---

## Task 1: Pure logic module `lib.js` (breakdown math + migration) with Node tests

**Files:**
- Create: `lib.js`
- Create: `tests/lib.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (globals in browser, `module.exports` in Node):
  - `num(v) -> number` — parseFloat with finite guard, else 0.
  - `DOC_VERSION = 2` (number).
  - `computeBreakdown(check, categoryItems) -> { income, budgeted, leftover, segments, unallocated, over, incomeZeroFallback, empty }` where:
    - `segments`: array of `{ name, amt, pct, width }` (only amounts > 0; `pct` is share of income—or of budgeted when income ≤ 0; `width` is percent of `barDenom`).
    - `unallocated`: `{ amt, pct, width }` or `null` (present only when `income > 0` and `leftover > 0`).
    - `over`: number (`budgeted - income` when positive, else 0).
    - `incomeZeroFallback`: boolean (`income <= 0 && budgeted > 0`).
    - `empty`: boolean (`budgeted <= 0`).
  - `migrateDoc(doc) -> { doc, changed }` — non-destructive in-place forward migration; `changed` true if any field was added/updated.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib.test.js`:

```js
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
  assert.ok(Number.isFinite(b.segments[0].pct), "no NaN/Infinity");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/lib.test.js`
Expected: FAIL — `Cannot find module '../lib.js'` (file does not exist yet).

- [ ] **Step 3: Implement `lib.js`**

Create `lib.js`:

```js
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
  var over = budgeted > income ? budgeted - income : 0;

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/lib.test.js`
Expected: PASS — prints `All lib.js tests passed.`

- [ ] **Step 5: Commit**

```bash
git add lib.js tests/lib.test.js
git commit -m "feat: add lib.js pure helpers (breakdown math + doc migration) with node tests"
```

---

## Task 2: Load `lib.js` in the shell, cache it, drop app.jsx's duplicate `num`

**Files:**
- Modify: `index.html` (add script tag before `app.jsx`)
- Modify: `sw.js:6` (CACHE name) and `sw.js:8-23` (SHELL list)
- Modify: `app.jsx:15` (remove local `num`, now provided globally by `lib.js`)

**Interfaces:**
- Consumes: globals `num`, `DOC_VERSION`, `computeBreakdown`, `migrateDoc` from Task 1.
- Produces: those globals available to `app.jsx` at runtime; `lib.js` cached offline.

- [ ] **Step 1: Add `lib.js` before the Babel app script in `index.html`**

In `index.html`, find (line 63):

```html
  <script type="text/babel" data-presets="react" src="app.jsx"></script>
```

Replace with (plain `lib.js` loads and defines globals before Babel runs `app.jsx`):

```html
  <script src="lib.js"></script>
  <script type="text/babel" data-presets="react" src="app.jsx"></script>
```

- [ ] **Step 2: Bump the cache name and add `lib.js` to the shell in `sw.js`**

In `sw.js`, change line 6:

```js
const CACHE = "ouro-pwa-v2";
```

to:

```js
const CACHE = "ouro-pwa-v3";
```

Then in the `SHELL` array (lines 8-23), add `"./lib.js"` right after `"./app.jsx"`:

```js
const SHELL = [
  "./",
  "./index.html",
  "./app.jsx",
  "./lib.js",
  "./manifest.webmanifest",
  "./assets/vendor/react.production.min.js",
  "./assets/vendor/react-dom.production.min.js",
  "./assets/vendor/babel.min.js",
  "./assets/vendor/tailwind.js",
  "./assets/logo-light.svg",
  "./assets/logo-dark.svg",
  "./assets/icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png",
];
```

- [ ] **Step 3: Remove the now-duplicate `num` from `app.jsx`**

In `app.jsx`, find line 15:

```js
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
```

Delete that line. `num` is now the global from `lib.js`. (Leave `nowIso`, `uid`, `usd`, `money` as they are.)

- [ ] **Step 4: Manual verification in the browser**

Run: `python -m http.server 8000` and open `http://localhost:8000`.
In DevTools Console, run:

```js
typeof computeBreakdown === "function" && typeof migrateDoc === "function" && typeof num === "function"
```

Expected: `true`. The app still renders normally (no `num is not defined` errors in console).

- [ ] **Step 5: Commit**

```bash
git add index.html sw.js app.jsx
git commit -m "build: load lib.js globally, cache it (ouro-pwa-v3), drop duplicate num"
```

---

## Task 3: Editable budget title (placeholder "Budget")

**Files:**
- Modify: `app.jsx` — `buildSeed()` (lines 41-60), `actions` object (around lines 602-625), `BudgetSection` heading (lines 281-284)

**Interfaces:**
- Consumes: `mutate`, `TextInput`, `DOC_VERSION` (global).
- Produces: `doc.budgetTitle` (string) and `actions.setBudgetTitle(name)`.

- [ ] **Step 1: Seed `budgetTitle` and current `version` in `buildSeed()`**

In `app.jsx` `buildSeed()`, find:

```js
  return {
    version: 1,
    categories: { updatedAt: ts, items: FIXED_CATEGORIES.map((c) => ({ ...c })) },
```

Replace with:

```js
  return {
    version: DOC_VERSION,
    budgetTitle: "",
    categories: { updatedAt: ts, items: FIXED_CATEGORIES.map((c) => ({ ...c })) },
```

- [ ] **Step 2: Add the `setBudgetTitle` action**

In the `actions` object, add this entry (e.g., right after the opening `const actions = {`):

```js
    setBudgetTitle: (name) => mutate((d) => { d.budgetTitle = name; return d; }),
```

- [ ] **Step 3: Replace the static heading with an editable field**

In `BudgetSection`, find:

```jsx
        <h2 className="text-lg font-medium tracking-tight">Bi-Weekly Budget</h2>
```

Replace with:

```jsx
        <TextInput value={doc.budgetTitle || ""} onChange={actions.setBudgetTitle}
          placeholder="Budget"
          className="text-lg font-medium tracking-tight text-brand-text min-w-0 flex-1" />
```

- [ ] **Step 4: Manual verification**

Reload `http://localhost:8000`. Expected:
- The budget heading is now an input showing placeholder **Budget** when empty.
- Type "Summer Budget", reload the page → the value persists.
- Click **⬇ Export backup** and confirm the downloaded JSON contains `"budgetTitle": "Summer Budget"`.

- [ ] **Step 5: Commit**

```bash
git add app.jsx
git commit -m "feat: editable budget title with 'Budget' placeholder"
```

---

## Task 4: Income-based "Where your money is going:" breakdown

**Files:**
- Modify: `app.jsx` — `BreakdownBar` component (lines 175-214)

**Interfaces:**
- Consumes: `computeBreakdown` (global), `money`, `SEG_COLORS`, `Card`, `Eyebrow`.
- Produces: rewritten `BreakdownBar` rendering income-based percentages, an "Unallocated" segment, an over-budget line, and a zero-income fallback note.

- [ ] **Step 1: Replace the `BreakdownBar` component body**

In `app.jsx`, replace the entire `BreakdownBar` function (lines 175-214) with:

```jsx
function BreakdownBar({ doc, check }) {
  const b = computeBreakdown(check, doc.categories.items);
  return (
    <Card className="p-4">
      <Eyebrow>Where your money is going:</Eyebrow>
      {b.empty ? (
        <div className="text-sm text-brand-muted py-3">
          Add some planned amounts below and your breakdown shows up here.
        </div>
      ) : (
        <>
          <div className="flex w-full h-3 rounded-full overflow-hidden my-3 bg-brand-bg">
            {b.segments.map((s, i) => (
              <div key={i} title={`${s.name}: ${money(s.amt)}`}
                style={{ width: `${s.width}%`, background: SEG_COLORS[i % SEG_COLORS.length] }} />
            ))}
            {b.unallocated && (
              <div title={`Unallocated: ${money(b.unallocated.amt)}`}
                style={{ width: `${b.unallocated.width}%`, background: "var(--border)" }} />
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mt-2">
            {b.segments.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SEG_COLORS[i % SEG_COLORS.length] }} />
                <span className="text-brand-text2 truncate">{s.name}</span>
                <span className="ml-auto tabular-nums text-brand-muted">{s.pct}%</span>
              </div>
            ))}
            {b.unallocated && (
              <div className="flex items-center gap-2 text-xs">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: "var(--border)" }} />
                <span className="text-brand-text2 truncate">Unallocated</span>
                <span className="ml-auto tabular-nums text-brand-muted">{b.unallocated.pct}%</span>
              </div>
            )}
          </div>
          {b.over > 0 && (
            <div className="text-xs text-brand-text2 mt-2">Over income by {money(b.over)}</div>
          )}
          {b.incomeZeroFallback && (
            <div className="text-xs text-brand-muted mt-2">
              Set this check's income to see each category as a share of income.
            </div>
          )}
        </>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Manual verification of the math**

Reload the app. On the selected check:
- Set **Income this check** to `1000` and **Food** to `250` → bar shows a filled segment + a lighter "Unallocated" segment; labels read **Food 25%** and **Unallocated 75%**.
- Add a custom category `500` and set another category to `700` (income still 1000) → a line reads **Over income by $200**; percentages sum past 100% (truthful).
- Set income to `0` with some amounts entered → no `NaN%`/`Infinity%`; the note **"Set this check's income to see each category as a share of income."** appears and percentages are shares of budgeted.
- Clear all amounts → the empty-state message returns.

- [ ] **Step 3: Commit**

```bash
git add app.jsx
git commit -m "feat: income-based breakdown with unallocated + over-budget states"
```

---

## Task 5: Repeatable paycheck amount

**Files:**
- Modify: `app.jsx` — `buildSeed()` checks (lines 49-58), `actions.addCheck` (lines 609-615), `BudgetSection` income area (after the grid, around line 320)

**Interfaces:**
- Consumes: `actions.updateCheck`, `num` (global), `addDays`, `uid`, `nowIso`.
- Produces: `check.repeat` (boolean) honored on add; a repeat checkbox in the UI.

- [ ] **Step 1: Seed `repeat: false` on the starter checks**

In `buildSeed()`, find the check object inside the `.map`:

```js
    checks: [0, 1, 2, 3].map((i) => ({
      id: `chk_${i + 1}`,
      label: `Check ${i + 1}`,
      payDate: addDays(start, BIWEEKLY_DAYS * i),
      income: 0,
      allocations: alloc(),
      customCategories: [],
      updatedAt: ts,
      deleted: false,
    })),
```

Add `repeat: false,` after `customCategories: [],`:

```js
    checks: [0, 1, 2, 3].map((i) => ({
      id: `chk_${i + 1}`,
      label: `Check ${i + 1}`,
      payDate: addDays(start, BIWEEKLY_DAYS * i),
      income: 0,
      allocations: alloc(),
      customCategories: [],
      repeat: false,
      updatedAt: ts,
      deleted: false,
    })),
```

- [ ] **Step 2: Inherit income from the latest check when it is repeatable**

Replace the `addCheck` action (lines 609-615) with:

```js
    addCheck: () => mutate((d) => {
      const live = d.checks.filter((c) => !c.deleted).sort((a, b) => a.payDate < b.payDate ? -1 : 1);
      const last = live.length ? live[live.length - 1] : null;
      const lastDate = last ? last.payDate : new Date().toISOString().slice(0, 10);
      const inherit = !!(last && last.repeat === true);
      const alloc = Object.fromEntries(d.categories.items.map((c) => [c.id, 0]));
      d.checks.push({
        id: uid("chk"), label: "Check",
        payDate: addDays(lastDate, BIWEEKLY_DAYS),
        income: inherit ? num(last.income) : 0,
        allocations: alloc, customCategories: [], repeat: inherit,
        updatedAt: nowIso(), deleted: false,
      });
      return d;
    }),
```

- [ ] **Step 3: Add the repeat toggle under the income field**

In `BudgetSection`, find the closing `</div>` of the pay-date/income grid (the `</div>` on line 320, immediately before `<div className="mt-3">`). Insert the toggle just after that closing `</div>`:

```jsx
      <label className="flex items-center gap-2 mt-2 text-sm text-brand-text2 select-none">
        <input type="checkbox" checked={check.repeat === true}
          onChange={(e) => actions.updateCheck(check.id, { repeat: e.target.checked })}
          className="accent-brand-accent" />
        Repeat this amount for new checks
      </label>
```

- [ ] **Step 4: Manual verification**

Reload the app.
- On the selected check, set income to `1500`, tick **Repeat this amount for new checks**, then click **+ Add check** → the new check pre-fills income `1500.00` and its repeat box is already ticked.
- Untick repeat on the latest check, click **+ Add check** → the newest check starts at `0.00`.
- Confirm an existing check's income is never rewritten by adding a check.

- [ ] **Step 5: Commit**

```bash
git add app.jsx
git commit -m "feat: repeatable paycheck — new checks inherit income when repeat is on"
```

---

## Task 6: Make every category removable (including defaults)

**Files:**
- Modify: `app.jsx` — `actions` object (add `removeCategory`), global-category render in `BudgetSection` (lines 323-328)

**Interfaces:**
- Consumes: `mutate`, `nowIso`, existing `BudgetRow` `onRemove` prop.
- Produces: `actions.removeCategory(id)` that removes a global category and purges its allocations from all checks.

- [ ] **Step 1: Add the `removeCategory` action**

In the `actions` object, add after `renameCategory`:

```js
    removeCategory: (id) => mutate((d) => {
      d.categories = { updatedAt: nowIso(), items: d.categories.items.filter((c) => c.id !== id) };
      d.checks = d.checks.map((c) => {
        if (!c.allocations || !(id in c.allocations)) return c;
        const next = { ...c.allocations };
        delete next[id];
        return { ...c, allocations: next, updatedAt: nowIso() };
      });
      return d;
    }),
```

- [ ] **Step 2: Add the remove button to the global category rows**

In `BudgetSection`, find:

```jsx
        {doc.categories.items.map((c) => (
          <BudgetRow key={c.id} label={c.name} renamable
            onRename={(name) => actions.renameCategory(c.id, name)}
            amount={(check.allocations || {})[c.id]}
            onAmount={(v) => actions.setAllocation(check.id, c.id, v)} />
        ))}
```

Replace with (adds `onRemove`):

```jsx
        {doc.categories.items.map((c) => (
          <BudgetRow key={c.id} label={c.name} renamable
            onRename={(name) => actions.renameCategory(c.id, name)}
            amount={(check.allocations || {})[c.id]}
            onAmount={(v) => actions.setAllocation(check.id, c.id, v)}
            onRemove={() => actions.removeCategory(c.id)} />
        ))}
```

- [ ] **Step 3: Manual verification**

Reload the app.
- Each default category row (Car, Gas, Credit Card Payment, Food) now shows a `×` remove button.
- Set Food to `100` on Check 1, then remove **Food** → it disappears from every check; switch checks to confirm. The breakdown no longer lists Food.
- Remove all four defaults → the list is empty; add a new one via **+ Add category**. Reload → state persists.

- [ ] **Step 4: Commit**

```bash
git add app.jsx
git commit -m "feat: allow removing default categories and purge their allocations"
```

---

## Task 7: Wire migration into load and import

**Files:**
- Modify: `app.jsx` — bootstrap `useEffect` (lines 555-564) and `replaceAll` (lines 576-581)

**Interfaces:**
- Consumes: `migrateDoc` (global), `validDoc`, `buildSeed`, `idbGet`, `idbSet`, `sortedChecks`.
- Produces: stored and imported docs are migrated non-destructively and persisted when changed.

- [ ] **Step 1: Migrate the loaded doc on bootstrap**

Replace the bootstrap `useEffect` (lines 555-564) with:

```js
  // bootstrap from this device's storage (or seed on first ever run)
  useEffect(() => {
    (async () => {
      const local = await idbGet();
      let initial;
      if (validDoc(local)) {
        const { doc: migrated, changed } = migrateDoc(local);
        initial = migrated;
        if (changed) idbSet(initial).catch(() => {});
      } else {
        initial = buildSeed();
        idbSet(initial).catch(() => {});
      }
      setDoc(initial);
      const first = sortedChecks(initial)[0];
      setSelectedId(first ? first.id : null);
    })();
  }, []);
```

- [ ] **Step 2: Migrate imported backups too**

Replace `replaceAll` (lines 576-581) with:

```js
  const replaceAll = useCallback((nextDoc) => {
    const { doc: migrated } = migrateDoc(nextDoc);
    setDoc(migrated);
    idbSet(migrated).catch(() => {});
    const first = sortedChecks(migrated)[0];
    setSelectedId(first ? first.id : null);
  }, []);
```

- [ ] **Step 3: Manual verification (old backup upgrades, customizations survive)**

1. In DevTools Console, write a legacy-shaped doc (no `budgetTitle`/`repeat`, renamed default) directly, then reload:

```js
const legacy = {
  version: 1,
  categories: { updatedAt: "", items: [{ id: "cat_food", name: "Groceries" }] },
  accounts: [{ id: "acc_cash", name: "Cash", balance: 0, deleted: false }],
  checks: [{ id: "chk_1", label: "Check 1", payDate: "2026-06-28", income: 0, allocations: {}, deleted: false }],
};
const r = indexedDB.open("ourobudget", 1);
r.onsuccess = () => r.result.transaction("kv", "readwrite").objectStore("kv").put(legacy, "doc");
```

2. Reload the page. Expected:
   - App loads without errors; budget title field shows the **Budget** placeholder (empty).
   - The renamed category still reads **Groceries** (user customization preserved — not reset to "Food").
   - Export backup now shows `"version": 2`, `"budgetTitle": ""`, and `"repeat": false` on the check.

- [ ] **Step 4: Commit**

```bash
git add app.jsx
git commit -m "feat: migrate stored and imported docs non-destructively on load"
```

---

## Task 8: Service worker waits for user instead of auto-swapping

**Files:**
- Modify: `sw.js` — `install` handler (lines 25-32), add a `message` handler

**Interfaces:**
- Consumes: nothing new.
- Produces: an installed-but-waiting worker that only activates when it receives `{ type: "SKIP_WAITING" }`.

- [ ] **Step 1: Remove the automatic `skipWaiting()` from install and add a message handler**

In `sw.js`, replace the `install` handler (lines 25-32):

```js
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // ignore any single asset that 404s so install never fully fails
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});
```

with:

```js
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // ignore any single asset that 404s so install never fully fails
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
  );
});

// Activate immediately only when the page asks (user clicked "Refresh").
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
```

Leave the `activate` handler (with `clients.claim()`) and the `fetch` handler unchanged.

- [ ] **Step 2: Manual verification (worker now waits)**

This is verified end-to-end in Task 10. For now, confirm no syntax errors: reload `http://localhost:8000`, open DevTools → Application → Service Workers, and confirm a worker is **activated and running** (first install still activates because there is no older controller to wait behind).

- [ ] **Step 3: Commit**

```bash
git add sw.js
git commit -m "feat(sw): wait for SKIP_WAITING message instead of auto-activating"
```

---

## Task 9: Registration glue detects updates and reloads once

**Files:**
- Modify: `index.html` — the registration `<script>` (lines 65-73)

**Interfaces:**
- Consumes: the waiting worker from Task 8.
- Produces: globals `window.__ouroSWReg` (the registration), `window.__ouroUpdateReady` (boolean), and a `ouro-update-ready` window event; a one-time reload on `controllerchange`.

- [ ] **Step 1: Replace the registration script**

In `index.html`, replace the registration `<script>` (lines 65-73):

```html
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) {
          console.warn('SW registration failed:', e);
        });
      });
    }
  </script>
```

with:

```html
  <script>
    if ('serviceWorker' in navigator) {
      // When the new worker takes control, reload exactly once to load fresh assets.
      var ouroReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (ouroReloaded) return;
        ouroReloaded = true;
        window.location.reload();
      });

      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          function flagReady() {
            window.__ouroSWReg = reg;
            window.__ouroUpdateReady = true;
            window.dispatchEvent(new CustomEvent('ouro-update-ready'));
          }
          // An update was already downloaded and is waiting.
          if (reg.waiting && navigator.serviceWorker.controller) flagReady();
          // An update is downloading now.
          reg.addEventListener('updatefound', function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function () {
              // "installed" + an existing controller == update (not first install).
              if (nw.state === 'installed' && navigator.serviceWorker.controller) flagReady();
            });
          });
        }).catch(function (e) {
          console.warn('SW registration failed:', e);
        });
      });
    }
  </script>
```

- [ ] **Step 2: Manual verification**

Reload the app once to install this registration code (and Task 8's worker). No console errors. Full update behavior is verified in Task 10.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: detect waiting SW update and reload once on controllerchange"
```

---

## Task 10: Update banner in the app + end-to-end update test

**Files:**
- Modify: `app.jsx` — add `UpdateBanner` component (near other components) and mount it in `App` (return block, lines 632-659)

**Interfaces:**
- Consumes: `window.__ouroUpdateReady`, `window.__ouroSWReg`, the `ouro-update-ready` event (Task 9).
- Produces: a dismissible banner that posts `SKIP_WAITING` to the waiting worker.

- [ ] **Step 1: Add the `UpdateBanner` component**

In `app.jsx`, add this component (e.g., immediately before the `Header` component definition near line 510):

```jsx
/* =========================================================================
   Update banner — surfaces a waiting service-worker update
   ========================================================================= */
function UpdateBanner() {
  const [ready, setReady] = useState(typeof window !== "undefined" && window.__ouroUpdateReady === true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener("ouro-update-ready", on);
    return () => window.removeEventListener("ouro-update-ready", on);
  }, []);

  if (!ready || dismissed) return null;

  const refresh = () => {
    const reg = window.__ouroSWReg;
    if (reg && reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    else window.location.reload();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 flex justify-center">
      <div className="flex items-center gap-3 bg-brand-surface border border-brand-border rounded-2xl px-4 py-2.5 shadow-lg max-w-sm w-full">
        <span className="text-sm text-brand-text flex-1">A new version is available.</span>
        <button onClick={refresh}
          className="rounded-full px-3 py-1.5 text-xs font-medium bg-brand-accent text-white dark:text-[#15240a] hover:bg-brand-accentd transition-colors">
          Refresh
        </button>
        <button onClick={() => setDismissed(true)}
          className="text-brand-muted text-xl leading-none px-1" title="Dismiss">×</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount the banner in `App`**

In `App`'s returned JSX, find the closing of the root div:

```jsx
        <p className="text-center text-xs text-brand-muted pt-2">
          OuroBudget™ · No ads, no tracking, your data never leaves your device · Loop In. Level Up.
        </p>
      </main>
    </div>
  );
}
```

Insert `<UpdateBanner />` just before `</div>` (after `</main>`):

```jsx
        <p className="text-center text-xs text-brand-muted pt-2">
          OuroBudget™ · No ads, no tracking, your data never leaves your device · Loop In. Level Up.
        </p>
      </main>
      <UpdateBanner />
    </div>
  );
}
```

- [ ] **Step 3: End-to-end update verification**

1. Serve and open the app: `python -m http.server 8000` → `http://localhost:8000`. Let the service worker install (Application → Service Workers shows it activated). Enter some data (e.g., a budget title and an income) so you can confirm persistence.
2. Simulate a new release: bump the cache string in `sw.js` from `ouro-pwa-v3` to `ouro-pwa-v4` and make a visible tweak (e.g., change the footer text). Save.
3. Reload the page once. Expected:
   - A new worker installs and **waits** (Application → Service Workers shows a "waiting" worker).
   - The **"A new version is available."** banner appears at the bottom with **Refresh** and **×**.
4. Click **Refresh**. Expected: the page reloads exactly once, the visible tweak is now live, and your entered data (budget title, income) is still present.
5. Confirm **×** dismisses the banner for the session without reloading.
6. Revert the temporary `ouro-pwa-v4`/footer tweak back to `ouro-pwa-v3` before finishing (the real release bump happens once, at deploy time).

- [ ] **Step 4: Commit**

```bash
git add app.jsx
git commit -m "feat: in-app 'new version available' banner with one-tap refresh"
```

---

## Final verification (whole feature)

- [ ] **Run the automated unit tests:** `node tests/lib.test.js` → `All lib.js tests passed.`
- [ ] **Smoke test the app** at `http://localhost:8000`: editable title persists; breakdown percentages are income-based with Unallocated/over-budget/zero-income states correct; repeatable paycheck carries forward; all categories (incl. defaults) removable; old backup imports and upgrades while keeping renamed categories.
- [ ] **Confirm the release knob:** `sw.js` ships with `CACHE = "ouro-pwa-v3"`; future releases bump it to trigger the update banner.
- [ ] **Update the README** rollout note if desired (it already documents bumping the CACHE string; the new banner now surfaces that update to users automatically).

---

## Self-Review notes (author)

- **Spec coverage:** editable title (T3), income-based math + heading rename (T1 math, T4 UI), repeatable paycheck (T5), removable defaults (T6), auto update notification (T8–T10), data persistence + migration (T1 migrateDoc, T7 wiring), category precedence (T1 migrateDoc leaves items untouched; asserted in tests). All covered.
- **Type consistency:** `computeBreakdown` returns `{ income, budgeted, leftover, segments[{name,amt,pct,width}], unallocated|null, over, incomeZeroFallback, empty }` — used identically in T4. `migrateDoc` returns `{ doc, changed }` — used identically in T7. `__ouroSWReg`/`__ouroUpdateReady`/`ouro-update-ready` produced in T9, consumed in T10. `SKIP_WAITING` message produced in T10, handled in T8.
- **No placeholders:** every code step contains complete content.
