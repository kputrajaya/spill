# Spill

## Project Overview

Spill is a small browser-based bill splitter with two pages:

- `/` divides item costs between people, allocates the difference between the item subtotal and the paid total as a proportional fee, and can send the result to settlement.
- `/settle/` keeps a local ledger of transactions, shows each person's balance, and produces the smallest practical set of settlement transfers.

## Development

This is a zero-build project. There is no npm package, bundler, or TypeScript setup. Tests run directly with Node:

```bash
node tests/site.test.js
node tests/settle.test.js
```

Run the static site locally with:

```bash
python -m http.server
```

Receipt scanning requires the Vercel function, Python dependencies, an `OPENAI_API_KEY` environment variable, and a `HOST` environment variable for origin checks. Requests fail closed when `HOST` is missing. `RECEIPT_MODEL` optionally overrides the vision model (defaults to a cheap vision tier). Use Vercel CLI for local API testing:

```bash
python -m pip install -r requirements.txt
vercel dev
```

The deployed site is hosted on Vercel. `vercel.json` configures `api/upload.py` with a 60-second maximum duration. The settle page is a static directory index at `settle/index.html`.

## Structure

- `index.html` — split page markup and Alpine.js bindings: Input card and Result
- `site.js` — split page logic; imports the shared core, exports the `spill` namespace for Node tests, and returns before DOM setup outside a browser
- `shared.js` — zero-build shared helpers: money parsing/allocation, formatting, timestamps, settlement solver, and browser toast/clipboard utilities. Exposed as `window.SpillCore` in browsers and `module.exports` in Node.
- `settle/index.html` — settle page markup and Alpine.js bindings
- `settle/settle.js` — pure settle ledger logic plus the Alpine component and sync wiring; exports the `settle` namespace for Node tests and returns before DOM setup outside a browser
- `settle/settle.css` — settle-page components layered on the shared tokens in `site.css`
- `tests/site.test.js` — Node checks for parsing, splitting, share links, and settlement solver
- `tests/settle.test.js` — Node checks for split modes, ledger totals, handoff validation, and storage normalization
- `site.css` — tokens and components, grouped as: tokens, base, layout, fields, buttons, chips/item rows, tables, responsive
- `api/upload.py` — Vercel Python function that resizes/grayscales an uploaded receipt, sends it to a vision model with a 30-second timeout, and returns extracted JSON. Requires `HOST`; requests fail closed when it is missing and only same-origin browsers are accepted.
- `requirements.txt` — pinned Python dependencies for receipt scanning

Both pages load Alpine.js, Alpine Persist, and Bootstrap CSS from CDN URLs. The settle page also loads the PubSub SDK. `shared.js` loads before `site.js` and before `settle.js`. Toasts are native app markup/CSS.

## Organization

- `index.html` — markup and Alpine bindings only; no business logic.
- `site.js` — section order: Shared core, Settings, Text parsing, Bill calculation, Share helpers, URL state, Exports, Alpine component.
- `settle/index.html` — balances, settlement, transaction list, floating add/edit sheet, people settings dialog.
- `settle/settle.js` — section order: Names and ids, Shares, Ledger, Handoff, State, Sync, Alpine component.
- `shared.js` — Money, Settlement, Formatting, Browser UI helpers.
- `site.css` — shared design tokens and components.
- `settle/settle.css` — settle-only layout, split-mode, manual-input, and dialog styles.
- `api/upload.py` — Vercel handler; secrets and external calls stay server-side.
- `tests/*.test.js` — Node-only tests; never loaded by either page.

Root state model:

- Source state: `totalPaid`, `itemText`, `nameText`, `shares`, `bill`, `roundWhole`.
- Derived getters: `parsedItems`, `people`, `assignmentItems`, `chipRows`, `warning`.
- Cached computed: `bill`.
- Persisted: `spill:roundWhole` only.

Root component methods to keep consistent when editing: `recalculate()`, `scheduleUrlSync()`, `cycleShare()`, `shareEveryone()`, `normalizeNames()`, `sendToSettle()`, `copyBillSummary()`, `copyShareLink()`, `roundAmount()`, `formatAmount()`. Pure helpers exported as `spill`: `parseNumber`, `parseItems`, `parseNames`, `sanitizeName`, `clampShare`, `toMinor`, `fromMinor`, `roundAmount`, `formatAmount`, `calculateBill`, `parseShares`, `encodeShares`, `settleBalances`, `settleGreedy`, `EXACT_LIMIT`.

Settle ledger state, persisted under `spill:settle` (sync code under `spill:settle:syncKey`; display rounding shares `spill:roundWhole` with the split page):

