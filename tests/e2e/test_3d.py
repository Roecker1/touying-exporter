"""3D scenes: kernel parity (Typst vs JS), render parity with the PDF, transform
steps and pivots against an independent implementation, tracked geometry, drag.
"""

import io
import json
import math
import random
import re
import shutil
import time

import pytest

typst = pytest.importorskip("typst")
from PIL import Image  # noqa: E402

from helpers import diff, open_deck  # noqa: E402

UNIT = 28.3465
MAT = {"f": "#3b82f6", "fa": 1.0, "s": "#111111", "sa": 1.0, "sw": 2.0, "r": 3.0, "h": 6.0, "shade": True}
VIEWS = [
    {"values": {"phi": 70.0, "theta": -45.0, "zoom": 1.3, "ifocal": 0.0, "cx": 0.2, "cy": -0.1, "cz": 0.3}, "unit": UNIT, "at": [300.0, 150.0]},
    # Precision-sensitive perspective (ifocal = 0.100049) looking along -x.
    {"values": {"phi": 90.0, "theta": 0.0, "zoom": 1.0, "ifocal": 0.100049, "cx": 0.0, "cy": 0.0, "cz": 0.0}, "unit": UNIT, "at": [300.0, 150.0]},
    {"values": {"phi": 0.0, "theta": -90.0, "zoom": 1.0, "ifocal": 0.0, "cx": 0.0, "cy": 0.0, "cz": 0.0}, "unit": 10.0, "at": [100.0, 50.0]},
]
# Triangle with one vertex behind the near plane (d = 10 > 9.5) in view 1,
# a segment crossing it, a point behind the camera and a vector.
CLIP_GEOM = {
    "pos": [10.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 12.0, 0.5, 0.5, 2.0, -1.0, -1.0, 11.0, 2.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0],
    "prims": [["t", 0, 1, 2, 0, 3], ["s", 3, 4, 0, 0.0, 1.0], ["p", 5, 0], ["s", 7, 6, 0, 0.0, 1.0], ["h", 6, 7, 0]],
    "mats": [MAT],
    "labels": [],
}
CASES = [
    {"kind": "point", "view": 0, "p": [1.0, 2.0, -0.5]},
    {"kind": "point", "view": 1, "p": [5.0, 1.0, 0.25]},
    {"kind": "point", "view": 1, "p": [9.4, -0.3, 0.7]},
    {"kind": "point", "view": 2, "p": [1.0, 2.0, 0.0]},
    {"kind": "rotation", "view": 0, "p": [0.0, 1.0, 0.3],
     "a": {"axis": [1.0, 0.0, 0.0], "angle": 90.0, "pivot": [0.0, 0.0, 0.0]},
     "b": {"axis": [0.0, 1.0, 0.0], "angle": 90.0, "pivot": [0.5, 0.0, 0.0]}},
    {"kind": "geom", "view": 1, "geom": CLIP_GEOM, "opacity": 1.0, "draw": 1.0},
    {"kind": "geom", "view": 0, "geom": CLIP_GEOM, "opacity": 0.6, "draw": 0.5},
]

PROBE = """#import "/src/core/scene3d.typ" as s3
#let data = json("data.json")
#let view(v) = s3.make-view(v.values, v.unit, v.at)
#metadata(data.cases.map(c => {{
  let v = view(data.views.at(c.view))
  if c.kind == "point" {{
    let cam = s3.to-camera(v, c.p)
    (cam: cam, screen: s3.to-screen(v, cam))
  }} else if c.kind == "rotation" {{
    s3.mat-apply(s3.mat-mul(s3.mat-rotation(c.a.axis, c.a.angle, c.a.pivot),
      s3.mat-rotation(c.b.axis, c.b.angle, c.b.pivot)), c.p)
  }} else {{
    s3.drawables(v, ((c.geom, s3.mat-identity, c.opacity, c.draw),))
      .map(d => d.pairs().filter(((k, _)) => k != "key").to-dict())
  }}
}}))<kernel>
"""

