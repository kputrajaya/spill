(() => {
  const Shared =
    typeof module === 'object' && module.exports
      ? require('../shared.js')
      : window.SpillCore;

  const {
    toMinor,
    fromMinor,
    distributeUnits,
    formatAmount,
    formatTimestamp,
    settleBalances,
    MAX_SETTLE_PEOPLE,
    toast,
    copyToClipboard,
    repairStoredJson,
  } = Shared;

  const STORAGE = 'spill:settle';
  const LEGACY_KEY_STORAGE = 'spill:settle:syncKey';
  const LEDGER_PREFIX = 'spill:settle:ledger:';
  const INDEX_STORAGE = 'spill:settle:index';
  const MAX_LEDGERS = 10;
  const MAX_PEOPLE = MAX_SETTLE_PEOPLE;
  const MAX_NAME_LENGTH = 24;
  const MAX_TRANSACTION_NAME = 40;
  const DEFAULT_TRANSACTION_NAME = 'Bill';
  const MODES = ['equal', 'owed', 'manual'];

  /* ------------------------------------------------------------------ */
  /* Names and ids                                                      */
  /* ------------------------------------------------------------------ */

  const newId = (prefix) =>
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const cleanPersonName = (value) =>
    String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME_LENGTH);

  const cleanTransactionName = (value) =>
    String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TRANSACTION_NAME);

  const nameKey = (name) => name.toLowerCase();

  // Plain code-unit ordering. localeCompare depends on the browser locale,
  // which would let two devices disagree about equal revisions.
  const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // IDs are stable; names are compared exactly. Order does not matter.
  const sameRoster = (a = [], b = []) => {
    if (a.length !== b.length) return false;
    const names = new Map(a.map((person) => [person.id, person.name]));
    return b.every((person) => names.get(person.id) === person.name);
  };

  const ledgerStorageKey = (key) => `${LEDGER_PREFIX}${key}`;

  // Snapshot copy for branching a ledger. The source and copy diverge from
  // this point; IDs and amounts are intentionally preserved.
  const cloneLedgerState = (state, key) => {
    const clone = JSON.parse(JSON.stringify(state));
    clone.ledgerKey = key;
    return clone;
  };

  // Preserve insertion order. Only trim the oldest entries when an old or
  // corrupt index exceeds the cap; never reorder for "last used".
  const normalizeLedgerIndex = (raw = {}) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const ledgers = [];
    const entries = Array.isArray(source.ledgers) ? source.ledgers : [];
    entries.forEach((entry) => {
      const key = entry && typeof entry.key === 'string' ? entry.key.slice(0, 100) : '';
      if (!key || seen.has(key)) return;
      seen.add(key);
      const updatedAt =
        Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 ? entry.updatedAt : 0;
      ledgers.push({ key, updatedAt });
    });

    const trimmed = ledgers.slice(-MAX_LEDGERS);
    const active = trimmed.some((entry) => entry.key === source.active)
      ? source.active
      : trimmed[0]?.key || '';
    return { active, ledgers: trimmed };
  };

  // Six characters normally. Extend only when two local keys share a prefix.
  const shortLedgerId = (key, keys = []) => {
    let length = 6;
    while (
      length < key.length &&
      keys.some(
        (other) =>
          other !== key && other.slice(0, length) === key.slice(0, length)
      )
    ) {
      length += 1;
    }
    return key.slice(0, length);
  };

  // Stable fallback id for old records without one. A random id here would be
  // regenerated on every device and keep the ledger republishing forever.
  const hashText = (text) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  /* ------------------------------------------------------------------ */
  /* Shares                                                             */
  /* ------------------------------------------------------------------ */

  // Spread a minor-unit amount across ids using largest-remainder allocation.
  const splitEvenly = (amountMinor, ids = []) => {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !ids.length) return null;
    const units = distributeUnits(amountMinor, ids.map(() => 1));
    return Object.fromEntries(ids.map((id, index) => [id, units[index]]));
  };

  // Zero-value shares are omitted from stored/synced transactions.
  const compactShares = (shares) =>
    Object.fromEntries(
      Object.entries(shares).filter(
        ([, amount]) => Number.isSafeInteger(amount) && amount > 0
      )
    );

  // `manual` is a map of person id to integer minor units.
  const buildShares = ({ mode = 'equal', amount, payerId, people = [], manual = {} } = {}) => {
    const ids = people.map((person) => (typeof person === 'string' ? person : person.id)).filter(Boolean);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { shares: null, error: 'Enter a valid amount.' };
    }
    if (ids.length < 2) {
      return { shares: null, error: 'Add at least two people.' };
    }
    if (!ids.includes(payerId)) {
      return { shares: null, error: 'Select who paid.' };
    }

    if (mode === 'owed') {
      const others = ids.filter((id) => id !== payerId);
      const split = splitEvenly(amount, others);
      const shares = Object.fromEntries(ids.map((id) => [id, 0]));
      others.forEach((id) => {
        shares[id] = split[id];
      });
      return { shares: compactShares(shares), error: null };
    }

    if (mode === 'manual') {
      const shares = {};
      let total = 0;
      ids.forEach((id) => {
        const value = manual[id] === undefined || manual[id] === '' ? 0 : manual[id];
        shares[id] = Number.isSafeInteger(value) && value >= 0 ? value : NaN;
        total += shares[id];
      });
      if (Object.values(shares).some((value) => !Number.isSafeInteger(value) || value < 0)) {
        return { shares: null, error: 'Enter valid amounts.' };
      }
      if (total !== amount) {
        return { shares: null, error: 'Shares must add up to the total.' };
      }
      return { shares: compactShares(shares), error: null };
    }

    return { shares: compactShares(splitEvenly(amount, ids)), error: null };
  };

  /* ------------------------------------------------------------------ */
  /* Ledger                                                             */
  /* ------------------------------------------------------------------ */

  const computeLedger = (people = [], transactions = []) => {
    const ids = people.map((person) => person.id);
    const paid = Object.fromEntries(ids.map((id) => [id, 0]));
    const spent = Object.fromEntries(ids.map((id) => [id, 0]));

    transactions.forEach((transaction) => {
      if (!Object.prototype.hasOwnProperty.call(paid, transaction.payerId)) return;

      const amount = Number(transaction.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) return;
      paid[transaction.payerId] += amount;

      Object.entries(transaction.shares || {}).forEach(([id, value]) => {
        if (!Object.prototype.hasOwnProperty.call(spent, id)) return;

        const cents = Number(value);
        if (!Number.isSafeInteger(cents) || cents <= 0) return;
        spent[id] += cents;
      });
    });

    const balances = Object.fromEntries(
      ids.map((id) => [id, paid[id] - spent[id]])
    );
    return { paid, spent, balances };
  };

  const computeTransfers = (people = [], transactions = []) => {
    const ids = people.map((person) => person.id);
    const { balances } = computeLedger(people, transactions);
    const values = ids.map((id) => fromMinor(balances[id]));
    return settleBalances(values).map((transfer) => ({
      fromId: ids[transfer.from],
      toId: ids[transfer.to],
      amount: transfer.amount,
    }));
  };

  /* ------------------------------------------------------------------ */
  /* Handoff                                                            */
  /* ------------------------------------------------------------------ */

  // Handoff links can be double-encoded (for example from file:// or manual
  // copies), leaving `%7C` after URLSearchParams already decoded once.
  const decodeHandoffValue = (value) => {
    const text = String(value == null ? '' : value);
    if (!text.includes('%')) return text;
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };

  // Validate the one-time split bill handoff carried in the query string.
  const readHandoff = (search) => {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    if (params.get('from') !== 'split') return null;

    const names = decodeHandoffValue(params.get('p')).split('|').map(cleanPersonName);
    const rawAmounts = decodeHandoffValue(params.get('a')).split('|');
    const total = Number(params.get('t'));

    if (names.length < 2 || names.length > MAX_PEOPLE) return null;
    if (names.some((name) => !name)) return null;
    if (new Set(names.map(nameKey)).size !== names.length) return null;
    if (rawAmounts.length !== names.length) return null;

    const amounts = rawAmounts.map((raw) => {
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= 0 ? value : NaN;
    });
    if (amounts.some((value) => !Number.isSafeInteger(value))) return null;
    if (!Number.isSafeInteger(total) || total <= 0) return null;
    if (amounts.reduce((sum, value) => sum + value, 0) !== total) return null;
    if (!amounts.some((value) => value > 0)) return null;

    return {
      total,
      people: names.map((name, index) => ({ name, amount: amounts[index] })),
    };
  };

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  const createState = () => ({
    rev: 0,
    ledgerKey: '',
    people: [],
    transactions: [],
  });

  // Drop malformed stored data instead of letting it break the page.
  const normalizeState = (raw) => {
    if (!raw || typeof raw !== 'object') return createState();
    if (!Array.isArray(raw.people) || !Array.isArray(raw.transactions)) return createState();

    // Missing revs come from older or hand-written data; treat them as
    // generation 0, or 1 when there is real transaction data to preserve.
    let rev = Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
    const ledgerKey = typeof raw.ledgerKey === 'string' ? raw.ledgerKey.slice(0, 100) : '';
    const seenIds = new Set();
    const people = [];
    raw.people.forEach((person) => {
      const id = person && typeof person.id === 'string' ? person.id : '';
      const name = cleanPersonName(person && person.name);
      if (!id || !name || seenIds.has(id)) return;
      if (people.some((existing) => nameKey(existing.name) === nameKey(name))) return;
      seenIds.add(id);
      people.push({ id, name });
    });
    const ids = new Set(people.map((person) => person.id));
    const transactions = [];
    const transactionIds = new Set();

    raw.transactions.forEach((transaction) => {
      if (!transaction || typeof transaction !== 'object') return;
      if (!ids.has(transaction.payerId)) return;

      const amount = Number(transaction.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) return;

      const mode = MODES.includes(transaction.mode) ? transaction.mode : 'equal';
      const shares = {};
      Object.entries(transaction.shares || {}).forEach(([id, value]) => {
        if (!ids.has(id) || !Number.isSafeInteger(value) || value <= 0) return;
        shares[id] = value;
      });

      const allTotal = Object.values(shares).reduce((sum, value) => sum + value, 0);
      const otherTotal = Object.entries(shares)
        .filter(([id]) => id !== transaction.payerId)
        .reduce((sum, [, value]) => sum + value, 0);
      const valid =
        mode === 'owed'
          ? otherTotal === amount && (shares[transaction.payerId] || 0) === 0
          : allTotal === amount;
      if (!valid) return;

      // Invalid dates fall back to the epoch, not to "now": every client must
      // normalize the same record to the same bytes or sync never converges.
      let createdAt = new Date(0);
      if (transaction.createdAt && !Number.isNaN(Date.parse(transaction.createdAt))) {
        createdAt = new Date(transaction.createdAt);
      }
      const createdAtIso = createdAt.toISOString();
      const name = cleanTransactionName(transaction.name) || DEFAULT_TRANSACTION_NAME;

      // Keep the first record for a duplicated id instead of minting a random
      // one, and derive a deterministic id when the stored record has none.
      const id =
        typeof transaction.id === 'string' && transaction.id
          ? transaction.id
          : `t_${hashText(
              JSON.stringify([name, transaction.payerId, amount, mode, shares, createdAtIso])
            )}`;
      if (transactionIds.has(id)) return;
      transactionIds.add(id);

      transactions.push({
        id,
        name,
        payerId: transaction.payerId,
        amount,
        mode,
        shares,
        createdAt: createdAtIso,
      });
    });

    if (rev === 0 && transactions.length) rev = 1;

    return { rev, ledgerKey, people, transactions };
  };

  /* ------------------------------------------------------------------ */
  /* Sync ordering                                                      */
  /* ------------------------------------------------------------------ */

  // At this edit frequency, equal revisions from independent editors are not
  // expected. Higher rev wins; equal revs are left alone until the next edit.
  const compareStates = (a, b) => {
    const revA = Number.isSafeInteger(a?.rev) ? a.rev : 0;
    const revB = Number.isSafeInteger(b?.rev) ? b.rev : 0;
    if (revA === revB) return 0;
    return revA > revB ? 1 : -1;
  };

  const bumpRev = (state) => (Number.isSafeInteger(state?.rev) ? state.rev : 0) + 1;

  /* ------------------------------------------------------------------ */
  /* Sync                                                               */
  /* ------------------------------------------------------------------ */

  const SYNC_HOST = 'wss://pubsub.h.kvn.pt';
  const SYNC_APP_KEY = 'spill';
  const SYNC_KEY_PARAM = 'k';
  const SYNC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  // The SDK's own timer is disabled; the page publishes explicitly after a
  // local edit and never before the first snapshot has been read.
  const PUB_FREQUENCY_MS = 24 * 60 * 60 * 1000;
  const SYNC_READY_TIMEOUT_MS = 4000;

  const makeSyncKey = () => {
    const bytes = new Uint8Array(30);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, (byte) => SYNC_ALPHABET[byte % SYNC_ALPHABET.length]).join('');
  };

  const readUrlKey = () => {
    try {
      return (new URLSearchParams(window.location.search).get(SYNC_KEY_PARAM) || '')
        .trim()
        .slice(0, 100);
    } catch {
      return '';
    }
  };

  const setUrlKey = (key) => {
    if (!key) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(SYNC_KEY_PARAM, key);
      window.history.replaceState(null, '', url);
    } catch { }
  };

  const readStorageValue = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return { found: false };
      try {
        return { found: true, value: JSON.parse(raw) };
      } catch {
        return { found: true, corrupt: true, raw };
      }
    } catch {
      return { found: false };
    }
  };

  const backupStorageValue = (key, raw) => {
    try {
      localStorage.setItem(`${key}:corrupt`, raw);
    } catch { }
  };

  const removeStorageValue = (key) => {
    try {
      localStorage.removeItem(key);
    } catch { }
  };

  const writeLedger = (key, state) => {
    if (!key) return false;
    try {
      localStorage.setItem(ledgerStorageKey(key), JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  };

  const writeIndex = (active, ledgers) => {
    try {
      localStorage.setItem(INDEX_STORAGE, JSON.stringify({ active, ledgers }));
      return true;
    } catch {
      return false;
    }
  };

  const scanLedgerBuckets = () => {
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const name = localStorage.key(index);
        if (!name || !name.startsWith(LEDGER_PREFIX)) continue;
        const key = name.slice(LEDGER_PREFIX.length);
        if (!key || key.endsWith(':corrupt')) continue;
        keys.push(key);
      }
    } catch { }
    return keys;
  };

  // Load the index, rebuild it from buckets, or migrate the old single ledger.
  const loadIndex = () => {
    const stored = readStorageValue(INDEX_STORAGE);
    if (stored.found && !stored.corrupt) {
      const index = normalizeLedgerIndex(stored.value);
      if (index.ledgers.length) return { index, repaired: false, migrated: false };
    }

    let repaired = false;
    if (stored.corrupt) {
      backupStorageValue(INDEX_STORAGE, stored.raw);
      removeStorageValue(INDEX_STORAGE);
      repaired = true;
    }

    const bucketKeys = scanLedgerBuckets();
    if (bucketKeys.length) {
      let legacyKey = '';
      try {
        legacyKey = (localStorage.getItem(LEGACY_KEY_STORAGE) || '').slice(0, 100);
      } catch { }
      const index = normalizeLedgerIndex({
        active: legacyKey,
        ledgers: bucketKeys.map((key) => ({ key, updatedAt: 0 })),
      });
      writeIndex(index.active, index.ledgers);
      return { index, repaired, migrated: false };
    }

    const legacy = readStorageValue(STORAGE);
    if (legacy.found && !legacy.corrupt) {
      let legacyKey = '';
      try {
        legacyKey = (localStorage.getItem(LEGACY_KEY_STORAGE) || '').slice(0, 100);
      } catch { }
      const state = normalizeState(legacy.value);
      const key = (state.ledgerKey || legacyKey || makeSyncKey()).slice(0, 100);
      state.ledgerKey = key;
      const index = { active: key, ledgers: [{ key, updatedAt: Date.now() }] };
      const written = writeLedger(key, state) && writeIndex(index.active, index.ledgers);
      if (written) {
        try {
          localStorage.setItem(
            'spill:settle:legacy',
            JSON.stringify({ state: legacy.value, key: legacyKey })
          );
        } catch { }
        removeStorageValue(STORAGE);
        removeStorageValue(LEGACY_KEY_STORAGE);
      }
      return { index, repaired, migrated: true, state };
    }
    if (legacy.corrupt) {
      backupStorageValue(STORAGE, legacy.raw);
      removeStorageValue(STORAGE);
      repaired = true;
    }

    return { index: { active: '', ledgers: [] }, repaired, migrated: false };
  };

  const loadLedger = (key) => {
    const stored = readStorageValue(ledgerStorageKey(key));
    if (stored.corrupt) {
      backupStorageValue(ledgerStorageKey(key), stored.raw);
      removeStorageValue(ledgerStorageKey(key));
      const state = createState();
      state.ledgerKey = key;
      return { state, fresh: true, repaired: true };
    }
    if (stored.found && stored.value && typeof stored.value === 'object') {
      const state = normalizeState(stored.value);
      if (state.ledgerKey && state.ledgerKey !== key) {
        backupStorageValue(ledgerStorageKey(key), JSON.stringify(stored.value));
        const fresh = createState();
        fresh.ledgerKey = key;
        return { state: fresh, fresh: true, repaired: true };
      }
      state.ledgerKey = key;
      return {
        state,
        fresh: state.rev === 0 && state.transactions.length === 0,
        repaired: false,
      };
    }

    const state = createState();
    state.ledgerKey = key;
    return { state, fresh: true, repaired: false };
  };

  // The SDK reads `k` from the URL only. Add it temporarily when needed.
  const withUrlSyncKey = (key, callback) => {
    const url = new URL(window.location.href);
    const existing = url.searchParams.get(SYNC_KEY_PARAM);
    if (existing) return callback();

    url.searchParams.set(SYNC_KEY_PARAM, key);
    try {
      window.history.replaceState(null, '', url);
    } catch {
      return callback();
    }

    try {
      return callback();
    } finally {
      if (existing === null) url.searchParams.delete(SYNC_KEY_PARAM);
      else url.searchParams.set(SYNC_KEY_PARAM, existing);
      try {
        window.history.replaceState(null, '', url);
      } catch { }
    }
  };

  // Localhost needs a local PubSub server: the deployed host rejects local
  // origins with a 403. Run `node server.js` in the pubsub project for dev.
  const getSyncHost = () => {
    const name = window.location.hostname;
    if (
      name === 'localhost' ||
      name === '127.0.0.1' ||
      name === '0.0.0.0' ||
      name === '::1' ||
      name === '[::1]'
    ) {
      return 'ws://localhost:8075';
    }
    return SYNC_HOST;
  };

  const createSyncClient = (key, { getData, setData }) => {
    if (!key || typeof PubSub === 'undefined') return null;
    return withUrlSyncKey(
      key,
      () =>
        new PubSub({
          host: getSyncHost(),
          appKey: SYNC_APP_KEY,
          subKeyParam: SYNC_KEY_PARAM,
          getData,
          setData,
          pubFrequency: PUB_FREQUENCY_MS,
        })
    );
  };

  const settle = {
    STORAGE,
    INDEX_STORAGE,
    MAX_LEDGERS,
    MAX_PEOPLE,
    MODES,
    DEFAULT_TRANSACTION_NAME,
    newId,
    cleanPersonName,
    cleanTransactionName,
    nameKey,
    sameRoster,
    ledgerStorageKey,
    cloneLedgerState,
    normalizeLedgerIndex,
    shortLedgerId,
    splitEvenly,
    buildShares,
    computeLedger,
    computeTransfers,
    readHandoff,
    normalizeState,
    createState,
    compareStates,
    bumpRev,
    loadIndex,
    loadLedger,
  };
  if (typeof module === 'object' && module.exports) module.exports = settle;
  if (typeof document === 'undefined') return;

  const ROUND_STORAGE = 'spill:roundWhole';
  const TRANSACTION_WARNING_THRESHOLD = 300;
  const SETTINGS_CONFLICT = 'People changed elsewhere. Cancel and reopen.';

  // Must run before Alpine initializes $persist.
  if (repairStoredJson(ROUND_STORAGE, (value) => typeof value === 'boolean')) {
    toast.error('Settings were unreadable and reset.');
  }

  // One PubSub client per page; kept out of Alpine's reactive state.
  let pubsub = null;

  // Drop handoff fields but keep unrelated params such as the sync key.
  const clearHandoffParams = () => {
    const url = new URL(window.location.href);
    ['from', 't', 'p', 'a'].forEach((param) => url.searchParams.delete(param));
    try {
      window.history.replaceState(null, '', url);
    } catch { }
  };

  /* ------------------------------------------------------------------ */
  /* Component                                                          */
  /* ------------------------------------------------------------------ */

  document.addEventListener('alpine:init', () => {
    Alpine.data('settle', function () {
      return {
        state: createState(),
        roundWhole: this.$persist(true).as(ROUND_STORAGE),
        formOpen: false,
        form: null,
        settingsDraft: [],
        settingsBase: [],
        settingsError: '',
        settingsLedgers: [],
        settingsLedgerStates: {},
        settingsLedgerKey: '',
        ledgerError: '',
        ledgers: [],
        syncKey: '',
        syncReady: false,
        syncReadyTimer: null,
        receivedRemote: false,
        freshJoin: false,
        lastPublishedRev: 0,

        /* ---------------------------- State --------------------------- */

        get balanceRows() {
          const ledger = computeLedger(this.state.people, this.state.transactions);
          return this.state.people.map((person) => ({
            id: person.id,
            name: person.name,
            paid: fromMinor(ledger.paid[person.id] || 0),
            spent: fromMinor(ledger.spent[person.id] || 0),
            balance: fromMinor(ledger.balances[person.id] || 0),
          }));
        },

        get transfers() {
          const names = Object.fromEntries(
            this.state.people.map((person) => [person.id, person.name])
          );
          return computeTransfers(this.state.people, this.state.transactions).map(
            (transfer) => ({
              fromId: transfer.fromId,
              toId: transfer.toId,
              from: names[transfer.fromId] || '?',
              to: names[transfer.toId] || '?',
              amount: transfer.amount,
            })
          );
        },

        get sortedTransactions() {
          return this.state.transactions
            .slice()
            .sort((a, b) => compareText(String(b.createdAt), String(a.createdAt)));
        },

        get transactionWarning() {
          const count = this.state.transactions.length;
          if (count <= TRANSACTION_WARNING_THRESHOLD) return '';
          return `${count} transactions. Large ledgers can be slow and use more sync data.`;
        },

        get canAddTransaction() {
          return this.state.people.length >= 2;
        },

        ledgerId(key) {
          return shortLedgerId(
            key.toUpperCase(),
            this.settingsLedgers.map((entry) => entry.key.toUpperCase())
          );
        },

        ledgerCountLabel(count) {
          const value = Number.isFinite(count) ? count : 0;
          return `(${value} transaction${value === 1 ? '' : 's'})`;
        },

        persistLedger() {
          if (!this.syncKey || !this.state) return;
          if (this.state.ledgerKey !== this.syncKey) return;
          writeLedger(this.syncKey, this.state);
          const updatedAt = Date.now();
          const entry = this.ledgers.find((ledger) => ledger.key === this.syncKey);
          if (entry) entry.updatedAt = updatedAt;
          else this.ledgers.push({ key: this.syncKey, updatedAt });
          writeIndex(this.syncKey, this.ledgers);
        },

        get formPayerOptions() {
          if (!this.form) return this.state.people;
          const staged = this.form.stagedPeople || [];
          return staged.length ? [...this.state.people, ...staged] : this.state.people;
        },

        get formAmountMinor() {
          return this.form ? toMinor(this.form.amount) : NaN;
        },

        get formManualMinor() {
          const values = {};
          this.formPayerOptions.forEach((person) => {
            const raw = this.form?.manual?.[person.id];
            const text = raw == null ? '' : String(raw).trim();
            values[person.id] = text ? toMinor(text) : 0;
          });
          return values;
        },

        get formManualTotal() {
          return Object.values(this.formManualMinor).reduce(
            (sum, value) => (Number.isFinite(value) ? sum + value : NaN),
            0
          );
        },

        get formManualValid() {
          const amount = this.formAmountMinor;
          const total = this.formManualTotal;
          return (
            Number.isSafeInteger(amount) &&
            amount > 0 &&
            Number.isSafeInteger(total) &&
            total === amount
          );
        },

        get formCanSave() {
          if (!this.form || this.form.syncPending) return false;
          const amount = this.formAmountMinor;
          if (!Number.isSafeInteger(amount) || amount <= 0) return false;
          if (!this.formPayerOptions.some((person) => person.id === this.form.payerId)) return false;
          if (this.form.mode === 'manual') return this.formManualValid;
          return true;
        },

        get formModeHelp() {
          if (!this.form) return '';
          if (this.form.mode === 'owed') {
            return 'Only non-payers share this total.';
          }
          if (this.form.mode === 'manual') {
            return 'Enter each person’s share. The payer’s row is not a debt.';
          }
          return 'The total is split among everyone, including the payer.';
        },

        get formInlineError() {
          if (!this.form || this.form.mode !== 'manual') return '';
          const amount = this.formAmountMinor;
          if (!Number.isSafeInteger(amount) || amount <= 0) return '';
          const total = this.formManualTotal;
          if (!Number.isFinite(total)) return 'Enter valid amounts.';
          if (total === amount) return '';

          const difference = Math.abs(amount - total);
          const label = total < amount ? 'Under by' : 'Over by';
          return `${label}: ${formatAmount(fromMinor(difference), false)}.`;
        },

        /* ---------------------------- Setup --------------------------- */

        init() {
          window.addEventListener('resize', () => this.syncViewport());
          window.visualViewport?.addEventListener('resize', () => this.syncViewport());
          window.visualViewport?.addEventListener('scroll', () => this.syncViewport());
          this.syncViewport();

          const loaded = loadIndex();
          this.ledgers = loaded.index.ledgers;

          let key = loaded.index.active || '';
          const urlKey = readUrlKey();
          let blocked = false;

          if (urlKey) {
            if (this.ledgers.some((entry) => entry.key === urlKey)) {
              key = urlKey;
            } else if (this.ledgers.length >= MAX_LEDGERS) {
              blocked = true;
              key = loaded.index.active || this.ledgers[0]?.key || '';
            } else {
              key = urlKey;
              this.ledgers = [...this.ledgers, { key, updatedAt: Date.now() }];
            }
          }

          if (!key) {
            key = makeSyncKey();
            this.ledgers = [...this.ledgers, { key, updatedAt: Date.now() }];
          } else if (!this.ledgers.some((entry) => entry.key === key)) {
            this.ledgers = [...this.ledgers, { key, updatedAt: Date.now() }];
          }

          this.syncKey = key;
          writeIndex(key, this.ledgers);
          setUrlKey(key);

          const ledger =
            loaded.state && loaded.index.active === key
              ? { state: loaded.state, fresh: false, repaired: false }
              : loadLedger(key);
          this.state = ledger.state;
          this.lastPublishedRev = this.state.rev;
          this.freshJoin = ledger.fresh;
          this.$watch('state', () => this.persistLedger());
          this.persistLedger();

          if (loaded.repaired) {
            toast.error('Saved data was unreadable; recovered what we could (backup kept).');
          }
          if (ledger.repaired) {
            toast.error('Ledger was unreadable; started fresh (backup kept).');
          }
          if (blocked) {
            clearHandoffParams();
            toast.error(
              `Limit: ${MAX_LEDGERS} ledgers. Delete one, then reopen the link.`
            );
          }

          // Show the handoff editor immediately; Save stays locked until the
          // first sync snapshot (or the readiness timeout) finalizes the
          // roster. Otherwise the page looks unresponsive for a few seconds.
          if (!blocked) {
            const payload = readHandoff(window.location.search);
            if (payload) {
              const overrides = this.handoffOverrides(payload, { provisional: true });
              if (overrides) {
                this.startForm({ ...overrides, syncPending: true });
                this.form.peopleSnapshot = this.formPayerOptions.map((person) => ({
                  ...person,
                }));
              } else {
                clearHandoffParams();
                toast.error(`Too many people (limit: ${MAX_PEOPLE}).`);
              }
            }
          }

          if (!this.syncKey || typeof PubSub === 'undefined') {
            this.markSyncReady();
            return;
          }

          this.connectSync();
        },

        connectSync() {
          if (pubsub || !this.syncKey) return;

          try {
            pubsub = createSyncClient(this.syncKey, {
              getData: () => this.state,
              setData: (data) => this.applyRemote(data),
            });
          } catch {
            pubsub = null;
            this.markSyncReady();
            return;
          }

          if (!pubsub) {
            this.markSyncReady();
            return;
          }

          this.syncReadyTimer = setTimeout(() => {
            this.syncReadyTimer = null;
            if (!this.receivedRemote) this.markSyncReady();
          }, SYNC_READY_TIMEOUT_MS);
        },

        // No publishing before the first snapshot: a stale device must read
        // before it can overwrite newer state.
        markSyncReady() {
          if (this.syncReady) return;
          this.syncReady = true;
          if (this.syncReadyTimer) {
            clearTimeout(this.syncReadyTimer);
            this.syncReadyTimer = null;
          }

          this.applyHandoff();

          // Empty channel (or no sync key): push real local data. A fresh
          // ledger has rev 0 and is not published until it is edited.
          if (!this.receivedRemote && this.state.rev > 0) this.publish();
        },

        publish() {
          if (!this.syncReady || !pubsub) return;
          if (this.state.rev <= 0) return;
          this.lastPublishedRev = this.state.rev;
          pubsub.pub();
        },

        touch() {
          this.state.rev = bumpRev(this.state);
          this.publish();
        },

        // Whole-state last-write-wins: higher rev, then canonical content.
        applyRemote(data) {
          if (!data || typeof data !== 'object') return;
          if (!Array.isArray(data.people) || !Array.isArray(data.transactions)) return;

          const next = normalizeState(data);
          // Never adopt a snapshot belonging to another channel.
          if (next.ledgerKey && next.ledgerKey !== this.syncKey) return;
          if (this.syncKey) next.ledgerKey = this.syncKey;
          this.receivedRemote = true;
          const order = compareStates(next, this.state);
          // A first-time key seeds only an empty channel; a payload with real
          // data wins over the local seed.
          const adopt =
            (this.freshJoin && (next.rev > 0 || next.transactions.length > 0)) ||
            order > 0;

          if (adopt) {
            const dirty = this.state.rev > this.lastPublishedRev;
            this.state = next;
            this.lastPublishedRev = next.rev;
            if (dirty) {
              toast.error('A newer ledger replaced your edit.');
            }
          }

          this.freshJoin = false;
          this.markSyncReady();
          if (!adopt && order < 0) this.publish();
        },

        async copySyncLink(key = this.syncKey) {
          if (!key) return;

          const url = new URL(window.location.href);
          url.search = '';
          url.searchParams.set(SYNC_KEY_PARAM, key);
          const copied = await copyToClipboard(url.toString());
          copied
            ? toast.success('Link copied.')
            : toast.error('Clipboard unavailable.');
        },

        // Build the prefilled manual form for a split-bill handoff. Staged
        // people are generated fresh each call, so the caller matches edits
        // back by name when re-applying after sync.
        handoffOverrides(payload, { provisional = false } = {}) {
          const byName = new Map(
            this.state.people.map((person) => [nameKey(person.name), person])
          );
          const staged = [];
          const handoff = payload.people.map(({ name, amount }) => {
            let person = byName.get(nameKey(name));
            if (!person) {
              person = { id: newId('p'), name: cleanPersonName(name) };
              staged.push(person);
              byName.set(nameKey(person.name), person);
            }
            return { id: person.id, amount };
          });

          const rosterCount = this.state.people.length + staged.length;
          if (!provisional && rosterCount > MAX_PEOPLE) return null;

          return {
            amount: String(fromMinor(payload.total)),
            mode: 'manual',
            stagedPeople: staged,
            manual: Object.fromEntries(
              handoff.map((entry) => [
                entry.id,
                entry.amount > 0 ? String(fromMinor(entry.amount)) : '',
              ])
            ),
          };
        },

        // Keep whatever the user already changed in the locked editor while
        // the roster is being finalized. IDs from before sync may differ, so
        // match payer and manual values by person name.
        restorePendingForm(pending) {
          if (!this.form) return;
          const people = pending.peopleSnapshot || [];
          const payer = people.find((person) => person.id === pending.payerId);

          this.form.amount = pending.amount;
          this.form.name = pending.name;
          this.form.mode = pending.mode || 'manual';
          this.form.syncPending = false;

          if (payer) {
            const match = this.formPayerOptions.find(
              (person) => nameKey(person.name) === nameKey(payer.name)
            );
            if (match) this.form.payerId = match.id;
          }

          const manualByName = new Map();
          people.forEach((person) => {
            const value = pending.manual?.[person.id];
            if (value != null) manualByName.set(nameKey(person.name), value);
          });
          this.formPayerOptions.forEach((person) => {
            const value = manualByName.get(nameKey(person.name));
            if (value != null) this.form.manual[person.id] = value;
          });
        },

        applyHandoff() {
          const query = new URLSearchParams(String(window.location.search || '').replace(/^\?/, ''));
          const payload = readHandoff(window.location.search);

          if (!payload) {
            // Do not leave a truncated or malformed bill link in the URL with
            // no explanation.
            if (query.get('from') === 'split') {
              clearHandoffParams();
              toast.error('Bill link is incomplete.');
            }
            return false;
          }

          const pending = this.form?.syncPending ? this.form : null;
          const overrides = this.handoffOverrides(payload);

          if (!overrides) {
            clearHandoffParams();
            if (pending) this.cancelForm();
            toast.error(`Too many people (limit: ${MAX_PEOPLE}).`);
            return true;
          }

          this.startForm(overrides);
          if (pending) this.restorePendingForm(pending);
          clearHandoffParams();
          return true;
        },

        /* ----------------------------- Form --------------------------- */

        startAdd() {
          if (!this.canAddTransaction) {
            toast.error('Add at least two people.');
            return;
          }
          this.startForm(null);
        },

        startForm(overrides) {
          const staged = overrides?.stagedPeople || [];
          const people = [...this.state.people, ...staged];
          const manual = Object.fromEntries(people.map((person) => [person.id, '']));
          Object.assign(manual, overrides?.manual || {});

          this.form = {
            id: null,
            name: '',
            payerId: '',
            amount: '',
            mode: 'equal',
            stagedPeople: [],
            syncPending: false,
            ...(overrides || {}),
            manual,
            error: null,
          };
          this.formOpen = true;
          this.$nextTick(() => {
            const dialog = this.$refs.txnDialog;
            if (dialog && !dialog.open) dialog.showModal();
          });
        },

        cancelForm() {
          // Dismissing the provisional handoff editor abandons the link too;
          // otherwise the pending sync would reopen the same form.
          const pendingHandoff = this.form?.syncPending;
          const dialog = this.$refs.txnDialog;
          if (dialog?.open) dialog.close();
          this.formOpen = false;
          this.form = null;
          if (pendingHandoff) clearHandoffParams();
        },

        syncViewport() {
          const vv = window.visualViewport;
          const height = Math.round(vv ? vv.height : window.innerHeight);
          document.documentElement.style.setProperty(
            '--app-viewport-height',
            `${height}px`
          );
        },

        previewFor(mode) {
          if (!this.form) return {};
          const amount = this.formAmountMinor;
          const people = this.formPayerOptions.map((person) => person.id);
          if (!Number.isSafeInteger(amount) || amount <= 0) return {};
          if (!people.includes(this.form.payerId)) return {};

          const result = buildShares({
            mode,
            amount,
            payerId: this.form.payerId,
            people,
            manual: this.formManualMinor,
          });
          return result.shares || {};
        },

        setMode(mode) {
          if (!this.form || this.form.mode === mode) return;
          const previous = this.form.mode;
          this.form.mode = mode;
          this.form.error = null;
          if (mode === 'manual' && previous !== 'manual') {
            const hasValues = this.formPayerOptions.some(
              (person) => String(this.form.manual[person.id] || '').trim() !== ''
            );
            if (!hasValues) this.prefillManual(previous);
          }
        },

        // Carry the visible split into the manual inputs as a starting point.
        prefillManual(mode) {
          const preview = this.previewFor(mode);
          if (!Object.keys(preview).length) return;
          this.formPayerOptions.forEach((person) => {
            const cents = preview[person.id] || 0;
            this.form.manual[person.id] = cents > 0 ? String(fromMinor(cents)) : '';
          });
        },

        // Staged handoff people live only in the form. Commit them on save,
        // keeping only new people with a share or the payer, reusing any
        // same-name person that arrived from sync while the form was open,
        // then remap the transaction's payer and shares.
        commitStagedPeople(form, transaction) {
          const staged = form?.stagedPeople || [];
          if (!staged.length) return;

          const idMap = new Map();
          staged.forEach((person) => {
            const paid = transaction.payerId === person.id;
            const share = transaction.shares[person.id] || 0;
            if (!paid && share <= 0) return;

            const existing = this.state.people.find(
              (entry) => nameKey(entry.name) === nameKey(person.name)
            );
            if (existing) {
              idMap.set(person.id, existing.id);
              return;
            }
            if (!this.state.people.some((entry) => entry.id === person.id)) {
              this.state.people.push(person);
            }
          });

          if (!idMap.size) return;
          if (idMap.has(transaction.payerId)) {
            transaction.payerId = idMap.get(transaction.payerId);
          }
          const shares = {};
          Object.entries(transaction.shares).forEach(([id, amount]) => {
            const nextId = idMap.get(id) || id;
            shares[nextId] = (shares[nextId] || 0) + amount;
          });
          transaction.shares = shares;
        },

        saveTransaction() {
          const form = this.form;
          if (!form || form.syncPending) return;

          const amount = this.formAmountMinor;
          const result = buildShares({
            mode: form.mode,
            amount,
            payerId: form.payerId,
            people: this.formPayerOptions.map((person) => person.id),
            manual: this.formManualMinor,
          });
          if (result.error) {
            form.error = result.error;
            return;
          }

          const existing = form.id
            ? this.state.transactions.find((transaction) => transaction.id === form.id)
            : null;
          const now = new Date().toISOString();
          const transaction = {
            id: existing?.id || newId('t'),
            name: cleanTransactionName(form.name) || DEFAULT_TRANSACTION_NAME,
            payerId: form.payerId,
            amount,
            mode: form.mode,
            shares: result.shares,
            createdAt: existing?.createdAt || now,
          };

          this.commitStagedPeople(form, transaction);

          if (existing) {
            const index = this.state.transactions.indexOf(existing);
            this.state.transactions.splice(index, 1, transaction);
            toast.success('Transaction updated.');
          } else {
            this.state.transactions.push(transaction);
            toast.success('Transaction saved.');
          }

          this.touch();
          this.cancelForm();
        },

        editTransaction(transaction) {
          const manual = Object.fromEntries(
            this.state.people.map((person) => [
              person.id,
              transaction.shares[person.id]
                ? String(fromMinor(transaction.shares[person.id]))
                : '',
            ])
          );

          this.startForm({
            id: transaction.id,
            name: transaction.name,
            payerId: transaction.payerId,
            amount: String(fromMinor(transaction.amount)),
            mode: transaction.mode,
            manual,
          });
        },

        deleteTransaction(transaction) {
          if (!confirm(`Delete "${transaction.name}"?`)) return;
          const index = this.state.transactions.findIndex(
            (entry) => entry.id === transaction.id
          );
          if (index === -1) return;
          this.state.transactions.splice(index, 1);
          this.touch();
          if (this.form?.id === transaction.id) this.cancelForm();
          toast.success('Transaction deleted.');
        },

        recordSettlement(transfer, amount, createdAt) {
          this.state.transactions.push({
            id: newId('t'),
            name: 'Settlement Payment',
            payerId: transfer.fromId,
            amount,
            mode: 'manual',
            shares: { [transfer.toId]: amount },
            createdAt,
          });
        },

        closeTransfer(transfer) {
          const amount = toMinor(transfer.amount);
          if (!Number.isSafeInteger(amount) || amount <= 0) return;

          const message = `Record settlement: ${transfer.from} pays ${transfer.to} ${this.formatAmount(
            transfer.amount
          )}?`;
          if (!confirm(message)) return;

          this.recordSettlement(transfer, amount, new Date().toISOString());
          this.touch();
          toast.success(
            `Settlement recorded: ${transfer.from} → ${transfer.to}, ${this.formatAmount(
              transfer.amount
            )}.`
          );
        },

        settleAll() {
          const payments = this.transfers
            .map((transfer) => {
              const amount = toMinor(transfer.amount);
              return Number.isSafeInteger(amount) && amount > 0
                ? { transfer, amount }
                : null;
            })
            .filter(Boolean);

          if (!payments.length) {
            toast.error('No settlement needed.');
            return;
          }

          const count = payments.length;
          if (!confirm(`Record ${count} settlement${count === 1 ? '' : 's'}?`)) return;

          const createdAt = new Date().toISOString();
          payments.forEach(({ transfer, amount }) => {
            this.recordSettlement(transfer, amount, createdAt);
          });
          this.touch();

          if (count === 1) {
            const { transfer } = payments[0];
            toast.success(
              `Settlement recorded: ${transfer.from} → ${transfer.to}, ${this.formatAmount(
                transfer.amount
              )}.`
            );
          } else {
            toast.success(`${count} settlements recorded.`);
          }
        },

        /* --------------------------- Settings ------------------------- */

        openPeople() {
          this.settingsBase = this.state.people.map((person) => ({
            id: person.id,
            name: person.name,
          }));
          this.settingsDraft = this.state.people.map((person) => ({ ...person }));
          this.settingsError = '';
          this.$nextTick(() => {
            const dialog = this.$refs.peopleDialog;
            dialog?.showModal();
            dialog?.focus();
          });
        },

        closePeople() {
          if (!this.applyDraftPeople()) return;
          this.settingsBase = [];
          this.settingsDraft = [];
          this.settingsError = '';
          this.$refs.peopleDialog?.close();
        },

        cancelPeople() {
          this.settingsBase = [];
          this.settingsDraft = [];
          this.settingsError = '';
          this.$refs.peopleDialog?.close();
        },

        openLedgers() {
          this.settingsLedgers = this.ledgers.map((ledger) => {
            let count = 0;
            if (ledger.key === this.syncKey) {
              count = this.state.transactions.length;
            } else {
              const stored = readStorageValue(ledgerStorageKey(ledger.key));
              if (
                stored.found &&
                !stored.corrupt &&
                stored.value &&
                Array.isArray(stored.value.transactions)
              ) {
                count = stored.value.transactions.length;
              }
            }
            return { ...ledger, count };
          });
          this.settingsLedgerStates = {};
          this.settingsLedgerKey = this.syncKey;
          this.ledgerError = '';
          this.$nextTick(() => {
            this.$refs.ledgerDialog?.showModal();
          });
        },

        closeLedgers() {
          if (!this.finishLedgers()) return;
          this.settingsLedgers = [];
          this.settingsLedgerStates = {};
          this.settingsLedgerKey = '';
          this.ledgerError = '';
          this.$refs.ledgerDialog?.close();
        },

        cancelLedgers() {
          this.settingsLedgers = [];
          this.settingsLedgerStates = {};
          this.settingsLedgerKey = '';
          this.ledgerError = '';
          this.$refs.ledgerDialog?.close();
        },

        // Resolve a ledger row to its data, including rows that were added in
        // this dialog and are not on disk yet. Returns null when the bucket is
        // missing or unreadable.
        ledgerStateFor(key) {
          if (!key) return null;
          const pending = this.settingsLedgerStates[key];
          if (pending) return pending;
          if (key === this.syncKey) return this.state;

          const stored = readStorageValue(ledgerStorageKey(key));
          if (!stored.found || stored.corrupt || !stored.value) return null;
          if (
            !Array.isArray(stored.value.people) ||
            !Array.isArray(stored.value.transactions)
          ) {
            return null;
          }

          const state = normalizeState(stored.value);
          if (!state.ledgerKey) state.ledgerKey = key;
          return state;
        },

        addDraftLedger(copyCurrent = false) {
          if (this.settingsLedgers.length >= MAX_LEDGERS) {
            this.ledgerError = `Limit: ${MAX_LEDGERS} ledgers. Delete one first.`;
            return;
          }

          let state;
          if (copyCurrent) {
            // Duplicate the selected radio, which may be another stored
            // ledger or a draft added in this dialog, not the open ledger.
            const source = this.ledgerStateFor(this.settingsLedgerKey);
            if (!source) {
              this.ledgerError = 'That ledger could not be read.';
              return;
            }
            state = cloneLedgerState(source, makeSyncKey());
          } else {
            state = createState();
            state.ledgerKey = makeSyncKey();
          }

          const key = state.ledgerKey;
          this.settingsLedgerStates = {
            ...this.settingsLedgerStates,
            [key]: state,
          };
          this.settingsLedgers = [
            ...this.settingsLedgers,
            { key, updatedAt: Date.now(), count: state.transactions.length },
          ];
          this.settingsLedgerKey = key;
          this.ledgerError = '';
        },

        removeDraftLedger(key) {
          const ledger = this.settingsLedgers.find((entry) => entry.key === key);
          if (!ledger) return;

          if (
            !confirm(
              `Delete ${this.ledgerId(key)} when you save? The shared copy stays until it expires.`
            )
          ) {
            return;
          }

          const states = { ...this.settingsLedgerStates };
          delete states[key];
          this.settingsLedgerStates = states;
          this.settingsLedgers = this.settingsLedgers.filter(
            (entry) => entry.key !== key
          );

          if (this.settingsLedgerKey === key) {
            const mostRecent = this.settingsLedgers
              .slice()
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
            this.settingsLedgerKey = this.settingsLedgers.some(
              (entry) => entry.key === this.syncKey
            )
              ? this.syncKey
              : mostRecent?.key || '';
          }
          this.ledgerError = '';
        },

        navigateToLedger(key) {
          if (!key) return;
          const url = new URL(window.location.href);
          url.search = '';
          url.searchParams.set(SYNC_KEY_PARAM, key);
          window.location.assign(url.toString());
        },

        finishLedgers() {
          const deletingCurrent = !this.settingsLedgers.some(
            (ledger) => ledger.key === this.syncKey
          );

          // Make sure the ledger we are leaving is on disk before touching the
          // index. Skip this when that ledger is being deleted.
          if (!deletingCurrent) this.persistLedger();

          if (!this.settingsLedgers.length) {
            const key = makeSyncKey();
            const state = createState();
            state.ledgerKey = key;
            writeLedger(key, state);
            this.settingsLedgers = [{ key, updatedAt: Date.now() }];
            this.settingsLedgerKey = key;
          }

          const finalKeys = new Set(this.settingsLedgers.map((ledger) => ledger.key));
          this.ledgers
            .filter((ledger) => !finalKeys.has(ledger.key))
            .forEach((ledger) => {
              removeStorageValue(ledgerStorageKey(ledger.key));
              removeStorageValue(`${ledgerStorageKey(ledger.key)}:corrupt`);
            });

          this.settingsLedgers.forEach((ledger) => {
            if (this.ledgers.some((entry) => entry.key === ledger.key)) return;
            const state =
              this.settingsLedgerStates[ledger.key] ||
              (() => {
                const fresh = createState();
                fresh.ledgerKey = ledger.key;
                return fresh;
              })();
            writeLedger(ledger.key, state);
          });

          let target = this.settingsLedgerKey;
          if (!this.settingsLedgers.some((ledger) => ledger.key === target)) {
            const mostRecent = this.settingsLedgers
              .slice()
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
            target = this.settingsLedgers.some(
              (ledger) => ledger.key === this.syncKey
            )
              ? this.syncKey
              : mostRecent.key;
            this.settingsLedgerKey = target;
          }

          const keptActive = this.settingsLedgers.find(
            (ledger) => ledger.key === this.syncKey
          );
          if (keptActive && !deletingCurrent) keptActive.updatedAt = Date.now();

          this.ledgers = this.settingsLedgers;
          writeIndex(target, this.ledgers);

          if (target === this.syncKey && !deletingCurrent) return true;

          this.navigateToLedger(target);
          return false;
        },

        transactionUsage(personId) {
          return this.state.transactions.filter(
            (transaction) =>
              transaction.payerId === personId ||
              (transaction.shares[personId] || 0) > 0
          ).length;
        },

        usedMessage(person, usedBy) {
          return `${person.name} is used by ${usedBy} transaction${usedBy === 1 ? '' : 's'
            }. Edit ${usedBy === 1 ? 'it' : 'them'} first.`;
        },

        applyDraftPeople() {
          if (!sameRoster(this.state.people, this.settingsBase)) {
            this.settingsError = SETTINGS_CONFLICT;
            return false;
          }

          const names = this.settingsDraft.map((person) => cleanPersonName(person.name));
          if (names.some((name) => !name)) {
            this.settingsError = 'Every person needs a name.';
            return false;
          }
          if (new Set(names.map(nameKey)).size !== names.length) {
            this.settingsError = 'Names must be unique.';
            return false;
          }

          // A remote transaction can reference a person the draft removes even
          // when the roster itself did not change.
          const removed = this.state.people.filter(
            (person) => !this.settingsDraft.some((entry) => entry.id === person.id)
          );
          for (const person of removed) {
            const usedBy = this.transactionUsage(person.id);
            if (usedBy) {
              this.settingsError = this.usedMessage(person, usedBy);
              return false;
            }
          }

          const changed =
            this.state.people.length !== names.length ||
            this.state.people.some(
              (person, index) =>
                person.id !== this.settingsDraft[index].id || person.name !== names[index]
            );

          if (changed) {
            this.state.people = this.settingsDraft.map((person, index) => ({
              id: person.id,
              name: names[index],
            }));

            if (this.formOpen) {
              this.state.people.forEach((person) => {
                if (!(person.id in this.form.manual)) this.form.manual[person.id] = '';
              });
            }

            this.touch();
          }

          this.settingsError = '';
          return true;
        },

        addDraftPerson() {
          if (this.settingsDraft.length >= MAX_PEOPLE) {
            this.settingsError = `Limit: ${MAX_PEOPLE} people.`;
            return;
          }

          this.settingsDraft.push({ id: newId('p'), name: '' });
          this.settingsError = '';
          this.$nextTick(() => {
            const inputs = this.$refs.peopleDialog?.querySelectorAll(
              'input[aria-label="Person name"]'
            );
            inputs?.[inputs.length - 1]?.focus();
          });
        },

        removeDraftPerson(person) {
          const usedBy = this.transactionUsage(person.id);
          if (usedBy) {
            this.settingsError = this.usedMessage(person, usedBy);
            return;
          }

          this.settingsDraft = this.settingsDraft.filter(
            (entry) => entry.id !== person.id
          );
          this.settingsError = '';
        },

        /* ---------------------------- Output -------------------------- */

        async copySettlement() {
          if (!this.transfers.length) {
            toast.error('No settlement needed.');
            return;
          }

          let summary = 'SETTLEMENT\r\n===';
          this.transfers.forEach((transfer) => {
            summary += `\r\n${transfer.from} -> ${transfer.to}: ${this.formatAmount(
              transfer.amount
            )}`;
          });

          summary += '\r\n\r\nDETAILS\r\n===';
          this.balanceRows.forEach((row) => {
            summary += `\r\n${row.name}`;
            if (row.paid > 0) {
              summary += `\r\n- Paid: ${this.formatAmount(row.paid)}`;
            }
            if (row.spent > 0) {
              summary += `\r\n- Spent: ${this.formatAmount(row.spent)}`;
            }
            summary += `\r\n- Balance: ${this.formatAmount(row.balance)}`;
          });

          const copied = await copyToClipboard(summary);
          copied ? toast.success('Summary copied.') : toast.error('Clipboard unavailable.');
        },

        /* --------------------------- Formatting ----------------------- */

        formatAmount(value) {
          return formatAmount(value, this.roundWhole);
        },

        formatMinor(cents) {
          return formatAmount(fromMinor(cents), this.roundWhole);
        },

        shareCell(transaction, personId) {
          const cents = Number(transaction.shares?.[personId] || 0);
          if (transaction.payerId !== personId && cents <= 0) return '';
          return this.formatMinor(cents);
        },

        formatDate(iso) {
          const date = new Date(iso);
          return Number.isNaN(date.getTime()) ? '' : formatTimestamp(date);
        },
      };
    });
  });
})();
