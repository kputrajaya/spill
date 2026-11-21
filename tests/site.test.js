const assert = require('node:assert/strict');
const spill = require('../site.js');

const {
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
} = spill;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sumCents = (values) =>
  Object.values(values).reduce((sum, value) => sum + Math.round(value * 100), 0);

const apply = (balances) => {
  const net = balances.map((value) => Math.round(value * 100));
  const transfers = settleBalances(balances);
  transfers.forEach((transfer) => {
    net[transfer.from] += Math.round(transfer.amount * 100);
    net[transfer.to] -= Math.round(transfer.amount * 100);
  });
  return { transfers, net };
};

const assertSettled = (balances, label) => {
  const { transfers, net } = apply(balances);
  net.forEach((cents) => assert.equal(cents, 0, `${label}: account left at ${cents} cents`));
  const debt = balances.reduce((sum, value) => sum + (value < 0 ? -Math.round(value * 100) : 0), 0);
  const paid = transfers.reduce((sum, transfer) => sum + Math.round(transfer.amount * 100), 0);
  assert.equal(paid, debt, `${label}: transferred ${paid} cents for ${debt} cents of debt`);
  return transfers;
};

const bruteMinimum = (balances) => {
  const debt = balances.map((value) => Math.round(value * 100)).filter((cents) => cents !== 0);
  const solve = (start) => {
    while (start < debt.length && debt[start] === 0) start++;
    if (start === debt.length) return 0;

    let best = Infinity;
    for (let i = start + 1; i < debt.length; i++) {
      if (debt[i] * debt[start] >= 0) continue;
      const amount = debt[start];
      debt[i] += amount;
      const candidate = 1 + solve(start + 1);
      debt[i] -= amount;
      if (candidate < best) best = candidate;
    }
    return best;
  };
  return solve(0);
};

test('parseNumber handles thousand and decimal units', () => {
  const cases = [
    ['2.000', 2000],
    ['2,000', 2000],
    ['2,000.00', 2000],
    ['2.000,00', 2000],
    ['6.000', 6000],
    ['6,000.00', 6000],
    ['6 000', 6],
    ['Rp 73.150', 73150],
    ['1.234.567,89', 1234567.89],
    ['2,5', 2.5],
  ];
  cases.forEach(([input, expected]) => assert.equal(parseNumber(input), expected, input));
});

test('parseItems uses only the first amount on each line', () => {
  const result = parseItems(
    [
      '6000',
      '6.000',
      '6,000',
      '6000 le minerale 330',
      'Le minerale 6000',
      'Le minerale 6000 (330ml)',
      '6.000,00',
      '6,000.00',
    ].join('\n')
  );
  assert.deepEqual(
    result.items.map((item) => item.price),
    [6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]
  );
  assert.equal(result.skipped, 0);
});

test('parseItems skips broken amounts and blank lines', () => {
  const broken = parseItems('6x0j00\n6*0+00');
  assert.deepEqual(broken.items, []);
  assert.equal(broken.skipped, 2);
  assert.deepEqual(broken.lineIndexes, [null, null]);

  const blank = parseItems('6000\n\n27500');
  assert.deepEqual(
    blank.items.map((item) => item.price),
    [6000, 27500]
  );
  assert.equal(blank.skipped, 1);
  assert.deepEqual(blank.lineIndexes, [0, null, 1]);
});

test('parseNames normalizes, deduplicates, and sorts initials', () => {
  assert.deepEqual(parseNames(' ani budi ANI 123 '), ['ANI', 'BUDI']);
  assert.equal(sanitizeName('a-b c'), 'ABC');
});

test('share weights cap at 2', () => {
  assert.equal(clampShare(''), 1);
  assert.equal(clampShare('1'), 1);
  assert.equal(clampShare('2'), 2);
  assert.equal(clampShare('3'), 2);
});

test('share links round-trip through encode and parse', () => {
  const shares = [{ PP: 2, MJ: 1 }, {}, { PP: 1 }];
  const text = shares.map(encodeShares).join('|');
  assert.deepEqual(parseShares(text), shares);
});

test('calculateBill shares items and applies the fee', () => {
  const { bill, error } = calculateBill({
    total: '55000',
    items: [20000, 30000],
    people: ['PP', 'MJ'],
    shares: [{}, {}],
    roundWhole: true,
  });

  assert.equal(error, null);
  assert.equal(bill.subtotal, 50000);
  assert.equal(bill.total, 55000);
  assert.equal(bill.feePercent, 10);
  assert.deepEqual(bill.totals, { PP: 27500, MJ: 27500 });
  assert.equal(bill.items[0].priceWithFee, 22000);
  assert.equal(bill.items[1].priceWithFee, 33000);
  assert.deepEqual(bill.items[0].shares, { PP: 11000, MJ: 11000 });
  assert.deepEqual(bill.items[1].shares, { PP: 16500, MJ: 16500 });
});

