"""Shape morphs (M3): `transform` morphs outlines point by point.

Pages of tests/features/scene/morph-shape: 0 circle->square, 1 ring->disc,
2 one->three, 3 x^2->sin x, 4 open->closed, 5 concurrent rotation,
6 half transparent, 7 strokes under transforms, 8 chains, 9 latency,
10 stroked parts appear.
"""

import io
import random
import re
import statistics

import pytest

pytest.importorskip("typst")
from PIL import Image  # noqa: E402

from helpers import open_deck, region_diff  # noqa: E402

NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


@pytest.fixture(scope="module")
def deck(browser, export, scene_deck):
    html, _ = export(scene_deck("morph-shape"))
    page = open_deck(browser, html)
    yield page
    page.close()


def at(page, index, t):
    page.evaluate(f"touying.goto({index}, 'start'); touying.seek({t})")


def shot(page):
    return Image.open(io.BytesIO(page.screenshot())).convert("RGB")


def morphs(page):
    return page.evaluate("touying.morphs()")


def scene_box(page, pad=4):
    r = page.evaluate(
        "(() => { const r = touying.player.scenes[0].root.getBoundingClientRect();"
        " return [r.left, r.top, r.right, r.bottom]; })()"
    )
    return (r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad)


def overlay_at(page, k, f):
    """Draw the overlays of morph k (and of morphs sharing its window)
    directly at progress f, with their objects hidden."""
    page.evaluate(
        f"""(() => {{
          const all = touying.player.scenes[0].morphs;
          const t0 = all[{k}].rec.t0;
          for (const m of all) {{
            if (m.rec.t0 !== t0 || !m.overlay) continue;
            m.src.xf.style.visibility = 'hidden';
            m.dst.xf.style.visibility = 'hidden';
            m.overlay.style.display = '';
            for (const item of m.items) item({f});
          }}
        }})()"""
    )


def path_numbers(page, k, f):
    return page.evaluate(
        f"""(() => {{
          const m = touying.player.scenes[0].morphs[{k}];
          for (const item of m.items) item({f});
          return [...m.overlay.querySelectorAll('path')].map(p => p.getAttribute('d'));
        }})()"""
    )


ENDPOINT_PAGES = [0, 1, 2, 3, 7, 8, 10]


@pytest.mark.parametrize("index", ENDPOINT_PAGES)
def test_endpoints_are_faithful(deck, index):
    at(deck, index, 0)
    infos = morphs(deck)
    k = next(i for i, m in enumerate(infos) if m["mode"] == "shape")
    rec = deck.evaluate(f"touying.player.scenes[0].morphs[{k}].rec")
    box = scene_box(deck)
    # Source at rest (before the morph) vs the overlay at f = 0.
    at(deck, index, rec["t0"])
    deck.evaluate(f"touying.player.scenes[0].morphs[{k}].clear()")
    deck.evaluate(
        f"touying.player.scenes[0].morphs[{k}].src.apply("
        f"{{...touying.player.scenes[0].morphs[{k}].rec.src, opacity: 1}}, {rec['t0']}, 1e9, touying.player.scenes[0].rec.rates)"
    )
    source = shot(deck)
    at(deck, index, rec["t0"])
    overlay_at(deck, k, 0)
    start = shot(deck)
    worst, frac = region_diff(source, start, box)
    assert frac < 0.005, (index, "start", worst, frac)
    # Target at rest (after the morph) vs the overlay at f = 1.
    at(deck, index, rec["t1"])
    target = shot(deck)
    at(deck, index, (rec["t0"] + rec["t1"]) / 2)
    overlay_at(deck, k, 1)
    end = shot(deck)
    worst, frac = region_diff(target, end, box)
    assert frac < 0.005, (index, "end", worst, frac)
    assert deck.errors == []


@pytest.mark.parametrize("index", [0, 1, 2, 3, 10])
def test_no_jumps_around_half(deck, index):
    at(deck, index, 0.5)
    k = next(i for i, m in enumerate(morphs(deck)) if m["mode"] == "shape")
    ends = [path_numbers(deck, k, f) for f in (0, 1)]
    frames = [path_numbers(deck, k, f) for f in (0.49, 0.5, 0.51)]
    for p in range(len(ends[0])):
        a = [float(x) for x in NUM.findall(ends[0][p])]
        b = [float(x) for x in NUM.findall(ends[1][p])]
        span = max(abs(x - y) for x, y in zip(a, b)) or 1.0
        seq = [[float(x) for x in NUM.findall(fr[p])] for fr in frames]
        for u, v in zip(seq, seq[1:]):
            assert len(u) == len(v)
            jump = max(abs(x - y) for x, y in zip(u, v))
            assert jump <= 0.011 * span + 1e-6, (index, p, jump, span)


