const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { featureStore } = require('./feature_store');
const names = ['scraper', 'scorer', 'inbox', 'telegram'];
const timestamp = value => {
    if (!['string', 'number'].includes(typeof value) || value === '') return null;
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? result : null;
};
const count = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
const sourceNames = new Set(['streeteasy', 'renthop', 'compass']);
const sourceOutcomes = new Set(['success', 'empty', 'partial', 'blocked', 'parser_failure', 'failed']);
const sourceFailures = new Set(['blocked', 'parser_failure', 'failed']);
function publicFeed(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !['streeteasy.com', 'renthop.com', 'compass.com'].includes(url.hostname.replace(/^www\./, ''))) return null;
        // Feed query parameters may carry private tokens. Health needs the source
        // and path; it never needs credentials, fragments or provider responses.
        return `${url.origin}${url.pathname}`.slice(0, 1000);
    } catch { return null; }
}
const categories = new Set(['mailbox_or_database_unavailable', 'messages_pending', 'delivery_or_database_unavailable',
    'connection_or_service_error', 'telegram_409', 'telegram_401', 'telegram_403', 'telegram_429',
    'scrape_failed', 'scoring_failed', 'database_unavailable', 'startup_failed']);
const RUN_LIMIT = 30;
const runOutcomes = new Set(['started', 'success', 'failure', 'stopping', 'stopped']);
const statuses = new Set(['running', 'stopping', 'stopped']);
function publicRun(value) {
    return { at: timestamp(value?.at), status: statuses.has(value?.status) ? value.status : 'running',
        outcome: runOutcomes.has(value?.outcome) ? value.outcome : 'failure',
        error: value?.error ? categories.has(value.error) ? value.error : 'connection_or_service_error' : null,
        lastSuccessAt: timestamp(value?.last_success_at), backlog: count(value?.backlog) };
}

function createWorkerReporter(name, { store = featureStore, now = Date.now, intervalMs = 15000 } = {}) {
    if (!names.includes(name)) throw new Error('Unknown worker name');
    let current = { status: 'running', last_success_at: null, error: null, backlog: null }, writing = null, dirty = false, stopped = false, savedRunIds = new Set();
    function persist() {
        dirty = true;
        if (!writing) writing = Promise.resolve().then(async () => {
            try {
                while (dirty) {
                    dirty = false;
                    const snapshot = { ...current, name, heartbeat_at: now() };
                    try {
                        const record = await store.update('worker_health', name, (previous, previousRecord) => {
                            const next = { ...snapshot, last_success_at: snapshot.last_success_at ?? timestamp(previous?.last_success_at) };
                            const changed = !previous || previous.status !== next.status || previous.error !== next.error || previous.last_success_at !== next.last_success_at;
                            const outcome = next.status === 'stopped' ? 'stopped' : next.status === 'stopping' ? 'stopping' : next.error ? 'failure' :
                                next.last_success_at !== null && next.last_success_at !== previous?.last_success_at ? 'success' : 'started';
                            // Commit the history identity with the heartbeat. A
                            // crash before appending can replay this exact entry.
                            next.last_run = changed ? { id: name + ':' + randomUUID(), name, at: next.heartbeat_at, sequence: (previousRecord?.revision || 0) + 1, status: next.status,
                                outcome, error: next.error, last_success_at: next.last_success_at, backlog: next.backlog } : previous.last_run || null;
                            const priorRuns = Array.isArray(previous?.recent_runs) ? previous.recent_runs : previous?.last_run ? [previous.last_run] : [];
                            next.recent_runs = (changed ? [...priorRuns, next.last_run] : priorRuns).slice(-RUN_LIMIT);
                            return next;
                        });
                        const pending = record?.data?.recent_runs || [];
                        if (pending.some(run => !savedRunIds.has(run.id))) {
                            for (const run of pending) if (!savedRunIds.has(run.id)) await store.create('worker_runs', run.id, run);
                            const history = (await store.list('worker_runs')).filter(row => row.data.name === name)
                                .sort((a, b) => (timestamp(b.data.at) || 0) - (timestamp(a.data.at) || 0) || (b.data.sequence || 0) - (a.data.sequence || 0) || b.id.localeCompare(a.id));
                            for (const stale of history.slice(RUN_LIMIT)) await store.remove('worker_runs', stale.id, { expectedRevision: stale.revision });
                            savedRunIds = new Set(pending.map(run => run.id));
                        }
                    }
                    catch { /* The health API will show stale state when storage is unreachable. */ }
                }
            } finally { writing = null; }
        });
        return writing;
    }
    const timer = setInterval(() => { void persist(); }, intervalMs).unref();
    return {
        async report({ status, lastSuccessAt, error, backlog } = {}) {
            if (stopped) { await writing; return; }
            if (['running', 'stopping', 'stopped'].includes(status)) current.status = status;
            if (Number.isFinite(timestamp(lastSuccessAt))) current.last_success_at = timestamp(lastSuccessAt);
            if (error !== undefined) current.error = error ? categories.has(error) ? error : 'connection_or_service_error' : null;
            if (Number.isFinite(backlog)) current.backlog = Math.max(0, backlog);
            await persist();
        },
        async stop() { clearInterval(timer); stopped = true; current.status = 'stopped'; await persist(); }
    };
}

