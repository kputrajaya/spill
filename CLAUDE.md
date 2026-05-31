# Spill — Simple Bill Splitter

## Stack
- **Frontend:** Alpine.js 3.x + Bootstrap 5.3.3 (CDN, no bundler)
- **Backend:** Python 3 serverless (Vercel), Google Cloud Document AI Expense Parser for receipt OCR
- **Notifications:** Notyf v3
- **Image resize:** Pica v9
- **Persist:** @alpinejs/persist

## Structure
```
spill/
  index.html          # Single-page app (Bootstrap HTML + Alpine x-data="spill")
  site.js             # All JS: IIFE, Alpine.data('spill', ...) registration
  site.css            # Minimal custom styles (21 lines)
  api/upload.py       # Vercel serverless: image upload → Google Cloud Document AI → JSON
  requirements.txt    # Python deps (pinned)
  vercel.json         # Vercel config (maxDuration: 60 for upload)
```

## Architecture
- **Zero build step** — plain HTML/CSS/JS served statically on Vercel
- **Single Alpine component** (`spill`) with state: `total`, `items`, `people`, `billData`, `mbrData`
- **URL state:** total/items/people synced to query params via `setParams`/`getParams`
- **Persistent state:** `mbrData` (stacked bills) and `roundDecimals` via `this.$persist()`
- **Auto-compute:** `$watch('total')`, `$watch('items')`, `$watch('people')`, `$watch('roundDecimals')` trigger `compute()`
- **MBR (Multi-Bill Rollup):** Stack bills → calculate balances → generate optimized settlement transactions (greedy match largest credit/debt)

## Conventions
- **JS:** `camelCase` for vars/functions, IIFE wrapper, no modules/imports
- **Python:** `snake_case`, env vars via `os.environ`, `BaseHTTPRequestHandler`
- **Error handling:** `try/catch` in JS sets `this.error`; `try/except` in Python returns 500
- **Clipboard:** `execCommand('copy')` fallback → `navigator.clipboard.writeText()`
- **CSS:** Bootstrap classes everywhere; `.fs-7` custom utility; keep minimal (21 lines)
- **No tests, no linting/formatting config** — quality is manual

## Key Helpers (site.js)
- `parseAmount(amount)` — parses float, rounds to whole if `roundDecimals` else 2 decimals
- `formatNumber(num)` — comma-separated, respects `roundDecimals`
- `settleBalances(balances)` — greedy algorithm returning `{from, to, amount}[]`
- `copyText(text)` — dual-strategy clipboard copy
- `formatDate(date)` — returns "Mon DD, HH:MM"

## Receipt Upload Flow
1. User picks image → resized via Pica (max 1200px) → JPEG 0.7 quality
2. POST `/api/upload` → Python handler sends raw image to Google Cloud Document AI Expense Parser → returns `{total, items: [{name, amount}]}`
3. Frontend populates total/items fields

## Env Vars (Vercel)
- `GOOGLE_PROJECT_ID` — GCP project ID
- `GOOGLE_LOCATION` — Document AI processor location (e.g. `us`)
- `GOOGLE_PROCESSOR_ID` — Expense Parser processor ID
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` — service account key (JSON string)

## Local Dev
```bash
pip install -r requirements.txt   # Python deps
vercel dev                        # Local server (requires Vercel CLI)
vercel deploy                     # Deploy to Vercel
```
