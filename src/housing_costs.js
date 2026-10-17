const { calculateRent } = require('./rent');

class CostValidationError extends Error {
    constructor(message) { super(message); this.status = 400; this.code = 'invalid_costs'; }
}
const fail = message => { throw new CostValidationError(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
function amount(value, name, max = 10000000) {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(`${name} must be a nonnegative number or null for unknown.`);
    return value;
}
function text(value, name, max) {
    if (typeof value !== 'string' || value.length > max) fail(`${name} must be text of at most ${max} characters.`);
    return value.trim();
}
function evidence(value, source, name) {
    if (!['confirmed', 'assumed', 'unknown'].includes(value)) fail(`${name} evidence must be confirmed, assumed, or unknown.`);
    const cleanSource = text(source ?? '', `${name} source`, 500);
    if (value === 'confirmed' && !cleanSource) fail(`${name} needs a source before it can be marked confirmed.`);
    return { evidence: value, source: cleanSource };
}
function assertKeys(value, keys, name) {
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`${name} contains unsupported fields.`);
}

// Null means unknown, never zero. A confirmed label records the owner's supplied
// evidence; this calculator cannot establish a fee's legal status.
function validateCostInput(input) {
    assertKeys(input, ['lease_months', 'rent', 'items'], 'Costs');
    const lease = amount(input.lease_months, 'Lease months', 120);
    if (lease !== null && lease < 0.1) fail('Lease months must be at least 0.1.');
    assertKeys(input.rent, ['gross_monthly', 'concessions_mentioned', 'free_months', 'rent_credit', 'upfront_rent_months', 'upfront_rent_credit', 'evidence', 'source'], 'Rent');
    const rent = {
        gross_monthly: amount(input.rent.gross_monthly, 'Gross monthly rent'),
        concessions_mentioned: input.rent.concessions_mentioned,
        free_months: amount(input.rent.free_months, 'Free months', 120),
        rent_credit: amount(input.rent.rent_credit, 'Rent credit'),
        upfront_rent_months: amount(input.rent.upfront_rent_months, 'Rent months due before moving', 120),
        upfront_rent_credit: amount(input.rent.upfront_rent_credit, 'Concession credit applied before moving'),
        ...evidence(input.rent.evidence, input.rent.source, 'Rent')
    };
    if (rent.gross_monthly === 0) fail('Gross monthly rent must be positive or unknown.');
    if (typeof rent.concessions_mentioned !== 'boolean') fail('Concessions mentioned must be true or false.');
    if (!rent.concessions_mentioned && (rent.free_months !== 0 || rent.rent_credit !== 0)) fail('Rent without concessions must have zero free months and zero rent credit.');
    if (lease !== null && rent.free_months !== null && rent.free_months >= lease) fail('Free months must be less than the lease length.');
    if (lease !== null && rent.upfront_rent_months !== null && rent.upfront_rent_months > lease) fail('Upfront rent months cannot exceed the lease length.');
    if (lease !== null && rent.gross_monthly !== null && rent.free_months !== null && rent.rent_credit !== null &&
        rent.gross_monthly * (lease - rent.free_months) <= rent.rent_credit) fail('Rent concessions cannot exceed the lease rent.');
    if (rent.gross_monthly !== null && rent.upfront_rent_months !== null && rent.upfront_rent_credit !== null &&
        rent.upfront_rent_credit > rent.gross_monthly * rent.upfront_rent_months) fail('Upfront rent credit cannot exceed upfront rent.');
    if (!rent.concessions_mentioned && rent.upfront_rent_credit !== null && rent.upfront_rent_credit !== 0) fail('Upfront concession credit must be zero when no concessions apply.');
    if (rent.gross_monthly !== null && rent.free_months !== null && rent.rent_credit !== null && rent.upfront_rent_credit !== null &&
        rent.upfront_rent_credit > rent.free_months * rent.gross_monthly + rent.rent_credit) fail('Upfront credit cannot exceed the total rent concession.');
    if (!Array.isArray(input.items) || input.items.length > 40) fail('Provide at most 40 cost line items.');
    const ids = new Set();
    const items = input.items.map(item => {
        assertKeys(item, ['id', 'label', 'category', 'amount', 'cadence', 'refundable', 'evidence', 'source', 'annual_basis', 'due_before_move_in'], 'Cost item');
        const id = text(item.id, 'Item ID', 80), label = text(item.label, 'Item label', 120);
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail('Cost item IDs must be unique letters, numbers, underscores, or hyphens.');
        ids.add(id);
        if (!label) fail('Each cost item needs a label.');
        if (!['utilities', 'amenity', 'pet', 'fee', 'deposit', 'moving', 'other'].includes(item.category)) fail('Unsupported cost category.');
        if (!['monthly', 'annual', 'one_time'].includes(item.cadence)) fail('Cost cadence must be monthly, annual, or one_time.');
        if (typeof item.refundable !== 'boolean' || typeof item.due_before_move_in !== 'boolean') fail('Refundable and due before move-in must be true or false.');
        if (item.refundable && item.cadence !== 'one_time') fail('Refundable deposits must be entered as one-time amounts.');
        if (item.category === 'deposit' && !item.refundable) fail('Use the fee category for a nonrefundable charge; deposits are refundable.');
        const basis = item.annual_basis ?? null;
        if (![null, 'prorated', 'whole_years'].includes(basis) || item.cadence !== 'annual' && basis !== null) fail('Choose prorated or whole_years only for annual charges.');
        return { id, label, category: item.category, amount: amount(item.amount, `${label} amount`), cadence: item.cadence,
            refundable: item.refundable, ...evidence(item.evidence, item.source, label), annual_basis: basis, due_before_move_in: item.due_before_move_in };
    });
    return { lease_months: lease, rent, items };
}

function seedCostInput(listing) {
    let terms = listing.rent_terms;
    try { if (typeof terms === 'string') terms = JSON.parse(terms); } catch { terms = null; }
    const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const gross = number(terms?.gross_monthly_rent) ?? number(listing.true_gross_rent);
    const concessions = typeof terms?.concessions_mentioned === 'boolean' ? terms.concessions_mentioned : true;
    return {
        lease_months: number(terms?.lease_months),
        rent: { gross_monthly: gross, concessions_mentioned: concessions,
            free_months: concessions ? number(terms?.free_months) : 0,
            rent_credit: concessions ? number(terms?.rent_credit) : 0,
            upfront_rent_months: null, upfront_rent_credit: concessions ? null : 0,
            evidence: gross === null ? 'unknown' : 'assumed',
            source: gross === null ? '' : 'AI-extracted listing terms; verify against the offered lease.' },
        items: []
    };
}

function calculateHousingCosts(rawInput) {
    const input = validateCostInput(rawInput), { rent, lease_months: lease, items } = input;
    const totals = {};
    for (const key of ['recurring_monthly', 'effective_monthly', 'lease_nonrefundable', 'upfront_cash', 'refundable_deposits']) {
        totals[key] = { amount: 0, known_amount: 0, complete: true, evidence: 'confirmed', unknowns: [] };
    }
    const add = (key, value, level, missing) => {
        const total = totals[key];
        if (value === null || level === 'unknown') { total.complete = false; total.unknowns.push(missing); }
        else { total.known_amount += value; if (level === 'assumed') total.evidence = 'includes_assumptions'; }
    };
    const gross = rent.gross_monthly;
    let effective = null, leaseRent = null;
    if (gross !== null && (!rent.concessions_mentioned || lease !== null && rent.free_months !== null && rent.rent_credit !== null)) {
        // Keep the existing rent arithmetic for ordinary whole-month leases.
        effective = Number.isInteger(lease) || lease === null
            ? calculateRent(gross, { concessions_mentioned: rent.concessions_mentioned, lease_months: lease, free_months: rent.free_months, rent_credit: rent.rent_credit }).effective_monthly_rent
            : (gross * (lease - rent.free_months) - rent.rent_credit) / lease;
        if (lease !== null) leaseRent = gross * (lease - rent.free_months) - rent.rent_credit;
    }
    const upfrontRent = gross !== null && rent.upfront_rent_months !== null && rent.upfront_rent_credit !== null
        ? gross * rent.upfront_rent_months - rent.upfront_rent_credit : null;
    add('recurring_monthly', gross, rent.evidence, 'Gross monthly rent');
    add('effective_monthly', effective, rent.evidence, 'Complete rent/concession terms');
    add('lease_nonrefundable', leaseRent, rent.evidence, 'Lease length and complete rent/concession terms');
    add('upfront_cash', upfrontRent, rent.evidence, 'Rent months and concession credit due before moving');
    const breakdown = [];
    for (const item of items) {
        let leaseCost = item.amount, monthly = 0;
        if (item.cadence === 'monthly') { monthly = item.amount; leaseCost = lease === null || item.amount === null ? null : item.amount * lease; }
        if (item.cadence === 'annual') {
            leaseCost = lease === null || item.amount === null || item.annual_basis === null ? null :
                item.amount * (item.annual_basis === 'prorated' ? lease / 12 : Math.ceil(lease / 12));
            monthly = leaseCost === null ? null : leaseCost / lease;
        }
        if (!item.refundable) {
            add('lease_nonrefundable', leaseCost, item.evidence, item.label + (item.cadence === 'annual' && item.annual_basis === null ? ' (annual billing assumption)' : ''));
            if (item.cadence !== 'one_time') {
                add('recurring_monthly', monthly, item.evidence, item.label);
                add('effective_monthly', monthly, item.evidence, item.label);
            }
        } else add('refundable_deposits', item.amount, item.evidence, item.label);
        let upfront = item.amount;
        if (item.cadence === 'annual') upfront = item.annual_basis === null || item.annual_basis === 'prorated' && lease === null ? null :
            item.amount === null ? null : item.amount * (item.annual_basis === 'prorated' ? Math.min(lease, 12) / 12 : 1);
        if (item.cadence === 'monthly' && lease !== null && lease < 1 && item.amount !== null) upfront = item.amount * lease;
        if (item.due_before_move_in) add('upfront_cash', upfront, item.evidence, item.label);
        breakdown.push({ ...item, lease_cost: item.refundable ? 0 : leaseCost === null ? null : money(leaseCost),
            monthly_budget: monthly === null ? null : money(monthly), upfront_cash: item.due_before_move_in ? upfront === null ? null : money(upfront) : 0 });
    }
    for (const total of Object.values(totals)) {
        total.known_amount = money(total.known_amount);
        total.amount = total.complete ? total.known_amount : null;
        if (!total.complete) total.evidence = 'incomplete';
    }
    return { currency: 'USD', lease_months: lease, gross_monthly_rent: gross, effective_monthly_rent: effective === null ? null : money(effective),
        lease_rent: leaseRent === null ? null : money(leaseRent), upfront_rent: upfrontRent === null ? null : money(upfrontRent),
        totals, items: breakdown,
        notes: ['Totals cover entered items only. Unlisted charges have not been verified.',
            'Upfront rent is part of lease rent, not an additional lease expense. Refundable deposits are excluded from nonrefundable lease cost.',
            'Annual charges are averaged into the monthly budget using the selected billing assumption. Upfront annual charges count the first payment, prorated for leases shorter than a year only when prorated billing is selected.',
            'Confirmed means supported by the identified source; no charge is identified here as legally required.',
            ...(lease !== null && !Number.isInteger(lease) ? ['Partial lease months use a proportional month assumption; verify daily proration in the lease.'] : [])] };
}

module.exports = { CostValidationError, validateCostInput, seedCostInput, calculateHousingCosts };
