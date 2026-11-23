"""Annotations and emphasis (M4).

Pages of tests/features/scene/emphasis: 0-1 annotations, 2-4 the emphasis
scene's three segments.
"""

import pytest

pytest.importorskip("typst")

from helpers import open_deck  # noqa: E402


@pytest.fixture(scope="module")
def deck(browser, export, scene_deck):
    html, _ = export(scene_deck("emphasis"))
    page = open_deck(browser, html)
    yield page
    page.close()


def at(page, index, t):
    page.evaluate(f"touying.goto({index}, 'start'); touying.seek({t})")


def centre(page, obj):
    """Centre of an object's drawing in scene coordinates (pt)."""
    return page.evaluate(
        f"""(() => {{
          const sc = touying.player.scenes[0];
          const o = sc.object({obj!r});
          const inv = sc.root.getCTM().inverse();
          const m = inv.multiply(o.inner.getCTM());
          const b = o.inner.getBBox();
          const x = b.x + b.width / 2, y = b.y + b.height / 2;
          return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
        }})()"""
    )


U = 72 / 2.54  # one scene unit (1 cm) in pt


def test_outline_measured_when_the_animation_starts(deck):
    # The equation's layout box is centred at (4, 4) (scene height 6): the
    # outline surrounds it there, not where the shift is taking it.
    at(deck, 2, 0.5)
    assert centre(deck, "@e1") == pytest.approx([4 * U, 2 * U], abs=0.05)
    # Segment 2: the lagged circumscribe starts at 0.5 s, after the shift.
    at(deck, 3, 0.75)
    assert centre(deck, "@e3") == pytest.approx([5 * U, 2 * U], abs=0.05)


def test_aux_objects_end_invisible(deck):
    for index in (2, 3):
        at(deck, index, 0)
        d = deck.evaluate("touying.duration")
        st = deck.evaluate(f"touying.states({d})[0].states")
        aux = {k: v for k, v in st.items() if k.startswith("@")}
        assert aux and all(v["opacity"] == 0 for v in aux.values()), aux
        assert all(v.get("pass", -1) < 0 for v in aux.values())


def dash(page, obj):
    return page.evaluate(
        f"""(() => {{
          const o = touying.player.scenes[0].object({obj!r});
          const p = [...o.inner.querySelectorAll('path')].find(p => p.getAttribute('fill') === 'none' && p.getAttribute('stroke') !== 'none');
          return [p.style.strokeDasharray, p.style.strokeDashoffset, p.style.opacity, p.getAttribute('pathLength')];
        }})()"""
    )


def first(css):
    """First number of a CSS length list such as '0.3px, 2px' or '1 1'."""
    return float(css.replace("px", "").replace(",", " ").split()[0])


def window(p, w):
    upper = min((1 + w) * p, 1)
    lower = max((1 + w) * p - w, 0)
    return upper - lower, lower


@pytest.mark.parametrize("obj, t0, w", [("glow", 0.0, 0.3), ("glow2", 1.0, 1.5)])
@pytest.mark.parametrize("p", [0.0, 0.25, 0.5, 0.999])
def test_passing_windows(deck, obj, t0, w, p):
    at(deck, 4, t0 + p)
    arr, off, op, plen = dash(deck, obj)
    length, lower = window(p, w)
    assert plen == "1"
    got_len = first(arr)
    assert got_len == pytest.approx(max(length, 0), abs=2e-4)
    assert float(off.replace("px", "") or 0) == pytest.approx(-lower, abs=2e-4)
    assert op == ("" if length > 1e-6 else "0")


def test_stroke_state_is_idempotent_across_seeks(deck):
    # Segment 1: `create` draws the glow in (2 s to 3 s).
    at(deck, 2, 2.5)
    arr, off, op, plen = dash(deck, "glow")
    assert arr.startswith("1") and plen == "1"
    deck.evaluate("touying.seek(3)")
    assert dash(deck, "glow") == ["", "", "", None]
    # Segment 3: flash, invisible afterwards, then seeks in any order.
    deck.evaluate("touying.goto(4, 'start')")
    for t in (0.5, 1.5, 0.2, 2.9, 0.5, 0.0, 0.999, 0.25):
        deck.evaluate(f"touying.seek({t})")
        visible = deck.evaluate("touying.player.scenes[0].object('glow').xf.getAttribute('opacity')") != "0"
        if t < 1:
            length, lower = window(t, 0.3)
            arr, off, op, _ = dash(deck, "glow")
            assert first(arr) == pytest.approx(max(length, 0), abs=2e-4), t
            assert visible
        else:
            assert not visible
    assert deck.errors == []


def test_wiggle_restores_exactly(deck):
    at(deck, 4, 0)
    d = deck.evaluate("touying.duration")
    mid = deck.evaluate(f"touying.states({d - 0.3})[0].states.eq")
    end = deck.evaluate(f"touying.states({d})[0].states.eq")
    assert abs(mid["rot"]) > 1e-3 or abs(mid["scale"] - 1) > 1e-3
    assert end["rot"] == 0 and end["scale"] == 1, end


def test_presenter_mirrors_emphasis(deck):
    with deck.expect_popup() as info:
        deck.keyboard.press("p")
    popup = info.value
    popup.wait_for_load_state()
    at(deck, 4, 0.5)
    arr = deck.evaluate(
        "(() => { const sc = touying.presenter.current.scenes[0]; const o = sc.object('glow');"
        " const p = [...o.inner.querySelectorAll('path')].find(p => p.getAttribute('fill') === 'none');"
        " return p.style.strokeDasharray; })()"
    )
    assert arr == dash(deck, "glow")[0]
    popup.close()
