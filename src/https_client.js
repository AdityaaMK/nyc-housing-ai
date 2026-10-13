const { EnvHttpProxyAgent, fetch } = require('undici');
const tls = require('node:tls');
const fs = require('node:fs');

// Deliberately contains no provider body, request URL, headers, cause, or credentials.
class HttpsError extends Error {
    constructor(service, code, status = 0) {
        super(`${service}: ${code}${status ? ` (HTTP ${status})` : ''}`);
        this.name = 'HttpsError'; this.code = code; this.status = status;
    }
}
function createDispatcher(env = process.env) {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('HTTPS backends require TLS certificate validation');
    let ca;
    try {
        // Node already loads NODE_EXTRA_CA_CERTS at process startup. Some cloud
        // environments additionally expose their proxy CA via SSL_CERT_FILE.
        if (env.SSL_CERT_FILE) ca = [...(tls.getCACertificates ? tls.getCACertificates('default') : tls.rootCertificates), fs.readFileSync(env.SSL_CERT_FILE, 'utf8')];
    } catch { throw new Error('Cannot load the configured HTTPS CA certificate'); }
    return new EnvHttpProxyAgent({
        httpProxy: env.http_proxy || env.HTTP_PROXY, httpsProxy: env.https_proxy || env.HTTPS_PROXY,
        noProxy: env.no_proxy ?? env.NO_PROXY,
        ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {})
    });
}
function createHttpsClient({ fetchImpl = fetch, dispatcher, timeoutMs = 30000 } = {}) {
    let agent = dispatcher;
    return {
        async request(url, { method = 'GET', headers = {}, json, service = 'HTTPS service', signal } = {}) {
            let target;
            try { target = new URL(url); } catch { throw new HttpsError(service, 'invalid endpoint'); }
            if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) {
                throw new HttpsError(service, 'requires HTTPS on port 443');
            }
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const timer = setTimeout(abort, timeoutMs);
            try {
                agent ||= createDispatcher();
                // JSON keeps network-secret placeholders literal (no form/url/base64
                // encoding). Never follow redirects or replay an ambiguous mutation.
                const response = await fetchImpl(target, { method, headers: { ...headers,
                    ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
                    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
                    dispatcher: agent, redirect: 'error', signal: controller.signal });
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new HttpsError(service, 'request rejected', response.status);
                }
                const body = await response.text();
                return { data: body ? JSON.parse(body) : null, headers: response.headers, status: response.status };
            } catch (error) {
                if (error instanceof HttpsError) throw error;
                throw new HttpsError(service, controller.signal.aborted ? 'request deadline exceeded or cancelled' : 'request failed; check network, proxy and CA trust');
            } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        },
        async close() { await agent?.close?.(); }
    };
}
const httpsClient = createHttpsClient();
module.exports = { createHttpsClient, createDispatcher, HttpsError, httpsClient };