```js
{
  people: [{ id, name }],
  transactions: [{
    id,
    name,
    payerId,
    amount,      // integer minor units
    mode,        // 'equal' | 'owed' | 'manual'
    shares,      // { [personId]: integer minor units }; zero shares omitted
    createdAt,
  }],
}
```

- Default people are `John` and `Jane` with generated stable IDs.
- Derived: `balanceRows`, `transfers`, `sortedTransactions`, form preview and validation getters.
- Root `spill:bills` is not read, written, or migrated.

## Architecture Decisions

- Keep the zero-build architecture. Bootstrap CSS is used for form/layout primitives; Bootstrap JS, Pica, Notyf, and the browser test runner were removed. Toasts use a native `role="status"` stack; settle settings use a native `<dialog>`.
- Keep a pure core plus stateful Alpine shells. `shared.js`, `site.js`, and `settle/settle.js` export their pure helpers for Node and return before DOM setup when `document` is unavailable. Keep one page script per page rather than splitting sync/UI into extra files.
- Calculate money in integer minor units (`MINOR_DECIMALS = 2`, `MINOR_UNIT = 100`). Use largest-remainder allocation so item shares, transaction shares, and person totals sum exactly to their targets. Do not introduce major-unit float calculations.
- Accept display-level rounding differences on the split result: independently rounded item-price cells may not sum to the displayed subtotal, and rounded totals may not exactly reconstruct `feePercent`. Per-portion allocation and settlement must stay exact.
- Settlement first matches exact opposites (`+9` / `-9`), then finds minimum transfers by maximizing zero-sum groups for up to 10 remaining nonzero balances. Larger remainders use the largest-first greedy fallback.
- Use compact split-page URL params `t`, `i`, `p`, and `a`. Newly generated links must stay compatible; legacy `total`/`items` links are intentionally unsupported.
- The split → settle handoff is a one-time URL payload, not a POST and not shared storage: `from=split`, `t` (total minor units), `p` (`|`-separated names), `a` (`|`-separated per-person totals, aligned with `p`). The settle page validates it, auto-adds unknown names, opens a prefilled manual transaction, then cleans the query string with `history.replaceState`. Handoffs and the settle roster are capped at 20 people.
- Optional live sync uses the same PubSub SDK and host as BOTC: `wss://pubsub.h.kvn.pt`, app key `spill`, and the channel key from `?k=`, giving `spill:<k>`. The settle page publishes the whole persisted ledger (`people` + `transactions`) as a full snapshot and applies remote snapshots after validation. No key param means local-only only when no stored key exists. `Copy sync link` in the Balances header generates a 30-character key when missing, stores it under `spill:settle:syncKey`, starts the connection, and copies the URL. A URL key wins and overwrites the stored key; without one, the stored key is appended to the URL on load and reused, including after a root handoff. The SDK needs `k` in the URL, so a temporary insert remains as a fallback during initialization. Keys are shared secrets, not authentication. On `localhost`, `127.0.0.1`, or `0.0.0.0` the page connects to `ws://localhost:8075` instead, because the deployed host rejects local origins with a 403; run the PubSub project's `node server.js` for local sync.
- `parseNumber()` takes the first amount-looking whitespace-separated token, so `6 000` reads as `6` while `Rp 73.150` reads as `73150`. Item lines and the total use the same rule.
- Transaction split modes:
  - `equal` (`To everyone`) — the amount is shared by every participant, payer included. The payer's own share is attributed but is never a debt.
  - `owed` (`To non-payers`) — the amount is what the others owe; it is split across non-payers only and the payer's share is `0`.
  - `manual` — one per-person share including the payer; shares must add up exactly to the amount.
- Balances: `paid` is the sum of transaction amounts a person paid; `spent` is the sum of their own shares across all transactions; `balance = paid - spent`. The payer's own share cancels out, so this matches the earlier credit/debt math.
- Participant names are free text (trimmed, collapsed spaces, max 24 chars, case-insensitive uniqueness, display case preserved). Transactions store participant IDs so renames cascade. A participant referenced as a payer or with a non-zero share cannot be removed.
- Older root data under `spill:bills` is deliberately left untouched and unreachable after the settlement move. No migration.
- Tests cover pure parsing, splitting, rounding, share links, settlement, split modes, ledger math, handoff validation, and storage normalization. Browser/Alpine behavior still requires manual verification.

## Core Behavior

### Split page