function classify(data, now) {
    if (!data) return 'unknown';
    if (data.status === 'stopped') return 'stopped';
    const heartbeat = timestamp(data.heartbeat_at);
    if (heartbeat === null || now - heartbeat > 60000 || heartbeat - now > 60000) return 'stale';
    if (data.error || data.status === 'stopping' || timestamp(data.last_success_at) === null) return 'degraded';
    return 'healthy';
}
function createHealthService({ store = featureStore, repository, now = Date.now, local = true } = {}) {
    return {
        async status() {
            const [workers, scans, stats, runs] = await Promise.all([store.list('worker_health'), store.list('source_scans'), repository.statsRows(), store.list('worker_runs')]);
            const data = new Map(workers.map(row => [row.id, row.data]));
            const provenance = new Map(workers.map(row => [row.id, 'shared']));
            const queues = { scoring: { pending: 0, processing: 0, completed: 0, retry_wait: 0, failed: 0 },
                inboxPending: null, telegramPending: null, inboxPendingSource: null, telegramPendingSource: null };
            for (const row of stats.rows) if (Object.hasOwn(queues.scoring, row.evaluation_status)) queues.scoring[row.evaluation_status]++;
            if (local) {
                const paths = [
                    ['inbox', require('./inbox_state').stateFile(), require('./inbox_state').readInboxStatus],
                    ['telegram', require('./telegram_worker').stateFile(), require('./telegram_state').readStatus]
                ];
                for (const [name, filename, read] of paths) {
                    if (!fs.existsSync(filename)) continue;
                    try {
                        const status = read(filename), h = status.heartbeat;
                        if (!h) continue;
                        const localAt = timestamp(h.at), sharedAt = timestamp(data.get(name)?.heartbeat_at);
                        const sharedIsValid = sharedAt !== null && sharedAt - now() <= 60000;
                        // A stopped journal from this host may outlive deployment
                        // elsewhere. Use it only when its evidence is more recent.
                        if (localAt === null || localAt - now() > 60000 || (sharedIsValid && localAt <= sharedAt)) continue;
                        data.set(name, { status: h.status, heartbeat_at: h.at,
                            last_success_at: h.lastCheckAt || h.lastPollAt, error: h.error || h.pollError || h.notifyError,
                            backlog: null });
                        provenance.set(name, 'local_journal');
                        const rows = name === 'inbox' ? status.messages : status.deliveries;
                        const queueName = name === 'inbox' ? 'inboxPending' : 'telegramPending';
                        queues[queueName] = rows.filter(row =>
                            !['done', 'ignored', 'cancelled'].includes(row.status)).reduce((total, row) => total + (count(row.count) || 0), 0);
                        queues[queueName + 'Source'] = 'local_journal';
                    } catch {
                        // An unreadable old local file says nothing about a worker
                        // currently reporting through the shared database.
                        if (!data.has(name)) {
                            data.set(name, { heartbeat_at: null, error: 'database_unavailable' });
                            provenance.set(name, 'local_journal');
                        }
                    }
                }
            }
            const latest = new Map();
            for (const row of scans) {
                const scan = row.data, key = scan.source + ':' + scan.feed_url;
                if (!latest.has(key) || timestamp(scan.completed_at) > timestamp(latest.get(key).completed_at)) latest.set(key, scan);
            }
            return { checkedAt: new Date(now()).toISOString(), workers: names.map(name => {
                const worker = data.get(name);
                const history = new Map(runs.filter(row => row.data.name === name).map(row => [row.id, row.data]));
                // Shared health keeps a bounded recovery copy, including an
                // operation interrupted before its history append completed.
                const shared = workers.find(row => row.id === name)?.data;
                for (const run of shared?.recent_runs || []) if (run.name === name) history.set(run.id, run);
                return { name, source: provenance.get(name) || 'unknown', status: classify(worker, now()), heartbeatAt: timestamp(worker?.heartbeat_at),
                    lastSuccessAt: timestamp(worker?.last_success_at), error: worker?.error ? categories.has(worker.error) ? worker.error : 'connection_or_service_error' : null,
                    backlog: count(worker?.backlog), recentRuns: [...history.values()]
                        .sort((a, b) => (timestamp(b.at) || 0) - (timestamp(a.at) || 0) || (b.sequence || 0) - (a.sequence || 0))
                        .slice(0, RUN_LIMIT).map(publicRun) };
            }), sources: [...latest.values()].map(scan => {
                const at = timestamp(scan.completed_at);
                return { source: sourceNames.has(scan.source) ? scan.source : 'unknown', feed: publicFeed(scan.feed_url),
                    status: at === null || now() - at > 900000 || at - now() > 60000 ? 'stale' : sourceOutcomes.has(scan.outcome) ? scan.outcome : 'failed',
                    at: at === null ? null : new Date(at).toISOString(), count: count(scan.observation_count ?? scan.parsed_count),
                    error: scan.failure_category ? sourceFailures.has(scan.failure_category) ? scan.failure_category : 'failed' : null };
            }), queues };
        }
    };
}
module.exports = { createWorkerReporter, createHealthService, classify };
