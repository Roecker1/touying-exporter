"""Equation morphs (M3): pairings, fallbacks and continuity."""

import io

import pytest

typst = pytest.importorskip("typst")
from PIL import Image  # noqa: E402

from helpers import diff, open_deck  # noqa: E402
from touying.html_player import export_html  # noqa: E402


@pytest.fixture(scope="module")
def deck(browser, export, scene_deck):
    html, _ = export(scene_deck("morph"))
    page = open_deck(browser, html)
    yield page
    page.close()


def at(page, index, t):
    page.evaluate(f"touying.goto({index}, 'start'); touying.seek({t})")


def shot(page):
    return Image.open(io.BytesIO(page.screenshot())).convert("RGB")


def morphs(page):
    return page.evaluate("touying.morphs()")


def test_identical_endpoints_are_pixel_faithful(deck):
    at(deck, 0, 0.0001)  # overlay at the start
    start = shot(deck)
    info = morphs(deck)[0]
    assert info["mode"] == "overlay", info
    # Key, the coloured glyph, the other glyphs and the fraction bar all match.
    assert info["tiers"]["key"] == 1 and info["tiers"]["shape"] == 1
    assert info["tiers"]["faded"] == 0 and info["tiers"]["repainted"] == 0
    at(deck, 0, 0.9999)
    end = shot(deck)
    at(deck, 0, 1)  # target object, no overlay
    target = shot(deck)
    for img in (start, end):
        mean, big = diff(target, img)
        assert big < 0.0005, (mean, big)
    assert deck.errors == []


def test_occluder_falls_back_to_crossfade(deck):
    at(deck, 1, 0.5)
    info = morphs(deck)[0]
    assert info["mode"] == "crossfade" and "wall" in info["reason"]
    assert deck.evaluate(
        "touying.player.scenes[0].object('src').xf.style.opacity"
    ) == "0.5"


def test_factor_pairs_and_continuity(deck):
    at(deck, 2, 0.5)
    info = morphs(deck)[0]
    assert info["mode"] == "overlay"
    # x, +, 1 and the exponent 2 occur in both; "2x"'s 2 and one x fade.
    assert info["tiers"]["glyph"] >= 4 and info["tiers"]["faded"] >= 2, info
    # Every pair moves from the upper equation to the lower one.
    assert all(p["to"][1] > p["from"][1] for p in info["pairs"])
    at(deck, 2, 0.9999)
    before = shot(deck)
    at(deck, 2, 1)
    _, big = diff(shot(deck), before)
    assert big < 0.002, big
    at(deck, 2, 0.0001)
    after_start = shot(deck)
    deck.evaluate("touying.goto(2, 'start')")
    deck.evaluate("touying.player.scenes[0].morphs[0].clear()")  # overlay off, source shown
    source = shot(deck)
    _, big = diff(after_start, source)
    assert big < 0.002, big


def test_repeated_glyphs_pair_the_nearest(deck):
    at(deck, 3, 0.5)
    info = morphs(deck)[0]
    glyphs = [p for p in info["pairs"] if p["tier"] == "glyph"]
    assert len(glyphs) == 1, info  # one of the two a's; "+" and the other a fade
    a = glyphs[0]
    # The right-hand a of "a + a" is closer to the a of "2 a" (to the right).
    assert float(a["from"][0]) > 0 and info["tiers"]["faded"] == 3


def test_keys_and_colour(deck):
    at(deck, 4, 0.5)
    info = morphs(deck)[0]
    assert info["tiers"].get("key") == 1 and info["tiers"].get("glyph", 0) >= 1, info
    at(deck, 5, 0.5)
    info = morphs(deck)[0]
    assert info["mode"] == "overlay" and info["tiers"]["repainted"] == 1, info


def test_rotated_source_falls_back(deck):
    at(deck, 6, 1.5)
    info = morphs(deck)[0]
    assert info["mode"] == "crossfade" and "rotated" in info["reason"], info


def test_chained_simultaneous_and_instant(deck):
    at(deck, 7, 0.5)
    infos = morphs(deck)
    assert [m["mode"] for m in infos] == ["overlay"] * 4, infos
    # During the first play both overlays are visible, later ones hidden.
    shown = deck.evaluate(
        "touying.player.scenes[0].morphs.map(m => m.overlay && m.overlay.style.display !== 'none')"
    )
    assert shown == [True, True, False, False]
    # After the instant q -> p, p is visible again and q is not.
    at(deck, 7, 2)
    st = deck.evaluate("touying.states(2)[0].states")
    assert st["p"]["opacity"] == 1 and st["q"]["opacity"] == 0 and st["end"]["opacity"] == 1
    assert deck.errors == []


def test_terminal_state_matches_pdf(deck, scene_deck, touying_root):
    # Factor slide: the target replaces the source in the PDF.
    deckfile = scene_deck("morph")
    import re

    svg = typst.compile(str(deckfile), root=str(touying_root), format="svg")[2].decode()
    w_pt = float(re.search(r'width="([0-9.]+)pt"', svg).group(1))
    png = typst.compile(str(deckfile), root=str(touying_root), format="png", ppi=960 / (w_pt / 72))[2]
    ref = Image.open(io.BytesIO(png)).convert("RGB")
    deck.set_viewport_size({"width": ref.size[0], "height": ref.size[1]})
    deck.evaluate("touying.goto(2, 'end')")
    mean, big = diff(ref, shot(deck))
    deck.set_viewport_size({"width": 960, "height": 540})
    assert big < 0.002, (mean, big)


@pytest.mark.parametrize(
    "anims",
    [
        'sc.transform-matching("a", "b"), sc.shift("a", (1, 0))',
        'sc.shift("b", (1, 0)), sc.transform-matching("a", "b")',
    ],
)
def test_conflicting_animation_is_rejected(touying_root, tmp_path, anims):
    deck = tmp_path / "conflict.typ"
    deck.write_text(
        f'#import "{touying_root.as_posix()}/lib.typ": *\n'
        "#import themes.simple: *\n#show: simple-theme\n#let sc = touying-scene\n== C\n"
        "#sc.scene(width: 6cm, height: 2cm,\n"
        "  objects: (a: sc.obj(at: (1, 1), $a$), b: sc.obj(at: (2, 1), $b$)),\n"
        f"  timeline: (sc.play({anims}),))\n"
    )
    with pytest.raises(typst.TypstError, match="morph needs both objects|overlapping animations"):
        export_html(str(deck), output=str(tmp_path / "c.html"), root="/", silent=True)


def test_rate_must_end_at_one(touying_root, tmp_path):
    deck = tmp_path / "rate.typ"
    deck.write_text(
        f'#import "{touying_root.as_posix()}/lib.typ": *\n'
        "#import themes.simple: *\n#show: simple-theme\n#let sc = touying-scene\n== R\n"
        "#sc.scene(width: 6cm, height: 2cm,\n"
        "  objects: (a: sc.obj(at: (1, 1), $a$), b: sc.obj(at: (2, 1), $b$)),\n"
        '  timeline: (sc.transform-matching("a", "b", rate: "there-and-back"),))\n'
    )
    with pytest.raises(typst.TypstError, match="must start at 0 and end at 1"):
        export_html(str(deck), output=str(tmp_path / "r.html"), root="/", silent=True)