- One Input card holds three fields: **People**, **Item prices**, and **Total amount (optional)**, plus the yellow `Scan receipt` button at the top right and the `Round numbers` switch at the bottom. Inputs use the default sans-serif font; the price field grows with its content, never scrolls vertically, and scrolls sideways instead of wrapping. Placeholders are `JOHN JANE`, two prices, and `55000`.
- Input and Result are always-expanded cards.
- Per-field guidance stays out of paragraphs under the fields.
- Prices are entered or pasted into one field; each line becomes at most one item, using its first standalone amount. Later numbers on the same line, such as quantities or package sizes, are ignored. Lines may carry a name, as `Name 30.000` or `30.000 - Name`; the name stays visible in the field but is not used in calculations.
- Amounts accept loose input: currency symbols separated by whitespace, thousands separators (`.`, `,`), and decimal commas. If both separators appear, the rightmost is decimal. A single separator followed by three digits is thousands, so `6.000`, `6,000`, `6.000,00`, and `6,000.00` all become `6000`. Spaces split tokens, so `6 000` reads as `6`. A malformed amount such as `6x0j00` is skipped with a warning.
- People is a single-line field; only whitespace separates names, every other symbol is dropped and names keep letters only, so they are uppercased, deduplicated, sorted, and displayed space-separated on blur; they are not persisted and come from input or a share link only.
- The Item prices field is split 1:2: the price textarea on the left and the untitled chip rows on the right, the latter shown once there are both prices and names. Skipped and blank lines keep an empty chip row so the rows stay aligned with the text. There is no bulk reset, only a per-row `All` chip; the chip rows scroll sideways together as one strip.
- An item with no name selected is shared by everyone in the roster.
- Tapping a selected name cycles ×1 → ×2 → off so an item can split unevenly: `A×2 + B×1` gives A two thirds of that item.
- Missing prices or names are an empty state, not an error; only an invalid total (non-empty, unparseable, or `<= 0`) errors, shown directly under the Total amount field.
- The Result table has `No`, `Price`, `W. fee (X%)`, then one column per person; its footer starts with `Total` and shows the subtotal, the total with fee, and each person's total. `No`, `Bill`, `From`, and `To` are left-aligned; `Price` and the amounts are right-aligned.
- The fee is `(paid total - item subtotal) / item subtotal` and is distributed proportionally across items and people. An empty total means no fee. `calculateBill()` owns this pure calculation; it accepts `{ total, items, people, shares, roundWhole }` and returns `{ bill, error }`.
- The `Round numbers` switch (`roundWhole`) at the bottom of the Input card toggles between whole numbers and two decimal places and shares its setting with the settle page.
- The bill is encoded in URL query parameters so `Copy link` can share it: `t` (total amount), `i` (item prices, newline-separated, written as `|`), `p` (roster, `|`-separated), and `a` (per item, comma-separated `NAME` or `NAME+weight` tokens, items separated by `|`).
- Scanning a receipt fills the total and the price list as `amount - name` lines and clears assignments; it never touches the people field. The model preserves printed separators and `parseNumber()` normalizes them in the browser.
- `Settle bills` sits in the page header at the top right. With a valid bill of at least two people it asks `Save the current bill for future settlement?` and then sends `bill.total` and each person's `bill.totals` in minor units to `/settle/` in the same tab. With no bill (or only one person) it skips the question and opens `/settle/` directly. It does not persist anything on the split page.

### Settle page

