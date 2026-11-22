"""End-to-end tests of the HTML player (Playwright, file:// URLs).

Browsers: TOUYING_BROWSERS=chromium,firefox,webkit (default: chromium).
"""

import io
import os
import re
import time

import pytest

typst = pytest.importorskip("typst")
sync_api = pytest.importorskip("playwright.sync_api")
PIL = pytest.importorskip("PIL")
from PIL import Image, ImageChops, ImageStat  # noqa: E402

from touying.html_player import export_html  # noqa: E402
from helpers import diff as _diff, open_deck, states  # noqa: E402

def test_basic_states(browser, export, scene_deck):
    html, stats = export(scene_deck("basic"))
    page = open_deck(browser, html)
    assert page.evaluate("touying.count") == 4
    page.evaluate("touying.goto(0, 'start')")
    s = states(page, 0)
    # visible: auto hides objects that are introduced by create/write.
    assert s["curve"]["opacity"] == 0 and s["axes"]["draw"] == 0
    assert s["eq"]["reveal"] == 0
    s = states(page, 0.75)  # half of write's 1.5 s, smooth(0.5) == 0.5
    assert s["eq"]["reveal"] == pytest.approx(0.5, abs=1e-3)
    s = states(page, 10)
    assert all(o["draw"] == 1 and o["reveal"] == 1 for o in s.values())
    # Segment 3: eq crossfades into eq2.
    page.evaluate("touying.goto(2, 'end')")
    s = states(page, 10)
    assert s["eq"]["opacity"] == 0 and s["eq2"]["opacity"] == 1
    # Tracker knots: lifted out of the page, exactly one mounted at a time.
    page.evaluate("touying.goto(1, 'start'); touying.seek(1.7)")
    assert page.evaluate("document.querySelectorAll('[data-typst-label^=\"tys-s1-gd-dot-k\"]').length") == 0
    assert page.evaluate(
        "touying.player.scenes[0].objects.find(o => o.rec.id === 'dot').inner.childElementCount"
    ) == 1
    assert page.errors == []
    page.close()


@pytest.mark.parametrize("width", [960, 1600])
def test_render_parity_with_pdf(browser, export, scene_deck, touying_root, width):
    deck = scene_deck("parity")
    html, _ = export(deck)
    svg = typst.compile(str(deck), root=str(touying_root), format="svg")
    svg = (svg[0] if isinstance(svg, list) else svg).decode()
    w_pt = float(re.search(r'width="([0-9.]+)pt"', svg).group(1))
    png = typst.compile(str(deck), root=str(touying_root), format="png", ppi=width / (w_pt / 72))
    ref = Image.open(io.BytesIO(png[0] if isinstance(png, list) else png)).convert("RGB")
    page = open_deck(browser, html, viewport=ref.size)
    page.evaluate("touying.goto(0, 'end')")
    end = Image.open(io.BytesIO(page.screenshot()))
    page.evaluate("touying.goto(0, 'start')")
    start = Image.open(io.BytesIO(page.screenshot()))
    mean, big = _diff(ref, end)
    _, big_start = _diff(ref, start)
    assert mean < 0.6 and big < 0.002, (mean, big)
    assert big_start > 0.005  # the metric does detect a wrong state
    page.close()


def test_lifecycle_contract(browser, export, scene_deck):
    html, _ = export(scene_deck("lifecycle"))
    page = open_deck(browser, html)
    js = page.evaluate
    # Page 1: scene A plays on load; B has not started (covered, so absent).
    assert js("touying.activations") == 1 and js("touying.playing")
    assert js("touying.player.scenes.map(s => s.rec.scene.key)") == ["s1-a"]
    js("touying.next()")  # click during playback finishes it
    assert not js("touying.playing") and js("touying.page") == 0
    js("touying.next()")  # A segment 2 and B segment 1 share the click
    assert js("touying.page") == 1 and js("touying.activations") == 2
    assert js("touying.player.scenes.map(s => s.rec.lifecycle)") == ["active", "active"]
    js("touying.player.finish(); touying.next()")
    assert js("touying.player.scenes.map(s => s.rec.lifecycle)") == ["held", "active"]
    js("touying.player.finish(); touying.next()")  # the #pause page: both held
    assert js("touying.page") == 3 and js("touying.duration") == 0
    assert js("touying.activations") == 3  # a held page never replays
    js("touying.prev()")  # back: terminal state, no replay
    assert js("touying.page") == 2 and not js("touying.playing")
    assert js("touying.activations") == 3
    assert states(page, 0, "s1-b")["y"]["opacity"] == 0  # seek is stateless
    js("touying.goto(2, 'end')")
    assert states(page, 99, "s1-b")["y"]["opacity"] == 1
    # Tab suspension: scene time stands still while hidden.
    js("touying.goto(1, 'play')")
    page.wait_for_timeout(150)
    js(
        "Object.defineProperty(document, 'hidden', {value: true, configurable: true});"
        "document.dispatchEvent(new Event('visibilitychange'))"
    )
    before = js("touying.player.time")
    page.wait_for_timeout(600)
    js(
        "Object.defineProperty(document, 'hidden', {value: false, configurable: true});"
        "document.dispatchEvent(new Event('visibilitychange'))"
    )
    page.wait_for_timeout(100)
    after = js("touying.player.time")
    assert after - before < 0.4, (before, after)
    assert page.errors == []
    page.close()


def test_tracker_size_and_frames(browser, export, scene_deck):
    html, stats = export(scene_deck("tracker"))
    page = open_deck(browser, html)
    nodes = page.evaluate("touying.goto(1, 'start'), document.querySelectorAll('#tys-stage *').length")
    frames = page.evaluate(
        """() => new Promise(resolve => {
            const ts = [];
            touying.goto(1, 'play');
            const tick = (t) => { ts.push(t); if (touying.playing) requestAnimationFrame(tick); else resolve(ts); };
            requestAnimationFrame(tick);
        })"""
    )
    deltas = sorted(b - a for a, b in zip(frames, frames[1:]))
    p95 = deltas[int(len(deltas) * 0.95)] if deltas else 0
    print(
        f"\ntracker deck: {stats['raw_svg_bytes'] / 1024:.0f} KiB SVG -> "
        f"{stats['html_bytes'] / 1024:.0f} KiB HTML, export {stats['export_seconds']:.2f}s, "
        f"{nodes} DOM nodes, {len(frames)} frames, p95 frame {p95:.1f} ms"
    )
    assert stats["html_bytes"] < 250 * 1024
    assert p95 < 50
    assert page.errors == []
    page.close()


def test_sample_budget_is_an_error(touying_root, tmp_path):
    deck = tmp_path / "budget.typ"
    deck.write_text(
        f'#import "{touying_root.as_posix()}/lib.typ": *\n'
        "#import themes.simple: *\n"
        "#show: simple-theme.with(config-scene(max-samples: 10))\n"
        "#let sc = touying-scene\n"
        "== Budget\n"
        "#sc.scene(width: 4cm, height: 2cm,\n"
        "  objects: (t: sc.tracked(x: 0, v => sc.obj(at: (1, 1))[#v.x])),\n"
        "  timeline: (sc.set-value(\"t\", x: 1, run-time: 2),))\n"
    )
    with pytest.raises(typst.TypstError, match="samples"):
        export_html(str(deck), output=str(tmp_path / "b.html"), root="/", silent=True)
