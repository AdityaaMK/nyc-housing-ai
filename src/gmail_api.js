const fs = require('node:fs');
const { required } = require('./backend_config');
const { httpsClient, HttpsError } = require('./https_client');
const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
function gmailConfig(env = process.env) {
    let saved = {};
    if (env.GMAIL_CREDENTIALS_FILE) {
        try { saved = JSON.parse(fs.readFileSync(env.GMAIL_CREDENTIALS_FILE, 'utf8')); }
        catch { throw new Error('Cannot read GMAIL_CREDENTIALS_FILE; run npm run gmail:authorize locally'); }
    }
    const config = { ...saved, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')) };
    required(config, ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'], 'gmail-api');
    return config;
}
function gmailError(error, refreshing = false) {
    if (!(error instanceof HttpsError)) return error;
    if (refreshing && [400, 401].includes(error.status)) return new Error('Gmail OAuth credentials were rejected or revoked; run npm run gmail:authorize again with the Desktop OAuth client');
    if (error.status === 403) return new Error('Gmail API access denied; enable the Gmail API and reauthorize with gmail.modify, then check Google Workspace access policies');
    if (error.status === 401) return new Error('Gmail access token rejected; reauthorize with npm run gmail:authorize');
    return error;
}
function createGmailClient({ env = process.env, client = httpsClient, now = Date.now } = {}) {
    const config = gmailConfig(env);
    let cached, refreshing;
    async function api(path, token, options = {}) {
        try {
            return (await client.request('https://gmail.googleapis.com/gmail/v1/users/me/' + path,
                { ...options, headers: { Authorization: `Bearer ${token}` }, service: 'Gmail API' })).data;
        } catch (error) { if (error.status === 401) cached = null; throw gmailError(error); }
    }
    async function refresh() {
        let result;
        try {
            result = (await client.request('https://oauth2.googleapis.com/token', { method: 'POST', service: 'Gmail OAuth',
                json: { client_id: config.GMAIL_CLIENT_ID, client_secret: config.GMAIL_CLIENT_SECRET,
                    refresh_token: config.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' } })).data;
        } catch (error) { throw gmailError(error, true); }
        if (!result?.access_token || !(Number(result.expires_in) > 60)) throw new Error('Gmail OAuth returned an invalid token response');
        if (result.scope && !result.scope.split(' ').includes(MODIFY_SCOPE) && !result.scope.split(' ').includes('https://mail.google.com/')) {
            throw new Error('Gmail OAuth grant requires gmail.modify; run npm run gmail:authorize again');
        }
        const expiresAt = now() + Number(result.expires_in) * 1000;
        const profile = await api('profile', result.access_token);
        if (profile?.emailAddress?.toLowerCase() !== config.GMAIL_USER.toLowerCase()) {
            throw new Error('Authorized Gmail mailbox does not match GMAIL_USER; authorize the intended account');
        }
        cached = { token: result.access_token, expiresAt, profile };
        return cached;
    }
    async function credentials() {
        if (cached && now() < cached.expiresAt - 60000) return cached;
        refreshing ||= refresh().finally(() => { refreshing = null; });
        return refreshing;
    }
    const request = async (path, options) => api(path, (await credentials()).token, options);
    return {
        user: config.GMAIL_USER,
        verifyIdentity: async () => (await credentials()).profile,
        async listUnread(since) {
            const result = [], seen = new Set();
            let pageToken;
            do {
                const query = new URLSearchParams({ q: `in:inbox is:unread after:${Math.floor(since.getTime() / 1000)}`, maxResults: '500' });
                if (pageToken) query.set('pageToken', pageToken);
                const page = await request('messages?' + query);
                for (const message of page.messages || []) if (!seen.has(message.id)) { seen.add(message.id); result.push(message.id); }
                pageToken = page.nextPageToken;
            } while (pageToken);
            return result;
        },
        async getMessage(id) {
            const message = await request('messages/' + encodeURIComponent(id) + '?format=raw');
            if (!message?.raw) throw new Error('Gmail message has no raw MIME content');
            const parsed = await require('mailparser').simpleParser(Buffer.from(message.raw, 'base64url'));
            return { id, subject: parsed.subject || 'No Subject', from: parsed.from?.text || 'Unknown Sender',
                fromAddress: parsed.from?.value?.[0]?.address, body: parsed.text || parsed.html || '',
                receivedAt: parsed.date?.toISOString() || new Date(Number(message.internalDate)).toISOString() };
        },
        markRead: id => request('messages/' + encodeURIComponent(id) + '/modify', { method: 'POST', json: { removeLabelIds: ['UNREAD'] } }),
        async send(mailOptions) {
            // Verify the mailbox before constructing/sending. keepBcc prevents the
            // MIME composer from discarding recipients Gmail gets from the headers.
            await credentials();
            const composer = require('nodemailer').createTransport({ streamTransport: true, buffer: true });
            const composed = await composer.sendMail({ ...mailOptions, keepBcc: true });
            const sent = await request('messages/send', { method: 'POST', json: { raw: composed.message.toString('base64url') } });
            return { ...sent, messageId: sent.id };
        },
        close: async () => {}
    };
}
let shared;
const getGmailClient = () => shared ||= createGmailClient();
module.exports = { createGmailClient, getGmailClient, gmailConfig, gmailError, MODIFY_SCOPE };
