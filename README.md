# Touying Exporter

Export presentation slides in various formats for Touying.


## HTML Export

The HTML export renders every page to SVG and packs the deck into **one self-contained, offline HTML file**. It also plays touying's manim-style [scenes](https://github.com/touying-typ/touying): fades, drawing, writing, moves, rotations, paths and value trackers.

- **Small:** glyphs, clip paths and gradients are stored once per deck rather than once per page, and the payload is gzip-compressed and decoded in the browser.
- **Faithful:** scenes are rendered by Typst. The player only animates labelled groups, using the same model and easing tables as the PDF output.
- **Smooth trackers and morphs:** value trackers with `interpolate: true` are blended between Typst-rendered samples wherever their SVG structure matches. `transform-matching` morphs equations glyph by glyph, with a crossfade where an overlay could not look right.
- **Presenter keys:** arrow keys, space or click to go forward; a click during an animation finishes it. <kbd>R</kbd> replays the step, <kbd>N</kbd> shows the speaker notes, <kbd>F</kbd> toggles fullscreen.
- **Presenter window:** <kbd>P</kbd> (or <kbd>S</kbd>) opens a second window that shows the current page live, the next page, the speaker notes and a timer (<kbd>T</kbd> pauses it). Both windows navigate the deck. Animations run on a single clock and keep playing while either window is visible.

`--html-engine impress` selects the previous impress.js export. `--no-compress` embeds the deck as plain JSON for debugging or for very old browsers.

![image](https://github.com/touying-typ/touying-exporter/assets/34951714/207ddffc-87c8-4976-9bf4-4c6c5e2573ea)

![image](https://github.com/touying-typ/touying-exporter/assets/34951714/eac4976b-7d5d-40b6-8827-88c9a024b89a)

[Touying template](https://github.com/touying-typ/touying-template) for online presentation. [Online](https://touying-typ.github.io/touying-template/)

## PPTX Export

We generate PNG image files and package them into a PPTX file. This way, you can open and present it using PowerPoint, and it supports speaker notes.

![image](https://github.com/touying-typ/touying-exporter/assets/34951714/3d547c74-fb4b-4c31-81e5-5138a5d727c9)

## Install

```sh
pip install touying
```


## CLI

```text
usage: touying compile [-h] [--output OUTPUT] [--root ROOT] [--font-paths [FONT_PATHS ...]] [--start-page START_PAGE] [--count COUNT] [--ppi PPI] [--silent SILENT] [--format {html,pptx,pdf,pdfpc}] [--html-engine {player,impress}] [--no-compress] [--sys-inputs SYS_INPUTS] input

positional arguments:
  input                 Input file

options:
  -h, --help            show this help message and exit
  --output OUTPUT       Output file
  --root ROOT           Root directory for typst file
  --font-paths [FONT_PATHS ...]
                        Paths to custom fonts
  --start-page START_PAGE
                        Page to start from
  --count COUNT         Number of pages to convert
  --ppi PPI             Pixels per inch for PPTX format
  --silent SILENT       Run silently
  --format {html,pptx,pdf,pdfpc}
                        Output format
  --html-engine {player,impress}
                        HTML engine: the compact scene player (default) or the legacy impress.js export
  --no-compress         Embed the HTML payload as plain JSON instead of gzip+base64
  --sys-inputs SYS_INPUTS
                        JSON string to pass to typst's sys.inputs
```

For example:

```sh
touying compile example.typ
```

You will get a `example.html` file. Open it with your browser and start your presentation :-)

### Passing variables to typst

You can pass variables to your typst files using the `--sys-inputs` parameter:

```sh
touying compile example.typ --sys-inputs '{"title":"My Presentation","author":"John Doe"}'
```

In your typst file, you can access these variables like this:

```typst
#let title = sys.inputs.at("title", default: "Default Title")
#let author = sys.inputs.at("author", default: "Default Author")

= #title
By #author
```


## Use it as a python package

```python
import touying

touying.to_html("example.typ")
```

## Thanks

- [impress.js](https://github.com/impress/impress.js)
- [typst-py](https://github.com/messense/typst-py)
- [python-pptx](https://github.com/scanny/python-pptx)

## Development

```sh
python -m venv .venv && .venv/bin/pip install -e . pytest playwright
.venv/bin/python -m playwright install chromium
TOUYING_ROOT=/path/to/touying .venv/bin/python -m pytest tests
```

The end-to-end tests in `tests/e2e` export the scene decks in touying's `tests/features/scene` and drive the player with Playwright. When touying-exporter is checked out as touying's `dependencies/touying-exporter` submodule, `TOUYING_ROOT` is found automatically. `TOUYING_BROWSERS=chromium,firefox,webkit` runs them in more browsers.
