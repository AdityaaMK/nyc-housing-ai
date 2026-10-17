const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateHousingCosts, seedCostInput, validateCostInput } = require('../src/housing_costs');

const rent = overrides => ({ gross_monthly: 3000, concessions_mentioned: false, free_months: 0, rent_credit: 0,
    upfront_rent_months: 1, upfront_rent_credit: 0, evidence: 'confirmed', source: 'Draft lease section 4', ...overrides });
const input = overrides => ({ lease_months: 12, rent: rent(), items: [], ...overrides });
const item = overrides => ({ id: 'cost', label: 'Cost', category: 'other', amount: 100, cadence: 'monthly', refundable: false,
    evidence: 'assumed', source: 'My estimate', annual_basis: null, due_before_move_in: false, ...overrides });

test('deposits affect cash before moving but never nonrefundable lease costs or double-count first rent', () => {
    const result = calculateHousingCosts(input({ items: [
        item({ id: 'deposit', label: 'Deposit', category: 'deposit', amount: 3000, cadence: 'one_time', refundable: true, due_before_move_in: true }),
        item({ id: 'moving', label: 'Moving', category: 'moving', amount: 500, cadence: 'one_time', due_before_move_in: true }),
        item({ id: 'utilities', label: 'Utilities', category: 'utilities', amount: 100 })
    ] }));
    assert.equal(result.totals.recurring_monthly.amount, 3100);
    assert.equal(result.totals.lease_nonrefundable.amount, 37700);
    assert.equal(result.totals.upfront_cash.amount, 6500);
    assert.equal(result.totals.refundable_deposits.amount, 3000);
    assert.equal(result.totals.lease_nonrefundable.evidence, 'includes_assumptions');
});

test('free rent and credit reduce lease rent once; known upfront timing is separate', () => {
    const result = calculateHousingCosts(input({ rent: rent({ concessions_mentioned: true, free_months: 1, rent_credit: 600, upfront_rent_credit: 3000 }) }));
    assert.equal(result.effective_monthly_rent, 2700);
    assert.equal(result.lease_rent, 32400);
    assert.equal(result.totals.lease_nonrefundable.amount, 32400);
    assert.equal(result.totals.upfront_cash.amount, 0);
    assert.equal(result.totals.recurring_monthly.amount, 3000);
    assert.equal(result.totals.effective_monthly.amount, 2700);
    assert.throws(() => calculateHousingCosts(input({ rent: rent({ upfront_rent_credit: 1 }) })), /zero/);
});

test('unknown items and upfront concession timing produce incomplete totals with known components', () => {
    const result = calculateHousingCosts(input({ rent: rent({ concessions_mentioned: true, free_months: null, rent_credit: null, upfront_rent_credit: null }),
        items: [item({ label: 'Pet charge', amount: null, evidence: 'unknown' })] }));
    assert.equal(result.totals.recurring_monthly.amount, null);
    assert.equal(result.totals.recurring_monthly.known_amount, 3000);
    assert.deepEqual(result.totals.recurring_monthly.unknowns, ['Pet charge']);
    assert.equal(result.totals.lease_nonrefundable.amount, null);
    assert.equal(result.totals.upfront_cash.amount, null);
    assert.equal(result.effective_monthly_rent, null);
});

test('annual charges require explicit proration; partial lease periods stay visible', () => {
    const yearly = item({ label: 'Annual amenity', cadence: 'annual', amount: 1200, due_before_move_in: true });
    let result = calculateHousingCosts(input({ lease_months: 6.5, items: [yearly] }));
    assert.equal(result.totals.lease_nonrefundable.amount, null);
    assert.equal(result.totals.upfront_cash.amount, null);
    assert.match(result.notes.join(' '), /Partial lease/);
    result = calculateHousingCosts(input({ lease_months: 6.5, items: [{ ...yearly, annual_basis: 'prorated' }] }));
    assert.equal(result.totals.lease_nonrefundable.amount, 20150);
    assert.equal(result.totals.upfront_cash.amount, 3650);
    assert.equal(result.totals.recurring_monthly.amount, 3100);
    result = calculateHousingCosts(input({ lease_months: 13, items: [{ ...yearly, annual_basis: 'whole_years' }] }));
    assert.equal(result.totals.lease_nonrefundable.amount, 41400);
    assert.equal(result.totals.upfront_cash.amount, 4200);
    assert.equal(result.items[0].monthly_budget, 184.62);
});

test('lease rent retains cent accuracy instead of multiplying a rounded effective monthly rent', () => {
    const result = calculateHousingCosts(input({ lease_months: 13, rent: rent({ concessions_mentioned: true, free_months: 1, rent_credit: 100 }) }));
    assert.equal(result.effective_monthly_rent, 2761.54);
    assert.equal(result.lease_rent, 35900);
});

test('fees cannot be presented as confirmed without a source or deposits as nonrefundable', () => {
    assert.throws(() => validateCostInput(input({ items: [item({ evidence: 'confirmed', source: '' })] })), /source/);
    assert.throws(() => validateCostInput(input({ items: [item({ category: 'deposit', cadence: 'one_time', refundable: false })] })), /nonrefundable/);
    assert.throws(() => validateCostInput(input({ items: [item({ refundable: true })] })), /one-time/);
    assert.throws(() => validateCostInput(input({ items: [item(), item()] })), /unique/);
    assert.throws(() => validateCostInput(input({ items: [item({ amount: '100' })] })), /nonnegative/);
    assert.throws(() => validateCostInput(input({ rent: rent({ gross_monthly: 0 }) })), /positive/);
});

test('seed never infers gross from advertised net price or a standard lease/deposit', () => {
    const unknown = seedCostInput({ price: 2500 });
    assert.equal(unknown.lease_months, null);
    assert.equal(unknown.rent.gross_monthly, null);
    assert.equal(unknown.rent.upfront_rent_months, null);
    assert.deepEqual(unknown.items, []);
    assert.equal(calculateHousingCosts(unknown).totals.lease_nonrefundable.amount, null);
    const extracted = seedCostInput({ price: 2500, true_gross_rent: 3000, rent_terms: JSON.stringify({ lease_months: 12, concessions_mentioned: false, free_months: 0, rent_credit: 0 }) });
    assert.equal(extracted.rent.evidence, 'assumed');
    assert.equal(calculateHousingCosts(extracted).totals.lease_nonrefundable.amount, 36000);
    assert.equal(calculateHousingCosts(extracted).totals.upfront_cash.amount, null);
});

test('null lease length preserves known monthly outlay without inventing total lease cost', () => {
    const result = calculateHousingCosts(input({ lease_months: null, items: [item()] }));
    assert.equal(result.totals.recurring_monthly.amount, 3100);
    assert.equal(result.totals.effective_monthly.amount, 3100);
    assert.equal(result.totals.lease_nonrefundable.amount, null);
    assert.equal(result.totals.upfront_cash.amount, 3000);
});
