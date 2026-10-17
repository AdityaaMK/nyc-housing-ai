function installListingInsightsApi(app, { service, requireOwner }) {
    const handle = fn => async (req, res) => {
        try { res.json(await fn(req)); }
        catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Listing insights unavailable' }); }
    };
    app.get('/api/listings/:id/insights', handle(req => service.getInsights(req.params.id)));
    app.post('/api/listings/:id/recheck', requireOwner, handle(req => service.recheck(req.params.id)));
}
module.exports = { installListingInsightsApi };
