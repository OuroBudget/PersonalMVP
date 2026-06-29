/* OuroBudget PWA - React app (transformed in-browser by Babel).

   Standalone & server-less: ALL data lives in this browser (IndexedDB). Nothing
   is sent anywhere - no backend, no network calls, no analytics. Back up or move
   data with the Export / Import buttons. Installable to the home screen. */

const { useState, useEffect, useRef, useCallback } = React;

/* ----------------------------------------------------------------- helpers */
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => usd.format(Number.isFinite(n) ? n : 0);

const BIWEEKLY_DAYS = 14;
const addDays = (iso, days) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const prettyDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const FIXED_CATEGORIES = [
  { id: "cat_car", name: "Car" },
  { id: "cat_gas", name: "Gas" },
  { id: "cat_ccpay", name: "Credit Card Payment" },
  { id: "cat_food", name: "Food" },
];
const DEFAULT_ACCOUNTS = [
  { id: "acc_bank1", name: "Bank 1" },
  { id: "acc_bank2", name: "Bank 2" },
  { id: "acc_cash", name: "Cash" },
];

function buildSeed() {
  const ts = nowIso();
  const start = new Date().toISOString().slice(0, 10);
  const alloc = () => Object.fromEntries(FIXED_CATEGORIES.map((c) => [c.id, 0]));
  return {
    version: DOC_VERSION,
    budgetTitle: "",
    categories: { updatedAt: ts, items: FIXED_CATEGORIES.map((c) => ({ ...c })) },
    accounts: DEFAULT_ACCOUNTS.map((a) => ({ ...a, balance: 0, updatedAt: ts, deleted: false })),
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
  };
}

function validDoc(d) {
  return !!d && typeof d === "object" &&
    Array.isArray(d.accounts) && Array.isArray(d.checks) &&
    d.categories && Array.isArray(d.categories.items);
}

/* ------------------------------------------------------------- IndexedDB kv */
const DB_NAME = "ourobudget", STORE = "kv", KEY = "doc";
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet() {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      tx.onsuccess = () => res(tx.result || null);
      tx.onerror = () => rej(tx.error);
    });
  } catch { return null; }
}
async function idbSet(doc) {
  const db = await idbOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(doc, KEY);
    tx.onsuccess = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ----------------------------------------------------------- derived views */
const visible = (list) => (list || []).filter((x) => !x.deleted);
const sortedChecks = (doc) =>
  visible(doc.checks).sort((a, b) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : 0));
const checkBudgeted = (chk) => {
  const fixed = Object.values(chk.allocations || {}).reduce((s, v) => s + num(v), 0);
  const custom = (chk.customCategories || []).reduce((s, c) => s + num(c.amount), 0);
  return fixed + custom;
};
const SEG_COLORS = ["#5A9B0A", "#A8C870", "#3D6B07", "#6FDC30", "#83b34a", "#cfe3a8", "#2ABF33", "#b9cf91", "#4e7d10", "#9bbf63"];

/* ----------------------------------------------------- export / import data */
function exportData(doc) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ourobudget-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================================================
   UI primitives
   ========================================================================= */
