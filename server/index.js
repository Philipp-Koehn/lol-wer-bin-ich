'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const champions = require('./champions');
const { Room } = require('./game');
const { RateLimiter } = require('./rate-limit');
const { createStatic, makeEntry, send, REVALIDATE } = require('./static');
const { configuredOrigin, requestOrigin, allowedOriginHosts, isOriginAllowed, escapeHtml } = require('./public-url');

const PORT = Number(process.env.PORT) || 3000;
const TURN_SKIP_MS = Number(process.env.TURN_SKIP_MS) || 20_000; // Zug eines Getrennten Ã¼berspringen
const RECONNECT_WINDOW_MS = Number(process.env.RECONNECT_WINDOW_MS) || 3 * 60_000; // danach entfernt
// Anzahl vertrauenswÃ¼rdiger Proxys vor dem Server (Render/Railway: 1). Bei direktem
// Betrieb ohne Proxy (z. B. im LAN) TRUST_PROXY=0 setzen, sonst ist X-Forwarded-For fÃ¤lschbar.
const TRUST_PROXY = process.env.TRUST_PROXY === undefined ? 1 : Math.max(0, Number(process.env.TRUST_PROXY) || 0);
const IDLE_ROOM_MS = 60 * 60_000;
const MAX_ROOMS = 500;
const MAX_CONNECTIONS = 2000; // gleichzeitige Sockets insgesamt
const MAX_CONNECTIONS_PER_IP = 40; // reicht fÃ¼r eine LAN-Party hinter einer NAT-IP
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const PUBLIC_ORIGIN = configuredOrigin();
const ORIGIN_HOSTS = allowedOriginHosts();

const app = express();
app.disable('x-powered-by');
app.disable('etag'); // ETags setzt server/static.js selbst
app.set('trust proxy', TRUST_PROXY);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: https://ddragon.leagueoflegends.com",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

