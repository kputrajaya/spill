(() => {
  /* ------------------------------------------------------------------ */
  /* Shared core                                                        */
  /* ------------------------------------------------------------------ */

  const Core =
    typeof module === 'object' && module.exports
      ? require('./shared.js')
      : window.SpillCore;

  const {
    parseNumber,
    toMinor,
    fromMinor,
    distributeUnits,
    roundAmount,
    formatAmount,
    settleBalances,
    settleGreedy,
    EXACT_LIMIT,
    MAX_SETTLE_PEOPLE,
    toast,
    copyToClipboard,
    repairStoredJson,
  } = Core;

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */

  const CONFIG = {
    maxImagePx: 2000,
    jpegQuality: 0.7,
    maxShare: 2,
    maxNameLength: 24,
  };

  // The only state that persists is the rounding switch
  const STORAGE = {
    roundWhole: 'spill:roundWhole',
  };

  const URL_SYNC_DELAY_MS = 250;

  /* ------------------------------------------------------------------ */
  /* Text                                                              */
  /* ------------------------------------------------------------------ */

  const AMOUNT_TOKEN = /^\d[\d.,]*$/;

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

    const lines = text.split('\n');
    const lineIndexes = lines.map((line) => {
      // Left to right, first standalone amount wins; later numbers
      // (quantities, package sizes, stray totals) are ignored. A token with
      // broken punctuation such as "6x0j00" never matches, so it is skipped.
      const price = parseFirstAmount(line);
      if (!(price > 0)) return null;

      items.push({ price });
      return items.length - 1;
    });

    // Blank lines only exist to keep the chip rows aligned; do not report them
    // as skipped, or a pasted list ending in a newline shows a false warning.
    const skipped = lines.reduce(
      (count, line, index) => (lineIndexes[index] === null && line.trim() ? count + 1 : count),
      0
    );
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
    // `roundWhole` only affects display; the split and handoff stay exact.
    const targetTotalCents = totalCents === null ? subtotalCents : totalCents;
    const itemTargetCents = distributeUnits(targetTotalCents, priceCents);
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
        itemTargetCents[index],
        entries.map(([, weight]) => weight),
        index
      );

      const row = {
        index,
        price: fromMinor(price),
        priceWithFee: fromMinor(itemTargetCents[index]),
        shares: {},
      };

      entries.forEach(([person], item) => {
        const cents = allocations[item];
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
        subtotal: fromMinor(subtotalCents),
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

  // Must run before Alpine initializes $persist.
  if (repairStoredJson(STORAGE.roundWhole, (value) => typeof value === 'boolean')) {
    toast.error('Settings were unreadable and reset.');
  }

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
        scanning: false,
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
          return skipped ? `${skipped} line${skipped === 1 ? '' : 's'} skipped: no amount found.` : null;
        },

        /* ---------------------------- Setup --------------------------- */

        init() {
          this.restoreFromUrl();

          this.recalculate();
          this.autoSizeLists();

          this.$watch('totalPaid', () => this.recalculate());
          this.$watch('itemText', () => this.recalculate());
          this.$watch('nameText', () => this.recalculate());
          this.$watch('roundWhole', () => this.recalculate());
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

          this.scanning = true;
          toast.success('Scanning receipt...');

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

              this.totalPaid = `${this.exactAmount(data.total)}`;
              this.itemText = data.items
                .map((item) => {
                  const amount = this.exactAmount(item.amount);
                  const name = (item.name || '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
                  return name ? `${amount} - ${name}` : `${amount}`;
                })
                .join('\n');
              this.shares = [];
              toast.success('Receipt scanned. Check the amounts.');
            } catch {
              toast.error("Couldn't read the receipt.");
            } finally {
              this.scanning = false;
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(image.src);
            this.scanning = false;
            toast.error("Couldn't load the image.");
          };
          image.src = URL.createObjectURL(file);
        },

        /* ---------------------------- Output -------------------------- */

        async copyBillSummary() {
          if (!this.bill?.people?.length) {
            toast.error('Complete the bill first.');
            return;
          }

          let summary = `TOTAL: ${this.formatAmount(this.bill.total)}\r\n===`;
          this.bill.people.forEach((person) => {
            const amount = this.bill.totals[person];
            if (amount > 0) summary += `\r\n${person}: ${this.formatAmount(amount)}`;
          });

          const copied = await copyToClipboard(summary);
          copied ? toast.success('Summary copied.') : toast.error('Clipboard unavailable.');
        },

        /* ------------------------ Settle handoff ---------------------- */

        // The settle page reads these params once, then cleans its URL.
        settleInNewTab() {
          const bill = this.bill;
          if (!bill?.people?.length) {
            toast.error('Complete the bill first.');
            return;
          }
          if (bill.people.length < 2) {
            toast.error('Add at least two people to settle.');
            return;
          }
          if (bill.people.length > MAX_SETTLE_PEOPLE) {
            toast.error(`Settle supports up to ${MAX_SETTLE_PEOPLE} people.`);
            return;
          }

          const totalMinor = toMinor(bill.total);
          if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
            toast.error('Add a total before settling.');
            return;
          }

          const params = new URLSearchParams({
            from: 'split',
            t: String(totalMinor),
            p: bill.people.join('|'),
            a: bill.people.map((person) => String(toMinor(bill.totals[person]))).join('|'),
          });
          flushUrlState();
          window.open(`/settle/?${params.toString()}`, '_blank', 'noopener');
        },

        /* --------------------------- Formatting ----------------------- */

        // Scanned values keep their cents; Whole numbers only affects display.
        exactAmount(value) {
          const cents = toMinor(value);
          return Number.isFinite(cents) ? fromMinor(cents) : 0;
        },

        formatAmount(value, decimals = null) {
          return formatAmount(value, this.roundWhole, decimals);
        },

        // The fee is stored with one decimal; keep it instead of rounding 12.5%
        // to 13% in the header.
        formatFee(value) {
          return this.formatAmount(value, 1).replace(/\.0$/, '');
        },
      };
    });
  });
})();
