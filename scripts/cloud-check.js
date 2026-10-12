// Explicitly read-only: never import db.js (its SQL initialization can migrate).
require('dotenv').config({ quiet: true });
const { createSupabaseClient } = require('../src/supabase_client');
const { createGmailClient } = require('../src/gmail_api');
const { httpsClient } = require('../src/https_client');
async function check({ database = createSupabaseClient(), gmail = createGmailClient() } = {}) {
    await database.verifySchema();
    for (const table of ['listings', 'tour_schedules']) {
        const response = await database.rest(table, { params: { select: 'id', order: 'id.asc', limit: 1 } });
        if (!Array.isArray(response.data)) throw new Error('Supabase read diagnostic returned invalid data');
    }
    await gmail.verifyIdentity();
    return { schema: 'compatible', databaseReads: 'ok', tokenRefresh: 'ok', mailboxIdentity: 'matches GMAIL_USER' };
}
module.exports = { check };
if (require.main === module) check().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
}).finally(() => httpsClient.close());
