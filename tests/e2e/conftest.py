import os
import time

import pytest

pytest.importorskip("playwright.sync_api")
from playwright import sync_api  # noqa: E402

from touying.html_player import export_html  # noqa: E402

BROWSERS = os.environ.get("TOUYING_BROWSERS", "chromium").split(",")


@pytest.fixture(scope="session", params=BROWSERS)
def browser(request):
    with sync_api.sync_playwright() as p:
        b = getattr(p, request.param).launch()
        yield b
        b.close()


@pytest.fixture(scope="session")
def export(tmp_path_factory, touying_root):
    cache = {}

    def run(deck):
        if deck not in cache:
            out = tmp_path_factory.mktemp("html") / (deck.parent.name + ".html")
            t0 = time.perf_counter()
            stats = export_html(str(deck), output=str(out), root=str(touying_root), silent=True)
            stats["export_seconds"] = time.perf_counter() - t0
            cache[deck] = (out, stats)
        return cache[deck]

    return run
