"""
End-to-End-Test: drei Spieler in getrennten Browser-Kontexten spielen eine
komplette Runde. Aufruf (Server muss laufen oder per with_server.py):

    python test/e2e_game.py            # BASE_URL=http://localhost:3000

Geprüft wird u. a.:
  * eigener Champion taucht nie in den Socket-Payloads des eigenen Clients auf
  * Ja -> Fragender bleibt dran, Gleichstand -> Nein -> nächster Spieler
  * falscher Tipp -> nächster, richtiger Tipp -> Platzierung + Aufdecken
  * Reconnect per Reload, Rangliste/Punkte, Neustart, Verlassen
  * XSS-Name wird als Text dargestellt, Rate Limit greift
  * Screenshots Lobby/Spiel/Rundenende auf Desktop und Handy-Breite
"""
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://localhost:3000")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screenshots")
os.makedirs(OUT, exist_ok=True)
expect.set_options(timeout=8000)

DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}
RESULTS = []


def check(cond, label):
    RESULTS.append((bool(cond), label))
    print(("  OK   " if cond else "  FAIL ") + label)
    if not cond:
        raise AssertionError(label)


def split_packets(raw):
    """Socket.IO/Engine.IO-Pakete aus WebSocket-Frames oder Polling-Bodys."""
    for part in raw.split("\x1e"):
        m = re.match(r"^4[23]\d*(\[.*\])$", part, re.S)
        if m:
            try:
                yield json.loads(m.group(1))
            except ValueError:
                pass


def contains_value(obj, needles, substrings):
    if isinstance(obj, str):
        return obj in needles or any(s in obj for s in substrings)
    if isinstance(obj, dict):
        return any(contains_value(v, needles, substrings) for v in obj.values())
    if isinstance(obj, list):
        return any(contains_value(v, needles, substrings) for v in obj)
    return False


class Player:
    def __init__(self, browser, name, viewport, mobile=False):
        self.name = name
        opts = {"viewport": viewport}
        if mobile:
            opts.update(device_scale_factor=2, is_mobile=True, has_touch=True)
        self.ctx = browser.new_context(**opts)
        self.page = self.ctx.new_page()
        self.raw = []
        self.errors = []
        self.dialogs = []
        self.id = None
        self.page.on("websocket", lambda ws: ws.on("framereceived", self._frame))
        self.page.on("response", self._response)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.on("console", lambda m: m.type == "error" and self.errors.append(f"console: {m.text}"))
        self.page.on("dialog", self._dialog)

    def _frame(self, payload):
        if isinstance(payload, str):
            self.raw.append(payload)

    def _response(self, res):
        if "/socket.io/" in res.url and "transport=polling" in res.url and res.request.method == "GET":
            try:
                self.raw.append(res.text())
            except Exception:
                pass

    def _dialog(self, dialog):
        self.dialogs.append(dialog.message)
        # Bestätigungen (Verlassen/Neustart) akzeptieren; alert() wäre ein XSS-Treffer.
        dialog.accept()

    def payloads(self, since=0):
        for raw in self.raw[since:]:
            yield from split_packets(raw)

    def new_page(self):
        """Simuliert Tab schließen und neu öffnen (sessionStorage ist dann leer)."""
        self.page.close()
        self.page = self.ctx.new_page()
        self.page.on("websocket", lambda ws: ws.on("framereceived", self._frame))
        self.page.on("response", self._response)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.on("console", lambda m: m.type == "error" and self.errors.append(f"console: {m.text}"))
        self.page.on("dialog", self._dialog)

    def card(self, pid):
        return self.page.locator(f'li.card[data-player-id="{pid}"]')


def assert_no_leak(player, champ, label, since=0):
    needles = {champ["id"], champ["name"]}
    subs = [f"/{champ['id']}.png"]
    packets = list(player.payloads(since))
    leaks = [p for p in packets if contains_value(p, needles, subs)]
    check(packets and not leaks,
          f"{label}: eigener Champion ({champ['name']}) nicht in {len(packets)} Paketen an {player.name}")
    own = player.page.locator("li.card.is-you")
    check(own.get_attribute("data-champion-id") is None, f"{label}: eigene Karte von {player.name} verdeckt")


