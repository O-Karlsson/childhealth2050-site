// How fast countries are actually moving, against how fast they would have to move.
//
// The prospect charts answer "is THIS country on track". This answers "how many are",
// and shows the shape of the answer: one distribution of recent annual change per
// indicator, with a vertical line at the pace the goal requires and the count on each
// side of it. A reader sees at once whether the world is a little short or nowhere near.
//
// Countries only. A regional aggregate is a weighted mean of countries already in the
// distribution, so including one would count the same children twice and pull a second
// bump out of nothing.
//
// Two things this figure must not get wrong, and both are handled below rather than
// assumed: which SIDE of the line is on track, and whether the line and the count agree.
//
// `measure: "level"` draws the same panels over the latest VALUE instead of the rate —
// where countries are, rather than how fast they are moving (2026-09-25). There is no
// threshold there: the goal is a pace, and a level has no pace. And `highlight` picks out
// named countries inside either distribution, which is how a reader finds their own
// country among two hundred without the figure becoming about one of them.

import { registerExportable, niceTicks, rowName } from "./prospect-chart.js";
import { num } from "./format.js";

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

// The pace that closes half the gap by the target year, in the units the outcome's own
// `rate` is stored in — which is the whole reason this is computed per outcome rather
// than once. A proportional outcome compounds on its gap, so halving it over `run` years
// is a constant annual rate; height moves in a straight line in centimetres, so its
// requirement is the target divided by the run.
//
// `run` comes from each outcome's OWN latest year. They are not all the same: maths still
// starts from 2018 while everything else starts from 2025, and a shared 25 would quietly
// make the maths bar 22% too easy.
// A stored rate as the figure shows it: per cent for the proportional outcomes, and signed
// so that better is positive whichever way the outcome moves.
function improvement(meta, v) {
  const sign = meta.direction === "higher" ? 1 : -1;
  return (meta.trendRule !== "linear" ? v * 100 : v) * sign;
}

function requiredRate(meta, sex, bands, targetYear) {
  const run = targetYear - meta.latestYear;
  if (!(run > 0)) return null;
  if (meta.trendRule === "linear") {
    const target = meta.target?.[sex];
    return target == null ? null : target / run;
  }
  return (1 - bands[1]) ** (1 / run) - 1;
}

// Gaussian kernel density with Silverman's rule of thumb. Hand-rolled because the whole
// estimator is six lines and a dependency for it would be its own liability.
//
// The bandwidth uses the smaller of the standard deviation and the IQR-based scale, which
// is what stops one country with an absurd rate — and the projections have no guard rails,
// so there are some — from smearing every real feature of the distribution flat.
function density(values, grid) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const iqr = q(0.75) - q(0.25);
  const scale = iqr > 0 ? Math.min(sd, iqr / 1.349) : sd;
  const h = 1.06 * (scale || sd || 1) * n ** (-1 / 5);
  if (!(h > 0)) return grid.map(() => 0);
  const c = 1 / (n * h * Math.sqrt(2 * Math.PI));
  return grid.map((x) =>
    c * values.reduce((a, v) => a + Math.exp(-0.5 * ((x - v) / h) ** 2), 0));
}

// Bins with an EDGE on the required pace, which is the point of offering bins at all: a
// bar straddling the threshold would put on-track and off-track countries in one column
// and make the count unreadable off the figure. The origin is shifted so `edgeAt` lands
// on a boundary; the width is Freedman–Diaconis, falling back to the range over 12.
function bins(values, lo, hi, edgeAt) {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const iqr = q(0.75) - q(0.25);
  let w = iqr > 0 ? 2 * iqr * n ** (-1 / 3) : (hi - lo) / 12;
  if (!(w > 0)) w = (hi - lo) / 12 || 1;
  // Cap the count so a tight distribution does not become a comb of single-country bars.
  if ((hi - lo) / w > 40) w = (hi - lo) / 40;
  const origin = edgeAt == null ? lo : edgeAt - Math.ceil((edgeAt - lo) / w) * w;
  const out = [];
  for (let x = origin; x < hi + w * 1e-9; x += w) {
    out.push({ x0: x, x1: x + w, n: 0 });
  }
  for (const v of values) {
    const i = Math.min(out.length - 1, Math.max(0, Math.floor((v - origin) / w)));
    out[i].n++;
  }
  return out;
}

