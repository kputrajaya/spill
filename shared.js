(() => {
  /* ------------------------------------------------------------------ */
  /* Money                                                              */
  /* ------------------------------------------------------------------ */

  // Money is stored in integer minor units; 2 decimals means cents.
  const MINOR_DECIMALS = 2;
  const MINOR_UNIT = 10 ** MINOR_DECIMALS;
  const AMOUNT_TOKEN = /^\d[\d.,]*$/;

  // Accepts "Rp 73.150", "30,000", "30 000", "1.234.567,89", 27500.
  // The first amount-looking token wins, so "6 000" reads as 6.
  const parseNumber = (raw) => {
    if (typeof raw === 'number') return raw;

    const full = String(raw == null ? '' : raw).trim();
    if (!full) return NaN;

    const token = full.split(/\s+/).find((part) => AMOUNT_TOKEN.test(part));
    if (!token) return NaN;

    let text = token.replace(/[^\d.,-]/g, '').replace(/-/g, '');
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
  /* Formatting                                                         */
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
  /* Browser UI helpers                                                 */
  /* ------------------------------------------------------------------ */

  const TOAST_DURATION_MS = 2500;

  const showToast = (message, type = 'success') => {
    if (typeof document === 'undefined') return;
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
    if (typeof navigator === 'undefined' || typeof document === 'undefined') return false;

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

  const core = {
    MINOR_DECIMALS,
    MINOR_UNIT,
    parseNumber,
    toMinor,
    fromMinor,
    roundToUnit,
    distributeUnits,
    roundAmount,
    settleBalances,
    settleGreedy,
    EXACT_LIMIT,
    formatTimestamp,
    formatAmount,
    toast,
    copyToClipboard,
  };

  if (typeof module === 'object' && module.exports) module.exports = core;
  if (typeof window !== 'undefined') window.SpillCore = core;
})();