function MoneyInput({ value, onChange, className = "", placeholder = "0.00" }) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const display = focused ? text : value ? Number(value).toFixed(2) : "";
  return (
    <input
      type="text" inputMode="decimal" placeholder={placeholder}
      className={"bg-transparent outline-none text-right tabular-nums " + className}
      value={display}
      onFocus={() => { setFocused(true); setText(value ? String(value) : ""); }}
      onChange={(e) => { setText(e.target.value); onChange(num(e.target.value)); }}
      onBlur={() => setFocused(false)}
    />
  );
}
function TextInput({ value, onChange, className = "", placeholder = "" }) {
  return (
    <input
      type="text" value={value} placeholder={placeholder}
      className={"bg-transparent outline-none " + className}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
const Card = ({ children, className = "" }) => (
  <div className={"bg-brand-surface border border-brand-border rounded-2xl " + className}>{children}</div>
);
const Eyebrow = ({ children }) => (
  <div className="eyebrow text-brand-muted mb-1">{children}</div>
);
const GhostBtn = ({ children, onClick, className = "" }) => (
  <button onClick={onClick}
    className={"rounded-full px-3 py-1.5 text-sm border border-brand-border text-brand-accentd dark:text-brand-accent bg-brand-accentl hover:border-brand-accent transition-colors " + className}>
    {children}
  </button>
);

/* =========================================================================
   Dashboard
   ========================================================================= */
function StatCard({ label, value, sub, tone }) {
  const toneClass = tone === "good" ? "text-brand-accent"
    : tone === "bad" ? "text-brand-danger"
    : tone === "warn" ? "text-brand-text2" : "text-brand-text";
  return (
    <Card className="p-4">
      <Eyebrow>{label}</Eyebrow>
      <div className={"text-2xl font-medium tabular-nums tracking-tight " + toneClass}>{value}</div>
      {sub ? <div className="text-xs text-brand-muted mt-1">{sub}</div> : null}
    </Card>
  );
}

function BreakdownBar({ doc, check }) {
  const b = computeBreakdown(check, doc.categories.items);
  const over = b.over > 0;
  const segColor = (i) => over ? "var(--danger)" : SEG_COLORS[i % SEG_COLORS.length];
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
                style={{ width: `${s.width}%`, background: segColor(i) }} />
            ))}
            {b.unallocated && (
              <div title={`Unallocated: ${money(b.unallocated.amt)}`}
                style={{ width: `${b.unallocated.width}%`, background: "var(--border)" }} />
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mt-2">
            {b.segments.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: segColor(i) }} />
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
            <div className="text-xs text-brand-danger font-medium mt-2">Over income by {money(b.over)}</div>
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

function Dashboard({ doc, check }) {
  const accounts = visible(doc.accounts);
  const totalCash = accounts.reduce((s, a) => s + num(a.balance), 0);
  const income = num(check ? check.income : 0);
  const budgeted = check ? checkBudgeted(check) : 0;
  const left = income - budgeted;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Cash" value={money(totalCash)}
          sub={`${accounts.length} account${accounts.length === 1 ? "" : "s"}`} tone="good" />
        <StatCard label="This Check — Income" value={money(income)}
          sub={check ? `Pays ${prettyDate(check.payDate)}` : ""} />
        <StatCard label="This Check — Budgeted" value={money(budgeted)} />
        <StatCard label="This Check — Left to Allocate"
          value={left >= 0 ? money(left) : money(Math.abs(left))}
          sub={left >= 0 ? "left to allocate" : "over income"}
          tone={left >= 0 ? "good" : "bad"} />
      </div>
      {accounts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {accounts.map((a) => (
            <span key={a.id}
              className="text-xs px-3 py-1 rounded-full bg-brand-accentl border border-brand-border text-brand-text2">
              {a.name} <span className="tabular-nums text-brand-text font-medium">{money(num(a.balance))}</span>
            </span>
          ))}
        </div>
      )}
      {check && <BreakdownBar doc={doc} check={check} />}
    </div>
  );
}

/* =========================================================================
   Budget section
   ========================================================================= */
