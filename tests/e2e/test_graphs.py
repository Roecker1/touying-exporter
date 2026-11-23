"""Graph helpers (M1/M2): shapes keep one SVG skeleton, so tracked graphs
interpolate; interpolation stays within the linear-interpolation bound of the
exact geometry.

The exact geometry is computed here from the helpers' formulas. At the knots
the player shows Typst's own renders, so checking the formulas there (<= 0.05
pt) ties them to Typst.
"""

import math

import pytest

pytest.importorskip("typst")

from helpers import open_deck  # noqa: E402
from touying.html_player import tokenize_knot  # noqa: E402

U = 72 / 2.54  # one scene unit (1 cm) in pt
H_SCENE = 7.0  # scene height in units (y is flipped)
AT, SIZE, XR, YR = (1.0, 0.5), (10.0, 6.0), (-2.5, 2.5), (-3.0, 3.0)
LENGTH = 2.0


def f(x):
    return x**3 - 3 * x


def df(x):
    return 3 * x * x - 3


def c2p(x, y):
    sx = AT[0] + (x - XR[0]) / (XR[1] - XR[0]) * SIZE[0]
    sy = AT[1] + (y - YR[0]) / (YR[1] - YR[0]) * SIZE[1]
    return sx * U, (H_SCENE - sy) * U  # pt, y down


def exact(x):
    """Dot centre and both tangent endpoints (pt) at parameter x."""
    sx = SIZE[0] / (XR[1] - XR[0])
    sy = SIZE[1] / (YR[1] - YR[0])
    dx, dy = sx, sy * df(x)
    n = math.hypot(dx, dy)
    cx, cy = AT[0] + (x - XR[0]) * sx, AT[1] + (f(x) - YR[0]) * sy
    ux, uy = dx / n * LENGTH / 2, dy / n * LENGTH / 2
    pts = [(cx, cy), (cx - ux, cy - uy), (cx + ux, cy + uy)]
    return [(px * U, (H_SCENE - py) * U) for px, py in pts]


GEOMETRY_JS = """() => {
  const sc = touying.player.scenes.find(s => s.rec.scene.key === 's1-tangent');
  const root = sc.root, inv = root.getCTM().inverse();
  const obj = sc.object('t');
  const paths = [...obj.inner.querySelectorAll('path')];
  return paths.map(p => {
    const m = inv.multiply(p.getCTM());
    const nums = p.getAttribute('d').match(/[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?/g).map(Number);
    // "M 0 0c ..": absolute (0,0), then relative cubics (each 6 numbers).
    const ends = [[0, 0]];
    let cx = 0, cy = 0;
    for (let i = 2; i + 5 < nums.length; i += 6) {
      cx += nums[i + 4]; cy += nums[i + 5];
      ends.push([cx, cy]);
    }
    return ends.map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  });
}"""


@pytest.fixture(scope="module")
def deck(browser, export, scene_deck):
    html, _ = export(scene_deck("graphs"))
    page = open_deck(browser, html)
    yield page
    page.close()


def measured(page, t):
    if page.evaluate("touying.page") != 1:
        page.evaluate("touying.goto(1, 'start')")
    page.evaluate(f"touying.seek({t})")
    tangent, dot = page.evaluate(GEOMETRY_JS)
    # Dot: centre of its four cubic end points (the first one closes it).
    cx = sum(p[0] for p in dot[:4]) / 4
    cy = sum(p[1] for p in dot[:4]) / 4
    return [(cx, cy), tuple(tangent[0]), tuple(tangent[-1])]


def err(a, b):
    return max(math.hypot(p[0] - q[0], p[1] - q[1]) for p, q in zip(a, b))


def bound(x0, x1):
    """(h^2/8) * max |d^2 p / dx^2| over [x0, x1], per point, in pt."""
    h = x1 - x0
    worst = [0.0, 0.0, 0.0]
    k = 1e-3
    for i in range(21):
        x = x0 + h * i / 20
        a, b, c = exact(x - k), exact(x), exact(x + k)
        for j in range(3):
            d2 = math.hypot(
                (a[j][0] - 2 * b[j][0] + c[j][0]) / k**2,
                (a[j][1] - 2 * b[j][1] + c[j][1]) / k**2,
            )
            worst[j] = max(worst[j], d2)
    return [h * h / 8 * w for w in worst]


def test_one_skeleton_across_zero_slopes(deck):
    deck.evaluate("touying.goto(1, 'start')")
    knots = deck.evaluate(
        "touying.player.scenes.find(s => s.rec.scene.key === 's1-tangent').object('t').rec.knots"
    )
    assert len(knots["skeletons"]) == 1
    assert len(knots["knots"]) == 61
    assert [s["kind"] for s in knots["spans"]] == ["progress"]


def test_interpolation_accuracy(deck):
    n = 60
    for i in range(n + 1):  # knots: Typst's own renders
        t = 2 * i / n
        e = err(measured(deck, t), exact(-2 + 4 * i / n))
        assert e <= 0.05, (t, e)
    for i in range(n):  # midpoints: within the interpolation bound
        x0, x1 = -2 + 4 * i / n, -2 + 4 * (i + 1) / n
        t = 2 * (i + 0.5) / n
        got = measured(deck, t)
        want = exact((x0 + x1) / 2)
        b = bound(x0, x1)
        for j in range(3):
            e = math.hypot(got[j][0] - want[j][0], got[j][1] - want[j][1])
            assert e <= b[j] + 0.05, (t, j, e, b[j])
    assert deck.errors == []


@pytest.mark.parametrize(
    "a, b, same",
    [
        ('<path d="M 0 0c 1 0 2 0 3 0"/>', '<path transform="translate(4)" d="M 0 0c 1 1 2 2 3 3"/>', True),
        ('<path transform="translate(4 5)" d="M 0 0c 0 0 0 0 0 0"/>', '<path d="M 0 0c 1 1 2 2 3 3"/>', True),
        # A clip that changes the segment count changes the skeleton.
        ('<path d="M 0 0c 1 0 2 0 3 0"/>', '<path d="M 0 0c 1 0 2 0 3 0c 1 0 2 0 3 0"/>', False),
    ],
)
def test_tokenizer_normalisation(a, b, same):
    wrap = '<g data-typst-label="k">{}</g>'
    ka = tokenize_knot(wrap.format(a))[0]
    kb = tokenize_knot(wrap.format(b))[0]
    assert (ka == kb) is same
