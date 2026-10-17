const { repository } = require('./repository');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB, pool } = require('./db');
const { createAllowance } = require('./commute_allowance');
const { createCommuteService, commuteOrigin } = require('./google_commute');
const { installCommuteApi } = require('./commute_api');
const { publicError } = require('./evaluation_errors');
const { commuteMapsUrl } = require('./commute_links');
const { confirmTourBooking, generateGoogleCalendarUrl } = require('./inbound_listener');

const { loadPreferences, matchesPreferences, locationArea } = require('./preferences');
const { createOwnerAuth } = require('./owner_auth');
const { getProductServices } = require('./product_services');

const app = express();
app.use(cors());
app.use(express.json());
const owner = createOwnerAuth();
const products = getProductServices();
app.get('/api/owner/session', owner.session);
// Existing actions can send mail, mutate user choices, or consume provider quota.
app.post(['/api/listings/:id/status', '/api/tours/:id/confirm', '/api/listings/:id/commute'], owner.requireOwner);
app.post('/api/listings/:id/commute', async (req, res, next) => {
    try { await products.preferences.get(); next(); }
    catch { res.status(503).json({ error: 'Search preferences are temporarily unavailable.' }); }
});
installCommuteApi(app, { repository, service: createCommuteService({ allowance: createAllowance(pool),
    destination: () => loadPreferences().officeCommute.destination }) });
require('./listing_insights_api').installListingInsightsApi(app, { service: products.insights, requireOwner: owner.requireOwner });
require('./preferences_api').installPreferencesApi(app, { service: products.preferences, requireOwner: owner.requireOwner });
require('./selection_api').installSelectionApi(app, { service: products.selection, requireOwner: owner.requireOwner });
require('./conversations_api').installConversationsApi(app, { service: products.conversations, requireOwner: owner.requireOwner });
require('./tour_planner_api').installTourPlannerApi(app, { service: products.tours, requireOwner: owner.requireOwner });
require('./applications_api').installApplicationsApi(app, { service: products.applications, requireOwner: owner.requireOwner });
app.get('/api/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await products.health.status()); }
    catch { res.status(503).json({ error: 'Worker health is temporarily unavailable.' }); }
});

// Get all listings
app.get('/api/listings', async (req, res) => {
    try {
        const result = await repository.listListings();
        const enriched = await products.enrichListings(result.rows);
        const preferences = loadPreferences();
        res.json(enriched.map(row => {
            const { evaluation_claim_token, evaluation_claim_expires_at, saved, ...listing } = row;
            return { ...listing, commute_address_available: Boolean(commuteOrigin(listing)), commute_maps_url: commuteMapsUrl(listing), evaluation_last_error: publicError(listing.evaluation_last_error),
                location_area: locationArea(listing, preferences), is_preferred: matchesPreferences(listing, preferences) };
        }));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch listings' });
    }
});

// Update listing status (e.g. 'passed', 'applied', 'contacted', 'inbox')
app.post('/api/listings/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['inbox', 'passed', 'applied', 'contacted'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const result = await repository.setListingStatus(id, status);
        if (!result.rowCount) return res.status(404).json({ error: 'Listing not found' });
        res.json({ success: true, id, status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Get all tours from tour_schedules
app.get('/api/tours', owner.requireOwner, async (req, res) => {
    try {
        const result = await repository.listTours();
        
        // Enrich with calendar URLs
        const tours = result.rows.map(t => {
            const startTime = t.proposed_datetime ? new Date(t.proposed_datetime) : null;
            if (!startTime || !Number.isFinite(startTime.getTime())) return { ...t, calendar_url: null };
            const endTime = new Date(startTime.getTime() + 45 * 60 * 1000);
            const calendarUrl = generateGoogleCalendarUrl({
                title: t.listing_address || "Apartment Tour",
                startTime,
                endTime,
                location: t.listing_address || "New York, NY",
                details: `Broker: ${t.broker_name || "Broker"} (${t.broker_email || ""})\nNotes: ${t.special_instructions || "None"}`
            });
            return { ...t, calendar_url: calendarUrl };
        });

        res.json(tours);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tours' });
    }
});

// Confirm tour booking via web UI
app.post('/api/tours/:id/confirm', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await confirmTourBooking(id, { expectedRevision: req.body?.expectedRevision });
        res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to confirm tour' });
    }
});

// Get system statistics
app.get('/api/stats', async (req, res) => {
    try {
        const listingsRes = await repository.statsRows();
        const rows = listingsRes.rows;

        const evaluation = { pending: 0, processing: 0, completed: 0, retry_wait: 0, failed: 0 };
        let total = rows.length;
        let inbox = 0, applied = 0, passed = 0;
        let gradeA = 0, gradeB = 0, gradeC = 0;
        let priceSum = 0, priceCount = 0;

        for (const r of rows) {
            if (Object.hasOwn(evaluation, r.evaluation_status)) evaluation[r.evaluation_status]++;
            if (r.status === 'applied') applied++;
            else if (r.status === 'passed') passed++;
            else inbox++;

            if (r.price && r.price > 0) {
                priceSum += r.price;
                priceCount++;
            }

            try {
                if (r.building_health) {
                    const bh = typeof r.building_health === 'string' ? JSON.parse(r.building_health) : r.building_health;
                    if (bh.grade === 'A') gradeA++;
                    else if (bh.grade === 'B') gradeB++;
                    else if (bh.grade === 'C') gradeC++;
                }
            } catch(e) {}
        }

        let toursCount = 0;
        try {
            const toursRes = await repository.countTours();
            toursCount = parseInt(toursRes.rows[0].count, 10);
        } catch(e) {}

        res.json({
            total,
            evaluation,
            inbox,
            applied,
            passed,
            averagePrice: priceCount > 0 ? Math.round(priceSum / priceCount) : 0,
            health: { gradeA, gradeB, gradeC },
            tours: toursCount
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to compute stats' });
    }
});

// Serve the built dashboard from the existing API process when a build is present.
app.use(express.static(require('node:path').resolve(__dirname, '../web/dist')));

const PORT = process.env.PORT || 3001;

if (require.main === module) {
    initDB().then(async () => {
        await products.store.verify();
        app.listen(PORT, () => {
            console.log(`🚀 Housing AI Web API running on http://localhost:${PORT}`);
        });
    }).catch(async () => {
        console.error('Housing API startup failed. Check database access and install the product feature migration.');
        await pool.end().catch(() => {});
        process.exitCode = 1;
    });
}

module.exports = app;
