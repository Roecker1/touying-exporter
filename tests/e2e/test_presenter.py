"""Presenter window (M1): a second, same-origin window driven by the deck.

Visibility is simulated by overriding `document.hidden`; Playwright cannot
minimise windows. Browsers: TOUYING_BROWSERS=chromium,firefox,webkit.
"""

import pytest

pytest.importorskip("playwright.sync_api")

from helpers import open_deck  # noqa: E402

HIDE = (
    "Object.defineProperty(document, 'hidden', {value: %s, configurable: true});"
    "document.dispatchEvent(new Event('visibilitychange'))"
)


def open_presenter(page):
    with page.expect_popup() as info:
        page.keyboard.press("p")
    pop = info.value
    pop.wait_for_selector(".tys-p-current svg")
    return pop


@pytest.fixture
def deck(browser, export, scene_deck):
    html, _ = export(scene_deck("lifecycle"))
    page = open_deck(browser, html)
    page.evaluate("touying.player.finish()")
    yield page
    page.close()


def test_presenter_shows_current_next_and_notes(deck):
    pop = open_presenter(deck)
    assert pop.locator(".tys-notes-pane").inner_text().strip() == "Notes for the lifecycle slide."
    assert pop.locator(".tys-count").inner_text() == "1 / 4"
    assert pop.locator(".tys-p-next svg").count() == 1
    # Glyphs resolve against the defs copied into the presenter document.
    assert pop.evaluate(
        "document.querySelector('.tys-p-current svg use').getBBox().width"
    ) > 0
    # The live view matches the audience view (same markup after applying state).
    deck.evaluate("touying.goto(1, 'start'); touying.seek(0.4)")
    norm = "s => s.replace(/tys-clip-\\d+/g, '')"
    audience = deck.evaluate(f"({norm})(document.querySelector('#tys-stage svg').outerHTML)")
    current = pop.evaluate(f"({norm})(document.querySelector('.tys-p-current svg').outerHTML)")
    assert audience == current
    # On the last page the preview says so.
    deck.evaluate("touying.goto(touying.count - 1)")
    assert "End of presentation" in pop.locator(".tys-p-next").inner_text()
    assert deck.errors == []


def test_presenter_navigation_and_notes_keys(deck):
    pop = open_presenter(deck)
    pop.keyboard.press("ArrowRight")  # starts page 2 (A2 + B1)
    assert deck.evaluate("touying.page") == 1
    pop.keyboard.press("ArrowRight")  # finishes playback
    pop.keyboard.press("ArrowRight")
    assert deck.evaluate("touying.page") == 2
    assert pop.locator(".tys-count").inner_text() == "3 / 4"
    # Keys inside the notes pane scroll, they do not navigate.
    pop.locator(".tys-notes-pane").focus()
    pop.keyboard.press("ArrowRight")
    pop.keyboard.press("Space")
    assert deck.evaluate("touying.page") == 2
    # Buttons are commands.
    pop.locator('[data-cmd="prev"]').click()
    assert deck.evaluate("touying.page") == 1
    assert deck.errors == []


def test_attach_mid_animation_keeps_state(deck):
    deck.evaluate("touying.goto(1, 'play')")
    deck.wait_for_timeout(150)
    before = deck.evaluate("[touying.page, touying.activations, touying.playing]")
    pop = open_presenter(deck)
    after = deck.evaluate("[touying.page, touying.activations, touying.playing]")
    assert before == after and after[2] is True
    # Both views run on the one clock: identical markup at any instant.
    deck.wait_for_timeout(200)
    norm = "s => s.replace(/tys-clip-\\d+/g, '')"
    a = deck.evaluate(
        f"(() => {{ const n = {norm}; return [n(document.querySelector('#tys-stage svg').outerHTML),"
        " n(touying.presenter.current.root.querySelector('svg').outerHTML)]; })()"
    )
    assert a[0] == a[1]
    # Re-attaching (P again) installs no duplicate handlers.
    # The window already exists, so it is reused (no new popup) and rebuilt.
    deck.evaluate("touying.player.finish()")
    deck.keyboard.press("p")
    pop.wait_for_selector(".tys-p-current svg")
    assert len(deck.context.pages) == 2
    page = deck.evaluate("touying.page")
    pop.keyboard.press("ArrowRight")
    assert deck.evaluate("touying.page") == page + 1
    assert deck.errors == []


