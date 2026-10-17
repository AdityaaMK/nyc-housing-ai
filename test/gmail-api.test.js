const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createGmailClient, MODIFY_SCOPE } = require('../src/gmail_api');
const { HttpsError } = require('../src/https_client');
const { authorizationRequest, validateCallback, saveCredentials } = require('../scripts/gmail-authorize');
const env = { GMAIL_USER: 'tenant@example.test', GMAIL_CLIENT_ID: 'client', GMAIL_CLIENT_SECRET: 'NETWORK_SECRET_PLACEHOLDER+secret/', GMAIL_REFRESH_TOKEN: 'NETWORK_SECRET_PLACEHOLDER+refresh/' };
function fixture(handler = async () => ({}), now = Date.now) {
    let refreshes = 0, profiles = 0;
    const calls = [];
    const gmail = createGmailClient({ env, now, client: { async request(url, options = {}) {
        calls.push({ url, options });
        if (url.endsWith('/token')) {
            refreshes++; await new Promise(resolve => setImmediate(resolve));
            assert.equal(options.json.client_secret, env.GMAIL_CLIENT_SECRET); assert.equal(options.json.refresh_token, env.GMAIL_REFRESH_TOKEN);
            return { data: { access_token: 'access', expires_in: 3600, scope: MODIFY_SCOPE } };
        }
        if (url.endsWith('/profile')) { profiles++; return { data: { emailAddress: env.GMAIL_USER } }; }
        return { data: await handler(url, options) };
    } } });
    return { gmail, calls, counts: () => ({ refreshes, profiles }) };
}
test('Gmail refreshes coalesce, cache until the pre-expiry margin, and verify identity', async () => {
    let time = 0;
    const f = fixture(undefined, () => time);
    await Promise.all(Array.from({ length: 12 }, () => f.gmail.verifyIdentity()));
    assert.deepEqual(f.counts(), { refreshes: 1, profiles: 1 });
    time = 3539000; await f.gmail.verifyIdentity(); assert.equal(f.counts().refreshes, 1);
    time = 3540000; await Promise.all([f.gmail.verifyIdentity(), f.gmail.verifyIdentity()]); assert.deepEqual(f.counts(), { refreshes: 2, profiles: 2 });
});
test('revoked tokens, missing scopes, API access denial and mailbox mismatch fail with actionable credential-free errors', async () => {
    for (const mode of ['revoked', 'scope', 'denied', 'mismatch']) {
        let mutations = 0;
        const gmail = createGmailClient({ env, client: { async request(url) {
            if (url.endsWith('/token')) {
                if (mode === 'revoked') throw new HttpsError('Gmail OAuth', 'request rejected', 400);
                return { data: { access_token: 'private-token', expires_in: 3600, scope: mode === 'scope' ? 'gmail.readonly' : MODIFY_SCOPE } };
            }
            if (url.endsWith('/profile')) {
                if (mode === 'denied') throw new HttpsError('Gmail API', 'request rejected', 403);
                return { data: { emailAddress: 'wrong@example.test' } };
            }
            mutations++; return { data: {} };
        } } });
        await assert.rejects(gmail.send({ to: 'broker@example.test' }), e => {
            assert.match(e.message, /authorize|mailbox|gmail.modify/); assert.ok(!e.message.includes('private-token')); return true;
        }); assert.equal(mutations, 0);
    }
});
test('Gmail unread listing uses INBOX, unread and two-day time filter and follows all pages', async () => {
    const seen = [];
    const f = fixture(async url => {
        const u = new URL(url); seen.push(u.searchParams);
        return u.searchParams.has('pageToken') ? { messages: [{ id: 'b' }, { id: 'c' }] } : { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'opaque+/=' };
    });
    const since = new Date('2026-10-10T20:00:00Z');
    assert.deepEqual(await f.gmail.listUnread(since), ['a', 'b', 'c']);
    assert.equal(seen.length, 2); assert.equal(seen[1].get('pageToken'), 'opaque+/=');
    assert.equal(seen[0].get('q'), 'in:inbox is:unread after:' + Math.floor(since.getTime() / 1000));
});
test('Gmail uses Nodemailer MIME with encoded subject, Reply-To and retained BCC; failed send is never replayed', async () => {
    let sends = 0, raw;
    const f = fixture(async (url, options) => {
        if (url.endsWith('/messages/send')) { sends++; raw = Buffer.from(options.json.raw, 'base64url').toString(); return { id: 'gmail-stable-id' }; }
        if (url.endsWith('/modify')) { assert.deepEqual(options.json, { removeLabelIds: ['UNREAD'] }); return {}; }
    });
    const mail = { from: { name: 'Tenant É', address: env.GMAIL_USER }, to: 'Broker <broker@example.test>',
        replyTo: env.GMAIL_USER, bcc: env.GMAIL_USER, subject: 'Tour — Tuesday', text: 'Hello!\nMay I tour?' };
    assert.equal((await f.gmail.send(mail)).messageId, 'gmail-stable-id'); assert.equal(sends, 1);
    assert.match(raw, /Bcc: tenant@example.test/i); assert.match(raw, /Reply-To: tenant@example.test/i); assert.match(raw, /Subject: =\?UTF-8\?/i);
    assert.match(raw, /From: =\?UTF-8\?/i); await f.gmail.markRead('gmail-stable-id');
    let attempts = 0;
    const broken = fixture(async () => { attempts++; throw new HttpsError('Gmail API', 'request failed'); });
    await assert.rejects(broken.gmail.send(mail)); assert.equal(attempts, 1);
});
test('worker mailbox listing includes read replies without changing read flags', async () => {
    const f = fixture(async (url, options) => {
        assert.equal(options.method, undefined);
        assert.equal(new URL(url).searchParams.get('q'), 'in:inbox after:1000');
        return { messages: [{ id: 'opened-on-phone' }] };
    });
    assert.deepEqual(await f.gmail.listMessages(new Date(1000000)), ['opened-on-phone']);
});
test('Gmail parses encoded headers and multipart base64/quoted-printable raw MIME with mailparser', async () => {
    const raw = [
        'From: =?UTF-8?B?QnJva2VyIMOJ?= <broker@example.test>', 'Subject: =?UTF-8?B?VG91ciDigJQgVHVlc2RheQ==?=',
        'Date: Mon, 12 Oct 2026 12:00:00 -0400', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="fixture"', '',
        '--fixture', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Tour at 5:30 =E2=80=94 buzz 4B',
        '--fixture', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from('<p>Tour at 5:30 — buzz 4B</p>').toString('base64'), '--fixture--', ''
    ].join('\r\n');
    const f = fixture(async url => { assert.ok(url.endsWith('?format=raw')); return { raw: Buffer.from(raw).toString('base64url'), internalDate: '1791820800000' }; });
    const message = await f.gmail.getMessage('stable-id');
    assert.equal(message.id, 'stable-id'); assert.equal(message.subject, 'Tour — Tuesday');
    assert.equal(message.fromAddress, 'broker@example.test'); assert.match(message.body, /Tour at 5:30 — buzz 4B/);
    assert.equal(message.receivedAt, '2026-10-12T16:00:00.000Z');
});
test('Desktop OAuth helper uses offline access, state validation and PKCE, and saves only a private file', () => {
    const redirect = 'http://127.0.0.1:12345/oauth2callback', auth = authorizationRequest('client', redirect), url = new URL(auth.url);
    assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), MODIFY_SCOPE); assert.ok(!url.searchParams.has('client_secret'));
    assert.equal(validateCallback('/oauth2callback?state=' + auth.state + '&code=fixture', redirect, auth.state), 'fixture');
    assert.throws(() => validateCallback('/oauth2callback?state=wrong&code=fixture', redirect, auth.state), /state/);
    assert.throws(() => validateCallback('/oauth2callback?state=' + auth.state + '&error=access_denied', redirect, auth.state), /denied/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-credentials-'));
    try {
        const file = saveCredentials(env, dir);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
        assert.deepEqual(JSON.parse(fs.readFileSync(file)), env);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
