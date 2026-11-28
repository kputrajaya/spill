const assert = require('node:assert/strict');
const settle = require('../settle/settle.js');
const { MINOR_UNIT, settleBalances } = require('../shared.js');

const {
  cleanPersonName,
  cleanTransactionName,
  splitEvenly,
  buildShares,
  computeLedger,
  computeTransfers,
  readHandoff,
  normalizeState,
  createState,
  sameRoster,
  cloneLedgerState,
  normalizeLedgerIndex,
  shortLedgerId,
  compareStates,
  bumpRev,
  loadIndex,
  loadLedger,
} = settle;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sum = (values) => Object.values(values).reduce((total, value) => total + value, 0);

test('clean names collapse spaces and cap length', () => {
  assert.equal(cleanPersonName('  Aunt   May  '), 'Aunt May');
  assert.equal(cleanPersonName('x'.repeat(40)).length, 24);
  assert.equal(cleanTransactionName(' Dinner   Oct 16 '), 'Dinner Oct 16');
});

test('splitEvenly uses largest-remainder cents', () => {
  assert.deepEqual(splitEvenly(100, ['a', 'b', 'c']), { a: 34, b: 33, c: 33 });
  assert.equal(sum(splitEvenly(10000, ['a', 'b', 'c'])), 10000);
  assert.deepEqual(splitEvenly(0, ['a', 'b']), { a: 0, b: 0 });
  assert.equal(splitEvenly(100, []), null);
});

test('equal mode includes the payer', () => {
  const people = ['you', 'a', 'b'];
  const { shares, error } = buildShares({
    mode: 'equal',
    amount: 10000,
    payerId: 'you',
    people,
  });

  assert.equal(error, null);
  assert.equal(sum(shares), 10000);
  assert.deepEqual(Object.keys(shares), people);
  assert.equal(shares.you, 3334);
});

test('owed mode excludes the payer and keeps the total exact', () => {
  const people = ['you', 'a', 'b'];
  const { shares, error } = buildShares({
    mode: 'owed',
    amount: 10000,
    payerId: 'you',
    people,
  });

  assert.equal(error, null);
  assert.equal(shares.you, undefined);
  assert.equal(shares.a + shares.b, 10000);
  assert.deepEqual(Object.keys(shares), ['a', 'b']);
});

test('manual mode must add up to the amount', () => {
  const people = ['you', 'a', 'b'];
  const valid = buildShares({
    mode: 'manual',
    amount: 10000,
    payerId: 'you',
    people,
    manual: { you: 2000, a: 3000, b: 5000 },
  });
  assert.equal(valid.error, null);
  assert.deepEqual(valid.shares, { you: 2000, a: 3000, b: 5000 });

  const short = buildShares({
    mode: 'manual',
    amount: 10000,
    payerId: 'you',
    people,
    manual: { you: 2000, a: 3000, b: 4000 },
  });
  assert.equal(short.error, 'Shares must add up to the total.');

  const invalid = buildShares({
    mode: 'manual',
    amount: 10000,
    payerId: 'you',
    people,
    manual: { you: 2000, a: NaN, b: 8000 },
  });
  assert.equal(invalid.error, 'Enter valid amounts.');

  const missing = buildShares({
    mode: 'manual',
    amount: 10000,
    payerId: 'you',
    people,
    manual: { you: 10000 },
  });
  assert.equal(missing.error, null);
  assert.deepEqual(missing.shares, { you: 10000 });
});

test('invalid amounts and payers are rejected', () => {
  assert.equal(
    buildShares({ mode: 'equal', amount: 0, payerId: 'you', people: ['you', 'a'] }).error,
    'Enter a valid amount.'
  );
  assert.equal(
    buildShares({ mode: 'equal', amount: 100, payerId: 'x', people: ['you', 'a'] }).error,
    'Select who paid.'
  );
  assert.equal(
    buildShares({ mode: 'equal', amount: 100, payerId: 'you', people: ['you'] }).error,
    'Add at least two people.'
  );
});

test('ledger uses paid and spent including the payer own share', () => {
  const people = [{ id: 'you' }, { id: 'a' }, { id: 'b' }];
  const transactions = [
    {
      payerId: 'you',
      amount: 10000,
      shares: { you: 3334, a: 3333, b: 3333 },
    },
  ];

  const ledger = computeLedger(people, transactions);
  assert.equal(ledger.paid.you, 10000);
  assert.equal(ledger.paid.a, 0);
  assert.equal(ledger.spent.you, 3334);
  assert.equal(ledger.spent.a, 3333);
  assert.equal(ledger.spent.b, 3333);
  assert.equal(ledger.balances.you, 6666);
  assert.equal(ledger.balances.a, -3333);
  assert.equal(ledger.balances.b, -3333);
  assert.equal(sum(ledger.balances), 0);
});