def test_pairing_tiers(deck):
    expected = {
        0: {"morph": 1},  # circle -> square
        1: {"morph": 1},  # the ring's hole shrinks inside the pair
        2: {"morph": 1, "grow": 2},
        3: {"morph": 2, "grow": 2},  # x^2 -> sin x
        4: {"fade": 1},  # open -> closed crossfades
        10: {"morph": 1, "grow": 1},
    }
    for index, tiers in expected.items():
        at(deck, index, 0.5)
        info = morphs(deck)[0]
        assert info["mode"] == "shape", (index, info)
        got = {k: v for k, v in info["tiers"].items() if v}
        assert got == tiers, (index, info)


def test_compile_time_eligibility(deck):
    # A concurrent rotation of the target: no shape record, plain crossfade.
    at(deck, 5, 0.5)
    assert morphs(deck) == []
    # A half transparent source: crossfade with the track opacities intact.
    at(deck, 6, 0.5 + 0.5)
    assert morphs(deck) == []
    st = deck.evaluate("touying.states(1)[0].states")
    src = deck.evaluate("touying.player.scenes[0].object('a').xf")
    assert src is not None
    style = deck.evaluate("touying.player.scenes[0].object('a').xf.style.opacity")
    attr = deck.evaluate("touying.player.scenes[0].object('a').xf.getAttribute('opacity')")
    assert style == "" and abs(float(attr) - st["a"]["opacity"]) < 1e-3, (style, attr, st["a"])


def test_strokes_under_transforms(deck):
    at(deck, 7, 0.5)
    a, c = morphs(deck)
    assert a["tiers"]["fade"] == 1  # non-uniformly scaled stroke: crossfade
    assert c["tiers"]["morph"] == 1  # rotated stroke: morphs


def test_chains_hand_over_seamlessly(deck):
    at(deck, 8, 0.5)
    modes = [m["mode"] for m in morphs(deck)]
    assert modes == ["shape", "shape", "overlay", "shape"], modes
    box = scene_box(deck)
    # a -> b ends at 1, b -> c starts at 1.
    at(deck, 8, 1 - 1e-4)
    before = shot(deck)
    at(deck, 8, 1)
    after = shot(deck)
    worst, frac = region_diff(before, after, box)
    assert frac < 0.002, (worst, frac)


def test_random_seeks_match_fresh_renders(deck):
    rng = random.Random(7)
    times = [rng.uniform(0, 5) for _ in range(12)] + [0.5, 1.0, 1.5, 2.0, 3.0, 4.5]
    fresh = {}
    for t in times:
        at(deck, 8, t)
        fresh[t] = shot(deck)
    deck.evaluate("touying.goto(8, 'start')")
    box = scene_box(deck)
    rng.shuffle(times)
    for t in times:
        deck.evaluate(f"touying.seek({t})")
        worst, frac = region_diff(fresh[t], shot(deck), box)
        assert frac < 0.0005, (t, worst, frac)
    assert deck.errors == []


def test_setup_latency(deck):
    samples = []
    for _ in range(5):
        deck.evaluate("touying.goto(9, 'start')")
        ms = deck.evaluate(
            """(() => { const m = touying.player.scenes[0].morphs[0];
                 m.fallback(null); m.ready = false;
                 const t = performance.now(); m.setup(); return performance.now() - t; })()"""
        )
        samples.append(ms)
    info = morphs(deck)[0]
    assert info["mode"] == "shape", info
    med = statistics.median(samples)
    print(f"\nshape morph setup (sum -> closed form): median {med:.1f} ms")
    assert med < 100


def test_parser_forms(deck):
    parse = "touying.shapes.parsePath"
    cases = {
        "M 0 0 L 10 0 H 20 V 10 Z": (1, True, 4),
        "m 0 0 l 10 0 h 10 v 10 z": (1, True, 4),
        "M 0 0 C 1 1 2 2 3 3 S 5 5 6 6": (1, False, 2),
        "M 0 0 Q 5 5 10 0 T 20 0": (1, False, 2),
        "M 0 0 L 1 0 L 1 1 Z L 2 2": (2, True, 3),  # drawing after Z starts a subpath
        "M 0 0m 5 3c 0 0 0 0 0 0": (1, False, 1),
        "M 0 0 10 0 10 10": (1, False, 2),  # implicit lines after M
    }
    for d, (n, closed, segs) in cases.items():
        out = deck.evaluate(f"{parse}({d!r})")
        assert len(out) == n, (d, out)
        assert out[0]["closed"] is closed, (d, out)
        assert len(out[0]["segs"]) == segs, (d, out)
    # Quadratics are exact cubics: Q 5 5 10 0 from (0, 0).
    seg = deck.evaluate(f"{parse}('M 0 0 Q 5 5 10 0')[0].segs[0]")
    assert seg == pytest.approx([0, 0, 10 / 3, 10 / 3, 20 / 3, 10 / 3, 10, 0])
    # Relative chains accumulate.
    seg = deck.evaluate(f"{parse}('m 1 1 l 1 0 l 1 0')[0].segs[1]")
    assert seg[6:] == pytest.approx([3, 1])
    assert "arcs" in deck.evaluate(
        f"(() => {{ try {{ {parse}('M 0 0 A 1 1 0 0 1 2 2'); }} catch (e) {{ return e.message; }} }})()"
    )