// Diese Dateien sollen auch fremde Seiten/Dienste einbetten dÃ¼rfen (Link-Vorschau, Icons).
const SHAREABLE = new Set(['/og-image.jpg', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', SHAREABLE.has(req.path) ? 'cross-origin' : 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

const statics = createStatic({
  publicDir: path.join(__dirname, '..', 'public'),
  extra: {
    // Minifizierter Client statt des unminifizierten /socket.io/socket.io.js
    '/vendor/socket.io.min.js': path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist', 'socket.io.min.js'),
  },
  templates: ['/index.html'],
});

// index.html, robots.txt und sitemap.xml enthalten absolute URLs. Mit konfigurierter
// Basis-URL wird jede Datei einmal gerendert, sonst pro Host (Cache mit fester Obergrenze).
const renderCache = new Map();
function rendered(kind, origin, build, type) {
  const key = `${kind} ${origin}`;
  let entry = renderCache.get(key);
  if (!entry) {
    entry = makeEntry(build(origin), type, true, 6);
    if (renderCache.size >= 60) renderCache.delete(renderCache.keys().next().value);
    renderCache.set(key, entry);
  }
  return entry;
}
const originFor = (req) => PUBLIC_ORIGIN || requestOrigin(req);
// Ohne feste Basis-URL hÃ¤ngt die Antwort vom Host ab: nicht in geteilten Caches mischen.
function sendRendered(req, res, entry, cacheControl) {
  if (!PUBLIC_ORIGIN) res.setHeader('Vary', 'Host');
  send(req, res, entry, PUBLIC_ORIGIN ? cacheControl : 'private, no-cache');
}

app.get(['/', '/index.html'], (req, res) => {
  sendRendered(req, res, rendered('index', originFor(req), (o) =>
    statics.render('/index.html', { baseUrl: escapeHtml(o) }), 'text/html; charset=utf-8'), REVALIDATE);
});

app.get('/robots.txt', (req, res) => {
  sendRendered(req, res, rendered('robots', originFor(req), (o) =>
    `User-agent: *\nAllow: /\n\nSitemap: ${o}/sitemap.xml\n`, 'text/plain; charset=utf-8'), 'public, max-age=3600');
});

app.get('/sitemap.xml', (req, res) => {
  sendRendered(req, res, rendered('sitemap', originFor(req), (o) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${escapeHtml(o)}/</loc></url>\n</urlset>\n`,
  'application/xml; charset=utf-8'), 'public, max-age=3600');
});

app.use(statics.middleware);

let championsEntry = null;
app.get('/api/champions', (req, res) => {
  const data = champions.getChampionData();
  if (!data) return res.status(503).json({ error: 'Champion-Daten werden geladen.' });
  if (!championsEntry || championsEntry.data !== data) {
    const body = JSON.stringify({
      version: data.version,
      source: data.source,
      champions: data.champions.map(({ id, name, title, image }) => ({ id, name, title, image })),
    });
    championsEntry = { data, entry: makeEntry(body, 'application/json; charset=utf-8', true, 9) };
  }
  send(req, res, championsEntry.entry, 'public, max-age=600');
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).type('text/plain').send('Nicht gefunden'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).type('text/plain').send('Interner Fehler');
});

const server = http.createServer(app);
server.headersTimeout = 20_000; // langsame Header (Slowloris) nicht ewig offen halten
server.requestTimeout = 30_000;

const io = new Server(server, {
  maxHttpBufferSize: 4096, // Nachrichten sind klein; groÃŸe Payloads werden verworfen
  pingInterval: 10_000,
  pingTimeout: 8_000,
  serveClient: false, // Client kommt minifiziert und komprimiert Ã¼ber /vendor/
  // Cross-Site-WebSocket-Hijacking verhindern: nur Verbindungen von der eigenen Seite.
  allowRequest: (req, callback) => callback(null, isOriginAllowed(req.headers, ORIGIN_HOSTS, TRUST_PROXY > 0)),
});

/** @type {Map<string, {room: Room, sockets: Map<string,string>, timers: Map<string, NodeJS.Timeout[]>}>} */
const rooms = new Map();
const ipLimiter = new RateLimiter();
const connectionsByIp = new Map();
let connectionCount = 0;

function generateCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : '';
}

function getChampionPool() {
  const data = champions.getChampionData();
  return data ? data.champions : [];
}

function broadcast(entry) {
  for (const [playerId, socketId] of entry.sockets) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('state', entry.room.viewFor(playerId));
  }
}

function clearTimers(entry, playerId) {
  const list = entry.timers.get(playerId);
  if (list) list.forEach(clearTimeout);
  entry.timers.delete(playerId);
}

function deleteRoomIfEmpty(code) {
  const entry = rooms.get(code);
  if (entry && entry.room.isEmpty()) {
    for (const list of entry.timers.values()) list.forEach(clearTimeout);
    rooms.delete(code);
  }
}

function attach(socket, entry, player) {
  const previous = entry.sockets.get(player.id);
  if (previous && previous !== socket.id) {
    const old = io.sockets.sockets.get(previous);
    if (old) {
      old.data.playerId = null;
      old.data.roomCode = null;
      old.emit('session:replaced');
      old.disconnect(true);
    }
  }
  clearTimers(entry, player.id);
  entry.sockets.set(player.id, socket.id);
  socket.data.roomCode = entry.room.code;
  socket.data.playerId = player.id;
  socket.join(entry.room.code);
}

function session(entry, player) {
  return { ok: true, code: entry.room.code, playerId: player.id, token: player.token, name: player.name };
}

// Validiert Payload-Form, bevor die Spiellogik sie sieht.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Hinter n vertrauenswÃ¼rdigen Proxys (TRUST_PROXY = n) steht der echte Client an n-letzter
// Stelle von x-forwarded-for; weiter vorne stehende EintrÃ¤ge kann der Client fÃ¤lschen.
// Ohne Proxy (TRUST_PROXY = 0) wird der Header ignoriert.
function clientIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (TRUST_PROXY > 0 && typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const candidate = parts[parts.length - TRUST_PROXY];
    if (candidate) return candidate;
  }
  return socket.handshake.address || 'unknown';
}

// Ressourcen begrenzen: Sockets insgesamt, pro IP und neue Verbindungen pro Minute.
io.use((socket, next) => {
  const ip = clientIp(socket);
  if (connectionCount >= MAX_CONNECTIONS) return next(new Error('Der Server ist gerade voll.'));
  if ((connectionsByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return next(new Error('Zu viele Verbindungen von dieser Adresse.'));
  if (!ipLimiter.allow(`conn:${ip}`, 60, 60_000)) return next(new Error('Zu viele Verbindungsversuche.'));
  next();
});

io.on('connection', (socket) => {
  const limiter = new RateLimiter();
  const ip = clientIp(socket);
  let violations = 0;
  connectionCount += 1;
  connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);
  socket.once('disconnect', () => {
    connectionCount -= 1;
    const n = (connectionsByIp.get(ip) || 1) - 1;
    if (n > 0) connectionsByIp.set(ip, n);
    else connectionsByIp.delete(ip);
  });

  // Wrapper: Rate Limit, Payload-PrÃ¼fung, Ack immer genau einmal, Fehler nie nach auÃŸen.
  function on(event, bucket, handler) {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const rule = RATE_RULES[bucket];
      if (!limiter.allow(bucket, rule.max, rule.windowMs)) {
        violations += 1;
        if (violations > 50) socket.disconnect(true);
        return reply({ ok: false, error: 'Zu viele Aktionen. Bitte kurz warten.' });
      }
      // Ein fehlendes Argument kommt nach der Serialisierung als null an.
      if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
        return reply({ ok: false, error: 'UngÃ¼ltige Anfrage.' });
      }
      try {
        reply(handler(payload || {}) || { ok: true });
      } catch (err) {
        console.error(`[socket] ${event}:`, err);
        reply({ ok: false, error: 'Interner Fehler.' });
      }
    });
  }

  function currentEntry() {
    const entry = socket.data.roomCode ? rooms.get(socket.data.roomCode) : null;
    if (!entry || !socket.data.playerId || !entry.room.players.has(socket.data.playerId)) return null;
    return entry;
  }

  // FÃ¼hrt eine Raum-Aktion aus und verteilt danach den neuen Zustand.
  function roomAction(fn) {
    const entry = currentEntry();
    if (!entry) return { ok: false, error: 'Du bist in keinem Raum.' };
    const result = fn(entry.room, socket.data.playerId);
    if (result.ok) broadcast(entry);
    return result;
  }

  on('room:create', 'join', ({ name }) => {
    if (socket.data.playerId) return { ok: false, error: 'Du bist bereits in einem Raum.' };
    if (!ipLimiter.allow(`create:${ip}`, 10, 10 * 60_000)) {
      return { ok: false, error: 'Zu viele neue RÃ¤ume. Bitte spÃ¤ter erneut versuchen.' };
    }
    if (rooms.size >= MAX_ROOMS) return { ok: false, error: 'Der Server ist gerade voll.' };
    const code = generateCode();
    if (!code) return { ok: false, error: 'Kein Raumcode frei. Bitte erneut versuchen.' };
    const room = new Room(code, { getChampions: getChampionPool });
    const res = room.addPlayer(name);
    if (!res.ok) return res;
    const entry = { room, sockets: new Map(), timers: new Map() };
    rooms.set(code, entry);
    attach(socket, entry, res.player);
    broadcast(entry);
    return session(entry, res.player);
  });

  on('room:join', 'join', ({ code, name }) => {
    if (socket.data.playerId) return { ok: false, error: 'Du bist bereits in einem Raum.' };
    // Gegen das Durchprobieren von Raumcodes: Fehlversuche pro IP begrenzen.
    const failKey = `joinfail:${ip}`;
    if (!ipLimiter.wouldAllow(failKey, 20, 10 * 60_000)) {
      return { ok: false, error: 'Zu viele falsche Raumcodes. Bitte spÃ¤ter erneut versuchen.' };
    }
    const entry = rooms.get(normalizeCode(code));
    if (!entry) {
      ipLimiter.allow(failKey, 20, 10 * 60_000);
      return { ok: false, error: 'Diesen Raum gibt es nicht. PrÃ¼fe den Code.' };
    }
    const res = entry.room.addPlayer(name);
    if (!res.ok) return res;
    attach(socket, entry, res.player);
    broadcast(entry);
    return session(entry, res.player);
  });

  on('room:resume', 'join', ({ code, playerId, token }) => {
    const entry = rooms.get(normalizeCode(code));
    if (!entry || typeof playerId !== 'string') return { ok: false, error: 'Sitzung abgelaufen.' };
    const player = entry.room.verifyToken(playerId, token);
    if (!player) return { ok: false, error: 'Sitzung abgelaufen.' };
    attach(socket, entry, player);
    entry.room.setConnected(player.id, true);
    broadcast(entry);
    return session(entry, player);
  });

  on('room:leave', 'join', () => {
    const entry = currentEntry();
    if (!entry) return { ok: true };
    const { playerId } = socket.data;
    clearTimers(entry, playerId);
    entry.sockets.delete(playerId);
    entry.room.removePlayer(playerId, 'left');
    socket.leave(entry.room.code);
    socket.data.playerId = null;
    socket.data.roomCode = null;
    broadcast(entry);
    deleteRoomIfEmpty(entry.room.code);
    return { ok: true };
  });

  on('game:start', 'action', () => roomAction((room, pid) => room.startRound(pid)));
  on('game:restart', 'action', () => roomAction((room, pid) => room.restartRound(pid)));
  on('turn:ask', 'ask', ({ text }) => roomAction((room, pid) => room.ask(pid, text)));
  on('turn:answer', 'action', ({ questionId, answer }) =>
    roomAction((room, pid) => room.answer(pid, Number.isInteger(questionId) ? questionId : -1, answer))
  );
  on('turn:guess', 'action', ({ championId }) =>
    roomAction((room, pid) => room.guess(pid, typeof championId === 'string' ? championId.slice(0, 40) : ''))
  );
  on('turn:pass', 'action', () => roomAction((room, pid) => room.pass(pid)));
  on('chat:send', 'chat', ({ text }) => roomAction((room, pid) => room.chat(pid, text)));

  socket.on('disconnect', () => {
    const entry = currentEntry();
    if (!entry) return;
    const { playerId } = socket.data;
    if (entry.sockets.get(playerId) !== socket.id) return;
    entry.sockets.delete(playerId);
    entry.room.setConnected(playerId, false);
    broadcast(entry);

    const code = entry.room.code;
    const skip = setTimeout(() => {
      const e = rooms.get(code);
      if (!e) return;
      e.room.handleDisconnectTimeout(playerId);
      broadcast(e);
    }, TURN_SKIP_MS);
    const remove = setTimeout(() => {
      const e = rooms.get(code);
      if (!e) return;
      const p = e.room.players.get(playerId);
      if (p && !p.connected) {
        e.room.removePlayer(playerId, 'timeout');
        e.timers.delete(playerId);
        broadcast(e);
        deleteRoomIfEmpty(code);
      }
    }, RECONNECT_WINDOW_MS);
    entry.timers.set(playerId, [skip, remove]);
  });
});

const RATE_RULES = {
  join: { max: 10, windowMs: 60_000 },
  action: { max: 20, windowMs: 10_000 },
  ask: { max: 6, windowMs: 10_000 },
  chat: { max: 6, windowMs: 10_000 },
};

// Verwaiste RÃ¤ume aufrÃ¤umen.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    if (!entry.room.hasConnectedPlayers() && now - entry.room.lastActivity > IDLE_ROOM_MS) {
      for (const list of entry.timers.values()) list.forEach(clearTimeout);
      rooms.delete(code);
    }
  }
  ipLimiter.prune();
}, 5 * 60_000).unref();

champions
  .init()
  .catch((err) => {
    console.error('[champions] Start ohne Champion-Daten:', err.message);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`LoL - Wer bin ich? lÃ¤uft auf http://localhost:${PORT}`);
      console.log(PUBLIC_ORIGIN
        ? `[site] Ã–ffentliche Basis-URL: ${PUBLIC_ORIGIN}`
        : '[site] Keine PUBLIC_URL gesetzt: Link-Vorschau nutzt den Host der jeweiligen Anfrage.');
    });
  });
