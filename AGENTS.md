# Spill

## Project Overview

Spill is a small browser-based bill splitter. It divides item costs between people, allocates the difference between the item subtotal and the paid total as a proportional fee, and can combine multiple bills into a settlement summary.

## Development

This is a zero-build project. There is no npm package, bundler, TypeScript setup, or automated test suite.

Run the static site locally with:

```bash
python -m http.server
```

Receipt scanning requires the Vercel function, Python dependencies, and an `OPENAI_API_KEY` environment variable. `RECEIPT_MODEL` optionally overrides the vision model (defaults to a cheap vision tier). Use Vercel CLI for local API testing:

```bash
python -m pip install -r requirements.txt
vercel dev
```

The deployed site is hosted on Vercel. `vercel.json` configures `api/upload.py` with a 60-second maximum duration.

## Structure

- `index.html` — page markup and Alpine.js bindings, in three blocks: Input card, Result, Stack bills
- `site.js` — all logic, in this order: settings (`CONFIG`, `STORAGE`), number helpers, text parsing, URL state, formatting/settlement, clipboard, then the `spill` Alpine component (setup, bill, assignment, receipt, output, stacked bills, formatting) and small local helpers at the end
- `site.css` — tokens and components, grouped as: tokens, base, layout, fields, buttons, chips/item rows, tables, stack-bills accent, accordion, responsive
- `api/upload.py` — Vercel Python function that resizes/grayscales an uploaded receipt, sends it to a vision model, and returns extracted JSON
- `requirements.txt` — pinned Python dependencies for receipt scanning

The frontend loads Alpine.js, Alpine Persist, Bootstrap, Notyf, and Pica from CDN URLs in `index.html`.

Component names to keep consistent when editing: `totalPaid`, `itemText`, `nameText`, `people`, `shares`, `items`, `pillRows`, `bill`, `stack`, `stackTotals`; methods `recalculate()`, `recalculateStack()`, `syncUrlState()`, `cycleShare()`, `shareEveryone()`, `normalizeNames()`, `saveBill()`, `deleteBill()`, `clearBills()`, `copyBillSummary()`, `copyShareLink()`, `copySettlement()`, `roundAmount()`, `formatAmount()`.

## Core Behavior

- One Input card holds three fields: **People's initials**, **Item prices**, and **Total paid (optional)**. Inputs use the default sans-serif font; the price field grows with its content, never scrolls vertically, and scrolls sideways instead of wrapping. Placeholders are `PP MJ`, two prices, and `55000`.
- Input and Result are always-expanded cards; Stack bills starts collapsed.
- Per-field guidance stays out of paragraphs under the fields.
- Prices are entered or pasted into one field; each line (or bare comma/space-separated amount) becomes an item. Lines may carry a name, as `Name 30.000` or `30.000 - Name`; the name stays visible in the field but is not used in calculations.
- Amounts accept loose input: currency symbols, thousands separators (`.`, `,`, spaces), and decimal commas.
- People's initials is a single-line field; only whitespace separates names, every other symbol is dropped and names keep letters only, so they are uppercased, deduplicated, sorted, and displayed space-separated on blur; they are not persisted and come from input or a share link only.
- The Item prices field is split 1:2: the price textarea on the left and the untitled chip rows on the right, the latter shown once there are both prices and names. Skipped and blank lines keep an empty chip row so the rows stay aligned with the text. There is no bulk reset, only a per-row `All` chip; the chip rows scroll sideways together as one strip.
- An item with no name selected is shared by everyone in the roster.
- Tapping a selected name cycles ×1 → ×2 → off so an item can split unevenly: `A×2 + B×1` gives A two thirds of that item.
- Missing prices or names are an empty state, not an error; only an invalid total (non-empty, `<= 0`) errors.
- The Result table has `No`, `Price`, `W. fee (X%)`, then one column per person; its footer starts with `Total` and shows the subtotal, the total with fee, and each person's total. `No`, `Bill`, `From`, and `To` are left-aligned; `Price` and the amounts are right-aligned.
- The fee is `(paid total - item subtotal) / item subtotal` and is distributed proportionally across items and people. An empty total means no fee.
- The `Round numbers` switch (`roundWhole`) toggles between whole numbers and two decimal places.
- The bill is encoded in URL query parameters so the `Link` action can share it: `total`, `items` (prices, newline-separated, written as `|`), `p` (roster, `|`-separated), and `a` (per item, comma-separated `NAME` or `NAME+weight` tokens, items separated by `|`). Legacy links with `people` lines are still read, where a repeated name counts as its weight.
- Scanning a receipt fills the total and the price list as `amount - name` lines and clears assignments; it never touches the name list.
- Stacked bills live in the mild-yellow Stack bills card, persisted with Alpine Persist: `Who paid?` and `Bill Name (Optional)` feed the `Save bill` button, and saved bills roll up into Total paid / Total spent / Balance plus the settlement. The stack only tracks people who paid a bill or hold a non-zero share; everyone else is dropped on save, load and delete. The payer may be any name in the roster, including someone with no share of that bill; a payer with no share renders `0` rather than a blank cell.
- The settlement shows `No settlement needed` (and hides its table) when every balance is zero.
- Persisted state is limited to `spill:bills` and `spill:roundWhole`; no other keys are read or written.
- Settlement balances are matched into debtor-to-creditor transactions by `settleBalances()`. A negative balance means the person owes money.

## Change Guidelines

- Keep the zero-build architecture and existing CDN dependencies unless a change genuinely requires new tooling.
- Keep all user-visible calculations consistent with `parseNumber()` and `formatAmount()`.
- Preserve shareable-link compatibility when changing input or URL state handling.
- Treat receipt OCR output as untrusted: validate the response before using it and never expose `OPENAI_API_KEY` to the browser.
- Do not commit secrets, uploaded receipt data, `.vercel` contents, or local environment files.
- Keep the interface mobile-friendly; this app is commonly used while people are sharing a bill.
- Keep the UI monochrome except the mild-yellow accent used by the Stack bills card, the `Scan receipt` button, and the per-person totals in the Result footer, and reuse the tokens/components in `site.css` instead of introducing new colors or fonts.
- Verify calculation changes with representative cases including shared items, fees, rounding, invalid input, and multiple stacked bills.

## Verification

For frontend-only changes, open the site in a browser and check bill calculation, empty states, shareable links, copy actions, rounding, and stacked-bill settlement. The page must stay free of horizontal overflow at mobile widths (test ~390 px); the price field grows vertically with its content and scrolls sideways instead of wrapping.

For receipt scanning changes, run `vercel dev`, set `OPENAI_API_KEY` in the local environment, and test a representative receipt without logging or committing the image or API key. A scanned receipt should fill the total, produce `amount - name` lines, clear assignments, and leave the People list untouched.
