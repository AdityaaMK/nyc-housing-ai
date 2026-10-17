function installPreferencesApi(app, { service, requireOwner }) {
    if (typeof requireOwner !== 'function') throw new Error('Preference routes require owner authentication');
    const handle = work => async (req, res) => {
        try { res.json(await work(req)); }
        catch (error) {
            const status = error.status === 409 ? 409 : error.status === 400 ? 400 : 500;
            res.status(status).json({ error: status === 500 ? 'Search preferences are temporarily unavailable' : error.message });
        }
    };
    app.get('/api/preferences', handle(() => service.get()));
    app.put('/api/preferences', requireOwner, handle(req => service.update(req.body)));
    app.post('/api/preferences/preview', requireOwner, handle(req => service.preview(req.body)));
}
module.exports = { installPreferencesApi };
