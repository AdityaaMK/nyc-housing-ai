const { timingSafeEqual, createHash } = require('node:crypto');
function createOwnerAuth(env = process.env) {
    const configured = () => typeof env.HOUSING_OWNER_TOKEN === 'string' && env.HOUSING_OWNER_TOKEN.length >= 24 && env.HOUSING_OWNER_TOKEN.length <= 512;
    const authenticated = req => {
        if (!configured()) return false;
        const supplied = /^Bearer (.{1,512})$/.exec(req.get('authorization') || '')?.[1];
        if (!supplied) return false;
        const digest = value => createHash('sha256').update(value).digest();
        return timingSafeEqual(digest(supplied), digest(env.HOUSING_OWNER_TOKEN));
    };
    const requireOwner = (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!configured()) return res.status(503).json({ error: 'Owner editing is not configured. Set HOUSING_OWNER_TOKEN on the server.' });
        if (!authenticated(req)) return res.status(401).json({ error: 'Unlock owner access to continue.' });
        return next();
    };
    return { requireOwner, session: (req, res) => {
        res.set('Cache-Control', 'no-store'); res.json({ configured: configured(), authenticated: authenticated(req) });
    } };
}
module.exports = { createOwnerAuth };
