const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { getBrowserProxyArg } = require('../src/scraper');

const originalHttpsProxy = process.env.HTTPS_PROXY;
const originalHttpProxy = process.env.HTTP_PROXY;

afterEach(() => {
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
});

test('returns no argument when no proxy is configured', () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    assert.equal(getBrowserProxyArg(), null);
});

test('uses HTTPS_PROXY without exposing credentials', () => {
    process.env.HTTPS_PROXY = 'http://example-user:example-password@proxy.example:8080';
    assert.equal(getBrowserProxyArg(), '--proxy-server=http://proxy.example:8080');
});

test('falls back to HTTP_PROXY and accepts supported SOCKS proxies', () => {
    delete process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = 'socks5://proxy.example:1080';
    assert.equal(getBrowserProxyArg(), '--proxy-server=socks5://proxy.example:1080');
});

test('rejects invalid and unsupported proxy values', () => {
    process.env.HTTPS_PROXY = 'not a url';
    assert.equal(getBrowserProxyArg(), null);

    process.env.HTTPS_PROXY = 'ftp://proxy.example:21';
    assert.equal(getBrowserProxyArg(), null);
});