JS_KERNEL = """(data) => {
  const K = touying.kernel;
  const view = (v) => K.makeView(v.values, v.unit, v.at);
  return data.cases.map((c) => {
    const v = view(data.views[c.view]);
    if (c.kind === "point") { const cam = K.toCamera(v, c.p); return { cam, screen: K.toScreen(v, cam) }; }
    if (c.kind === "rotation")
      return K.matApply(K.matMul(K.matRotation(c.a.axis, c.a.angle, c.a.pivot), K.matRotation(c.b.axis, c.b.angle, c.b.pivot)), c.p);
    return K.drawables(v, [{ geom: c.geom, pos: c.geom.pos, matrix: [1,0,0,0,0,1,0,0,0,0,1,0], opacity: c.opacity, draw: c.draw }])
      .map((d) => { const { key, ...rest } = d; return rest; });
  });
}"""


def close(a, b, tol=1e-9, path="$"):
    """Recursive comparison with a numeric tolerance (JS null == Typst none)."""
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        assert abs(a - b) <= tol * max(1.0, abs(a), abs(b)), (path, a, b)
    elif isinstance(a, dict):
        assert set(a) == set(b), (path, sorted(a), sorted(b))
        for k in a:
            close(a[k], b[k], tol, f"{path}.{k}")
    elif isinstance(a, list):
        assert len(a) == len(b), (path, a, b)
        for i, (x, y) in enumerate(zip(a, b)):
            close(x, y, tol, f"{path}[{i}]")
    else:
        assert a == b, (path, a, b)


@pytest.fixture(scope="module")
def deck3d(browser, export, scene_deck):
    html, stats = export(scene_deck("space"))
    page = open_deck(browser, html)
    yield page, stats
    page.close()


def test_kernel_parity_typst_vs_js(deck3d, touying_root):
    page, _ = deck3d
    data = {"views": VIEWS, "cases": CASES}
    tmp = touying_root / "tests" / "_tmp_3d_kernel"
    tmp.mkdir(exist_ok=True)
    try:
        probe = tmp / "probe.typ"
        probe.write_text(PROBE.format())
        (tmp / "data.json").write_text(json.dumps(data))
        compiler = typst.Compiler(str(probe), root=str(touying_root))
        typst_out = json.loads(compiler.query("<kernel>", field="value", one=True))
    finally:
        shutil.rmtree(tmp)
    js_out = page.evaluate(JS_KERNEL, data)
    close(typst_out, js_out)
    # Analytic anchors: top view maps x right and y up; w = 0.5 doubles.
    assert typst_out[3]["screen"] == [110.0, 30.0]
    # R_x(90°) after R_y(90°) about (0.5, 0, 0), computed by hand.
    assert typst_out[4] == pytest.approx([0.8, -0.5, 1.0], abs=1e-12)
    clipped = next(d for d in typst_out[5] if d["kind"] == "poly" and len(d["pts"]) == 4)
    assert clipped["kind"] == "poly" and len(clipped["pts"]) == 4
    assert sorted(clipped["flags"]) == [False, False, True, True]
    assert [d["kind"] for d in typst_out[5]].count("point") == 0  # behind the camera


def test_render_parity_with_pdf(deck3d, scene_deck, touying_root):
    page, stats = deck3d
    deck = scene_deck("space")
    svgs = typst.compile(str(deck), root=str(touying_root), format="svg")
    w_pt = float(re.search(r'width="([0-9.]+)pt"', svgs[0].decode()).group(1))
    pngs = typst.compile(str(deck), root=str(touying_root), format="png", ppi=960 / (w_pt / 72))
    for i, png in enumerate(pngs):
        ref = Image.open(io.BytesIO(png)).convert("RGB")
        page.set_viewport_size({"width": ref.size[0], "height": ref.size[1]})
        page.evaluate(f"touying.goto({i}, 'end')")
        mean, big = diff(ref, Image.open(io.BytesIO(page.screenshot())))
        assert big < 0.001, (i, mean, big)
    page.set_viewport_size({"width": 960, "height": 540})
    assert page.errors == []


# --- independent implementation of the projection spec (Python) -----------

def ease(table, p):
    p = min(1.0, max(0.0, p))
    x = p * (len(table) - 1)
    i = min(int(x), len(table) - 2)
    return table[i] + (table[i + 1] - table[i]) * (x - i)


def rotate(p, axis, deg, pivot):
    n = [a / math.sqrt(sum(x * x for x in axis)) for a in axis]
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    q = [p[i] - pivot[i] for i in range(3)]
    d = sum(n[i] * q[i] for i in range(3))
    cr = [n[1] * q[2] - n[2] * q[1], n[2] * q[0] - n[0] * q[2], n[0] * q[1] - n[1] * q[0]]
    r = [q[i] * c + cr[i] * s + n[i] * d * (1 - c) for i in range(3)]
    return [r[i] + pivot[i] for i in range(3)]


