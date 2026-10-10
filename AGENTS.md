# Spill

## Project Overview

Spill is a small browser-based bill splitter. It divides item costs between people, allocates the difference between the item subtotal and the paid total as a proportional fee, and can combine multiple bills into a settlement summary.

## Development

This is a zero-build project. There is no npm package, bundler, TypeScript setup, or automated test suite.

Run the static site locally with:

```bash
python -m http.server
```

Receipt scanning requires the Vercel function, Python dependencies, and an `OPENAI_API_KEY` environment variable. Use Vercel CLI for local API testing:

```bash
python -m pip install -r requirements.txt
vercel dev
```

The deployed site is hosted on Vercel. `vercel.json` configures `api/upload.py` with a 60-second maximum duration.

## Structure

- `index.html` — page markup and Alpine.js bindings
- `site.js` — all bill calculation, URL state, persistence, clipboard, image upload, and settlement logic
- `site.css` — small project-specific CSS overrides
- `api/upload.py` — Vercel Python function that resizes an uploaded receipt, sends it to OpenAI vision, and returns extracted JSON
- `requirements.txt` — pinned Python dependencies for receipt scanning

The frontend loads Alpine.js, Alpine Persist, Bootstrap, Notyf, and Pica from CDN URLs in `index.html`.

## Core Behavior

- Items and people are entered one line at a time; each item line must correspond to one people line.
- A people line may contain multiple names when an item is shared.
- Names are normalized to uppercase for calculations.
- The fee is `(paid total - item subtotal) / item subtotal` and is distributed proportionally across items and people.
- `roundDecimals` controls whether amounts are rounded to whole numbers or two decimal places.
- The current bill is encoded in URL query parameters so the `Link` action can share it.
- Stacked bills are persisted with Alpine Persist in browser local storage.
- Settlement balances are matched into debtor-to-creditor transactions by `settleBalances()`.

## Change Guidelines

- Keep the zero-build architecture and existing CDN dependencies unless a change genuinely requires new tooling.
- Keep all user-visible calculations consistent with `parseAmount()` and `formatNumber()`.
- Preserve shareable-link compatibility when changing input or URL state handling.
- Treat receipt OCR output as untrusted: validate the response before using it and never expose `OPENAI_API_KEY` to the browser.
- Do not commit secrets, uploaded receipt data, `.vercel` contents, or local environment files.
- Keep the interface mobile-friendly; this app is commonly used while people are sharing a bill.
- Verify calculation changes with representative cases including shared items, fees, rounding, invalid input, and multiple stacked bills.

## Verification

For frontend-only changes, open the site in a browser and check bill calculation, shareable links, copy actions, rounding, and stacked-bill settlement.

For receipt scanning changes, run `vercel dev`, set `OPENAI_API_KEY` in the local environment, and test a representative receipt without logging or committing the image or API key.