function BudgetRow({ label, renamable, onRename, amount, onAmount, onRemove }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-brand-border last:border-0">
      {renamable ? (
        <TextInput value={label} onChange={onRename} className="flex-1 text-sm text-brand-text min-w-0" />
      ) : (
        <span className="flex-1 text-sm text-brand-text truncate">{label}</span>
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

function BudgetSection({ doc, check, selectedId, setSelectedId, actions }) {
  const [newCat, setNewCat] = useState("");
  const checks = sortedChecks(doc);
  if (!check) return null;
  const income = num(check.income);
  const budgeted = checkBudgeted(check);
  const left = income - budgeted;
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <TextInput value={doc.budgetTitle || ""} onChange={actions.setBudgetTitle}
          placeholder="Budget"
          className="text-lg font-medium tracking-tight text-brand-text min-w-0 flex-1" />
        <span className="eyebrow text-brand-muted">{checks.length} check{checks.length === 1 ? "" : "s"}</span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
        {checks.map((c, i) => {
          const active = c.id === selectedId;
          return (
            <button key={c.id} onClick={() => setSelectedId(c.id)}
              className={"shrink-0 rounded-xl px-3 py-2 text-left border transition-colors " +
                (active ? "bg-brand-accent text-white dark:text-[#15240a] border-brand-accent"
                        : "bg-brand-bg border-brand-border text-brand-text2 hover:border-brand-accent")}>
              <div className="text-sm font-medium">Check {i + 1}</div>
              <div className={"text-[11px] " + (active ? "opacity-90" : "text-brand-muted")}>{prettyDate(c.payDate)}</div>
            </button>
          );
        })}
        <button onClick={actions.addCheck}
          className="shrink-0 rounded-xl px-3 py-2 text-sm border border-dashed border-brand-accentm text-brand-accentd dark:text-brand-accent hover:bg-brand-accentl">
          + Add check
        </button>
      </div>

      <div className="mt-4 grid sm:grid-cols-2 gap-3">
        <label className="flex items-center justify-between gap-3 bg-brand-bg rounded-xl px-3 py-2">
          <span className="text-sm text-brand-text2">Pay date</span>
          <input type="date" value={check.payDate}
            onChange={(e) => actions.updateCheck(check.id, { payDate: e.target.value })}
            className="bg-transparent outline-none text-sm text-brand-text" />
        </label>
        <label className="flex items-center justify-between gap-3 bg-brand-bg rounded-xl px-3 py-2">
          <span className="text-sm text-brand-text2">Income this check</span>
          <span className="flex items-center gap-1">
            <span className="text-brand-muted text-sm">$</span>
            <MoneyInput value={check.income} onChange={(v) => actions.updateCheck(check.id, { income: v })}
              className="w-24 text-sm text-brand-text" />
          </span>
        </label>
      </div>

      <label className="flex items-center gap-2 mt-2 text-sm text-brand-text2 select-none">
        <input type="checkbox" checked={check.repeat === true}
          onChange={(e) => actions.updateCheck(check.id, { repeat: e.target.checked })}
          className="accent-brand-accent" />
        Repeat this amount for new checks
      </label>

      <div className="mt-3">
        {doc.categories.items.map((c) => (
          <BudgetRow key={c.id} label={c.name} renamable
            onRename={(name) => actions.renameCategory(c.id, name)}
            amount={(check.allocations || {})[c.id]}
            onAmount={(v) => actions.setAllocation(check.id, c.id, v)}
            onRemove={() => actions.removeCategory(c.id)} />
        ))}
        {(check.customCategories || []).map((c) => (
          <BudgetRow key={c.id} label={c.name} renamable
            onRename={(name) => actions.updateCustom(check.id, c.id, { name })}
            amount={c.amount}
            onAmount={(v) => actions.updateCustom(check.id, c.id, { amount: v })}
            onRemove={() => actions.removeCustom(check.id, c.id)} />
        ))}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <TextInput value={newCat} onChange={setNewCat} placeholder="Other"
          className="flex-1 text-sm bg-brand-bg rounded-full px-3 py-2 border border-brand-border focus:border-brand-accent" />
        <GhostBtn onClick={() => { actions.addCustom(check.id, newCat.trim() || "Other"); setNewCat(""); }}>
          + Add category
        </GhostBtn>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-4 pt-3 border-t border-brand-border text-sm">
        <span className="text-brand-text2">Budgeted <span className="tabular-nums text-brand-text font-medium">{money(budgeted)}</span></span>
        <span className="text-brand-text2">Income <span className="tabular-nums text-brand-text font-medium">{money(income)}</span></span>
        <span className={left >= 0 ? "text-brand-accent" : "text-brand-danger font-medium"}>
          {left >= 0 ? "Left " : "Over "}
          <span className="tabular-nums font-medium">{money(Math.abs(left))}</span>
        </span>
        {checks.length > 1 && (
          <button onClick={() => actions.removeCheck(check.id)}
            className="ml-auto text-xs text-brand-muted hover:text-brand-accentd">Remove this check</button>
        )}
      </div>
    </Card>
  );
}

/* =========================================================================
   Accounts section
   ========================================================================= */
function AccountsSection({ doc, actions }) {
  const accounts = visible(doc.accounts);
  const total = accounts.reduce((s, a) => s + num(a.balance), 0);
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium tracking-tight">Accounts</h2>
        <span className="text-sm text-brand-text2">Total <span className="tabular-nums text-brand-text font-medium">{money(total)}</span></span>
      </div>
      <div>
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 py-2 border-b border-brand-border last:border-0">
            <TextInput value={a.name} onChange={(name) => actions.updateAccount(a.id, { name })}
              className="flex-1 text-sm text-brand-text min-w-0" />
            <span className="text-brand-muted text-sm">$</span>
            <MoneyInput value={a.balance} onChange={(v) => actions.updateAccount(a.id, { balance: v })}
              className="w-28 text-sm text-brand-text border-b border-brand-border focus:border-brand-accent" />
            <button onClick={() => actions.removeAccount(a.id)}
              className="text-brand-muted hover:text-brand-accentd text-lg leading-none px-1" title="Remove">×</button>
          </div>
        ))}
      </div>
      <div className="mt-3"><GhostBtn onClick={actions.addAccount}>+ Add account</GhostBtn></div>
    </Card>
  );
}

