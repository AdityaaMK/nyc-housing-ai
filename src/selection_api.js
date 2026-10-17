function installSelectionApi(app, { service, requireOwner }) {
    const owner = requireOwner || ((req, res) => res.status(403).json({ error: 'Owner access is required.' }));
    const route = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await handler(req)); }
        catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Selection operation failed.' : error.message,
                code: status === 500 ? 'selection_error' : error.code ?? 'invalid_selection' });
        }
    };
    app.get('/api/watchlist', owner, route(() => service.watchlist()));
    app.put('/api/watchlist/:id', owner, route(req => {
        if (!req.body || Object.keys(req.body).some(key => key !== 'saved')) {
            const error = new Error('Provide only the saved flag.'); error.status = 400; throw error;
        }
        return service.setWatchlist(req.params.id, req.body.saved);
    }));
    app.get('/api/compare', owner, route(req => service.comparison(typeof req.query.ids === 'string' ? req.query.ids.split(',') : [])));
    app.get('/api/listings/:id/costs', owner, route(req => service.getCosts(req.params.id)));
    app.put('/api/listings/:id/costs', owner, route(req => service.updateCosts(req.params.id, req.body)));
    app.get('/api/listings/:id/review', owner, route(req => service.getReview(req.params.id)));
    app.put('/api/listings/:id/review', owner, route(req => service.updateReview(req.params.id, req.body)));
    app.post('/api/listings/:id/decision', owner, route(req => service.decide(req.params.id, req.body)));
    app.get('/api/decisions', owner, route(() => service.decisions()));
}
module.exports = { installSelectionApi };
