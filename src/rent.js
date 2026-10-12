const { EvaluationError } = require('./evaluation_errors');

// The model extracts terms; arithmetic and the budget decision stay in code.
function calculateRent(gross, terms) {
    const number = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
    if (!number(gross, 1, 2147483647) || !terms || typeof terms !== 'object' || Array.isArray(terms) ||
        typeof terms.concessions_mentioned !== 'boolean' ||
        !(terms.lease_months === null || Number.isInteger(terms.lease_months) && number(terms.lease_months, 1, 120)) ||
        !(terms.free_months === null || number(terms.free_months, 0, 120)) ||
        !(terms.rent_credit === null || number(terms.rent_credit, 0, 2147483647)) ||
        (!terms.concessions_mentioned && (terms.free_months !== 0 || terms.rent_credit !== 0))) {
        throw new EvaluationError('invalid');
    }
    const { concessions_mentioned, lease_months, free_months, rent_credit } = terms;
    if (lease_months !== null && free_months !== null && free_months >= lease_months) throw new EvaluationError('invalid');
    let effective = gross;
    if (concessions_mentioned) {
        // Never invent a lease length or discount to justify an advertised net price.
        effective = [lease_months, free_months, rent_credit].includes(null) ? null :
            (gross * (lease_months - free_months) - rent_credit) / lease_months;
    }
    if (effective !== null && effective <= 0) throw new EvaluationError('invalid');
    return {
        effective_monthly_rent: effective === null ? null : Math.round((effective + Number.EPSILON) * 100) / 100,
        rent_terms: { gross_monthly_rent: gross, concessions_mentioned, lease_months, free_months, rent_credit }
    };
}
module.exports = { calculateRent };