def test_clock_handoff_between_windows(deck):
    pop = open_presenter(deck)
    deck.evaluate("touying.goto(1, 'play')")
    # Audience hidden, presenter visible: the presenter owns the frame loop.
    deck.evaluate(HIDE % "true")
    assert deck.evaluate("touying.player.scheduler.owner === touying.presenter.win")
    t0 = deck.evaluate("touying.player.time")
    pop.wait_for_timeout(250)
    t1 = deck.evaluate("touying.player.time")
    assert t1 > t0, "playback must continue in the presenter"
    # Both hidden: scene time stands still.
    pop.evaluate(HIDE % "true")
    t2 = deck.evaluate("touying.player.time")
    pop.wait_for_timeout(400)
    assert deck.evaluate("touying.player.time") == t2
    assert deck.evaluate("touying.player.scheduler.owner") is None
    # Audience visible again: resumes without a jump over the hidden time.
    deck.evaluate(HIDE % "false")
    deck.wait_for_timeout(100)
    t3 = deck.evaluate("touying.player.time")
    assert t2 < t3 < t2 + 0.35
    # Exactly one loop: ticks per wall-clock second stay at the frame rate.
    ticks = deck.evaluate(
        """() => new Promise(resolve => {
            const p = touying.player; let n = 0; const tick = p.tick.bind(p);
            p.scheduler.tick = () => { n++; tick(); };
            const frames = []; const f = (t) => { frames.push(t); if (frames.length < 20) requestAnimationFrame(f); else resolve([n, frames.length]); };
            requestAnimationFrame(f);
        })"""
    )
    assert ticks[0] <= ticks[1] + 2, ticks
    assert deck.errors == []


def test_closing_the_owner_hands_back(deck):
    pop = open_presenter(deck)
    deck.evaluate("touying.goto(1, 'play')")
    deck.evaluate(HIDE % "true")
    assert deck.evaluate("touying.player.scheduler.owner === touying.presenter.win")
    pop.close()
    deck.wait_for_timeout(1200)  # the 1 s closed-window check
    assert deck.evaluate("touying.presenter") is None
    deck.evaluate(HIDE % "false")
    t0 = deck.evaluate("touying.player.time")
    deck.wait_for_timeout(150)
    assert deck.evaluate("touying.player.time") > t0 or not deck.evaluate("touying.playing")
    assert deck.errors == []


def test_reload_and_reattach(deck):
    open_presenter(deck)
    deck.evaluate("touying.goto(2)")
    deck.reload()
    deck.wait_for_selector("body[data-ready]")
    # The named window still exists (blank in Chromium/WebKit, stale in
    # Firefox): P reuses and rebuilds it.
    deck.keyboard.press("p")
    pop = next(p for p in deck.context.pages if p != deck)
    pop.wait_for_selector(".tys-p-current svg")
    assert pop.locator(".tys-count").inner_text() == "3 / 4"
    assert pop.locator(".tys-p-current svg").count() == 1
    pop.keyboard.press("ArrowLeft")
    assert deck.evaluate("touying.page") == 1


def test_blocked_popup_shows_notice(deck):
    deck.evaluate("window.open = () => null")
    deck.keyboard.press("p")
    assert "blocked" in deck.locator("#tys-toast").inner_text()
    assert deck.evaluate("touying.presenter") is None


def test_timer(deck):
    pop = open_presenter(deck)
    assert pop.locator(".tys-timer").inner_text() == "00:00"
    pop.keyboard.press("ArrowRight")  # the first forward navigation starts it
    assert deck.evaluate("touying.player.timer.running")
    pop.keyboard.press("t")
    assert not deck.evaluate("touying.player.timer.running")
    pop.locator('[data-cmd="timer.reset"]').click()
    assert deck.evaluate("touying.player.timer.elapsed") < 50
