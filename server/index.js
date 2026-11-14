'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const champions = require('./champions');
const { Room } = require('./game');
const { RateLimiter } = require('./rate-limit');

const PORT = Number(process.env.PORT) || 3000;
const TURN_SKIP_MS = Number(process.env.TURN_SKIP_MS) || 20_000; // Zug eines Getrennten überspringen
const RECONNECT_WINDOW_MS = Number(process.env.RECONNECT_WINDOW_MS) || 3 * 60_000; // danach entfernt
const IDLE_ROOM_MS = 60 * 60_000;
const MAX_ROOMS = 500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render/Railway sitzen hinter einem Proxy

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://ddragon.leagueoflegends.com",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));

app.get('/api/champions', (req, res) => {
  const data = champions.getChampionData();
  if (!data) return res.status(503).json({ error: 'Champion-Daten werden geladen.' });
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json({
    version: data.version,
    source: data.source,
    champions: data.champions.map(({ id, name, title, image }) => ({ id, name, title, image })),
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.use((req, res) => res.status(404).send('Nicht gefunden'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).send('Interner Fehler');
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 4096, // Nachrichten sind klein; große Payloads werden verworfen
  pingInterval: 10_000,
  pingTimeout: 8_000,
  serveClient: true,
});

/** @type {Map<string, {room: Room, sockets: Map<string,string>, timers: Map<string, NodeJS.Timeout[]>}>} */
const rooms = new Map();
const ipLimiter = new RateLimiter();

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

io.on('connection', (socket) => {
  const limiter = new RateLimiter();
  const ip = socket.handshake.address || 'unknown';
  let violations = 0;

  // Wrapper: Rate Limit, Payload-Prüfung, Ack immer genau einmal, Fehler nie nach außen.
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
        return reply({ ok: false, error: 'Ungültige Anfrage.' });
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

  // Führt eine Raum-Aktion aus und verteilt danach den neuen Zustand.
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
      return { ok: false, error: 'Zu viele neue Räume. Bitte später erneut versuchen.' };
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
    const entry = rooms.get(normalizeCode(code));
    if (!entry) return { ok: false, error: 'Diesen Raum gibt es nicht. Prüfe den Code.' };
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

// Verwaiste Räume aufräumen.
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
    server.listen(PORT, () => console.log(`LoL - Wer bin ich? läuft auf http://localhost:${PORT}`));
  });
