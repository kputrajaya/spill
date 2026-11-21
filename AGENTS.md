# Spill

## Project Overview

Spill is a small browser-based bill splitter. It divides item costs between people, allocates the difference between the item subtotal and the paid total as a proportional fee, and can combine multiple bills into a settlement summary.

## Development

This is a zero-build project. There is no npm package, bundler, or TypeScript setup. Tests run directly with Node: `node tests/site.test.js`.

Run the static site locally with:

```bash
python -m http.server
```

Receipt scanning requires the Vercel function, Python dependencies, an `OPENAI_API_KEY` environment variable, and a `HOST` environment variable for origin checks. Requests fail closed when `HOST` is missing. `RECEIPT_MODEL` optionally overrides the vision model (defaults to a cheap vision tier). Use Vercel CLI for local API testing:

```bash
python -m pip install -r requirements.txt
vercel dev
```

The deployed site is hosted on Vercel. `vercel.json` configures `api/upload.py` with a 60-second maximum duration.

## Structure

- `index.html` — page markup and Alpine.js bindings, in three blocks: Input card, Result, Stack bills
- `site.js` — all app logic; exports the `spill` namespace for Node tests and returns before DOM setup outside a browser. See Organization for section order and state model.
- `tests/site.test.js` — Node checks for parsing, splitting, share links, and settlement; not loaded by `index.html`.
- `site.css` — tokens and components, grouped as: tokens, base, layout, fields, buttons, chips/item rows, tables, stack-bills details, responsive
- `api/upload.py` — Vercel Python function that resizes/grayscales an uploaded receipt, sends it to a vision model with a 30-second timeout, and returns extracted JSON. Requires `HOST`; requests fail closed when it is missing and only same-origin browsers are accepted.
- `requirements.txt` — pinned Python dependencies for receipt scanning

The frontend loads Alpine.js, Alpine Persist, and Bootstrap CSS from CDN URLs in `index.html`. Toasts are native app markup/CSS.

## Organization

- `index.html` — markup and Alpine bindings only; no business logic.
- `site.js` — section order: Settings, Money, Text parsing, Bill calculation, Share helpers, Settlement, URL state, Formatting, DOM helpers, Exports, Alpine component.
- `site.css` — design tokens and component styles.
- `api/upload.py` — Vercel handler; secrets and external calls stay server-side.
- `tests/site.test.js` — Node-only tests; never loaded by the app.

State model:

- Source state: `totalPaid`, `itemText`, `nameText`, `shares`, `bill`, `stack`, `stackTotals`, `stackPayer`, `stackNote`, `roundWhole`.
- Derived getters: `parsedItems`, `people`, `assignmentItems`, `chipRows`, `warning`, `payerOptions`, `stackPeople`.
- Cached computed: `bill`, `stackTotals` because calculation and settlement are more expensive than simple derivation.
- Persisted: `spill:bills` and `spill:roundWhole` only. `stackPeople` is derived, not persisted.

Component methods to keep consistent when editing: `recalculate()`, `recalculateStack()`, `scheduleUrlSync()`, `cycleShare()`, `shareEveryone()`, `normalizeNames()`, `saveBill()`, `deleteBill()`, `clearBills()`, `copyBillSummary()`, `copyShareLink()`, `copySettlement()`, `roundAmount()`, `formatAmount()`. Pure helpers exported as `spill`: `parseNumber`, `parseItems`, `parseNames`, `sanitizeName`, `clampShare`, `toMinor`, `fromMinor`, `roundAmount`, `formatAmount`, `calculateBill`, `parseShares`, `encodeShares`, `settleBalances`, `settleGreedy`, `EXACT_LIMIT`.

## Architecture Decisions

