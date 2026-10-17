function installApplicationsApi(app, { service, requireOwner }) {
    const owner = requireOwner || ((req, res) => res.status(403).json({ error: 'Owner access is required.' }));
    const route = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await handler(req)); }
        catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Application operation failed.' : error.message,
                code: status === 500 ? 'application_error' : error.code ?? 'invalid_application' });
        }
    };
    app.get('/api/applications', owner, route(() => service.list()));
    app.get('/api/applications/compare', owner, route(req => service.compare(typeof req.query.ids === 'string' ? req.query.ids.split(',') : [])));
    app.get('/api/listings/:id/application', owner, route(req => service.get(req.params.id)));
    app.put('/api/listings/:id/application', owner, route(req => service.update(req.params.id, req.body)));
}
module.exports = { installApplicationsApi };
