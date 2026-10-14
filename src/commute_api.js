const { CommuteError, messages } = require('./google_commute');
function installCommuteApi(app, { service, repository }) {
    app.get('/api/commute/status', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await service.status()); }
        catch { res.status(503).json({ configured: false, available: false, code: 'service_error', error: messages.service_error }); }
    });
    app.post('/api/listings/:id/commute', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', abort);
        try {
            const listing = (await repository.getListing(req.params.id)).rows[0];
            if (!listing) throw new CommuteError('not_found', 404);
            const result = await service.lookup(listing, { signal: controller.signal });
            if (!controller.signal.aborted) res.json(result);
        } catch (error) {
            const safe = error instanceof CommuteError ? error : new CommuteError('service_error');
            if (!controller.signal.aborted) res.status(safe.status).json({ code: safe.code, error: safe.message });
        } finally { req.off('aborted', abort); res.off('close', abort); }
    });
}
module.exports = { installCommuteApi };
