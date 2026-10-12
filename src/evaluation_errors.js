// Only these fixed summaries may be persisted, logged, or returned to clients.
const summaries = {
    description: 'Listing description unavailable.',
    invalid: 'AI returned an invalid evaluation.',
    timeout: 'Evaluation timed out.',
    shutdown: 'Evaluation interrupted by shutdown.',
    expired: 'Evaluation interrupted; claim expired.',
    credentials: 'Gemini API credentials are missing.',
    configuration: 'Gemini authentication or model configuration failed.',
    rate_limit: 'Gemini rate limit reached; processing paused.',
    transient: 'Evaluation temporarily unavailable.'
};
class EvaluationError extends Error {
    constructor(code, retryAfterMs = 0) {
        super(summaries[code] || summaries.transient);
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}
function errorCode(error) {
    if (error instanceof EvaluationError) return error.code;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    return 'transient';
}
function publicError(value) {
    return !value ? null : Object.values(summaries).includes(value) ? value : summaries.transient;
}
module.exports = { EvaluationError, errorCode, publicError, summaries };