// One outcome's numbers, gathered before anything is drawn so the panel can be skipped
// when there is nothing to draw and the note can say what was skipped.
function collect(cfg, key) {
  const { summary: S, locations: L, sex, window: w } = cfg;
  const meta = S.outcomes[key];
  const iProj = S.meta.trendFields.indexOf("rate");
  const iPct = S.meta.trendFields.indexOf("pctClosed");

  if (cfg.measure === "level") {
    const points = [];
    for (const [code, rec] of Object.entries(S.data)) {
      if (L.locations[code]?.type !== "country") continue;
      const v = rec?.[key]?.[sex]?.v;
      if (Number.isFinite(v)) points.push({ code, label: L.locations[code].label, value: v });
    }
    return { key, meta, required: null, points, onTrack: null };
  }

  const required = requiredRate(meta, sex, S.meta.bands, S.meta.targetYear);
  const points = [];
  for (const [code, rec] of Object.entries(S.data)) {
    if (L.locations[code]?.type !== "country") continue;
    const t = rec?.[key]?.[sex]?.t?.[w];
    if (!t) continue;
    const rate = t[iProj];
    const pct = t[iPct];
    if (!Number.isFinite(rate) || !Number.isFinite(pct)) continue;
    points.push({ code, label: L.locations[code].label, rate, pct, value: improvement(meta, rate) });
  }
  // "On track" is read off the share of the gap the projection closes, not off the rate
  // against the line. The two agree by construction — the line is exactly the rate that
  // closes half the gap — but pctClosed is what colours every other figure on the site,
  // so taking it from there is what stops this figure disagreeing with those.
  const onTrack = points.filter((p) => p.pct >= S.meta.bands[1]).length;
  return { key, meta, required, points, onTrack };
}

const PANEL_W = 330, PANEL_H = 196, GAP_X = 26, GAP_Y = 40;

// Highlighted countries: a tick up from the axis at the country's value, and its name above.
// Names are stacked into as many lines as it takes for no two to overlap, below the two
// count lines at the top of the panel, rather than dropped — a reader who picked a country
// has to be able to find it.
//
// Each name is measured (the svg is already in the document, which is what makes that
// possible) and sits on a box of the page ground. A halo alone follows the glyphs, so a tick
// from a name higher up still showed through the gap between words: "Sri|Lanka".
//
// `named`, where given, is the few that get a name; the rest keep a quieter, unnamed tick. A
// figure about one country among its neighbours wants that country named and the neighbours
// only placed, since six stacked names left the one that mattered hard to find.
function drawHighlights(g, hl, x, plotH, named) {
  const base = PAD.t + plotH;
  const ly = (line) => PAD.t + 30 + COUNT_DROP + line * 12;
  for (const p of hl.filter((q) => named && !named.has(q.code))) {
    g.appendChild(el("line", {
      class: "dist-hl quiet", x1: x(p.value), x2: x(p.value), y1: ly(0) + 3, y2: base,
    }));
    g.appendChild(el("circle", { class: "dist-hl-dot quiet", cx: x(p.value), cy: base, r: 2.5 }));
  }
  const labels = hl.filter((q) => !named || named.has(q.code))
    .sort((a, b) => a.value - b.value).map((p) => {
    const t = el("text", { class: "dist-hl-label", "text-anchor": "middle" }, p.label);
    g.appendChild(t);
    return { p, t, w: t.getComputedTextLength() || String(p.label).length * 5.6 };
  });
  const lines = [];
  for (const it of labels) {
    it.cx = Math.min(PANEL_W - it.w / 2, Math.max(it.w / 2, x(it.p.value)));
    it.line = lines.findIndex((end) => end < it.cx - it.w / 2 - 4);
    if (it.line < 0) { it.line = lines.length; lines.push(0); }
    lines[it.line] = it.cx + it.w / 2;
  }
  // Every tick goes in before the first name, then each name gets its box just before it, so
  // the paint order is all ticks, then boxes and names. Boxes on one line never overlap, and
  // lines are further apart than a box is tall.
  const first = labels[0]?.t;
  for (const { p, line } of labels) {
    g.insertBefore(el("line", {
      class: "dist-hl", x1: x(p.value), x2: x(p.value), y1: ly(line) + 3, y2: base,
    }), first);
    g.insertBefore(el("circle", { class: "dist-hl-dot", cx: x(p.value), cy: base, r: 3 }), first);
  }
  for (const { t, w, cx, line } of labels) {
    g.insertBefore(el("rect", {
      class: "dist-hl-bg", x: cx - w / 2 - 2, y: ly(line) - 9, width: w + 4, height: 11,
    }), t);
    t.setAttribute("x", cx);
    t.setAttribute("y", ly(line));
  }
}