- Layout top to bottom: balances card, settlement card, transactions card. `Add transaction` is a floating bottom button; add/edit opens as a fixed bottom sheet the same width as the cards, not inside a card.
- The balances table is transposed: people are columns and the rows are `Paid`, `Spent`, `Balance`, shown with two decimals, or whole numbers when `Round numbers` is on. The `Round numbers` switch sits at the bottom of the Balances card, applies immediately, and shares its `spill:roundWhole` setting with the split page. Positive balance cells use a soft green background with ink text, negative cells soft red with ink text, and zero stays on the yellow accent. The separate settlement card is always visible below it; `Copy summary` copies the transfers plus a per-person paid/spent/balance summary. Each transfer row has a right-aligned `×` action, matching transaction deletes, that asks for confirmation and then records a `Settlement Payment` transaction: payer is the transfer's `From`, and the full amount is attributed to the `To` share, so the balances offset.
- Transactions are listed newest first with the fallback date under the name. The table has `Name`, `Total`, one column per person, and delete. Payer cells carry a `P` badge; non-payer zero shares stay blank. Clicking a row edits it in place using the same form; `×` deletes after confirmation. There is no hard transaction limit; above 300 transactions a persistent warning notes that a large ledger can impair performance and use more sync bandwidth.
- The add/edit form asks for amount, who paid, an optional transaction name, and a split mode (`To non-payers`, `To everyone`, `Input manually`). It defaults to `To non-payers`. A blank name becomes `Bill`; the created date is always shown under the name.
- `To everyone` and `To non-payers` show no per-person breakdown. `Input manually` shows editable rows for everyone; an under/over error appears inline to the left of the right-aligned Save/Cancel buttons only when the rows do not sum to the amount, and save stays disabled. No success message is shown.
- A split-bill handoff opens the form prefilled with the bill total and per-person totals, mode `manual`, payer unset. The user only picks who paid and saves.
- `Edit people` opens a native dialog to rename, add, or remove participants. Edits stay in a draft and are applied once when the dialog closes via Escape or a backdrop click, avoiding a sync per keystroke. Invalid or duplicate names block closing and show an error. Renames cascade through IDs. Removing a referenced participant is blocked with an explanatory message. At least two participants are kept.
- Balances show `No settlement needed` when every balance is zero.
- `Clear all` is a grey button in the Transactions card; it resets all transactions after confirmation, keeping the participant list and sync key.
- `Edit people` and `Copy sync link` sit in the Balances header, in that order. `Copy sync link` creates a 30-character key when needed, stores it in localStorage, copies the current URL with `?k=`, and connects the page to the PubSub channel. Later visits without `?k=` append the stored key to the URL, including root handoffs. Anyone with the link can read or change the ledger; changes sync as full-state snapshots with last write winning.
- Persisted state is limited to `spill:settle` and `spill:settle:syncKey` on this page, plus the shared `spill:roundWhole` display setting. Old `spill.settle.v1` and `spill.settle.syncKey` values are moved once on load. No other split-page state is shared.

## Change Guidelines

- Keep the zero-build architecture and existing CDN dependencies unless a change genuinely requires new tooling. Do not reintroduce Bootstrap JS or Pica.
- Keep all user-visible calculations consistent with `shared.js`: `parseNumber()`, `toMinor()`/`fromMinor()`, `distributeUnits()`, and `formatAmount()`. Do not add money calculations in floating-point major units.
- Keep shared money and settlement logic in `shared.js`; do not fork it into `settle.js`.
- Preserve newly generated share links when changing input or URL state handling. Legacy `total`/`items` links are intentionally unsupported.
- Preserve the `from=split&t=…&p=…&a=…` handoff contract and validate it as untrusted input.
- Publish only the persisted settle state through PubSub; never sync form drafts or settings drafts. Validate remote snapshots before applying them. Treat sync keys as shared secrets, not authentication.
- Treat transaction IDs and participant IDs as stable. Rename display names only; never key stored transactions by name.
- Keep cheap derivations as getters and expensive values (`bill`) cached; do not reintroduce parallel mutable state.
- Treat receipt OCR output as untrusted: validate the response before using it and never expose `OPENAI_API_KEY` to the browser.
- Do not treat `Origin`/`Referer` checks as authentication. Rate limiting belongs in Vercel WAF or another server-side control.
- Do not commit secrets, uploaded receipt data, `.vercel` contents, or local environment files.
- Keep both pages mobile-friendly; this app is commonly used while people are sharing a bill.
- Keep the UI monochrome except the mild-yellow accent used by accent buttons, the Result footer totals, and zero balance cells, plus the soft green/red balance-cell backgrounds; reuse the tokens/components in `site.css` and `settle.css` instead of introducing new colors or fonts.
- Verify calculation changes with representative cases including shared items, fees, rounding, invalid input, all three split modes, handoffs, and multiple transactions.

## Verification

For calculation or settlement changes, run both suites:

```bash
node tests/site.test.js
node tests/settle.test.js
```

For frontend changes, open both pages and check bill calculation, empty states, shareable links, copy actions, rounding, `Settle bills` handoff, add/edit/delete transactions, all split modes, settings rename/remove guards, persistence after reload, and settlement copying. For sync changes, open two tabs with the same `?k=` link and check that adding, editing, deleting, and renaming propagate both ways, while a tab without `k` stays local. Both pages must stay free of horizontal overflow at mobile widths (test ~390 px); the split price field grows vertically with its content and scrolls sideways instead of wrapping.

For receipt scanning changes, run `vercel dev`, set `OPENAI_API_KEY` in the local environment, and test a representative receipt without logging or committing the image or API key. A scanned receipt should fill the total, produce `amount - name` lines, clear assignments, leave the people field untouched, and let `parseNumber()` normalize `2.000`-style amounts to `2000`.
