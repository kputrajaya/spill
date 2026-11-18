(() => {
  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */

  const CONFIG = {
    maxImagePx: 2000,
    jpegQuality: 0.7,
    maxShare: 3,
    maxNameLength: 24,
    maxLabelLength: 48,
  };

  const STORAGE = {
    names: 'spill:names',
    bills: 'spill:bills',
    roundWhole: 'spill:roundWhole',
    legacyNames: 'spill:roster',
    legacyBills: '_x_mbrData',
    legacyRoundWhole: '_x_roundDecimals',
  };

  const AMOUNT_TOKEN = /^\d[\d.,]*$/;
  const CURRENCY_PREFIX = /^(?:rp|idr|usd|sgd|myr|thb|php|vnd|aud|eur|gbp)\b\.?[\s-]*/i;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ------------------------------------------------------------------ */
  /* Storage                                                           */
  /* ------------------------------------------------------------------ */

  const readStorage = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const writeStorage = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  };

  // Names were stored as a JSON array before the People field existed
  const migrateStorage = () => {
    if (readStorage(STORAGE.names) == null) {
      const legacy = readStorage(STORAGE.legacyNames);
      try {
        const parsed = legacy ? JSON.parse(legacy) : null;
        if (Array.isArray(parsed)) {
          writeStorage(STORAGE.names, parsed.map(sanitizeName).filter(Boolean).sort().join('\n'));
        }
      } catch {}
    }

    // Persisted Alpine state was renamed, so carry the old values over once
    if (readStorage(STORAGE.bills) == null) {
      const legacy = readStorage(STORAGE.legacyBills);
      if (legacy) writeStorage(STORAGE.bills, legacy);
    }
    if (readStorage(STORAGE.roundWhole) == null) {
      const legacy = readStorage(STORAGE.legacyRoundWhole);
      if (legacy) writeStorage(STORAGE.roundWhole, legacy);
    }
  };

  const readNames = () => readStorage(STORAGE.names) ?? '';
  const writeNames = (text) => writeStorage(STORAGE.names, text);

  /* ------------------------------------------------------------------ */
  /* Numbers                                                           */
  /* ------------------------------------------------------------------ */

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

  const clampShare = (value) => {
    const weight = Math.round(parseNumber(value));
    if (!Number.isFinite(weight)) return 1;
    return Math.min(CONFIG.maxShare, Math.max(1, weight));
  };

  /* ------------------------------------------------------------------ */
  /* Text                                                              */
  /* ------------------------------------------------------------------ */

  const sanitizeLabel = (value) =>
    String(value || '')
      .replace(CURRENCY_PREFIX, '')
      .replace(/^[\s\-–—:;•*@#|]+/, '')
      .replace(/[\s\-–—:;•*@#|]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONFIG.maxLabelLength);

  const sanitizeName = (value) =>
    String(value || '')
      .toUpperCase()
      .replace(/[,|+&=#%?/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CONFIG.maxNameLength);

  const parseNames = (text) => {
    const names = new Set();
    String(text || '')
      .split(/[\n,;]+/)
      .map(sanitizeName)
      .filter(Boolean)
      .forEach((name) => names.add(name));
    return [...names].sort();
  };

  // One entry per line: "30000", "Nasi Goreng 30.000" or "30.000 - Nasi Goreng"
  const parseItems = (raw) => {
    let text = String(raw || '').replace(/\r/g, '');
    for (let i = 0; i < 3; i++) {
      text = text.replace(/(\d)[\u00A0 ](?=\d{3}(?!\d))/g, '$1');
    }

    const items = [];
    let skipped = 0;

    const addItem = (label, token) => {
      const price = parseNumber(token);
      if (!(price > 0)) {
        skipped++;
        return;
      }
      items.push({ price, label: sanitizeLabel(label) });
    };

    text.split(/[\n;]+/).forEach((line) => {
      // Split only on commas that separate entries, never inside "30,000"
      const segments = line.split(/(?<=\D)\s*,\s*|\s*,\s*(?=\D)/);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i].trim();
        if (!segment) continue;

        // Glue a fragment without an amount onto the following segment
        if (!/\d/.test(segment) && i + 1 < segments.length) {
          segments[i + 1] = `${segment} ${segments[i + 1]}`;
          continue;
        }

        // No letters: a bare list of amounts ("30000 27500 9000")
        if (!/[A-Za-z]/.test(segment)) {
          const amounts = segment.split(/[\s,]+/).filter((token) => /\d/.test(token));
          if (!amounts.length) {
            skipped++;
            continue;
          }
          amounts.forEach((token) => addItem('', token));
          continue;
        }

        // A label plus one amount
        const tokens = segment.split(/\s+/);
        let amountIndex = -1;
        for (let t = tokens.length - 1; t >= 0; t--) {
          if (AMOUNT_TOKEN.test(tokens[t])) {
            amountIndex = t;
            break;
          }
        }
        if (amountIndex === -1) {
          skipped++;
          continue;
        }
        addItem(
          tokens.filter((_, t) => t !== amountIndex).join(' '),
          tokens[amountIndex]
        );
      }
    });

    return { items, skipped };
  };

  /* ------------------------------------------------------------------ */
  /* URL state                                                         */
  /* ------------------------------------------------------------------ */

  const decodeParam = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  // Decodes the values written with the legacy "+" / "|" convention
  const decodeLegacyValue = (value) => decodeParam(value).replace(/\+/g, ' ').replace(/\|/g, '\n');

  const readUrlState = () => {
    const state = {};
    const search = window.location.search.slice(1);
    if (!search) return state;

    search.split('&').forEach((pair) => {
      const at = pair.indexOf('=');
      if (at === -1) return;
      state[pair.slice(0, at)] = pair.slice(at + 1);
    });
    return state;
  };

  const writeUrlState = (params) => {
    const search = Object.entries(params)
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => {
        // `p` and `a` are pre-encoded so "|", "," and "+" stay readable separators
        if (key === 'p' || key === 'a') return `${key}=${value}`;
        return `${key}=${encodeURIComponent(value).replace(/%20/g, '+').replace(/%0A/g, '|')}`;
      })
      .join('&');

    window.history.replaceState(null, null, search ? `?${search}` : window.location.pathname);
  };

  // "NAME" / "NAME+weight" tokens, comma-separated, items separated by "|"
  const parseShares = (raw) =>
    decodeParam(raw)
      .split('|')
      .map((line) => {
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

  // Legacy links listed a name per share, so duplicates carry the weight
  const parseLegacyShares = (text) =>
    text.split('\n').map((line) => {
      const shares = {};
      line
        .trim()
        .split(/\s+/)
        .map(sanitizeName)
        .filter(Boolean)
        .forEach((name) => {
          shares[name] = (shares[name] || 0) + 1;
        });
      return shares;
    });

  const encodeShares = (shares) =>
    Object.entries(shares)
      .map(([name, weight]) => `${encodeURIComponent(name)}${weight > 1 ? `+${weight}` : ''}`)
      .join(',');

  /* ------------------------------------------------------------------ */
  /* Formatting & settlement                                           */
  /* ------------------------------------------------------------------ */

  const formatTimestamp = (date) => {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hours}:${minutes}`;
  };

  const settleBalances = (balances) => {
    const creditors = [];
    const debtors = [];
    balances.forEach((balance, index) => {
      if (balance > 0) debtors.push({ index, amount: balance });
      else if (balance < 0) creditors.push({ index, amount: -balance });
    });
    creditors.sort((a, b) => b.amount - a.amount);
    debtors.sort((a, b) => b.amount - a.amount);

    const transfers = [];
    while (creditors.length && debtors.length) {
      const creditor = creditors[0];
      const debtor = debtors[0];
      const transfer = {
        from: debtor.index,
        to: creditor.index,
        amount: Math.min(creditor.amount, debtor.amount),
      };
      transfers.push(transfer);

      if (creditor.amount === transfer.amount) {
        creditors.shift();
      } else {
        creditor.amount -= transfer.amount;
        creditors.sort((a, b) => b.amount - a.amount);
      }
      if (debtor.amount === transfer.amount) {
        debtors.shift();
      } else {
        debtor.amount -= transfer.amount;
        debtors.sort((a, b) => b.amount - a.amount);
      }
    }

    return transfers;
  };

  const copyToClipboard = async (text) => {
    const field = document.createElement('textarea');
    field.style.opacity = 0;
    document.body.appendChild(field);
    field.value = text;
    field.focus();
    field.select();
    const copied = document.execCommand && document.execCommand('copy');
    field.remove();
    if (copied === true) return true;

    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    return false;
  };

  /* ------------------------------------------------------------------ */
  /* Component                                                         */
  /* ------------------------------------------------------------------ */

  document.addEventListener('alpine:init', () => {
    migrateStorage();

    const toast = new Notyf({
      ripple: false,
      position: { x: 'center' },
    });

    Alpine.data('spill', function () {
      return {
        // State
        totalPaid: '',
        itemText: '',
        nameText: '',
        people: [],
        shares: [],
        items: [],
        payerOptions: [],
        warning: null,
        error: null,
        bill: null,
        stack: this.$persist({ people: [], bills: [] }).as(STORAGE.bills),
        stackTotals: null,
        stackPayer: '',
        stackNote: '',
        roundWhole: this.$persist(true).as(STORAGE.roundWhole),

        /* ---------------------------- Setup --------------------------- */

        init() {
          this.restoreFromUrl();
          this.stack.bills = this.stack.bills.map(normalizeBill);
          this.stack.people = [...new Set([...this.stack.people, ...this.stack.bills.map((bill) => bill.payer)])].sort();

          this.recalculate();
          this.recalculateStack();
          this.autoSizeLists();

          this.$watch('totalPaid', () => this.recalculate());
          this.$watch('itemText', () => this.recalculate());
          this.$watch('nameText', () => {
            this.recalculate();
            writeNames(this.people.join('\n'));
          });
          this.$watch('roundWhole', () => {
            this.recalculate();
            this.recalculateStack();
          });
        },

        restoreFromUrl() {
          const state = readUrlState();
          if (state.total != null) this.totalPaid = decodeLegacyValue(state.total);
          if (state.items != null) this.itemText = decodeLegacyValue(state.items);

          let linkedPeople = [];
          if (state.p != null) {
            linkedPeople = decodeParam(state.p)
              .split(/[|,]/)
              .map(sanitizeName)
              .filter(Boolean);
          }

          let linkedShares = null;
          if (state.a != null) {
            linkedShares = parseShares(state.a);
          } else if (state.people != null) {
            linkedShares = parseLegacyShares(decodeLegacyValue(state.people));
            if (!linkedPeople.length) {
              linkedPeople = [...new Set(linkedShares.flatMap((shares) => Object.keys(shares)))];
            }
          }

          this.nameText = linkedPeople.length ? [...new Set(linkedPeople)].sort().join('\n') : readNames();
          if (linkedShares) this.shares = linkedShares;
        },

        /* ---------------------------- Bill ---------------------------- */

        recalculate() {
          const { items, skipped } = parseItems(this.itemText);

          this.people = parseNames(this.nameText);
          this.payerOptions = [...this.people];

          // Keep shares aligned with the parsed items, dropping names that were removed
          this.shares = items.map((_, index) => pruneShares(this.shares[index], this.people));
          this.items = items.map((item, index) => ({
            index,
            label: item.label,
            price: item.price,
            shares: this.shares[index],
            shareCount: Object.keys(this.shares[index]).length,
          }));

          this.syncUrlState();
          this.autoSizeLists();
          this.warning = skipped ? `${skipped} line${skipped === 1 ? '' : 's'} skipped: no amount found.` : null;

          this.bill = this.buildBill(items);
        },

        buildBill(items) {
          // Nothing entered yet
          if (!String(this.totalPaid).trim() && !String(this.itemText).trim()) {
            this.error = null;
            return null;
          }

          // A blank total means no fee: the items already add up to what was paid
          const totalText = String(this.totalPaid).trim();
          const total = totalText ? parseNumber(totalText) : null;
          if (total !== null && !(total > 0)) {
            this.error = 'Enter a valid total.';
            return null;
          }
          if (!items.length) {
            this.error = null;
            return null;
          }

          const everyone = this.people.length
            ? this.people
            : [...new Set(this.shares.flatMap((shares) => Object.keys(shares)))];
          if (!everyone.length) {
            this.error = null;
            return null;
          }

          const subtotal = items.reduce((sum, item) => sum + item.price, 0);
          const fee = total === null ? 0 : (total - subtotal) / subtotal;
          const totals = {};

          const rows = items.map((item, index) => {
            const shares = this.shares[index];
            const names = Object.keys(shares);
            // No names selected means everyone shares the item equally
            const split = names.length ? shares : Object.fromEntries(everyone.map((name) => [name, 1]));
            const totalWeight = Object.values(split).reduce((sum, weight) => sum + weight, 0);

            const row = {
              index,
              label: item.label,
              price: this.roundAmount(item.price),
              priceWithFee: this.roundAmount(item.price * (1 + fee)),
              shares: {},
            };

            Object.entries(split).forEach(([person, weight]) => {
              const amount = (item.price * weight * (1 + fee)) / totalWeight;
              row.shares[person] = this.roundAmount((row.shares[person] || 0) + amount);
              totals[person] = (totals[person] || 0) + amount;
            });

            return row;
          });

          Object.keys(totals).forEach((person) => {
            totals[person] = this.roundAmount(totals[person]);
          });

          this.error = null;
          // Anyone in the name list may have paid, even without a share
          this.payerOptions = [...new Set([...this.people, ...Object.keys(totals)])].sort();

          return {
            people: Object.keys(totals).sort(),
            feePercent: Math.round(fee * 1000) / 10,
            items: rows,
            subtotal: this.roundAmount(subtotal),
            total: this.roundAmount(subtotal * (1 + fee)),
            totals,
          };
        },

        syncUrlState() {
          const params = { total: String(this.totalPaid).trim(), items: this.itemText };
          if (this.people.length) params.p = this.people.map(encodeURIComponent).join('|');

          const shareText = this.shares.map(encodeShares).join('|');
          if (shareText.replace(/\|/g, '')) params.a = shareText;

          writeUrlState(params);
        },

        // "Everyone" resets an item back to equal shares within the group
        shareEveryone(index) {
          this.shares = this.shares.map((shares, i) => (i === index ? {} : shares));
          this.recalculate();
        },

        // Tap cycles ×1 → ×2 → ×3 → off
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
          const text = this.people.join('\n');
          if (text !== this.nameText) this.nameText = text;
          writeNames(text);
          this.autoSizeLists();
        },

        autoSizeLists() {
          this.$nextTick(() => {
            document.querySelectorAll('.list-input').forEach((field) => {
              field.style.height = 'auto';
              field.style.height = `${field.scrollHeight}px`;
            });
          });
        },

        /* --------------------------- Receipt -------------------------- */

        scanReceipt() {
          const fileInput = document.createElement('input');
          fileInput.type = 'file';
          fileInput.accept = 'image/*,text/plain';
          fileInput.style.display = 'none';
          document.body.appendChild(fileInput);

          fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            document.body.removeChild(fileInput);
            if (!file) return;

            toast.success('Processing, please wait...');

            const image = new Image();
            image.onload = async () => {
              URL.revokeObjectURL(image.src);
              const blob = await shrinkImage(image);
              const formData = new FormData();
              formData.append('file', blob, `${file.name}.res.jpg`);

              try {
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
          });

          fileInput.click();
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

          const copied = await copyToClipboard(location.href);
          copied ? toast.success('Shareable link copied!') : toast.error('Cannot access clipboard!');
        },

        /* ------------------------- Stacked bills ---------------------- */

        saveBill() {
          const people = this.bill?.people || [];
          if (!people.length) {
            toast.error('Bill is invalid!');
            return;
          }

          const payer = sanitizeName(this.stackPayer);
          if (!payer || !this.payerOptions.includes(payer)) {
            toast.error('Select who paid first!');
            return;
          }

          this.stack.people = [...new Set([...this.stack.people, ...people, payer])].sort();
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

          this.stack = { people: [], bills: [] };
          this.stackTotals = null;
          toast.success('All bills deleted!');
        },

        recalculateStack() {
          if (!this.stack.bills.length) {
            this.stackTotals = null;
            return;
          }

          const bills = this.stack.bills;
          const people = [...new Set([...this.stack.people, ...bills.map((bill) => bill.payer)])].sort();
          if (people.join('|') !== this.stack.people.join('|')) this.stack.people = people;

          const spent = people.map(() => 0);
          const paid = people.map(() => 0);
          // Positive balance means the person owes money
          const ledger = Object.fromEntries(people.map((person) => [person, 0]));
          let total = 0;

          bills.forEach((bill) => {
            total += bill.total;
            people.forEach((person, i) => {
              spent[i] += bill.totals[person] || 0;
              if (bill.payer === person) paid[i] += bill.total;
            });
            Object.entries(bill.totals).forEach(([person, amount]) => {
              if (bill.payer === person) return;
              ledger[person] += amount;
              ledger[bill.payer] -= amount;
            });
          });

          const balances = people.map((person) => this.roundAmount(ledger[person]));

          this.stackTotals = {
            total: this.roundAmount(total),
            spent: spent.map((amount) => this.roundAmount(amount)),
            paid: paid.map((amount) => this.roundAmount(amount)),
            balances,
            transfers: settleBalances(balances).map((transfer) => ({
              from: people[transfer.from],
              to: people[transfer.to],
              amount: this.roundAmount(transfer.amount),
            })),
          };
        },

        async copySettlement() {
          if (!this.stackTotals) return;

          const people = this.stack.people;
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
          const number = parseNumber(value);
          const factor = this.roundWhole ? 1 : 100;
          return Number.isFinite(number) ? Math.round(number * factor) / factor : 0;
        },

        formatAmount(value, decimals = null) {
          if (value == null || Number.isNaN(Number(value))) return '';
          const digits = decimals ?? (this.roundWhole ? 0 : 2);
          return Number(value).toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        },
      };
    });
  });

  /* ------------------------------------------------------------------ */
  /* Local helpers                                                      */
  /* ------------------------------------------------------------------ */

  const pruneShares = (shares, people) => {
    const pruned = {};
    Object.entries(shares || {}).forEach(([name, weight]) => {
      if (people.includes(name)) pruned[name] = weight;
    });
    return pruned;
  };

  const normalizeBill = (bill) => ({
    payer: bill.payer,
    note: bill.note,
    total: bill.total ?? bill.totalPriceWithFee ?? 0,
    totals: bill.totals ?? bill.peopleTotal ?? {},
  });

  const shrinkImage = (image) => {
    const { maxImagePx } = CONFIG;
    const landscape = image.width > image.height;
    const width = landscape ? maxImagePx : Math.round((image.width / image.height) * maxImagePx);
    const height = landscape ? Math.round((image.height / image.width) * maxImagePx) : maxImagePx;

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(image.width, width);
    canvas.height = Math.min(image.height, height);

    const resizer = pica();
    return resizer.resize(image, canvas).then(() => resizer.toBlob(canvas, 'image/jpeg', CONFIG.jpegQuality));
  };
})();