// `t` leaves room for the two count lines to sit clear of the unit sublabel above them.
const PAD = { l: 34, r: 14, t: 34, b: 34 };
// How far the two counts sit in from the panel's sides and down from the plot's top (ADR-046).
const COUNT_INSET = 24, COUNT_DROP = 14;

function drawPanel(g, d, cfg) {
  const { display } = cfg;
  // Rates are stored as a fraction per year for the proportional outcomes; a reader
  // thinks in per cent. They are drawn as IMPROVEMENT — the sign flipped for the outcomes
  // that aim to fall — so a falling mortality rate reads positive and every panel has its
  // on-track countries on the right. Flipped here, at display, and nowhere upstream:
  // `rate` in summary.json feeds key-numbers.csv and the manuscript with its own sign.
  const level = cfg.measure === "level";
  const asPct = d.meta.trendRule !== "linear";
  const f = (v) => improvement(d.meta, v);
  // A level axis is the plain value, so it has to say which way is good; the improvement
  // axis already means "right is good" on every panel.
  const unit = level
    ? `${d.meta.unit}, ${d.meta.direction === "higher" ? "higher" : "lower"} is better`
    : asPct ? "improvement, % per year" : `improvement, ${d.meta.unit} per year`;

  const vals = d.points.map((p) => p.value);
  const req = d.required == null ? null : f(d.required);
  const named = cfg.highlightLabels ? new Set(cfg.highlightLabels) : null;
  const hl = (cfg.highlight ?? []).map((c) => d.points.find((p) => p.code === c))
    .filter(Boolean);

  // The tails are cut rather than scaled to. Without guard rails a handful of projections
  // run to absurd rates, and one of them would squeeze every other country into a single
  // pixel column. The cut is named in the note and the countries stay in the counts.
  const sorted = [...vals].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  let lo = pick(0.01), hi = pick(0.99);
  if (req != null) { lo = Math.min(lo, req); hi = Math.max(hi, req); }
  // A country the reader asked to see is never trimmed away with the tail.
  for (const p of hl) { lo = Math.min(lo, p.value); hi = Math.max(hi, p.value); }
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const plotW = PANEL_W - PAD.l - PAD.r;
  const plotH = PANEL_H - PAD.t - PAD.b;
  // The counts sit near the panel's top corners, so a threshold in the outer fifth of the axis
  // ran straight through one of them — the maths panels, where no country is anywhere near
  // the pace, put it hard against the edge. The range is widened until it sits clear, by as
  // much again as the counts are inset.
  if (req != null) {
    const span = hi - lo;
    const clear = 0.2 + COUNT_INSET / plotW;
    if (hi - req < clear * span) hi = req + clear * span;
    if (req - lo < clear * span) lo = req - clear * span;
  }
  // Levels of these measures cannot be negative, so the padding must not invent an axis
  // running below zero.
  if (level && sorted[0] >= 0) lo = Math.max(lo, 0);
  // Nor above the most the measure can be — a share past 100% is not a place on the axis.
  if (level && d.meta.valueMax != null) hi = Math.min(hi, d.meta.valueMax);
  const clipped = vals.filter((v) => v < lo || v > hi).length;

  const x =(v) => PAD.l + ((v - lo) / (hi - lo)) * plotW;

  g.appendChild(el("text", { class: "panel-title", x: 0, y: 10 }, rowName(d.meta)));
  g.appendChild(el("text", { class: "row-sublabel", x: 0, y: 21 }, unit));

  const inside = vals.filter((v) => v >= lo && v <= hi);
  if (display === "bins") {
    const bs = bins(inside, lo, hi, req);
    const maxN = Math.max(...bs.map((b) => b.n), 1);
    for (const b of bs) {
      if (!b.n) continue;
      const x0 = x(b.x0), x1 = x(b.x1);
      const h = (b.n / maxN) * plotH;
      g.appendChild(el("rect", {
        class: "dist-bar", x: x0 + 0.5, y: PAD.t + plotH - h,
        width: Math.max(1, x1 - x0 - 1), height: h,
      }));
    }
  } else {
    const grid = Array.from({ length: 121 }, (_, i) => lo + ((hi - lo) * i) / 120);
    const dens = density(inside, grid);
    const maxD = Math.max(...dens, 1e-12);
    const pts = grid.map((v, i) =>
      `${x(v).toFixed(2)},${(PAD.t + plotH - (dens[i] / maxD) * plotH).toFixed(2)}`);
    g.appendChild(el("polygon", {
      class: "dist-area",
      points: `${PAD.l},${PAD.t + plotH} ${pts.join(" ")} ${PAD.l + plotW},${PAD.t + plotH}`,
    }));
    g.appendChild(el("polyline", { class: "dist-line", points: pts.join(" ") }));
  }

  // Axis
  g.appendChild(el("line", {
    class: "axis-rule", x1: PAD.l, x2: PAD.l + plotW,
    y1: PAD.t + plotH, y2: PAD.t + plotH,
  }));
  // A tick label sits exactly ON the threshold, because that is the number the whole
  // panel is read against and it is the one value a reader should not have to interpolate.
  // Any regular tick that would collide with it is dropped rather than overprinted.
  let ticks = niceTicks(lo, hi, 6);
  if (req != null) {
    ticks = [...ticks.filter((t) => Math.abs(x(t) - x(req)) > 24), req].sort((a, b) => a - b);
  }
  for (const t of ticks) {
    const onReq = req != null && t === req;
    g.appendChild(el("line", {
      class: onReq ? "axis-tick dist-req-tick" : "axis-tick",
      x1: x(t), x2: x(t), y1: PAD.t + plotH, y2: PAD.t + plotH + (onReq ? 6 : 4),
    }));
    g.appendChild(el("text", {
      class: onReq ? "axis-label dist-req-label" : "axis-label",
      x: x(t), y: PAD.t + plotH + 15, "text-anchor": "middle",
    }, num(t)));
  }

  if (req == null) {
    drawHighlights(g, hl, x, plotH, named);
    // No threshold to count against, so the panel says how many countries it holds — on the
    // title line, since the curve's peak is scaled to reach the top of the plot and anything
    // inside it is sitting where the peak may be.
    g.appendChild(el("text", {
      class: "dist-count-n", x: PANEL_W, y: 10, "text-anchor": "end",
    }, `${d.points.length} countries`));
    return { clipped };
  }

  // The threshold, and the two counts. Which side is which is READ FROM THE OUTCOME, not
  // assumed: for the four that aim at zero a faster fall is further left, but height aims
  // at a gain, so its on-track countries are the ones to the RIGHT. Hardcoding "on track
  // on the left" would have labelled the height panel backwards.
  const rx = x(req);
  g.appendChild(el("line", {
    class: "dist-threshold", x1: rx, x2: rx, y1: PAD.t - 4, y2: PAD.t + plotH,
  }));

  const total = d.points.length;
  const off = total - d.onTrack;
  // On the right on every panel, now that the axis is improvement. It used to be read off
  // the outcome's direction, because on raw change height's on-track side was the other one.
  const onLeft = false;

  // The counts go to the PANEL EDGES rather than hugging the threshold: left-aligned at
  // the far left, right-aligned at the far right. Beside the line they competed with it
  // for the same few pixels and had to be measured and tucked back in whenever the
  // threshold sat near an edge; at the edges there is nothing to collide with and the
  // side each one is on still reads, which is the whole job. Two lines, because the count
  // is the thing being read and "66 of 200" wants to be the wider, first thing seen.
  // Hard in the corners they read as apart from the curve, so they sit a little in and down
  // (COUNT_INSET, COUNT_DROP); the threshold's clearance above grows by the inset to match.
  const label = (n, txt, side) => {
    const near = side === "left";
    const g2 = el("g", { class: "dist-count" });
    for (const [i, line] of [`${n} of ${total}`, txt].entries()) {
      g2.appendChild(el("text", {
        x: near ? COUNT_INSET : PANEL_W - COUNT_INSET,
        y: PAD.t + 4 + COUNT_DROP + i * 12,
        "text-anchor": near ? "start" : "end",
      }, line));
    }
    g.appendChild(g2);
  };
  label(d.onTrack, "on track", onLeft ? "left" : "right");
  label(off, "not on track", onLeft ? "right" : "left");

  // Last, so a name's box interrupts the threshold where the two cross rather than the line
  // striking through the name.
  drawHighlights(g, hl, x, plotH, named);
  return { clipped };
}

