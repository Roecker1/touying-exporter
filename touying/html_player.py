"""Self-contained HTML export with an animation player for touying scenes.

The pipeline:

1. compile the presentation to one SVG per page with
   ``sys.inputs["touying-scene"] = "html"`` (scenes then wrap every object in
   a labelled box and emit ``<touying-scene>`` metadata),
2. query that metadata (with page numbers) and the speaker notes,
3. hoist the content-hashed ``<defs>`` (glyphs, clip paths, gradients) of all
   pages into one shared block, so each glyph is stored once per deck,
4. pack pages, defs, scene records and notes as JSON, gzip and base64-encode
   it, and inline it with the player into a single HTML file.
"""

from __future__ import annotations

import base64
import gzip
import html as htmllib
import json
import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import jinja2

FILE_PATH = os.path.dirname(os.path.realpath(__file__))

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
H5_NS = "http://www.w3.org/1999/xhtml"

ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)
ET.register_namespace("h5", H5_NS)

_DEFS_RE = re.compile(r"<defs(?:\s[^>]*)?>(.*?)</defs>", re.S)
# A scene record travels as the label of an empty group (see touying's
# src/core/scene.typ): <g transform=".." data-typst-label="tys-data:{json}"/>.
_RECORD_RE = re.compile(r'<g\b[^>]*?\sdata-typst-label="tys-data:([^"]*)"[^>]*?/>')
_SIZE_RE = re.compile(r'width="([0-9.]+)pt" height="([0-9.]+)pt"')



class ExportError(RuntimeError):
    pass


@dataclass
class HoistResult:
    pages: List[str]
    defs: Dict[str, str] = field(default_factory=dict)
    kept_local: int = 0


def _defs_children(inner: str) -> List[Tuple[Optional[str], str]]:
    """Split the inside of a ``<defs>`` block into (id, markup) pairs."""
    wrapper = f'<defs xmlns="{SVG_NS}" xmlns:xlink="{XLINK_NS}" xmlns:h5="{H5_NS}">{inner}</defs>'
    root = ET.fromstring(wrapper)
    out = []
    for child in root:
        markup = ET.tostring(child, encoding="unicode", short_empty_elements=True)
        # ElementTree repeats the namespace declaration on every element.
        markup = markup.replace(f' xmlns="{SVG_NS}"', "", 1)
        markup = markup.replace(f' xmlns:xlink="{XLINK_NS}"', "")
        markup = markup.replace(f' xmlns:h5="{H5_NS}"', "")
        out.append((child.get("id"), markup))
    return out


def hoist_defs(pages: List[str]) -> HoistResult:
    """Move every page's ``<defs>`` children into one shared dictionary.

    Typst derives definition ids from a hash of their content, so equal ids
    across pages must mean equal definitions; this is checked, and a page whose
    definition differs keeps its own copy (never silently merged).
    """
    result = HoistResult(pages=[])
    for page in pages:
        local = []
        for match in _DEFS_RE.finditer(page):
            for def_id, markup in _defs_children(match.group(1)):
                if def_id is None:
                    local.append(markup)
                    continue
                known = result.defs.get(def_id)
                if known is None:
                    result.defs[def_id] = markup
                elif known != markup:
                    local.append(markup)
                    result.kept_local += 1
        body = _DEFS_RE.sub("", page)
        if local:
            body = body.replace("</svg>", "<defs>" + "".join(local) + "</defs></svg>")
        result.pages.append(body)
    return result


def responsive_svg(svg: str) -> Tuple[str, Tuple[float, float]]:
    """Let the page fill its container; return the page size in pt."""
    match = _SIZE_RE.search(svg)
    if not match:
        raise ExportError("unexpected SVG header: no width/height in pt")
    size = (float(match.group(1)), float(match.group(2)))
    return _SIZE_RE.sub('width="100%" height="100%"', svg, count=1), size


def extract_scene_records(svg: str) -> Tuple[str, list]:
    """Remove the scene records embedded in a page and return them."""
    records = []

    def take(match):
        value = json.loads(htmllib.unescape(match.group(1)))
        if value.get("schema") not in (1, 2, 3):
            raise ExportError(
                f"unsupported touying-scene schema {value.get('schema')!r}; "
                "update touying-exporter"
            )
        records.append(value)
        return ""

    return _RECORD_RE.sub(take, svg), records


# --------------------------------------------------------------------------
# Tracker knots: renders of a `tracked` object at sampled values. They are
# lifted out of the page into the record, each as (skeleton, numbers): the
# markup with its numbers taken out, plus those numbers. Knots with the same
# skeleton can be interpolated by the player, number by number.

