"""Compile errors of the scene DSL: shape morphs, graphs, annotations and
emphasis animations reject invalid timelines with clear messages."""

import pytest

typst = pytest.importorskip("typst")

CASES = {
    "transform-self": (
        "(a: sc.obj($a$))",
        '(sc.transform("a", "a"),)',
        "source and target must differ",
    ),
    "shape-mode": (
        "(a: sc.obj(circle(radius: 1cm)), b: sc.obj(rect()))",
        '(sc.play(sc.transform("a", "b", mode: "shape"), sc.rotate-by("b", 30deg)),)',
        'mode: "shape"',
    ),
    "pass-overlaps-draw": (
        "(a: sc.obj(circle(radius: 1cm)))",
        '(sc.play(sc.create("a"), sc.show-passing-flash("a")),)',
        "overlapping animations on `a` (dash)",
    ),
    "unknown-of": (
        '(a: sc.obj($a$), s: sc.surround(of: "zz"))',
        "()",
        "unknown object `zz`",
    ),
    "cycle": (
        '(a: sc.surround(of: "b"), b: sc.brace(of: "a"))',
        "()",
        "cycle",
    ),
    "secant": (
        "(s: sc.secant(sc.axes(), x => x, 1, 1))",
        "()",
        "use `tangent`",
    ),
    "wiggle-rate": (
        "(a: sc.obj($a$))",
        '(sc.wiggle("a", rate: "there-and-back"),)',
        "must start at 0 and end at 1",
    ),
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_rejected(touying_root, tmp_path, name):
    objects, timeline, message = CASES[name]
    deck = tmp_path / "bad.typ"
    deck.write_text(
        f'#import "{touying_root.as_posix()}/lib.typ": *\n'
        "#import themes.simple: *\n#show: simple-theme\n#let sc = touying-scene\n== B\n"
        f"#sc.scene(width: 10cm, height: 4cm, objects: {objects}, timeline: {timeline})\n"
    )
    with pytest.raises(typst.TypstError) as err:
        typst.compile(str(deck), root="/", format="svg")
    assert message in str(err.value), str(err.value)[:400]
