'use strict';

// Reine Spiellogik eines Raums. Keine Sockets, keine Timer: der Aufrufer
// (server/index.js) kümmert sich um Netzwerk und Zeitsteuerung. Jede Methode
// liefert { ok: true } oder { ok: false, error } und verändert den Zustand.

const crypto = require('crypto');

const LIMITS = Object.freeze({
  NAME_MAX: 20,
  QUESTION_MIN: 3,
  QUESTION_MAX: 140,
  CHAT_MAX: 200,
  MAX_PLAYERS: 10,
  MIN_PLAYERS: 2,
  HISTORY_MAX: 200,
});

const SCORING = Object.freeze({ BASE: 100, PER_QUESTION: 5, PER_WRONG_GUESS: 10, MIN: 10 });

const RULES_TEXT = Object.freeze({
  answers: 'Alle verbundenen Mitspieler antworten. Die Mehrheit entscheidet, bei Gleichstand zählt Nein.',
  turn: 'Bei Ja fragst du weiter. Bei Nein oder falschem Tipp ist der Nächste dran.',
  scoring: `Punkte beim Erraten: ${SCORING.BASE} − ${SCORING.PER_QUESTION} pro Frage − ${SCORING.PER_WRONG_GUESS} pro Fehltipp (mindestens ${SCORING.MIN}). Wer zuletzt übrig bleibt, bekommt 0.`,
});

function computePoints(questions, wrongGuesses) {
  return Math.max(
    SCORING.MIN,
    SCORING.BASE - SCORING.PER_QUESTION * questions - SCORING.PER_WRONG_GUESS * wrongGuesses
  );
}

// Steuerzeichen, unsichtbare Zeichen und Bidi-Overrides (gegen Spoofing im Verlauf).
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g;

// Entfernt Steuerzeichen, normalisiert Unicode und Leerraum.
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const fail = (error) => ({ ok: false, error });
const OK = Object.freeze({ ok: true });

class Room {
  /**
   * @param {string} code
   * @param {{ getChampions: () => Array<{id:string,name:string,title:string,image:string}>, now?: () => number, randomInt?: (max:number) => number }} deps
   */
  constructor(code, deps) {
    this.code = code;
    this.getChampions = deps.getChampions;
    this.now = deps.now || Date.now;
    this.randomInt = deps.randomInt || ((max) => crypto.randomInt(max));
    this.players = new Map();
    this.order = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.roundNumber = 0;
    this.startOffset = 0;
    this.solvedCount = 0;
    this.turn = { currentId: null, question: null };
    this.history = [];
    this.seq = 0;
    this.lastActivity = this.now();
  }

  // ---------- Spieler ----------

  addPlayer(rawName) {
    const name = cleanText(rawName, LIMITS.NAME_MAX);
    if (!name) return fail('Bitte gib einen Namen ein.');
    if (this.players.size >= LIMITS.MAX_PLAYERS) return fail(`Der Raum ist voll (max. ${LIMITS.MAX_PLAYERS}).`);
    const lower = name.toLocaleLowerCase('de');
    for (const p of this.players.values()) {
      if (p.name.toLocaleLowerCase('de') === lower) return fail('Dieser Name ist im Raum schon vergeben.');
    }
    const player = {
      id: crypto.randomBytes(8).toString('hex'),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      connected: true,
      totalScore: 0,
      round: this.emptyRound(false),
    };
    this.players.set(player.id, player);
    this.order.push(player.id);
    if (!this.hostId) this.hostId = player.id;
    this.log('system', { text: `${name} ist dem Raum beigetreten.` });
    this.touch();
    return { ok: true, player };
  }

  emptyRound(playing) {
    return { playing, championId: null, solved: false, placement: null, questions: 0, wrongGuesses: 0, points: 0 };
  }

  verifyToken(playerId, token) {
    const p = this.players.get(playerId);
    if (!p || typeof token !== 'string') return null;
    const a = Buffer.from(p.token);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return p;
  }

  setConnected(playerId, connected) {
    const p = this.players.get(playerId);
    if (!p || p.connected === connected) return OK;
    p.connected = connected;
    this.log('system', { text: connected ? `${p.name} ist wieder da.` : `${p.name} hat die Verbindung verloren.` });
    if (this.phase === 'playing') {
      if (connected && !this.turn.currentId && this.isCandidate(p)) this.turn.currentId = p.id;
      if (!connected) this.resolveIfComplete();
    }
    this.touch();
    return OK;
  }

