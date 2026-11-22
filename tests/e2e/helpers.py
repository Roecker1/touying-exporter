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
