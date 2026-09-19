require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initDB } = require('./db');
const { confirmTourBooking, generateGoogleCalendarUrl } = require('./inbound_listener');

const app = express();
app.use(cors());
app.use(express.json());

// Get all listings
app.get('/api/listings', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM listings ORDER BY suitability_score DESC NULLS LAST, discovered_at DESC`
        );
        res.json(result.rows);
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
        await pool.query(`UPDATE listings SET status = $1 WHERE id = $2`, [status, id]);
        res.json({ success: true, id, status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Get all tours from tour_schedules
app.get('/api/tours', async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tour_schedules (
                id TEXT PRIMARY KEY,
                listing_address TEXT,
                broker_email TEXT,
                broker_name TEXT,
                proposed_time TEXT,
                special_instructions TEXT,
                status TEXT DEFAULT 'proposed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const result = await pool.query(`SELECT * FROM tour_schedules ORDER BY created_at DESC`);
        
        // Enrich with calendar URLs
        const tours = result.rows.map(t => {
            const startTime = new Date(Date.now() + 24 * 3600 * 1000);
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
        const result = await confirmTourBooking(id);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to confirm tour' });
    }
});

// Get system statistics
app.get('/api/stats', async (req, res) => {
    try {
        const listingsRes = await pool.query(`SELECT status, suitability_score, building_health, price FROM listings`);
        const rows = listingsRes.rows;

        let total = rows.length;
        let inbox = 0, applied = 0, passed = 0;
        let gradeA = 0, gradeB = 0, gradeC = 0;
        let priceSum = 0, priceCount = 0;

        for (const r of rows) {
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
            const toursRes = await pool.query(`SELECT COUNT(*) FROM tour_schedules`);
            toursCount = parseInt(toursRes.rows[0].count, 10);
        } catch(e) {}

        res.json({
            total,
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

const PORT = process.env.PORT || 3001;

if (require.main === module) {
    initDB().then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 Housing AI Web API running on http://localhost:${PORT}`);
        });
    });
}

module.exports = app;