- Keep the zero-build architecture. Bootstrap CSS is used for form/layout primitives; Bootstrap JS, Pica, Notyf, and the browser test runner were removed. Stack bills uses native `<details>` and toasts use a native `role="status"` stack.
- Keep a pure core plus a stateful Alpine shell. `site.js` exports the `spill` namespace and returns before DOM setup when `document` is unavailable, so Node tests use the production functions.
- Calculate money in integer minor units (`MINOR_DECIMALS = 2`, `MINOR_UNIT = 100`). Use largest-remainder allocation so item shares and person totals sum exactly to their targets. Do not introduce major-unit float calculations.
- Accept display-level rounding differences: independently rounded item-price cells may not sum to the displayed subtotal, and rounded totals may not exactly reconstruct `feePercent`. Per-portion allocation and settlement must stay exact.
- Settlement first matches exact opposites (`+9` / `-9`), then finds minimum transfers by maximizing zero-sum groups for up to 10 remaining nonzero balances. Larger remainders use the old largest-first greedy fallback. Exact 30 is not feasible with the subset algorithm.
- Use compact URL params `t`, `i`, `p`, and `a`. Newly generated links must stay compatible; legacy `total`/`items` links are intentionally unsupported.
- Item prices and total paid use the same rule: first standalone amount token. Item lines become at most one item; spaces split tokens, so `6 000` reads as `6`; semicolons and space thousands separators are not supported.
- Assignment weights cap at ×2; `All` clears an item’s assignments and shares it equally. Missing assignments mean everyone shares.
- Receipt OCR preserves printed separators; the browser `parseNumber()` normalizes them. The API does not duplicate that logic.
- API requests fail closed without `HOST`; only same-origin `Origin`/`Referer` requests pass. This is CSRF protection, not authentication. Use Vercel WAF rate limiting (dashboard, not repo code) for abuse protection. OpenAI calls have a 30-second timeout and capped completion tokens; server failures are logged.
- Older saved bills using legacy field names are not migrated, and old link formats are not read.
- Tests cover pure parsing, splitting, rounding, share links, and settlement. GitHub Actions runs `node tests/site.test.js` on push and pull requests; browser/Alpine behavior still requires manual verification.

## Core Behavior

- One Input card holds three fields: **People's initials**, **Item prices**, and **Total paid (optional)**. Inputs use the default sans-serif font; the price field grows with its content, never scrolls vertically, and scrolls sideways instead of wrapping. Placeholders are `PP MJ`, two prices, and `55000`.
- Input and Result are always-expanded cards; Stack bills starts collapsed.
- Per-field guidance stays out of paragraphs under the fields.
- Prices are entered or pasted into one field; each line becomes at most one item, using its first standalone amount. Later numbers on the same line, such as quantities or package sizes, are ignored. Lines may carry a name, as `Name 30.000` or `30.000 - Name`; the name stays visible in the field but is not used in calculations.
- Amounts accept loose input: currency symbols separated by whitespace, thousands separators (`.`, `,`), and decimal commas. If both separators appear, the rightmost is decimal. A single separator followed by three digits is thousands, so `6.000`, `6,000`, `6.000,00`, and `6,000.00` all become `6000`. Spaces split tokens, so `6 000` reads as `6`. A malformed amount such as `6x0j00` is skipped with a warning.
- People's initials is a single-line field; only whitespace separates names, every other symbol is dropped and names keep letters only, so they are uppercased, deduplicated, sorted, and displayed space-separated on blur; they are not persisted and come from input or a share link only.
- The Item prices field is split 1:2: the price textarea on the left and the untitled chip rows on the right, the latter shown once there are both prices and names. Skipped and blank lines keep an empty chip row so the rows stay aligned with the text. There is no bulk reset, only a per-row `All` chip; the chip rows scroll sideways together as one strip.
- An item with no name selected is shared by everyone in the roster.
- Tapping a selected name cycles ×1 → ×2 → off so an item can split unevenly: `A×2 + B×1` gives A two thirds of that item.
- Missing prices or names are an empty state, not an error; only an invalid total (non-empty, unparseable, or `<= 0`) errors, shown directly under the Total paid field.
- The Result table has `No`, `Price`, `W. fee (X%)`, then one column per person; its footer starts with `Total` and shows the subtotal, the total with fee, and each person's total. `No`, `Bill`, `From`, and `To` are left-aligned; `Price` and the amounts are right-aligned.
- The fee is `(paid total - item subtotal) / item subtotal` and is distributed proportionally across items and people. An empty total means no fee. `calculateBill()` owns this pure calculation; it accepts `{ total, items, people, shares, roundWhole }` and returns `{ bill, error }`. All money is calculated in integer minor units with largest-remainder allocation, so person totals and item shares sum exactly to their totals.
- The `Round numbers` switch (`roundWhole`) toggles between whole numbers and two decimal places.
- The bill is encoded in URL query parameters so the `Link` action can share it: `t` (total paid), `i` (item prices, newline-separated, written as `|`), `p` (roster, `|`-separated), and `a` (per item, comma-separated `NAME` or `NAME+weight` tokens, items separated by `|`).
- Scanning a receipt fills the total and the price list as `amount - name` lines and clears assignments; it never touches the initials field. The model preserves printed separators and `parseNumber()` normalizes them in the browser, so `2.000`, `2,000`, `2,000.00`, and `2.000,00` all become `2000`.
- Stacked bills live in the mild-yellow Stack bills card, persisted with Alpine Persist: `Who paid?` and `Bill Name (Optional)` feed the `Save bill` button, and saved bills roll up into Total paid / Total spent / Balance plus the settlement. Stack people are derived from saved bills, not persisted. The stack only tracks people who paid a bill or hold a non-zero share; everyone else is dropped on save, load and delete. The payer may be any name in the roster, including someone with no share of that bill; a payer with no share renders `0` rather than a blank cell.
- The settlement shows `No settlement needed` (and hides its table) when every balance is zero.
- Persisted state is limited to `spill:bills` and `spill:roundWhole`; no other keys are read or written.
- Settlement balances are matched into debtor-to-creditor transactions by `settleBalances()` in `site.js`. It first settles exact opposites, then maximizes zero-sum groups on the remainder to get the minimum transaction count, settling each group largest-first. Above 10 remaining nonzero balances it falls back to the greedy largest-first solver. A negative balance means the person owes money.

