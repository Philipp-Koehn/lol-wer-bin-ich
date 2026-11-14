/* LoL – Wer bin ich?  Client. Der Server ist autoritativ; dieser Code rendert nur
   den Zustand, den der Server für genau diesen Spieler schickt. Alle fremden
   Texte landen ausschließlich per textContent im DOM. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'lolwbi.session';
  const NAME_KEY = 'lolwbi.name';

  // ---------- Speicher (kann in privaten Fenstern fehlen) ----------
  const safe = (fn, fallback = null) => {
    try { return fn(); } catch { return fallback; }
  };
  // sessionStorage: automatische Wiederaufnahme in diesem Tab (Reload, Netzwerkwechsel).
  // localStorage: nur ein Angebot zum Wiederbeitreten, falls der Tab geschlossen wurde.
  // Es wird nie automatisch genutzt, damit sich zwei Tabs nicht gegenseitig verdrängen.
  const isSession = (s) => s && typeof s.code === 'string' && typeof s.playerId === 'string' && typeof s.token === 'string';
  const loadSession = () => safe(() => JSON.parse(sessionStorage.getItem(SESSION_KEY)));
  const loadRecovery = () => safe(() => JSON.parse(localStorage.getItem(SESSION_KEY)));
  const saveSession = (s) => safe(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  });
  const clearSession = () => safe(() => {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  });

  // ---------- Zustand ----------
  let champions = [];
  const champById = new Map();
  let state = null;
  let prev = null; // zuletzt gerenderter Zustand (für Animationen und Ansagen)
  let session = loadSession();
  // Die Startseite ist im HTML sichtbar. Wird gleich eine Sitzung wiederaufgenommen
  // (Reload im Spiel), sofort ausblenden, damit sie nicht kurz aufblitzt.
  if (isSession(session)) $('screen-home').hidden = true;
  const HOME_TITLE = document.title;
  let lastOwnVisible = null;
  let lastTurnWasMine = false;
  let guessSelection = null;
  let guessActive = -1;
  let guessMatches = [];
  const sigs = { cards: '', log: '', scores: '', ranking: '' };

  const reducedMotion = () => safe(() => matchMedia('(prefers-reduced-motion: reduce)').matches, false);
  const finePointer = () => safe(() => matchMedia('(hover: hover) and (pointer: fine)').matches, false);

  // ---------- DOM-Helfer ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // Fremde Namen in zusammengesetzten Sätzen isolieren (z. B. arabische Namen vor „fragt“).
  const iso = (s) => `⁨${s}⁩`;

  // Spielername als eigenes, bidi-isoliertes Element; „(du)“ abgesetzt.
  function nameEl(p, cls = 'player-name') {
    return h('span', { class: cls, 'data-testid': cls === 'player-name' ? 'player-name' : null },
      h('bdi', null, p.name), p.isYou ? h('span', { class: 'you' }, ' (du)') : null);
  }

  function initials(name) {
    return (name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?';
  }

  // alt="" wenn der Name ohnehin als Text daneben steht (sonst liest der Screenreader doppelt).
  function champImg(champ, size, alt = '') {
    const img = h('img', {
      src: champ.image, alt, width: size, height: size, loading: 'lazy', decoding: 'async',
    });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'ph', 'aria-hidden': 'true' }, initials(champ.name))), { once: true });
    return img;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  // ---------- Ansagen für Screenreader ----------
  // Kurz hintereinander eintreffende Meldungen werden gesammelt statt sich zu überschreiben.
  const srQueue = { 'sr-status': [], 'sr-alert': [] };
  const srTimer = {};
  function announce(message, assertive = false) {
    if (!message) return;
    const id = assertive ? 'sr-alert' : 'sr-status';
    srQueue[id].push(message);
    // Leeren und neu setzen, damit auch eine gleichlautende Meldung erneut vorgelesen wird.
    $(id).textContent = '';
    clearTimeout(srTimer[id]);
    srTimer[id] = setTimeout(() => {
      $(id).textContent = srQueue[id].join(' ');
      srQueue[id] = [];
    }, 80);
  }

  function toast(message, isError = false) {
    const box = $('toasts');
    const el = h('div', { class: `toast${isError ? ' is-error' : ''}` }, message);
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    announce(message, isError);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 180);
    }, isError ? 5000 : 3200);
  }

  function showScreen(name) {
    for (const s of ['home', 'lobby', 'game']) {
      const el = $(`screen-${s}`);
      const show = s === name;
      if (el.hidden === show) {
        el.hidden = !show;
        if (show) {
          const heading = el.querySelector('h1');
          if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
        }
      }
    }
  }

  const isShown = (el) => !!el && el.isConnected && (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);

  // Klasse neu auslösen, damit eine CSS-Animation erneut abläuft.
  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------- Animationen über Neu-Renderings hinweg ----------
  // Listen werden bei jedem Zustand neu gebaut. Damit eine laufende Animation dabei nicht
  // neu startet oder abbricht, merken wir uns den Startzeitpunkt pro Schlüssel und setzen
  // auf neu erzeugten Elementen eine negative Verzögerung (--t): Sie laufen nahtlos weiter.
  const fresh = new Map();
  const FRESH_MS = 1600;
  function markFresh(key) {
    const now = performance.now();
    for (const [k, t] of fresh) if (now - t > FRESH_MS) fresh.delete(k);
    fresh.set(key, now);
  }
  function animateIfFresh(el, key, cls, delay = 0) {
    const t = fresh.get(key);
    if (t === undefined) return;
    const age = performance.now() - t;
    if (age > FRESH_MS) { fresh.delete(key); return; }
    el.classList.add(cls);
    el.style.setProperty('--t', `${Math.round(delay - age)}ms`);
  }

  // ---------- Netzwerk ----------
  // eslint-disable-next-line no-undef
  const socket = io({ reconnectionDelayMax: 4000 });

  function emit(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(6000).emit(event, payload || {}, (err, res) => {
        resolve(err ? { ok: false, error: 'Keine Antwort vom Server. Prüfe deine Verbindung.' } : res || { ok: false, error: 'Unbekannter Fehler.' });
      });
    });
  }

  async function act(event, payload) {
    const res = await emit(event, payload);
    if (!res.ok) toast(res.error || 'Aktion fehlgeschlagen.', true);
    return res;
  }

  // Sperrt Knöpfe, solange eine Aktion unterwegs ist (kein Doppelklick, kein doppeltes Antworten).
  // Bewusst aria-disabled statt disabled: ein deaktivierter Knopf verliert sonst den Tastaturfokus.
  async function withBusy(buttons, fn) {
    if (buttons.some((b) => b.dataset.busy)) return null;
    buttons.forEach((b) => { b.dataset.busy = '1'; b.setAttribute('aria-disabled', 'true'); });
    try {
      return await fn();
    } finally {
      buttons.forEach((b) => { delete b.dataset.busy; b.removeAttribute('aria-disabled'); });
    }
  }

  function adoptSession(res) {
    session = { code: res.code, playerId: res.playerId, token: res.token, name: res.name };
    saveSession(session);
    $('rejoin-box').hidden = true;
    const url = new URL(location.href);
    url.searchParams.set('raum', res.code);
    history.replaceState(null, '', url);
  }

  function dropSession() {
    session = null;
    state = null;
    prev = null;
    lastOwnVisible = null;
    for (const k of Object.keys(sigs)) sigs[k] = '';
    clearSession();
    showScreen('home');
    document.title = HOME_TITLE;
  }

  async function resume() {
    const res = await emit('room:resume', session);
    if (res.ok) return adoptSession(res);
    const code = session && session.code;
    dropSession();
    if (code) $('code-input').value = code;
    toast('Deine Sitzung ist abgelaufen. Tritt dem Raum neu bei.', true);
  }

  socket.on('connect', () => {
    $('conn-banner').hidden = true;
    if (session) resume();
    else if (!state) showScreen('home');
  });
  socket.on('disconnect', () => { if (session) $('conn-banner').hidden = false; });
  // Vom Server abgewiesen (z. B. zu viele Verbindungen): Socket.IO versucht es dann nicht
  // selbst erneut, also nach einer Pause manuell.
  socket.on('connect_error', (err) => {
    if (socket.active) return;
    toast(err && err.message ? err.message : 'Verbindung abgelehnt.', true);
    setTimeout(() => socket.connect(), 8000);
  });
  socket.on('state', (s) => { state = s; render(); });
  socket.on('session:replaced', () => {
    dropSession();
    toast('Dieser Platz wurde in einem anderen Tab übernommen.', true);
  });

  // ---------- Champions ----------
  async function loadChampions() {
    try {
      const res = await fetch('/api/champions');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      champions = data.champions;
      champions.forEach((c) => champById.set(c.id, c));
      $('data-note').textContent = data.source === 'ddragon'
        ? `${champions.length} Champions, Patch ${data.version}`
        : `${champions.length} Champions aus dem Offline-Bestand (Patch ${data.version})`;
    } catch {
      $('data-note').textContent = 'Champion-Liste konnte nicht geladen werden. Lade die Seite neu.';
    }
  }

  // ---------- Startseite ----------
  function homeError(message, field) {
    $('home-error').textContent = message;
    for (const id of ['name-input', 'code-input']) {
      if (id === field) $(id).setAttribute('aria-invalid', 'true');
      else $(id).removeAttribute('aria-invalid');
    }
    if (field) $(field).focus();
  }

  function readName() {
    const name = $('name-input').value.trim();
    if (!name) {
      homeError('Bitte gib zuerst deinen Namen ein.', 'name-input');
      return null;
    }
    safe(() => localStorage.setItem(NAME_KEY, name));
    return name;
  }

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    homeError('');
    const name = readName();
    if (!name) return;
    const btn = e.currentTarget.querySelector('button[type=submit]');
    const res = await withBusy([btn], () => emit('room:create', { name }));
    if (!res) return;
    if (!res.ok) { homeError(res.error); return; }
    adoptSession(res);
  });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    homeError('');
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 5) {
      homeError('Der Raumcode hat 5 Zeichen.', 'code-input');
      return;
    }
    const name = readName();
    if (!name) return;
    const btn = e.currentTarget.querySelector('button[type=submit]');
    const res = await withBusy([btn], () => emit('room:join', { code, name }));
    if (!res) return;
    if (!res.ok) { homeError(res.error); return; }
    adoptSession(res);
  });

  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    e.target.removeAttribute('aria-invalid');
  });
  $('name-input').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

  // ---------- Gemeinsame Aktionen ----------
  async function copyInvite() {
    if (!state) return;
    const link = `${location.origin}/?raum=${state.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Einladungslink kopiert.');
    } catch {
      toast(`Raumcode: ${state.code}`);
    }
  }
  $('lobby-code').addEventListener('click', copyInvite);
  $('game-code').addEventListener('click', copyInvite);

  async function leave() {
    if (!window.confirm('Raum wirklich verlassen? Deine Punkte gehen verloren.')) return;
    await emit('room:leave');
    dropSession();
    const url = new URL(location.href);
    url.searchParams.delete('raum');
    history.replaceState(null, '', url);
  }
  $('lobby-leave').addEventListener('click', leave);
  $('game-leave').addEventListener('click', leave);

  $('start-btn').addEventListener('click', () => withBusy([$('start-btn')], () => act('game:start')));
  $('next-round-btn').addEventListener('click', () => withBusy([$('next-round-btn')], () => act('game:start')));
  $('restart-btn').addEventListener('click', () => {
    if (window.confirm('Runde neu starten? Die Punkte dieser Runde verfallen.')) act('game:restart');
  });

  function setRules(open, returnFocus = false) {
    $('rules-pop').hidden = !open;
    $('rules-btn').setAttribute('aria-expanded', String(open));
    if (!open && returnFocus) $('rules-btn').focus();
  }
  $('rules-btn').addEventListener('click', () => setRules($('rules-pop').hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('rules-pop').hidden) {
      const inside = $('rules-pop').contains(document.activeElement) || document.activeElement === $('rules-btn');
      setRules(false, inside);
    }
  });

  // ---------- Fragen, Antworten, Chat ----------
  $('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('ask-input');
    const text = input.value.trim();
    if (text.length < 3) { toast('Die Frage ist zu kurz.', true); input.focus(); return; }
    const btn = e.currentTarget.querySelector('button[type=submit]');
    const res = await withBusy([btn], () => act('turn:ask', { text }));
    if (res && res.ok) input.value = '';
  });

  function answer(value) {
    const q = state && state.turn.question;
    if (!q) return;
    withBusy([$('yes-btn'), $('no-btn')], () => act('turn:answer', { questionId: q.id, answer: value }));
  }
  $('yes-btn').addEventListener('click', () => answer('yes'));
  $('no-btn').addEventListener('click', () => answer('no'));
  $('pass-btn').addEventListener('click', () => withBusy([$('pass-btn')], () => act('turn:pass')));

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input');
    if (!input.value.trim()) return;
    const res = await act('chat:send', { text: input.value });
    if (res.ok) input.value = '';
  });

  // ---------- Raten mit Autovervollständigung ----------
  const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function takenChampionIds() {
    const ids = new Set();
    if (state) for (const p of state.players) if (p.champion && !p.isYou) ids.add(p.champion.id);
    return ids;
  }

  function updateGuessList() {
    const input = $('guess-input');
    const q = norm(input.value);
    guessSelection = null;
    const exact = champions.find((c) => norm(c.name) === q);
    if (exact && q) guessSelection = exact.id;
    $('guess-btn').disabled = !guessSelection;

    if (!q) { closeGuessList(); return; }
    const taken = takenChampionIds();
    const pool = champions.filter((c) => !taken.has(c.id));
    const starts = pool.filter((c) => norm(c.name).startsWith(q));
    const contains = pool.filter((c) => !norm(c.name).startsWith(q) && norm(c.name).includes(q));
    guessMatches = starts.concat(contains).slice(0, 8);
    guessActive = guessMatches.length ? 0 : -1;
    renderGuessList();
  }

  function renderGuessList() {
    const list = $('guess-list');
    const input = $('guess-input');
    list.replaceChildren();
    if (!guessMatches.length) {
      list.append(h('li', { role: 'option', 'aria-disabled': 'true', 'aria-selected': 'false' }, 'Kein Champion gefunden'));
    }
    guessMatches.forEach((c, i) => {
      const li = h('li', { id: `opt-${c.id}`, role: 'option', 'aria-selected': String(i === guessActive) },
        champImg(c, 32), h('span', null, c.name), h('small', null, c.title));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); chooseGuess(c); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (guessActive >= 0) {
      input.setAttribute('aria-activedescendant', `opt-${guessMatches[guessActive].id}`);
      const active = list.children[guessActive];
      if (active) active.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function closeGuessList() {
    $('guess-list').hidden = true;
    $('guess-input').setAttribute('aria-expanded', 'false');
    $('guess-input').removeAttribute('aria-activedescendant');
  }

  function chooseGuess(c) {
    $('guess-input').value = c.name;
    guessSelection = c.id;
    $('guess-btn').disabled = false;
    closeGuessList();
    $('guess-btn').focus();
  }

  let guessing = false;
  async function submitGuess() {
    if (!guessSelection || guessing) return;
    guessing = true;
    const champ = champById.get(guessSelection);
    $('guess-btn').setAttribute('aria-disabled', 'true');
    const res = await act('turn:guess', { championId: guessSelection });
    $('guess-btn').removeAttribute('aria-disabled');
    guessing = false;
    if (res.ok) {
      $('guess-input').value = '';
      guessSelection = null;
      toast(res.correct ? `Richtig! Du bist ${champ.name}.` : `Falsch, du bist nicht ${champ.name}. Der Nächste ist dran.`, !res.correct);
    }
    $('guess-btn').disabled = !guessSelection;
  }

  $('guess-input').addEventListener('input', updateGuessList);
  $('guess-input').addEventListener('blur', () => setTimeout(closeGuessList, 100));
  $('guess-input').addEventListener('keydown', (e) => {
    const open = !$('guess-list').hidden && guessMatches.length;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault(); guessActive = (guessActive + 1) % guessMatches.length; renderGuessList();
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault(); guessActive = (guessActive - 1 + guessMatches.length) % guessMatches.length; renderGuessList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && guessActive >= 0) chooseGuess(guessMatches[guessActive]);
      else submitGuess();
    } else if (e.key === 'Escape') {
      closeGuessList();
    }
  });
  $('guess-btn').addEventListener('click', submitGuess);

  // ---------- Änderungen erkennen: Animationen markieren, Ansagen sammeln ----------
  const verdictWord = { yes: 'Ja', no: 'Nein' };

  function diffState(before, now) {
    const said = [];
    if (!before || before.code !== now.code) return said; // erstes Bild: nichts animieren, nichts ansagen
    const self = now.players.find((p) => p.isYou);
    const name = (id) => { const p = now.players.find((x) => x.id === id); return p ? p.name : ''; };

    // Lobby: neue Spieler gleiten ein.
    const oldIds = new Set(before.players.map((p) => p.id));
    for (const p of now.players) if (!oldIds.has(p.id)) markFresh(`player:${p.id}`);

    // Verlauf: neue Einträge und frisch entschiedene Fragen.
    const oldEntries = new Map(before.history.map((e) => [e.id, e]));
    const lastOld = before.history.length ? before.history[before.history.length - 1].id : 0;
    for (const e of now.history) {
      const old = oldEntries.get(e.id);
      if (!old && e.id > lastOld) {
        markFresh(`log:${e.id}`);
        if (e.type === 'system') said.push(e.text);
        else if (e.type === 'chat' && e.playerId !== self.id) said.push(`${e.name} schreibt: ${e.text}`);
        else if (e.type === 'guess' && e.playerId !== self.id) said.push(`${e.name} tippt auf ${e.championName}: ${e.correct ? 'richtig' : 'falsch'}.`);
        else if (e.type === 'question' && e.askerId !== self.id && now.turn.question && now.turn.question.id === e.id) {
          const mustAnswer = now.turn.question.required.includes(self.id);
          said.push(`${e.askerName} fragt: ${e.text}${mustAnswer ? ' Antworte mit Ja oder Nein.' : ''}`);
        }
      }
      if (old && e.type === 'question' && old.status === 'pending' && e.status !== 'pending') {
        markFresh(`verdict:${e.id}`);
        if (verdictWord[e.status]) said.push(`Antwort auf „${e.text}“: ${verdictWord[e.status]}.`);
      }
    }

    // Antwort-Fortschritt: frisch beantwortete Namen.
    const q = now.turn.question;
    if (q) {
      const had = new Set(before.turn.question && before.turn.question.id === q.id ? before.turn.question.answeredIds : []);
      for (const id of q.answeredIds) if (!had.has(id)) markFresh(`pill:${q.id}:${id}`);
    }

    // Zugwechsel.
    const turnKey = (s) => `${s.roundNumber}:${s.phase}:${s.turn.currentId}`;
    if (now.phase === 'playing' && turnKey(before) !== turnKey(now) && now.turn.currentId) {
      markFresh(`turn:${now.roundNumber}:${now.turn.currentId}`);
      // Beim Rundenstart sagt der Systemeintrag „… fängt an“ schon, wer dran ist.
      if (now.turn.currentId === self.id || before.roundNumber === now.roundNumber) said.push(now.turn.currentId === self.id ? 'Du bist dran. Stell eine Frage oder rate deinen Champion.' : `${name(now.turn.currentId)} ist dran.`);
    }

    // Rundenende.
    if (now.phase === 'roundEnd' && before.phase !== 'roundEnd') {
      markFresh(`ranking:${now.roundNumber}`);
      const ranked = now.players.filter((p) => p.playing && p.placement).sort((a, b) => a.placement - b.placement);
      said.push(`Rangfolge: ${ranked.map((p) => `Platz ${p.placement} ${p.name}, plus ${p.roundPoints}`).join('; ')}.`);
    }
    return said;
  }

  // ---------- Rendering ----------
  // Verbindung zum Bild-CDN aufbauen, sobald man in einem Raum ist (vor den ersten Karten).
  let preconnected = false;
  function preconnectImages() {
    if (preconnected) return;
    preconnected = true;
    document.head.append(h('link', { rel: 'preconnect', href: 'https://ddragon.leagueoflegends.com' }));
  }

  function render() {
    if (!state) return showScreen('home');
    preconnectImages();
    const said = diffState(prev, state);
    document.querySelectorAll('[data-rule]').forEach((el) => { el.textContent = state.rules[el.dataset.rule] || ''; });
    const codeLabel = `Raumcode ${state.code.split('').join(' ')}, Einladungslink kopieren`;
    $('lobby-code').setAttribute('aria-label', codeLabel);
    $('game-code').setAttribute('aria-label', codeLabel);
    if (state.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderGame();
    }
    if (said.length) announce(said.join(' '));
    prev = state;
  }

  function me() {
    return state.players.find((p) => p.isYou);
  }

  function byId(id) {
    return state.players.find((p) => p.id === id);
  }

  function playerTags(p) {
    return [
      p.isHost ? h('span', { class: 'tag tag-host' }, 'Host') : null,
      p.connected ? null : h('span', { class: 'tag tag-off' }, 'getrennt'),
    ];
  }

  function renderLobby() {
    const self = me();
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = `${state.players.length} / 10`;
    $('lobby-players').replaceChildren(...state.players.map((p) => {
      const li = h('li', { class: p.isYou ? 'is-you' : null }, nameEl(p), ...playerTags(p));
      animateIfFresh(li, `player:${p.id}`, 'is-new');
      return li;
    }));
    const connected = state.players.filter((p) => p.connected).length;
    const enough = connected >= state.limits.minPlayers;
    $('start-btn').hidden = !self.isHost;
    $('start-btn').disabled = !enough;
    const host = byId(state.hostId);
    $('lobby-wait').textContent = self.isHost
      ? (enough ? 'Alle da? Dann los.' : 'Warte auf mindestens einen Mitspieler. Teile den Raumcode.')
      : `Warte, bis ${host ? iso(host.name) : 'der Host'} die Runde startet.`;
    document.title = 'Lobby – LoL – Wer bin ich?';
  }

  function renderGame() {
    const self = me();
    const t = state.turn;
    const q = t.question;
    const current = byId(t.currentId);
    const myTurn = state.phase === 'playing' && t.currentId === self.id;
    const panel = $('turn-panel');
    const focusBefore = document.activeElement;
    const focusWasInPanel = panel.contains(focusBefore) && focusBefore !== panel;

    $('game-code').textContent = state.code;
    $('round-label').textContent = `Runde ${state.roundNumber}`;
    $('restart-btn').hidden = !(self.isHost && state.phase === 'playing');

    panel.classList.toggle('is-active', myTurn);
    if (myTurn && !lastTurnWasMine && prev) replay(panel, 'turn-flash');
    const show = { ask: false, answer: false, progress: false, guess: false, end: false };
    let title = '';
    let sub = '';

    if (state.phase === 'roundEnd') {
      title = 'Runde vorbei';
      sub = `Ergebnis von Runde ${state.roundNumber}:`;
      show.end = true;
      renderRoundEnd(self);
    } else if (myTurn) {
      if (q) {
        title = 'Warte auf die Antworten';
        sub = `Deine Frage: „${q.text}“`;
        show.progress = true;
      } else {
        title = 'Du bist dran';
        sub = 'Stell eine Ja/Nein-Frage oder rate deinen Champion.';
        show.ask = true;
      }
      show.guess = true;
      $('pass-btn').hidden = !!q;
    } else {
      const askerName = current ? current.name : '';
      if (q && q.askerId !== self.id) {
        title = `${iso(byId(q.askerId) ? byId(q.askerId).name : askerName)} fragt`;
        $('answer-question').textContent = q.text;
        if (q.yourAnswer) {
          sub = `Du hast mit ${q.yourAnswer === 'yes' ? 'Ja' : 'Nein'} geantwortet.`;
        } else if (q.required.includes(self.id)) {
          show.answer = true;
          sub = 'Schau dir die Karte an und antworte ehrlich.';
        }
        show.progress = true;
      } else if (current) {
        title = `${iso(current.name)} ist dran`;
        sub = 'Warte auf die nächste Frage.';
      } else {
        title = 'Warte auf Spieler';
        sub = 'Gerade ist niemand verbunden, der raten kann.';
      }
      if (!self.playing) sub = `${sub} Du schaust diese Runde zu und spielst ab der nächsten mit.`;
      else if (self.solved) sub = `${sub} Du hast deinen Champion schon erraten.`;
    }

    const titleEl = $('turn-title');
    if (titleEl.textContent !== title) {
      titleEl.textContent = title;
      if (prev) replay(titleEl, 'is-changed');
    }
    $('turn-sub').textContent = sub;
    $('ask-form').hidden = !show.ask;
    $('answer-box').hidden = !show.answer;
    $('guess-box').hidden = !show.guess;
    $('round-end').hidden = !show.end;
    $('answer-progress').hidden = !show.progress;
    if (show.progress) renderProgress(q);
    if (!show.guess) closeGuessList();

    // Fokus nie im Nichts verlieren: Wurde das fokussierte Element ausgeblendet (z. B. nach
    // „Ja“), springt er auf die Überschrift des Zug-Panels. Wird man selbst dran, landet er im
    // Fragefeld, aber nur mit Maus/Tastatur (auf dem Handy würde sonst die Tastatur aufspringen).
    const focusLost = focusWasInPanel && !isShown(focusBefore);
    const focusFree = document.activeElement === document.body || focusLost;
    if (myTurn && !lastTurnWasMine && !q && focusFree && finePointer()) $('ask-input').focus({ preventScroll: true });
    else if (focusLost) titleEl.focus({ preventScroll: true });
    lastTurnWasMine = myTurn;
    document.title = `${myTurn ? '(Du bist dran) ' : ''}LoL – Wer bin ich?`;

    renderCards(self);
    renderLog();
    renderScores();
  }

  function renderProgress(q) {
    const done = new Set(q.answeredIds);
    const pills = q.required.map((id) => {
      const p = byId(id);
      const answered = done.has(id);
      const pill = h('span', { class: `pill${answered ? ' done' : ''}` },
        h('bdi', null, p ? p.name : '?'),
        h('span', { class: 'mark', 'aria-hidden': 'true' }, answered ? '✓' : '…'),
        h('span', { class: 'visually-hidden' }, answered ? ' hat geantwortet' : ' antwortet noch'));
      if (answered) animateIfFresh(pill, `pill:${q.id}:${id}`, 'is-new');
      return pill;
    });
    const count = q.required.filter((id) => done.has(id)).length;
    $('answer-progress').replaceChildren(
      h('span', null, `Antworten ${count} von ${q.required.length}:`), ...pills);
  }

  function renderRoundEnd(self) {
    const ranked = state.players.filter((p) => p.playing && p.placement).sort((a, b) => a.placement - b.placement);
    const sig = JSON.stringify(ranked.map((p) => [p.id, p.name, p.placement, p.roundPoints, p.champion && p.champion.id, p.questions, p.wrongGuesses, p.isYou]));
    if (sig !== sigs.ranking) {
      sigs.ranking = sig;
      $('round-ranking').replaceChildren(...ranked.map((p, i) => {
        const li = h('li', null,
          h('span', { class: 'place' }, h('span', { class: 'visually-hidden' }, 'Platz '), `${p.placement}.`),
          p.champion ? champImg(p.champion, 48) : h('span', { class: 'ph', 'aria-hidden': 'true' }, '?'),
          h('span', { class: 'who' },
            h('strong', null, h('bdi', null, p.name), p.isYou ? ' (du)' : ''),
            h('span', null, `${p.champion ? p.champion.name : '?'}, ${plural(p.questions, 'Frage', 'Fragen')}, ${plural(p.wrongGuesses, 'Fehltipp', 'Fehltipps')}`)),
          h('span', { class: 'pts' }, h('span', { class: 'visually-hidden' }, 'Punkte: '), `+${p.roundPoints}`));
        animateIfFresh(li, `ranking:${state.roundNumber}`, 'is-enter', 80 + i * 60);
        return li;
      }));
    }
    $('next-round-btn').hidden = !self.isHost;
    const host = byId(state.hostId);
    $('next-round-wait').textContent = self.isHost ? '' : `Warte, bis ${host ? iso(host.name) : 'der Host'} die nächste Runde startet.`;
  }

  function renderCards(self) {
    const ownVisible = !!(self.champion);
    if (lastOwnVisible === false && ownVisible) markFresh(`reveal:${state.roundNumber}:${self.id}`);
    lastOwnVisible = self.playing ? ownVisible : null;

    const playing = state.players.filter((p) => p.playing);
    const sig = JSON.stringify([state.phase, state.roundNumber, state.turn.currentId, playing.map((p) =>
      [p.id, p.name, p.connected, p.isHost, p.placement, p.questions, p.wrongGuesses, p.champion && p.champion.id])]);
    if (sig === sigs.cards) return;
    sigs.cards = sig;

    const cards = playing.map((p) => {
      const isTurn = state.phase === 'playing' && p.id === state.turn.currentId;
      const classes = ['card'];
      if (isTurn) classes.push('is-turn');
      if (p.isYou) classes.push('is-you');
      if (!p.connected) classes.push('is-off');

      const portrait = h('div', { class: 'portrait' });
      if (p.champion) portrait.append(champImg(p.champion, 120));
      else portrait.append(h('div', { class: 'sealed', 'aria-hidden': 'true' }, h('span', null, '?')));
      if (isTurn) portrait.append(h('span', { class: 'badge badge-turn', 'aria-hidden': 'true' }, 'Am Zug'));
      if (p.placement) portrait.append(h('span', { class: 'badge badge-place', 'aria-hidden': 'true' }, `#${p.placement}`));

      const champName = p.champion ? p.champion.name : (p.isYou ? 'Wer bin ich?' : 'Verdeckt');
      const status = [isTurn ? 'am Zug' : null, p.placement ? `Platz ${p.placement}` : null].filter(Boolean).join(', ');
      const body = h('div', { class: 'card-body' },
        h('span', { class: 'champ-name', 'data-testid': 'champ-name' }, champName),
        p.champion && p.champion.title ? h('span', { class: 'champ-title' }, p.champion.title) : null,
        h('span', { class: 'card-player' }, nameEl(p), ...playerTags(p)),
        h('span', { class: 'card-stats' },
          `${plural(p.questions, 'Frage', 'Fragen')}${p.wrongGuesses ? `, ${plural(p.wrongGuesses, 'Fehltipp', 'Fehltipps')}` : ''}`),
        status ? h('span', { class: 'visually-hidden' }, `, ${status}`) : null);

      const li = h('li', {
        class: classes.join(' '),
        'data-player-id': p.id,
        'data-champion-id': p.champion ? p.champion.id : null,
      }, h('div', { class: 'card-inner' }, portrait, body));
      if (isTurn) animateIfFresh(li, `turn:${state.roundNumber}:${p.id}`, 'turn-in');
      if (p.isYou) animateIfFresh(li, `reveal:${state.roundNumber}:${p.id}`, 'reveal');
      return li;
    });
    $('cards').replaceChildren(...cards);
  }

  const verdictLabel = { yes: 'Ja', no: 'Nein', pending: 'offen', abgebrochen: 'abgebrochen', 'zurückgezogen': 'zurückgezogen' };

  function renderLog() {
    const log = $('log');
    const sig = JSON.stringify(state.history.map((e) => [e.id, e.status, e.answeredIds && e.answeredIds.length]));
    if (sig === sigs.log) return;
    sigs.log = sig;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const items = state.history.map((e) => {
      const time = h('time', { datetime: new Date(e.ts).toISOString() }, fmtTime(e.ts));
      let li;
      if (e.type === 'system') {
        li = h('li', { class: 'is-system' }, h('span', { class: 'text' }, e.text), ' ', time);
      } else if (e.type === 'chat') {
        li = h('li', null, h('div', { class: 'meta' }, h('strong', null, h('bdi', null, e.name)), time), h('div', { class: 'text' }, e.text));
      } else if (e.type === 'guess') {
        li = h('li', { class: e.correct ? 'is-correct' : 'is-no' },
          h('div', { class: 'meta' }, h('strong', null, h('bdi', null, e.name)),
            h('span', { class: `verdict ${e.correct ? 'correct' : 'no'}` }, e.correct ? 'richtig' : 'falsch'), time),
          h('div', { class: 'text' }, `tippt auf ${e.championName}`));
      } else {
        // Frage
        const status = e.status;
        const cls = status === 'yes' ? 'is-yes' : status === 'no' ? 'is-no' : null;
        const vClass = status === 'yes' ? 'yes' : status === 'no' ? 'no' : status === 'pending' ? 'pending' : 'other';
        let detail = null;
        if (e.answers && e.answers.length) {
          detail = h('div', { class: 'answers' }, ...e.answers.flatMap((a, i) =>
            [i ? ', ' : null, h('bdi', null, a.name), `: ${a.answer === 'yes' ? 'Ja' : 'Nein'}`]));
        } else if (status === 'pending') {
          const n = (e.answeredIds || []).length;
          detail = h('div', { class: 'answers' }, n === 1 ? '1 Antwort bisher' : `${n} Antworten bisher`);
        }
        const verdict = h('span', { class: `verdict ${vClass}` }, verdictLabel[status] || status);
        animateIfFresh(verdict, `verdict:${e.id}`, 'is-new');
        li = h('li', { class: cls },
          h('div', { class: 'meta' }, h('strong', null, h('bdi', null, e.askerName)), verdict, time),
          h('div', { class: 'text q-text' }, e.text), detail);
      }
      animateIfFresh(li, `log:${e.id}`, 'is-new');
      return li;
    });
    log.replaceChildren(...(items.length ? items : [h('li', { class: 'is-system log-empty' }, 'Noch nichts passiert.')]));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function renderScores() {
    const list = $('scores');
    const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name, 'de'));
    const spectating = (p) => !(p.playing || state.phase === 'roundEnd');
    const sig = JSON.stringify(sorted.map((p) => [p.id, p.name, p.totalScore, spectating(p), p.isYou]));
    if (sig === sigs.scores) return;
    sigs.scores = sig;

    // FLIP: alte Positionen merken, neu rendern, Zeilen von alt nach neu gleiten lassen.
    const oldTop = new Map();
    const oldScore = new Map();
    for (const li of list.children) {
      oldTop.set(li.dataset.id, li.getBoundingClientRect().top);
      oldScore.set(li.dataset.id, Number(li.dataset.score));
    }
    list.replaceChildren(...sorted.map((p, i) =>
      h('li', { 'data-id': p.id, 'data-score': p.totalScore },
        h('span', { class: 'rank' }, `${i + 1}.`),
        h('span', { class: `name${p.isYou ? ' is-you' : ''}` }, h('bdi', null, p.name), spectating(p) ? ' (schaut zu)' : ''),
        h('span', { class: 'pts' }, String(p.totalScore)))));
    if (!prev || !oldTop.size) return;
    const motion = !reducedMotion();
    for (const li of list.children) {
      const id = li.dataset.id;
      if (oldScore.has(id) && Number(li.dataset.score) > oldScore.get(id)) li.querySelector('.pts').classList.add('bump');
      if (!motion || !oldTop.has(id) || !li.animate) continue;
      const dy = oldTop.get(id) - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) {
        li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
          { duration: 420, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' });
      }
    }
  }

  // ---------- Start ----------
  const params = new URLSearchParams(location.search);
  const codeParam = (params.get('raum') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (codeParam) $('code-input').value = codeParam;
  const savedName = safe(() => localStorage.getItem(NAME_KEY));
  if (savedName) $('name-input').value = savedName.slice(0, 20);
  if (!isSession(session)) {
    session = null;
    showScreen('home');
    const recovery = loadRecovery();
    if (isSession(recovery)) {
      $('rejoin-text').textContent = `Du warst zuletzt in Raum ${recovery.code}${recovery.name ? ` als ${iso(recovery.name)}` : ''}.`;
      $('rejoin-box').hidden = false;
      $('rejoin-btn').addEventListener('click', () => {
        session = recovery;
        saveSession(session);
        if (socket.connected) resume();
      });
      $('rejoin-dismiss').addEventListener('click', () => {
        safe(() => localStorage.removeItem(SESSION_KEY));
        $('rejoin-box').hidden = true;
        $('name-input').focus();
      });
    }
  }
  loadChampions();
})();
