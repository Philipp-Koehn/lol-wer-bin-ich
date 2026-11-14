# LoL – Wer bin ich?

Multiplayer-Ratespiel im Browser. Jeder Spieler bekommt zufällig einen
League-of-Legends-Champion. Alle sehen die Champions der anderen, nur den
eigenen nicht. Reihum stellt man Ja/Nein-Fragen, bis man seinen Champion errät.

## Starten

Voraussetzung: Node.js 18.17 oder neuer.

```bash
npm install && npm start
```

Danach http://localhost:3000 öffnen. Der Port lässt sich mit der Umgebungsvariable
`PORT` ändern. Freunde im selben Netz erreichen das Spiel über die IP des
Rechners (z. B. `http://192.168.1.20:3000`), sofern die Firewall den Port freigibt.

## Spielregeln

- Der Host erstellt einen Raum und teilt den 5-stelligen Raumcode oder den Einladungslink.
- Ab 2 Spielern startet der Host die Runde. Jeder bekommt einen anderen Champion.
- Wer dran ist, tippt eine Frage ein. **Alle verbundenen Mitspieler müssen antworten.
  Die Mehrheit entscheidet, bei Gleichstand zählt Nein.**
- Bei Ja fragt man weiter, bei Nein ist der Nächste dran.
- Im eigenen Zug kann man jederzeit raten (Suchfeld mit Autovervollständigung).
  Richtig: man ist raus, wird platziert und der Champion wird aufgedeckt.
  Falsch: zählt wie ein Nein.
- Punkte beim Erraten: 100 − 5 pro Frage − 10 pro Fehltipp, mindestens 10.
  Wer als Letzter übrig bleibt, bekommt 0. Die Punkte summieren sich über alle Runden.
- Der Host kann eine laufende Runde neu starten (die Punkte dieser Runde verfallen).

Verbindungsabbrüche: Ein Reload holt den Spieler automatisch zurück. Ist der
Spieler am Zug länger als 20 Sekunden weg, geht der Zug weiter. Nach 3 Minuten
ohne Verbindung wird er aus dem Raum entfernt. Wurde der Tab geschlossen, bietet
die Startseite „Wieder beitreten“ an. Verlässt der Host den Raum, wird der
nächste Spieler Host.

## Champion-Daten

Beim Start lädt der Server die neueste Version von Riot Data Dragon
(`api/versions.json` → `cdn/<version>/data/de_DE/champion.json`) und
aktualisiert sie alle 12 Stunden. Ist Data Dragon nicht erreichbar, nutzt er
den letzten Cache in `data/champions-cache.json` und sonst die mitgelieferte
Liste `server/fallback-champions.json`. Bilder kommen direkt vom Data-Dragon-CDN;
fehlen sie, zeigt die Karte die Initialen.

## Hosting (Render, Railway o. ä.)

- Build-Befehl: `npm install`, Start-Befehl: `npm start`.
- Der Server liest `PORT` aus der Umgebung, das setzen die Anbieter automatisch.
- WebSockets müssen erlaubt sein (bei Render und Railway Standard).
- Nur **eine** Instanz betreiben: Spielstand und Rate Limits liegen im Speicher.
  Bei einem Neustart (z. B. Deploy oder Einschlafen im Gratis-Tarif) sind offene Räume weg.
- Optionale Variablen: `TURN_SKIP_MS` (Standard 20000), `RECONNECT_WINDOW_MS` (Standard 180000).

## Sicherheit

- Der Server ist autoritativ und schickt jedem Client eine eigene Sicht. Der eigene
  Champion wird erst nach dem Erraten oder am Rundenende übertragen.
- Alle Eingaben werden serverseitig geprüft, bereinigt und gekürzt
  (Name 20, Frage 140, Chat 200 Zeichen). Socket-Nachrichten über 4 KB werden verworfen.
- Rate Limits pro Verbindung (Fragen, Chat, Aktionen, Beitreten) und pro IP für neue Räume.
- Der Client setzt fremde Texte nur per `textContent`; dazu eine strikte
  Content-Security-Policy ohne Inline-Skripte.

## Tests

```bash
npm test                     # Spiellogik (node:test)
```

End-to-End mit Playwright (Python), drei Spieler in getrennten Browser-Kontexten:

```bash
pip install playwright && python -m playwright install chromium
TURN_SKIP_MS=3000 PORT=3210 npm start          # in einem zweiten Terminal
BASE_URL=http://localhost:3210 python test/e2e_game.py
```

Der Test legt Screenshots in `screenshots/` ab.

## Aufbau

```
server/index.js       Express, Socket.IO, Validierung, Rate Limits, Timer
server/game.js        Spiellogik eines Raums (ohne Netzwerk, testbar)
server/champions.js   Data-Dragon-Loader mit Cache und Fallback
server/rate-limit.js  Sliding-Window-Limiter
public/               Frontend (HTML, CSS, JS ohne Build-Schritt)
test/                 Unit- und E2E-Tests
```

League of Legends und alle Champion-Bilder sind Eigentum von Riot Games.
Dieses Projekt ist nicht von Riot Games unterstützt.