_TAG_RE = re.compile(r"<(/?)([A-Za-z][\w:.-]*)\b[^>]*?(/?)>")
_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_NUM_RE = re.compile(_NUM)
_FULL_NUM_RE = re.compile(rf"^\s*{_NUM}\s*$")
_TRANSLATE_RE = re.compile(rf"^translate\(\s*{_NUM}(?:[\s,]+{_NUM})?\s*\)$")
# Only these attributes carry interpolable numbers; anything else (colours,
# references, matrices, dash patterns, ...) is part of the skeleton and must
# match exactly.
_NUMERIC_ATTRS = {
    "x",
    "y",
    "width",
    "height",
    "stroke-width",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
}


def _element_end(svg: str, start: int) -> int:
    """Index just past the element whose start tag begins at `start`."""
    depth = 0
    for m in _TAG_RE.finditer(svg, start):
        if m.group(3):
            if depth == 0:
                return m.end()
            continue
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.end()
    raise ExportError("unbalanced SVG markup")


def cut_labelled(svg: str, label: str) -> Tuple[str, str]:
    """Remove the element labelled `label`; return (svg, its markup)."""
    i = svg.find(f' data-typst-label="{label}"')
    if i < 0:
        raise ExportError(f"labelled group {label!r} not found")
    start = svg.rfind("<", 0, i)
    end = _element_end(svg, start)
    return svg[:start] + svg[end:], svg[start:end]


def _split_numbers(name: str, value: str):
    """(literals, numbers) if the attribute has interpolable numbers."""
    plain = name.split("}")[-1]
    if plain == "d" and not re.search(r"[aA]", value):
        pass  # arcs carry flags, which must not be interpolated
    elif plain == "transform" and _TRANSLATE_RE.match(value):
        pass
    elif plain in _NUMERIC_ATTRS and _FULL_NUM_RE.match(value):
        pass
    else:
        return None
    numbers = [float(x) for x in _NUM_RE.findall(value)]
    if not numbers:
        return None
    return _NUM_RE.split(value), numbers


_PATH_TAG_RE = re.compile(r"<path\b[^>]*>")
_ONE_ARG_TRANSLATE_RE = re.compile(rf'transform="translate\(\s*({_NUM})\s*\)"')


def _canonical_paths(markup: str) -> str:
    """Give every path the same transform form, so equal shapes tokenize alike.

    Typst omits the transform of a path placed at the origin and writes
    ``translate(x)`` when y is 0; both become ``translate(x y)``.
    """

    def fix(match):
        tag = match.group(0)
        if " transform=" not in tag:
            end = -2 if tag.endswith("/>") else -1
            return tag[:end] + ' transform="translate(0 0)"' + tag[end:]
        return _ONE_ARG_TRANSLATE_RE.sub(r'transform="translate(\1 0)"', tag)

    return _PATH_TAG_RE.sub(fix, markup)


def tokenize_knot(markup: str):
    """Split a knot group into (skeleton key, template, attrs, numbers).

    `attrs` lists [element index, attribute, literals] for every attribute with
    numbers, element indices counting the root and its descendants in document
    order; `numbers` are their values in that order.
    """
    template = _canonical_paths(re.sub(r' data-typst-label="[^"]*"', "", markup, count=1))
    wrapper = f'<g xmlns="{SVG_NS}" xmlns:xlink="{XLINK_NS}" xmlns:h5="{H5_NS}">{template}</g>'
    root = ET.fromstring(wrapper)[0]
    key, attrs, numbers = [], [], []
    for index, el in enumerate(root.iter()):
        key.append(el.tag)
        # Attribute order is not significant; sort so it cannot split skeletons.
        for name, value in sorted(el.attrib.items()):
            split = _split_numbers(name, value)
            if split is None:
                key.append(f"{name}={value}")
            else:
                literals, nums = split
                key.append(f"{name}~" + "#".join(literals))
                attrs.append([index, name.split("}")[-1], literals])
                numbers.extend(nums)
    return "\x00".join(key), template, attrs, numbers


def extract_knots(svg: str, records: list) -> str:
    """Move the knot groups of tracked objects from the page into the records."""
    for record in records:
        for obj in record.get("objects", []):
            knots = obj.get("knots")
            # 3D objects carry geometry knots (positions) in the record itself.
            if not knots or knots.get("kind") == "geom":
                continue
            skeletons, keys, items = [], {}, []
            for label in knots.pop("labels"):
                svg, markup = cut_labelled(svg, label)
                key, template, attrs, numbers = tokenize_knot(markup)
                if key not in keys:
                    keys[key] = len(skeletons)
                    skeletons.append({"template": template, "attrs": attrs})
                items.append({"s": keys[key], "v": numbers})
            knots["skeletons"] = skeletons
            knots["knots"] = items
    return svg


