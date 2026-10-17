function installConversationsApi(app, { service, requireOwner }) {
    if (typeof requireOwner !== 'function') throw new Error('Conversation endpoints require owner authentication');
    const handle = fn => async (req, res) => {
        try { res.json(await fn(req)); }
        catch (error) { const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Conversation data is temporarily unavailable' : error.message }); }
    };
    app.get('/api/listings/:id/conversation', requireOwner, handle(req => service.timeline(req.params.id)));
    app.get('/api/conversations/unassigned', requireOwner, handle(() => service.unassigned()));
    app.put('/api/conversations/:messageId/assignment', requireOwner, handle(req => service.assign(req.params.messageId, req.body || {})));
}
module.exports = { installConversationsApi };
