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
    toast,
    copyToClipboard,
  } = Shared;

  const STORAGE = 'spill.settle.v1';
  const MAX_PEOPLE = 20;
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
      return { shares: null, error: 'Add at least two people first.' };
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
        return { shares: null, error: 'Amounts must add up to the total.' };
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
    people: [
      { id: newId('p'), name: 'John' },
      { id: newId('p'), name: 'Jane' },
    ],
    transactions: [],
  });

  // Drop malformed stored data instead of letting it break the page.
  const normalizeState = (raw) => {
    if (!raw || typeof raw !== 'object') return createState();
    if (!Array.isArray(raw.people) || !Array.isArray(raw.transactions)) return createState();

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
    if (people.length < 2) return createState();

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

      let createdAt = new Date();
      if (transaction.createdAt && !Number.isNaN(Date.parse(transaction.createdAt))) {
        createdAt = new Date(transaction.createdAt);
      }

      let id = typeof transaction.id === 'string' && transaction.id ? transaction.id : newId('t');
      if (transactionIds.has(id)) id = newId('t');
      transactionIds.add(id);

      transactions.push({
        id,
        name: cleanTransactionName(transaction.name) || DEFAULT_TRANSACTION_NAME,
        payerId: transaction.payerId,
        amount,
        mode,
        shares,
        createdAt: createdAt.toISOString(),
      });
    });

    return { people, transactions };
  };

  /* ------------------------------------------------------------------ */
  /* Sync                                                               */
  /* ------------------------------------------------------------------ */

  const SYNC_HOST = 'wss://pubsub.h.kvn.pt';
  const SYNC_APP_KEY = 'spill-settle';
  const SYNC_KEY_PARAM = 'k';
  const SYNC_STORAGE = 'spill.settle.syncKey';
  const SYNC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

  const storeSyncKey = (key) => {
    if (!key) return;
    try {
      localStorage.setItem(SYNC_STORAGE, key);
    } catch {}
  };

  const storedSyncKey = () => {
    try {
      return localStorage.getItem(SYNC_STORAGE) || '';
    } catch {
      return '';
    }
  };

  const appendSyncKeyToUrl = (key) => {
    if (!key) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(SYNC_KEY_PARAM)) return;
    url.searchParams.set(SYNC_KEY_PARAM, key);
    try {
      window.history.replaceState(null, '', url);
    } catch {}
  };

  // URL key wins; otherwise reuse the persisted key and put it back in the URL.
  const readSyncKey = () => {
    let fromUrl = '';
    try {
      fromUrl = (new URLSearchParams(window.location.search).get(SYNC_KEY_PARAM) || '')
        .trim()
        .slice(0, 100);
    } catch {}

    if (fromUrl) {
      storeSyncKey(fromUrl);
      return fromUrl;
    }

    const stored = storedSyncKey().trim().slice(0, 100);
    if (stored) appendSyncKeyToUrl(stored);
    return stored;
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
      } catch {}
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

  const prepareSyncLink = (currentKey) => {
    const url = new URL(window.location.href);
    let key = url.searchParams.get(SYNC_KEY_PARAM) || currentKey;
    if (!key) key = makeSyncKey();

    url.searchParams.set(SYNC_KEY_PARAM, key);
    if (url.href !== window.location.href) {
      try {
        window.history.replaceState(null, '', url);
      } catch {}
    }

    storeSyncKey(key);
    return { key, url };
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
        })
    );
  };

  const settle = {
    STORAGE,
    MAX_PEOPLE,
    MODES,
    DEFAULT_TRANSACTION_NAME,
    newId,
    cleanPersonName,
    cleanTransactionName,
    nameKey,
    splitEvenly,
    buildShares,
    computeLedger,
    computeTransfers,
    readHandoff,
    normalizeState,
    createState,
  };
  if (typeof module === 'object' && module.exports) module.exports = settle;
  if (typeof document === 'undefined') return;

  const ROUND_STORAGE = 'spill:roundWhole';
  const TRANSACTION_WARNING_THRESHOLD = 300;

  // One PubSub client per page; kept out of Alpine's reactive state.
  let pubsub = null;

  // Drop handoff fields but keep unrelated params such as the sync key.
  const clearHandoffParams = () => {
    const url = new URL(window.location.href);
    ['from', 't', 'p', 'a'].forEach((param) => url.searchParams.delete(param));
    try {
      window.history.replaceState(null, '', url);
    } catch {}
  };

  /* ------------------------------------------------------------------ */
  /* Component                                                          */
  /* ------------------------------------------------------------------ */

  document.addEventListener('alpine:init', () => {
    Alpine.data('settle', function () {
      return {
        state: this.$persist(createState()).as(STORAGE),
        roundWhole: this.$persist(true).as(ROUND_STORAGE),
        formOpen: false,
        form: null,
        settingsDraft: [],
        settingsError: '',
        newName: '',
        syncKey: '',
        syncActive: false,

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
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        },

        get transactionWarning() {
          const count = this.state.transactions.length;
          if (count <= TRANSACTION_WARNING_THRESHOLD) return '';
          return `You have ${count} transactions. Too many transactions can impair performance and use more sync bandwidth.`;
        },

        get formPayerOptions() {
          return this.state.people;
        },

        get formAmountMinor() {
          return this.form ? toMinor(this.form.amount) : NaN;
        },

        get formManualMinor() {
          const values = {};
          this.state.people.forEach((person) => {
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
          if (!this.form) return false;
          const amount = this.formAmountMinor;
          if (!Number.isSafeInteger(amount) || amount <= 0) return false;
          if (!this.state.people.some((person) => person.id === this.form.payerId)) return false;
          if (this.form.mode === 'manual') return this.formManualValid;
          return true;
        },

        get formModeHelp() {
          if (!this.form) return '';
          if (this.form.mode === 'owed') {
            return 'This total is what the non-payers owe. The payer is not part of the split.';
          }
          if (this.form.mode === 'manual') {
            return 'Enter each person’s share. The payer’s row is their own share, not a debt.';
          }
          return 'The total is shared by everyone, including the payer.';
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
          return `${label}: ${formatAmount(fromMinor(difference), false)}`;
        },

        /* ---------------------------- Setup --------------------------- */

        init() {
          this.state = normalizeState(this.state);
          this.syncKey = readSyncKey();
          this.applyHandoff();

          this.connectSync();
          this.$watch('state', () => pubsub?.pub());
        },

        connectSync() {
          if (pubsub || !this.syncKey) return;

          try {
            pubsub = createSyncClient(this.syncKey, {
              getData: () => this.state,
              setData: (data) => {
                if (!data || typeof data !== 'object') return;
                if (!Array.isArray(data.people) || !Array.isArray(data.transactions)) return;
                this.state = normalizeState(data);
              },
            });
            this.syncActive = !!pubsub?.active;
          } catch {
            pubsub = null;
            this.syncActive = false;
          }
        },

        async copySyncLink() {
          if (typeof PubSub === 'undefined') {
            toast.error('Sync unavailable!');
            return;
          }

          const { key, url } = prepareSyncLink(this.syncKey);
          this.syncKey = key;
          this.connectSync();
          if (!this.syncActive) {
            toast.error('Sync unavailable!');
            return;
          }

          const copied = await copyToClipboard(url.toString());
          copied ? toast.success('Sync link copied!') : toast.error('Cannot access clipboard!');
        },

        applyHandoff() {
          const payload = readHandoff(window.location.search);
          if (!payload) return false;

          const byName = new Map(
            this.state.people.map((person) => [nameKey(person.name), person])
          );
          const missing = payload.people.filter(
            (person) => !byName.has(nameKey(person.name))
          );
          if (this.state.people.length + missing.length > MAX_PEOPLE) {
            clearHandoffParams();
            toast.error(`Keep it to ${MAX_PEOPLE} people.`);
            return true;
          }

          const handoff = payload.people.map(({ name, amount }) => {
            let person = byName.get(nameKey(name));
            if (!person) {
              person = { id: newId('p'), name: cleanPersonName(name) };
              this.state.people.push(person);
              byName.set(nameKey(person.name), person);
            }
            return { id: person.id, amount };
          });

          this.startForm({
            amount: String(fromMinor(payload.total)),
            mode: 'manual',
            manual: Object.fromEntries(
              handoff.map((entry) => [
                entry.id,
                entry.amount > 0 ? String(fromMinor(entry.amount)) : '',
              ])
            ),
          });

          clearHandoffParams();
          toast.success('Bill received. Pick who paid.');
          return true;
        },

        /* ----------------------------- Form --------------------------- */

        startAdd() {
          this.startForm(null);
        },

        startForm(overrides) {
          const people = this.state.people;
          const manual = Object.fromEntries(people.map((person) => [person.id, '']));
          Object.assign(manual, overrides?.manual || {});

          this.form = {
            id: null,
            name: '',
            payerId: '',
            amount: '',
            mode: 'owed',
            ...(overrides || {}),
            manual,
            error: null,
          };
          this.formOpen = true;
        },

        cancelForm() {
          this.formOpen = false;
          this.form = null;
        },

        previewFor(mode) {
          if (!this.form) return {};
          const amount = this.formAmountMinor;
          const people = this.state.people.map((person) => person.id);
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
            const hasValues = this.state.people.some(
              (person) => String(this.form.manual[person.id] || '').trim() !== ''
            );
            if (!hasValues) this.prefillManual(previous);
          }
        },

        // Carry the visible split into the manual inputs as a starting point.
        prefillManual(mode) {
          const preview = this.previewFor(mode);
          if (!Object.keys(preview).length) return;
          this.state.people.forEach((person) => {
            const cents = preview[person.id] || 0;
            this.form.manual[person.id] = cents > 0 ? String(fromMinor(cents)) : '';
          });
        },

        saveTransaction() {
          const form = this.form;
          if (!form) return;

          const amount = this.formAmountMinor;
          const result = buildShares({
            mode: form.mode,
            amount,
            payerId: form.payerId,
            people: this.state.people.map((person) => person.id),
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

          if (existing) {
            const index = this.state.transactions.indexOf(existing);
            this.state.transactions.splice(index, 1, transaction);
            toast.success('Transaction updated!');
          } else {
            this.state.transactions.push(transaction);
            toast.success('Transaction saved!');
          }

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
          if (this.form?.id === transaction.id) this.cancelForm();
          toast.success('Transaction deleted!');
        },

        closeTransfer(transfer) {
          const amount = toMinor(transfer.amount);
          if (!Number.isSafeInteger(amount) || amount <= 0) return;

          const message = `This records that ${transfer.from} is settling the balance by transferring ${this.formatAmount(
            transfer.amount
          )} to ${transfer.to}. Continue?`;
          if (!confirm(message)) return;

          this.state.transactions.push({
            id: newId('t'),
            name: 'Settlement Payment',
            payerId: transfer.fromId,
            amount,
            mode: 'manual',
            shares: { [transfer.toId]: amount },
            createdAt: new Date().toISOString(),
          });
          toast.success(`Settlement payment: ${transfer.from} -> ${transfer.to}`);
        },

        /* --------------------------- Settings ------------------------- */

        openSettings() {
          this.settingsDraft = this.state.people.map((person) => ({ ...person }));
          this.settingsError = '';
          this.newName = '';
          this.$nextTick(() => this.$refs.settingsDialog?.showModal());
        },

        closeSettings() {
          if (!this.applyDraftPeople()) return;
          this.$refs.settingsDialog?.close();
        },

        applyDraftPeople() {
          const names = this.settingsDraft.map((person) => cleanPersonName(person.name));
          if (names.some((name) => !name)) {
            this.settingsError = 'Every person needs a name.';
            return false;
          }
          if (new Set(names.map(nameKey)).size !== names.length) {
            this.settingsError = 'Names must be unique.';
            return false;
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
          }

          this.settingsError = '';
          return true;
        },

        addDraftPerson() {
          const name = cleanPersonName(this.newName);
          if (!name) {
            this.settingsError = 'Enter a name.';
            return;
          }
          if (this.settingsDraft.length >= MAX_PEOPLE) {
            this.settingsError = `Keep it to ${MAX_PEOPLE} people.`;
            return;
          }
          if (this.settingsDraft.some((person) => nameKey(person.name) === nameKey(name))) {
            this.settingsError = 'That name is already in the list.';
            return;
          }

          this.settingsDraft.push({ id: newId('p'), name });
          this.newName = '';
          this.settingsError = '';
        },

        removeDraftPerson(person) {
          if (this.settingsDraft.length <= 2) {
            this.settingsError = 'Keep at least two people.';
            return;
          }

          const usedBy = this.state.transactions.filter(
            (transaction) =>
              transaction.payerId === person.id ||
              (transaction.shares[person.id] || 0) > 0
          ).length;
          if (usedBy) {
            this.settingsError = `${person.name} is used by ${usedBy} transaction${
              usedBy === 1 ? '' : 's'
            }. Delete those first.`;
            return;
          }

          this.settingsDraft = this.settingsDraft.filter(
            (entry) => entry.id !== person.id
          );
          this.settingsError = '';
        },

        clearTransactions() {
          if (!this.state.transactions.length) {
            toast.error('No transactions to clear!');
            return;
          }
          if (!confirm('Clear all transactions?')) return;

          this.state.transactions = [];
          if (this.formOpen) this.cancelForm();
          toast.success('Transactions cleared!');
        },

        /* ---------------------------- Output -------------------------- */

        async copySettlement() {
          if (!this.transfers.length) {
            toast.error('No settlement needed!');
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
          copied ? toast.success('Settlement summary copied!') : toast.error('Cannot access clipboard!');
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
