require('dotenv').config();

function isOutboundEnabled() {
    return process.env.OUTBOUND_ENABLED === 'true';
}

function outboundDisabledResult(action) {
    return {
        success: false,
        disabled: true,
        reason: `${action} is disabled because OUTBOUND_ENABLED is not set to true.`
    };
}

module.exports = { isOutboundEnabled, outboundDisabledResult };
