const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { createHttpsClient, createDispatcher } = require('../src/https_client');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(resolve));
test('real HTTPS proxy CONNECT routing, injected CA trust and rejection of untrusted certificates', {
    skip: process.env.RUN_HTTPS_PROXY_TEST !== '1' ? 'Set RUN_HTTPS_PROXY_TEST=1 where local listening is permitted (requires openssl)' : false
}, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-https-proxy-'));
    let origin, proxy, trusted, untrusted;
    const sockets = new Set(), authorities = [], bodies = [];
    try {
        fs.writeFileSync(path.join(dir, 'openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=fixture.test\n[ext]\nsubjectAltName=DNS:fixture.test\nbasicConstraints=critical,CA:TRUE\n');
        const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
        const generated = spawnSync(process.env.OPENSSL_BIN || (process.platform === 'darwin' ? '/usr/bin/openssl' : 'openssl'), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', path.join(dir, 'openssl.cnf'), '-keyout', key, '-out', cert], { stdio: 'ignore' });
        assert.equal(generated.status, 0, 'openssl must generate a temporary test certificate');
        origin = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
            let body = ''; req.on('data', data => { body += data; }); req.on('end', () => {
                bodies.push({ body, key: req.headers.apikey }); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
            });
        });
        const originPort = await listen(origin);
        proxy = http.createServer();
        proxy.on('connect', (req, downstream, head) => {
            authorities.push(req.url);
            const upstream = net.connect(originPort, '127.0.0.1', () => {
                downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head); upstream.pipe(downstream); downstream.pipe(upstream);
            });
            for (const socket of [upstream, downstream]) { sockets.add(socket); socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); }
        });
        const proxyPort = await listen(proxy);
        const env = { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '' };
        trusted = createHttpsClient({ dispatcher: createDispatcher({ ...env, SSL_CERT_FILE: cert }), timeoutMs: 5000 });
        const secret = 'NETWORK_SECRET_PLACEHOLDER+fixture/';
        assert.deepEqual((await trusted.request('https://fixture.test/token', { method: 'POST', headers: { apikey: secret }, json: { refresh_token: secret } })).data, { ok: true });
        assert.equal(authorities[0], 'fixture.test:443'); assert.equal(bodies[0].key, secret); assert.ok(bodies[0].body.includes(secret));
        untrusted = createHttpsClient({ dispatcher: createDispatcher(env), timeoutMs: 5000 });
        await assert.rejects(untrusted.request('https://fixture.test/token'), /proxy and CA trust/);
        assert.equal(bodies.length, 1, 'untrusted TLS must not reach the origin HTTP handler');
    } finally {
        await trusted?.close(); await untrusted?.close();
        for (const socket of sockets) socket.destroy();
        if (proxy) await close(proxy); if (origin) await close(origin);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
