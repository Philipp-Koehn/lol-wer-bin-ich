"""Erzeugt public/og-image.jpg (1200x630, Link-Vorschau), PNG-Icons und favicon.ico
lokal per Chromium (Playwright). Nur bei Design-Änderungen nötig:

    pip install playwright && python -m playwright install chromium
    python tools/og-image/generate.py
"""
import os
import pathlib
import struct
import tempfile

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
PUB = HERE.parent.parent / "public"

html = (HERE / "og.html").read_text(encoding="utf-8").replace("FONTDIR", (PUB / "fonts").as_uri())
BUILT = pathlib.Path(tempfile.mkdtemp()) / "og.html"
BUILT.write_text(html, encoding="utf-8")
svg = (PUB / "favicon.svg").read_text(encoding="utf-8")


def icon_page(size, pad=0.0):
    inner = size * (1 - 2 * pad)
    return f"""<!doctype html><html><body style="margin:0;width:{size}px;height:{size}px;background:#06101E;display:grid;place-items:center;overflow:hidden">
    <div style="width:{inner}px;height:{inner}px">{svg.replace('<svg ', f'<svg width="{inner}" height="{inner}" ')}</div></body></html>"""


def build_ico(pngs):
    # ICO mit eingebetteten PNGs (ab Windows Vista / allen aktuellen Browsern unterstützt)
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for size, data in pngs:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    return header + entries + blobs


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 630})
    page.goto(BUILT.as_uri())
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(300)
    page.screenshot(path=str(PUB / "og-image.jpg"), type="jpeg", quality=90)

    def render_icon(size, pad=0.0):
        p = browser.new_page(viewport={"width": size, "height": size})
        p.set_content(icon_page(size, pad))
        data = p.screenshot()
        p.close()
        return data

    (PUB / "apple-touch-icon.png").write_bytes(render_icon(180, 0.08))
    (PUB / "icon-192.png").write_bytes(render_icon(192))
    (PUB / "icon-512.png").write_bytes(render_icon(512))
    (PUB / "icon-maskable-512.png").write_bytes(render_icon(512, 0.12))
    (PUB / "favicon.ico").write_bytes(build_ico([(16, render_icon(16)), (32, render_icon(32)), (48, render_icon(48))]))
    browser.close()

for f in ("og-image.jpg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "favicon.ico"):
    print(f, os.path.getsize(PUB / f))
