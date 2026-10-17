const { TourPlannerError } = require('./tour_planner');
function installTourPlannerApi(app, { service, requireOwner }) {
    if (typeof requireOwner !== 'function') throw new Error('Tour APIs require owner authorization');
    const handle = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await action(req, res); }
        catch (error) {
            const known = error instanceof TourPlannerError || error.status === 409;
            res.status(known ? error.status : 503).json({ error: known ? error.message : 'Tour scheduling is temporarily unavailable.', code: known ? error.code : 'service_error' });
        }
    };
    app.get('/api/schedule', requireOwner, handle(async (req, res) => res.json(await service.listSchedule())));
    app.get('/api/tours/:id/schedule', requireOwner, handle(async (req, res) => res.json(await service.getSchedule(req.params.id))));
    app.put('/api/tours/:id/schedule', requireOwner, handle(async (req, res) => res.json(await service.updateSchedule(req.params.id, req.body))));
    app.get('/api/tours/:id/calendar.ics', requireOwner, handle(async (req, res) => {
        res.type('text/calendar').set('Content-Disposition', 'attachment; filename="apartment-tour.ics"').send(await service.calendar(req.params.id));
    }));
    app.post('/api/itineraries/plan', requireOwner, handle(async (req, res) => {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', abort);
        try { const result = await service.planItinerary(req.body, { signal: controller.signal }); if (!controller.signal.aborted) res.json(result); }
        finally { req.off('aborted', abort); res.off('close', abort); }
    }));
}
module.exports = { installTourPlannerApi };