test('multiple transactions net to zero and settle', () => {
  const people = [{ id: 'you' }, { id: 'a' }, { id: 'b' }];
  const transactions = [
    {
      payerId: 'you',
      amount: 10000,
      shares: { you: 3334, a: 3333, b: 3333 },
    },
    {
      payerId: 'a',
      amount: 5000,
      shares: { you: 2500, a: 0, b: 2500 },
    },
  ];

  const ledger = computeLedger(people, transactions);
  assert.deepEqual(ledger.paid, { you: 10000, a: 5000, b: 0 });
  assert.deepEqual(ledger.spent, { you: 5834, a: 3333, b: 5833 });
  assert.deepEqual(ledger.balances, { you: 4166, a: 1667, b: -5833 });
  assert.equal(sum(ledger.balances), 0);

  const transfers = computeTransfers(people, transactions);
  assert.ok(transfers.length >= 1);

  const net = { you: 0, a: 0, b: 0 };
  transfers.forEach((transfer) => {
    net[transfer.fromId] -= Math.round(transfer.amount * MINOR_UNIT);
    net[transfer.toId] += Math.round(transfer.amount * MINOR_UNIT);
  });
  assert.deepEqual(net, { you: 4166, a: 1667, b: -5833 });
  assert.deepEqual(
    settleBalances([41.66, 16.67, -58.33]).map((transfer) => transfer.amount),
    transfers.map((transfer) => transfer.amount)
  );
});

test('unknown people and empty ledgers are harmless', () => {
  const ledger = computeLedger(
    [{ id: 'you' }, { id: 'a' }],
    [{ payerId: 'ghost', amount: 100, shares: { a: 100 } }]
  );
  assert.deepEqual(ledger.balances, { you: 0, a: 0 });
  assert.deepEqual(computeTransfers([{ id: 'you' }, { id: 'a' }], []), []);
});