def notes_by_page(raw: str) -> Dict[int, str]:
    data = json.loads(raw)
    if not data:
        return {}
    pdfpc = data[0]
    return {
        int(page["idx"]): page["note"]
        for page in pdfpc.get("pages", [])
        if page.get("note")
    }


def pack_payload(payload: dict, compress: bool = True) -> Tuple[str, str]:
    """Return (encoding, text) for embedding the payload in a script tag."""
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    if not compress:
        # `</` must not appear inside a <script> element.
        return "json", data.replace("</", "<\\/")
    packed = gzip.compress(data.encode("utf-8"), compresslevel=9, mtime=0)
    return "gzip+base64", base64.b64encode(packed).decode("ascii")


def build_html(
    pages: List[str],
    notes_raw: str = "[]",
    title: str = "Touying",
    compress: bool = True,
    start_page: int = 1,
    count: Optional[int] = None,
) -> Tuple[str, dict]:
    """Assemble the HTML document. Returns (html, stats)."""
    if count is None:
        count = len(pages) - (start_page - 1)
    selected = list(range(start_page - 1, min(len(pages), start_page - 1 + count)))

    raw_bytes = sum(len(p.encode("utf-8")) for p in pages)
    scenes = []
    stripped = []
    for i in selected:
        page, records = extract_scene_records(pages[i])
        page = extract_knots(page, records)
        stripped.append(page)
        scenes.append(records)
    hoisted = hoist_defs(stripped)
    svgs, size = [], None
    for svg in hoisted.pages:
        svg, page_size = responsive_svg(svg)
        size = size or page_size
        svgs.append(svg)

    notes = notes_by_page(notes_raw)
    payload = {
        "version": 1,
        "size": size,
        "defs": "".join(hoisted.defs.values()),
        "pages": svgs,
        "scenes": scenes,
        "notes": [notes.get(i, "") for i in selected],
    }
    encoding, text = pack_payload(payload, compress=compress)

    env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(os.path.join(FILE_PATH, "player")),
        autoescape=False,
    )
    player_js = _read_asset("player.js")
    if compress:
        # The player is a fixed cost per deck: ship it compressed as well.
        player_js = base64.b64encode(
            gzip.compress(player_js.encode("utf-8"), compresslevel=9, mtime=0)
        ).decode("ascii")
    else:
        player_js = player_js.replace("</script", "<\\/script")
    html = env.get_template("player.html.j2").render(
        title=title,
        payload=text,
        encoding=encoding,
        player_js=player_js,
        player_compressed=compress,
        player_css=_read_asset("player.css"),
    )
    stats = {
        "pages": len(selected),
        "scenes": sum(len(v) for v in payload["scenes"]),
        "raw_svg_bytes": raw_bytes,
        "shared_defs": len(hoisted.defs),
        "defs_kept_local": hoisted.kept_local,
        "payload_bytes": len(text.encode("utf-8")),
        "html_bytes": len(html.encode("utf-8")),
    }
    return html, stats


def _read_asset(name: str) -> str:
    with open(os.path.join(FILE_PATH, "player", name), encoding="utf8") as f:
        return f.read()


def export_html(
    input,
    output=None,
    root=None,
    font_paths=(),
    sys_inputs=None,
    start_page=1,
    count=None,
    compress=True,
    silent=False,
) -> dict:
    """Compile ``input`` and write the self-contained HTML presentation."""
    import typst

    inputs = dict(sys_inputs or {})
    inputs.setdefault("touying-scene", "html")
    if not silent:
        print(f"Compiling typst source file {input}...")
    compiler = typst.Compiler(
        input, root=root, font_paths=list(font_paths), sys_inputs=inputs
    )
    pages = compiler.compile(format="svg")
    if not isinstance(pages, list):
        pages = [pages]
    pages = [p.decode("utf-8") for p in pages]
    notes_raw = compiler.query("<pdfpc-file>", field="value")

    html, stats = build_html(
        pages,
        notes_raw=notes_raw,
        title=Path(input).stem,
        compress=compress,
        start_page=start_page,
        count=count,
    )
    if output is None:
        output = Path(input).with_suffix(".html")
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w", encoding="utf8") as f:
        f.write(html)
    if not silent:
        print(
            f"Presentation saved to {output}: {stats['pages']} pages, "
            f"{stats['scenes']} scene segments, "
            f"{stats['raw_svg_bytes'] / 1024:.0f} KiB SVG -> "
            f"{stats['html_bytes'] / 1024:.0f} KiB HTML"
        )
    return stats
