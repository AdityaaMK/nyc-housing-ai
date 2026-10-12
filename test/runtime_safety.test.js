const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { isOutboundEnabled, outboundDisabledResult } = require('../src/runtime_safety');

const originalValue = process.env.OUTBOUND_ENABLED;

afterEach(() => {
    if (originalValue === undefined) delete process.env.OUTBOUND_ENABLED;
    else process.env.OUTBOUND_ENABLED = originalValue;
});

test('outbound actions are disabled by default and for non-exact values', () => {
    delete process.env.OUTBOUND_ENABLED;
    assert.equal(isOutboundEnabled(), false);

    process.env.OUTBOUND_ENABLED = 'TRUE';
    assert.equal(isOutboundEnabled(), false);

    process.env.OUTBOUND_ENABLED = 'false';
    assert.equal(isOutboundEnabled(), false);
});

test('outbound actions require explicit lowercase true', () => {
    process.env.OUTBOUND_ENABLED = 'true';
    assert.equal(isOutboundEnabled(), true);
});

test('disabled actions return a structured result', () => {
    assert.deepEqual(outboundDisabledResult('Broker email'), {
        success: false,
        disabled: true,
        reason: 'Broker email is disabled because OUTBOUND_ENABLED is not set to true.'
    });
});