test('normalizeState keeps transactions beyond the warning threshold', () => {
  const people = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  const transactions = Array.from({ length: 305 }, (_, index) => ({
    id: `t${index}`,
    name: 'Bill',
    payerId: index % 2 ? 'a' : 'b',
    amount: 100,
    mode: 'manual',
    shares: { [index % 2 ? 'b' : 'a']: 100 },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));

  const state = normalizeState({ people, transactions });
  assert.equal(state.transactions.length, 305);
});

test('handoff params round-trip and are validated', () => {
  const search = '?from=split&t=10000&p=ANN|JOE&a=4000|6000';
  assert.deepEqual(readHandoff(search), {
    total: 10000,
    people: [
      { name: 'ANN', amount: 4000 },
      { name: 'JOE', amount: 6000 },
    ],
  });

  assert.equal(readHandoff('?from=split&t=10000&p=ANN|JOE&a=4000|5000'), null);
  assert.equal(readHandoff('?from=split&t=10000&p=ANN|ANN&a=5000|5000'), null);
  assert.equal(readHandoff('?from=split&t=10000&p=ANN|&a=4000|6000'), null);
  assert.equal(readHandoff('?from=split&t=10000&p=ANN&a=10000'), null);
  assert.equal(readHandoff('?from=split&t=0&p=ANN&a=0'), null);
  assert.equal(readHandoff('?from=other&t=10000&p=ANN&a=10000'), null);
  assert.equal(readHandoff(''), null);
});

test('normalizeState drops malformed transactions but keeps valid ones', () => {
  const raw = {
    people: [
      { id: 'you', name: 'You' },
      { id: 'a', name: 'A' },
      { id: 'a', name: 'Duplicate id' },
      { id: 'b', name: 'a' },
    ],
    transactions: [
      {
        id: 't1',
        name: 'Dinner',
        payerId: 'you',
        amount: 1000,
        mode: 'equal',
        shares: { you: 500, a: 500 },
        createdAt: '2026-11-27T10:00:00.000Z',
      },
      {
        id: 't2',
        payerId: 'you',
        amount: 1000,
        mode: 'equal',
        shares: { you: 500, a: 400 },
      },
      {
        id: 't3',
        payerId: 'ghost',
        amount: 1000,
        mode: 'equal',
        shares: { a: 1000 },
      },
      {
        id: 't4',
        name: '',
        payerId: 'you',
        amount: 1000,
        mode: 'owed',
        shares: { you: 0, a: 1000 },
      },
    ],
  };

  const state = normalizeState(raw);
  assert.deepEqual(state.people, [
    { id: 'you', name: 'You' },
    { id: 'a', name: 'A' },
  ]);
  assert.equal(state.transactions.length, 2);
  assert.deepEqual(
    state.transactions.map((transaction) => transaction.id),
    ['t1', 't4']
  );
  assert.ok(state.transactions[1].name);
  assert.equal(state.transactions[1].name, 'Bill');
});

test('createState starts empty', () => {
  const state = createState();
  assert.equal(state.rev, 0);
  assert.equal(state.ledgerKey, '');
  assert.deepEqual(state.people, []);
  assert.deepEqual(state.transactions, []);
});

test('normalizeState allows empty and one-person rosters', () => {
  const empty = normalizeState({ people: [], transactions: [] });
  assert.equal(empty.people.length, 0);
  assert.deepEqual(empty.transactions, []);
  assert.deepEqual(normalizeState(null).people, []);

  const one = normalizeState({
    people: [{ id: 'p1', name: 'Ann' }],
    transactions: [],
  });
  assert.equal(one.people.length, 1);
  assert.equal(one.people[0].name, 'Ann');
});

test('normalizeState preserves a valid ledger revision', () => {
  const people = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.equal(normalizeState({ rev: 7, people, transactions: [] }).rev, 7);
  assert.equal(normalizeState({ people, transactions: [] }).rev, 0);
  assert.equal(normalizeState({ rev: -1, people, transactions: [] }).rev, 0);
  assert.equal(normalizeState({ rev: 1.5, people, transactions: [] }).rev, 0);

  const legacy = normalizeState({
    people,
    transactions: [
      {
        id: 't1',
        payerId: 'a',
        amount: 100,
        mode: 'manual',
        shares: { b: 100 },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  assert.equal(legacy.rev, 1);
});

test('normalizeState preserves the ledger key', () => {
  const people = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.equal(
    normalizeState({ ledgerKey: 'chan-1', people, transactions: [] }).ledgerKey,
    'chan-1'
  );
  assert.equal(normalizeState({ people, transactions: [] }).ledgerKey, '');
  assert.equal(
    normalizeState({ ledgerKey: 42, people, transactions: [] }).ledgerKey,
    ''
  );
});

test('normalizeState is deterministic for duplicate ids and bad dates', () => {
  const people = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  const state = normalizeState({
    people,
    transactions: [
      {
        id: 't1',
        payerId: 'a',
        amount: 100,
        mode: 'manual',
        shares: { b: 100 },
        createdAt: 'not-a-date',
      },
      {
        id: 't1',
        payerId: 'b',
        amount: 100,
        mode: 'manual',
        shares: { a: 100 },
        createdAt: 'not-a-date',
      },
    ],
  });

  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].payerId, 'a');
  assert.equal(state.transactions[0].createdAt, new Date(0).toISOString());
});

test('normalizeState derives a stable id for id-less records', () => {
  const raw = {
    people: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    transactions: [
      {
        payerId: 'a',
        amount: 100,
        mode: 'manual',
        shares: { b: 100 },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };

  const first = normalizeState(raw);
  const second = normalizeState(JSON.parse(JSON.stringify(raw)));
  assert.ok(first.transactions[0].id);
  assert.equal(first.transactions[0].id, second.transactions[0].id);
});

test('compareStates orders by revision only', () => {
  const people = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  const base = { rev: 1, people, transactions: [] };

  assert.equal(compareStates({ ...base, rev: 2 }, base), 1);
  assert.equal(compareStates(base, { ...base, rev: 2 }), -1);
  assert.equal(compareStates(base, { ...base, people: [people[1], people[0]] }), 0);
  assert.equal(
    compareStates({ ...base, ledgerKey: 'a' }, { ...base, ledgerKey: 'b' }),
    0
  );

  const emptyDefault = { rev: 0, people, transactions: [] };
  assert.equal(compareStates(emptyDefault, base), -1);
});

test('sameRoster compares ids and names without order', () => {
  const roster = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  assert.equal(
    sameRoster(roster, [
      { id: 'b', name: 'B' },
      { id: 'a', name: 'A' },
    ]),
    true
  );
  assert.equal(
    sameRoster(roster, [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'Bee' },
    ]),
    false
  );
  assert.equal(sameRoster(roster, [{ id: 'a', name: 'A' }]), false);
  assert.equal(
    sameRoster(roster, [...roster, { id: 'c', name: 'C' }]),
    false
  );
});

test('normalizeLedgerIndex dedupes, caps, and picks an active ledger', () => {
  const ledgers = Array.from({ length: 12 }, (_, index) => ({
    key: `key${index}`,
    updatedAt: index,
  }));
  const index = normalizeLedgerIndex({ active: 'missing', ledgers });

  assert.equal(index.ledgers.length, 10);
  assert.equal(index.ledgers[0].key, 'key2');
  assert.equal(index.active, 'key2');

  const ordered = normalizeLedgerIndex({
    active: 'a',
    ledgers: [
      { key: 'a', updatedAt: 1 },
      { key: 'b', updatedAt: 99 },
      { key: 'c', updatedAt: 50 },
    ],
  });
  assert.deepEqual(
    ordered.ledgers.map((ledger) => ledger.key),
    ['a', 'b', 'c']
  );

  const chosen = normalizeLedgerIndex({
    active: 'key2',
    ledgers: [
      { key: 'key0', updatedAt: 0 },
      { key: 'key0', updatedAt: 99 },
      { key: 'key2', updatedAt: 1 },
    ],
  });
  assert.equal(chosen.ledgers.length, 2);
  assert.equal(chosen.active, 'key2');

  assert.deepEqual(normalizeLedgerIndex(null), { active: '', ledgers: [] });
  assert.deepEqual(normalizeLedgerIndex('bad'), { active: '', ledgers: [] });
});

test('shortLedgerId uses six chars and extends on collision', () => {
  assert.equal(shortLedgerId('abcdef1', ['abcdef1']), 'abcdef');
  assert.equal(shortLedgerId('abcdef1', ['abcdef1', 'abcdef2']), 'abcdef1');
  assert.equal(shortLedgerId('abc', ['abc']), 'abc');
});

const withStorage = (fn) => {
  const store = new Map();
  const original = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      key: (index) => [...store.keys()][index] ?? null,
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  });
  try {
    return fn(store);
  } finally {
    if (original) Object.defineProperty(global, 'localStorage', original);
    else delete global.localStorage;
  }
};

test('loadIndex migrates the legacy single ledger', () => {
  withStorage((store) => {
    const people = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    store.set(
      'spill:settle',
      JSON.stringify({ rev: 2, ledgerKey: 'keyA', people, transactions: [] })
    );
    store.set('spill:settle:syncKey', 'keyA');

    const { index } = loadIndex();
    assert.equal(index.active, 'keyA');
    assert.ok(store.has('spill:settle:ledger:keyA'));
    assert.equal(store.has('spill:settle'), false);
    assert.ok(store.has('spill:settle:legacy'));

    const loaded = loadLedger('keyA');
    assert.equal(loaded.state.rev, 2);
    assert.equal(loaded.state.ledgerKey, 'keyA');
    assert.equal(loaded.fresh, false);
  });
});

test('loadIndex rebuilds a corrupt index from buckets', () => {
  withStorage((store) => {
    const people = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    store.set('spill:settle:index', '{oops');
    store.set(
      'spill:settle:ledger:keyB',
      JSON.stringify({ rev: 1, ledgerKey: 'keyB', people, transactions: [] })
    );

    const { index } = loadIndex();
    assert.equal(index.active, 'keyB');
    assert.ok(store.has('spill:settle:index:corrupt'));
    assert.ok(store.has('spill:settle:index'));

    const loaded = loadLedger('keyB');
    assert.equal(loaded.state.rev, 1);
  });
});

test('cloneLedgerState copies data and changes the key', () => {
  const source = {
    rev: 4,
    ledgerKey: 'source',
    people: [{ id: 'p', name: 'A' }],
    transactions: [{ id: 't', payerId: 'p', amount: 100, shares: { p: 100 } }],
  };
  const copy = cloneLedgerState(source, 'branch');

  assert.equal(copy.ledgerKey, 'branch');
  assert.equal(copy.rev, 4);
  assert.deepEqual(copy.people, source.people);
  assert.deepEqual(copy.transactions, source.transactions);
  assert.notEqual(copy.people, source.people);
  assert.notEqual(copy.transactions, source.transactions);

  copy.people[0].name = 'B';
  assert.equal(source.people[0].name, 'A');
});

test('bumpRev keeps a monotonic integer', () => {
  assert.equal(bumpRev({ rev: 5 }), 6);
  assert.equal(bumpRev({}), 1);
});

const failures = [];
tests.forEach(({ name, fn }) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n${error.message}`);
  }
});

if (failures.length) {
  console.error(`\n${failures.length} of ${tests.length} tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} tests passed`);
}