test('calculateBill honors weighted assignments', () => {
  const { bill, error } = calculateBill({
    total: '',
    items: [30000],
    people: ['PP', 'MJ'],
    shares: [{ PP: 2, MJ: 1 }],
    roundWhole: false,
  });

  assert.equal(error, null);
  assert.equal(bill.feePercent, 0);
  assert.deepEqual(bill.totals, { PP: 20000, MJ: 10000 });
});

test('calculateBill rounds to cents when rounding is off', () => {
  const { bill } = calculateBill({
    total: '',
    items: [10000, 10000],
    people: ['PP', 'MJ', 'AB'],
    shares: [{}, {}],
    roundWhole: false,
  });

  assert.deepEqual(bill.items[0].shares, { PP: 3333.34, MJ: 3333.33, AB: 3333.33 });
  assert.deepEqual(bill.items[1].shares, { PP: 3333.33, MJ: 3333.34, AB: 3333.33 });
  assert.deepEqual(bill.totals, { PP: 6666.67, MJ: 6666.67, AB: 6666.66 });
  assert.equal(sumCents(bill.totals), sumCents({ total: bill.total }));
});

test('calculateBill rounds to whole numbers when rounding is on', () => {
  const { bill } = calculateBill({
    total: '',
    items: [10000, 10000],
    people: ['PP', 'MJ', 'AB'],
    shares: [{}, {}],
    roundWhole: true,
  });

  assert.deepEqual(bill.items[0].shares, { PP: 3334, MJ: 3333, AB: 3333 });
  assert.deepEqual(bill.items[1].shares, { PP: 3333, MJ: 3334, AB: 3333 });
  assert.deepEqual(bill.totals, { PP: 6667, MJ: 6667, AB: 6666 });
  assert.equal(sumCents(bill.totals), sumCents({ total: bill.total }));
});

test('calculateBill rounds a fractional fee split', () => {
  const { bill } = calculateBill({
    total: '10000',
    items: [9000],
    people: ['PP', 'MJ', 'AB'],
    shares: [{}],
    roundWhole: false,
  });

  assert.equal(bill.feePercent, 11.1);
  assert.deepEqual(bill.totals, { PP: 3333.34, MJ: 3333.33, AB: 3333.33 });
  assert.equal(bill.total, 10000);
  assert.equal(sumCents(bill.totals), sumCents({ total: bill.total }));
});

test('calculateBill keeps each row total equal to its shares', () => {
  const { bill } = calculateBill({
    total: '55000',
    items: [20000, 30000],
    people: ['PP', 'MJ'],
    shares: [{ PP: 2, MJ: 1 }, { PP: 1, MJ: 2 }],
    roundWhole: true,
  });

  bill.items.forEach((item) => {
    assert.equal(sumCents(item.shares), sumCents({ total: item.priceWithFee }));
  });
  assert.equal(sumCents(bill.totals), sumCents({ total: bill.total }));
  assert.equal(
    bill.items.reduce((sum, item) => sum + Math.round(item.priceWithFee * 100), 0),
    Math.round(bill.total * 100)
  );
});

test('calculateBill uses the assignment roster when people are absent', () => {
  const { bill } = calculateBill({
    total: '',
    items: [10000],
    people: [],
    shares: [{ PP: 1, MJ: 1 }],
    roundWhole: false,
  });

  assert.deepEqual(bill.people, ['MJ', 'PP']);
  assert.deepEqual(bill.totals, { PP: 5000, MJ: 5000 });
});

test('calculateBill handles empty and invalid inputs', () => {
  assert.deepEqual(calculateBill({ total: '', items: [] }), { bill: null, error: null });
  assert.deepEqual(calculateBill({ total: '', items: [100], people: [] }), {
    bill: null,
    error: null,
  });
  assert.deepEqual(calculateBill({ total: '0', items: [100], people: ['PP'] }), {
    bill: null,
    error: 'Enter a valid total.',
  });
});

