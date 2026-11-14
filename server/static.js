'use strict';

// Statische Dateien aus dem Speicher: beim Start einmal gelesen, gehasht und mit
// Brotli/Gzip vorkomprimiert. Es gibt nur eine feste Liste von Dateien, keinen
// Dateisystemzugriff pro Anfrage (kein Path-Traversal, keine I/O-Last).
//
// Caching: Verweise in index.html tragen ?v=<hash>. Mit passendem Hash darf der
// Browser die Datei ein Jahr lang ungefragt behalten (immutable); ohne Hash wird per
// ETag revalidiert. index.html selbst wird immer revalidiert, damit Deploys sofort greifen.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.txt', '.xml']);
const MIN_COMPRESS_BYTES = 512;
const LONG_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, no-cache';

const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('base64url');

/**
 * Erzeugt einen auslieferbaren Eintrag (Rohdaten plus komprimierte Varianten).
 * quality: Brotli-Stufe. 11 (Maximum) für Dateien, die einmal beim Start gepackt werden;
 * zur Laufzeit erzeugte Antworten nutzen eine schnellere Stufe.
 */
function makeEntry(body, type, compressible = true, quality = 11) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const hash = hashOf(buf);
  const entry = { type, raw: buf, hash: hash.slice(0, 10), etag: `"${hash.slice(0, 22)}"`, br: null, gzip: null };
  if (compressible && buf.length >= MIN_COMPRESS_BYTES) {
    entry.br = zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    });
    entry.gzip = zlib.gzipSync(buf, { level: quality >= 11 ? 9 : 6 });
  }
  return entry;
}

function pickEncoding(req, entry) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (entry.br && /\bbr\b/.test(accept)) return 'br';
  if (entry.gzip && /\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function etagMatches(req, etag) {
  const inm = req.headers['if-none-match'];
  if (typeof inm !== 'string') return false;
  return inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

/** Sendet einen Eintrag mit Content-Negotiation, ETag und 304-Unterstützung. */
function send(req, res, entry, cacheControl) {
  res.setHeader('Content-Type', entry.type);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', entry.etag);
  if (entry.br || entry.gzip) {
    const vary = res.getHeader('Vary');
    res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  }
  if (etagMatches(req, entry.etag)) {
    res.statusCode = 304;
    return res.end();
  }
  const encoding = pickEncoding(req, entry);
  const body = encoding ? entry[encoding] : entry.raw;
  if (encoding) res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', body.length);
  res.statusCode = 200;
  return res.end(req.method === 'HEAD' ? undefined : body);
}

function walk(dir, base = dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(full, base));
    else if (d.isFile()) out.push(full);
  }
  return out;
}

/**
 * @param {{ publicDir: string, extra?: Record<string, string>, templates?: string[] }} opts
 *   extra: zusätzliche URL-Pfade -> Datei (z. B. der Socket.IO-Client aus node_modules)
 *   templates: URL-Pfade, die nicht direkt, sondern über render() ausgeliefert werden
 */
function createStatic({ publicDir, extra = {}, templates = [] }) {
  const files = new Map(); // URL-Pfad -> Eintrag
  const sources = new Map(); // URL-Pfad -> Text (für Templates)
  const add = (urlPath, file) => {
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext];
    if (!type) return;
    let body = fs.readFileSync(file);
    // Source-Map-Verweise entfernen: die .map-Dateien werden nicht ausgeliefert.
    if (ext === '.js') body = Buffer.from(body.toString('utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'));
    if (templates.includes(urlPath)) sources.set(urlPath, body.toString('utf8'));
    else files.set(urlPath, makeEntry(body, type, COMPRESSIBLE.has(ext)));
  };
  for (const file of walk(publicDir)) {
    add(`/${path.relative(publicDir, file).split(path.sep).join('/')}`, file);
  }
  for (const [urlPath, file] of Object.entries(extra)) add(urlPath, file);

  // Ersetzt {{asset:/pfad}} durch /pfad?v=<hash> und weitere {{schlüssel}} durch Werte.
  function render(urlPath, vars) {
    const src = sources.get(urlPath);
    if (src === undefined) throw new Error(`Unbekanntes Template ${urlPath}`);
    return src.replace(/\{\{([a-zA-Z]+)(?::([^}]+))?\}\}/g, (m, key, arg) => {
      if (key === 'asset') {
        const entry = files.get(arg);
        if (!entry) throw new Error(`Template verweist auf fehlende Datei ${arg}`);
        return `${arg}?v=${entry.hash}`;
      }
      if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
      throw new Error(`Template-Variable ${key} fehlt`);
    });
  }

  function middleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const entry = files.get(req.path);
    if (!entry) return next();
    return send(req, res, entry, cacheControlFor(req, entry));
  }

  return { middleware, render, files };
}

// Schriften ändern sich nie (bei einer neuen Version: neuer Dateiname), Bilder selten.
function cacheControlFor(req, entry) {
  if (typeof req.query.v === 'string' && req.query.v === entry.hash) return LONG_CACHE;
  if (req.path.startsWith('/fonts/') && req.path.endsWith('.woff2')) return LONG_CACHE;
  if (/^image\/(png|jpeg|x-icon)$/.test(entry.type)) return 'public, max-age=86400';
  return REVALIDATE;
}

module.exports = { createStatic, makeEntry, send, REVALIDATE, LONG_CACHE };