/* =========================================================================
   Install button (native prompt where available; per-platform guide otherwise:
   iOS / Android-Chrome / Samsung Internet / generic)
   ========================================================================= */
function isIOS() {
  const ua = window.navigator.userAgent;
  return (/iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) && !window.MSStream;
}
function isSamsung() {
  return /SamsungBrowser/i.test(window.navigator.userAgent);
}
function isAndroid() {
  return /android/i.test(window.navigator.userAgent);
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

const b = (t) => <span className="font-medium text-brand-text">{t}</span>;
const INSTALL_GUIDES = {
  ios: {
    title: "Add to Home Screen (iPhone / iPad)",
    steps: [
      <>Tap the {b("Share")} button <span className="inline-block mx-1 align-middle">⬆️</span> at the bottom of Safari.</>,
      <>Scroll down and tap {b("“Add to Home Screen.”")}</>,
      <>Tap {b("Add")} — the OuroBudget icon appears on your home screen.</>,
    ],
  },
  android: {
    title: "Install on Android (Chrome)",
    steps: [
      <>Tap the {b("⋮")} menu (three dots) at the top-right of Chrome.</>,
      <>Tap {b("“Install app”")} or {b("“Add to Home screen.”")}</>,
      <>Tap {b("Install")} (or {b("Add")}) to confirm — OuroBudget appears with your apps.</>,
    ],
  },
  samsung: {
    title: "Install on Samsung Internet",
    steps: [
      <>Tap the {b("≡")} menu (three lines) at the bottom-right.</>,
      <>Tap {b("“Add page to.”")}</>,
      <>Choose {b("“Home screen,”")} then tap {b("Add")} to confirm.</>,
    ],
  },
  generic: {
    title: "Add to Home Screen",
    steps: [
      <>Open your browser’s menu (usually {b("⋮")} or {b("≡")}).</>,
      <>Choose {b("“Install app”")} or {b("“Add to Home screen.”")}</>,
      <>Confirm — OuroBudget opens like a normal app and works offline.</>,
    ],
  },
};

function InstallButton() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(isStandalone());
  const [help, setHelp] = useState(null); // 'ios' | 'android' | 'samsung' | 'generic' | null

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => { setInstalled(true); setDeferred(null); setHelp(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const onClick = async () => {
    if (deferred) {
      deferred.prompt();
      try { await deferred.userChoice; } catch {}
      setDeferred(null);
    } else if (isIOS()) {
      setHelp("ios");
    } else if (isSamsung()) {
      setHelp("samsung");
    } else if (isAndroid()) {
      setHelp("android");
    } else {
      setHelp("generic");
    }
  };

  return (
    <>
      <button onClick={onClick}
        className="rounded-full px-3 py-1.5 text-xs font-medium bg-brand-accent text-white dark:text-[#15240a] hover:bg-brand-accentd transition-colors">
        Install
      </button>
      {help && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
          onClick={() => setHelp(null)}>
          <div className="bg-brand-surface border border-brand-border rounded-2xl max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-medium">{INSTALL_GUIDES[help].title}</h3>
              <button onClick={() => setHelp(null)} className="text-brand-muted text-xl leading-none">×</button>
            </div>
            <ol className="text-sm text-brand-text2 space-y-2 list-decimal pl-5">
              {INSTALL_GUIDES[help].steps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
            <p className="text-xs text-brand-muted mt-3">Once added, it opens like a normal app and works offline.</p>
          </div>
        </div>
      )}
    </>
  );
}

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

/* =========================================================================
   Header
   ========================================================================= */
function Header({ dark, setDark, saving }) {
  return (
    <header className="sticky top-0 z-10 bg-brand-bg border-b border-brand-border">
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <img src="assets/icon.svg" alt="OuroBudget" className="h-9 w-auto" />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-brand-text2" title="Saved on this device">
            <span className={"w-2 h-2 rounded-full " + (saving ? "bg-brand-accent animate-pulse" : "bg-brand-accent")} />
            {saving ? "Saving…" : "Saved"}
          </span>
          <InstallButton />
          <button onClick={() => setDark(!dark)}
            className="rounded-full px-3 py-1.5 text-xs border border-brand-border bg-brand-accentl text-brand-accentd dark:text-brand-accent">
            {dark ? "Light" : "Dark"}
          </button>
        </div>
      </div>
    </header>
  );
}

/* =========================================================================
   App root
   ========================================================================= */
function App() {
  const [doc, setDoc] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("ouro-dark") === "1");
  const fileRef = useRef(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("ouro-dark", dark ? "1" : "0");
  }, [dark]);

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

  // apply an update, persist to IndexedDB
  const mutate = useCallback((updater) => {
    setSaving(true);
    setDoc((prev) => {
      const next = updater(structuredCloneSafe(prev));
      idbSet(next).then(() => setSaving(false)).catch(() => setSaving(false));
      return next;
    });
  }, []);

  const replaceAll = useCallback((nextDoc) => {
    const { doc: migrated } = migrateDoc(nextDoc);
    setDoc(migrated);
    idbSet(migrated).catch(() => {});
    const first = sortedChecks(migrated)[0];
    setSelectedId(first ? first.id : null);
  }, []);

  const onImportFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-importing the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!validDoc(parsed)) throw new Error("not an OuroBudget backup");
        if (confirm("Import this backup? It will replace the data currently on this device.")) {
          replaceAll(parsed);
        }
      } catch (err) {
        alert("That file isn't a valid OuroBudget backup.");
      }
    };
    reader.readAsText(file);
  };

  const actions = {
    setBudgetTitle: (name) => mutate((d) => { d.budgetTitle = name; return d; }),
    updateAccount: (id, patch) => mutate((d) => { d.accounts = d.accounts.map((a) => a.id === id ? { ...a, ...patch, updatedAt: nowIso() } : a); return d; }),
    addAccount: () => mutate((d) => { d.accounts.push({ id: uid("acc"), name: "New Account", balance: 0, updatedAt: nowIso(), deleted: false }); return d; }),
    removeAccount: (id) => mutate((d) => { d.accounts = d.accounts.map((a) => a.id === id ? { ...a, deleted: true, updatedAt: nowIso() } : a); return d; }),
    renameCategory: (id, name) => mutate((d) => { d.categories = { updatedAt: nowIso(), items: d.categories.items.map((c) => c.id === id ? { ...c, name } : c) }; return d; }),
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
    setAllocation: (checkId, catId, value) => mutate((d) => { d.checks = d.checks.map((c) => c.id === checkId ? { ...c, allocations: { ...c.allocations, [catId]: value }, updatedAt: nowIso() } : c); return d; }),
    updateCheck: (checkId, patch) => mutate((d) => { d.checks = d.checks.map((c) => c.id === checkId ? { ...c, ...patch, updatedAt: nowIso() } : c); return d; }),
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
    removeCheck: (checkId) => {
      const live = sortedChecks(doc);
      if (live.length <= 1) return;
      mutate((d) => { d.checks = d.checks.map((c) => c.id === checkId ? { ...c, deleted: true, updatedAt: nowIso() } : c); return d; });
      if (selectedId === checkId) { const next = live.find((c) => c.id !== checkId); setSelectedId(next ? next.id : null); }
    },
    addCustom: (checkId, name) => mutate((d) => { d.checks = d.checks.map((c) => c.id === checkId ? { ...c, customCategories: [...(c.customCategories || []), { id: uid("cust"), name, amount: 0 }], updatedAt: nowIso() } : c); return d; }),
    updateCustom: (checkId, custId, patch) => mutate((d) => { d.checks = d.checks.map((c) => c.id === checkId ? { ...c, customCategories: c.customCategories.map((x) => x.id === custId ? { ...x, ...patch } : x), updatedAt: nowIso() } : c); return d; }),
    removeCustom: (checkId, custId) => mutate((d) => { d.checks = d.checks.map((c) => c.id === checkId ? { ...c, customCategories: c.customCategories.filter((x) => x.id !== custId), updatedAt: nowIso() } : c); return d; }),
  };

  if (!doc) return <div className="min-h-screen flex items-center justify-center text-brand-muted">Loading…</div>;

  const checks = sortedChecks(doc);
  const selected = checks.find((c) => c.id === selectedId) || checks[0] || null;

  return (
    <div className="min-h-screen text-brand-text">
      <Header dark={dark} setDark={setDark} saving={saving} />
      <main className="max-w-3xl mx-auto px-4 py-5 space-y-4 pb-16">
        <Dashboard doc={doc} check={selected} />
        <BudgetSection doc={doc} check={selected} selectedId={selected ? selected.id : null}
          setSelectedId={setSelectedId} actions={actions} />
        <AccountsSection doc={doc} actions={actions} />

        <Card className="p-4 sm:p-5">
          <Eyebrow>Your Data</Eyebrow>
          <p className="text-sm text-brand-text2 mb-3">
            Everything is stored privately in this browser — nothing is uploaded anywhere. Export a backup, or
            import one to move your budget to another device.
          </p>
          <div className="flex flex-wrap gap-2">
            <GhostBtn onClick={() => exportData(doc)}>⬇ Export backup</GhostBtn>
            <GhostBtn onClick={() => fileRef.current && fileRef.current.click()}>⬆ Import backup</GhostBtn>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />
          </div>
        </Card>

        <p className="text-center text-xs text-brand-muted pt-2">
          OuroBudget™ · No ads, no tracking, your data never leaves your device · Loop In. Level Up.
        </p>
      </main>
      <UpdateBanner />
    </div>
  );
}

function structuredCloneSafe(obj) {
  try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
