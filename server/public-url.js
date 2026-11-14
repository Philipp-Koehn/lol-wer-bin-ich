'use strict';

// Öffentliche Basis-URL (für Open-Graph-Bild, Canonical, Sitemap). Reihenfolge:
// PUBLIC_URL, dann was Render bzw. Railway automatisch setzen, sonst aus der Anfrage.

function normalizeOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Basis-URL aus der Umgebung oder null. */
function configuredOrigin(env = process.env) {
  const candidates = [
    env.PUBLIC_URL,
    env.RENDER_EXTERNAL_URL,
    env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '',
  ];
  for (const c of candidates) {
    const origin = normalizeOrigin(c);
    if (origin) return origin;
  }
  return null;
}

// Nur einfache Hostnamen/IPv4 mit optionalem Port; alles andere (z. B. manipulierte
// Host-Header mit Sonderzeichen) fällt auf localhost zurück.
const HOST_RE = /^(?:[a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}(?::\d{1,5})?$/i;

/** Basis-URL aus einer Express-Anfrage (Fallback, wenn nichts konfiguriert ist). */
function requestOrigin(req) {
  const host = req.get('host') || '';
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return HOST_RE.test(host) ? `${proto}://${host.toLowerCase()}` : 'http://localhost';
}

/** Hosts (host[:port]), von denen Browser eine Socket-Verbindung öffnen dürfen. */
function allowedOriginHosts(env = process.env) {
  const hosts = new Set();
  const configured = configuredOrigin(env);
  if (configured) hosts.add(new URL(configured).host);
  for (const raw of String(env.ALLOWED_ORIGINS || '').split(',')) {
    const origin = normalizeOrigin(raw);
    if (origin) hosts.add(new URL(origin).host);
  }
  return hosts;
}

/**
 * Prüft den Origin-Header eines Socket.IO-Handshakes. Browser senden ihn immer; er
 * muss zur eigenen Seite passen (gleicher Host wie die Anfrage oder ausdrücklich erlaubt).
 * Ohne Origin (Nicht-Browser-Clients) wird erlaubt: dort schützt der Origin-Check
 * ohnehin nicht, dafür greifen die Verbindungs- und Rate-Limits.
 */
function isOriginAllowed(headers, allowedHosts, trustProxy) {
  const origin = headers.origin;
  if (origin === undefined) return true;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (allowedHosts.has(host)) return true;
  const reqHost = String(headers.host || '').toLowerCase();
  if (reqHost && host === reqHost) return true;
  if (trustProxy) {
    const fwd = String(headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
    if (fwd && host === fwd) return true;
  }
  return false;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

module.exports = { configuredOrigin, requestOrigin, allowedOriginHosts, isOriginAllowed, normalizeOrigin, escapeHtml };
