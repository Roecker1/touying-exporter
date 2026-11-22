import os
from pathlib import Path

import pytest


def _touying_root():
    env = os.environ.get("TOUYING_ROOT")
    if env:
        return Path(env).resolve()
    # Default layout: touying/dependencies/touying-exporter/tests
    candidate = Path(__file__).resolve().parents[3]
    return candidate if (candidate / "lib.typ").exists() else None


TOUYING_ROOT = _touying_root()


@pytest.fixture(scope="session")
def touying_root():
    if TOUYING_ROOT is None:
        pytest.skip("touying checkout not found; set TOUYING_ROOT")
    return TOUYING_ROOT


@pytest.fixture(scope="session")
def scene_deck(touying_root):
    def path(name):
        p = touying_root / "tests" / "features" / "scene" / name / "test.typ"
        assert p.exists(), p
        return p

    return path