  // Wird vom Server aufgerufen, wenn ein Spieler zu lange getrennt ist.
  handleDisconnectTimeout(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.connected) return OK;
    if (this.phase === 'playing' && this.turn.currentId === p.id) {
      this.withdrawQuestion('abgebrochen');
      this.log('system', { text: `${p.name} ist nicht erreichbar, der Zug geht weiter.` });
      this.advanceTurn();
    }
    if (this.hostId === p.id) this.reassignHost();
    return OK;
  }

  removePlayer(playerId, reason = 'left') {
    const p = this.players.get(playerId);
    if (!p) return OK;
    const wasCurrent = this.turn.currentId === p.id;
    const oldIndex = this.order.indexOf(playerId);
    this.players.delete(playerId);
    this.order = this.order.filter((id) => id !== playerId);
    this.log('system', {
      text: reason === 'timeout' ? `${p.name} wurde nach zu langer Abwesenheit entfernt.` : `${p.name} hat den Raum verlassen.`,
    });
    if (this.hostId === playerId) this.reassignHost();
    if (this.phase === 'playing') {
      const q = this.turn.question;
      if (q && q.askerId === playerId) this.withdrawQuestion('abgebrochen');
      if (this.checkRoundEnd()) return OK;
      if (wasCurrent) this.turn.currentId = this.nextCandidateFromIndex(oldIndex);
      this.resolveIfComplete();
    }
    this.touch();
    return OK;
  }

  reassignHost() {
    const ids = this.order.filter((id) => this.players.has(id));
    const next = ids.find((id) => this.players.get(id).connected) || ids[0] || null;
    if (next && next !== this.hostId) {
      this.hostId = next;
      this.log('system', { text: `${this.players.get(next).name} ist jetzt Host.` });
    } else if (!next) {
      this.hostId = null;
    }
  }

  isEmpty() {
    return this.players.size === 0;
  }

  hasConnectedPlayers() {
    for (const p of this.players.values()) if (p.connected) return true;
    return false;
  }

  // ---------- Runden ----------

  startRound(byId) {
    if (byId !== this.hostId) return fail('Nur der Host kann die Runde starten.');
    if (this.phase === 'playing') return fail('Es läuft bereits eine Runde.');
    return this.beginRound();
  }

  restartRound(byId) {
    if (byId !== this.hostId) return fail('Nur der Host kann neu starten.');
    if (this.phase !== 'playing') return fail('Es läuft keine Runde.');
    this.log('system', { text: `Runde ${this.roundNumber} wurde vom Host abgebrochen. Punkte dieser Runde verfallen.` });
    for (const p of this.players.values()) p.round = this.emptyRound(false);
    return this.beginRound();
  }

  beginRound() {
    const participants = this.order.map((id) => this.players.get(id)).filter((p) => p.connected);
    if (participants.length < LIMITS.MIN_PLAYERS) {
      return fail(`Mindestens ${LIMITS.MIN_PLAYERS} verbundene Spieler nötig.`);
    }
    const pool = this.getChampions();
    if (!pool || pool.length < participants.length) return fail('Champion-Daten fehlen.');

    // Zufällige, verschiedene Champions (Fisher-Yates mit kryptografischem Zufall).
    const ids = pool.map((c) => c.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = this.randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (const p of this.players.values()) p.round = this.emptyRound(false);
    participants.forEach((p, i) => {
      p.round = this.emptyRound(true);
      p.round.championId = ids[i];
    });

    this.phase = 'playing';
    this.roundNumber += 1;
    this.solvedCount = 0;
    this.turn = { currentId: null, question: null };
    const starter = participants[this.startOffset % participants.length];
    this.startOffset += 1;
    this.turn.currentId = starter.id;
    this.log('system', { text: `Runde ${this.roundNumber} beginnt. ${starter.name} fängt an.` });
    this.touch();
    return OK;
  }

  checkRoundEnd() {
    if (this.phase !== 'playing') return false;
    const unsolved = this.order.map((id) => this.players.get(id)).filter((p) => p.round.playing && !p.round.solved);
    if (unsolved.length > 1) return false;
    this.endRound(unsolved);
    return true;
  }

  endRound(unsolved) {
    for (const p of unsolved) {
      this.solvedCount += 1;
      p.round.placement = this.solvedCount;
      p.round.points = 0;
    }
    for (const p of this.players.values()) {
      p.totalScore += p.round.points;
    }
    this.withdrawQuestion('abgebrochen');
    this.turn.currentId = null;
    this.phase = 'roundEnd';
    const last = unsolved[0];
    const lastText = last ? ` ${last.name} war ${this.championName(last.round.championId)}.` : '';
    this.log('system', { text: `Runde ${this.roundNumber} ist vorbei.${lastText}` });
  }

  // ---------- Züge ----------

  isCandidate(p) {
    return p && p.connected && p.round.playing && !p.round.solved;
  }

  // Prüft order[startIdx], order[startIdx+1], ... (zyklisch) auf den nächsten Kandidaten.
  nextCandidateFromIndex(startIdx) {
    const len = this.order.length;
    for (let step = 0; step < len; step++) {
      const p = this.players.get(this.order[(startIdx + step) % len]);
      if (this.isCandidate(p)) return p.id;
    }
    return null;
  }

  nextCandidateAfter(fromId) {
    return this.nextCandidateFromIndex(this.order.indexOf(fromId) + 1);
  }

  advanceTurn() {
    this.turn.question = null;
    this.turn.currentId = this.nextCandidateAfter(this.turn.currentId);
  }

  requireCurrent(byId) {
    if (this.phase !== 'playing') return fail('Es läuft keine Runde.');
    if (this.turn.currentId !== byId) return fail('Du bist gerade nicht am Zug.');
    return null;
  }

  // Wer muss antworten? Alle verbundenen Spieler außer dem Fragenden.
  eligibleAnswerers(askerId) {
    return [...this.players.values()].filter((p) => p.connected && p.id !== askerId);
  }

  ask(byId, rawText) {
    const err = this.requireCurrent(byId);
    if (err) return err;
    if (this.turn.question) return fail('Warte, bis alle geantwortet haben.');
    const text = cleanText(rawText, LIMITS.QUESTION_MAX);
    if (text.length < LIMITS.QUESTION_MIN) return fail('Die Frage ist zu kurz.');
    if (this.eligibleAnswerers(byId).length === 0) return fail('Gerade ist niemand da, der antworten kann.');
    const p = this.players.get(byId);
    p.round.questions += 1;
    const entry = this.log('question', { askerId: p.id, askerName: p.name, text, status: 'pending', answers: [] });
    this.turn.question = { entryId: entry.id, askerId: p.id, answers: new Map() };
    this.touch();
    return OK;
  }

  answer(byId, questionId, value) {
    if (this.phase !== 'playing') return fail('Es läuft keine Runde.');
    const q = this.turn.question;
    if (!q || q.entryId !== questionId) return fail('Diese Frage ist nicht mehr offen.');
    if (value !== 'yes' && value !== 'no') return fail('Ungültige Antwort.');
    if (byId === q.askerId) return fail('Du kannst deine eigene Frage nicht beantworten.');
    const p = this.players.get(byId);
    if (!p || !p.connected) return fail('Unbekannter Spieler.');
    if (q.answers.has(byId)) return fail('Du hast schon geantwortet.');
    q.answers.set(byId, value);
    this.resolveIfComplete();
    this.touch();
    return OK;
  }

  resolveIfComplete() {
    const q = this.turn.question;
    if (!q || this.phase !== 'playing') return;
    const required = this.eligibleAnswerers(q.askerId);
    if (required.length === 0) return; // warten, bis jemand (wieder) da ist
    if (!required.every((p) => q.answers.has(p.id))) return;

    let yes = 0;
    let no = 0;
    const answers = [];
    for (const [pid, value] of q.answers) {
      const p = this.players.get(pid);
      if (!p) continue;
      if (value === 'yes') yes += 1;
      else no += 1;
      answers.push({ playerId: pid, name: p.name, answer: value });
    }
    const result = yes > no ? 'yes' : 'no';
    const entry = this.history.find((h) => h.id === q.entryId);
    if (entry) {
      entry.status = result;
      entry.answers = answers;
      entry.yes = yes;
      entry.no = no;
    }
    this.turn.question = null;
    if (result === 'no') this.advanceTurn();
  }

  withdrawQuestion(status) {
    const q = this.turn.question;
    if (!q) return;
    const entry = this.history.find((h) => h.id === q.entryId);
    if (entry) entry.status = status;
    this.turn.question = null;
  }

  guess(byId, championId) {
    const err = this.requireCurrent(byId);
    if (err) return err;
    const champ = this.getChampions().find((c) => c.id === championId);
    if (!champ) return fail('Unbekannter Champion.');
    const p = this.players.get(byId);
    this.withdrawQuestion('zurückgezogen');
    const correct = p.round.championId === champ.id;
    this.log('guess', { playerId: p.id, name: p.name, championId: champ.id, championName: champ.name, correct });
    if (correct) {
      this.solvedCount += 1;
      p.round.solved = true;
      p.round.placement = this.solvedCount;
      p.round.points = computePoints(p.round.questions, p.round.wrongGuesses);
      if (!this.checkRoundEnd()) this.advanceTurn();
    } else {
      p.round.wrongGuesses += 1;
      this.advanceTurn();
    }
    this.touch();
    return { ok: true, correct };
  }

  pass(byId) {
    const err = this.requireCurrent(byId);
    if (err) return err;
    if (this.turn.question) return fail('Warte, bis alle geantwortet haben.');
    const p = this.players.get(byId);
    this.log('system', { text: `${p.name} gibt den Zug weiter.` });
    this.advanceTurn();
    this.touch();
    return OK;
  }

  chat(byId, rawText) {
    const p = this.players.get(byId);
    if (!p) return fail('Unbekannter Spieler.');
    const text = cleanText(rawText, LIMITS.CHAT_MAX);
    if (!text) return fail('Die Nachricht ist leer.');
    this.log('chat', { playerId: p.id, name: p.name, text });
    this.touch();
    return OK;
  }

  // ---------- Hilfen ----------

  log(type, data) {
    const entry = { id: ++this.seq, type, ts: this.now(), ...data };
    this.history.push(entry);
    if (this.history.length > LIMITS.HISTORY_MAX) this.history.splice(0, this.history.length - LIMITS.HISTORY_MAX);
    return entry;
  }

  touch() {
    this.lastActivity = this.now();
  }

  championName(id) {
    const c = this.getChampions().find((x) => x.id === id);
    return c ? c.name : '?';
  }

  // ---------- Sicht eines Spielers ----------
  // Zentrale Stelle gegen Leaks: Der eigene Champion wird nur geliefert, wenn er
  // erraten wurde oder die Runde vorbei ist.
  canSeeChampion(viewerId, p) {
    if (!p.round.championId || this.phase === 'lobby') return false;
    return p.id !== viewerId || p.round.solved || this.phase === 'roundEnd';
  }

  viewFor(viewerId) {
    const champs = this.getChampions();
    const champView = (id) => {
      const c = champs.find((x) => x.id === id);
      return c ? { id: c.id, name: c.name, title: c.title, image: c.image } : null;
    };
    const q = this.turn.question;
    const players = this.order.map((id) => {
      const p = this.players.get(id);
      return {
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.id === this.hostId,
        isYou: p.id === viewerId,
        playing: p.round.playing,
        solved: p.round.solved,
        placement: p.round.placement,
        questions: p.round.questions,
        wrongGuesses: p.round.wrongGuesses,
        roundPoints: p.round.points,
        totalScore: p.totalScore + (this.phase === 'playing' ? p.round.points : 0),
        champion: this.canSeeChampion(viewerId, p) ? champView(p.round.championId) : null,
      };
    });

    const history = this.history.slice(-150).map((h) => {
      if (h.type !== 'question' || h.status !== 'pending') return { ...h };
      const answeredIds = q && q.entryId === h.id ? [...q.answers.keys()] : [];
      return { ...h, answers: [], answeredIds };
    });

    let question = null;
    if (q) {
      const required = this.eligibleAnswerers(q.askerId).map((p) => p.id);
      question = {
        id: q.entryId,
        askerId: q.askerId,
        text: (this.history.find((h) => h.id === q.entryId) || {}).text || '',
        required,
        answeredIds: [...q.answers.keys()],
        yourAnswer: q.answers.get(viewerId) || null,
      };
    }

    return {
      code: this.code,
      phase: this.phase,
      roundNumber: this.roundNumber,
      hostId: this.hostId,
      youId: viewerId,
      players,
      turn: { currentId: this.turn.currentId, question },
      history,
      rules: RULES_TEXT,
      limits: { questionMax: LIMITS.QUESTION_MAX, chatMax: LIMITS.CHAT_MAX, minPlayers: LIMITS.MIN_PLAYERS },
    };
  }
}

module.exports = { Room, LIMITS, SCORING, RULES_TEXT, computePoints, cleanText };