## Change Guidelines

- Keep the zero-build architecture and existing CDN dependencies unless a change genuinely requires new tooling. Do not reintroduce Bootstrap JS or Pica.
- Keep all user-visible calculations consistent with `parseNumber()`, `toMinor()`/`fromMinor()`, and `formatAmount()`. Do not add money calculations in floating-point major units.
- Preserve newly generated share links when changing input or URL state handling. Legacy `total`/`items` links are intentionally unsupported.
- Keep cheap derivations as getters and expensive values (`bill`, `stackTotals`) cached; do not reintroduce parallel mutable copies such as persisted stack people.
- Treat receipt OCR output as untrusted: validate the response before using it and never expose `OPENAI_API_KEY` to the browser.
- Do not treat `Origin`/`Referer` checks as authentication. Rate limiting belongs in Vercel WAF or another server-side control.
- Do not commit secrets, uploaded receipt data, `.vercel` contents, or local environment files.
- Keep the interface mobile-friendly; this app is commonly used while people are sharing a bill.
- Keep the UI monochrome except the mild-yellow accent used by the Stack bills card, the `Scan receipt` button, and the per-person totals in the Result footer, and reuse the tokens/components in `site.css` instead of introducing new colors or fonts.
- Verify calculation changes with representative cases including shared items, fees, rounding, invalid input, and multiple stacked bills.

## Verification

For settlement or split-calculation changes, run `node tests/site.test.js`. The test suite is never loaded by `index.html`.

For frontend-only changes, open the site in a browser and check bill calculation, empty states, shareable links, copy actions, rounding, and stacked-bill settlement. The page must stay free of horizontal overflow at mobile widths (test ~390 px); the price field grows vertically with its content and scrolls sideways instead of wrapping.

For receipt scanning changes, run `vercel dev`, set `OPENAI_API_KEY` in the local environment, and test a representative receipt without logging or committing the image or API key. A scanned receipt should fill the total, produce `amount - name` lines, clear assignments, leave the initials field untouched, and let `parseNumber()` normalize `2.000`-style amounts to `2000`.
