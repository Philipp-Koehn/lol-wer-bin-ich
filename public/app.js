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
  let session = loadSession();
  let lastOwnVisible = null;
  let lastTurnWasMine = false;
  let guessSelection = null;
  let guessActive = -1;
  let guessMatches = [];

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

  function initials(name) {
    return (name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?';
  }

  function champImg(champ, size) {
    const img = h('img', {
      src: champ.image, alt: champ.name, width: size, height: size, loading: 'lazy', decoding: 'async',
    });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'ph', 'aria-label': champ.name }, initials(champ.name))), { once: true });
    return img;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function toast(message, isError = false) {
    const el = h('div', { class: `toast${isError ? ' is-error' : ''}`, role: isError ? 'alert' : 'status' }, message);
    $('toasts').append(el);
    setTimeout(() => el.remove(), isError ? 5000 : 3200);
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
    lastOwnVisible = null;
    clearSession();
    showScreen('home');
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
  function readName() {
    const name = $('name-input').value.trim();
    if (!name) {
      $('home-error').textContent = 'Bitte gib zuerst deinen Namen ein.';
      $('name-input').focus();
      return null;
    }
    safe(() => localStorage.setItem(NAME_KEY, name));
    return name;
  }

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('home-error').textContent = '';
    const name = readName();
    if (!name) return;
    const res = await emit('room:create', { name });
    if (!res.ok) { $('home-error').textContent = res.error; return; }
    adoptSession(res);
  });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('home-error').textContent = '';
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 5) {
      $('home-error').textContent = 'Der Raumcode hat 5 Zeichen.';
      $('code-input').focus();
      return;
    }
    const name = readName();
    if (!name) return;
    const res = await emit('room:join', { code, name });
    if (!res.ok) { $('home-error').textContent = res.error; return; }
    adoptSession(res);
  });

  $('code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

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

  $('start-btn').addEventListener('click', () => act('game:start'));
  $('next-round-btn').addEventListener('click', () => act('game:start'));
  $('restart-btn').addEventListener('click', () => {
    if (window.confirm('Runde neu starten? Die Punkte dieser Runde verfallen.')) act('game:restart');
  });

  $('rules-btn').addEventListener('click', () => {
    const pop = $('rules-pop');
    pop.hidden = !pop.hidden;
    $('rules-btn').setAttribute('aria-expanded', String(!pop.hidden));
  });

  // ---------- Fragen, Antworten, Chat ----------
  $('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('ask-input');
    const text = input.value.trim();
    if (text.length < 3) { toast('Die Frage ist zu kurz.', true); input.focus(); return; }
    const res = await act('turn:ask', { text });
    if (res.ok) input.value = '';
  });

  function answer(value) {
    const q = state && state.turn.question;
    if (q) act('turn:answer', { questionId: q.id, answer: value });
  }
  $('yes-btn').addEventListener('click', () => answer('yes'));
  $('no-btn').addEventListener('click', () => answer('no'));
  $('pass-btn').addEventListener('click', () => act('turn:pass'));

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
    const list = $('guess-list');
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
      list.append(h('li', { role: 'option', 'aria-disabled': 'true' }, 'Kein Champion gefunden'));
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

  async function submitGuess() {
    if (!guessSelection) return;
    const champ = champById.get(guessSelection);
    const res = await act('turn:guess', { championId: guessSelection });
    if (res.ok) {
      $('guess-input').value = '';
      guessSelection = null;
      $('guess-btn').disabled = true;
      toast(res.correct ? `Richtig! Du bist ${champ.name}.` : `Falsch, du bist nicht ${champ.name}. Der Nächste ist dran.`, !res.correct);
    }
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

  // ---------- Rendering ----------
  function render() {
    if (!state) return showScreen('home');
    document.querySelectorAll('[data-rule]').forEach((el) => { el.textContent = state.rules[el.dataset.rule] || ''; });
    if (state.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderGame();
    }
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
    $('lobby-players').replaceChildren(...state.players.map((p) =>
      h('li', { class: p.isYou ? 'is-you' : null },
        h('span', { class: 'player-name' }, p.name, p.isYou ? ' (du)' : ''),
        ...playerTags(p))));
    const connected = state.players.filter((p) => p.connected).length;
    const enough = connected >= state.limits.minPlayers;
    $('start-btn').hidden = !self.isHost;
    $('start-btn').disabled = !enough;
    const host = byId(state.hostId);
    $('lobby-wait').textContent = self.isHost
      ? (enough ? 'Alle da? Dann los.' : 'Warte auf mindestens einen Mitspieler. Teile den Raumcode.')
      : `Warte, bis ${host ? host.name : 'der Host'} die Runde startet.`;
    document.title = 'Lobby – LoL – Wer bin ich?';
  }

  function renderGame() {
    const self = me();
    const t = state.turn;
    const q = t.question;
    const current = byId(t.currentId);
    const myTurn = state.phase === 'playing' && t.currentId === self.id;

    $('game-code').textContent = state.code;
    $('round-label').textContent = `Runde ${state.roundNumber}`;
    $('restart-btn').hidden = !(self.isHost && state.phase === 'playing');

    const panel = $('turn-panel');
    panel.classList.toggle('is-active', myTurn);
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
        title = `${byId(q.askerId) ? byId(q.askerId).name : askerName} fragt`;
        $('answer-question').textContent = q.text;
        if (q.yourAnswer) {
          sub = `Du hast mit ${q.yourAnswer === 'yes' ? 'Ja' : 'Nein'} geantwortet.`;
        } else if (q.required.includes(self.id)) {
          show.answer = true;
          sub = 'Schau dir die Karte an und antworte ehrlich.';
        }
        show.progress = true;
      } else if (current) {
        title = `${current.name} ist dran`;
        sub = 'Warte auf die nächste Frage.';
      } else {
        title = 'Warte auf Spieler';
        sub = 'Gerade ist niemand verbunden, der raten kann.';
      }
      if (!self.playing) sub = `${sub} Du schaust diese Runde zu und spielst ab der nächsten mit.`;
      else if (self.solved) sub = `${sub} Du hast deinen Champion schon erraten.`;
    }

    $('turn-title').textContent = title;
    $('turn-sub').textContent = sub;
    $('ask-form').hidden = !show.ask;
    $('answer-box').hidden = !show.answer;
    $('guess-box').hidden = !show.guess;
    $('round-end').hidden = !show.end;
    $('answer-progress').hidden = !show.progress;
    if (show.progress) renderProgress(q);
    if (!show.guess) closeGuessList();

    if (myTurn && !lastTurnWasMine && document.activeElement === document.body && !q) $('ask-input').focus();
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
      return h('span', { class: `pill${answered ? ' done' : ''}` }, `${p ? p.name : '?'} ${answered ? '✓' : '…'}`);
    });
    const count = q.required.filter((id) => done.has(id)).length;
    $('answer-progress').replaceChildren(
      h('span', null, `Antworten ${count} von ${q.required.length}:`), ...pills);
  }

  function renderRoundEnd(self) {
    const ranked = state.players.filter((p) => p.playing && p.placement).sort((a, b) => a.placement - b.placement);
    $('round-ranking').replaceChildren(...ranked.map((p) =>
      h('li', null,
        h('span', { class: 'place', 'aria-label': `Platz ${p.placement}` }, `${p.placement}.`),
        p.champion ? champImg(p.champion, 48) : h('span', { class: 'ph' }, '?'),
        h('span', { class: 'who' },
          h('strong', null, p.name, p.isYou ? ' (du)' : ''),
          h('span', null, `${p.champion ? p.champion.name : '?'}, ${plural(p.questions, 'Frage', 'Fragen')}, ${plural(p.wrongGuesses, 'Fehltipp', 'Fehltipps')}`)),
        h('span', { class: 'pts' }, `+${p.roundPoints}`))));
    $('next-round-btn').hidden = !self.isHost;
    const host = byId(state.hostId);
    $('next-round-wait').textContent = self.isHost ? '' : `Warte, bis ${host ? host.name : 'der Host'} die nächste Runde startet.`;
  }

  function renderCards(self) {
    const ownVisible = !!(self.champion);
    const animateOwn = lastOwnVisible === false && ownVisible;
    lastOwnVisible = self.playing ? ownVisible : null;

    const cards = state.players.filter((p) => p.playing).map((p) => {
      const isTurn = state.phase === 'playing' && p.id === state.turn.currentId;
      const classes = ['card'];
      if (isTurn) classes.push('is-turn');
      if (p.isYou) classes.push('is-you');
      if (!p.connected) classes.push('is-off');
      if (p.isYou && animateOwn) classes.push('reveal');

      const portrait = h('div', { class: 'portrait' });
      if (p.champion) portrait.append(champImg(p.champion, 120));
      else portrait.append(h('div', { class: 'sealed', 'aria-hidden': 'true' }, h('span', null, '?')));
      if (isTurn) portrait.append(h('span', { class: 'badge badge-turn' }, 'Am Zug'));
      if (p.placement) portrait.append(h('span', { class: 'badge badge-place', 'aria-label': `Platz ${p.placement}` }, `#${p.placement}`));

      const champName = p.champion ? p.champion.name : (p.isYou ? 'Wer bin ich?' : 'Verdeckt');
      const body = h('div', { class: 'card-body' },
        h('span', { class: 'champ-name', 'data-testid': 'champ-name' }, champName),
        p.champion && p.champion.title ? h('span', { class: 'champ-title' }, p.champion.title) : null,
        h('span', { class: 'card-player' },
          h('span', { class: 'player-name', 'data-testid': 'player-name' }, p.name, p.isYou ? ' (du)' : ''),
          ...playerTags(p)),
        h('span', { class: 'card-stats' },
          `${plural(p.questions, 'Frage', 'Fragen')}${p.wrongGuesses ? `, ${plural(p.wrongGuesses, 'Fehltipp', 'Fehltipps')}` : ''}`));

      return h('li', {
        class: classes.join(' '),
        'data-player-id': p.id,
        'data-champion-id': p.champion ? p.champion.id : null,
        'aria-label': `${p.name}${p.isYou ? ' (du)' : ''}: ${p.champion ? p.champion.name : 'verdeckt'}${isTurn ? ', am Zug' : ''}`,
      }, h('div', { class: 'card-inner' }, portrait, body));
    });
    $('cards').replaceChildren(...cards);
  }

  const verdictLabel = { yes: 'Ja', no: 'Nein', pending: 'offen', abgebrochen: 'abgebrochen', 'zurückgezogen': 'zurückgezogen' };

  function renderLog() {
    const log = $('log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const items = state.history.map((e) => {
      const time = h('time', { datetime: new Date(e.ts).toISOString() }, fmtTime(e.ts));
      if (e.type === 'system') return h('li', { class: 'is-system' }, h('span', { class: 'text' }, e.text), ' ', time);
      if (e.type === 'chat') {
        return h('li', null, h('div', { class: 'meta' }, h('strong', null, e.name), time), h('div', { class: 'text' }, e.text));
      }
      if (e.type === 'guess') {
        return h('li', { class: e.correct ? 'is-correct' : 'is-no' },
          h('div', { class: 'meta' }, h('strong', null, e.name),
            h('span', { class: `verdict ${e.correct ? 'correct' : 'no'}` }, e.correct ? 'richtig' : 'falsch'), time),
          h('div', { class: 'text' }, `tippt auf ${e.championName}`));
      }
      // Frage
      const status = e.status;
      const cls = status === 'yes' ? 'is-yes' : status === 'no' ? 'is-no' : null;
      const vClass = status === 'yes' ? 'yes' : status === 'no' ? 'no' : status === 'pending' ? 'pending' : 'other';
      let detail = null;
      if (e.answers && e.answers.length) {
        detail = h('div', { class: 'answers' }, e.answers.map((a) => `${a.name}: ${a.answer === 'yes' ? 'Ja' : 'Nein'}`).join(', '));
      } else if (status === 'pending') {
        detail = h('div', { class: 'answers' }, `${(e.answeredIds || []).length} Antwort(en) bisher`);
      }
      return h('li', { class: cls },
        h('div', { class: 'meta' }, h('strong', null, e.askerName),
          h('span', { class: `verdict ${vClass}` }, verdictLabel[status] || status), time),
        h('div', { class: 'text q-text' }, e.text), detail);
    });
    log.replaceChildren(...items);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function renderScores() {
    const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name, 'de'));
    $('scores').replaceChildren(...sorted.map((p, i) =>
      h('li', null,
        h('span', { class: 'rank' }, `${i + 1}.`),
        h('span', { class: `name${p.isYou ? ' is-you' : ''}` }, p.name, p.playing || state.phase === 'roundEnd' ? '' : ' (schaut zu)'),
        h('span', { class: 'pts' }, String(p.totalScore)))));
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
      $('rejoin-text').textContent = `Du warst zuletzt in Raum ${recovery.code}${recovery.name ? ` als ${recovery.name}` : ''}.`;
      $('rejoin-box').hidden = false;
      $('rejoin-btn').addEventListener('click', () => {
        session = recovery;
        saveSession(session);
        if (socket.connected) resume();
      });
      $('rejoin-dismiss').addEventListener('click', () => {
        safe(() => localStorage.removeItem(SESSION_KEY));
        $('rejoin-box').hidden = true;
      });
    }
  }
  loadChampions();
})();
