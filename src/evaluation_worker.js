const { setTimeout: delay } = require('node:timers/promises');
const { pool } = require('./db');
const { createRepository } = require('./repository');
const { createFeatureStore } = require('./feature_store');
const { createPreferencesService } = require('./preferences_service');
const { createQueue } = require('./evaluation_queue');
const { EvaluationError, errorCode, summaries } = require('./evaluation_errors');
const { runAIEvaluation, applyScoringRules, assertCredentials } = require('./evaluator');

async function withDeadline(work, ms, parentSignal) {
    parentSignal?.throwIfAborted();
    const controller = new AbortController();
    const forward = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(new EvaluationError('timeout')), ms);
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]); }
    finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', forward);
        controller.signal.removeEventListener('abort', onAbort);
    }
}
async function closeBrowser(browser) {
    if (!browser) return;
    let timer;
    try {
        await Promise.race([browser.close(), new Promise(resolve => {
            timer = setTimeout(() => { browser.process?.()?.kill('SIGKILL'); resolve(); }, 2000);
        })]);
    } catch { browser.process?.()?.kill('SIGKILL'); }
    finally { clearTimeout(timer); }
}
async function fetchDescription(listing, { signal, launch } = {}) {
    if (!launch) {
        const puppeteer = require('puppeteer-extra');
        puppeteer.use(require('puppeteer-extra-plugin-stealth')());
        launch = options => puppeteer.launch(options);
    }
    let browser, closing;
    const close = () => closing ||= closeBrowser(browser);
    const abort = () => { if (browser) void close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();
        browser = await launch({ headless: true, timeout: 30000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        signal?.throwIfAborted();
        const page = await browser.newPage();
        const response = await page.goto(listing.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (response && response.status() >= 400) throw new EvaluationError('description');
        const description = await page.$$eval(".Description-block, .building-description, [data-test='description-text'], .font-size-9, #listing-description", els => els.map(e => e.innerText).join('\n')) ||
            await page.$$eval('p', els => els.map(e => e.innerText).join('\n'));
        if (!listing.price) {
            const pagePrice = await page.evaluate(() => document.querySelector('[data-test="price"], .price, .PriceInfo, [class*="price"], .details_info_price')?.innerText);
            const match = typeof pagePrice === 'string' && pagePrice.match(/\$([0-9,]+)/);
            if (match) listing.price = Number(match[1].replace(/,/g, ''));
        }
        signal?.throwIfAborted();
        if (!description || description.trim().length < 40 || /verify (you are|you're) human|access denied|captcha|unusual traffic/i.test(description)) {
            throw new EvaluationError('description');
        }
        if (listing.price != null && (!Number.isFinite(Number(listing.price)) || Number(listing.price) <= 0 || Number(listing.price) > 2147483647)) throw new EvaluationError('invalid');
        return description.slice(0, 30000);
    } finally {
        signal?.removeEventListener('abort', abort);
        await close();
    }
}
// Metadata and the queue live in separate rows. Publish/clear with revisions,
// then re-read so an observation racing completion cannot leave a stale score
// marked complete. The observer publishes its marker before its requeue call.
async function reconcileListingAssessment({ store, repository, id, initialInsight }) {
    const evaluatedSnapshot = initialInsight?.data.snapshot_id || null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await store.get('listing_insights', id);
        if (!current) return false;
        if ((current.data.snapshot_id || null) !== evaluatedSnapshot) {
            if (current.data.assessment_outdated) await repository.requeueEvaluation(id);
            return current.data.assessment_outdated === true;
        }
        if (current.data.assessment_outdated) {
            try {
                await store.put('listing_insights', id, { ...current.data, assessment_outdated: false }, { expectedRevision: current.revision });
            } catch (error) { if (error.status === 409) continue; throw error; }
        }
        const after = await store.get('listing_insights', id);
        if (after?.data.assessment_outdated) {
            await repository.requeueEvaluation(id);
            return true;
        }
        return false;
    }
    // Persistent contention is bounded; retain the evidence and let the existing
    // rate-limited scorer claim a fresh attempt rather than spinning here.
    await repository.requeueEvaluation(id);
    return true;
}
async function runWorker({ limit = 10, continuous = false, noRetries = false, signal,
    db = pool, now = Date.now, sleep = (ms, s) => delay(ms, undefined, { signal: s }),
    describe = fetchDescription, evaluate = runAIEvaluation, healthCheck,
    attemptTimeoutMs = 120000, aiTimeoutMs = 60000, onResult = () => {}, onHeartbeat = () => {}, log = console.log,
    store = createFeatureStore(db), repository = createRepository(db), preferenceService = createPreferencesService({ store, repository, now }) } = {}) {
    assertCredentials(); // Must happen before DB initialization or any claim.
    if (!continuous && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit must be a positive integer');
    const queue = createQueue(db, now);
    const seen = new Set(), report = { claimed: 0, aiCalls: 0, completed: 0, results: [], stopped: null };
    while (!signal?.aborted && (continuous || report.claimed < limit)) {
        await onHeartbeat({ status: 'running', claimed: report.claimed, completed: report.completed });
        const preferences = await preferenceService.get();
        await preferenceService.queueOutdated({ limit: 3, preferences });
        const pause = await queue.pauseUntil();
        if (pause > now()) {
            if (!continuous) { report.stopped = 'rate_limit'; break; }
            try { await sleep(Math.min(pause - now(), 30000), signal); } catch { break; }
            continue;
        }
        const listing = await queue.claim({ exclude: continuous ? [] : [...seen], noRetries });
        if (!listing) {
            await onHeartbeat({ status: 'running', lastSuccessAt: now(), error: null, claimed: report.claimed, completed: report.completed });
            if (!continuous) break;
            try { await sleep(30000, signal); } catch { break; }
            continue;
        }
        seen.add(listing.id); report.claimed++;
        const record = { id: listing.id, attempt: listing.evaluation_attempts, descriptionLength: 0, aiCalls: 0 };
        try {
            const initialInsight = await store.get('listing_insights', listing.id);
            // The claim can precede a concurrent observation. Read current asking
            // rent after the marker so that clearing that marker corresponds to
            // the listing inputs actually used; keep the original lease token.
            const currentListing = (await repository.getListing(listing.id)).rows[0];
            if (currentListing) listing.price = currentListing.price;
            const result = await withDeadline(async attemptSignal => {
                const description = await describe(listing, { signal: attemptSignal });
                record.descriptionLength = description.length;
                if (!description.trim()) throw new EvaluationError('description');
                while (!await queue.reserveRequest()) {
                    attemptSignal.throwIfAborted();
                    const until = await queue.pauseUntil();
                    if (until > now()) throw new EvaluationError('rate_limit', until - now());
                    await sleep(1000, attemptSignal);
                }
                attemptSignal.throwIfAborted();
                // Every attempt has exactly one possible provider call.
                if (!continuous && report.aiCalls >= limit) throw new EvaluationError('shutdown');
                report.aiCalls++; record.aiCalls++;
                const value = await withDeadline(aiSignal => evaluate(listing, description, { signal: aiSignal, preferences }), aiTimeoutMs, attemptSignal);
                attemptSignal.throwIfAborted();
                return applyScoringRules(listing, value, { signal: attemptSignal, healthCheck, preferences });
            }, attemptTimeoutMs, signal);
            signal?.throwIfAborted();
            const saved = await queue.complete(listing, result.evaluation, result.health);
            record.status = saved ? 'completed' : 'stale';
            if (saved) {
                report.completed++; record.score = Math.round(result.evaluation.suitability_score);
                record.preferencesRevision = preferences.revision;
                await onHeartbeat({ status: 'running', lastSuccessAt: now(), error: null, claimed: report.claimed, completed: report.completed });
                await preferenceService.recordEvaluation(listing.id, preferences.revision);
                const outdated = await reconcileListingAssessment({ store, repository, id: listing.id, initialInsight });
                if (outdated) record.assessmentOutdated = true;
            }
        } catch (error) {
            // A successful score with a failed metadata receipt must not be reported
            // as a retriable AI attempt; stop so the supervisor can surface the fault.
            if (record.status === 'completed') throw error;
            const code = signal?.aborted ? 'shutdown' : errorCode(error);
            record.error = summaries[code];
            if (code === 'rate_limit') {
                const until = await queue.pause(error.retryAfterMs);
                await queue.release(listing, code, until);
                record.status = 'retry_wait';
                if (!continuous) report.stopped = code;
            } else if (['credentials', 'configuration', 'shutdown'].includes(code)) {
                await queue.release(listing, code);
                record.status = 'pending'; report.stopped = code;
            } else {
                await queue.fail(listing, code);
                record.status = listing.evaluation_attempts >= 3 ? 'failed' : 'retry_wait';
            }
        }
        report.results.push(record);
        log(JSON.stringify(record));
        await onResult(record);
        if (report.stopped) break;
    }
    if (signal?.aborted) report.stopped = 'shutdown';
    return report;
}
module.exports = { runWorker, fetchDescription, withDeadline, closeBrowser, reconcileListingAssessment };
