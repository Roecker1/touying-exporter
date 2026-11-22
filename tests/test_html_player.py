import base64
import gzip
import json
import re

import pytest

from touying.html_player import (
    ExportError,
    build_html,
    extract_scene_records,
    hoist_defs,
    pack_payload,
)

HEAD = (
    '<svg viewBox="0 0 100 50" width="100pt" height="50pt" '
    'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
    'xmlns:h5="http://www.w3.org/1999/xhtml">'
)
GLYPH = '<symbol id="gAAA" overflow="visible"><path d="M 0 0h 1"/></symbol>'
CLIP = '<clipPath id="cBBB"><path d="M 0 0v 2"/></clipPath>'


def page(body, defs):
    return f"{HEAD}{body}<defs>{defs}</defs></svg>"


def test_hoist_dedupes_shared_definitions():
    p1 = page('<use xlink:href="#gAAA" x="1"/>', GLYPH)
    p2 = page('<g clip-path="url(#cBBB)"><use xlink:href="#gAAA"/></g>', GLYPH + CLIP)
    result = hoist_defs([p1, p2])
    assert set(result.defs) == {"gAAA", "cBBB"}
    assert result.kept_local == 0
    # Page bodies are untouched apart from the removed <defs> block.
    assert result.pages[0] == f'{HEAD}<use xlink:href="#gAAA" x="1"/></svg>'
    assert "<defs" not in result.pages[1]
    assert 'xmlns=' not in result.defs["gAAA"]


def test_hoist_keeps_conflicting_definitions_local():
    other = '<symbol id="gAAA" overflow="visible"><path d="M 0 0h 2"/></symbol>'
    result = hoist_defs([page("", GLYPH), page("", other)])
    assert result.kept_local == 1
    assert 'h 2' in result.pages[1] and 'h 1' in result.defs["gAAA"]


def test_extract_scene_records_unescapes_and_strips():
    record = {"schema": 1, "scene": {"alt": "a<b & \"c\""}}
    encoded = (
        json.dumps(record, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace('"', "&quot;")
    )
    svg = page(
        f'<g data-typst-label="tys-s1-x"><g transform="translate(1 2)" '
        f'data-typst-label="tys-data:{encoded}"/><path d="M 0 0"/></g>',
        "",
    )
    stripped, records = extract_scene_records(svg)
    assert records == [record]
    assert "tys-data" not in stripped and '<path d="M 0 0"/>' in stripped


def test_schema_mismatch_is_an_error():
    svg = page('<g data-typst-label="tys-data:{&quot;schema&quot;:99}"/>', "")
    with pytest.raises(ExportError):
        extract_scene_records(svg)


def test_pack_payload_roundtrip_and_script_safety():
    payload = {"pages": ["</script><svg/>"], "n": 1}
    enc, text = pack_payload(payload, compress=True)
    assert enc == "gzip+base64"
    assert json.loads(gzip.decompress(base64.b64decode(text))) == payload
    enc, text = pack_payload(payload, compress=False)
    assert enc == "json" and "</script>" not in text
    assert json.loads(text) == payload


def test_build_html_is_self_contained():
    html, stats = build_html([page('<use xlink:href="#gAAA"/>', GLYPH)] * 3)
    assert stats["pages"] == 3 and stats["shared_defs"] == 1
    assert not re.search(r'<(script|link)[^>]+(src|href)=', html)
    assert 'data-encoding="gzip+base64"' in html


def test_real_deck_references_resolve(scene_deck, touying_root):
    typst = pytest.importorskip("typst")

    deck = scene_deck("basic")
    compiler = typst.Compiler(
        str(deck), root=str(touying_root), sys_inputs={"touying-scene": "html"}
    )
    pages = [p.decode() for p in compiler.compile(format="svg")]
    records = [extract_scene_records(p) for p in pages]
    assert [len(r) for _, r in records] == [1, 1, 1, 1]
    assert [r[0]["lifecycle"] for _, r in records] == ["active"] * 3 + ["held"]
    result = hoist_defs([p for p, _ in records])
    for body in result.pages:
        for ref in re.findall(r'(?:xlink:href="#|url\(#)([^")]+)', body):
            assert ref in result.defs, ref


def test_uncompressed_build_inlines_the_player():
    html, _ = build_html([page('<use xlink:href="#gAAA"/>', GLYPH)], compress=False)
    assert 'data-encoding="json"' in html and "tys-player-code" not in html
    assert "class Player" in html
    html, _ = build_html([page('<use xlink:href="#gAAA"/>', GLYPH)])
    assert "tys-player-code" in html and "class Player" not in html
