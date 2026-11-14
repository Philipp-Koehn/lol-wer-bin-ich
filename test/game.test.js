'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, computePoints, cleanText } = require('../server/game');

const CHAMPS = ['Ahri', 'Garen', 'Lux', 'Jinx', 'Thresh', 'Yasuo'].map((id) => ({
  id,
  name: id,
  title: '',
  image: `https://example.invalid/${id}.png`,
}));

// randomInt(max) => 0 lässt das Mischen deterministisch werden.
function makeRoom() {
  return new Room('TEST1', { getChampions: () => CHAMPS, randomInt: () => 0 });
}

function setup(n = 3) {
  const room = makeRoom();
  const players = [];
  for (let i = 0; i < n; i++) players.push(room.addPlayer(`P${i + 1}`).player);
  return { room, players };
}

function containsValue(obj, needle) {
  if (obj === needle) return true;
  if (obj && typeof obj === 'object') return Object.values(obj).some((v) => containsValue(v, needle));
  return false;
}

test('erster Spieler wird Host, doppelte Namen werden abgelehnt', () => {
  const { room, players } = setup(2);
  assert.equal(room.hostId, players[0].id);
  assert.equal(room.addPlayer('p1').ok, false);
  assert.equal(room.addPlayer('   ').ok, false);
});

test('nur der Host startet, mindestens zwei Spieler', () => {
  const room = makeRoom();
  const a = room.addPlayer('A').player;
  assert.equal(room.startRound(a.id).ok, false);
  const b = room.addPlayer('B').player;
  assert.equal(room.startRound(b.id).ok, false);
  assert.equal(room.startRound(a.id).ok, true);
  assert.equal(room.phase, 'playing');
});

test('jeder bekommt einen anderen Champion, der eigene ist in der eigenen Sicht unsichtbar', () => {
  const { room, players } = setup(3);
  room.startRound(players[0].id);
  const assigned = players.map((p) => room.players.get(p.id).round.championId);
  assert.equal(new Set(assigned).size, 3);
  for (const p of players) {
    const view = room.viewFor(p.id);
    const own = room.players.get(p.id).round.championId;
    assert.equal(containsValue(view, own), false, `${p.name} sieht seinen eigenen Champion`);
    const others = view.players.filter((x) => !x.isYou);
    assert.ok(others.every((x) => x.champion && x.champion.id));
  }
});

test('Ja: Fragender bleibt dran; Gleichstand zählt als Nein und gibt weiter', () => {
  const { room, players } = setup(3);
  const [a, b, c] = players;
  room.startRound(a.id);
  assert.equal(room.turn.currentId, a.id);

  assert.equal(room.ask(a.id, 'Bin ich ein Mage?').ok, true);
  const q1 = room.turn.question.entryId;
  assert.equal(room.answer(a.id, q1, 'yes').ok, false, 'Fragender darf nicht antworten');
  room.answer(b.id, q1, 'yes');
  assert.equal(room.turn.question.entryId, q1, 'wartet auf alle');
  room.answer(c.id, q1, 'yes');
  assert.equal(room.turn.currentId, a.id);
  assert.equal(room.turn.question, null);

  room.ask(a.id, 'Bin ich ein Yordle?');
  const q2 = room.turn.question.entryId;
  room.answer(b.id, q2, 'yes');
  room.answer(c.id, q2, 'no');
  assert.equal(room.turn.currentId, b.id, 'Gleichstand => Nein => nächster');
  assert.equal(room.history.find((h) => h.id === q2).status, 'no');
});

test('falscher Tipp gibt weiter, richtiger Tipp platziert und deckt auf', () => {
  const { room, players } = setup(3);
  const [a, b, c] = players;
  room.startRound(a.id);
  const champOf = (p) => room.players.get(p.id).round.championId;
  const wrong = CHAMPS.find((x) => x.id !== champOf(a)).id;

  const r1 = room.guess(a.id, wrong);
  assert.deepEqual([r1.ok, r1.correct], [true, false]);
  assert.equal(room.turn.currentId, b.id);
  assert.equal(room.guess(a.id, champOf(a)).ok, false, 'nicht am Zug');

  room.ask(b.id, 'Bin ich ein Champion mit Schwert?');
  const q = room.turn.question.entryId;
  room.answer(a.id, q, 'yes');
  room.answer(c.id, q, 'yes');
  const r2 = room.guess(b.id, champOf(b));
  assert.equal(r2.correct, true);
  const pb = room.players.get(b.id).round;
  assert.equal(pb.placement, 1);
  assert.equal(pb.points, computePoints(1, 0));
  assert.equal(room.viewFor(b.id).players.find((x) => x.isYou).champion.id, champOf(b));
  assert.equal(room.turn.currentId, c.id);

  room.guess(c.id, champOf(c));
  assert.equal(room.phase, 'roundEnd');
  assert.equal(room.players.get(a.id).round.placement, 3);
  assert.equal(room.players.get(a.id).round.points, 0);
  assert.equal(room.players.get(b.id).totalScore, 95);
  assert.equal(room.viewFor(a.id).players.find((x) => x.isYou).champion.id, champOf(a), 'nach Rundenende aufgedeckt');
});

test('Disconnect: fehlende Antwort blockiert nicht, Zug wird nach Timeout übersprungen', () => {
  const { room, players } = setup(3);
  const [a, b, c] = players;
  room.startRound(a.id);
  room.ask(a.id, 'Bin ich ein Marksman?');
  const q = room.turn.question.entryId;
  room.answer(b.id, q, 'no');
  room.setConnected(c.id, false);
  assert.equal(room.turn.currentId, b.id, 'aufgelöst ohne getrennten Spieler');

  room.setConnected(b.id, false);
  room.handleDisconnectTimeout(b.id);
  assert.equal(room.turn.currentId, a.id, 'b und c getrennt => a ist wieder dran');
  room.setConnected(c.id, true);
  assert.equal(room.verifyToken(c.id, room.players.get(c.id).token).id, c.id);
  assert.equal(room.verifyToken(c.id, 'falsch'), null);
});

test('Verlassen: Host wird neu vergeben, Runde endet wenn nur einer übrig ist', () => {
  const { room, players } = setup(3);
  const [a, b, c] = players;
  room.startRound(a.id);
  room.removePlayer(a.id);
  assert.equal(room.hostId, b.id);
  assert.equal(room.turn.currentId, b.id);
  room.removePlayer(c.id);
  assert.equal(room.phase, 'roundEnd');
});

test('Neustart verwirft Rundenpunkte und rotiert den Startspieler', () => {
  const { room, players } = setup(2);
  const [a, b] = players;
  room.startRound(a.id);
  assert.equal(room.turn.currentId, a.id);
  assert.equal(room.restartRound(b.id).ok, false);
  assert.equal(room.restartRound(a.id).ok, true);
  assert.equal(room.roundNumber, 2);
  assert.equal(room.turn.currentId, b.id);
});

test('Texteingaben werden bereinigt und begrenzt', () => {
  assert.equal(cleanText('  a\u0000b\n\nc  ', 10), 'a b c');
  assert.equal(cleanText('x'.repeat(500), 20).length, 20);
  assert.equal(cleanText({}, 20), '');
});
