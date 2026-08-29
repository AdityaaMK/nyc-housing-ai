require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');

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

// Update listing status (e.g. 'passed', 'applied', 'contacted')
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

const PORT = process.env.PORT || 3001;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Housing AI Web API running on http://localhost:${PORT}`);
    });
}

module.exports = app;