test('calculateBill validates totals like item prices', () => {
  const valid = calculateBill({
    total: 'Rp 73.150',
    items: [73150],
    people: ['PP'],
    shares: [{}],
    roundWhole: true,
  });
  assert.equal(valid.error, null);
  assert.equal(valid.bill.total, 73150);

  assert.deepEqual(
    calculateBill({ total: '6x0j00', items: [6000], people: ['PP'], shares: [{}] }),
    { bill: null, error: 'Enter a valid total.' }
  );
  assert.deepEqual(
    calculateBill({ total: 'Rp73.150', items: [73150], people: ['PP'], shares: [{}] }),
    { bill: null, error: 'Enter a valid total.' }
  );
});

test('round and format helpers honor the rounding switch', () => {
  assert.equal(toMinor('2.000'), 200000);
  assert.equal(fromMinor(200000), 2000);
  assert.equal(roundAmount(1234.567, false), 1234.57);
  assert.equal(roundAmount(1234.567, true), 1235);
  assert.equal(formatAmount(1234567.8, true), '1,234,568');
  assert.equal(formatAmount(1234567.8, false), '1,234,567.80');
});

test('four accounts use the old largest-first pairing', () => {
  const transfers = assertSettled([-10, -9, 9, 10], 'four accounts');
  assert.equal(transfers.length, 2);
  assert.deepEqual(
    transfers.map((transfer) => [transfer.from, transfer.to, transfer.amount]),
    [
      [0, 3, 10],
      [1, 2, 9],
    ]
  );
});

test('exact opposites are settled directly first', () => {
  const balances = [9, -9, 11, -11, 10, -10, 12, -8, -4];
  const transfers = assertSettled(balances, 'exact opposites');
  assert.equal(transfers.length, 5);
  assert.deepEqual(
    transfers.slice(0, 3).map((transfer) => transfer.amount),
    [9, 11, 10]
  );
});

test('exact-opposite filtering keeps large stacks exact', () => {
  const balances = Array.from({ length: 10 }, (_, index) => index + 1).flatMap((value) => [
    value,
    -value,
  ]);
  assert.equal(settleBalances(balances).length, 10);
  assert.equal(balances.length, 20);
});

test('greedy alone is not minimal; exact grouping is', () => {
  const balances = [-16, 9, -25, 29, -21, 33, -9];
  assert.equal(settleGreedy(balances).length, 6);
  const transfers = assertSettled(balances, 'greedy counterexample');
  assert.equal(transfers.length, 5);
});

test('one saved bill settles', () => {
  const transfers = assertSettled([-10000, -20000, 30000], 'one bill');
  assert.equal(transfers.length, 2);
});

test('two stacked bills settle', () => {
  const transfers = assertSettled([-5000, 5000], 'two bills');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amount, 5000);
});

test('three stacked bills settle', () => {
  const transfers = assertSettled([10000, -15000, 5000], 'three bills');
  assert.equal(transfers.length, 2);
  assert.equal(
    transfers.reduce((sum, transfer) => sum + transfer.amount, 0),
    15000
  );
});

test('decimal cents settle cleanly', () => {
  const transfers = assertSettled([-33.33, 16.66, 16.67], 'decimal cents');
  assert.equal(transfers.length, 2);
});

test('zero balances make no transfers', () => {
  assert.deepEqual(settleBalances([0, 0, 0]), []);
});

test('exact solver matches brute force on deterministic cases', () => {
  let seed = 20261121;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let run = 0; run < 120; run++) {
    const count = 2 + Math.floor(random() * 6);
    const balances = [];
    let sum = 0;
    for (let i = 0; i < count - 1; i++) {
      const cents = 100 + Math.floor(random() * 19900);
      const value = random() < 0.5 ? -cents : cents;
      balances.push(value / 100);
      sum += value;
    }
    balances.push(-sum / 100);

    const { transfers, net } = apply(balances);
    net.forEach((cents) => assert.equal(cents, 0, `random ${run}: account left at ${cents} cents`));
    assert.ok(
      transfers.length <= settleGreedy(balances).length,
      `random ${run}: exact solver used more transfers than greedy`
    );
    assert.equal(
      transfers.length,
      bruteMinimum(balances),
      `random ${run}: not the minimum (${JSON.stringify(balances)})`
    );
  }
});

test('large stacks still settle through the greedy fallback', () => {
  const balances = [];
  let sum = 0;
  for (let i = 0; i < 20; i++) {
    const value = (i % 2 === 0 ? -1 : 1) * (100 + i * 37) * 100;
    balances.push(value / 100);
    sum += value;
  }
  balances.push(-sum / 100);
  assert.ok(balances.length > EXACT_LIMIT + 1);
  assertSettled(balances, 'large stack');
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
