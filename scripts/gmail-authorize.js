// Run on the local workstation, using a downloaded Google Desktop OAuth client.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const { httpsClient } = require('../src/https_client');
const { createGmailClient, MODIFY_SCOPE, gmailError } = require('../src/gmail_api');
function authorizationRequest(clientId, redirectUri) {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: MODIFY_SCOPE, access_type: 'offline', prompt: 'consent select_account', state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return { state, verifier, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + query };
}
function validateCallback(requestUrl, redirectUri, expectedState) {
    const url = new URL(requestUrl, redirectUri);
    if (url.pathname !== '/oauth2callback') return null;
    const actual = Buffer.from(url.searchParams.get('state') || ''), expected = Buffer.from(expectedState);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('OAuth callback state mismatch');
    if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('Gmail authorization was denied or incomplete');
    return url.searchParams.get('code');
}
function saveCredentials(credentials, dir = path.join(os.homedir(), '.config', 'nyc-housing-ai')) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // New private file per authorization; never overwrite another grant or follow a symlink.
    const file = path.join(dir, 'gmail-' + randomBytes(8).toString('hex') + '.json');
    fs.writeFileSync(file, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return file;
}
async function main() {
    const clientFile = process.argv[2];
    if (!clientFile) throw new Error('Usage: npm run gmail:authorize -- /private/path/desktop-client.json mailbox@gmail.com');
    const user = process.argv[3] || process.env.GMAIL_USER;
    if (!user) throw new Error('Provide the intended mailbox as the second argument or GMAIL_USER');
    let desktop;
    try { desktop = JSON.parse(fs.readFileSync(clientFile, 'utf8')).installed; } catch {}
    if (!desktop?.client_id || !desktop?.client_secret) throw new Error('Input must be a downloaded Desktop OAuth client JSON file');
    let server, timer;
    try {
        let auth, redirectUri;
        let resolveCode, rejectCode;
        const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
        server = http.createServer((req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (req.method !== 'GET') { res.writeHead(405).end(); return; }
                const code = validateCallback(req.url, redirectUri, auth.state);
                if (!code) { res.writeHead(404).end(); return; }
                res.end('Authorization received. You can close this window.'); resolveCode(code);
            } catch { res.writeHead(400).end('Invalid OAuth callback.'); }
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
        auth = authorizationRequest(desktop.client_id, redirectUri);
        timer = setTimeout(() => rejectCode(new Error('Gmail authorization timed out; rerun the helper')), 5 * 60000);
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', auth.url] : [auth.url];
        const browser = spawn(command, args, { stdio: 'ignore' });
        browser.once('error', () => rejectCode(new Error('Cannot open the local browser; run this helper on a desktop workstation')));
        browser.once('exit', code => { if (code) rejectCode(new Error('Cannot open the local browser')); });
        const code = await codePromise;
        let tokens;
        try {
            tokens = (await httpsClient.request('https://oauth2.googleapis.com/token', { method: 'POST', service: 'Gmail OAuth', json: {
                code, client_id: desktop.client_id, client_secret: desktop.client_secret,
                redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: auth.verifier
            } })).data;
        } catch (error) { throw gmailError(error, true); }
        if (!tokens?.refresh_token) throw new Error('Google did not return an offline refresh token; revoke this app grant and authorize again');
        const credentials = { GMAIL_USER: user, GMAIL_CLIENT_ID: desktop.client_id,
            GMAIL_CLIENT_SECRET: desktop.client_secret, GMAIL_REFRESH_TOKEN: tokens.refresh_token };
        await createGmailClient({ env: credentials }).verifyIdentity();
        console.log(saveCredentials(credentials));
    } finally {
        clearTimeout(timer);
        if (server) await new Promise(resolve => server.close(resolve));
        await httpsClient.close();
    }
}
module.exports = { authorizationRequest, validateCallback, saveCredentials };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
