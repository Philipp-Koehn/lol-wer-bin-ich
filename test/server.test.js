'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createStatic, send, makeEntry } = require('../server/static');
const { configuredOrigin, requestOrigin, isOriginAllowed, allowedOriginHosts, escapeHtml } = require('../server/public-url');
const { RateLimiter } = require('../server/rate-limit');

function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 0,
    body: undefined,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    end(body) { this.body = body; },
  };
}
const fakeReq = (p, headers = {}, query = {}) => ({ method: 'GET', path: p, headers, query });

const tempDirs = [];
test.after(() => tempDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolwbi-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'fonts'));
  fs.writeFileSync(path.join(dir, 'app.js'), `console.log(${JSON.stringify('x'.repeat(2000))});\n//# sourceMappingURL=app.js.map\n`);
  fs.writeFileSync(path.join(dir, 'fonts', 'a.woff2'), Buffer.alloc(64));
  fs.writeFileSync(path.join(dir, 'secret.env'), 'TOKEN=1'); // unbekannter Typ: wird nie ausgeliefert
  fs.writeFileSync(path.join(dir, 'index.html'), '<link href="{{asset:/app.js}}"><meta content="{{baseUrl}}/og.jpg">');
  return createStatic({ publicDir: dir, templates: ['/index.html'] });
}

test('statische Dateien: Brotli/Gzip, ETag/304, Cache-Control nach Version', () => {
  const s = fixture();
  const entry = s.files.get('/app.js');
  assert.ok(entry, 'app.js ist registriert');
  assert.ok(!entry.raw.toString().includes('sourceMappingURL'), 'Source-Map-Verweis entfernt');

  let res = fakeRes();
  s.middleware(fakeReq('/app.js', { 'accept-encoding': 'gzip, deflate, br' }, { v: entry.hash }), res, () => assert.fail('next'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(zlib.brotliDecompressSync(res.body).toString(), entry.raw.toString());

  res = fakeRes();
  s.middleware(fakeReq('/app.js', { 'accept-encoding': 'gzip' }), res, () => assert.fail('next'));
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['cache-control'], 'public, no-cache', 'ohne passende Version wird revalidiert');

  res = fakeRes();
  s.middleware(fakeReq('/app.js', { 'if-none-match': entry.etag }), res, () => assert.fail('next'));
  assert.equal(res.statusCode, 304);

  res = fakeRes();
  s.middleware(fakeReq('/fonts/a.woff2'), res, () => assert.fail('next'));
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(res.headers['content-encoding'], undefined, 'woff2 wird nicht nochmals komprimiert');

  for (const p of ['/secret.env', '/index.html', '/../package.json', '/missing.js']) {
    let called = false;
    s.middleware(fakeReq(p), fakeRes(), () => { called = true; });
    assert.ok(called, `${p} wird nicht als statische Datei ausgeliefert`);
  }
});

test('Template: Asset-Versionen und Basis-URL werden eingesetzt', () => {
  const s = fixture();
  const html = s.render('/index.html', { baseUrl: 'https://example.org' });
  assert.equal(html, `<link href="/app.js?v=${s.files.get('/app.js').hash}"><meta content="https://example.org/og.jpg">`);
  assert.throws(() => s.render('/index.html', {}), /baseUrl/);
});

test('send hängt Accept-Encoding an ein vorhandenes Vary an', () => {
  const res = fakeRes();
  res.setHeader('Vary', 'Host');
  send(fakeReq('/'), res, makeEntry('x'.repeat(1000), 'text/plain'), 'no-cache');
  assert.equal(res.headers.vary, 'Host, Accept-Encoding');
});

test('Basis-URL: PUBLIC_URL vor Render/Railway, nur http(s), Host-Header wird geprüft', () => {
  assert.equal(configuredOrigin({ PUBLIC_URL: 'https://spiel.example.org/irgendwas/' }), 'https://spiel.example.org');
  assert.equal(configuredOrigin({ RENDER_EXTERNAL_URL: 'https://x.onrender.com' }), 'https://x.onrender.com');
  assert.equal(configuredOrigin({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), 'https://x.up.railway.app');
  assert.equal(configuredOrigin({ PUBLIC_URL: 'javascript:alert(1)' }), null);
  assert.equal(configuredOrigin({}), null);

  const req = (host, protocol = 'http') => ({ protocol, get: () => host });
  assert.equal(requestOrigin(req('Spiel.Example.org:8080', 'https')), 'https://spiel.example.org:8080');
  assert.equal(requestOrigin(req('evil.com"><script>')), 'http://localhost');
  assert.equal(requestOrigin(req('')), 'http://localhost');
  assert.equal(escapeHtml('"<&>\''), '&quot;&lt;&amp;&gt;&#39;');
});

test('Socket-Origin: nur eigene Seite oder ausdrücklich erlaubte Hosts', () => {
  const hosts = allowedOriginHosts({ PUBLIC_URL: 'https://spiel.example.org', ALLOWED_ORIGINS: 'https://lan.example:3000, kaputt' });
  assert.ok(isOriginAllowed({ origin: 'https://spiel.example.org', host: 'intern:3000' }, hosts, true));
  assert.ok(isOriginAllowed({ origin: 'https://lan.example:3000', host: 'x' }, hosts, true));
  assert.ok(isOriginAllowed({ origin: 'http://localhost:3210', host: 'localhost:3210' }, new Set(), true));
  assert.ok(isOriginAllowed({ host: 'localhost:3210' }, new Set(), true), 'ohne Origin (kein Browser) erlaubt');
  assert.ok(!isOriginAllowed({ origin: 'https://boese.example', host: 'localhost:3210' }, hosts, true));
  assert.ok(!isOriginAllowed({ origin: 'null', host: 'localhost:3210' }, hosts, true));
  assert.ok(isOriginAllowed({ origin: 'https://a.onrender.com', host: 'intern', 'x-forwarded-host': 'a.onrender.com' }, new Set(), true));
  assert.ok(!isOriginAllowed({ origin: 'https://a.onrender.com', host: 'intern', 'x-forwarded-host': 'a.onrender.com' }, new Set(), false));
});

test('RateLimiter.wouldAllow zählt keinen Treffer', () => {
  const rl = new RateLimiter();
  for (let i = 0; i < 3; i++) assert.ok(rl.wouldAllow('k', 3, 1000, 0));
  rl.allow('k', 3, 1000, 0);
  rl.allow('k', 3, 1000, 0);
  assert.ok(rl.wouldAllow('k', 3, 1000, 0));
  rl.allow('k', 3, 1000, 0);
  assert.ok(!rl.wouldAllow('k', 3, 1000, 0));
  assert.ok(rl.wouldAllow('k', 3, 1000, 1500), 'nach Ablauf des Fensters wieder frei');
});
