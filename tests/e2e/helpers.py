"""Helpers shared by the end-to-end tests."""

from PIL import ImageChops, ImageStat


def open_deck(browser, html, viewport=(960, 540)):
    page = browser.new_page(viewport={"width": viewport[0], "height": viewport[1]})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(html.as_uri())
    page.wait_for_selector("body[data-ready]")
    assert page.evaluate("document.body.dataset.ready") == "true", errors
    page.errors = errors
    return page


def states(page, t, key=None):
    scenes = page.evaluate(f"touying.states({t})")
    if key is None:
        assert len(scenes) == 1
        return scenes[0]["states"]
    return next(s["states"] for s in scenes if s["key"] == key)


def diff(a, b):
    """(mean grey difference, fraction of pixels differing by more than 64)."""
    a, b = a.convert("L"), b.convert("L").resize(a.size)
    d = ImageChops.difference(a, b)
    big = sum(d.histogram()[64:]) / (a.size[0] * a.size[1])
    return ImageStat.Stat(d).mean[0], big


def region_diff(a, b, box, threshold=48):
    """Colour-aware comparison of one region (x0, y0, x1, y1) of two shots.

    Returns (max channel difference, fraction of pixels whose largest channel
    difference exceeds `threshold`). Unlike `diff`, a small object that
    vanishes from a large slide is not averaged away.
    """
    assert a.size == b.size, (a.size, b.size)
    box = tuple(int(round(v)) for v in box)
    a = a.convert("RGBA").crop(box)
    b = b.convert("RGBA").crop(box)
    d = ImageChops.difference(a, b)
    channels = d.split()
    worst = channels[0]
    for c in channels[1:]:
        worst = ImageChops.lighter(worst, c)
    hist = worst.histogram()
    n = a.size[0] * a.size[1] or 1
    return max(i for i, c in enumerate(hist) if c) if any(hist) else 0, sum(hist[threshold + 1 :]) / n


def element_box(page, selector_js, pad=4):
    """Client box (x0, y0, x1, y1) of the element returned by `selector_js`."""
    r = page.evaluate(f"(() => {{ const r = ({selector_js}).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }})()")
    return (r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad)