def current_id(page):
    return page.locator("li.card.is-turn").get_attribute("data-player-id")


def wait_turn(players, pid):
    for p in players:
        expect(p.page.locator(f'li.card.is-turn[data-player-id="{pid}"]')).to_have_count(1)


def ask(player, text):
    player.page.fill("#ask-input", text)
    player.page.click("#ask-form button[type=submit]")


def answer(player, value):
    btn = player.page.locator("#yes-btn" if value == "yes" else "#no-btn")
    expect(btn).to_be_visible()
    btn.click()


def guess(player, champ):
    page = player.page
    expect(page.locator("#guess-input")).to_be_visible()
    page.fill("#guess-input", "")
    page.locator("#guess-input").press_sequentially(champ["name"][:-1] if len(champ["name"]) > 3 else champ["name"], delay=20)
    option = page.locator(f'#guess-list [id="opt-{champ["id"]}"]')
    expect(option).to_be_visible()
    option.click()
    expect(page.locator("#guess-btn")).to_be_enabled()
    page.click("#guess-btn")


def shot(player, name):
    path = os.path.join(OUT, name)
    player.page.screenshot(path=path, full_page=True)
    print(f"  shot {path}")


def no_horizontal_scroll(player, label):
    ok = player.page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
    check(ok, f"{label}: kein horizontales Scrollen bei {player.page.viewport_size['width']}px")


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel=os.environ.get("PW_CHANNEL") or None)
        ana = Player(browser, "Ana", DESKTOP)
        ben = Player(browser, "Ben", DESKTOP)
        cleo = Player(browser, "<i>Cleo</i>", MOBILE, mobile=True)
        players = [ana, ben, cleo]

        print("Startseite und Lobby")
        ana.page.goto(BASE)
        ana.page.wait_for_load_state("networkidle")
        expect(ana.page.locator("#data-note")).to_contain_text("Champions")
        shot(ana, "01-start-desktop.png")
        ana.page.fill("#name-input", ana.name)
        ana.page.click("#create-form button")
        expect(ana.page.locator("#screen-lobby")).to_be_visible()
        code = ana.page.locator("#lobby-code").inner_text().strip()
        check(re.fullmatch(r"[A-Z2-9]{5}", code), f"Raumcode erzeugt ({code})")
        champions = ana.page.evaluate("fetch('/api/champions').then(r => r.json())")["champions"]
        by_id = {c["id"]: c for c in champions}
        check(len(champions) > 150, f"Champion-Liste geladen ({len(champions)})")

        for p in (ben, cleo):
            p.page.goto(f"{BASE}/?raum={code}")
            p.page.wait_for_load_state("networkidle")
            check(p.page.input_value("#code-input") == code, f"{p.name}: Code aus Einladungslink vorausgefüllt")
            p.page.fill("#name-input", p.name)
            p.page.click("#join-form button")
            expect(p.page.locator("#screen-lobby")).to_be_visible()

        for p in players:
            expect(p.page.locator("#lobby-players li")).to_have_count(3)
        check(cleo.page.locator("#lobby-players i").count() == 0, "XSS: Name mit HTML wird nicht als HTML gerendert")
        expect(ana.page.locator("#lobby-players")).to_contain_text("<i>Cleo</i>")
        check(ben.page.locator("#start-btn").is_hidden(), "Nur der Host sieht 'Runde starten'")
        shot(ana, "02-lobby-desktop.png")
        shot(cleo, "03-lobby-mobile.png")
        no_horizontal_scroll(cleo, "Lobby mobil")

        print("Runde 1 startet")
        ana.page.click("#start-btn")
        for p in players:
            expect(p.page.locator("#screen-game")).to_be_visible()
            expect(p.page.locator("li.card")).to_have_count(3)
            p.id = p.page.locator("li.card.is-you").get_attribute("data-player-id")
        by_pid = {p.id: p for p in players}

        # Champion jedes Spielers aus Sicht eines anderen ermitteln
        champ_of = {}
        for p in players:
            other = next(o for o in players if o is not p)
            cid = other.card(p.id).get_attribute("data-champion-id")
            champ_of[p.id] = by_id[cid]
            expect(p.page.locator("li.card.is-you [data-testid=champ-name]")).to_have_text("Wer bin ich?")
        check(len({c["id"] for c in champ_of.values()}) == 3, "Drei verschiedene Champions verteilt")
        for p in players:
            assert_no_leak(p, champ_of[p.id], "Rundenstart")

        order = [ana.id, ben.id, cleo.id]
        first = by_pid[current_id(ana.page)]
        i = order.index(first.id)
        second = by_pid[order[(i + 1) % 3]]
        third = by_pid[order[(i + 2) % 3]]
        others = lambda x: [p for p in players if p is not x]
        print(f"Reihenfolge: {first.name} -> {second.name} -> {third.name}")

        print("Ja: Fragender bleibt dran")
        expect(first.page.locator("#ask-form")).to_be_visible()
        ask(first, "Bin ich ein Mage?")
        for p in others(first):
            expect(p.page.locator("#answer-question")).to_have_text("Bin ich ein Mage?")
        check(first.page.locator("#answer-box").is_hidden(), "Fragender bekommt keine Ja/Nein-Buttons")
        for p in others(first):
            answer(p, "yes")
        expect(first.page.locator("#log li.is-yes")).to_have_count(1)
        wait_turn(players, first.id)
        check(current_id(second.page) == first.id, "Nach Ja ist derselbe Spieler weiter dran")

        print("Gleichstand zählt als Nein: Zug geht weiter")
        ask(first, "Kann ich fliegen?")
        o1, o2 = others(first)
        expect(o1.page.locator("#yes-btn")).to_be_visible()
        expect(cleo.page.locator("#answer-progress")).to_be_visible()
        shot(ana, "04-spiel-frage-desktop.png")
        shot(cleo, "05-spiel-frage-mobile.png")
        no_horizontal_scroll(cleo, "Spiel mobil")
        answer(o1, "yes")
        expect(o2.page.locator("#answer-progress")).to_contain_text("Antworten 1 von 2")
        answer(o2, "no")
        wait_turn(players, second.id)
        expect(ana.page.locator("#log li.is-no")).to_have_count(1)
        expect(ana.page.locator("#log li.is-no")).to_contain_text(f"{o1.name}: Ja")
        check(True, "Nach 1x Ja / 1x Nein ist der nächste Spieler dran (Gleichstand = Nein)")

        print("Falscher Tipp")
        taken = {c["id"] for c in champ_of.values()}
        wrong = next(c for c in champions if c["id"] not in taken)
        guess(second, wrong)
        wait_turn(players, third.id)
        expect(ana.page.locator("#log")).to_contain_text(f"tippt auf {wrong['name']}")
        check(second.page.locator("li.card.is-you").get_attribute("data-champion-id") is None, "Nach Fehltipp bleibt eigene Karte verdeckt")

        print("Richtiger Tipp")
        assert_no_leak(third, champ_of[third.id], "vor dem Erraten")
        guess(third, champ_of[third.id])
        expect(third.page.locator("li.card.is-you")).to_have_attribute("data-champion-id", champ_of[third.id]["id"])
        expect(third.page.locator("li.card.is-you .badge-place")).to_have_text("#1")
        check(True, f"{third.name} hat richtig geraten, Karte aufgedeckt, Platz 1")
        wait_turn(players, first.id)
        check(True, "Nach richtigem Tipp ist der nächste ungelöste Spieler dran")

        print("Reconnect per Reload")
        before = len(first.raw)
        first.page.reload()
        first.page.wait_for_load_state("networkidle")
        expect(first.page.locator("#screen-game")).to_be_visible()
        wait_turn([first], first.id)
        check(first.page.locator("li.card.is-you").get_attribute("data-player-id") == first.id, "Gleiche Identität nach Reload")
        check(len(first.raw) > before, "Nach Reload neue Frames empfangen")
        assert_no_leak(first, champ_of[first.id], "nach Reconnect")

        print("Zweiter richtiger Tipp beendet die Runde")
        guess(first, champ_of[first.id])
        for p in players:
            expect(p.page.locator("#round-end")).to_be_visible()
            expect(p.page.locator("#round-ranking li")).to_have_count(3)
        ranking = [t.strip() for t in ana.page.locator("#round-ranking li").all_inner_texts()]
        check(third.name in ranking[0] and "+100" in ranking[0], f"Platz 1: {third.name} mit 100 Punkten (0 Fragen)")
        check(first.name in ranking[1] and "+90" in ranking[1], f"Platz 2: {first.name} mit 90 Punkten (2 Fragen)")
        check(second.name in ranking[2] and "+0" in ranking[2], f"Platz 3: {second.name} mit 0 Punkten (übrig geblieben)")
        expect(second.page.locator("li.card.is-you")).to_have_attribute("data-champion-id", champ_of[second.id]["id"])
        check(True, "Nach Rundenende sieht auch der Letzte seinen Champion")
        scores = ana.page.locator("#scores li").all_inner_texts()
        check(third.name in scores[0] and scores[0].strip().endswith("100"), "Gesamtrangliste führt mit 100")
        check(not ben.page.locator("#next-round-btn").is_visible() or ben is ana, "Nur Host sieht 'Nächste Runde'")
        ana.page.wait_for_timeout(900)  # Aufdeck-Animation abwarten
        shot(ana, "06-rundenende-desktop.png")
        shot(cleo, "07-rundenende-mobile.png")

        print("Runde 2 und Neustart")
        marks = {p.name: len(p.raw) for p in players}
        ana.page.click("#next-round-btn")
        for p in players:
            expect(p.page.locator("#round-label")).to_have_text("Runde 2")
            expect(p.page.locator("li.card.is-you [data-testid=champ-name]")).to_have_text("Wer bin ich?")
        check(first is ana and current_id(ana.page) == ben.id, "Startspieler rotiert (Runde 1: Ana, Runde 2: Ben)")
        for p in players:
            other = next(o for o in players if o is not p)
            # Runde-1-Champions wurden am Ende aufgedeckt, daher nur Frames seit Rundenstart prüfen.
            assert_no_leak(p, by_id[other.card(p.id).get_attribute("data-champion-id")], "Runde 2", since=marks[p.name])
        shot(ana, "08-runde2-desktop.png")
        shot(cleo, "09-runde2-mobile.png")
        expect(ana.page.locator("#restart-btn")).to_be_visible()
        check(ben.page.locator("#restart-btn").is_hidden(), "Nur Host sieht 'Neu starten'")
        ana.page.click("#restart-btn")
        for p in players:
            expect(p.page.locator("#round-label")).to_have_text("Runde 3")
        expect(ana.page.locator("#log")).to_contain_text("abgebrochen")
        wait_turn(players, cleo.id)
        check(True, "Host startet laufende Runde neu, Runde 3 beginnt mit Cleo")

        print("Raum verlassen (Spieler am Zug)")
        cleo.page.click("#game-leave")
        expect(cleo.page.locator("#screen-home")).to_be_visible()
        for p in (ana, ben):
            expect(p.page.locator("li.card")).to_have_count(2)
            expect(p.page.locator("#scores li")).to_have_count(2)
        wait_turn([ana, ben], ana.id)
        check(True, "Nach Verlassen des Spielers am Zug ist der Nächste dran, Runde läuft weiter")

        print("Disconnect: Zug wird übersprungen, Wiederbeitreten nach Tab-Schließen")
        ana.page.click("#pass-btn")
        wait_turn([ana, ben], ben.id)
        ben.new_page()
        expect(ana.card(ben.id).locator(".tag-off")).to_have_text("getrennt")
        wait_turn([ana], ana.id)  # TURN_SKIP_MS (Test: 3 s)
        check(True, "Zug eines getrennten Spielers wird nach Timeout übersprungen")
        ben.page.goto(BASE)
        expect(ben.page.locator("#rejoin-box")).to_be_visible()
        expect(ben.page.locator("#rejoin-text")).to_contain_text(code)
        ben.page.click("#rejoin-btn")
        expect(ben.page.locator("#screen-game")).to_be_visible()
        check(ben.page.locator("li.card.is-you").get_attribute("data-player-id") == ben.id, "Wiederbeitreten mit gleicher Identität")
        expect(ana.card(ben.id).locator(".tag-off")).to_have_count(0)
        check(ben.page.locator("li.card.is-you").get_attribute("data-champion-id") is None, "Nach Wiederbeitreten bleibt eigener Champion verdeckt")

        print("Sicherheit: Validierung und Rate Limit über rohen Socket")
        result = ben.page.evaluate(
            """async (code) => {
              const big = io({ forceNew: true });
              await new Promise(r => big.on('connect', r));
              const dropped = new Promise(r => big.on('disconnect', () => r(true)));
              big.emit('chat:send', { text: 'x'.repeat(20000) });
              const bigDropped = await Promise.race([dropped, new Promise(r => setTimeout(() => r(false), 3000))]);
              big.disconnect();

              const s = io({ forceNew: true });
              const call = (ev, p) => new Promise(r => s.timeout(3000).emit(ev, p, (e, res) => r(e ? {timeout:true} : res)));
              await new Promise(r => s.on('connect', r));
              const longName = await call('room:create', { name: 'y'.repeat(300) });
              await call('room:leave');
              const bad2 = await call('turn:guess', 'kein-objekt');
              const joined = await call('room:join', { code, name: 'Spammer' });
              let limited = 0;
              for (let i = 0; i < 15; i++) {
                const r = await call('chat:send', { text: 'spam ' + i });
                if (!r.ok && /Zu viele/.test(r.error || '')) limited++;
              }
              const notMyTurn = await call('turn:ask', { text: 'Bin ich dran?' });
              await call('room:leave');
              s.disconnect();
              return { bigDropped, longName, bad2, joined, limited, notMyTurn };
            }""",
            code,
        )
        check(result["bigDropped"], "Übergroße Payload (20 KB) führt zum Verbindungsabbruch")
        check(result["longName"].get("ok") and len(result["longName"]["name"]) == 20, "Überlanger Name wird auf 20 Zeichen gekürzt")
        check(result["bad2"].get("ok") is False, "Nicht-Objekt-Payload wird abgelehnt")
        check(result["joined"].get("ok"), f"Zusätzlicher Client kann beitreten {result['joined']}")
        check(result["limited"] >= 5, f"Chat-Rate-Limit greift ({result['limited']} von 15 abgelehnt)")
        check(result["notMyTurn"].get("ok") is False, "Fragen außerhalb des eigenen Zugs wird abgelehnt")

        print("Fehler in Browser-Konsolen")
        for p in players:
            # 413 stammt vom absichtlichen 20-KB-Paket im Sicherheitstest oben.
            errs = [e for e in p.errors if "favicon" not in e and "413" not in e]
            check(not errs, f"{p.name}: keine JS-/Konsolenfehler {errs[:3]}")
            check(not any("1" == d for d in p.dialogs), f"{p.name}: kein alert() durch XSS")

        browser.close()

    failed = [l for ok, l in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)} / {len(RESULTS)} Prüfungen bestanden")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"\nABBRUCH: {e}")
        sys.exit(1)