def project(p, phi, theta, zoom, unit, at):
    P, T = math.radians(phi), math.radians(theta)
    c = [math.sin(P) * math.cos(T), math.sin(P) * math.sin(T), math.cos(P)]
    right = [-math.sin(T), math.cos(T), 0]
    up = [-math.cos(P) * math.cos(T), -math.cos(P) * math.sin(T), math.sin(P)]
    u = sum(p[i] * right[i] for i in range(3))
    v = sum(p[i] * up[i] for i in range(3))
    return [at[0] + u * zoom * unit, at[1] - v * zoom * unit]


def test_steps_and_pivots_against_independent_implementation(browser, export, scene_deck):
    html, _ = export(scene_deck("space-steps"))
    page = open_deck(browser, html)
    rec = page.evaluate("touying.player.scenes[0].rec")
    hook = next(o for o in rec["objects"] if o["id"] == "hook")
    # Pivot 1: s = 2 (earlier instant update) counts, s = 3 (later, same t) not.
    steps = hook["geom"]["steps"]
    assert steps[0]["pivot"] == pytest.approx([1.0, 0.5, 0.0])
    assert steps[1]["pivot"] == pytest.approx([1.0, 0.5, -0.5])
    smooth = rec["rates"]["smooth"]
    cam = rec["camera"]
    pts = lambda s: [[0, 0, 0], [s, 0, 0], [s, 1, 0]]

    def expected(seg, t):
        base = pts(3.0)
        if seg == 0:
            e1, e2, phi = ease(smooth, t), 0.0, 350.0
        else:
            e1, e2 = 1.0, ease(smooth, t)
            phi = 350.0 + 30.0 * ease(smooth, t - 1)
        out = []
        for p in base:
            p = rotate(p, [0, 1, 0], 90 * e1, steps[0]["pivot"])
            if e2:
                p = rotate(p, [1, 0, 0], 90 * e2, steps[1]["pivot"])
            out.append(project(p, phi, -60.0, 1.2, cam["unit"], cam["at"]))
        return out

    times = [(0, t) for t in (0.0, 0.3, 0.5, 0.99, 1.0)] + [(1, t) for t in (0.0, 0.25, 0.7, 1.0, 1.4, 2.0)]
    random.Random(3).shuffle(times)
    for seg, t in times:
        page.evaluate(f"touying.goto({seg}, 'start'); touying.seek({t})")
        lines = sorted(
            (d for d in page.evaluate("touying.world()[0].list") if d["kind"] == "line" and d["key"][1] == 1),
            key=lambda d: d["key"][2],
        )
        got = [lines[0]["pts"][0], lines[0]["pts"][1], lines[1]["pts"][1]]
        for g, w in zip(got, expected(seg, t)):
            assert g == pytest.approx(w, abs=1e-6), (seg, t, got)
    assert page.errors == []
    page.close()


def test_tracked_mesh_interpolates_exactly(deck3d):
    page, stats = deck3d
    rec = page.evaluate("touying.goto(3, 'start'), touying.player.scenes[0].rec")
    bowl = next(o for o in rec["objects"] if o["id"] == "bowl")
    assert bowl["knots"]["kind"] == "geom" and len(bowl["knots"]["positions"]) == 61
    smooth = rec["rates"]["smooth"]
    for t in (0.37, 1.0, 1.61, 2.0):
        page.evaluate(f"touying.seek({t})")
        pos = page.evaluate("touying.world()[0].positions")[2]
        a = 0.15 + (0.7 - 0.15) * ease(smooth, t / 2)
        for i in range(0, len(pos), 3):
            x, y, z = pos[i : i + 3]
            assert z == pytest.approx(a * (x * x + y * y), abs=1e-6), (t, x, y)
    print(f"\n3d deck: {stats['html_bytes'] / 1024:.0f} KiB HTML, export {stats['export_seconds']:.2f}s")