/**
 * Draw one distribution panel per outcome into `host`.
 *
 * cfg: { summary, locations, outcomeList, sex, window, display, title }
 */
export function changeDistribution(host, cfg) {
  host.textContent = "";
  const S = cfg.summary;

  // An outcome measured once has no trend, so it has no distribution to draw. Dropped
  // here and named in the page's note rather than drawn as an empty box.
  //
  // The second filter drops an outcome with too few countries to make a distribution —
  // and on Male or Female that is how `math` leaves, because the whole-population maths
  // measure is published for both sexes only. Silently losing a panel when the reader
  // changes sex reads as a bug, so WHY each one went is handed back for the note.
  const MIN_POINTS = 5;
  const skipped = [];
  const data = [];
  for (const k of cfg.outcomeList) {
    // Measured once is no obstacle to a distribution of LEVELS; it is only rates it rules out.
    if (S.outcomes[k].singleObservation && cfg.measure !== "level") {
      skipped.push({ key: k, why: "once" }); continue;
    }
    const d = collect(cfg, k);
    if (d.points.length < MIN_POINTS) {
      skipped.push({ key: k, why: d.points.length === 0 ? "nosex" : "few", n: d.points.length });
      continue;
    }
    data.push(d);
  }

  if (!data.length) return { drawn: [], skipped, clipped: 0 };

  // Two columns need ~690px. Below that they become two 200px plots with a threshold
  // line and two counts crammed into each, which is not a smaller figure but a broken
  // one — the same rule the prospect grids use, applied to this one. A caller laying the
  // figure out for a page or a slide (figure-format.js) passes `cols` instead; the panels
  // are a fixed size, so the column count is the whole of this figure's shape.
  const hostW = host.clientWidth || 720;
  const cols = cfg.cols ? Math.min(cfg.cols, data.length)
    : hostW < 690 ? 1 : Math.min(2, data.length);
  const rows = Math.ceil(data.length / cols);
  const width = cols * PANEL_W + (cols - 1) * GAP_X;
  const height = rows * PANEL_H + (rows - 1) * GAP_Y;

  const svg = el("svg", {
    class: "prospect-svg dist-svg", width, height,
    viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": cfg.title ?? "Distribution of recent annual change",
  });

  // Appended BEFORE the panels are drawn: getComputedTextLength returns 0 on a detached
  // node, silently, and the count labels measure themselves to stay inside their panel.
  host.appendChild(svg);

  let clipped = 0;
  data.forEach((d, i) => {
    const gx = (i % cols) * (PANEL_W + GAP_X);
    const gy = Math.floor(i / cols) * (PANEL_H + GAP_Y);
    const g = el("g", { transform: `translate(${gx}, ${gy})` });
    svg.appendChild(g);
    clipped += drawPanel(g, d, cfg).clipped;
  });

  registerExportable(svg, {
    summary: S,
    // The threshold is a vertical RULE, not an arrow. It was borrowing the arrow mark
    // because that was the only non-dot key available, which drew a triangle beside a
    // sentence about a line and then wrote "line →" to explain the mismatch.
    //
    // There is no key for the curve itself. It had one, beside a dot, and the figure has no
    // dots: the panel titles and axes already say what is distributed. A levels figure with
    // nothing highlighted therefore needs no key at all.
    legendItems: [
      ...(cfg.measure === "level" ? [] : [{ mark: "rule", fill: "currentColor",
        label: `vertical line: the pace needed to reach the ${S.meta.targetYear} target` }]),
      ...highlightKey(cfg),
    ],
  });

  return { svg, drawn: data, skipped, clipped };
}

