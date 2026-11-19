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

- `index.html` — page markup and Alpine.js bindings, in four blocks: Input card, Assign, Result, Stack bills
- `site.js` — all logic, in this order: settings (`CONFIG`, `STORAGE`), storage helpers, number helpers, text parsing, URL state, formatting/settlement, then the `spill` Alpine component (setup, bill, receipt, output, stacked bills, formatting) and small local helpers at the end
- `site.css` — tokens and components, grouped as: tokens, base, layout, fields, buttons, chips/item rows, tables, stack-bills accent, accordion, responsive
- `api/upload.py` — Vercel Python function that resizes an uploaded receipt, sends it to OpenAI vision, and returns extracted JSON
- `requirements.txt` — pinned Python dependencies for receipt scanning

The frontend loads Alpine.js, Alpine Persist, Bootstrap, Notyf, and Pica from CDN URLs in `index.html`.

Component names to keep consistent when editing: `totalPaid`, `itemText`, `nameText`, `people`, `shares`, `items`, `bill`, `stack`, `stackTotals`; methods `recalculate()`, `recalculateStack()`, `syncUrlState()`, `cycleShare()`, `shareEveryone()`, `saveBill()`, `clearBills()`, `copyBillSummary()`, `copySettlement()`, `roundAmount()`, `formatAmount()`.

## Core Behavior

- One Input card holds three fields: **Total paid**, **Item prices**, and **People**. Inputs use the default sans-serif font; the two list fields auto-grow with their content and never scroll internally.
- Input, Assign, and Result are always-expanded cards; Stack bills starts collapsed.
- Per-field guidance stays out of paragraphs under the fields.
- Prices are entered or pasted into one field; each line (or bare comma/space-separated amount) becomes an item. Lines may carry a name, as `Name 30.000` or `30.000 - Name`, which is kept as the item label.
- Amounts accept loose input: currency symbols, thousands separators (`.`, `,`, spaces), and decimal commas.
- People is one name per line (commas/semicolons also split); names are uppercased, deduplicated and sorted on blur, and persisted in `localStorage` under `spill:names`.
- The Assign section only appears once there are both prices and names. Each row shows the item label and price (no index) followed by tap chips; the section has no bulk reset, only a per-row `Everyone` chip.
- An item with no name selected is shared by everyone in the roster.
- Tapping a selected name raises its weight (×2, ×3) so an item can split unevenly: `A×2 + B×1` gives A two thirds of that item. Tapping past ×3 unselects the name for that item.
- Missing prices or names are an empty state, not an error; only an invalid total (non-empty, `<= 0`) errors.
- The Result table has `Price`, `W. fee (X%)`, then one column per person; its footer shows the subtotal, the total with fee, and each person's total.
- The fee is `(paid total - item subtotal) / item subtotal` and is distributed proportionally across items and people. An empty total means no fee.
- `roundDecimals` controls whether amounts are rounded to whole numbers or two decimal places.
- The bill is encoded in URL query parameters so the `Link` action can share it: `total`, `items` (prices, newline-separated, written as `|`), `p` (roster, `|`-separated), and `a` (per item, comma-separated `NAME` or `NAME+weight` tokens, items separated by `|`). Legacy links with `people` lines are still read, where a repeated name counts as its weight.
- Scanning a receipt fills the total and the price list as `amount - name` lines and clears assignments; it never touches the name list.
- Stacked bills live in the mild-yellow Stack bills card, persisted with Alpine Persist: `Who paid?` and `Bill name` feed the `Save current bill` button, and saved bills roll up into Total spent / Total paid / Balance plus the settlement. The payer may be any name in the roster, including someone with no share of that bill; a payer with no share renders `0` rather than a blank cell.
- The settlement shows `No settlement needed` (and hides its table) when every balance is zero.
- Persisted state uses explicit keys: `spill:names`, `spill:bills`, and `spill:roundWhole`; older `spill:roster` and `_x_*` values are migrated on load.
- Settlement balances are matched into debtor-to-creditor transactions by `settleBalances()`.

## Change Guidelines

- Keep the zero-build architecture and existing CDN dependencies unless a change genuinely requires new tooling.
- Keep all user-visible calculations consistent with `parseAmount()` and `formatNumber()`.
- Preserve shareable-link compatibility when changing input or URL state handling.
- Treat receipt OCR output as untrusted: validate the response before using it and never expose `OPENAI_API_KEY` to the browser.
- Do not commit secrets, uploaded receipt data, `.vercel` contents, or local environment files.
- Keep the interface mobile-friendly; this app is commonly used while people are sharing a bill.
- Keep the UI monochrome except the Stack bills card's mild-yellow accent, and reuse the tokens/components in `site.css` instead of introducing new colors or fonts.
- Verify calculation changes with representative cases including shared items, fees, rounding, invalid input, and multiple stacked bills.

## Verification

For frontend-only changes, open the site in a browser and check bill calculation, empty states, shareable links, copy actions, rounding, and stacked-bill settlement. The page must stay free of horizontal overflow at mobile widths (test ~390 px), and the two list fields must grow with their content instead of scrolling.

For receipt scanning changes, run `vercel dev`, set `OPENAI_API_KEY` in the local environment, and test a representative receipt without logging or committing the image or API key. A scanned receipt should fill the total, produce `amount - name` lines, clear assignments, and leave the People list untouched.