def test_orbit_frame_times(deck3d):
    page, _ = deck3d
    frames = page.evaluate(
        """() => new Promise(resolve => {
            const ts = []; touying.goto(1, 'play');
            const tick = (t) => { ts.push(t); if (touying.playing) requestAnimationFrame(tick); else resolve(ts); };
            requestAnimationFrame(tick);
        })"""
    )
    deltas = sorted(b - a for a, b in zip(frames, frames[1:]))
    p95 = deltas[int(len(deltas) * 0.95)]
    print(f"\norbit of a 20x20 surface: {len(frames)} frames, p95 {p95:.1f} ms")
    assert p95 < 34


def drag(page, dx, dy, steps=8):
    box = page.evaluate("(() => { const r = document.querySelector('[data-typst-label=\"' + touying.player.scenes[0].rec.scene.dom + '\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    page.mouse.move(*box)
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(box[0] + dx * i / steps, box[1] + dy * i / steps)
    page.mouse.up()


def test_drag_to_rotate(browser, export, scene_deck):
    html, _ = export(scene_deck("space-steps"))
    page = open_deck(browser, html)
    page.evaluate("touying.goto(0, 'end')")
    key = page.evaluate("touying.player.scenes[0].rec.scene.key")
    with page.expect_popup() as info:
        page.keyboard.press("p")
    pop = info.value
    pop.wait_for_selector(".tys-p-current svg")
    drag(page, 120, 0)
    off = page.evaluate(f"touying.drag('{key}')")
    assert off["dtheta"] == pytest.approx(-48, abs=1) and page.evaluate("touying.page") == 0
    # The presenter view mirrors the offset.
    a = page.evaluate("touying.world()[0].list.length")
    b = page.evaluate("touying.presenter.current.scenes[0].world.lastList.length")
    assert a == b
    # Scripted phi = 350° (polar 10°): a large vertical drag is limited, no jump.
    drag(page, 0, 900)
    drag(page, 0, -2000)
    off = page.evaluate(f"touying.drag('{key}')")
    m = (350 + off["dphi"]) % 360
    polar = m if m <= 180 else 360 - m
    assert 1 - 1e-6 <= polar <= 179 + 1e-6, off
    # Wheel zoom (over the scene) is bounded.
    page.mouse.move(480, 300)
    for _ in range(20):
        page.mouse.wheel(0, -500)
    page.wait_for_timeout(50)
    assert page.evaluate(f"touying.drag('{key}').zoom") == pytest.approx(4)
    # 0 eases back; the drags never navigated.
    page.keyboard.press("0")
    page.wait_for_timeout(500)
    assert page.evaluate(f"touying.drag('{key}')") is None
    assert page.evaluate("touying.page") == 0
    # A page change that keeps the scene turns back smoothly (about 1 s).
    drag(page, 50, 0)
    before = page.evaluate(f"touying.drag('{key}').dtheta")
    assert before != 0
    page.evaluate("touying.next(); touying.player.finish()")
    assert page.evaluate("touying.page") == 1
    assert page.evaluate("touying.player.scenes[0].rec.scene.key") == key
    page.wait_for_timeout(400)
    mid = page.evaluate(f"touying.drag('{key}')")
    assert mid is not None and 0 < abs(mid["dtheta"]) < abs(before), (before, mid)
    page.wait_for_timeout(900)
    assert page.evaluate(f"touying.drag('{key}')") is None
    # Grabbing the scene during the ease stops it where it is.
    drag(page, 50, 0)
    page.evaluate("touying.prev()")
    page.wait_for_timeout(200)
    drag(page, 10, 0)
    held = page.evaluate(f"touying.drag('{key}').dtheta")
    page.wait_for_timeout(1100)
    assert page.evaluate(f"touying.drag('{key}').dtheta") == held
    assert page.errors == []
    page.close()


def test_unsupported_animation_is_rejected(touying_root, tmp_path):
    deck = tmp_path / "bad.typ"
    deck.write_text(
        f'#import "{touying_root.as_posix()}/lib.typ": *\n'
        "#import themes.simple: *\n#show: simple-theme\n#let sc = touying-scene\n== B\n"
        "#sc.scene(width: 6cm, height: 3cm, camera: sc.camera(),\n"
        "  objects: (p: sc.point3d((0, 0, 0))),\n"
        '  timeline: (sc.shift("p", (1, 0)),))\n'
    )
    from touying.html_player import export_html

    with pytest.raises(typst.TypstError, match="does not apply to the 3D object"):
        export_html(str(deck), output=str(tmp_path / "b.html"), root="/", silent=True)
