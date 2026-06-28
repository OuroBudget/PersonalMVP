# OuroBudget™ — Manual Budget (PWA)

A standalone, installable budgeting app. **No server, no accounts, no cloud.** Everything a
person enters stays in their own browser on their own device. This is the shareable,
zero-install version of the OuroBudget bi-weekly budget — the spirit of the free manual tier.

> *Loop In. Level Up.*

---

## What it is

- A static **Progressive Web App** (React + Tailwind + Babel, all vendored locally — no CDN,
  no build step, no network calls at all).
- Data is stored privately in the browser (**IndexedDB**) and works fully **offline** after
  the first load.
- **Install button** that uses the native prompt on Android/desktop Chrome and shows an
  "Add to Home Screen" guide on iPhone.
- **Export / Import** a JSON backup to move data to another device (there's no server to
  sync through in this version).

Features: Total Cash across accounts, bi-weekly budgeting (4 checks to start, add/remove
more), six fixed categories + per-check custom categories, dashboard with a breakdown bar,
light/dark mode.

---

## Hosting it (GitHub → Cloudflare Pages)

This folder is the entire site — deploy its **contents** at the root of a Pages project.

1. **GitHub:** commit this `ourobudget-pwa/` folder to a repo (see "Safe for the repo" below).
2. **Cloudflare Pages:** create a new Pages project → connect the repo.
   - **Build command:** *(leave empty — there's no build step.)*
   - **Build output directory:** the path to this folder (e.g. `Dev/ourobudget-pwa` if you
     commit the whole project, or `/` if this folder is the repo root).
3. Deploy. Cloudflare serves it over HTTPS (required for installable PWAs) at your
   Pages URL or a custom subdomain (e.g. `budget.ourobudget.app`).

Because all paths are **relative**, it works at a domain root or a sub-path.

> Updating the app: when you change files and the cache should refresh, bump the
> `CACHE` version string in `sw.js` (e.g. `ouro-pwa-v1` → `ouro-pwa-v2`) so returning
> visitors pick up the new version.

---

## How friends install it

- **Android / desktop Chrome/Edge (Google):** open the link → tap **Install** in the header
  (or the browser's install icon in the address bar). If no prompt appears, tap **Install**
  for a step-by-step guide (⋮ menu → **Add to Home screen**).
- **Samsung Internet:** open the link → tap **Install** → follow the steps (≡ menu →
  **Add page to** → **Home screen**).
- **iPhone (Safari):** open the link → tap **Install** → follow the on-screen steps
  (Share → **Add to Home Screen**). iOS doesn't allow one-tap install, so this guide is the
  expected flow.

After installing, it launches like a normal app and works offline.

---

## Data & privacy

- Stored only in the user's browser (IndexedDB). **Nothing is uploaded — there is no
  backend.** Hosting only serves static files.
- **Back up / move data:** use **Export backup** (downloads a JSON file) and **Import
  backup** on another device.
- Clearing browser data / "site data" erases it, so keep a backup. Each browser/profile is
  its own separate copy.

---

## Safe for the repo

This folder contains **no secrets** — no keys, no certificates, no personal data, no
`.env`. It's safe to make public. Notes:

- There is **no `data.json`** here; user data lives only in the browser at runtime.
- `.gitignore` excludes any accidental `ourobudget-backup-*.json` export and OS cruft.
- If you commit the whole `Dev/` tree, the sibling `ourobudget-local/` already ignores its
  private bits (`certs/`, `data.json`, `.venv/`) via its own `.gitignore` — but if you only
  want to publish this PWA, **commit just this `ourobudget-pwa/` folder.**
- `assets/vendor/` holds standard open-source libraries (React, ReactDOM, Babel, Tailwind),
  committed on purpose so the app needs no CDN.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell + brand theme; loads vendored libs |
| `app.jsx` | The React app (browser storage, export/import, install button) |
| `sw.js` | Service worker — offline cache of the app shell |
| `manifest.webmanifest` | PWA metadata (name, icons, theme) |
| `assets/` | Logos, PNG/SVG icons, and `vendor/` libraries |

---

Built from the OuroBudget local edition, refactored to run anywhere with no server.
No ads, no tracking, data never leaves the device.
