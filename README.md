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
- Optionale Variablen:

| Variable | Standard | Zweck |
| --- | --- | --- |
| `PUBLIC_URL` | – | Öffentliche Adresse, z. B. `https://wer-bin-ich.example`. Wird für Link-Vorschau (Open Graph), Canonical, `robots.txt` und `sitemap.xml` genutzt und als Socket-Origin erlaubt. Fehlt sie, nimmt der Server `RENDER_EXTERNAL_URL` bzw. `RAILWAY_PUBLIC_DOMAIN` (setzen die Anbieter selbst), sonst den Host der Anfrage. |
| `TRUST_PROXY` | `1` | Anzahl der Proxys vor dem Server. Render/Railway: `1`. Direkt im LAN ohne Proxy: `0`, sonst kann ein Client per `X-Forwarded-For` eine andere IP vortäuschen und die IP-Limits umgehen. |
| `ALLOWED_ORIGINS` | – | Weitere erlaubte Origins für Socket-Verbindungen (kommagetrennt), z. B. eine zweite Domain. |
| `TURN_SKIP_MS` | `20000` | Zug eines getrennten Spielers überspringen nach … ms |
| `RECONNECT_WINDOW_MS` | `180000` | Getrennten Spieler entfernen nach … ms |

Die Link-Vorschau (WhatsApp, Discord, Telegram) zeigt `public/og-image.jpg` (1200×630).
Neu erzeugen nach Design-Änderungen: `python tools/og-image/generate.py` (Playwright nötig),
das Skript rendert auch Favicons und App-Icons.

## Performance

- Statische Dateien liegen nach dem Start im Speicher, vorkomprimiert mit Brotli und Gzip,
  mit ETag. Verweise in `index.html` tragen einen Inhalts-Hash (`?v=…`) und dürfen ein Jahr
  im Browser-Cache bleiben; `index.html` selbst wird immer revalidiert. **Nach Änderungen in
  `public/` den Server neu starten.**
- Schriften (Marcellus, Spline Sans; SIL Open Font License, siehe `public/fonts/`) liegen lokal:
  keine Anfrage an Google, kein fremdes Render-Blocking-CSS.
- Socket.IO-Client in der minifizierten Fassung unter `/vendor/`, Skripte mit `defer`.
- Champion-Bilder: `width`/`height` gegen Layout-Sprünge, `loading="lazy"`, `decoding="async"`,
  Verbindung zum CDN wird beim Betreten eines Raums vorab aufgebaut.

Messung (lokal, Lighthouse 12 Performance, Startseite):

| | vorher | nachher |
| --- | --- | --- |
| Mobil: Score / FCP / LCP | 92 / 2,7 s / 2,8 s | 100 / 0,8 s / 1,9 s |
| Desktop: Score / FCP / LCP | 99 / 0,8 s / 0,8 s | 100 / 0,2 s / 0,5 s |
| Übertragen (kalter Cache) | 212 KB, 8 Anfragen, 3 Hosts | 102 KB, 7 Anfragen, 1 Host |
| Cache-Dauer CSS/JS | 1 h, danach neu laden | 1 Jahr (versionierte URL), HTML per ETag |

## Sicherheit

- Der Server ist autoritativ und schickt jedem Client eine eigene Sicht. Der eigene
  Champion wird erst nach dem Erraten oder am Rundenende übertragen.
- Alle Eingaben werden serverseitig geprüft, bereinigt und gekürzt
  (Name 20, Frage 140, Chat 200 Zeichen). Socket-Nachrichten über 4 KB werden verworfen.
- Rate Limits pro Verbindung (Fragen, Chat, Aktionen, Beitreten) und pro IP
  (10 neue Räume / 10 min, 20 falsche Raumcodes / 10 min, 60 neue Verbindungen / min).
- Ressourcen-Obergrenzen: 500 Räume, 10 Spieler pro Raum, 200 Verlaufseinträge pro Raum,
  2000 gleichzeitige Verbindungen, davon höchstens 40 pro IP. Verlassene Räume werden
  nach 3 Minuten (Spieler) bzw. 60 Minuten (leerer Raum) aufgeräumt.
- Socket.IO nimmt nur Verbindungen von der eigenen Seite an (Origin-Prüfung gegen
  Cross-Site-WebSocket-Hijacking), CORS ist nicht freigegeben, der Client wird nicht von
  Socket.IO selbst ausgeliefert.
- Der Client setzt fremde Texte nur per `textContent`; dazu eine strikte
  Content-Security-Policy ohne Inline-Skripte und Fremd-Origins (außer dem Bild-CDN),
  mit Trusted Types. Weitere Header: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP, HSTS (nur über HTTPS).
- Statische Dateien kommen aus einer festen Liste im Speicher (kein Dateisystemzugriff
  pro Anfrage). Header-Timeouts gegen langsame Verbindungen. `npm audit`: 0 Funde.

Bewusst akzeptierte Risiken:

- **Kein Konto, kein Kick:** Wer den Raumcode kennt, kann beitreten (bis 10 Spieler).
  Codes haben 32⁵ ≈ 33,5 Mio. Kombinationen, Fehlversuche sind pro IP begrenzt; Raten
  über viele IPs bleibt theoretisch möglich.
- **Keine Abwehr gegen verteilte Angriffe (DDoS):** Die Limits gelten pro IP und
  Prozess. Gegen Angriffe aus vielen Netzen hilft nur der Hosting-Anbieter bzw. ein
  vorgeschaltetes CDN/WAF.
- **Nicht-Browser-Clients ohne Origin-Header** werden zugelassen; für sie greifen die
  Rate- und Verbindungs-Limits, der Server bleibt autoritativ.
- **Ohne `PUBLIC_URL`** stammen die absoluten URLs der Link-Vorschau aus dem Host-Header
  (auf einfache Hostnamen geprüft, HTML-escaped, `Vary: Host`, nur privat cachebar).
  Für öffentliches Hosting `PUBLIC_URL` setzen.
- **Spielernamen** werden bereinigt, aber nicht auf Ähnlichkeit geprüft (z. B. kyrillische
  Doppelgänger-Buchstaben).
- Champion-Bilder lädt der Browser direkt vom Riot-CDN (`ddragon.leagueoflegends.com`);
  dabei sieht Riot die IP-Adresse der Spieler.

## Tests

```bash
npm test                     # Spiellogik, Auslieferung, Origin-Prüfung (node:test)
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
server/static.js      Statische Dateien aus dem Speicher (Brotli/Gzip, ETag, Cache-Header)
server/public-url.js  Öffentliche Basis-URL, Host- und Origin-Prüfung
public/               Frontend (HTML, CSS, JS ohne Build-Schritt), Schriften, Icons
test/                 Unit- und E2E-Tests
tools/og-image/       Erzeugt Open-Graph-Bild und Icons
```

League of Legends und alle Champion-Bilder sind Eigentum von Riot Games.
Dieses Projekt ist nicht von Riot Games unterstützt.