// The key for the highlighted countries: one entry, or, where only some are named, the named
// ones by name and the rest together.
function highlightKey(cfg) {
  const hl = cfg.highlight ?? [];
  if (!hl.length) return [];
  if (!cfg.highlightLabels) return [{ mark: "hl", label: "highlighted countries" }];
  const names = cfg.highlightLabels.map((c) => cfg.locations.locations[c]?.label ?? c);
  const rest = hl.filter((c) => !cfg.highlightLabels.includes(c));
  return [
    { mark: "hl", label: names.join(", ") },
    ...(rest.length ? [{ mark: "hl-quiet", label: "comparators" }] : []),
  ];
}

// Table twin, so no count is reachable only by reading a picture. Highlighted countries get
// a column each, so the value a tick marks can be read off rather than estimated.
export function distributionTable(drawn, cfg) {
  const d = document.createElement("details");
  d.className = "table-view";
  d.innerHTML = "<summary>View as table</summary>";
  const level = cfg.measure === "level";
  const L = cfg.locations;
  const hl = (cfg.highlight ?? []).filter((c) => L?.locations[c]);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b), m = s.length / 2;
    return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
  };
  const rows = drawn.map((x) => {
    const f = (v) => (v == null ? "–" : num(level ? v : improvement(x.meta, v)));
    const vals = x.points.map((p) => p.value);
    const own = hl.map((c) => {
      const p = x.points.find((q) => q.code === c);
      return `<td>${p ? num(p.value) : "–"}</td>`;
    }).join("");
    const pct = !level && x.meta.trendRule !== "linear" ? "%" : "";
    return `<tr><th scope="row">${x.meta.label}</th><td>${x.points.length}</td>`
      + (level
        ? `<td>${num(median(vals))}</td><td>${num(Math.min(...vals))}</td>`
          + `<td>${num(Math.max(...vals))}</td>`
        : `<td>${f(x.required)}${pct}</td><td>${x.onTrack}</td>`
          + `<td>${x.points.length - x.onTrack}</td>`)
      + own + "</tr>";
  }).join("");
  const head = level
    ? "<th>Median</th><th>Lowest</th><th>Highest</th>"
    : "<th>Pace needed, a year</th><th>On track</th><th>Not on track</th>";
  d.insertAdjacentHTML("beforeend",
    `<div class="table-scroll"><table><thead><tr><th>Indicator</th><th>Countries</th>`
    + head + hl.map((c) => `<th>${L.locations[c].label}</th>`).join("")
    + `</tr></thead><tbody>${rows}</tbody></table></div>`);
  return d;
}
