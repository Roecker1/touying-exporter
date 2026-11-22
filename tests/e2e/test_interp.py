"""Tracker interpolation (M2) against exact Typst renders.

The probe deck renders the same tracked drawings at exact values; the
expected values at a time t follow from the fixture's timeline and the rate
tables the record carries (the tables are the shared source of truth).
"""

import random
import re

import pytest

typst = pytest.importorskip("typst")

from helpers import open_deck  # noqa: E402
from touying.html_player import cut_labelled  # noqa: E402

DOT = "tys-s1-interp-dot"
WAVE = "tys-s1-interp-wave"
NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def ease(table, p):
    p = min(1.0, max(0.0, p))
    x = p * (len(table) - 1)
    i = min(int(x), len(table) - 2)
    return table[i] + (table[i + 1] - table[i]) * (x - i)


def expected_dot(t, rates):
    """Values of the dot at segment-1 time t (see interp/test.typ)."""
    plateau = next(v for k, v in rates.items() if k.startswith("custom"))
    lin, smooth = rates["linear"], rates["smooth"]
    if t >= 4.5:
        return 9.0, 1.0  # after the final instant update
    if t < 0.5:
        return 1.0, 1.0
    if t < 2.5:
        return 1 + 4 * ease(plateau, (t - 0.5) / 2), 1.0
    if t < 3.5:
        return 5.0, 1 + 2 * ease(lin, t - 2.5)
    return 5 + 3 * ease(lin, t - 3.5), 3 - 2 * ease(smooth, (t - 3.5) / 0.5)


@pytest.fixture(scope="module")
def probe(touying_root):
    deck = touying_root / "tests" / "features" / "scene" / "interp" / "probe.typ"
    compiler = typst.Compiler(str(deck), root=str(touying_root))

    def render(**values):
        inputs = {"touying-scene": "html", **{k: repr(float(v)) for k, v in values.items()}}
        svg = compiler.compile(format="svg", sys_inputs=inputs)
        return (svg[0] if isinstance(svg, list) else svg).decode()

    return render


def dot_center(markup):
    m = re.search(r'fill="#ff4136"[^>]*transform="translate\(([^ )]+) ([^)]+)\)"', markup)
    return float(m.group(1)), float(m.group(2))


def wave_numbers(markup):
    m = re.search(r'stroke="#0074d9"[^>]*d="([^"]*)"', markup)
    return [float(x) for x in NUM.findall(m.group(1))]


def player_markup(page, obj):
    return page.evaluate(
        f"touying.player.scenes[0].objects.find(o => o.rec.id === '{obj}').inner.innerHTML"
    )


@pytest.fixture(scope="module")
def deck(browser, export, scene_deck):
    html, stats = export(scene_deck("interp"))
    page = open_deck(browser, html)
    page.evaluate("touying.goto(0, 'start')")
    yield page, stats
    page.close()


def test_dot_follows_exact_states_across_boundaries(deck, probe):
    page, _ = deck
    rates = page.evaluate("touying.player.scenes[0].rec.rates")
    times = [0, 0.25, 0.4999, 0.5, 0.6, 1.0, 1.3, 1.7, 2.2, 2.4999, 2.5, 3.0,
             3.4999, 3.5, 3.6, 3.75, 3.9, 3.9999, 4.0, 4.2, 4.4999, 4.5]
    random.Random(7).shuffle(times)  # random seeks, also backwards
    worst = 0.0
    for t in times:
        page.evaluate(f"touying.seek({t})")
        got = dot_center(player_markup(page, "dot"))
        x, y = expected_dot(t, rates)
        want = dot_center(cut_labelled(probe(x=x, y=y, k=1), DOT)[1])
        err = max(abs(a - b) for a, b in zip(got, want))
        worst = max(worst, err)
        assert err < 0.25, (t, got, want)
    print(f"\ndot: worst deviation from exact renders {worst:.4f} pt")
    # The wait holds still and the plateau holds still.
    page.evaluate("touying.seek(0.49)")
    assert dot_center(player_markup(page, "dot")) == dot_center(
        cut_labelled(probe(x=1, y=1, k=1), DOT)[1]
    )
    page.evaluate("touying.seek(1.2)")
    a = player_markup(page, "dot")
    page.evaluate("touying.seek(1.8)")
    assert player_markup(page, "dot") == a
    assert page.errors == []


def test_wave_interpolates_shape(deck, probe):
    page, _ = deck
    smooth = page.evaluate("touying.player.scenes[0].rec.rates.smooth")
    worst = 0.0
    for t in (0.9, 1.5, 2.13):
        page.evaluate(f"touying.seek({t})")
        got = wave_numbers(player_markup(page, "wave"))
        k = 1 + 2 * ease(smooth, (t - 0.5) / 2)
        want = wave_numbers(cut_labelled(probe(x=1, y=1, k=k), WAVE)[1])
        assert len(got) == len(want)
        err = max(abs(a - b) for a, b in zip(got, want))
        worst = max(worst, err)
        assert err < 1.0, (t, err)
    print(f"\nwave: worst deviation from exact renders {worst:.3f} pt")


def test_non_monotone_rate_returns(deck, probe):
    page, _ = deck
    page.evaluate("touying.goto(1, 'start')")
    start = player_markup(page, "wave")
    page.evaluate("touying.seek(0.75)")  # the turning point: k = 1
    mid = wave_numbers(player_markup(page, "wave"))
    want = wave_numbers(cut_labelled(probe(x=1, y=1, k=1), WAVE)[1])
    assert max(abs(a - b) for a, b in zip(mid, want)) < 0.05
    page.evaluate("touying.seek(1.5)")
    assert player_markup(page, "wave") == start
    assert page.errors == []
