(() => {
  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */

  const CONFIG = {
    maxImagePx: 2000,
    jpegQuality: 0.7,
    maxShare: 2,
    maxNameLength: 24,
  };

  // The only state that persists is the stacked bills and the rounding switch
  const STORAGE = {
    bills: 'spill:bills',
    roundWhole: 'spill:roundWhole',
  };

  // Money is stored in integer minor units; 2 decimals means cents.
  const MINOR_DECIMALS = 2;
  const MINOR_UNIT = 10 ** MINOR_DECIMALS;
  const TOAST_DURATION_MS = 2500;
  const URL_SYNC_DELAY_MS = 250;

  /* ------------------------------------------------------------------ */
  /* Money                                                              */
  /* ------------------------------------------------------------------ */

  const AMOUNT_TOKEN = /^\d[\d.,]*$/;

  // Accepts "Rp 73.150", "30,000", "30 000", "1.234.567,89", 27500
  const parseNumber = (raw) => {
    if (typeof raw === 'number') return raw;

    let text = String(raw == null ? '' : raw).trim();
    if (!text) return NaN;

    text = text.replace(/[^\d.,-]/g, '').replace(/-/g, '');
    if (!text) return NaN;

    const dot = text.lastIndexOf('.');
    const comma = text.lastIndexOf(',');
    if (dot === -1 && comma === -1) return parseFloat(text);

    const both = dot !== -1 && comma !== -1;
    const decimalSeparator = both ? (dot > comma ? '.' : ',') : null;
    const separator = decimalSeparator || (dot !== -1 ? '.' : ',');
    const other = separator === '.' ? ',' : '.';
    if (other !== separator) text = text.split(other).join('');

    const groups = text.split(separator);
    let decimals = decimalSeparator;
    if (!decimals) {
      // "30.000" and "1.234.567" are thousands, "1234.5" is decimal
      const last = groups[groups.length - 1];
      decimals = groups.length > 1 && last.length !== 3 ? separator : null;
    }
    if (!decimals) return parseFloat(groups.join(''));

    const tail = groups.pop();
    return parseFloat(`${groups.join('')}.${tail}`);
  };

  const parseFirstAmount = (raw) => {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    const token = text.split(/\s+/).find((part) => AMOUNT_TOKEN.test(part));
    return token ? parseNumber(token) : NaN;
  };

  const clampShare = (value) => {
    const weight = Math.round(parseNumber(value));
    if (!Number.isFinite(weight)) return 1;
    return Math.min(CONFIG.maxShare, Math.max(1, weight));
  };

  // All money is calculated in integer minor units (cents) and only converted
  // back to major units for display.
  const toMinor = (value) => {
    const number = parseNumber(value);
    return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * MINOR_UNIT) : NaN;
  };

  const fromMinor = (cents) => cents / MINOR_UNIT;

  const roundToUnit = (cents, unit) => Math.round(cents / unit) * unit;

  // Largest-remainder split of `totalUnits` according to integer weights.
  const distributeUnits = (totalUnits, weights, offset = 0) => {
    const count = weights.length;
    if (!count) return [];

    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (!totalWeight) return weights.map(() => 0);

    const units = weights.map((weight) => Math.floor((totalUnits * weight) / totalWeight));
    const remainder = totalUnits - units.reduce((sum, value) => sum + value, 0);
    if (remainder <= 0) return units;

    const order = weights
      .map((weight, index) => ({
        index,
        remainder: (totalUnits * weight) % totalWeight,
      }))
      .sort(
        (a, b) =>
          b.remainder - a.remainder ||
          ((a.index - offset + count) % count) - ((b.index - offset + count) % count)
      );

    for (let i = 0; i < remainder; i++) {
      units[order[i % count].index] += 1;
    }
    return units;
  };

  const roundAmount = (value, roundWhole = true) => {
    const cents = toMinor(value);
    if (!Number.isFinite(cents)) return 0;
    return fromMinor(roundToUnit(cents, roundWhole ? MINOR_UNIT : 1));
  };

  /* ------------------------------------------------------------------ */
  /* Text                                                              */
  /* ------------------------------------------------------------------ */

  // Names are letters only; anything else is dropped
  const sanitizeName = (value) =>
    String(value || '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, CONFIG.maxNameLength);

  const parseNames = (text) => {
    const names = new Set();
    String(text || '')
      .split(/\s+/)
      .map(sanitizeName)
      .filter(Boolean)
      .forEach((name) => names.add(name));
    return [...names].sort();
  };

  // One entry per line; the first standalone amount is used.
  // `lineIndexes` keeps one slot per visual line (an item index, or null when
  // skipped) so the chip rows can stay aligned with the textarea.
  const parseItems = (raw) => {
    const text = String(raw || '').replace(/\r/g, '');
    const items = [];

    const lineIndexes = text.split('\n').map((line) => {
      // Left to right, first standalone amount wins; later numbers
      // (quantities, package sizes, stray totals) are ignored. A token with
      // broken punctuation such as "6x0j00" never matches, so it is skipped.
      const price = parseFirstAmount(line);
      if (!(price > 0)) return null;

      items.push({ price });
      return items.length - 1;
    });

    const skipped = text.trim() ? lineIndexes.filter((index) => index === null).length : 0;
    return { items, skipped, lineIndexes };
  };

  /* ------------------------------------------------------------------ */
  /* Bill calculation                                                   */
  /* ------------------------------------------------------------------ */

  // Pure split calculation. `items` are prices, `shares` is one object per
  // item mapping name to weight (empty means everyone shares evenly), and
  // `total` may be empty for no fee.
  const calculateBill = ({ total = null, items = [], people = [], shares = [], roundWhole = true } = {}) => {
    const totalText = total == null ? '' : String(total).trim();
    if (!totalText && !items.length) return { bill: null, error: null };

    const totalValue = totalText ? parseFirstAmount(totalText) : null;
    if (totalValue !== null && !(totalValue > 0)) {
      return { bill: null, error: 'Enter a valid total.' };
    }
    if (!items.length) return { bill: null, error: null };

    const totalCents = totalValue === null ? null : toMinor(totalValue);

    const priceCents = items.map(toMinor);
    if (priceCents.some((cents) => !(cents > 0))) return { bill: null, error: null };

    const everyone = people.length
      ? people
      : [...new Set(shares.flatMap((row) => Object.keys(row || {})))];
    if (!everyone.length) return { bill: null, error: null };

    const subtotalCents = priceCents.reduce((sum, cents) => sum + cents, 0);
    const fee = totalCents === null ? 0 : (totalCents - subtotalCents) / subtotalCents;
    const unit = roundWhole ? MINOR_UNIT : 1;
    const targetTotalCents = roundToUnit(totalCents === null ? subtotalCents : totalCents, unit);
    const itemTargetCents = distributeUnits(targetTotalCents / unit, priceCents).map(
      (units) => units * unit
    );
    const totalsCents = {};

    const rows = priceCents.map((price, index) => {
      const selected = shares[index] || {};
      const names = Object.keys(selected);
      const split = names.length ? selected : Object.fromEntries(everyone.map((name) => [name, 1]));
      const entries = Object.entries(split).map(([person, weight]) => [
        person,
        Math.max(1, Math.round(Number(weight) || 1)),
      ]);
      const allocations = distributeUnits(
        itemTargetCents[index] / unit,
        entries.map(([, weight]) => weight),
        index
      );

      const row = {
        index,
        price: fromMinor(roundToUnit(price, unit)),
        priceWithFee: fromMinor(itemTargetCents[index]),
        shares: {},
      };

      entries.forEach(([person], item) => {
        const cents = allocations[item] * unit;
        row.shares[person] = fromMinor(cents);
        totalsCents[person] = (totalsCents[person] || 0) + cents;
      });

      return row;
    });

    const totals = Object.fromEntries(
      Object.entries(totalsCents).map(([person, cents]) => [person, fromMinor(cents)])
    );

    return {
      bill: {
        people: Object.keys(totalsCents).sort(),
        feePercent: Math.round(fee * 1000) / 10,
        items: rows,
        subtotal: fromMinor(roundToUnit(subtotalCents, unit)),
        total: fromMinor(targetTotalCents),
        totals,
      },
      error: null,
    };
  };

  /* ------------------------------------------------------------------ */
  /* Share helpers                                                      */
  /* ------------------------------------------------------------------ */

  const pruneShares = (shares, people) => {
    const pruned = {};
    Object.entries(shares || {}).forEach(([name, weight]) => {
      if (people.includes(name)) pruned[name] = weight;
    });
    return pruned;
  };

  /* ------------------------------------------------------------------ */
  /* Settlement                                                         */
  /* ------------------------------------------------------------------ */

  // Exact grouping is O(3^n); 10 remaining nonzero balances is the practical
  // ceiling after exact opposites are removed.
  const EXACT_LIMIT = 10;

  const toEntries = (balances) =>
    balances
      .map((balance, index) => ({ index, cents: Math.round(balance * MINOR_UNIT) }))
      .filter((entry) => entry.cents !== 0);

  // Largest-first greedy within one zero-sum group
  const settleGroup = (entries) => {
    const creditors = [];
    const debtors = [];
    entries.forEach((entry) => {
      if (entry.cents < 0) debtors.push({ index: entry.index, cents: -entry.cents });
      else creditors.push({ index: entry.index, cents: entry.cents });
    });
    creditors.sort((a, b) => b.cents - a.cents);
    debtors.sort((a, b) => b.cents - a.cents);

    const transfers = [];
    while (creditors.length && debtors.length) {
      const creditor = creditors[0];
      const debtor = debtors[0];
      const cents = Math.min(creditor.cents, debtor.cents);
      transfers.push({ from: debtor.index, to: creditor.index, amount: cents / MINOR_UNIT });

      creditor.cents -= cents;
      debtor.cents -= cents;
      if (!creditor.cents) creditors.shift();
      if (!debtor.cents) debtors.shift();
      creditors.sort((a, b) => b.cents - a.cents);
      debtors.sort((a, b) => b.cents - a.cents);
    }
    return transfers;
  };

  const settleGreedy = (balances) => settleGroup(toEntries(balances));

  // Split balances into as many zero-sum groups as possible, then settle each
  // group greedily. Fewer groups means more transfers; maximizing groups gives
  // the minimum possible transaction count.
  const settleBalances = (balances) => {
    const entries = toEntries(balances);
    const transfers = [];

    // Exact opposites can always settle each other directly; removing them
    // reduces the search size without affecting the minimum transfer count.
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].cents) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[j].cents !== -entries[i].cents) continue;

        const positive = entries[i].cents > 0 ? entries[i] : entries[j];
        const negative = entries[i].cents > 0 ? entries[j] : entries[i];
        transfers.push({
          from: negative.index,
          to: positive.index,
          amount: positive.cents / MINOR_UNIT,
        });
        entries[i].cents = 0;
        entries[j].cents = 0;
        break;
      }
    }

    const active = entries.filter((entry) => entry.cents !== 0);
    if (active.length < 2) return transfers;
    if (active.length > EXACT_LIMIT) {
      transfers.push(...settleGroup(active));
      return transfers;
    }

    const size = 1 << active.length;
    const sums = new Array(size).fill(0);
    for (let mask = 1; mask < size; mask++) {
      const bit = mask & -mask;
      const index = 31 - Math.clz32(bit);
      sums[mask] = sums[mask ^ bit] + active[index].cents;
    }
    if (sums[size - 1] !== 0) return [...transfers, ...settleGroup(active)];

    const groups = new Array(size).fill(-1);
    const choice = new Array(size).fill(0);
    groups[0] = 0;

    for (let mask = 1; mask < size; mask++) {
      if (sums[mask] !== 0) continue;

      const first = mask & -mask;
      for (let sub = (mask - 1) & mask; sub; sub = (sub - 1) & mask) {
        if (!(sub & first) || sums[sub] !== 0) continue;
        const value = groups[mask ^ sub] + 1;
        if (value > groups[mask]) {
          groups[mask] = value;
          choice[mask] = sub;
        }
      }
      if (groups[mask] < 0) groups[mask] = 1;
    }

    for (let mask = size - 1; mask; ) {
      const groupMask = choice[mask] || mask;
      const group = [];
      for (let i = 0; i < active.length; i++) {
        if (groupMask & (1 << i)) group.push(active[i]);
      }
      transfers.push(...settleGroup(group));
      mask ^= groupMask;
    }
    return transfers;
  };

  /* ------------------------------------------------------------------ */
  /* URL state                                                         */
  /* ------------------------------------------------------------------ */

  const readUrlState = () => Object.fromEntries(new URLSearchParams(window.location.search));

  const writeUrlState = (params) => {
    const search = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value != null && value !== '')
    ).toString();
    window.history.replaceState(null, null, search ? `?${search}` : window.location.pathname);
  };

  let urlSyncTimer = null;
  let pendingUrlParams = null;

  const queueUrlState = (params) => {
    pendingUrlParams = params;
    if (urlSyncTimer) clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(() => {
      urlSyncTimer = null;
      const next = pendingUrlParams;
      pendingUrlParams = null;
      if (next) writeUrlState(next);
    }, URL_SYNC_DELAY_MS);
  };

  const flushUrlState = () => {
    if (!urlSyncTimer) return;
    clearTimeout(urlSyncTimer);
    urlSyncTimer = null;
    const next = pendingUrlParams;
    pendingUrlParams = null;
    if (next) writeUrlState(next);
  };

  // "NAME" / "NAME+weight" tokens, comma-separated, items separated by "|"
  const parseShares = (raw) =>
    raw.split('|').map((line) => {
      const shares = {};
      line.split(',').forEach((token) => {
        const trimmed = token.trim();
        if (!trimmed) return;

        const separator = Math.max(trimmed.lastIndexOf('+'), trimmed.lastIndexOf(':'));
        const name = sanitizeName(separator > 0 ? trimmed.slice(0, separator) : trimmed);
        if (!name) return;

        const weight = separator > 0 ? trimmed.slice(separator + 1) : '';
        shares[name] = clampShare(weight);
      });
      return shares;
    });

  const encodeShares = (shares) =>
    Object.entries(shares)
      .map(([name, weight]) => `${name}${weight > 1 ? `+${weight}` : ''}`)
      .join(',');

  /* ------------------------------------------------------------------ */
  /* Formatting                                                        */
  /* ------------------------------------------------------------------ */

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const formatTimestamp = (date) => {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hours}:${minutes}`;
  };

  const formatAmount = (value, roundWhole = true, decimals = null) => {
    if (value == null || Number.isNaN(Number(value))) return '';
    const digits = decimals ?? (roundWhole ? 0 : MINOR_DECIMALS);
    return Number(value).toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                        */
  /* ------------------------------------------------------------------ */

  const showToast = (message, type = 'success') => {
    const stack = document.getElementById('toastStack');
    if (!stack) return;

    const item = document.createElement('div');
    item.className = `toast-item toast-item-${type}`;
    item.textContent = message;
    stack.appendChild(item);
    setTimeout(() => item.remove(), TOAST_DURATION_MS);
  };

  const toast = {
    success: (message) => showToast(message, 'success'),
    error: (message) => showToast(message, 'error'),
  };

  const copyToClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }

    const field = document.createElement('textarea');
    field.style.opacity = 0;
    document.body.appendChild(field);
    field.value = text;
    field.focus();
    field.select();
    const copied = document.execCommand && document.execCommand('copy');
    field.remove();
    return copied === true;
  };

  const shrinkImage = (image) => {
    const scale = Math.min(1, CONFIG.maxImagePx / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', CONFIG.jpegQuality));
  };

  /* ------------------------------------------------------------------ */
  /* Exports                                                            */
  /* ------------------------------------------------------------------ */

  const spill = {
    parseNumber,
    parseItems,
    parseNames,
    sanitizeName,
    clampShare,
    toMinor,
    fromMinor,
    roundAmount,
    formatAmount,
    calculateBill,
    parseShares,
    encodeShares,
    settleBalances,
    settleGreedy,
    EXACT_LIMIT,
  };
  if (typeof module === 'object' && module.exports) module.exports = spill;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------------------------ */
  /* Component                                                         */
  /* ------------------------------------------------------------------ */

  document.addEventListener('alpine:init', () => {
    Alpine.data('spill', function () {
      return {
        // Source state
        totalPaid: '',
        itemText: '',
        nameText: '',
        shares: [],
        error: null,
        bill: null,
        stack: this.$persist({ bills: [] }).as(STORAGE.bills),
        stackTotals: null,
        stackPayer: '',
        stackNote: '',
        roundWhole: this.$persist(true).as(STORAGE.roundWhole),

        // Derived state
        get parsedItems() {
          return parseItems(this.itemText);
        },

        get people() {
          return parseNames(this.nameText);
        },

        get assignmentItems() {
          return this.parsedItems.items.map((item, index) => ({
            index,
            key: `item-${index}`,
            price: item.price,
            shares: this.shares[index] || {},
            shareCount: Object.keys(this.shares[index] || {}).length,
          }));
        },

        get chipRows() {
          return this.parsedItems.lineIndexes.map((index, lineIndex) =>
            index === null
              ? { key: `skip-${lineIndex}`, placeholder: true, index: -1, shares: {}, shareCount: 0 }
              : this.assignmentItems[index]
          );
        },

        get warning() {
          const skipped = this.parsedItems.skipped;
          return skipped ? `${skipped} line${skipped === 1 ? '' : 's'} skipped: no valid amount found.` : null;
        },

        // Anyone in the name list may have paid, even without a share
        get payerOptions() {
          return [...new Set([...this.people, ...Object.keys(this.bill?.totals || {})])].sort();
        },

        get stackPeople() {
          const bills = this.stack.bills;
          if (!bills.length) return [];
          return [
            ...new Set(
              bills.flatMap((bill) => [
                bill.payer,
                ...Object.entries(bill.totals)
                  .filter(([, amount]) => amount > 0)
                  .map(([person]) => person),
              ])
            ),
          ].sort();
        },

        /* ---------------------------- Setup --------------------------- */

        init() {
          this.restoreFromUrl();
          if (this.stack && 'people' in this.stack) delete this.stack.people;

          this.recalculate();
          this.recalculateStack();
          this.autoSizeLists();

          this.$watch('totalPaid', () => this.recalculate());
          this.$watch('itemText', () => this.recalculate());
          this.$watch('nameText', () => this.recalculate());
          this.$watch('roundWhole', () => {
            this.recalculate();
            this.recalculateStack();
          });
          window.addEventListener('pagehide', flushUrlState);
        },

        restoreFromUrl() {
          const state = readUrlState();
          if (state.t != null) this.totalPaid = state.t;
          if (state.i != null) this.itemText = state.i;

          let linkedPeople = [];
          if (state.p != null) {
            linkedPeople = state.p.split(/[|,]/).map(sanitizeName).filter(Boolean);
          }

          if (state.a != null) this.shares = parseShares(state.a);

          this.nameText = linkedPeople.length ? [...new Set(linkedPeople)].sort().join(' ') : '';
        },

        // The price field grows with its content instead of scrolling
        autoSizeLists() {
          this.$nextTick(() => {
            document.querySelectorAll('.list-input').forEach((field) => {
              field.style.height = 'auto';
              field.style.height = `${field.scrollHeight}px`;
            });
          });
        },

        /* ---------------------------- Bill ---------------------------- */

        recalculate() {
          const { items } = this.parsedItems;
          const people = this.people;

          // Keep shares aligned with the parsed items, dropping names that were removed
          this.shares = items.map((_, index) => pruneShares(this.shares[index], people));

          this.scheduleUrlSync();
          this.autoSizeLists();

          const result = calculateBill({
            total: this.totalPaid,
            items: items.map((item) => item.price),
            people,
            shares: this.shares,
            roundWhole: this.roundWhole,
          });
          this.error = result.error;
          this.bill = result.bill;
        },

        scheduleUrlSync() {
          const params = { t: String(this.totalPaid).trim(), i: this.itemText };
          if (this.people.length) params.p = this.people.join('|');

          const shareText = this.shares.map(encodeShares).join('|');
          if (shareText.replace(/\|/g, '')) params.a = shareText;

          queueUrlState(params);
        },

        /* -------------------------- Assignment ------------------------ */

        // "All" resets an item back to equal shares within the group
        shareEveryone(index) {
          this.shares = this.shares.map((shares, i) => (i === index ? {} : shares));
          this.recalculate();
        },

        // Tap cycles ×1 → ×2 → off
        cycleShare(index, name) {
          const current = this.shares[index] || {};
          const weight = (current[name] || 0) >= CONFIG.maxShare ? 0 : (current[name] || 0) + 1;
          const next = { ...current };
          if (weight) next[name] = weight;
          else delete next[name];

          this.shares = this.shares.map((shares, i) => (i === index ? next : shares));
          this.recalculate();
        },

        normalizeNames() {
          const text = parseNames(this.nameText).join(' ');
          if (text !== this.nameText) this.nameText = text;
        },

        /* --------------------------- Receipt -------------------------- */

        scanReceipt(event) {
          const input = event.target;
          const file = input.files[0];
          input.value = '';
          if (!file) return;

          toast.success('Processing, please wait...');

          const image = new Image();
          image.onload = async () => {
            URL.revokeObjectURL(image.src);
            try {
              const blob = await shrinkImage(image);
              if (!blob) throw new Error();
              const formData = new FormData();
              formData.append('file', blob, `${file.name}.res.jpg`);

              const response = await fetch('/api/upload', { method: 'POST', body: formData });
              const data = await response.json();
              if (!data || !data.total || !data.items) throw new Error();

              this.totalPaid = `${this.roundAmount(data.total)}`;
              this.itemText = data.items
                .map((item) => {
                  const amount = this.roundAmount(item.amount);
                  const name = (item.name || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
                  return name ? `${amount} - ${name}` : `${amount}`;
                })
                .join('\n');
              this.shares = [];
              toast.success('Data extracted, please verify!');
            } catch {
              toast.error('Failed to extract data!');
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(image.src);
            toast.error('Failed to load image!');
          };
          image.src = URL.createObjectURL(file);
        },

        /* ---------------------------- Output -------------------------- */

        async copyBillSummary() {
          if (!this.bill?.people?.length) {
            toast.error('Bill is invalid!');
            return;
          }

          let summary = `TOTAL: ${this.formatAmount(this.bill.total)}\r\n===`;
          this.bill.people.forEach((person) => {
            const amount = this.bill.totals[person];
            if (amount > 0) summary += `\r\n${person}: ${this.formatAmount(amount)}`;
          });

          const copied = await copyToClipboard(summary);
          copied ? toast.success('Split summary copied!') : toast.error('Cannot access clipboard!');
        },

        async copyShareLink() {
          if (!this.bill?.people?.length) {
            toast.error('Bill is invalid!');
            return;
          }

          flushUrlState();
          const copied = await copyToClipboard(location.href);
          copied ? toast.success('Shareable link copied!') : toast.error('Cannot access clipboard!');
        },

        /* ------------------------- Stacked bills ---------------------- */

        saveBill() {
          if (!this.bill?.people?.length) {
            toast.error('Bill is invalid!');
            return;
          }

          const payer = sanitizeName(this.stackPayer);
          if (!payer || !this.payerOptions.includes(payer)) {
            toast.error('Select who paid first!');
            return;
          }

          this.stack.bills.push({
            payer,
            note: (this.stackNote || '').trim() || formatTimestamp(new Date()),
            total: this.bill.total,
            totals: this.bill.totals,
          });

          this.stackPayer = '';
          this.stackNote = '';
          this.recalculateStack();
          toast.success('Current bill saved!');
        },

        deleteBill(index) {
          if (!confirm('Delete this bill?')) return;
          this.stack.bills.splice(index, 1);
          this.recalculateStack();
        },

        clearBills() {
          if (!this.stack.bills.length) {
            toast.error('No bills to clear!');
            return;
          }
          if (!confirm('Delete all saved bills?')) return;

          this.stack = { bills: [] };
          this.stackTotals = null;
          toast.success('All bills deleted!');
        },

        recalculateStack() {
          const bills = this.stack.bills;
          if (!bills.length) {
            this.stackTotals = null;
            return;
          }

          // Only people who paid or owe something keep a column
          const people = this.stackPeople;

          const spent = people.map(() => 0);
          const paid = people.map(() => 0);
          // Positive is credit, negative is debt
          const ledger = Object.fromEntries(people.map((person) => [person, 0]));
          let total = 0;

          bills.forEach((bill) => {
            const billTotal = toMinor(bill.total) || 0;
            total += billTotal;
            people.forEach((person, i) => {
              spent[i] += toMinor(bill.totals[person] || 0) || 0;
              if (bill.payer === person) paid[i] += billTotal;
            });
            Object.entries(bill.totals).forEach(([person, amount]) => {
              if (bill.payer === person) return;
              const cents = toMinor(amount) || 0;
              ledger[person] -= cents;
              ledger[bill.payer] += cents;
            });
          });

          const balances = people.map((person) => fromMinor(ledger[person]));

          this.stackTotals = {
            total: fromMinor(total),
            spent: spent.map(fromMinor),
            paid: paid.map(fromMinor),
            balances,
            transfers: settleBalances(balances).map((transfer) => ({
              from: people[transfer.from],
              to: people[transfer.to],
              amount: transfer.amount,
            })),
          };
        },

        async copySettlement() {
          if (!this.stackTotals) return;

          const people = this.stackPeople;
          const bills = this.stack.bills;

          const spentCount = people.map(() => 0);
          const paidCount = people.map(() => 0);
          bills.forEach((bill) => {
            people.forEach((person, i) => {
              if ((bill.totals[person] || 0) > 0) spentCount[i]++;
              if (bill.payer === person) paidCount[i]++;
            });
          });

          let summary = 'SETTLEMENT\r\n===';
          this.stackTotals.transfers.forEach((transfer) => {
            summary += `\r\n${transfer.from} -> ${transfer.to}: ${this.formatAmount(transfer.amount)}`;
          });
          summary += '\r\n\r\nDETAILS\r\n===';
          people.forEach((person, i) => {
            summary += `\r\n${person}`;
            if (spentCount[i] > 0) {
              summary += `\r\n- Spent (${spentCount[i]}): ${this.formatAmount(this.stackTotals.spent[i])}`;
            }
            if (paidCount[i] > 0) {
              summary += `\r\n- Paid (${paidCount[i]}): ${this.formatAmount(this.stackTotals.paid[i])}`;
            }
          });

          const copied = await copyToClipboard(summary);
          copied ? toast.success('Settlement summary copied!') : toast.error('Cannot access clipboard!');
        },

        /* --------------------------- Formatting ----------------------- */

        roundAmount(value) {
          return roundAmount(value, this.roundWhole);
        },

        formatAmount(value, decimals = null) {
          return formatAmount(value, this.roundWhole, decimals);
        },
      };
    });
  });
})();
