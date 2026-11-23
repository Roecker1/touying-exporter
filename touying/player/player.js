// touying HTML player: navigation plus playback of touying scenes.
//
// Every page is the SVG Typst rendered for one subslide. Pages that carry
// `<touying-scene>` records contain labelled groups (`data-typst-label`) for
// each scene object; this player animates them by evaluating the same
// history-free model as Typst: a state is a pure function of (record, time).
(() => {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const EPS = 1e-9;
  const reducedMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const num = (x) => (Math.abs(x) < 1e-9 ? "0" : String(+x.toFixed(4)));

  // ---------------------------------------------------------------- payload

  async function loadPayload() {
    const el = document.getElementById("tys-payload");
    const text = el.textContent.trim();
    if (el.dataset.encoding === "json") return JSON.parse(text);
    if (typeof DecompressionStream === "undefined") {
      throw new Error(
        "This browser cannot decompress the presentation. " +
          "Use a current browser, or export with --no-compress."
      );
    }
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  // ------------------------------------------------------ model evaluation

  // Rate tables are sampled by Typst; both sides interpolate them linearly.
  function easeEval(table, p) {
    p = clamp(p, 0, 1);
    const x = p * (table.length - 1);
    const i = Math.min(Math.floor(x), table.length - 2);
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  }

  function pathAt(points, p) {
    const lengths = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const l = Math.hypot(
        points[i + 1][0] - points[i][0],
        points[i + 1][1] - points[i][1]
      );
      lengths.push(l);
      total += l;
    }
    if (total <= EPS) return points[0];
    const target = clamp(p, 0, 1) * total;
    let acc = 0;
    for (let i = 0; i < lengths.length; i++) {
      const l = lengths[i];
      if (acc + l >= target - EPS || i === lengths.length - 1) {
        const f = l <= EPS ? 0 : clamp((target - acc) / l, 0, 1);
        const a = points[i];
        const b = points[i + 1];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      }
      acc += l;
    }
    return points[points.length - 1];
  }

  // State of one object at segment-local time t (mirrors Typst's _state-at).
  function evalObject(rec, rates, t) {
    const s = Object.assign({}, rec.initial);
    for (const tr of rec.tracks) {
      if (t + EPS < tr.t0) continue;
      const p =
        tr.t1 - tr.t0 <= EPS ? 1 : clamp((t - tr.t0) / (tr.t1 - tr.t0), 0, 1);
      const e = easeEval(rates[tr.ease], p);
      if (tr.prop === "path") {
        const [x, y] = pathAt(tr.points, e);
        s.tx = x;
        s.ty = y;
      } else {
        s[tr.prop] = tr.v0 + (tr.v1 - tr.v0) * e;
        // A passing flash's window width travels with its track.
        if (tr.w !== undefined) s.passW = tr.w;
      }
    }
    return s;
  }

  // ------------------------------------------------------------ scene view

  // Which knot(s) of a tracked object to show at segment time t:
  // {k} or {k, k1, f} to blend (see touying's `_spans`).
  function knotSelect(K, t, duration, rates, blendable) {
    if (t >= duration - 1e-9 || K.spans.length === 0) return { k: K.end };
    let span = K.spans[K.spans.length - 1];
    for (const sp of K.spans) {
      if (t < sp.b - 1e-9) {
        span = sp;
        break;
      }
    }
    const pts = span.knots;
    if (span.kind === "hold" || pts.length === 1) return { k: pts[0][1] };
    const p =
      span.kind === "progress"
        ? easeEval(rates[span.ease], (t - span.a) / (span.b - span.a))
        : t;
    let i = 0;
    while (i < pts.length - 1 && pts[i + 1][0] <= p + 1e-12) i++;
    const [p0, k0] = pts[i];
    if (i >= pts.length - 1 || !K.interpolate) return { k: k0 };
    const [p1, k1] = pts[i + 1];
    const f = clamp((p - p0) / (p1 - p0), 0, 1);
    if (f <= 1e-9) return { k: k0 };
    if (!blendable(k0, k1)) return { k: k0 };
    return { k: k0, k1, f };
  }

  let clipIds = 0;

  function byLabel(root, label) {
    return root.querySelector(`[data-typst-label="${CSS.escape(label)}"]`);
  }

  function isLeaf(el) {
    return /^(path|use|image|rect|circle|ellipse|line|polyline|polygon|text)$/.test(
      el.localName
    );
  }

  // Bounding box of the visible geometry inside `inner`, in its user space.
  // Invisible helpers (e.g. the CeTZ bounds rectangle) are skipped.
  function contentBBox(inner) {
    const base = inner.getCTM();
    if (!base) return inner.getBBox();
    const inv = base.inverse();
    let box = null;
    for (const el of inner.querySelectorAll("*")) {
      if (!isLeaf(el)) continue;
      const fill = el.getAttribute("fill");
      const stroke = el.getAttribute("stroke");
      if (el.localName === "path" && fill === "none" && (!stroke || stroke === "none"))
        continue;
      let bb;
      try {
        bb = el.getBBox();
      } catch (_) {
        continue;
      }
      const m = inv.multiply(el.getCTM());
      for (const [x, y] of [
        [bb.x, bb.y],
        [bb.x + bb.width, bb.y],
        [bb.x, bb.y + bb.height],
        [bb.x + bb.width, bb.y + bb.height],
      ]) {
        const px = m.a * x + m.c * y + m.e;
        const py = m.b * x + m.d * y + m.f;
        box = box
          ? {
              x0: Math.min(box.x0, px),
              y0: Math.min(box.y0, py),
              x1: Math.max(box.x1, px),
              y1: Math.max(box.y1, py),
            }
          : { x0: px, y0: py, x1: px, y1: py };
      }
    }
    if (!box) return inner.getBBox();
    return { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
  }

  class ObjectView {
    constructor(el, rec) {
      this.rec = rec;
      // Never touch Typst's own transform: animate wrappers inside the group.
      // Pages are also shown in the presenter window: create nodes in the
      // document that owns this page.
      const doc = el.ownerDocument;
      this.el = el;
      this.xf = doc.createElementNS(SVGNS, "g");
      this.inner = doc.createElementNS(SVGNS, "g");
      while (el.firstChild) this.inner.appendChild(el.firstChild);
      this.xf.appendChild(this.inner);
      el.appendChild(this.xf);
      this.strokes = null;
      this.others = null;
      this.drawing = false;
      this.clipRect = null;
      // Geometry revision: bumped whenever rendered geometry changes, so
      // cached reveal bounds are recomputed.
      this.geometry = 0;
      this.bboxGeometry = -1;
      // Tracked objects: one DOM group per skeleton, mounted on demand.
      this.skeletons = [];
      this.mounted = null;
    }

    // ---- tracked objects (knots) ----

    skeleton(id) {
      let sk = this.skeletons[id];
      if (!sk) {
        const spec = this.rec.knots.skeletons[id];
        const holder = this.inner.ownerDocument.createElementNS(SVGNS, "g");
        holder.innerHTML = spec.template;
        const el = holder.firstElementChild;
        sk = { el, elems: [el, ...el.querySelectorAll("*")], attrs: spec.attrs, values: null };
        this.skeletons[id] = sk;
      }
      return sk;
    }

    // Which knot(s) to show at segment time t: {k} or {k, k1, f} to blend.
    knotAt(t, duration, rates) {
      const K = this.rec.knots;
      // Only knots with the same skeleton can be blended number by number.
      return knotSelect(K, t, duration, rates, (a, b) => K.knots[a].s === K.knots[b].s);
    }

    applyKnots(t, duration, rates) {
      const K = this.rec.knots;
      const sel = this.knotAt(t, duration, rates);
      const knot = K.knots[sel.k];
      const sk = this.skeleton(knot.s);
      if (this.mounted !== sk) {
        if (this.drawing) this.applyStroke(1);
        if (this.mounted) this.mounted.el.remove();
        this.inner.appendChild(sk.el);
        this.mounted = sk;
        this.strokes = null;
        this.others = null;
        this.geometry++;
      }
      let values = knot.v;
      let exact = true;
      if (sel.k1 !== undefined) {
        const v1 = K.knots[sel.k1].v;
        values = values.map((x, i) => x + (v1[i] - x) * sel.f);
        exact = false;
      }
      if (sk.values === values) return;
      sk.values = values;
      const format = exact ? String : num;
      let j = 0;
      for (const [index, name, literals] of sk.attrs) {
        let str = literals[0];
        for (let n = 1; n < literals.length; n++) str += format(values[j++]) + literals[n];
        sk.elems[index].setAttribute(name, str);
      }
      this.geometry++;
    }

    classify() {
      this.strokes = [];
      this.others = [];
      for (const el of this.inner.querySelectorAll("*")) {
        if (!isLeaf(el)) continue;
        const stroke = el.getAttribute("stroke");
        const strokeOnly =
          el.localName === "path" &&
          el.getAttribute("fill") === "none" &&
          stroke &&
          stroke !== "none" &&
          !el.getAttribute("stroke-dasharray");
        (strokeOnly ? this.strokes : this.others).push(el);
      }
    }

    // Owns the stroke dash state of the object's leaves: `create` (draw < 1)
    // and passing flashes (pass >= 0, window width w). Both neutral restores
    // everything, so seeks in any order are idempotent.
    applyStroke(d, pass = -1, w = 0.3) {
      const passing = pass !== undefined && pass >= 0;
      if (!passing && d >= 1 - 1e-6) {
        if (!this.drawing) return;
        for (const p of this.strokes) {
          p.removeAttribute("pathLength");
          p.style.strokeDasharray = "";
          p.style.strokeDashoffset = "";
          p.style.opacity = "";
        }
        for (const o of this.others) o.style.opacity = "";
        this.drawing = false;
        return;
      }
      if (!this.strokes) this.classify();
      this.drawing = true;
      if (passing) {
        // manim's ShowPassingFlash window; empty at both ends.
        const upper = Math.min((1 + w) * pass, 1);
        const lower = Math.max((1 + w) * pass - w, 0);
        const len = upper - lower;
        for (const p of this.strokes) {
          p.setAttribute("pathLength", "1");
          p.style.strokeDasharray = `${num(Math.max(len, 0))} 2`;
          p.style.strokeDashoffset = num(-lower);
          p.style.opacity = len > 1e-6 ? "" : "0";
        }
        for (const o of this.others) o.style.opacity = "0";
        return;
      }
      const v = clamp(d, 0, 1);
      for (const p of this.strokes) {
        p.setAttribute("pathLength", "1");
        p.style.strokeDasharray = "1 1";
        p.style.strokeDashoffset = num(1 - v);
        p.style.opacity = "";
      }
      // Fills, glyphs, images and marks cannot be stroked in: fade them.
      for (const o of this.others) o.style.opacity = num(v);
    }

    applyReveal(r) {
      if (r >= 1 - 1e-6) {
        if (this.clipRect) this.inner.removeAttribute("clip-path");
        return;
      }
      if (this.bboxGeometry !== this.geometry) {
        this.bbox = contentBBox(this.inner);
        this.bboxGeometry = this.geometry;
      }
      if (!this.clipRect) {
        const doc = this.inner.ownerDocument;
        const clip = doc.createElementNS(SVGNS, "clipPath");
        this.clipId = `tys-clip-${++clipIds}`;
        clip.setAttribute("id", this.clipId);
        clip.setAttribute("clipPathUnits", "userSpaceOnUse");
        this.clipRect = doc.createElementNS(SVGNS, "rect");
        clip.appendChild(this.clipRect);
        this.xf.insertBefore(clip, this.inner);
      }
      const pad = 2;
      const bb = this.bbox;
      this.clipRect.setAttribute("x", num(bb.x - pad));
      this.clipRect.setAttribute("y", num(bb.y - pad));
      this.clipRect.setAttribute("height", num(bb.height + 2 * pad));
      this.clipRect.setAttribute(
        "width",
        num(Math.max(0, (bb.width + 2 * pad) * clamp(r, 0, 1)))
      );
      this.inner.setAttribute("clip-path", `url(#${this.clipId})`);
    }

    apply(s, t, duration, rates) {
      if (this.rec.knots) this.applyKnots(t, duration, rates);
      const op = clamp(s.opacity, 0, 1);
      if (op >= 1 - 1e-6) this.xf.removeAttribute("opacity");
      else this.xf.setAttribute("opacity", num(op));

      const [px, py] = this.rec.pivot;
      const identity =
        Math.abs(s.tx) < 1e-6 &&
        Math.abs(s.ty) < 1e-6 &&
        Math.abs(s.rot) < 1e-6 &&
        Math.abs(s.scale - 1) < 1e-6;
      if (identity) this.xf.removeAttribute("transform");
      else
        // M = T(t) · T(p) · R(θ) · S(s) · T(-p); θ is counter-clockwise.
        this.xf.setAttribute(
          "transform",
          `translate(${num(s.tx + px)} ${num(s.ty + py)}) rotate(${num(-s.rot)}) ` +
            `scale(${num(s.scale)}) translate(${num(-px)} ${num(-py)})`
        );

      if (op > 0) {
        this.applyStroke(s.draw, s.pass, s.passW);
        this.applyReveal(s.reveal);
      }

    }
  }

  class SceneView {
    constructor(svg, rec) {
      this.rec = rec;
      this.objects = [];
      this.root = byLabel(svg, rec.scene.dom);
      if (!this.root) return; // hidden on this page (metadata survives `hide`)
      if (rec.scene.alt) {
        this.root.setAttribute("role", "img");
        this.root.setAttribute("aria-label", rec.scene.alt);
      }
      for (const o of rec.objects) {
        const el = byLabel(this.root, o.label);
        if (el) this.objects.push(new ObjectView(el, o));
      }
      this.morphs = (rec.morphs || []).map((m) => new MorphView(this, m));
      this.world = rec.camera ? new World3D(this) : null;
    }

    object(id) {
      return this.objects.find((o) => o.rec.id === id);
    }

    applyObjects(tt) {
      for (const v of this.objects)
        v.apply(evalObject(v.rec, this.rec.rates, tt), tt, this.rec.duration, this.rec.rates);
    }

    get active() {
      return this.rec.lifecycle === "active";
    }

    apply(t) {
      const tt = clamp(t, 0, this.rec.duration);
      // Morphs measure both objects at their end points first.
      for (const m of this.morphs) if (!m.ready) m.setup();
      this.applyObjects(tt);
      if (this.world) this.world.apply(tt);
      // Morph ownership: clear every override first, then let the active
      // morphs (in timeline order) set theirs, so an inactive morph never
      // undoes an active one on a shared object (A -> B -> C).
      for (const m of this.morphs) m.clear();
      for (const m of this.morphs) m.apply(tt);
    }

    states(t) {
      const tt = clamp(t, 0, this.rec.duration);
      const out = {};
      for (const v of this.objects) out[v.rec.id] = evalObject(v.rec, this.rec.rates, tt);
      return out;
    }
  }


  // -------------------------------------------------------------------- 3D

  // Mirrors touying's src/core/scene3d.typ (the specification is there):
  // camera basis, near-plane clipping before projection, open-path
  // triangles, shading on sRGB channels and painter's-algorithm sorting.
  const NEAR = 0.05;
  const TINY = 1e-9;
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const len3 = (a) => Math.sqrt(dot3(a, a));
  const DEG = Math.PI / 180;
  const MAT_ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

  function matMul(a, b) {
    const out = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 4; j++) {
        let v = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j];
        if (j === 3) v += a[i * 4 + 3];
        out.push(v);
      }
    return out;
  }

  const matApply = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];

  function matRotation(axis, deg, pivot) {
    const n = mul3(axis, 1 / len3(axis));
    const [x, y, z] = n;
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG), k = 1 - c;
    const r = [
      [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
      [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
      [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
    ];
    const t = sub3(pivot, r.map((row) => dot3(row, pivot)));
    return [...r[0], t[0], ...r[1], t[1], ...r[2], t[2]];
  }

  function stepsMatrix(steps, state) {
    let m = MAT_ID;
    steps.forEach((st, k) => {
      const e = state["step:" + k] || 0;
      if (Math.abs(e) < TINY) return;
      const s =
        st.kind === "rot"
          ? matRotation(st.axis, st.angle * e, st.pivot)
          : [1, 0, 0, st.vec[0] * e, 0, 1, 0, st.vec[1] * e, 0, 0, 1, st.vec[2] * e];
      m = matMul(s, m);
    });
    return m;
  }

  function makeView(v, unit, at) {
    const p = v.phi * DEG, t = v.theta * DEG;
    return {
      c: [Math.sin(p) * Math.cos(t), Math.sin(p) * Math.sin(t), Math.cos(p)],
      right: [-Math.sin(t), Math.cos(t), 0],
      up: [-Math.cos(p) * Math.cos(t), -Math.cos(p) * Math.sin(t), Math.sin(p)],
      center: [v.cx, v.cy, v.cz],
      ifocal: v.ifocal,
      scale: v.zoom * unit,
      at,
    };
  }

  function toCamera(view, p) {
    const q = sub3(p, view.center);
    const d = dot3(q, view.c);
    return [dot3(q, view.right), dot3(q, view.up), d, 1 - d * view.ifocal];
  }

  const toScreen = (view, c) => [
    view.at[0] + (c[0] / c[3]) * view.scale,
    view.at[1] - (c[1] / c[3]) * view.scale,
  ];

  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbHex = (ch) =>
    "#" + ch.map((x) => clamp(x, 0, 255).toString(16).padStart(2, "0")).join("");

  function shadeHex(hex, tri, view) {
    const [a, b, c] = tri;
    const n = cross3(sub3(b, a), sub3(c, a));
    const l = len3(n);
    if (l < TINY) return hex;
    const k = 0.35 + 0.65 * Math.abs(dot3(mul3(n, 1 / l), view.c));
    return rgbHex(hexRgb(hex).map((x) => Math.round(x * k)));
  }

  const cutAt = (p, q) => {
    const t = (NEAR - p[3]) / (q[3] - p[3]);
    return [0, 1, 2, 3].map((k) => p[k] + (q[k] - p[k]) * t);
  };

  // Clip against w >= NEAR; flags[i] = stroked edge ending at point i.
  function clipPolygon(pts, flags) {
    const out = [], outFlags = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[(i + n - 1) % n], q = pts[i], f = flags[i];
      const pin = p[3] >= NEAR - TINY, qin = q[3] >= NEAR - TINY;
      if (pin && qin) {
        out.push(q);
        outFlags.push(f);
      } else if (pin && !qin) {
        out.push(cutAt(p, q));
        outFlags.push(f);
      } else if (!pin && qin) {
        out.push(cutAt(p, q));
        outFlags.push(false);
        out.push(q);
        outFlags.push(f);
      }
    }
    const pts2 = [], flags2 = [];
    out.forEach((p, i) => {
      if (pts2.length && len3(sub3(p, pts2[pts2.length - 1])) < TINY) {
        flags2[flags2.length - 1] = flags2[flags2.length - 1] || outFlags[i];
        return;
      }
      pts2.push(p);
      flags2.push(outFlags[i]);
    });
    if (pts2.length > 1 && len3(sub3(pts2[0], pts2[pts2.length - 1])) < TINY) {
      pts2.pop();
      const last = flags2.pop();
      flags2[0] = flags2[0] || last;
    }
    return [pts2, flags2];
  }

  function area2(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  function compareKeys(x, y) {
    for (let i = 0; i < 4; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
    return 0;
  }

  // items: [{geom, pos, matrix, opacity, draw}] in declaration order.
  function drawables(view, items) {
    const list = [];
    items.forEach((item, oi) => {
      const { geom, pos, matrix, opacity, draw } = item;
      if (opacity <= TINY) return;
      const world = [];
      for (let i = 0; i < pos.length; i += 3) world.push(matApply(matrix, [pos[i], pos[i + 1], pos[i + 2]]));
      const cam = world.map((p) => toCamera(view, p));
      const partial = clamp(draw, 0, 1);
      geom.prims.forEach((pr, pi) => {
        const kind = pr[0];
        if (kind === "t") {
          const [, a, b, c, mi, mask] = pr;
          const m = geom.mats[mi];
          const fill = m.f !== null && m.shade ? shadeHex(m.f, [world[a], world[b], world[c]], view) : m.f;
          const flags = [((mask >> 2) & 1) === 1, (mask & 1) === 1, ((mask >> 1) & 1) === 1];
          const tri = [cam[a], cam[b], cam[c]];
          let pts = tri, fl = flags;
          if (!tri.every((q) => q[3] >= NEAR)) [pts, fl] = clipPolygon(tri, flags);
          if (pts.length < 3) return;
          const screen = pts.map((q) => toScreen(view, q));
          if (area2(screen) < 1e-12) return;
          list.push({
            key: [pts.reduce((s, q) => s + q[2], 0) / pts.length, oi, pi, 0],
            kind: "poly", pts: screen, flags: fl,
            fill, fa: m.fa * opacity * partial, stroke: m.s, sa: m.sa * opacity * partial, sw: m.sw,
          });
        } else if (kind === "s") {
          const [, a, b, mi, s0, s1] = pr;
          if (partial <= s0 + TINY) return;
          const m = geom.mats[mi];
          const pb = partial < s1
            ? toCamera(view, add3(world[a], mul3(sub3(world[b], world[a]), (partial - s0) / (s1 - s0))))
            : cam[b];
          const pa = cam[a];
          const ain = pa[3] >= NEAR, bin = pb[3] >= NEAR;
          if (!ain && !bin) return;
          const [p, q] = ain && bin ? [pa, pb] : ain ? [pa, cutAt(pa, pb)] : [cutAt(pa, pb), pb];
          const sp = toScreen(view, p), sq = toScreen(view, q);
          if (Math.hypot(sp[0] - sq[0], sp[1] - sq[1]) < 1e-9) return;
          list.push({
            key: [(p[2] + q[2]) / 2, oi, pi, 0],
            kind: "line", pts: [sp, sq], stroke: m.s, sa: m.sa * opacity, sw: m.sw,
          });
        } else if (kind === "h") {
          const [, tip, base, mi] = pr;
          if (partial < 1 - 1e-6) return;
          const t = cam[tip], b = cam[base];
          if (t[3] < NEAR || b[3] < NEAR) return;
          const st = toScreen(view, t), sb = toScreen(view, b);
          const dx = st[0] - sb[0], dy = st[1] - sb[1];
          const l = Math.hypot(dx, dy);
          if (l < 1e-9) return;
          const m = geom.mats[mi];
          const ux = dx / l, uy = dy / l, h = m.h;
          const back = [st[0] - ux * h, st[1] - uy * h];
          list.push({
            key: [t[2], oi, pi, 0],
            kind: "poly",
            pts: [st, [back[0] - uy * h * 0.4, back[1] + ux * h * 0.4], [back[0] + uy * h * 0.4, back[1] - ux * h * 0.4]],
            flags: [false, false, false],
            fill: m.s, fa: m.sa * opacity, stroke: null, sa: 0, sw: 0,
          });
        } else if (kind === "p") {
          const [, a, mi] = pr;
          const q = cam[a];
          if (q[3] < NEAR) return;
          const m = geom.mats[mi];
          list.push({ key: [q[2], oi, pi, 0], kind: "point", at: toScreen(view, q), r: m.r, fill: m.f, fa: m.fa * opacity * partial });
        } else if (kind === "l") {
          const [, a, li] = pr;
          const q = cam[a];
          if (q[3] < NEAR) return;
          list.push({
            key: [q[2], oi, pi, 0], kind: "label", at: toScreen(view, q),
            obj: oi, label: li, alpha: opacity * partial, depth: geom.labels[li].depth,
          });
        }
      });
    });
    return list.sort(compareKeys);
  }

  const fmt = (x) => String(+x.toFixed(3));
  const pathOf = (pts, close) =>
    "M" + pts.map((p) => fmt(p[0]) + " " + fmt(p[1])).join("L") + (close ? "Z" : "");

  // Path specifications (d, fill, stroke) of one drawable; mirrors draw-one.
  function pathSpecs(d) {
    const fill = d.fill ? [d.fill, d.fa] : null;
    const stroke = d.stroke && d.sw > 0 ? [d.stroke, d.sa, d.sw] : null;
    if (d.kind === "poly") {
      const n = d.pts.length;
      const off = d.flags.filter((f) => !f).length;
      if (!stroke || off === 0) return [{ d: pathOf(d.pts, true), fill, stroke }];
      if (off === 1 && n === 3) {
        const i = d.flags.indexOf(false);
        const order = [0, 1, 2].map((k) => d.pts[(i + k) % n]);
        return [{ d: pathOf(order, false), fill, stroke }];
      }
      const out = [{ d: pathOf(d.pts, true), fill, stroke: null }];
      let edges = "";
      for (let i = 0; i < n; i++) if (d.flags[i]) edges += pathOf([d.pts[(i + n - 1) % n], d.pts[i]], false);
      if (edges) out.push({ d: edges, fill: null, stroke });
      return out;
    }
    if (d.kind === "line") return stroke ? [{ d: pathOf(d.pts, false), fill: null, stroke }] : [];
    if (d.kind === "point") {
      if (!fill || d.r <= 0) return [];
      const [x, y] = d.at, r = d.r;
      return [{
        d: `M${fmt(x - r)} ${fmt(y)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0Z`,
        fill, stroke: null,
      }];
    }
    return [];
  }

  // Drag offsets per scene key, shared by every stage (audience, presenter).
  const DRAG = new Map();
  // How long a dragged view takes to turn back after a page change.
  const NAV_RESET_MS = 1000;

  // The 3D layer of one scene on one stage.
  class World3D {
    constructor(scene) {
      this.scene = scene;
      const rec = scene.rec;
      this.rec = rec;
      const anchor = byLabel(scene.root, rec.world.label);
      const doc = scene.root.ownerDocument;
      this.doc = doc;
      this.group = doc.createElementNS(SVGNS, "g");
      this.group.setAttribute("data-tys-world", rec.scene.key);
      (anchor || scene.root).appendChild(this.group);
      this.pool = [];
      this.objects = rec.objects.filter((o) => o.geom);
      // Label billboards: Typst-rendered groups, positioned by the player.
      this.labels = this.objects.map((o) =>
        o.geom.labels.map((l) => {
          const el = byLabel(scene.root, l.label);
          if (!el) return null;
          const wrap = doc.createElementNS(SVGNS, "g");
          while (el.firstChild) wrap.appendChild(el.firstChild);
          el.appendChild(wrap);
          return { el, wrap, spec: l };
        })
      );
      this.time = 0;
    }

    camera(t) {
      const cam = this.rec.camera;
      const v = evalObject(cam, this.rec.rates, t);
      const off = DRAG.get(this.rec.scene.key);
      if (off) {
        v.phi += off.dphi;
        v.theta += off.dtheta;
        v.zoom *= off.zoom;
      }
      return makeView(v, cam.unit, cam.at);
    }

    positions(o, t) {
      const K = o.knots;
      if (!K || K.kind !== "geom") return o.geom.pos;
      const sel = knotSelect(K, t, this.rec.duration, this.rec.rates, () => true);
      const a = K.positions[sel.k];
      if (sel.k1 === undefined) return a;
      const b = K.positions[sel.k1];
      return a.map((x, i) => x + (b[i] - x) * sel.f);
    }

    apply(t) {
      this.time = t;
      const rates = this.rec.rates;
      const view = this.camera(t);
      const items = this.objects.map((o) => {
        const s = evalObject(o, rates, t);
        return {
          geom: o.geom,
          pos: this.positions(o, t),
          matrix: stepsMatrix(o.geom.steps, s),
          opacity: clamp(s.opacity, 0, 1),
          draw: s.draw,
        };
      });
      const list = drawables(view, items);
      this.render(list);
      this.lastList = list;
      this.lastItems = items;
    }

    redraw() {
      this.apply(this.time);
    }

    node(i) {
      let p = this.pool[i];
      if (!p) {
        p = this.doc.createElementNS(SVGNS, "path");
        p.setAttribute("stroke-linecap", "butt");
        p.setAttribute("stroke-linejoin", "miter");
        p.setAttribute("stroke-miterlimit", "4");
        this.pool[i] = p;
      }
      return p;
    }

    render(list) {
      const order = [];
      let n = 0;
      const shown = new Set();
      for (const d of list) {
        if (d.kind === "label") {
          const lab = this.labels[d.obj] && this.labels[d.obj][d.label];
          if (!lab) continue;
          shown.add(lab);
          const { el, wrap, spec } = lab;
          wrap.setAttribute("transform", `translate(${fmt(d.at[0] - spec.w / 2)} ${fmt(d.at[1] - spec.h / 2)})`);
          wrap.style.display = "";
          if (d.alpha < 1 - 1e-6) wrap.setAttribute("opacity", fmt(d.alpha));
          else wrap.removeAttribute("opacity");
          if (spec.depth) order.push(el);
          continue;
        }
        for (const ps of pathSpecs(d)) {
          const p = this.node(n++);
          p.setAttribute("d", ps.d);
          if (ps.fill) {
            p.setAttribute("fill", ps.fill[0]);
            p.setAttribute("fill-opacity", fmt(ps.fill[1]));
          } else {
            p.setAttribute("fill", "none");
            p.removeAttribute("fill-opacity");
          }
          if (ps.stroke) {
            p.setAttribute("stroke", ps.stroke[0]);
            p.setAttribute("stroke-opacity", fmt(ps.stroke[1]));
            p.setAttribute("stroke-width", fmt(ps.stroke[2]));
          } else {
            p.setAttribute("stroke", "none");
            p.removeAttribute("stroke-opacity");
            p.removeAttribute("stroke-width");
          }
          order.push(p);
        }
      }
      // Hide labels that are not drawn (clipped or invisible).
      for (const labs of this.labels)
        for (const lab of labs) if (lab && !shown.has(lab)) lab.wrap.style.display = "none";
      // Bring the group's children into the drawing order.
      const kids = this.group.children;
      let same = kids.length === order.length;
      for (let i = 0; same && i < order.length; i++) same = kids[i] === order[i];
      if (!same) this.group.replaceChildren(...order);
    }
  }

  // ---------------------------------------------------------------- morphs

  // transform-matching: glyphs (and identical shapes) that occur in both
  // objects move from their place in the source to their place in the target;
  // parts marked with the same key move as groups; the rest fades. It is drawn
  // by an overlay of clones placed right after the source object, so layering
  // and seeking stay simple. Cases the overlay cannot reproduce faithfully
  // fall back to a crossfade of the two objects.

  // Ancestor attributes that do not affect rendering.
  const INERT_ATTR = /^(transform|data-[\w-]+|class|id|role|aria-[\w-]+)$/;
  const EPS_M = 1e-6;

  function matrixString(m) {
    return `matrix(${num(m.a)} ${num(m.b)} ${num(m.c)} ${num(m.d)} ${num(m.e)} ${num(m.f)})`;
  }

  function lerpMatrix(p, q, f) {
    const l = (x, y) => x + (y - x) * f;
    return { a: l(p.a, q.a), b: 0, c: 0, d: l(p.d, q.d), e: l(p.e, q.e), f: l(p.f, q.f) };
  }

  // Translation, uniform scale and Typst's y flip only.
  function isSimilarity(m) {
    return (
      Math.abs(m.b) < EPS_M &&
      Math.abs(m.c) < EPS_M &&
      m.a > 0 &&
      Math.abs(Math.abs(m.d) - m.a) < 1e-4 * m.a
    );
  }

  function boxOf(el, m) {
    let bb;
    try {
      bb = el.getBBox();
    } catch (_) {
      return null;
    }
    const xs = [bb.x, bb.x + bb.width];
    const ys = [bb.y, bb.y + bb.height];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of xs)
      for (const y of ys) {
        const px = m.a * x + m.c * y + m.e;
        const py = m.b * x + m.d * y + m.f;
        x0 = Math.min(x0, px);
        y0 = Math.min(y0, py);
        x1 = Math.max(x1, px);
        y1 = Math.max(y1, py);
      }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Minimum-cost assignment between S and D where leaving an element
  // unmatched costs `tau` (Hungarian algorithm on the augmented square matrix;
  // greedy for large sets). Returns [[i, j], ...].
  function assign(S, D, cost, tau) {
    const nS = S.length, nD = D.length;
    if (!nS || !nD) return [];
    if (nS > 64 || nD > 64) {
      const all = [];
      S.forEach((a, i) => D.forEach((b, j) => all.push([cost(a, b), i, j])));
      all.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      const usedS = new Set(), usedD = new Set(), out = [];
      for (const [c, i, j] of all) {
        if (c >= 2 * tau || usedS.has(i) || usedD.has(j)) continue;
        usedS.add(i);
        usedD.add(j);
        out.push([i, j]);
      }
      return out;
    }
    const n = nS + nD, BIG = 1e12;
    const C = (i, j) => {
      if (i < nS && j < nD) return cost(S[i], D[j]);
      if (i < nS) return j - nD === i ? tau : BIG;
      if (j < nD) return i - nS === j ? tau : BIG;
      return 0;
    };
    // Kuhn–Munkres with potentials (1-based arrays).
    const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
    const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Float64Array(n + 1).fill(Infinity);
      const used = new Uint8Array(n + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= n; j++) {
          if (used[j]) continue;
          const cur = C(i0 - 1, j - 1) - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
        for (let j = 0; j <= n; j++) {
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else {
            minv[j] -= delta;
          }
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0);
    }
    const out = [];
    for (let j = 1; j <= nD; j++) {
      const i = p[j] - 1;
      if (i < nS) out.push([i, j - 1]);
    }
    return out.sort((x, y) => x[0] - y[0]);
  }

  // ------------------------------------------------------------ shape morphs
  //
  // `transform` in the HTML export: outlines morph point by point. Leaves
  // (paths and glyphs) are paired by position; inside a pair, contours are
  // paired by size and their cubic segments aligned. The crossfade tracks
  // stay authoritative: anything outside the supported subset falls back to
  // them, writing no overrides.

  const SHAPE_BUDGET = { leaves: 256, contours: 64, curves: 8000, rotate: 512 };

  class MorphError extends Error {}

  const PATH_TOKEN = /[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

  // SVG path data -> contours [{segs: [[x0,y0,c1x,c1y,c2x,c2y,x1,y1], ..], closed}]
  // in absolute coordinates. Lines and quadratics become exact cubics.
  function parsePath(d) {
    const toks = d.match(PATH_TOKEN) || [];
    const isCmd = (t) => /^[a-zA-Z]$/.test(t);
    const contours = [];
    let i = 0, cmd = null, cur = null;
    let x = 0, y = 0, sx = 0, sy = 0, lastC = null, lastQ = null;
    const num = () => {
      if (i >= toks.length || isCmd(toks[i])) throw new MorphError("malformed path data");
      return parseFloat(toks[i++]);
    };
    const start = (nx, ny) => {
      cur = { segs: [], closed: false };
      contours.push(cur);
      x = sx = nx;
      y = sy = ny;
    };
    const cubic = (c1x, c1y, c2x, c2y, ex, ey) => {
      if (!cur || cur.closed) start(x, y); // drawing after Z starts a subpath
      cur.segs.push([x, y, c1x, c1y, c2x, c2y, ex, ey]);
      x = ex;
      y = ey;
    };
    const line = (ex, ey) =>
      cubic(x + (ex - x) / 3, y + (ey - y) / 3, x + (2 * (ex - x)) / 3, y + (2 * (ey - y)) / 3, ex, ey);
    const quad = (qx, qy, ex, ey) =>
      cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
    while (i < toks.length) {
      if (isCmd(toks[i])) cmd = toks[i++];
      else if (cmd === null) throw new MorphError("malformed path data");
      const rel = cmd !== cmd.toUpperCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      switch (cmd.toUpperCase()) {
        case "M": {
          const nx = num() + ox, ny = num() + oy;
          start(nx, ny);
          cmd = rel ? "l" : "L"; // further pairs are lines
          lastC = lastQ = null;
          break;
        }
        case "L": {
          const nx = num() + ox, ny = num() + oy;
          line(nx, ny);
          lastC = lastQ = null;
          break;
        }
        case "H":
          line(num() + ox, y);
          lastC = lastQ = null;
          break;
        case "V":
          line(x, num() + oy);
          lastC = lastQ = null;
          break;
        case "C": {
          const a = num() + ox, b = num() + oy, c = num() + ox, e = num() + oy, f = num() + ox, g = num() + oy;
          cubic(a, b, c, e, f, g);
          lastC = [c, e];
          lastQ = null;
          break;
        }
        case "S": {
          const [c1x, c1y] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
          const c = num() + ox, e = num() + oy, f = num() + ox, g = num() + oy;
          cubic(c1x, c1y, c, e, f, g);
          lastC = [c, e];
          lastQ = null;
          break;
        }
        case "Q": {
          const qx = num() + ox, qy = num() + oy, ex = num() + ox, ey = num() + oy;
          quad(qx, qy, ex, ey);
          lastQ = [qx, qy];
          lastC = null;
          break;
        }
        case "T": {
          const [qx, qy] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
          const ex = num() + ox, ey = num() + oy;
          quad(qx, qy, ex, ey);
          lastQ = [qx, qy];
          lastC = null;
          break;
        }
        case "Z":
          if (cur && !cur.closed) {
            if (Math.hypot(x - sx, y - sy) > 1e-9) line(sx, sy);
            cur.closed = true;
          }
          x = sx;
          y = sy;
          lastC = lastQ = null;
          break;
        case "A":
          throw new MorphError("arcs are not supported");
        default:
          throw new MorphError(`unknown path command "${cmd}"`);
      }
    }
    // A contour that ends where it starts is closed (Typst writes circles
    // without Z).
    for (const c of contours) {
      if (c.closed || !c.segs.length) continue;
      const a = c.segs[0], b = c.segs[c.segs.length - 1];
      const size = Math.max(...c.segs.map((q) => Math.abs(q[6] - a[0]) + Math.abs(q[7] - a[1])));
      if (size > 1e-9 && Math.hypot(b[6] - a[0], b[7] - a[1]) <= 1e-6 * size) c.closed = true;
    }
    return contours.filter((c) => c.segs.length);
  }

  function mapSeg(m, s) {
    const out = new Array(8);
    for (let k = 0; k < 8; k += 2) {
      out[k] = m.a * s[k] + m.c * s[k + 1] + m.e;
      out[k + 1] = m.b * s[k] + m.d * s[k + 1] + m.f;
    }
    return out;
  }

  // Rotation, uniform scale and reflection (Typst's y flip included).
  function isConformal(m) {
    const n1 = m.a * m.a + m.b * m.b, n2 = m.c * m.c + m.d * m.d;
    return n1 > 1e-12 && Math.abs(n1 - n2) < 1e-6 * n1 && Math.abs(m.a * m.c + m.b * m.d) < 1e-6 * n1;
  }

  function contourArea(c) {
    let a = 0;
    for (const s of c.segs) {
      // Shoelace over the control polygon: exact sign for the usual shapes.
      for (let k = 0; k < 6; k += 2) a += s[k] * s[k + 3] - s[k + 2] * s[k + 1];
    }
    return a / 2;
  }

  function contourCentre(c) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of c.segs)
      for (let k = 0; k < 8; k += 2) {
        x0 = Math.min(x0, s[k]);
        x1 = Math.max(x1, s[k]);
        y0 = Math.min(y0, s[k + 1]);
        y1 = Math.max(y1, s[k + 1]);
      }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }

  function reverseContour(c) {
    const segs = c.segs
      .slice()
      .reverse()
      .map((s) => [s[6], s[7], s[4], s[5], s[2], s[3], s[0], s[1]]);
    return { segs, closed: c.closed };
  }

  function degenerateLike(c, x, y) {
    return { segs: c.segs.map(() => [x, y, x, y, x, y, x, y]), closed: c.closed };
  }

  // Split the longest segments at t = 1/2 until the contour has n segments.
  function splitTo(c, n) {
    const segs = c.segs.slice();
    const len = (s) =>
      Math.hypot(s[2] - s[0], s[3] - s[1]) + Math.hypot(s[4] - s[2], s[5] - s[3]) + Math.hypot(s[6] - s[4], s[7] - s[5]);
    while (segs.length < n) {
      let best = 0;
      for (let k = 1; k < segs.length; k++) if (len(segs[k]) > len(segs[best]) + 1e-12) best = k;
      const s = segs[best];
      const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const p0 = [s[0], s[1]], p1 = [s[2], s[3]], p2 = [s[4], s[5]], p3 = [s[6], s[7]];
      const a = m(p0, p1), b = m(p1, p2), c2 = m(p2, p3), ab = m(a, b), bc = m(b, c2), mid = m(ab, bc);
      segs.splice(best, 1, [...p0, ...a, ...ab, ...mid], [...mid, ...bc, ...c2, ...p3]);
    }
    return { segs, closed: c.closed };
  }

  // Rotate the segments of closed contour b to best match a.
  function rotateToMatch(a, b) {
    const n = a.segs.length;
    if (!b.closed || n > SHAPE_BUDGET.rotate) return b;
    let best = 0, bestCost = Infinity;
    for (let k = 0; k < n; k++) {
      let cost = 0;
      for (let i = 0; i < n && cost < bestCost; i++) {
        const p = a.segs[i], q = b.segs[(i + k) % n];
        cost += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    return { segs: b.segs.slice(best).concat(b.segs.slice(0, best)), closed: true };
  }

  function parseColour(v) {
    if (!v || v === "none") return null;
    let m = /^#([0-9a-f]{3})$/i.exec(v);
    if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1);
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
    if (m) {
      const h = m[1];
      return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)).concat(m[2] ? parseInt(m[2], 16) / 255 : 1);
    }
    return undefined; // a paint server or a colour syntax we cannot lerp
  }

  // Paint of a leaf. `use` elements carry the paint of their glyph.
  function paintOf(el, inner) {
    const get = (n, dflt) => {
      const v = el.getAttribute(n) ?? (inner ? inner.getAttribute(n) : null);
      return v === null ? dflt : v;
    };
    const p = {
      fill: get("fill", "#000000"),
      fillOpacity: parseFloat(get("fill-opacity", "1")),
      stroke: get("stroke", "none"),
      strokeOpacity: parseFloat(get("stroke-opacity", "1")),
      strokeWidth: parseFloat(get("stroke-width", "1")),
      linecap: get("stroke-linecap", "butt"),
      linejoin: get("stroke-linejoin", "miter"),
      miterlimit: get("stroke-miterlimit", "4"),
      fillRule: get("fill-rule", "nonzero"),
      dash: get("stroke-dasharray", "none"),
      markers: ["marker-start", "marker-mid", "marker-end"].some((n) => get(n, "none") !== "none"),
      opacity: parseFloat(get("opacity", "1")),
    };
    p.fillRGBA = parseColour(p.fill);
    p.strokeRGBA = parseColour(p.stroke);
    p.stroked = p.stroke !== "none";
    // Lerpable: solid colours only, no dashes or markers, no element opacity.
    p.simple =
      p.fillRGBA !== undefined &&
      p.strokeRGBA !== undefined &&
      p.dash === "none" &&
      !p.markers &&
      Math.abs(p.opacity - 1) < 1e-9;
    return p;
  }

  // Leaves of an object for a shape morph, in paint order, with geometry in
  // the overlay parent's user space. Throws MorphError for unsupported content.
  function shapeLeaves(view, base) {
    const leaves = [];
    const walk = (el) => {
      for (const child of el.children) {
        const tag = child.localName;
        if (tag === "path" || tag === "use") {
          const ctm = child.getCTM();
          if (!ctm) throw new MorphError("not measurable");
          let m = base.multiply(ctm);
          let d, inner = null;
          let cloneM = m;
          if (tag === "use") {
            const x = parseFloat(child.getAttribute("x")) || 0;
            const y = parseFloat(child.getAttribute("y")) || 0;
            m = m.translate(x, y);
            cloneM = m;
            const href = child.getAttribute("xlink:href") || child.getAttribute("href") || "";
            const sym = href.startsWith("#") ? child.ownerDocument.getElementById(href.slice(1)) : null;
            const kids = sym ? [...sym.children] : [];
            if (kids.length !== 1 || kids[0].localName !== "path")
              throw new MorphError(`unsupported glyph in ${view.rec.id}`);
            inner = kids[0];
            const t = inner.transform && inner.transform.baseVal.consolidate();
            if (t) m = m.multiply(t.matrix);
            d = inner.getAttribute("d");
          } else {
            d = child.getAttribute("d");
          }
          const paint = paintOf(child, inner);
          // Invisible helpers (e.g. the CeTZ bounds rectangle).
          if (paint.fill === "none" && !paint.stroked) continue;
          leaves.push({ el: child, m, cloneM, d: d || "", paint });
          continue;
        }
        if (isLeaf(child)) throw new MorphError(`unsupported <${tag}> in ${view.rec.id}`);
        for (const a of child.attributes)
          if (!INERT_ATTR.test(a.name)) throw new MorphError(`unsupported "${a.name}" inside ${view.rec.id}`);
        walk(child);
      }
    };
    walk(view.inner);
    if (leaves.length > SHAPE_BUDGET.leaves) throw new MorphError("too many parts");
    let curves = 0;
    for (const leaf of leaves) {
      const contours = parsePath(leaf.d).map((c) => ({ segs: c.segs.map((s) => mapSeg(leaf.m, s)), closed: c.closed }));
      if (contours.length > SHAPE_BUDGET.contours) throw new MorphError("too many contours");
      for (const c of contours) curves += c.segs.length;
      leaf.contours = contours;
      leaf.conformal = isConformal(leaf.m);
      leaf.scale = Math.sqrt(Math.abs(leaf.m.a * leaf.m.d - leaf.m.b * leaf.m.c));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of contours) {
        const b = contourCentre(c).box;
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
      }
      if (!contours.length) x0 = y0 = x1 = y1 = 0;
      leaf.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      leaf.cx = (x0 + x1) / 2;
      leaf.cy = (y0 + y1) / 2;
    }
    if (curves > SHAPE_BUDGET.curves) throw new MorphError("too many curves");
    return leaves;
  }

  // Lerpable style of a leaf; `ghost` (an absent partner) is fully transparent.
  function styleOf(leaf, other, ghost) {
    const p = leaf ? leaf.paint : other.paint;
    const scale = leaf ? leaf.scale : other.scale;
    const pick = (rgba, alt) => (rgba ? rgba : alt ? [alt[0], alt[1], alt[2], 0] : [0, 0, 0, 0]);
    const op = other ? other.paint : null;
    const fill = pick(p.fillRGBA, op && op.fillRGBA);
    const stroke = pick(p.strokeRGBA, op && op.strokeRGBA);
    const fa = ghost || !p.fillRGBA ? 0 : fill[3] * p.fillOpacity;
    const sa = ghost || !p.strokeRGBA ? 0 : stroke[3] * p.strokeOpacity;
    const width = ghost || !p.stroked ? 0 : p.strokeWidth * scale;
    return { fill, fa, stroke, sa, width };
  }

  // Overlap with a 0.5 px tolerance: touching boxes do not overlap.
  function boxesOverlap(a, b, tol = 0.5) {
    return a.x + tol < b.x + b.w && b.x + tol < a.x + a.w && a.y + tol < b.y + b.h && b.y + tol < a.y + a.h;
  }

  // Pair contours of two leaves and align them. Returns [[ca, cb], ..] or
  // null if the pair cannot morph (open versus closed contours).
  function alignContours(A, B) {
    const order = (L) =>
      L.contours
        .map((c) => ({ c, area: contourArea(c), centre: contourCentre(c) }))
        .sort(
          (p, q) =>
            Math.abs(q.area) - Math.abs(p.area) || p.centre.y - q.centre.y || p.centre.x - q.centre.x
        );
    const ca = A ? order(A) : [];
    const cb = B ? order(B) : [];
    const n = Math.max(ca.length, cb.length);
    const pairs = [];
    for (let k = 0; k < n; k++) {
      let a = ca[k] ? ca[k].c : null;
      let b = cb[k] ? cb[k].c : null;
      if (a && b && a.closed !== b.closed) return null;
      // A contour without a partner grows from / shrinks to its own centre.
      if (!a) a = degenerateLike(b, cb[k].centre.x, cb[k].centre.y);
      if (!b) b = degenerateLike(a, ca[k].centre.x, ca[k].centre.y);
      pairs.push([a, b, ca[k] ? ca[k].area : 0, cb[k] ? cb[k].area : 0]);
    }
    // Orientation per leaf: reversing every contour of a leaf keeps its fill.
    const closedDominant = pairs.length && pairs[0][0].closed && ca.length && cb.length;
    const flip = closedDominant && Math.sign(pairs[0][2]) * Math.sign(pairs[0][3]) < 0;
    const single = (A ? A.contours.length : 0) <= 1 && (B ? B.contours.length : 0) <= 1;
    const unfilled = (!A || A.paint.fill === "none") && (!B || B.paint.fill === "none");
    return pairs.map(([a, b]) => {
      if (flip) b = reverseContour(b);
      else if (!a.closed && (single || unfilled)) {
        // Open curves: run in the direction that moves the ends least.
        const s = a.segs[0], e = a.segs[a.segs.length - 1];
        const s2 = b.segs[0], e2 = b.segs[b.segs.length - 1];
        const same = Math.hypot(s[0] - s2[0], s[1] - s2[1]) + Math.hypot(e[6] - e2[6], e[7] - e2[7]);
        const rev = Math.hypot(s[0] - e2[6], s[1] - e2[7]) + Math.hypot(e[6] - s2[0], e[7] - s2[1]);
        if (rev < same - 1e-9) b = reverseContour(b);
      }
      const len = Math.max(a.segs.length, b.segs.length);
      a = splitTo(a, len);
      b = splitTo(b, len);
      if (a.closed) b = rotateToMatch(a, b);
      return [a, b];
    });
  }

  // Can two leaves morph into each other (rather than crossfade)?
  function compatible(A, B) {
    const pa = A.paint, pb = B.paint;
    if (!pa.simple || !pb.simple) return false;
    if (pa.fillRule !== pb.fillRule) return false;
    if (pa.stroked && pb.stroked && (pa.linecap !== pb.linecap || pa.linejoin !== pb.linejoin || pa.miterlimit !== pb.miterlimit))
      return false;
    if ((pa.stroked && !A.conformal) || (pb.stroked && !B.conformal)) return false;
    return true;
  }

  function pathData(contours, f) {
    let d = "";
    const l = (a, b) => a + (b - a) * f;
    for (const [a, b] of contours) {
      const s0 = a.segs[0], t0 = b.segs[0];
      d += `M${num(l(s0[0], t0[0]))} ${num(l(s0[1], t0[1]))}`;
      for (let k = 0; k < a.segs.length; k++) {
        const s = a.segs[k], t = b.segs[k];
        d += `C${num(l(s[2], t[2]))} ${num(l(s[3], t[3]))} ${num(l(s[4], t[4]))} ${num(l(s[5], t[5]))} ${num(l(s[6], t[6]))} ${num(l(s[7], t[7]))}`;
      }
      if (a.closed) d += "Z";
    }
    return d;
  }

  class MorphView {
    constructor(scene, rec) {
      this.scene = scene;
      this.rec = rec;
      this.ready = false;
      this.mode = "crossfade";
      this.items = [];
      this.info = { source: rec.source, target: rec.target, mode: "crossfade", reason: null, pairs: [], tiers: {} };
    }

    fallback(reason) {
      this.mode = "crossfade";
      this.info.mode = "crossfade";
      this.info.reason = reason;
      if (this.overlay) this.overlay.remove();
      this.overlay = null;
      this.items = [];
    }

    // Leaves (and keyed groups) of an object, with matrices relative to the
    // overlay's parent. Returns {atoms, keys, reason}.
    collect(view, base) {
      const out = { atoms: [], keys: new Map(), reason: null };
      const walk = (el) => {
        for (const child of el.children) {
          if (out.reason) return;
          const label = child.getAttribute("data-typst-label");
          if (label && label.startsWith("tysk-")) {
            const name = label.slice(5);
            if (out.keys.has(name)) {
              out.reason = `duplicate key "${name}" in ${view.rec.id}`;
              return;
            }
            const ctm = child.getCTM();
            if (!ctm) return void (out.reason = "not measurable");
            const m = base.multiply(ctm);
            out.keys.set(name, { el: child, m, box: boxOf(child, m) });
            continue;
          }
          if (isLeaf(child)) {
            const stroke = child.getAttribute("stroke");
            if (child.getAttribute("fill") === "none" && (!stroke || stroke === "none")) continue;
            const ctm = child.getCTM();
            if (!ctm) return void (out.reason = "not measurable");
            let m = base.multiply(ctm);
            let key;
            if (child.localName === "use") {
              const x = parseFloat(child.getAttribute("x")) || 0;
              const y = parseFloat(child.getAttribute("y")) || 0;
              m = m.translate(x, y);
              key = "g:" + (child.getAttribute("xlink:href") || child.getAttribute("href"));
            } else {
              // Identical shapes (e.g. equally long fraction bars) match too.
              const attrs = [...child.attributes]
                .filter((a) => a.name !== "transform")
                .map((a) => `${a.name}=${a.value}`)
                .sort();
              key = "s:" + child.localName + "|" + attrs.join("|");
            }
            if (!isSimilarity(m)) return void (out.reason = `rotated or skewed part in ${view.rec.id}`);
            const paint = ["fill", "stroke", "fill-opacity", "stroke-opacity", "opacity"]
              .map((n) => child.getAttribute(n))
              .join("|");
            out.atoms.push({ el: child, m, key, paint });
            continue;
          }
          for (const a of child.attributes) {
            if (!INERT_ATTR.test(a.name)) {
              out.reason = `unsupported "${a.name}" inside ${view.rec.id}`;
              return;
            }
          }
          walk(child);
        }
      };
      walk(view.inner);
      return out;
    }

    setup() {
      this.ready = true;
      const { source, target, t0, t1 } = this.rec;
      const scene = this.scene;
      const rates = scene.rec.rates;
      const dur = scene.rec.duration;
      const src = scene.object(source);
      const dst = scene.object(target);
      this.src = src;
      this.dst = dst;
      if (!src || !dst) return this.fallback("object not on this page");
      if (this.rec.kind === "shape") return this.setupShape();
      const s0 = evalObject(src.rec, rates, t0);
      const d1 = evalObject(dst.rec, rates, t1);
      if (s0.draw < 1 - 1e-6 || s0.reveal < 1 - 1e-6 || d1.draw < 1 - 1e-6 || d1.reveal < 1 - 1e-6)
        return this.fallback("partially drawn object");
      // Measure both objects at their end points (opaque; restored by the caller).
      src.apply({ ...s0, opacity: 1 }, t0, dur, rates);
      dst.apply({ ...d1, opacity: 1 }, t1, dur, rates);
      const parent = src.el.parentNode;
      const pctm = parent.getCTM();
      if (!pctm) return this.fallback("not measurable");
      const base = pctm.inverse();
      const A = this.collect(src, base);
      const B = this.collect(dst, base);
      if (A.reason || B.reason) return this.fallback(A.reason || B.reason);

      const between = this.between();
      if (between) return this.fallback(between);

      const [w, h] = scene.rec.scene.size;
      const tau = 0.5 * Math.hypot(w, h);
      const pairs = [];
      const fadeOut = [];
      const fadeIn = [];
      // Tier 1: keys pair by name.
      for (const [name, a] of A.keys) {
        const b = B.keys.get(name);
        if (b && a.box && b.box) pairs.push({ tier: "key", a, b });
        else fadeOut.push(a);
      }
      for (const [name, b] of B.keys) if (!A.keys.has(name)) fadeIn.push(b);
      // Tier 2: identical glyphs and shapes, by minimum total displacement.
      const reading = (x, y) => Math.round(x.m.f) - Math.round(y.m.f) || x.m.e - y.m.e;
      const groups = new Map();
      for (const a of A.atoms) {
        if (!groups.has(a.key)) groups.set(a.key, [[], []]);
        groups.get(a.key)[0].push(a);
      }
      for (const b of B.atoms) {
        if (!groups.has(b.key)) groups.set(b.key, [[], []]);
        groups.get(b.key)[1].push(b);
      }
      const dist = (a, b) => Math.hypot(a.m.e - b.m.e, a.m.f - b.m.f);
      for (const [key, [S, D]] of groups) {
        S.sort(reading);
        D.sort(reading);
        const matched = assign(S, D, dist, tau);
        const usedS = new Set(matched.map((x) => x[0]));
        const usedD = new Set(matched.map((x) => x[1]));
        for (const [i, j] of matched) {
          if (Math.sign(S[i].m.d) !== Math.sign(D[j].m.d)) {
            fadeOut.push(S[i]);
            fadeIn.push(D[j]);
          } else pairs.push({ tier: key.startsWith("g:") ? "glyph" : "shape", a: S[i], b: D[j] });
        }
        S.forEach((a, i) => usedS.has(i) || fadeOut.push(a));
        D.forEach((b, j) => usedD.has(j) || fadeIn.push(b));
      }

      // Build the overlay of clones.
      const doc = parent.ownerDocument;
      const overlay = doc.createElementNS(SVGNS, "g");
      overlay.setAttribute("data-tys-morph", `${source}->${target}`);
      overlay.style.display = "none";
      parent.insertBefore(overlay, src.el.nextSibling);
      this.overlay = overlay;
      const clone = (atom) => {
        const c = atom.el.cloneNode(true);
        c.removeAttribute("transform");
        if (c.localName === "use") {
          c.removeAttribute("x");
          c.removeAttribute("y");
        }
        c.removeAttribute("data-typst-label");
        overlay.appendChild(c);
        return c;
      };
      // Group clones follow the box interpolated between both keyed parts.
      const boxMap = (from, to, m) => {
        const sx = from.w > 1e-9 ? to.w / from.w : 1;
        const sy = from.h > 1e-9 ? to.h / from.h : 1;
        return {
          a: m.a * sx,
          b: 0,
          c: 0,
          d: m.d * sy,
          e: to.x + (m.e - from.x) * sx,
          f: to.y + (m.f - from.y) * sy,
        };
      };
      const lerpBox = (p, q, f) => ({
        x: p.x + (q.x - p.x) * f,
        y: p.y + (q.y - p.y) * f,
        w: p.w + (q.w - p.w) * f,
        h: p.h + (q.h - p.h) * f,
      });
      for (const { tier, a, b } of pairs) {
        if (tier === "key") {
          const ca = clone(a), cb = clone(b);
          this.items.push((f) => {
            const box = lerpBox(a.box, b.box, f);
            ca.setAttribute("transform", matrixString(boxMap(a.box, box, a.m)));
            cb.setAttribute("transform", matrixString(boxMap(b.box, box, b.m)));
            ca.setAttribute("opacity", num(1 - f));
            cb.setAttribute("opacity", num(f));
          });
        } else if (a.paint === b.paint) {
          const ca = clone(a);
          this.items.push((f) => ca.setAttribute("transform", matrixString(lerpMatrix(a.m, b.m, f))));
        } else {
          const ca = clone(a), cb = clone(b);
          this.items.push((f) => {
            const m = matrixString(lerpMatrix(a.m, b.m, f));
            ca.setAttribute("transform", m);
            cb.setAttribute("transform", m);
            ca.setAttribute("opacity", num(1 - f));
            cb.setAttribute("opacity", num(f));
          });
        }
      }
      for (const a of fadeOut) {
        const c = clone(a);
        c.setAttribute("transform", matrixString(a.m));
        this.items.push((f) => c.setAttribute("opacity", num(1 - f)));
      }
      for (const b of fadeIn) {
        const c = clone(b);
        c.setAttribute("transform", matrixString(b.m));
        this.items.push((f) => c.setAttribute("opacity", num(f)));
      }
      this.mode = "overlay";
      this.info.mode = "overlay";
      this.info.pairs = pairs.map(({ tier, a, b }) => ({
        tier,
        from: [num(a.m.e), num(a.m.f)],
        to: [num(b.m.e), num(b.m.f)],
      }));
      const tiers = { faded: fadeOut.length + fadeIn.length, repainted: 0 };
      for (const p of pairs) {
        tiers[p.tier] = (tiers[p.tier] || 0) + 1;
        if (p.tier !== "key" && p.a.paint !== p.b.paint) tiers.repainted++;
      }
      this.info.tiers = tiers;
    }

    // Objects drawn between the two would be crossed by the overlay.
    between() {
      const { t0, t1 } = this.rec;
      const scene = this.scene, rates = scene.rec.rates;
      const src = this.src, dst = this.dst;
      const [lo, hi] = [src.rec.order, dst.rec.order].sort((x, y) => x - y);
      const union = (r, q) => ({
        left: Math.min(r.left, q.left),
        top: Math.min(r.top, q.top),
        right: Math.max(r.right, q.right),
        bottom: Math.max(r.bottom, q.bottom),
      });
      const area = union(src.xf.getBoundingClientRect(), dst.xf.getBoundingClientRect());
      for (const o of scene.objects) {
        if (o.rec.order <= lo || o.rec.order >= hi) continue;
        const visible = [t0, (t0 + t1) / 2, t1].some((t) => evalObject(o.rec, rates, t).opacity > 1e-6);
        if (!visible) continue;
        const r = o.xf.getBoundingClientRect();
        if (r.right > area.left && r.left < area.right && r.bottom > area.top && r.top < area.bottom)
          return `"${o.rec.id}" lies between them`;
      }
      return null;
    }

    // `transform` as a point-by-point morph of the outlines.
    setupShape() {
      const { source, target, t0, t1 } = this.rec;
      const scene = this.scene, rates = scene.rec.rates, dur = scene.rec.duration;
      const src = this.src, dst = this.dst;
      try {
        // Measure at the exported snapshots (inside the window nothing else
        // changes either object, so these knots are the right ones).
        src.apply({ ...this.rec.src, opacity: 1 }, t0 + 1e-6, dur, rates);
        dst.apply({ ...this.rec.dst, opacity: 1 }, t1 - 1e-6, dur, rates);
        const parent = src.el.parentNode;
        if (dst.el.parentNode !== parent) throw new MorphError("different layers");
        const pctm = parent.getCTM();
        if (!pctm) throw new MorphError("not measurable");
        const base = pctm.inverse();
        const A = shapeLeaves(src, base);
        const B = shapeLeaves(dst, base);
        const between = this.between();
        if (between) throw new MorphError(between);
        this.buildShape(A, B, parent);
      } catch (err) {
        if (!(err instanceof MorphError)) throw err;
        this.fallback(err.message);
        if (this.rec.strict)
          console.warn(`touying: transform("${source}", "${target}") crossfades: ${err.message}`);
      }
    }

    buildShape(A, B, parent) {
      // Pair parts by their place within their object (positions relative
      // to the object's bounds), so objects far apart still pair sensibly.
      const frame = (L) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of L) {
          x0 = Math.min(x0, l.box.x);
          y0 = Math.min(y0, l.box.y);
          x1 = Math.max(x1, l.box.x + l.box.w);
          y1 = Math.max(y1, l.box.y + l.box.h);
        }
        const s = Math.max(x1 - x0, y1 - y0, 1e-9);
        const w = Math.max(x1 - x0, 0.1 * s), h = Math.max(y1 - y0, 0.1 * s);
        for (const l of L) {
          l.u = (l.cx - x0) / w;
          l.v = (l.cy - y0) / h;
        }
      };
      frame(A);
      frame(B);
      // Deterministic pairing: reading order, then paint order.
      const order = (L) =>
        L.map((_, i) => i).sort((i, j) => L[i].v - L[j].v || L[i].u - L[j].u || i - j);
      const oa = order(A), ob = order(B);
      const matched = assign(
        oa.map((i) => A[i]),
        ob.map((j) => B[j]),
        (a, b) => Math.hypot(a.u - b.u, a.v - b.v),
        1
      );
      const partnerA = new Map(), partnerB = new Map();
      for (const [x, y] of matched) {
        partnerA.set(oa[x], ob[y]);
        partnerB.set(ob[y], oa[x]);
      }
      // One fixed overlay order, merging both paintings: source order, with
      // target-only parts inserted after their predecessor in target order.
      const items = A.map((a, i) => ({ a, b: partnerA.has(i) ? B[partnerA.get(i)] : null, tb: partnerA.get(i) }));
      const itemOfB = new Map();
      items.forEach((it) => it.tb !== undefined && itemOfB.set(it.tb, it));
      let last = null;
      B.forEach((b, j) => {
        if (itemOfB.has(j)) {
          last = itemOfB.get(j);
          return;
        }
        const it = { a: null, b, tb: j };
        items.splice(last ? items.indexOf(last) + 1 : 0, 0, it);
        last = it;
      });
      // Parts that overlap must keep their stacking order, unless the order
      // cannot show: all of them opaque and painted alike (e.g. the glyphs of
      // an equation, whose boxes often touch).
      const paired = items.filter((it) => it.a && it.b);
      const paintKey = (l) => {
        const p = l.paint;
        const opaque = p.fillOpacity >= 1 - 1e-9 && p.strokeOpacity >= 1 - 1e-9 && p.opacity >= 1 - 1e-9;
        return opaque ? `${p.fill}|${p.stroke}|${p.stroked ? p.strokeWidth * l.scale : 0}` : null;
      };
      const alike = (p, q) => {
        const k = paintKey(p.a);
        return k !== null && [p.b, q.a, q.b].every((l) => paintKey(l) === k);
      };
      for (let x = 0; x < paired.length; x++)
        for (let y = x + 1; y < paired.length; y++) {
          const p = paired[x], q = paired[y];
          if (p.tb < q.tb || alike(p, q)) continue;
          if (boxesOverlap(p.a.box, q.a.box) || boxesOverlap(p.b.box, q.b.box))
            throw new MorphError("overlapping parts change their stacking order");
        }

      const doc = parent.ownerDocument;
      const overlay = doc.createElementNS(SVGNS, "g");
      overlay.setAttribute("data-tys-morph", `${this.rec.source}->${this.rec.target}`);
      overlay.style.display = "none";
      parent.insertBefore(overlay, this.src.el.nextSibling);
      this.overlay = overlay;
      const tiers = { morph: 0, grow: 0, shrink: 0, fade: 0 };
      let curves = 0;
      const clone = (leaf) => {
        const c = leaf.el.cloneNode(true);
        c.removeAttribute("transform");
        if (c.localName === "use") {
          c.removeAttribute("x");
          c.removeAttribute("y");
        }
        c.removeAttribute("data-typst-label");
        c.setAttribute("transform", matrixString(leaf.cloneM));
        overlay.appendChild(c);
        return c;
      };
      const rgb = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
      for (const { a, b } of items) {
        const fade = () => {
          tiers.fade++;
          const ca = a && clone(a), cb = b && clone(b);
          this.items.push((f) => {
            if (ca) ca.setAttribute("opacity", num(1 - f));
            if (cb) cb.setAttribute("opacity", num(f));
          });
        };
        if ((a && !a.paint.simple) || (b && !b.paint.simple) || (a && b && !compatible(a, b))) {
          fade();
          continue;
        }
        const contours = alignContours(a, b);
        if (!contours) {
          fade(); // open versus closed outlines
          continue;
        }
        for (const [ca] of contours) curves += ca.segs.length;
        if (curves > SHAPE_BUDGET.curves) throw new MorphError("too many curves");
        tiers[a && b ? "morph" : a ? "shrink" : "grow"]++;
        const sa = styleOf(a, b, !a), sb = styleOf(b, a, !b);
        const p = (a || b).paint;
        const stroked = a && a.paint.stroked ? a.paint : b && b.paint.stroked ? b.paint : p;
        const path = doc.createElementNS(SVGNS, "path");
        path.setAttribute("fill-rule", p.fillRule);
        path.setAttribute("stroke-linecap", stroked.linecap);
        path.setAttribute("stroke-linejoin", stroked.linejoin);
        path.setAttribute("stroke-miterlimit", stroked.miterlimit);
        overlay.appendChild(path);
        const l = (x, y, f) => x + (y - x) * f;
        const mix = (x, y, f) => [0, 1, 2].map((k) => l(x[k], y[k], f));
        this.items.push((f) => {
          path.setAttribute("d", pathData(contours, f));
          path.setAttribute("fill", rgb(mix(sa.fill, sb.fill, f)));
          path.setAttribute("fill-opacity", num(l(sa.fa, sb.fa, f)));
          path.setAttribute("stroke", rgb(mix(sa.stroke, sb.stroke, f)));
          path.setAttribute("stroke-opacity", num(l(sa.sa, sb.sa, f)));
          path.setAttribute("stroke-width", num(l(sa.width, sb.width, f)));
        });
      }
      this.mode = "shape";
      this.info.mode = "shape";
      this.info.reason = null;
      this.info.tiers = tiers;
      this.info.pairs = items
        .filter((it) => it.a && it.b)
        .map((it) => ({ from: [num(it.a.cx), num(it.a.cy)], to: [num(it.b.cx), num(it.b.cy)] }));
    }

    // Remove this morph's overrides (called for every morph before any applies).
    clear() {
      const src = this.src, dst = this.dst;
      if (!src || !dst) return;
      if (this.overlay) this.overlay.style.display = "none";
      for (const v of [src, dst]) {
        v.xf.style.visibility = "";
        v.xf.style.opacity = "";
      }
    }

    apply(t) {
      const { t0, t1, ease } = this.rec;
      const src = this.src, dst = this.dst;
      if (!src || !dst) return;
      const inside = t1 > t0 && t >= t0 - 1e-9 && t < t1 - 1e-9;
      if (!inside) return; // inactive morphs write nothing
      const f = easeEval(this.scene.rec.rates[ease], (t - t0) / (t1 - t0));
      if (this.overlay && (this.mode === "overlay" || this.mode === "shape")) {
        this.overlay.style.display = "";
        src.xf.style.visibility = "hidden";
        dst.xf.style.visibility = "hidden";
        for (const item of this.items) item(f);
      } else if (this.rec.kind !== "shape") {
        // Matching morph fallback: inline opacity overrides the tracks'
        // opacity meanwhile. A shape morph that falls back writes nothing:
        // its transform tracks animate the crossfade on their own.
        src.xf.style.opacity = num(1 - f);
        dst.xf.style.opacity = num(f);
      }
    }
  }

  // ---------------------------------------------------------------- stages

  // A stage is one place a page is shown: the audience view, or the current
  // and next views of the presenter window (which is another document).
  class Stage {
    constructor(doc, root, role) {
      this.doc = doc;
      this.root = root;
      this.role = role;
      this.scenes = [];
    }

    render(player, i) {
      const svg = this.doc.importNode(player.pageNode(i), true);
      svg.setAttribute("aria-label", `Slide page ${i + 1} of ${player.count}`);
      this.root.replaceChildren(svg);
      this.scenes = (player.payload.scenes[i] || [])
        .map((rec) => new SceneView(svg, rec))
        .filter((s) => s.root);
    }

    clear(text) {
      this.scenes = [];
      const note = this.doc.createElement("div");
      note.className = "tys-end";
      note.textContent = text;
      this.root.replaceChildren(note);
    }

    apply(t) {
      for (const s of this.scenes) s.apply(s.active ? t : 0);
    }
  }

  // --------------------------------------------------------------- scheduler

  // Runs the animation loop on a visible window: the audience window, or the
  // presenter window while the audience one is hidden. Time is always read
  // from this realm's performance.now(), never from another window's rAF
  // timestamps, so the clock never changes when the owner does. At most one
  // frame request is outstanding; the ticket invalidates stale callbacks.
  class Scheduler {
    constructor(tick) {
      this.tick = tick;
      this.windows = () => [window];
      this.running = false;
      this.owner = null;
      this.request = 0;
      this.ticket = 0;
    }

    visibleWindow() {
      for (const w of this.windows()) {
        try {
          if (!w.closed && !w.document.hidden) return w;
        } catch (_) {
          // A closing popup can throw on access; skip it.
        }
      }
      return null;
    }

    cancel() {
      this.ticket++;
      if (this.owner) {
        try {
          if (!this.owner.closed) this.owner.cancelAnimationFrame(this.request);
        } catch (_) {}
      }
      this.owner = null;
    }

    // Returns false when no window is visible (nothing scheduled).
    schedule() {
      this.cancel();
      if (!this.running) return false;
      const w = this.visibleWindow();
      if (!w) return false;
      const ticket = this.ticket;
      this.owner = w;
      this.request = w.requestAnimationFrame(() => {
        if (ticket !== this.ticket) return;
        this.owner = null;
        this.tick();
        if (this.running && ticket === this.ticket) this.schedule();
      });
      return true;
    }
  }

  // Presentation timer for the speaker; independent of scene time.
  class Timer {
    constructor() {
      this.started = false;
      this.running = false;
      this.since = 0;
      this.acc = 0;
    }
    start() {
      if (this.running) return;
      this.started = true;
      this.running = true;
      this.since = performance.now();
    }
    pause() {
      if (!this.running) return;
      this.acc += performance.now() - this.since;
      this.running = false;
    }
    toggle() {
      if (this.running) this.pause();
      else this.start();
    }
    reset() {
      this.acc = 0;
      this.since = performance.now();
    }
    get elapsed() {
      return this.acc + (this.running ? performance.now() - this.since : 0);
    }
  }

  const pad2 = (n) => String(Math.floor(n)).padStart(2, "0");
  function formatElapsed(ms) {
    const s = ms / 1000;
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    return (h ? `${h}:${pad2(m)}` : pad2(m)) + `:${pad2(s % 60)}`;
  }

  // ---------------------------------------------------------------- player

  class Player {
    constructor(payload, stageEl) {
      this.payload = payload;
      this.audience = new Stage(document, stageEl, "audience");
      this.presenter = null;
      this.templates = [];
      this.page = -1;
      this.duration = 0;
      this.time = 0;
      this.playing = false;
      this.start = 0;
      this.hiddenAt = null;
      this.activations = 0;
      this.timer = new Timer();
      this.scheduler = new Scheduler(() => this.tick());
      this.scheduler.windows = () =>
        this.presenter ? [window, this.presenter.win] : [window];
      this.notes = document.getElementById("tys-notes");
      this.counter = document.getElementById("tys-counter");
    }

    get count() {
      return this.payload.pages.length;
    }

    // Scene views of the audience stage (the test API reads these).
    get scenes() {
      return this.audience.scenes;
    }

    liveStages() {
      return this.presenter ? [this.audience, this.presenter.current] : [this.audience];
    }

    pageNode(i) {
      let tpl = this.templates[i];
      if (!tpl) {
        tpl = document.createElement("template");
        tpl.innerHTML = this.payload.pages[i];
        this.templates[i] = tpl;
      }
      return tpl.content.firstElementChild.cloneNode(true);
    }

    // mode: "play" (forward entry), "end" (terminal state), "start" (paused at 0)
    show(i, mode = "end") {
      this.stop();
      i = clamp(i, 0, this.count - 1);
      // Looking around with the mouse is per page. A scene that continues on
      // the new page turns back to its script smoothly; others are dropped.
      const dragged = new Map(DRAG);
      DRAG.clear();
      this.dragEase = null;
      this.page = i;
      for (const stage of this.liveStages()) stage.render(this, i);
      for (const sc of this.audience.scenes)
        if (sc.world && dragged.has(sc.rec.scene.key)) DRAG.set(sc.rec.scene.key, dragged.get(sc.rec.scene.key));
      if (this.presenter) this.presenter.renderNext();
      for (const stage of this.liveStages())
        stage.root.style.touchAction = stage.scenes.some((sc) => sc.world) ? "none" : "";
      const active = this.audience.scenes.filter((s) => s.active);
      this.duration = active.reduce((m, s) => Math.max(m, s.rec.duration), 0);
      if (mode === "play" && !reducedMotion && this.duration > 0) {
        this.activations++;
        this.applyAll(0);
        this.play();
      } else if (mode === "start") {
        this.applyAll(0);
      } else {
        this.applyAll(Infinity);
      }
      if (DRAG.size) this.resetView(NAV_RESET_MS);
      if (this.notes) this.notes.textContent = this.payload.notes[i] || "";
      if (this.counter) this.counter.textContent = `${i + 1} / ${this.count}`;
      if (this.presenter) this.presenter.update();
      try {
        if (history.replaceState) history.replaceState(null, "", `#${i + 1}`);
      } catch (_) {
        // WebKit throttles replaceState (100 calls per 10 s): the page
        // number in the URL is a convenience, never worth an error.
      }
    }

    applyAll(t) {
      this.time = Math.min(t, this.duration);
      for (const stage of this.liveStages()) stage.apply(t);
    }

    play() {
      this.playing = true;
      this.start = performance.now();
      this.hiddenAt = null;
      this.scheduler.running = true;
      if (!this.scheduler.schedule()) this.hiddenAt = performance.now();
    }

    tick() {
      if (!this.playing) return;
      const t = (performance.now() - this.start) / 1000;
      if (t >= this.duration) {
        this.stop();
        this.applyAll(this.duration);
      } else {
        this.applyAll(t);
      }
    }

    stop() {
      this.playing = false;
      this.hiddenAt = null;
      this.scheduler.running = false;
      this.scheduler.cancel();
    }

    finish() {
      this.stop();
      this.applyAll(Infinity);
    }

    // Scene time stands still only while every live window is hidden; while
    // one is visible, the loop runs there.
    visibilityChanged() {
      if (!this.playing) return;
      if (!this.scheduler.visibleWindow()) {
        if (this.hiddenAt === null) {
          this.hiddenAt = performance.now();
          this.scheduler.cancel();
        }
        return;
      }
      if (this.hiddenAt !== null) {
        this.start += performance.now() - this.hiddenAt;
        this.hiddenAt = null;
      }
      this.scheduler.schedule();
    }

    next() {
      this.timer.started || this.timer.start();
      if (this.playing) return this.finish();
      if (this.page < this.count - 1) this.show(this.page + 1, "play");
    }

    prev() {
      if (this.page > 0) this.show(this.page - 1, "end");
      else this.show(0, "end");
    }

    seek(t) {
      this.stop();
      this.applyAll(t);
    }

    command(cmd) {
      switch (cmd) {
        case "next":
          return this.next();
        case "prev":
          return this.prev();
        case "first":
          return this.show(0, "end");
        case "last":
          return this.show(this.count - 1, "end");
        case "replay":
          return this.show(this.page, "play");
        case "notes":
          return document.body.classList.toggle("tys-show-notes");
        case "presenter":
          return this.openPresenter();
        case "reset-view":
          return this.resetView();
        case "timer.toggle":
          this.timer.toggle();
          return this.presenter && this.presenter.update();
        case "timer.reset":
          this.timer.reset();
          return this.presenter && this.presenter.update();
        case "notes.larger":
        case "notes.smaller":
          return this.presenter && this.presenter.resizeNotes(cmd === "notes.larger" ? 1 : -1);
      }
    }

    // ---- drag to rotate (3D scenes) ----

    worlds(key) {
      const out = [];
      for (const stage of this.liveStages())
        for (const sc of stage.scenes) if (sc.world && (!key || sc.rec.scene.key === key)) out.push(sc.world);
      return out;
    }

    redraw3d(key) {
      for (const w of this.worlds(key)) w.redraw();
    }

    // The scene (with a 3D world) under a client point of a stage.
    worldAt(stageEl, x, y) {
      const stage = this.liveStages().find((st) => st.root === stageEl);
      if (!stage) return null;
      for (const sc of stage.scenes) {
        if (!sc.world) continue;
        const r = sc.root.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return sc;
      }
      return null;
    }

    // Change the drag offset of a scene. The polar angle seen is kept within
    // [1°, 179°] by limiting the offset only (the scripted angle may be
    // anything, e.g. 350°, and never jumps).
    nudge(sc, dphi, dtheta, zoom) {
      const key = sc.rec.scene.key;
      this.dragEase = null; // grabbing the scene stops an ease back
      const off = DRAG.get(key) || { dphi: 0, dtheta: 0, zoom: 1 };
      const phi = evalObject(sc.rec.camera, sc.rec.rates, sc.world.time).phi;
      const m = ((phi % 360) + 360) % 360;
      let [lo, hi] = m <= 180 ? [1 - m, 179 - m] : [181 - m, 359 - m];
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
      off.dphi = clamp(off.dphi + dphi, lo, hi);
      off.dtheta += dtheta;
      off.zoom = clamp(off.zoom * zoom, 0.25, 4);
      DRAG.set(key, off);
      this.redraw3d(key);
    }

    // `0` (and a page change): ease the offsets back to the script.
    resetView(ms = 300) {
      if (!DRAG.size) return;
      const from = new Map([...DRAG].map(([k, v]) => [k, { ...v }]));
      const done = () => {
        DRAG.clear();
        this.dragEase = null;
        this.redraw3d();
      };
      const win = this.scheduler.visibleWindow();
      if (reducedMotion || !win) return done();
      const ticket = (this.dragEase = {});
      const start = performance.now();
      const frame = () => {
        if (this.dragEase !== ticket) return;
        const f = Math.min(1, (performance.now() - start) / ms);
        if (f >= 1) return done();
        const k = 1 - (f * f * (3 - 2 * f));
        for (const [key, v] of from)
          DRAG.set(key, { dphi: v.dphi * k, dtheta: v.dtheta * k, zoom: Math.pow(v.zoom, k) });
        this.redraw3d();
        const w = this.scheduler.visibleWindow();
        if (w) w.requestAnimationFrame(frame);
        else done();
      };
      win.requestAnimationFrame(frame);
    }

    // Open (or re-attach to) the presenter window. Attaching renders the
    // current page at the current scene time without changing the page,
    // playback, activation count or time.
    openPresenter() {
      const open = () => {
        try {
          return window.open("", "touying-presenter", "popup,width=1280,height=760");
        } catch (_) {
          return null;
        }
      };
      const accessible = (w) => {
        try {
          return !!w.document;
        } catch (_) {
          return false;
        }
      };
      let win = open();
      if (win && !accessible(win)) {
        // Under file://, every page load gets a fresh opaque origin, so a
        // presenter window left over from before a reload is cross-origin.
        // Replace it (scripts may close windows they opened).
        try {
          win.close();
        } catch (_) {}
        win = open();
      }
      if (!win || !accessible(win)) {
        notice("The presenter window was blocked. Allow pop-ups for this file and press P again.");
        return null;
      }
      this.attachPresenter(win);
      try {
        win.focus();
      } catch (_) {}
      return win;
    }

    attachPresenter(win) {
      if (this.presenter) this.presenter.destroy();
      this.presenter = new Presenter(this, win);
      this.presenter.current.render(this, this.page);
      this.presenter.current.apply(this.time);
      this.presenter.renderNext();
      this.presenter.update();
      // The presenter may now be the only visible window for the frame loop.
      if (this.playing) this.visibilityChanged();
    }

    // The presenter's document went away: either the window closed, or it
    // navigated (a reused window can still be navigating to about:blank when
    // it is first written to). Rebuild in the latter case.
    checkPresenter() {
      const p = this.presenter;
      if (!p) return;
      if (p.closed) return this.detachPresenter();
      let replaced = true;
      try {
        replaced = p.win.document !== p.doc || !p.doc.querySelector(".tys-p-current");
      } catch (_) {}
      if (replaced) this.attachPresenter(p.win);
    }

    detachPresenter() {
      if (!this.presenter) return;
      this.presenter.destroy();
      this.presenter = null;
      // The presenter may have owned the frame loop.
      if (this.playing) this.visibilityChanged();
    }
  }

  // ------------------------------------------------------------- presenter

  const PRESENTER_BODY = `
<svg id="tys-defs" aria-hidden="true" focusable="false" width="0" height="0"></svg>
<main class="tys-p-current" aria-label="Current slide"></main>
<aside class="tys-p-side">
  <section class="tys-p-next-wrap" aria-label="Next slide">
    <div class="tys-p-label">Next</div>
    <div class="tys-p-next"></div>
  </section>
  <section class="tys-notes-pane" tabindex="0" aria-label="Speaker notes"></section>
</aside>
<footer class="tys-bar">
  <span class="tys-timer" title="Elapsed (T to pause)">00:00</span>
  <button type="button" data-cmd="timer.toggle" title="Pause or resume the timer (T)">Pause</button>
  <button type="button" data-cmd="timer.reset" title="Reset the timer">Reset</button>
  <span class="tys-clock"></span>
  <span class="tys-count"></span>
  <span class="tys-spacer"></span>
  <button type="button" data-cmd="notes.smaller" title="Smaller notes">A−</button>
  <button type="button" data-cmd="notes.larger" title="Larger notes">A+</button>
  <button type="button" data-cmd="prev" title="Previous (←)">◀</button>
  <button type="button" data-cmd="next" title="Next (→, space)">▶</button>
</footer>`;

  class Presenter {
    constructor(player, win) {
      this.player = player;
      this.win = win;
      this.abort = new AbortController();
      this.notesSize = 22;
      const doc = win.document;
      // Rebuilt on every attach: a reloaded deck may get back a blank (or a
      // stale) window. document.open() also drops listeners of a former deck.
      const css = document.querySelector("style").textContent;
      doc.open();
      doc.write(
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
          `<title>Presenter – ${escapeHtml(document.title)}</title>` +
          `<style>${css}</style></head><body class="tys-presenter">${PRESENTER_BODY}</body></html>`
      );
      doc.close();
      doc.getElementById("tys-defs").innerHTML = `<defs>${player.payload.defs}</defs>`;
      const [w, h] = player.payload.size || [16, 9];
      doc.body.style.setProperty("--tys-aspect", `${w} / ${h}`);
      this.doc = doc;
      this.current = new Stage(doc, doc.querySelector(".tys-p-current"), "presenter-current");
      this.next = new Stage(doc, doc.querySelector(".tys-p-next"), "presenter-next");
      this.notes = doc.querySelector(".tys-notes-pane");
      this.timerEl = doc.querySelector(".tys-timer");
      this.toggleEl = doc.querySelector('[data-cmd="timer.toggle"]');
      this.clockEl = doc.querySelector(".tys-clock");
      this.countEl = doc.querySelector(".tys-count");
      bindWindow(player, win, this.abort.signal, this.current.root);
      win.addEventListener("pagehide", () => setTimeout(() => player.checkPresenter(), 100), {
        signal: this.abort.signal,
      });
      // A closed window cannot report its own closing reliably, and a
      // navigation replaces the document: check both periodically.
      this.watch = setInterval(() => {
        player.checkPresenter();
        if (player.presenter === this) this.updateClock();
      }, 1000);
      this.ticker = setInterval(() => this.updateTimer(), 250);
    }

    get closed() {
      try {
        return this.win.closed;
      } catch (_) {
        return true;
      }
    }

    destroy() {
      this.abort.abort();
      clearInterval(this.watch);
      clearInterval(this.ticker);
    }

    renderNext() {
      const i = this.player.page + 1;
      if (i < this.player.count) {
        this.next.render(this.player, i);
        this.next.apply(Infinity);
      } else {
        this.next.clear("End of presentation");
      }
    }

    update() {
      const p = this.player;
      this.notes.textContent = p.payload.notes[p.page] || "";
      this.countEl.textContent = `${p.page + 1} / ${p.count}`;
      this.updateTimer();
      this.updateClock();
    }

    updateTimer() {
      if (this.closed) return;
      const t = this.player.timer;
      this.timerEl.textContent = formatElapsed(t.elapsed);
      this.timerEl.classList.toggle("tys-paused", t.started && !t.running);
      this.toggleEl.textContent = t.running ? "Pause" : "Start";
    }

    updateClock() {
      const d = new Date();
      this.clockEl.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    resizeNotes(step) {
      this.notesSize = clamp(this.notesSize + step * 2, 10, 60);
      this.notes.style.fontSize = `${this.notesSize}px`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function notice(text) {
    let el = document.getElementById("tys-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "tys-toast";
      el.setAttribute("role", "status");
      document.body.append(el);
    }
    el.textContent = text;
    el.classList.add("tys-visible");
    clearTimeout(notice.timeout);
    notice.timeout = setTimeout(() => el.classList.remove("tys-visible"), 5000);
  }

  // ------------------------------------------------------------------ input

  function keyCommand(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return null;
    const k = e.key;
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k)) return "next";
    if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) return "prev";
    if (k === "Home") return "first";
    if (k === "End") return "last";
    const lower = k.length === 1 ? k.toLowerCase() : "";
    return (
      { r: "replay", n: "notes", f: "fullscreen", p: "presenter", s: "presenter", t: "timer.toggle", 0: "reset-view" }[
        lower
      ] || null
    );
  }

  // Keyboard, click and visibility handling for one window (audience or
  // presenter); everything is forwarded to the one player as a command.
  function bindWindow(player, win, signal, stageEl) {
    const doc = win.document;
    doc.addEventListener(
      "keydown",
      (e) => {
        const cmd = keyCommand(e);
        if (!cmd) return;
        // Inside the presenter's notes and controls, keys keep their usual
        // meaning (scrolling, pressing a focused button).
        if (e.target && e.target.closest && e.target.closest(".tys-notes-pane, .tys-bar")) return;
        if (cmd === "fullscreen") {
          // Fullscreen needs a gesture in the window that goes fullscreen.
          if (doc.fullscreenElement) doc.exitFullscreen();
          else doc.documentElement.requestFullscreen?.();
        } else {
          player.command(cmd);
        }
        e.preventDefault();
      },
      { signal }
    );
    // Drag on a 3D scene to look around; the click ending a drag is ignored.
    let drag = null;
    let swallowClick = false;
    if (stageEl) {
      stageEl.addEventListener(
        "pointerdown",
        (e) => {
          if (e.button !== 0) return;
          const sc = player.worldAt(stageEl, e.clientX, e.clientY);
          if (!sc) return;
          drag = { sc, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
        },
        { signal }
      );
      stageEl.addEventListener(
        "pointermove",
        (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (!drag.moved) {
            if (Math.hypot(dx, dy) < 4) return;
            drag.moved = true;
            try {
              stageEl.setPointerCapture(e.pointerId);
            } catch (_) {}
          }
          drag.x = e.clientX;
          drag.y = e.clientY;
          player.nudge(drag.sc, -dy * 0.4, -dx * 0.4, 1);
          e.preventDefault();
        },
        { signal }
      );
      const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (drag.moved) swallowClick = e.type === "pointerup";
        drag = null;
      };
      stageEl.addEventListener("pointerup", end, { signal });
      stageEl.addEventListener("pointercancel", end, { signal });
      stageEl.addEventListener(
        "wheel",
        (e) => {
          const sc = player.worldAt(stageEl, e.clientX, e.clientY);
          if (!sc) return;
          e.preventDefault();
          player.nudge(sc, 0, 0, Math.exp(-e.deltaY * 0.001));
        },
        { signal, passive: false }
      );
    }
    doc.addEventListener(
      "click",
      (e) => {
        if (swallowClick) {
          swallowClick = false;
          return;
        }
        const button = e.target && e.target.closest && e.target.closest("[data-cmd]");
        if (button) return player.command(button.dataset.cmd);
        if (e.button === 0 && stageEl && stageEl.contains(e.target)) player.next();
      },
      { signal }
    );
    doc.addEventListener("visibilitychange", () => player.visibilityChanged(), { signal });
  }

  // ------------------------------------------------------------------ boot

  async function boot() {
    const stage = document.getElementById("tys-stage");
    try {
      const payload = await loadPayload();
      const defs = document.getElementById("tys-defs");
      defs.innerHTML = `<defs>${payload.defs}</defs>`;
      const player = new Player(payload, stage);
      bindWindow(player, window, undefined, stage);
      window.addEventListener("hashchange", () => {
        const i = parseInt(location.hash.slice(1), 10) - 1;
        if (Number.isFinite(i) && i !== player.page) player.show(i, "end");
      });
      window.addEventListener("pagehide", () => {
        if (player.presenter) player.presenter.destroy();
      });
      const fromHash = parseInt(location.hash.slice(1), 10) - 1;
      if (Number.isFinite(fromHash) && fromHash > 0) player.show(fromHash, "end");
      else player.show(0, "play");
      window.touying = {
        player,
        get page() {
          return player.page;
        },
        get playing() {
          return player.playing;
        },
        get duration() {
          return player.duration;
        },
        get activations() {
          return player.activations;
        },
        get presenter() {
          return player.presenter;
        },
        count: player.count,
        goto: (i, mode = "end") => player.show(i, mode),
        next: () => player.next(),
        prev: () => player.prev(),
        seek: (t) => player.seek(t),
        command: (cmd) => player.command(cmd),
        states: (t) => player.scenes.map((s) => ({ key: s.rec.scene.key, states: s.states(t) })),
        morphs: () => player.scenes.flatMap((s) => s.morphs.map((m) => m.info)),
        shapes: { parsePath, alignContours, splitTo, pathData },
        drag: (key) => DRAG.get(key) || null,
        kernel: { makeView, toCamera, toScreen, drawables, matRotation, matMul, matApply, stepsMatrix },
        world: () =>
          player.scenes.filter((s) => s.world).map((s) => ({
            key: s.rec.scene.key,
            list: s.world.lastList,
            positions: s.world.lastItems.map((i) => i.pos),
          })),
      };
      document.body.dataset.ready = "true";
    } catch (err) {
      stage.textContent = String(err && err.message ? err.message : err);
      document.body.dataset.ready = "error";
      throw err;
    }
  }

  boot();
})();
